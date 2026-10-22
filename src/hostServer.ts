#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostEditorStore } from './hostEditorStore.js';
import { HostCapture } from './hostCapture.js';
import { HostError, hostFailure, rejectFields } from './hostContracts.js';
import { getRegisteredWorkspace, getWorkspaceRoot } from './workspaceTools.js';
import type { ToolContext } from './spineJson.js';
const installRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const secret=()=>randomBytes(32).toString('hex');
const matches=(actual:unknown,expected:string)=>typeof actual==='string'&&actual.length===expected.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
async function protect(file:string){
  try{
    if(process.platform==='win32'){
      const run=promisify(execFile),who=await run('whoami',['/user','/fo','csv','/nh'],{windowsHide:true});
      const sid=who.stdout.match(/S-1-[0-9-]+/)?.[0];if(!sid)return false;
      await run('icacls',[file,'/inheritance:r','/grant:r',`*${sid}:(F)`],{windowsHide:true});
    }else await chmod(file,0o600);
    return true;
  }catch{return false;}
}
async function persist(file:string,value:unknown){
  await mkdir(path.dirname(file),{recursive:true});const handle=await open(file,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
}
export async function startHostServer(context:ToolContext,options:{port?:number;persist?:boolean;writeEnabled?:boolean;captureTimeoutMs?:number}={}){
  const store=new HostEditorStore(context),capture=new HostCapture(store,options.captureTimeoutMs);
  const token=secret(),control=secret(),instanceId=randomUUID(),startedAt=new Date().toISOString();
  let controlProtected=options.persist===false,securityMode:'acl'|'token-only'='token-only',closing=false,stopPromise:Promise<void>|null=null;
  const streams=new Set<ServerResponse>();let frames:number[]=[];
  const pageState:any={loaded:false,playing:false,lastSeenAt:null};
  const json=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  const server=createServer(async(request,response)=>{
    const base=`http://127.0.0.1:${(server.address() as any)?.port}`;
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
      const controlRoute=['/api/snapshot','/api/derived','/api/review','/api/authorize'].includes(url.pathname);
      const isControl=controlProtected&&matches(request.headers['x-spine-host-control'],control);
      if(controlRoute&&!isControl)throw new HostError('CONTROL_REQUIRED','该端点仅允许受保护的 MCP 控制通道。',403);
      if(request.method==='GET'){
        if(url.pathname==='/api/state'||url.pathname==='/api/capabilities'){
          const state={...await store.state(url.pathname==='/api/capabilities'||url.searchParams.get('includeCapabilities')!=='false'),instanceId,startedAt,security:{mode:securityMode,controlProtected},preview:pageState,
            rollout:{writeRequested:process.env.SPINE_HOST_WRITE==='1',writeEnabled:store.writeMode==='attached',message:'公开写入仍受 B 稳定观察与截图分层验收约束；默认观察模式。'}};
          for(const operation of state.capabilities?.operations??[]){
            if(operation.operation==='capture'&&store.active?.derived?.live){operation.canRun=pageState.visibilityState==='visible'&&Date.now()-Date.parse(pageState.lastSeenAt??'')<3000;operation.state=operation.canRun?'ready':'blocked';operation.reasons=operation.canRun?[]:[{code:'CAPTURE_TIMEOUT',message:'需要可见且正在上报心跳的 player 页面。'}];operation.nextAction={tool:operation.canRun?'spine_preview_capture':null,instruction:'截图准入由 captureValidity 与当前版本核验；rendererParity 单独记录，动作仍须视觉审查。'};}
            if(['evaluate','review'].includes(operation.operation)&&!controlProtected){operation.canRun=false;operation.state='blocked';operation.reasons=[{code:'CONTROL_REQUIRED',message:'控制凭据文件保护未通过，不能发布求解或审查结果。'}];}
          }
          json(response,200,url.pathname==='/api/state'?state:state.capabilities);return;
        }
        if(url.pathname==='/api/doc'){json(response,200,await store.inspect(url.searchParams.get('view')??'bones'));return;}
        if(url.pathname==='/api/player-bundle'){json(response,200,await capture.bundle(url.searchParams.get('captureId')??''));return;}
        if(url.pathname==='/api/frame'){
          const now=Date.now();frames=frames.filter(t=>now-t<1000);if(frames.length>=20){response.setHeader('Retry-After','1');throw new HostError('RATE_LIMITED','frame 每秒最多 20 次。',429);}frames.push(now);
          const expectedRevision:any={};for(const k of ['sessionId','documentId','openEpoch'])expectedRevision[k]=url.searchParams.get(k);
          expectedRevision.revision=url.searchParams.has('revision')?Number(url.searchParams.get('revision')):null;
          const result=await store.frame({expectedRevision,size:url.searchParams.has('size')?Number(url.searchParams.get('size')):undefined,time:url.searchParams.has('time')?Number(url.searchParams.get('time')):undefined});
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
      const limit=url.pathname==='/api/capture'?8*1024*1024:256*1024;let length=0;const parts:Buffer[]=[];
      for await(const part of request){const buffer=Buffer.from(part);length+=buffer.length;if(length>limit)throw new HostError('PAYLOAD_TOO_LARGE','请求体超出上限。',413);parts.push(buffer);}
      const args=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
      for(const key of ['dryRun','reload'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw new HostError('INVALID_ARGUMENT',`${key} 必须是布尔值。`);
      let result:any;
      switch(url.pathname){
        case '/api/open':rejectFields(args,['manifestPath','path','reload','expectedRevision']);result=await store.open(args);break;
        case '/api/snapshot':rejectFields(args,['expectedRevision']);result=await store.snapshot(args.expectedRevision);break;
        case '/api/derived':rejectFields(args,['expectedRevision','snapshotHash','dependencyFingerprint','result']);result=await store.publishDerived(args);break;
        case '/api/review':rejectFields(args,['expectedRevision','snapshotHash','derivedHash','reviewRecord','dryRun']);result=await store.registerReview(args);break;
        case '/api/authorize':rejectFields(args,['expectedRevision','snapshotHash','derivedHash','reviewHash','candidateHash','outputPath','intent','gateRecord']);result=await store.authorize(args);break;
        case '/api/pin':rejectFields(args,['expectedRevision']);result=await store.pin(args.expectedRevision);break;
        case '/api/patch':rejectFields(args,['expectedRevision','ops','dryRun','clientId']);result=await store.patch(args);break;
        case '/api/undo':case '/api/redo':rejectFields(args,['expectedRevision','dryRun','clientId']);result=await store.history(url.pathname.endsWith('undo')?'undo':'redo',args);break;
        case '/api/commit':rejectFields(args,['expectedRevision','outputPath','intent','dryRun','authorizationId','requestId']);result=await store.commit(args,isControl);break;
        case '/api/capture':
          if(args.captureId){rejectFields(args,['captureId','pngBase64','viewport','dpr','visibilityState','actual','actualCamera','resourceHashes','playerScriptHash','pma','error']);result=await capture.complete(args);}
          else{rejectFields(args,['expectedRevision','time','viewport','size']);result=await capture.request(args);}break;
        case '/api/state':rejectFields(args,['loaded','playing','visibilityState','heartbeat']);Object.assign(pageState,args,{lastSeenAt:new Date().toISOString()});result={ok:true};break;
        case '/api/shutdown':rejectFields(args,['reason']);json(response,202,{ok:true,closing:true});void stop().catch(error=>process.stderr.write(`Host 关闭未完成：${String(error)}\n`));return;
        default:throw new HostError('NOT_FOUND','没有该写入端点。',404);
      }
      json(response,200,result);
    }catch(error:any){if(!response.headersSent)json(response,error instanceof HostError?error.status:400,hostFailure(error));else response.end();}
  });
  store.onEvent=event=>{for(const response of streams)response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);};
  capture.onRequest=task=>{for(const response of streams)response.write(`event: capture-request\ndata: ${JSON.stringify(task)}\n\n`);};
  // Windows 的自动端口分配可能返回 Fetch 禁用的低端口；选浏览器可访问的高端口并处理竞争。
  for(let attempt=0;;attempt++){
    const selected=options.port||20000+randomBytes(2).readUInt16BE(0)%40000;
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(selected,'127.0.0.1',()=>{server.off('error',reject);resolve();});});break;}
    catch(error:any){if(options.port||error.code!=='EADDRINUSE'||attempt>=9)throw error;}
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
  function stop():Promise<void>{
    if(stopPromise)return stopPromise;closing=true;
    stopPromise=(async()=>{
      capture.close();await store.shutdown();
      for(const response of streams)response.end();streams.clear();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      if(options.persist!==false){
        for(const file of [portFile,controlFile])try{const record=JSON.parse(await readFile(file,'utf8'));if(record.instanceId===instanceId)await unlink(file);}catch(error:any){if(error.code!=='ENOENT')throw error;}
      }
    })();return stopPromise;
  }
  return{server,store,capture,endpoint,token,control,instanceId,stop};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=getWorkspaceRoot(process.env.SPINE_HOST_PROJECT_ID),record=getRegisteredWorkspace(root,process.env.SPINE_HOST_PROJECT_ID);
  startHostServer({workspaceRoot:root,projectId:record?.projectId},{port:Number(process.env.SPINE_HOST_PORT??0)}).then(host=>{
    console.log(`动画工作区宿主已启动：${host.endpoint}（默认观察模式）`);
    for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>{void host.stop();});
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}
