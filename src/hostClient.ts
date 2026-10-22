import { open as openFile, readFile, unlink } from 'node:fs/promises';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostEditorStore } from './hostEditorStore.js';
import { HostError, hostFailure, strictHash } from './hostContracts.js';
import { evaluateHostSnapshot } from './hostEvaluator.js';
import { readWriter } from './writerOwnership.js';
import { getRegisteredWorkspace, getWorkspaceRoot } from './workspaceTools.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { prepareHostPoseReview } from './hostPoseReview.js';
import { hostLifecycle } from './hostLifecycle.js';
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
    let record:any;
    try{record=JSON.parse(await readFile(resolveWorkspacePath('.spine-mcp/host-port.json',this.context),'utf8'));}catch(error:any){if(error.code!=='ENOENT')throw new HostError('HOST_UNAVAILABLE','端口文件不可读或已损坏。',409);}
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
      try{const control=JSON.parse(await readFile(resolveWorkspacePath('.spine-mcp/host-control.json',this.context),'utf8'));if(control.sessionId===state.sessionId&&control.instanceId===state.instanceId)value.control=control.control;}catch{}
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
    try{if(await this.ensurePreview(args.autostart!==false))return this.rpc('/api/state?'+new URLSearchParams({includeCapabilities:String(args.includeCapabilities!==false),...(this.context.projectId?{projectId:this.context.projectId}:{})}));}
    catch(error:any){if(error.code==='WRITE_OWNERSHIP_UNCERTAIN')return{...this.lastState,...hostFailure(error),available:false,degraded:true,writeMode:'frozen'};throw error;}
    return this.mirror.state(args.includeCapabilities!==false);
  }
  async open(args:any){return await this.ensurePreview()?this.rpc('/api/open',args):this.mirror.open(args);}
  async evaluate(expectedRevision:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(!this.endpoint)throw new HostError('HOST_UNAVAILABLE','镜像模式不发布内存派生结果；请显式使用原单姿态求解工具保存结果。',409);
    const snapshot=await this.rpc('/api/snapshot',{expectedRevision},true,signal);
    const result=await evaluateHostSnapshot(snapshot,this.context,signal,progress);
    return this.rpc('/api/derived',{expectedRevision,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result},true,signal);
  }
  async frame(args:any){
    if(await this.ensurePreview())return{ok:true,available:true,...await this.rpc('/api/frame?'+new URLSearchParams({...args.expectedRevision,...args.size?{size:String(args.size)}:{},...args.time!==undefined?{time:String(args.time)}:{}}).toString())};
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
  async patch(args:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','detached 镜像拒绝 Host 编辑。',409);
    const result=await this.rpc('/api/patch',args);
    if(args.dryRun===false){await this.evaluate(result.version,signal,progress);return{...result,state:await this.state(),...await this.frame({expectedRevision:result.version})};}
    return result;
  }
  async history(direction:'undo'|'redo',args:any,signal?:AbortSignal,progress?:(stage:string)=>void){
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','detached 镜像拒绝 Host 历史操作。',409);
    const result=await this.rpc('/api/'+direction,args);
    if(args.dryRun===false&&!result.noOp){await this.evaluate(result.version,signal,progress);return{...result,state:await this.state(),...await this.frame({expectedRevision:result.version})};}return result;
  }
  async commit(args:any){
    if(!await this.ensurePreview())throw new HostError('WRITE_FORBIDDEN','detached 镜像拒绝 Host 提交。',409);
    if(args.dryRun!==false)return this.rpc('/api/commit',args);
    // 先让已完成 requestId 返回原回执；无终态才会遇到缺少授权。
    try{return await this.rpc('/api/commit',args);}catch(error:any){if(error.code!=='COMMIT_NOT_AUTHORIZED')throw error;}
    const candidate=await this.rpc('/api/commit',{...args,dryRun:true},true),snapshot=await this.rpc('/api/snapshot',{expectedRevision:args.expectedRevision},true);
    if(strictHash(candidate.candidateBytes)!==candidate.candidateHash||candidate.intent!=='draft'||snapshot.kind!=='pose')throw new HostError('COMMIT_NOT_AUTHORIZED','精确草稿候选校验失败。',409);
    const value=JSON.parse(candidate.candidateBytes),input=snapshot.document;
    for(const key of ['filePath','mappingPath','visualRigPath','referencePosePath','sequencePath','stageId','standardPosePath','sourceFingerprint'])if(value[key]!==input[key])throw new HostError('TARGET_DRIFT',`草稿候选修改了固定绑定 ${key}。`,409);
    const authorization=await this.rpc('/api/authorize',{expectedRevision:args.expectedRevision,candidateHash:candidate.candidateHash,outputPath:candidate.outputPath,intent:'draft',snapshotHash:snapshot.snapshotHash,derivedHash:snapshot.derivedHash,reviewHash:(await this.state()).reviewHash,gateRecord:{gate:'pose-draft',passed:true,candidateHash:candidate.candidateHash}},true);
    return this.rpc('/api/commit',{...args,authorizationId:authorization.authorizationId});
  }
}
const clients=new Map<string,HostClient>();
export function hostClient(context:ToolContext={}){
  const root=context.workspaceRoot??getWorkspaceRoot(context.projectId),record=getRegisteredWorkspace(root,context.projectId),key=`${process.platform==='win32'?root.toLowerCase():root}:${record?.projectId??''}`;
  let client=clients.get(key);if(!client){client=new HostClient({workspaceRoot:root,projectId:record?.projectId},true);clients.set(key,client);}return client;
}
