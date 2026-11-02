// 同一冻结任务的 detached/attached 对照；真实 stdio，token 不估算。非完整 GIF 作品效率结论。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const directory=process.env.SPINE_VALIDATION_BUILD??'dist',load=file=>import(pathToFileURL(path.resolve(directory,file+'.js')).href);
const {strictHash,objectHash}=await load('hostContracts'),{hostBuildFingerprint}=await load('hostReleaseEvidence'),{startHostServer}=await load('hostServer');
const sourceRoot=path.resolve(process.argv.slice(2).find(a=>!a.startsWith('--'))??'D:/AI_cc/spine test/body-reference-trials/2026-10-24T15-53-20-542Z'),sourceManifest=JSON.parse(await fs.readFile(path.join(sourceRoot,'.spine-workflow.json'),'utf8'));
process.env.SPINE_MCP_REGISTRY_ROOT=sourceRoot;process.env.SPINE_MCP_WORKSPACE=sourceRoot;
const preflight=process.argv.includes('--preflight');
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),reportPath=`docs/plans/creation-performance-${stamp}.json`,count=preflight?1:30;
const report={schemaVersion:1,at:new Date().toISOString(),sourceRoot,scope:'同一原 GIF 起始帧适配请求（dryRun，无参考批准）在 detached/attached 的真实 stdio 对照；同冻结标准姿态另测状态、帧、头部 +1°、撤销、备份保存。不是完整 GIF 动作交付或模型效率证明。',build:await hostBuildFingerprint(),environment:{node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length},warmups:2,samplesPerRound:count,rounds:[],tokenUsage:null,tokenReason:'MCP SDK 客户端不提供模型实际 token 记录。',capture:'notRun: 真实浏览器权限审核超时',pageReload:'notRun',preparation:[],passed:false,formalPerformanceEvidence:!preflight};
report.capture='notRun: 本计量驱动不操作浏览器，真实 player 与播放验收另有独立记录';
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
const quality=value=>{const c=value.comparison??{};return {numeric:value.numeric?.ok??null,reference:c.ok??null,metrics:c.metrics?.map(m=>({id:m.id,status:m.status,error:m.error??null,required:m.required}))??null};};
for(let round=1;round<=(preflight?1:3);round++){
 const record={round,modes:[]};report.rounds.push(record);
 for(const mode of round%2?['detached','attached']:['attached','detached']){
  const protocol=new Client({name:'creation-efficiency-'+mode,version:'1'});let context={workspaceRoot:sourceRoot,projectId:sourceManifest.projectId},host,version;
  const calls=[];let phase='preparation';const result={mode,samples:[],calls};record.modes.push(result);
  const call=async(name,args={})=>{const start=performance.now(),response=await protocol.callTool({name,arguments:{projectId:context.projectId,...args}}),text=response.content.filter(c=>c.type==='text').map(c=>c.text).join(''),value=JSON.parse(text),images=response.content.filter(c=>c.type==='image');const metric={tool:name,phase,durationMs:performance.now()-start,textBytes:Buffer.byteLength(text),imageBytes:images.reduce((n,i)=>n+Buffer.from(i.data,'base64').length,0),imageCount:images.length,imageHashes:images.map(i=>strictHash(Buffer.from(i.data,'base64'))),error:response.isError===true};calls.push(metric);assert.notEqual(response.isError,true,name+': '+text);return {value,metric};};
  try{
   await protocol.connect(new StdioClientTransport({command:process.execPath,args:[path.join(directory,'server.js')],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:sourceRoot,SPINE_MCP_REGISTRY_ROOT:sourceRoot,SPINE_HOST_AUTOSTART:'0'}}));
   await call('spine_register_workspace',{rootPath:sourceRoot,projectId:sourceManifest.projectId});
   const prepared=await call('spine_start_creation_task',{characterId:'npc1',referencePath:'reference/body.gif',sequencePath:'reference/body.sequence.json',stages:[{stageId:'standard',documentPath:'trial/neutral-stand-v2.pose.json'}],isolatedDirectory:`creation-performance/${stamp}/r${round}-${mode}`,dryRun:false});context=prepared.value.taskContext;result.context=context;result.taskId=prepared.value.taskId;
   const taskFull=(await call('spine_get_creation_task',{taskId:result.taskId,responseDetail:'full'})).value;result.frozenInputHashes=taskFull.task.inputs.filter(i=>i.path!=='.spine-workflow.json').map(({path,hash})=>({path,hash}));result.isolationManifestHash=taskFull.task.inputs.find(i=>i.path==='.spine-workflow.json').hash;result.isolationManifestComparison='只比较角色/参考/审查/策略字节；隔离工程 ID 导致根清单哈希不同，分别保留。';
   if(mode==='attached'){host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'});const opened=await call('spine_host_open',{path:'trial/neutral-stand-v2.pose.json',recheck:true});version=opened.value.version;await call('spine_host_pin',{expectedRevision:version});}
   for(let i=-2;i<count;i++){
    phase=i<0?'warmup':'execution';const args={referencePosePath:'reference/ready-v1.reference.json',visualRigPath:'trial/npc1.visual-rig.json',standardPosePath:'trial/neutral-stand-v2.pose.json',sequencePath:'reference/body.sequence.json',stageId:'ready',posePath:'trial/benchmark-ready.pose.json',id:'benchmark-frozen-ready',dryRun:true,responseDetail:'full',...mode==='attached'?{expectedRevision:version}:{}};
    const adapted=await call('spine_retarget_reference_pose',args),q=quality(adapted.value);assert.equal(q.reference,false);const sample={iteration:i,retargetMs:adapted.metric.durationMs,retargetBytes:adapted.metric.textBytes,qualityHash:objectHash(q)};
    if(!result.quality)result.quality=q;assert.equal(objectHash(result.quality),sample.qualityHash);
    if(mode==='attached'){
     const state=await call('spine_preview_state'),frame=await call('spine_preview_frame',{expectedRevision:version,size:480});sample.stateMs=state.metric.durationMs;sample.frameMs=frame.metric.durationMs;
     const patch=await call('spine_adjust_pose_intent',{expectedRevision:version,headTilt:1,dryRun:false});version=patch.value.version;sample.patchToFrameMs=patch.metric.durationMs;sample.patchPipeline=patch.value.timings;
     const undo=await call('spine_host_undo',{expectedRevision:version,dryRun:false});version=undo.value.version;sample.undoToFrameMs=undo.metric.durationMs;sample.undoTransactionMs=undo.value.timings?.undoTransactionMs??null;sample.pixelReadback={frame:frame.metric.imageHashes,patch:patch.metric.imageHashes,undo:undo.metric.imageHashes};assert.deepEqual(sample.pixelReadback.frame,sample.pixelReadback.undo);assert.notDeepEqual(sample.pixelReadback.patch,sample.pixelReadback.undo);
     const commit=await call('spine_host_commit',{expectedRevision:version,outputPath:`trial/benchmark-r${round}-${i+2}.pose.json`,requestId:`benchmark-${round}-${i+2}`,dryRun:false});sample.commitMs=commit.metric.durationMs;assert.ok(commit.value.backupPath);
     phase='iterationReset';const reopen=await call('spine_host_open',{path:commit.value.outputPath,expectedRevision:commit.value.version,recheck:true});version=reopen.value.version;await call('spine_host_pin',{expectedRevision:version});
    }
    if(i>=0)result.samples.push(sample);
    if(i>=0&&i%10===9)console.log(JSON.stringify({round,mode,completed:i+1,total:count}));
   }
   phase='verification';const after=await call('spine_get_creation_task',{taskId:result.taskId});assert.equal(after.value.freshness.current,true);result.inputsUnchanged=true;
   result.phases=Object.fromEntries(['retargetMs','stateMs','frameMs','patchToFrameMs','undoToFrameMs','undoTransactionMs','commitMs'].filter(k=>result.samples.every(s=>Number.isFinite(s[k]))).map(k=>[k,{p95:p95(result.samples.map(s=>s[k])),maximum:Math.max(...result.samples.map(s=>s[k]))}]));
   result.cost=Object.fromEntries(['preparation','warmup','execution','iterationReset','verification'].map(p=>{const selected=calls.filter(c=>c.phase===p);return [p,{calls:selected.length,durationMs:selected.reduce((n,c)=>n+c.durationMs,0),textBytes:selected.reduce((n,c)=>n+c.textBytes,0),imageBytes:selected.reduce((n,c)=>n+c.imageBytes,0),images:selected.reduce((n,c)=>n+c.imageCount,0)}];}));
  }catch(error){result.error=error.stack??String(error);process.exitCode=1;throw error;}
  finally{await protocol.close();await host?.stop();result.hostStopped=true;await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');}
 }
 const [a,b]=record.modes;record.comparableCosts=Object.fromEntries(record.modes.map(m=>[m.mode,{calls:m.samples.length,durationMs:m.samples.reduce((n,s)=>n+s.retargetMs,0),textBytes:m.samples.reduce((n,s)=>n+s.retargetBytes,0),scope:'同一冻结起始帧适配请求；其它附着微预算操作不混入效率比较'}]));record.sameInputHashes=objectHash(a.frozenInputHashes)===objectHash(b.frozenInputHashes);record.sameQuality=objectHash(a.quality)===objectHash(b.quality);assert.equal(record.sameInputHashes,true);assert.equal(record.sameQuality,true);
 const attached=record.modes.find(m=>m.mode==='attached');const budgets={stateMs:20,frameMs:50,patchToFrameMs:120,undoTransactionMs:50,undoToFrameMs:120,commitMs:200};record.budgets=Object.fromEntries(Object.entries(budgets).map(([k,limit])=>[k,{limit,p95:attached.phases[k]?.p95??null,passed:attached.phases[k]?attached.phases[k].p95<limit:false}]));record.budgetsPassed=Object.values(record.budgets).every(v=>v.passed);
 await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
}
report.passed=true;report.budgetsPassed=report.rounds.every(r=>r.budgetsPassed);report.finishedAt=new Date().toISOString();await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({reportPath,passed:true,budgetsPassed:report.budgetsPassed,rounds:report.rounds.map(r=>({round:r.round,budgets:r.budgets}))}));
