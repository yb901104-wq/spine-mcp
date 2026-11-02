#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostEditorStore } from './hostEditorStore.js';
import { HostCapture } from './hostCapture.js';
import { creationQuality } from './creationQuality.js';
import { runtimeBuildIdentity } from './buildIdentity.js';
import { assertVersion, HostError, hostFailure, rejectFields } from './hostContracts.js';
import { getRegisteredWorkspace, getWorkspaceRoot } from './workspaceTools.js';
import type { ToolContext } from './spineJson.js';
import { HostObservation } from './hostObservation.js';
import { HostRollout } from './hostRollout.js';
import { protectHostFile as protect } from './hostFileProtection.js';
import type { HostEditProfile } from './hostPosePatch.js';
const installRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const secret=()=>randomBytes(32).toString('hex');
const matches=(actual:unknown,expected:string)=>typeof actual==='string'&&actual.length===expected.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
async function persist(file:string,value:unknown){
  await mkdir(path.dirname(file),{recursive:true});const handle=await open(file,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
}
export async function startHostServer(context:ToolContext,options:{port?:number;persist?:boolean;writeEnabled?:boolean;captureTimeoutMs?:number;developmentProfile?:HostEditProfile;trialInfo?:unknown}={}){
  const application={...await runtimeBuildIdentity,profile:options.developmentProfile??'c1',trial:options.trialInfo??null};
  const store=new HostEditorStore(context,'host',options.developmentProfile??'c1'),capture=new HostCapture(store,options.captureTimeoutMs);
  const observation=new HostObservation(store,context,protect),rollout=new HostRollout(store,context,protect);
  observation.onChanged=()=>store.onObservationChanged();
  const token=secret(),control=secret(),instanceId=randomUUID(),startedAt=new Date().toISOString();
  let controlProtected=options.persist===false,securityMode:'acl'|'token-only'='token-only',closing=false,stopPromise:Promise<void>|null=null;
  const streams=new Set<ServerResponse>();let frames:number[]=[];
  const pageState:any={loaded:false,playing:false,lastSeenAt:null};
  const json=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  const server=createServer(async(request,response)=>{
    const base=`http://127.0.0.1:${(server.address() as any)?.port}`;
    response.once('finish',()=>{try{observation.noteRequest(request.method??'GET',new URL(request.url??'/',base).pathname,response.statusCode);}catch{}});
    try{
      if(request.headers.host!==new URL(base).host)throw new HostError('PATH_FORBIDDEN','Host 头必须精确匹配本机服务。',403);
      const url=new URL(request.url??'/',base);
      if(request.method==='GET'&&url.pathname==='/'){
        const html=(await readFile(path.join(installRoot,'preview/host.html'),'utf8')).replace('<!--HOST_TOKEN-->',`<meta name="x-spine-host-token" content="${token}">`);
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'SAMEORIGIN'});response.end(html);return;
      }
      if(request.method==='GET'&&url.pathname.startsWith('/vendor/')){
        const files:Record<string,string>={
          '/vendor/spine-player.js':'node_modules/@esotericsoftware/spine-player/dist/iife/spine-player.min.js',
          '/vendor/spine-player.css':'node_modules/@esotericsoftware/spine-player/dist/spine-player.css',
        };
        const file=files[url.pathname];if(!file)throw new HostError('PATH_FORBIDDEN','静态资源不在白名单。',403);
        response.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'text/css','Cache-Control':'no-store'});response.end(await readFile(path.join(installRoot,file)));return;
      }
      if(!matches(request.headers['x-spine-host-token'],token))throw new HostError('AUTH_REQUIRED','缺少有效会话 token。',403);
      if(url.searchParams.has('projectId')&&url.searchParams.get('projectId')!==context.projectId)throw new HostError('PROJECT_BINDING_CONFLICT','当前 Host 不属于请求工程。',409);
      const controlRoute=['/api/snapshot','/api/derived','/api/review','/api/authorize','/api/asset-candidate','/api/diagnostic-candidate','/api/diagnostic-open','/api/diagnostic-resume','/api/animation-candidate','/api/animation-session','/api/animation-review','/api/evaluation-task','/api/observation','/api/rollout-disable'].includes(url.pathname);
      const isControl=controlProtected&&matches(request.headers['x-spine-host-control'],control);
      if(controlRoute&&!isControl)throw new HostError('CONTROL_REQUIRED','该端点仅允许受保护的 MCP 控制通道。',403);
      if(request.method==='GET'){
        if(url.pathname==='/api/state'||url.pathname==='/api/capabilities'){
          const state={...await store.state(url.pathname==='/api/capabilities'||url.searchParams.get('includeCapabilities')!=='false'),application,instanceId,startedAt,security:{mode:securityMode,controlProtected},preview:pageState,
            rollout:rollout.status(),observation:observation.status()};
          for(const operation of state.capabilities?.operations??[]){
            if(operation.operation==='capture'&&operation.supported&&operation.state==='blocked'&&operation.reasons.some((reason:any)=>reason.code==='CAPTURE_TIMEOUT')&&store.active?.derived?.live){operation.canRun=pageState.visibilityState==='visible'&&Date.now()-Date.parse(pageState.lastSeenAt??'')<3000;operation.state=operation.canRun?'ready':'blocked';operation.reasons=operation.canRun?[]:[{code:'CAPTURE_TIMEOUT',message:'需要可见且正在上报心跳的 player 页面。'}];operation.nextAction={tool:operation.canRun?'spine_preview_capture':null,instruction:'截图准入由 captureValidity 与当前版本核验；rendererParity 单独记录，动作仍须视觉审查。'};}
            if(['evaluate','review'].includes(operation.operation)&&operation.supported&&!['stale','busy','frozen'].includes(operation.state)&&!controlProtected){operation.canRun=false;operation.state='blocked';operation.reasons=[{code:'CONTROL_REQUIRED',message:'控制凭据文件保护未通过，不能发布求解或审查结果。'}];}
          }
          state.creationQuality=creationQuality({...state,capabilities:state.capabilities??store.capabilities(state.targetStale,'strict')});
          json(response,200,url.pathname==='/api/state'?state:state.capabilities);return;
        }
        if(url.pathname==='/api/doc'){json(response,200,await store.inspect(url.searchParams.get('view')??'bones'));return;}
        if(url.pathname==='/api/reference-frame'){
          const expected:any={};for(const key of ['sessionId','documentId','openEpoch'])expected[key]=url.searchParams.get(key);expected.revision=Number(url.searchParams.get('revision'));
          const snapshot=await store.snapshot(expected),ref=snapshot.document.referencePosePath;
          if(!ref)throw new HostError('NO_REFERENCE','当前文档未关联参考姿态。',404);
          const reference=JSON.parse(await readFile(store.resolve(ref),'utf8')),imagePath=reference.observation?.imagePath;
          if(typeof imagePath!=='string')throw new HostError('NO_REFERENCE','当前参考缺少图像路径。',404);
          const bytes=await readFile(store.resolve(imagePath));if(bytes.length>16*1024*1024)throw new HostError('INVALID_ARGUMENT','参考图超过 16MB。');
          const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.subarray(0,3).toString()==='GIF'?'image/gif':null;
          if(!mime)throw new HostError('INVALID_ARGUMENT','参考图仅显示 PNG/JPEG/GIF 位图。');
          await store.snapshot(expected);response.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});response.end(bytes);return;
        }
        if(url.pathname==='/api/playback-bundle'){const expected:any={};for(const key of ['sessionId','documentId','openEpoch'])expected[key]=url.searchParams.get(key);expected.revision=Number(url.searchParams.get('revision'));json(response,200,await capture.playbackBundle(expected,url.searchParams.get('candidateHash')??''));return;}
        if(url.pathname==='/api/player-bundle'){json(response,200,await capture.bundle(url.searchParams.get('captureId')??''));return;}
        if(url.pathname==='/api/frame'||url.pathname==='/api/previous-frame'){
          const now=Date.now();frames=frames.filter(t=>now-t<1000);if(frames.length>=20){response.setHeader('Retry-After','1');throw new HostError('RATE_LIMITED','frame 每秒最多 20 次。',429);}frames.push(now);
          const expectedRevision:any={};for(const k of ['sessionId','documentId','openEpoch'])expectedRevision[k]=url.searchParams.get(k);
          expectedRevision.revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):null;
          const result=url.pathname==='/api/previous-frame'?await store.previousFrame(expectedRevision):await store.frame({expectedRevision,size:url.searchParams.has('size')?Number(url.searchParams.get('size')):undefined,time:url.searchParams.has('time')?Number(url.searchParams.get('time')):undefined,
            ...(url.searchParams.has('animation')?{animation:url.searchParams.get('animation')||null}:{})});
          response.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store','X-Source':result.source,'X-Session-Id':result.version.sessionId,'X-Document-Id':result.version.documentId,'X-Open-Epoch':result.version.openEpoch,'X-Revision':String(result.version.revision),'X-Derived-Hash':result.derivedHash??''});response.end(result.png);return;
        }
        if(url.pathname==='/api/events'){
          response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});streams.add(response);
          for(const event of store.eventHistory(Number(request.headers['last-event-id']??0)))response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          const heartbeat=setInterval(()=>response.write(': heartbeat\n\n'),15000);heartbeat.unref();
          request.on('close',()=>{clearInterval(heartbeat);streams.delete(response);});return;
        }
        throw new HostError('NOT_FOUND','没有该读取端点。',404);
      }
      if(request.method!=='POST')throw new HostError('METHOD_NOT_ALLOWED','仅支持已声明的 GET/POST。',405);
      if(closing&&url.pathname!=='/api/shutdown')throw new HostError('HOST_CLOSING','Host 正在关闭，拒绝新的操作；请等待事务与写入权交接。',409);
      if(request.headers.origin!==base||request.headers['content-type']?.split(';')[0]!=='application/json')throw new HostError('AUTH_REQUIRED','POST 必须使用精确本机 Origin 与 JSON。',403);
      const limit=['/api/capture','/api/asset-candidate'].includes(url.pathname)?8*1024*1024:256*1024;let length=0;const parts:Buffer[]=[];
      for await(const part of request){const buffer=Buffer.from(part);length+=buffer.length;if(length>limit)throw new HostError('PAYLOAD_TOO_LARGE','请求体超出上限。',413);parts.push(buffer);}
      const args=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
      for(const key of ['dryRun','reload'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw new HostError('INVALID_ARGUMENT',`${key} 必须是布尔值。`);
      let result:any;
      switch(url.pathname){
        case '/api/observation':
          rejectFields(args,['action']);
          if(args.action==='start')result=await observation.start();
          else if(args.action==='stop')result=await observation.stop();
          else throw new HostError('INVALID_ARGUMENT','观察操作只能为 start 或 stop。');
          break;
        case '/api/rollout-disable':rejectFields(args,[]);result=await rollout.disable();break;
        case '/api/evaluation-task': {
          if(args.action==='begin') {
            rejectFields(args,['action','taskId','leaseKey','expectedRevision']);
            if(!store.active)throw new HostError('DOC_NOT_LOADED','登记求解任务前先打开文档。',409);
            assertVersion(args.expectedRevision,store.active.version);
            if(store.active.kind!=='pose'&&(!store.animationViewingEnabled()||!store.active.view))throw new HostError('UNSUPPORTED_DOC_KIND','当前文档缺少已开放的显式动画/时间选择。',409);
            result=store.evaluationTasks.begin(args.taskId,args.leaseKey,args.expectedRevision);
          }else if(args.action==='heartbeat') {
            rejectFields(args,['action','taskId','leaseKey','stage']);result=store.evaluationTasks.heartbeat(args.taskId,args.leaseKey,args.stage);
          }else if(args.action==='finish') {
            rejectFields(args,['action','taskId','leaseKey','outcome','stage']);result=store.evaluationTasks.finish(args.taskId,args.leaseKey,args.outcome,args.stage);
          }else throw new HostError('INVALID_ARGUMENT','任务操作只能是 begin、heartbeat 或 finish。');
          store.onEvaluationTaskChanged();break;
        }
        case '/api/open':rejectFields(args,['manifestPath','path','reload','expectedRevision','animation','time']);result=await store.open(args);break;
        case '/api/snapshot':rejectFields(args,['expectedRevision','purpose']);result=await store.snapshot(args.expectedRevision,args.purpose);break;
        case '/api/derived':rejectFields(args,['expectedRevision','snapshotHash','dependencyFingerprint','result']);result=await store.publishDerived(args);break;
        case '/api/review':rejectFields(args,['expectedRevision','snapshotHash','derivedHash','reviewRecord','dryRun']);result=await store.registerReview(args);break;
        case '/api/asset-candidate':rejectFields(args,['expectedRevision','snapshotHash','outputPath','document','binding','dependencies','dryRun']);result=await store.stageAsset(args);break;
        case '/api/diagnostic-candidate':rejectFields(args,['expectedRevision','snapshotHash','document','dryRun']);result=await store.adoptDiagnostic(args);break;
        case '/api/diagnostic-open':rejectFields(args,['expectedRevision','snapshotHash','document','dependencies','outputPath','dryRun']);result=await store.openDiagnostic(args);break;
        case '/api/diagnostic-resume':rejectFields(args,['expectedRevision','diagnosticId','dryRun']);result=await store.resumeDiagnostic(args);break;
        case '/api/animation-candidate':rejectFields(args,['expectedRevision','session']);result=await store.registerAnimationCandidate(args);break;
        case '/api/animation-session':rejectFields(args,['expectedRevision']);result=await store.animationSession(args.expectedRevision);break;
        case '/api/animation-review':rejectFields(args,['expectedRevision','baseToken','reviewRecord','dryRun']);result=await store.registerAnimationReview(args);break;
        case '/api/authorize':rejectFields(args,['expectedRevision','snapshotHash','derivedHash','reviewHash','candidateHash','outputPath','intent','assetCandidateHash','animationCandidateHash','expectedHash','reviewToken','gateRecord']);result=await store.authorize(args);break;
        case '/api/pin':rejectFields(args,['expectedRevision','intent']);result=await store.pin(args.expectedRevision,args.intent);break;
        case '/api/patch':rejectFields(args,['expectedRevision','ops','dryRun','clientId','expectedCandidateHash']);result=await store.patch(args);break;
        case '/api/undo':case '/api/redo':rejectFields(args,['expectedRevision','dryRun','clientId']);result=await store.history(url.pathname.endsWith('undo')?'undo':'redo',args);break;
        case '/api/commit':rejectFields(args,['expectedRevision','outputPath','intent','assetCandidateHash','animationCandidateHash','expectedHash','reviewToken','dryRun','authorizationId','requestId']);result=await store.commit(args,isControl);break;
        case '/api/capture':
          if(args.captureId){rejectFields(args,['captureId','pngBase64','viewport','dpr','visibilityState','actual','actualCamera','resourceHashes','playerScriptHash','pma','error']);result=await capture.complete(args);}
          else{rejectFields(args,['expectedRevision','animation','time','viewport','size']);result=await capture.request(args);}break;
        case '/api/state':rejectFields(args,['loaded','playing','visibilityState','heartbeat']);Object.assign(pageState,args,{lastSeenAt:new Date().toISOString()});result={ok:true};break;
        case '/api/shutdown':rejectFields(args,['reason']);json(response,202,{ok:true,closing:true});void stop().catch(error=>process.stderr.write(`Host 关闭未完成：${String(error)}\n`));return;
        default:throw new HostError('NOT_FOUND','没有该写入端点。',404);
      }
      json(response,200,result);
    }catch(error:any){if(!response.headersSent)json(response,error instanceof HostError?error.status:400,hostFailure(error));else response.end();}
  });
  store.onEvent=event=>{observation.noteEvent(event.type);for(const response of streams)response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);};
  capture.onRequest=task=>{for(const response of streams)response.write(`event: capture-request\ndata: ${JSON.stringify(task)}\n\n`);};
  // Windows 的自动端口分配可能返回 Fetch 禁用的低端口；选浏览器可访问的高端口并处理竞争。
  for(let attempt=0;;attempt++){
    const selected=options.port||20000+randomBytes(2).readUInt16BE(0)%40000;
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(selected,'127.0.0.1',()=>{server.off('error',reject);resolve();});});break;}
    catch(error:any){if(options.port||!['EADDRINUSE','EACCES'].includes(error.code)||attempt>=9)throw error;}
  }
  const port=(server.address() as any).port,endpoint=`http://127.0.0.1:${port}`;
  const portFile=store.resolve('.spine-mcp/host-port.json'),controlFile=store.resolve('.spine-mcp/host-control.json');
  if(options.persist!==false){
    try{
      await persist(portFile,{pid:process.pid,port,token,apiVersion:'1',sessionId:store.sessionId,startedAt,instanceId,projectId:context.projectId??null,workspaceRoot:context.workspaceRoot});
      await persist(controlFile,{sessionId:store.sessionId,instanceId,control});
      const protectedFiles=await Promise.all([protect(portFile),protect(controlFile)]);controlProtected=protectedFiles[1];securityMode=protectedFiles.every(Boolean)?'acl':'token-only';
    }catch(error){await new Promise<void>(resolve=>server.close(()=>resolve()));throw error;}
  }
  // 仅程序内隔离测试可提前验证 C 机械约束；公开进程不绕过两周/分层证据启用验收。
  if(options.writeEnabled)await store.enableWriting();
  else if(process.env.SPINE_HOST_WRITE==='1'&&process.env.SPINE_HOST_ROLLOUT_APPROVAL)await rollout.enableFromApproval(process.env.SPINE_HOST_ROLLOUT_APPROVAL);
  function stop():Promise<void>{
    if(stopPromise)return stopPromise;closing=true;
    stopPromise=(async()=>{
      let observationError:unknown;
      try{await observation.stop('host-shutdown');}catch(error){observationError=error;}
      capture.close();await store.shutdown();
      for(const response of streams)response.end();streams.clear();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      if(options.persist!==false){
        for(const file of [portFile,controlFile])try{const record=JSON.parse(await readFile(file,'utf8'));if(record.instanceId===instanceId)await unlink(file);}catch(error:any){if(error.code!=='ENOENT')throw error;}
      }
      if(observationError)throw observationError;
    })();return stopPromise;
  }
  return{server,store,capture,observation,rollout,endpoint,token,control,instanceId,stop};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=getWorkspaceRoot(process.env.SPINE_HOST_PROJECT_ID),record=getRegisteredWorkspace(root,process.env.SPINE_HOST_PROJECT_ID);
  startHostServer({workspaceRoot:root,projectId:record?.projectId},{port:Number(process.env.SPINE_HOST_PORT??0)}).then(host=>{
    console.log(`动画工作区宿主已启动：${host.endpoint}（默认观察模式）`);
    for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>{void host.stop();});
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}
