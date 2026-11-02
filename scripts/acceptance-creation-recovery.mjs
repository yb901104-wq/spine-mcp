// 真实 npc1 隔离会话恢复、取消与提交重试；只经正式 MCP 编辑，不改源 JSON。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HostClient} from '../dist/hostClient.js';
import {strictHash} from '../dist/hostContracts.js';
const baselinePath=process.argv[2];if(!baselinePath)throw Error('参数须为已完成的 creation-usability-trial 报告路径。');
const baseline=JSON.parse(await fs.readFile(baselinePath,'utf8')),context={workspaceRoot:baseline.task.workspaceRoot,projectId:baseline.task.projectId};
assert.equal(baseline.finished,true);assert.equal(baseline.hostStopped,true);assert.equal(baseline.writerReleased,true);
const report={schemaVersion:1,at:new Date().toISOString(),baselinePath,workspaceRoot:context.workspaceRoot,taskId:baseline.task.taskId,scope:'真实既有阶段：恢复、取消、旧版本及同一提交重试；不替代新参考准备或完整故障矩阵。',calls:[],passed:false};
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),reportPath=`docs/plans/creation-recovery-${stamp}.json`;
const env={...process.env,SPINE_MCP_WORKSPACE:context.workspaceRoot,SPINE_MCP_REGISTRY_ROOT:baseline.sourceRoot,SPINE_HOST_AUTOSTART:'0'};
const client=new Client({name:'creation-recovery-real-npc1',version:'1'});let host;
async function launch(resume){
  const child=spawn(process.execPath,['dist/creationTrialServer.js','--workspace',context.workspaceRoot,'--isolated',...resume?['--resume']:[]],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('隔离恢复启动超时')),20000);for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;for(const line of output.split('\n')){try{const m=JSON.parse(line);if(m.type==='creation-host-ready'){clearTimeout(timer);resolve({child,output,ready:m});}}catch{}}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({child,output,code});});});
}
async function call(name,args={},allowError=false,options){const start=performance.now();const r=await client.callTool({name,arguments:{projectId:context.projectId,...args}},undefined,options);const text=r.content.filter(c=>c.type==='text').map(c=>c.text).join(''),v=JSON.parse(text);report.calls.push({tool:name,durationMs:performance.now()-start,textBytes:Buffer.byteLength(text),error:r.isError===true,code:v.code??null});if(r.isError&&!allowError)throw Error(`${name}: ${text}`);return {...v,isError:r.isError===true};}
try{
  const refused=await launch(false);assert.equal(refused.code,1);const preview=refused.output.split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(m=>m?.type==='recovery-preview');assert.ok(preview?.recovery.length);assert.match(refused.output,/journal|恢复/);report.freshStartRefused={exitCode:refused.code,preview};
  const resumed=await launch(true);host=resumed.child;assert.ok(resumed.ready);report.resume={endpoint:resumed.ready.endpoint,explicit:true};
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],stderr:'pipe',env}));
  const opened=await call('spine_host_open',{path:'trial/ready-v1.pose.json',recheck:true});assert.ok(opened.version);assert.equal(opened.state.uncommitted,true);report.recovered={version:opened.version,uncommitted:opened.state.uncommitted,referenceStatus:opened.state.creationQuality.referenceStatus,hasApproval:opened.state.agentVisual?.status==='approved'};assert.equal(report.recovered.hasApproval,false);
  await call('spine_host_pin',{expectedRevision:opened.version});
  const stale=await call('spine_host_undo',{expectedRevision:baseline.refinement.version},true);assert.equal(stale.isError,true);report.oldVersionDenied={code:stale.code};
  const before=await call('spine_preview_state',{}),cancelledOutput=`trial/cancelled-${stamp}.pose.json`,controller=new AbortController();let sawProgress=false,aborted=false;
  try{await call('spine_refine_reference_pose',{posePath:'trial/ready-v1.pose.json',outputPosePath:cancelledOutput,expectedRevision:before.version,dryRun:false},false,{signal:controller.signal,onprogress:()=>{sawProgress=true;controller.abort();}});}catch(error){if(controller.signal.aborted){aborted=true;report.cancelMessage=String(error.message);}else throw error;}
  assert.equal(sawProgress,true);assert.equal(aborted,true);
  // 后续实际 MCP 请求等待前一请求检查点收束，再核对版本与文件，不以客户端 abort 等同服务端停止。
  let after;for(let i=0;i<50;i++){after=await call('spine_preview_state',{});if(!after.evaluationTask&&!after.busy)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.deepEqual(after.version,before.version);await assert.rejects(fs.access(path.join(context.workspaceRoot,cancelledOutput)),e=>e.code==='ENOENT');report.cancellation={progressObserved:sawProgress,versionUnchanged:true,outputAbsent:true};
  const savedBefore=strictHash(await fs.readFile(path.join(context.workspaceRoot,baseline.closedLoop.savedPath))),requestId='creation-'+path.basename(baselinePath).replace('creation-usability-trial-','').replace('.json','');
  const replay=await call('spine_host_commit',{expectedRevision:baseline.calls.find(c=>c.tool==='spine_host_undo').version,outputPath:baseline.closedLoop.savedPath,requestId,dryRun:false});assert.equal(replay.replayed,true);assert.equal(strictHash(await fs.readFile(path.join(context.workspaceRoot,baseline.closedLoop.savedPath))),savedBefore);report.retry={replayed:true,outputUnchanged:true,version:replay.version};
  const conflict=await call('spine_host_commit',{expectedRevision:before.version,outputPath:`trial/retry-conflict-${stamp}.pose.json`,requestId,dryRun:false},true);assert.equal(conflict.isError,true);assert.equal(conflict.code,'REQUEST_CONFLICT');report.retryConflictDenied=true;
  const task=await call('spine_get_creation_task',{taskId:baseline.task.taskId});assert.equal(task.freshness.current,true);report.inputsUnchanged=true;report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{if(host){try{await new HostClient(context).shutdownForSwitch();}catch(error){report.shutdownError=String(error);}await new Promise(resolve=>{if(host.exitCode!==null)return resolve();host.once('exit',resolve);setTimeout(resolve,10000);});report.hostStopped=host.exitCode!==null||host.signalCode!==null;}await client.close();try{await fs.access(path.join(context.workspaceRoot,'.spine-mcp/writer.lock'));report.writerReleased=false;}catch{report.writerReleased=true;}await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({reportPath,passed:report.passed,hostStopped:report.hostStopped,writerReleased:report.writerReleased,error:report.error??null}));}
