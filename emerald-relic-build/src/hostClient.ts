import { poseGateData } from './poseWorkflow.js';
import { open as openFile, readFile, unlink } from 'node:fs/promises';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostEditorStore } from './hostEditorStore.js';
import { assertVersion, HostError, hostFailure, strictHash } from './hostContracts.js';
import { evaluateHostSnapshot } from './hostEvaluator.js';
import { readWriter } from './writerOwnership.js';
import { getRegisteredWorkspace, getWorkspaceRoot } from './workspaceTools.js';
import { resolveWorkspacePath,resolveWorkspacePathAsync, type ToolContext } from './spineJson.js';
import { prepareHostPoseReview } from './hostPoseReview.js';
import { hostLifecycle } from './hostLifecycle.js';
import { withHostEvaluationTask } from './hostEvaluationTasks.js';
import { prepareHostPoseCommand } from './hostPoseCommands.js';
import { prepareHostAssetCandidate, verifyHostAssetCandidate } from './hostAssetCommands.js';
import { prepareHostAnimationCandidate } from './hostAnimationCandidate.js';
import { prepareHostAnimationReview,prepareHostAnimationComparison } from './hostAnimationReview.js';
import {verifyHostAnimationCommit} from './hostAnimationCommit.js';
const installRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
interface Endpoint{endpoint:string;token:string;control?:string;sessionId?:string;instanceId?:string}
export class HostClient {
  private mirror:HostEditorStore;
  private endpoint:Endpoint|null=null;
  private attachedSeen=false;
  private lastState:any=null;
  constructor(public context:ToolContext,private readonly managedLifecycle=false){this.mirror=new HostEditorStore(context,'mirror');}
  private async discover():Promise<Endpoint|null>{
    const envEndpoint=process.env.SPINE_HOST_ENDPOINT;
    if(envEndpoint&&!process.env.SPINE_HOST_TOKEN)return null;
    // 两份发现文件互相独立，只在本次调用并发读取；实例核对后才使用对应 control。
    const records=await Promise.allSettled(['.spine-mcp/host-port.json','.spine-mcp/host-control.json'].map(async file=>JSON.parse(await readFile(await resolveWorkspacePathAsync(file,this.context),'utf8'))));
    if(records[0].status==='rejected'&&records[0].reason?.code!=='ENOENT')throw new HostError('HOST_UNAVAILABLE','端口文件不可读或已损坏。',409);
    const record:any=records[0].status==='fulfilled'?records[0].value:undefined;
    const controlRecord:any=records[1].status==='fulfilled'?records[1].value:null;
    const value:Endpoint|undefined=envEndpoint?{endpoint:envEndpoint,token:process.env.SPINE_HOST_TOKEN!}:record?{endpoint:`http://127.0.0.1:${record.port}`,token:record.token,sessionId:record.sessionId,instanceId:record.instanceId}:undefined;
    if(!value)return null;
    const url=new URL(value.endpoint);
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new HostError('PATH_FORBIDDEN','Host endpoint 只接受本机 HTTP 根地址。',403);
    value.endpoint=url.origin;
    try{
      const response=await fetch(value.endpoint+'/api/state',{headers:{'X-Spine-Host-Token':value.token},signal:AbortSignal.timeout(500)});
      if(!response.ok)throw new HostError('HOST_UNAVAILABLE','Host 身份探测失败。',response.status);
      const state:any=await response.json();
      if(state.apiVersion!=='1')throw new HostError('HOST_VERSION_MISMATCH','Host apiVersion 不兼容。',409);
      if(state.projectId!==(this.context.projectId??null)||record&&(state.sessionId!==record.sessionId||state.instanceId!==record.instanceId||state.startedAt!==record.startedAt))throw new HostError('PROJECT_BINDING_CONFLICT','Host 实例或工作区与登记不符。',409);
      if(record){try{process.kill(record.pid,0);}catch{throw new HostError('HOST_UNAVAILABLE','端口记录的进程已退出。',409);}}
      if(controlRecord?.sessionId===state.sessionId&&controlRecord?.instanceId===state.instanceId)value.control=controlRecord.control;
      value.sessionId=state.sessionId;value.instanceId=state.instanceId;
      this.attachedSeen ||=state.writeMode==='attached';this.lastState=state;return value;
    }catch(error){if(error instanceof HostError)throw error;return null;}
  }
  async ensurePreview(allowStart=true){
    if(this.managedLifecycle&&allowStart)return hostLifecycle.activate(this,()=>this.connectPreview(allowStart));
    return this.connectPreview(allowStart);
  }
  /** 202 仅表示受理；确认服务不可达、发现文件退役和写入锁释放后才交接。 */
  async shutdownForSwitch(){
    const endpoint=this.endpoint??await this.discover();
    if(!endpoint){if(this.lastState?.available||this.attachedSeen||(await readWriter(this.context))?.mode==='attached')throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','旧 Host 离线但尚未确认关闭或写入权交接。',409);return;}
    const response=await fetch(endpoint.endpoint+'/api/shutdown',{method:'POST',headers:{'X-Spine-Host-Token':endpoint.token,Origin:endpoint.endpoint,'Content-Type':'application/json'},body:JSON.stringify({reason:'project-switch'}),signal:AbortSignal.timeout(1500)});
    if(response.status!==202)throw new HostError('HOST_UNAVAILABLE','旧 Host 拒绝关闭。',409);
    for(let attempt=0;attempt<30;attempt++){
      await new Promise(resolve=>setTimeout(resolve,50));
      let unreachable=false;
      try{await fetch(endpoint.endpoint+'/api/state',{headers:{'X-Spine-Host-Token':endpoint.token},signal:AbortSignal.timeout(200)});}catch{unreachable=true;}
      let retired=false;
      try{const record=JSON.parse(await readFile(resolveWorkspacePath('.spine-mcp/host-port.json',this.context),'utf8'));if(record.instanceId!==endpoint.instanceId)throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','关闭期间发现了另一 Host 实例，须重新核对。',409);}
      catch(error:any){if(error.code==='ENOENT')retired=true;else throw error;}
      if(unreachable&&retired&&!(await readWriter(this.context))){this.endpoint=null;this.lastState=null;this.attachedSeen=false;return;}
    }
    throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','旧 Host 关闭尚未完成；202 或超时不能作为交接证明。',409);
  }
  private async connectPreview(allowStart=true){
    this.endpoint=await this.discover();if(this.endpoint)return true;
    if(this.attachedSeen||(await readWriter(this.context))?.mode==='attached')throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','已附着宿主失联；保持冻结，不自动转为磁盘写入。',409);
    if(!allowStart||process.env.SPINE_HOST_AUTOSTART==='0'||process.env.SPINE_HOST_ENDPOINT)return false;
    const portFile=resolveWorkspacePath('.spine-mcp/host-port.json',this.context);
    try{
      const old=JSON.parse(await readFile(portFile,'utf8'));
      try{process.kill(old.pid,0);return false;}catch(error:any){if(error.code!=='ESRCH')return false;}
      const latest=JSON.parse(await readFile(portFile,'utf8'));if(latest.instanceId!==old.instanceId)return false;
      await unlink(portFile);
      const controlFile=resolveWorkspacePath('.spine-mcp/host-control.json',this.context);
      try{const control=JSON.parse(await readFile(controlFile,'utf8'));if(control.instanceId===old.instanceId)await unlink(controlFile);}catch{}
    }catch(error:any){if(error.code!=='ENOENT')throw error;}
    const log=resolveWorkspacePath('.spine-mcp/host.log',this.context);mkdirSync(path.dirname(log),{recursive:true});const fd=openSync(log,'a');
    try{
      const child=spawn(process.execPath,[path.join(installRoot,'dist/hostServer.js')],{cwd:installRoot,env:{...process.env,SPINE_MCP_WORKSPACE:this.context.workspaceRoot,SPINE_MCP_REGISTRY_ROOT:process.env.SPINE_MCP_REGISTRY_ROOT??process.env.SPINE_MCP_WORKSPACE??process.cwd(),SPINE_HOST_PROJECT_ID:this.context.projectId},stdio:['ignore',fd,fd],detached:true,windowsHide:true});
      child.unref();
    }finally{closeSync(fd);}
    for(const delay of [100,300,900]){await new Promise(r=>setTimeout(r,delay));this.endpoint=await this.discover();if(this.endpoint)return true;}
    return false;
  }
  async rpc(route:string,args?:any,control=false,signal?:AbortSignal):Promise<any>{
    if(!this.endpoint&&!await this.ensurePreview())throw new HostError('HOST_UNAVAILABLE','动画工作区宿主不可用。',409);
    if(control&&!this.endpoint!.control)throw new HostError('CONTROL_REQUIRED','缺少与该工作区实例匹配的受保护控制凭据。',403);
    const headers:Record<string,string>={'X-Spine-Host-Token':this.endpoint!.token};if(control)headers['X-Spine-Host-Control']=this.endpoint!.control!;
    if(args)headers['Content-Type']='application/json';
    let response:Response;
    try{response=await fetch(this.endpoint!.endpoint+route,{headers,...(args?{method:'POST',body:JSON.stringify(args),headers:{...headers,Origin:this.endpoint!.endpoint}}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}
    catch(error){if(signal?.aborted)throw new HostError('TASK_CANCELLED','重算已取消；已确认的编辑版本保留，可重新查询状态。',409);this.endpoint=null;if(this.attachedSeen||(await readWriter(this.context))?.mode==='attached')throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','Host 请求结果不明，写入保持冻结。',409);throw new HostError('HOST_UNAVAILABLE',`Host 请求失败：${String(error)}`,409);}
    if(!response.ok){const error:any=await response.json();throw new HostError(error.code??'HOST_ERROR',error.message,response.status,error.detail);}
    if(response.headers.get('content-type')?.startsWith('image/png'))return{__imageData:Buffer.from(await response.arrayBuffer()).toString('base64'),version:{sessionId:response.headers.get('x-session-id'),documentId:response.headers.get('x-document-id'),openEpoch:response.headers.get('x-open-epoch'),revision:Number(response.headers.get('x-revision'))},source:response.headers.get('x-source')};
    const result:any=await response.json();if(route==='/api/state'||route==='/api/open'){this.lastState=result;this.attachedSeen ||=result.writeMode==='attached';}return result;
  }
  async state(args:any={}){
    const previous=this.lastState;
    try{if(await this.ensurePreview(args.autostart!==false)){
      // 本次发现已进行严格 state 请求并核验实例；只复用这一请求的响应，不使用上次调用缓存。
      if(this.lastState&&this.lastState!==previous){const state=structuredClone(this.lastState);if(args.includeCapabilities===false)delete state.capabilities;return state;}
      return this.rpc('/api/state?'+new URLSearchParams({includeCapabilities:String(args.includeCapabilities!==false),...(this.context.projectId?{projectId:this.context.projectId}:{})}));
    }}
    catch(error:any){if(error.code==='WRITE_OWNERSHIP_UNCERTAIN')return{...this.lastState,...hostFailure(error),available:false,degraded:true,writeMode:'frozen'};throw error;}
    return this.mirror.state(args.includeCapabilities!==false);
  }
  async open(args:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    const {recheck,...request}=args;
    if(!await this.ensurePreview()){
      if(recheck===true)throw new HostError('HOST_UNAVAILABLE','镜像不执行新的动画/姿态求解；需当前 Host。',409);
      return this.mirror.open(request);
    }
    const opened=await this.rpc('/api/open',request);
    if(recheck===true){await this.evaluate(opened.version,signal,progress);return{...opened,...await this.currentFrameState(opened.version)};}
    return opened;
  }
  async evaluate(expectedRevision:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(!this.endpoint)throw new HostError('HOST_UNAVAILABLE','镜像模式不发布内存派生结果；请显式使用原单姿态求解工具保存结果。',409);
    const endpoint={...this.endpoint};
    if(!endpoint.control)throw new HostError('CONTROL_REQUIRED','缺少受保护的 MCP 控制凭据，不能登记外部求解。',403);
    const taskRpc=async(args:any,taskSignal?:AbortSignal)=>{
      const response=await fetch(endpoint.endpoint+'/api/evaluation-task',{method:'POST',headers:{'Content-Type':'application/json',Origin:endpoint.endpoint,
        'X-Spine-Host-Token':endpoint.token,'X-Spine-Host-Control':endpoint.control!},body:JSON.stringify(args),
        signal:taskSignal?AbortSignal.any([taskSignal,AbortSignal.timeout(1500)]):AbortSignal.timeout(1500)});
      const result:any=await response.json();if(!response.ok)throw new HostError(response.status===404?'HOST_VERSION_MISMATCH':result.code??'HOST_ERROR',response.status===404?'当前 Host 尚未实现外部求解状态通道；请重启以加载匹配源码，不静默跳过状态登记。':result.message,response.status,result.detail);return result;
    };
    return withHostEvaluationTask(taskRpc,expectedRevision,signal,async task=>{
      const snapshotStarted=performance.now(),snapshot=await this.rpc('/api/snapshot',{expectedRevision,purpose:'evaluate'},true,signal),snapshotAt=performance.now();task.check();task.stage('solve');
      const result=await evaluateHostSnapshot(snapshot,this.context,signal,progress);task.check();task.stage('publish');
      const solvedAt=performance.now(),published=await this.rpc('/api/derived',{expectedRevision,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result},true,signal);return {...published,timings:{snapshotMs:snapshotAt-snapshotStarted,solveMs:solvedAt-snapshotAt,publishMs:performance.now()-solvedAt}};
    });
  }
  async frame(args:any){
    if(await this.ensurePreview()){
      if(args.variant==='previous'){
        if(args.size!==undefined&&args.size!==480||args.time!==undefined||Object.hasOwn(args,'animation'))throw new HostError('INVALID_ARGUMENT','前次诊断图只读缓存的 480 图，不接受另选时间、动画或尺寸。');
        return {ok:true,available:true,advisory:true,evidenceEligible:false,currentVersion:args.expectedRevision,...await this.rpc('/api/previous-frame?'+new URLSearchParams(args.expectedRevision))};
      }
      if(Object.hasOwn(args,'animation')&&!this.lastState?.capabilities?.viewing?.supportedKinds?.includes(this.lastState?.activeDoc?.kind))throw new HostError('CAPABILITY_MISSING','当前 Host 未声明所请求的动画呈现能力。',409);
      return{ok:true,available:true,...await this.rpc('/api/frame?'+new URLSearchParams({...args.expectedRevision,...args.size?{size:String(args.size)}:{},...args.time!==undefined?{time:String(args.time)}:{},...Object.hasOwn(args,'animation')?{animation:args.animation??''}:{}}).toString())};
    }
    if(args.variant==='previous')throw new HostError('CAPABILITY_MISSING','镜像模式没有 Host 前次候选缓存，不回退旧磁盘图。',409);
    const result=await this.mirror.frame(args);return{ok:true,available:false,degraded:true,mode:'mirror',version:result.version,source:'disk',__imageData:result.png.toString('base64')};
  }
  async capture(args:any){
    if(!await this.ensurePreview())return{ok:true,available:false,degraded:true,advisory:true,message:'无真实 player 页面；可调用 spine_preview_frame 查看磁盘诊断图。'};
    const result=await this.rpc('/api/capture',args);return{...result,__imageData:result.pngBase64,pngBase64:undefined};
  }
  async review(args:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','附着审查需要当前 Host，不回退磁盘姿态。',409);
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','审查已取消，既有文档和审查保持原状。',409);
    const snapshot=await this.rpc('/api/snapshot',{expectedRevision:args.expectedRevision},true,signal);
    progress?.('核对当前 player 证据、数值与参考关系');
    const prepared=await prepareHostPoseReview(snapshot,args,this.context);
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','审查已取消，未登记新审查。',409);
    progress?.(prepared.dryRun?'验证审查预演，不修改批准状态':'登记当前姿态审查');
    // 登记开始后等待明确回执，不把中止网络等待描述成登记未发生。
    return this.rpc('/api/review',prepared,true);
  }
  /** 当前操作入口已核实实例；顺序读取避免严格文件读取与栅格计算竞争，不复用上一轮门禁结果。 */
  private async currentFrameState(expectedRevision:any){
    const state=await this.rpc('/api/state');assertVersion(state.version,expectedRevision);
    const frame=await this.rpc('/api/frame?'+new URLSearchParams({...expectedRevision}).toString());assertVersion(frame.version,expectedRevision);
    return{state,available:true,...frame};
  }
  async patch(args:any,signal?:AbortSignal,progress?:(stage:string)=>void,connected=false){
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','编辑已取消，未发送修改。',409);
    if(!connected&&!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','detached 镜像拒绝 Host 编辑。',409);
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','编辑已取消，未发送修改。',409);
    const requestStarted=performance.now(),result=await this.rpc('/api/patch',args),editedAt=performance.now();
    if(args.dryRun===false){const evaluated=await this.evaluate(result.version,signal,progress);const solvedAt=performance.now(),current=await this.currentFrameState(result.version);return{...result,...current,timings:{...result.timings,patchRpcMs:editedAt-requestStarted,evaluateMs:solvedAt-editedAt,presentMs:performance.now()-solvedAt,evaluation:evaluated.timings}};}
    return result;
  }
  async poseCommand(name:string,args:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','姿态命令已取消，未发送编辑。',409);
    const state=await this.state(),request=prepareHostPoseCommand(name,args,state,this.context);
    const result=await this.patch(request,signal,progress);
    return{...result,adapter:{tool:name,execution:'host-memory',persisted:false,saveTool:'spine_host_commit'}};
  }
  async history(direction:'undo'|'redo',args:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','detached 镜像拒绝 Host 历史操作。',409);
    const result=await this.rpc('/api/'+direction,args);
    if(args.dryRun===false&&!result.noOp){await this.evaluate(result.version,signal,progress);return{...result,...await this.currentFrameState(result.version)};}return result;
  }
  async animationCandidate(args:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','精确动画候选需要 attached Host，不回退旧磁盘写入路径。',409);
    const snapshot=await this.rpc('/api/snapshot',{expectedRevision:args.expectedRevision},true,signal);
    const prepared=await prepareHostAnimationCandidate(args,snapshot,this.context,signal,progress);
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','候选已取消，未发布。',409);
    const published=await this.rpc('/api/derived',{expectedRevision:args.expectedRevision,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result:prepared.derived},true,signal);
    if(prepared.session){
      if(signal?.aborted)throw new HostError('TASK_CANCELLED','候选回放已发布，审查会话未登记。',409);
      await this.rpc('/api/animation-candidate',{expectedRevision:args.expectedRevision,session:prepared.session},true);
    }
    return {...prepared.summary,...published,...await this.currentFrameState(args.expectedRevision),ok:prepared.summary.ok};
  }
  async animationReview(args:any,signal?:AbortSignal){
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','动画审查已取消。',409);
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','附着动画审查需要当前 Host。',409);
    const snapshot=await this.rpc('/api/snapshot',{expectedRevision:args.expectedRevision},true,signal),session=await this.rpc('/api/animation-session',{expectedRevision:args.expectedRevision},true,signal);
    const review=await prepareHostAnimationReview(snapshot,session,args,this.context);
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','动画审查在登记前已取消。',409);
    return this.rpc('/api/animation-review',review,true);
  }
  async animationComparison(args:any,signal?:AbortSignal){
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','动画参考比较已取消。',409);
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','附着动画比较需要当前 Host。',409);
    const snapshot=await this.rpc('/api/snapshot',{expectedRevision:args.expectedRevision},true,signal),session=await this.rpc('/api/animation-session',{expectedRevision:args.expectedRevision},true,signal);
    return prepareHostAnimationComparison(snapshot,session,args,this.context);
  }
  async assetCommand(name:string,args:any,signal?:AbortSignal){
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','资产计算已取消。',409);
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','资产暂存需要 attached Host。',409);
    const snapshot=await this.rpc('/api/snapshot',{expectedRevision:args.expectedRevision},true);
    const candidate=await prepareHostAssetCandidate(name,args,snapshot,this.context);
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','资产计算已取消，未暂存。',409);
    if('diagnostic'in candidate){
      if((candidate as any).newStage){
        const opened=await this.rpc('/api/diagnostic-open',{expectedRevision:args.expectedRevision,snapshotHash:snapshot.snapshotHash,document:candidate.document,dependencies:candidate.dependencies,outputPath:candidate.outputPath,dryRun:args.dryRun??true},true,signal);
        if(args.dryRun===false){await this.evaluate(opened.version,signal);return {...opened,...await this.currentFrameState(opened.version)};}return opened;
      }
      const document=(candidate as any).document;
      if(!document?.frame||snapshot.kind!=='pose'||['filePath','mappingPath','visualRigPath','referencePosePath','sequencePath','stageId','standardPosePath'].some(key=>document[key]!==snapshot.document[key])){
        const {document:_document,...diagnostic}=candidate as any;return {...diagnostic,adopted:false,message:!document?.frame?diagnostic.message:'诊断保留；需要先选择绑定相同参考与阶段的 pose，不能改写当前文档的绑定。'};
      }
      const adopted=await this.rpc('/api/diagnostic-candidate',{expectedRevision:args.expectedRevision,snapshotHash:snapshot.snapshotHash,document,dryRun:args.dryRun??true},true,signal);
      if(args.dryRun===false){await this.evaluate(adopted.version,signal);return {...adopted,...await this.currentFrameState(adopted.version)};}return adopted;
    }
    return this.rpc('/api/asset-candidate',candidate,true);
  }
  async resumeDiagnostic(args:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','诊断恢复已取消。',409);
    if(!await this.ensurePreview())throw new HostError('HOST_UNAVAILABLE','诊断恢复需要显式启动的隔离 C2 Host。',409);
    const resumed=await this.rpc('/api/diagnostic-resume',args,true,signal);
    // 实际恢复后返回新的干净派生图；旧批准/截图/求解不随 journal 恢复。
    if(args.dryRun===false){await this.evaluate(resumed.version,signal,progress);return {...resumed,...await this.currentFrameState(resumed.version)};}return resumed;
  }
  async commit(args:any){
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','detached 镜像拒绝 Host 提交。',409);
    if(args.dryRun!==false)return this.rpc('/api/commit',args);
    // 先让已完成 requestId 返回原回执；无终态才会遇到缺少授权。
    try{return await this.rpc('/api/commit',args);}catch(error:any){if(error.code!=='COMMIT_NOT_AUTHORIZED')throw error;}
    // 仅并发互相独立的只读准备；授权与发布仍顺序执行，失败时先收束全部读取。
    const prepared=await Promise.allSettled([
      this.rpc('/api/commit',{...args,dryRun:true},true),
      this.rpc('/api/snapshot',{expectedRevision:args.expectedRevision},true),
    ]);
    for(const result of prepared)if(result.status==='rejected')throw result.reason;
    const [candidate,snapshot]=prepared.map(result=>(result as PromiseFulfilledResult<any>).value);
    assertVersion(candidate.version,args.expectedRevision);assertVersion(snapshot.version,args.expectedRevision);
    if(!Object.hasOwn(snapshot,'reviewHash'))throw new HostError('HOST_VERSION_MISMATCH','当前 Host 快照缺少审查摘要，请重启加载匹配源码。',409);
    if(strictHash(candidate.candidateBytes)!==candidate.candidateHash||!['draft','asset','animation'].includes(candidate.intent)||candidate.intent==='draft'&&!['pose','motion'].includes(snapshot.kind))throw new HostError('COMMIT_NOT_AUTHORIZED','精确提交候选校验失败。',409);
    const value=JSON.parse(candidate.candidateBytes),input=snapshot.document;
    let gateRecord:any={gate:candidate.intent==='asset'?'asset-draft':snapshot.kind==='motion'?'motion-draft':'pose-draft',passed:true,candidateHash:candidate.candidateHash};
    if(candidate.intent==='animation')gateRecord=await verifyHostAnimationCommit(snapshot,candidate.animationSession,args,this.context);
    else if(candidate.intent==='asset')await verifyHostAssetCandidate(value,candidate.binding,snapshot,this.context);
    else if(snapshot.kind==='motion'){const gate=await poseGateData(value,this.context);if(!gate.ok)throw new HostError('COMMIT_NOT_AUTHORIZED','motion 修订关键姿态审查失效。',409,gate);}
    else for(const key of ['filePath','mappingPath','visualRigPath','referencePosePath','sequencePath','stageId','standardPosePath','sourceFingerprint'])if(value[key]!==input[key])throw new HostError('TARGET_DRIFT',`草稿候选修改了固定绑定 ${key}。`,409);
    const authorization=await this.rpc('/api/authorize',{expectedRevision:args.expectedRevision,candidateHash:candidate.candidateHash,outputPath:candidate.outputPath,intent:candidate.intent,...candidate.intent==='asset'?{assetCandidateHash:args.assetCandidateHash}:{},...candidate.intent==='animation'?{animationCandidateHash:args.animationCandidateHash,expectedHash:args.expectedHash,reviewToken:args.reviewToken}:{},snapshotHash:snapshot.snapshotHash,derivedHash:snapshot.derivedHash,reviewHash:candidate.intent==='animation'?candidate.reviewHash:snapshot.reviewHash,gateRecord},true);
    return this.rpc('/api/commit',{...args,authorizationId:authorization.authorizationId});
  }
}
const clients=new Map<string,HostClient>();
export function hostClient(context:ToolContext={}){
  const root=context.workspaceRoot??getWorkspaceRoot(context.projectId),record=getRegisteredWorkspace(root,context.projectId),key=`${process.platform==='win32'?root.toLowerCase():root}:${record?.projectId??''}`;
  let client=clients.get(key);if(!client){client=new HostClient({workspaceRoot:root,projectId:record?.projectId},true);clients.set(key,client);}return client;
}
