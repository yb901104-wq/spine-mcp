import { callCreationTool } from '../src/creationTasks.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyMotionInterval, assertMotionRecovery } from '../src/motionInterval.js';
import { semanticAt } from '../src/retargetEngine.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { HostClient } from '../src/hostClient.js';
import { callCreationControl } from '../src/creationControls.js';
import { renderPoseComparison, reviewPose, poseChecks } from '../src/poseWorkflow.js';
const f=(time:number)=>({time,body:{x:0,y:0,rotate:0},head:0,channels:{torso:{x:0,y:0,rotate:0}},targets:{leftFoot:{x:0,y:0,contact:true},rightHand:{x:1,y:1,angle:0}},bendDirections:{rightArm:1}});
const motion=()=>({version:2,name:'test',duration:3,loop:false,coordinateSystem:'normalizedSkeleton',frames:[0,1,2,3].map(f),poseWorkflow:{standardPosePath:'standard.json',keyPoses:[{stageId:'a',time:0,posePath:'standard.json'},{stageId:'b',time:2,posePath:'middle.json'},{stageId:'c',time:3,posePath:'end.json'}]}});
const mapping={bones:{body:'body',head:'head',channels:{torso:'body'},anchors:{leftFoot:{},rightHand:{}}}};
test('motion 区间边界、区间外采样、固定支撑及已审查关键姿态不可绕过',()=>{
  const source=motion(),op={op:'editMotionInterval',start:0,end:2,frames:[{time:.5,body:{rotate:2},targets:{rightHand:{x:.9}}}]};
  const result=applyMotionInterval(source,op,new Map(),mapping);
  assert.equal(result.frames.length,5);assert.equal(source.frames.length,4);
  for(const t of [0,2,2.1,2.5,3])assert.deepEqual(semanticAt(result,t),semanticAt(source as any,t));
  assert.equal(result.frames[1].body.rotate,2);
  for(const bad of [{...op,start:.2},{...op,end:4},{...op,frames:[{time:2,head:1}]},{...op,frames:[{time:1,targets:{leftFoot:{y:3}}}]},{...op,frames:[{time:1,body:{x:1}},{time:1,head:1}]},{...op,frames:[{time:1,channels:{missing:{x:1}}}]},{...op,frames:[],keyPoses:[{stageId:'c',time:1.5}]}])assert.throws(()=>applyMotionInterval(source,bad,new Map(),mapping));
  const forged=structuredClone(result);forged.frames[1].targets.leftFoot.contact=false;assert.throws(()=>assertMotionRecovery({value:source,mapping}as any,forged),/支撑/);
});
test('motion 阶段替换只接收已批准修订，时间冲突与支撑变更拒绝',()=>{
  const source=motion(),p={frame:f(0),status:'confirmed',review:{decision:'approved'}};
  const op={op:'editMotionInterval',start:0,end:3,keyPoses:[{stageId:'b',posePath:'new.json',time:2.2}]};
  const changed=applyMotionInterval(source,op,new Map([['new.json',p]]),mapping);
  assert.equal(changed.poseWorkflow.keyPoses[1].time,2.2);assert.equal(changed.frames[2].time,2.2);
  assert.throws(()=>applyMotionInterval(source,{...op,keyPoses:[{stageId:'b',time:1}]},new Map(),mapping),/重叠/);
  assert.throws(()=>applyMotionInterval(source,op,new Map([['new.json',{...p,status:'draft'}]]),mapping),/批准/);
  const bad=structuredClone(p);bad.frame.targets.leftFoot.contact=false;assert.throws(()=>applyMotionInterval(source,op,new Map([['new.json',bad]]),mapping),/支撑/);
});
test('C2 motion 实际修改出图、撤销、恢复、备份保存与重开；C1 和旧版本拒绝',async()=>withHostFixture(async({root,context})=>{
  const sheet=await renderPoseComparison({posePaths:['a.pose.json','b.pose.json']},context);
  await reviewPose({posePath:'a.pose.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'机械协议桩',reason:'只用于受控区间事务测试，不代表真实美术批准',checks:poseChecks,dryRun:false},context);
  await reviewPose({posePath:'b.pose.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'机械协议桩',reason:'第二标准修订用于冻结依赖校验，不代表真实美术批准',checks:poseChecks,dryRun:false},context);
  let host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'});let client=new HostClient(context);
  try{
    const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
    const built=await client.assetCommand('spine_build_motion_from_poses',{expectedRevision:opened.version,standardPosePath:'a.pose.json',keyPoses:[{posePath:'a.pose.json',time:0,stageId:'start'},{posePath:'b.pose.json',time:.3,stageId:'end'}],motionPath:'interval.motion.json',name:'interval',duration:.3,loop:false,dryRun:false});
    await client.commit({expectedRevision:opened.version,outputPath:built.outputPath,intent:'asset',assetCandidateHash:built.candidateHash,requestId:'interval-source',dryRun:false});
    const source=await readFile(path.join(root,'interval.motion.json')),poseSource=await readFile(path.join(root,'a.pose.json'));
    const selected=await client.open({path:built.outputPath,animation:'interval',time:.15,expectedRevision:opened.version,recheck:true});await client.rpc('/api/pin',{expectedRevision:selected.version});
    assert.equal((await client.state()).capabilities.operations.find((o:any)=>o.operation==='patch').canRun,true);
    const state=await client.state(),beforePlayback=JSON.stringify(host.store.active!.value);const bundle=await client.rpc('/api/playback-bundle?'+new URLSearchParams({...state.version,candidateHash:state.playback.candidateHash}));assert.equal(bundle.evidenceEligible,false);assert.equal(bundle.stages.length,2);assert.equal(JSON.stringify(host.store.active!.value),beforePlayback);await assert.rejects(client.rpc('/api/playback-bundle?'+new URLSearchParams({...state.version,candidateHash:'bad'})),{code:'SOLUTION_STALE'});
    const args={expectedRevision:selected.version,start:0,end:.3,frames:[{time:.15,head:1}]};
    const dry=await callCreationControl('spine_edit_motion_interval',args,context);assert.equal(dry.dryRun,true);assert.equal(host.store.active!.value.frames.length,2);
    const changed=await callCreationControl('spine_edit_motion_interval',{...args,dryRun:false},context);assert.ok(changed.__imageData);assert.equal(host.store.active!.value.frames[1].head,1);
    await assert.rejects(callCreationControl('spine_edit_motion_interval',{...args,dryRun:false},context),{code:'REVISION_CONFLICT'});
    const undone=await client.history('undo',{expectedRevision:changed.version,dryRun:false});assert.equal(host.store.active!.value.frames.length,2);
    const redone=await client.history('redo',{expectedRevision:undone.version,dryRun:false});assert.equal(host.store.active!.value.frames[1].head,1);
    await host.stop();host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'});client=new HostClient(context);
    const recovered=await client.open({path:built.outputPath,animation:'interval',time:.15,recheck:true});assert.equal(host.store.active!.value.frames[1].head,1);assert.equal(host.store.active!.review,null);
    await client.rpc('/api/pin',{expectedRevision:recovered.version});
    const saved=await client.commit({expectedRevision:recovered.version,outputPath:'interval-v2.motion.json',requestId:'interval-revision',dryRun:false});assert.ok(saved.backupPath);
    assert.deepEqual(await readFile(path.join(root,'interval.motion.json')),source);assert.deepEqual(await readFile(path.join(root,'a.pose.json')),poseSource);
    const again=await client.open({path:saved.outputPath,animation:'interval',time:.15,expectedRevision:saved.version,recheck:true});assert.equal(again.activeDoc.kind,'motion');assert.equal(host.store.active!.value.frames[1].head,1);
    const isolated=await callCreationTool('spine_start_creation_task',{characterId:'hero',referencePath:'body.png',stages:[{stageId:'animation',documentPath:'interval-v2.motion.json'}],isolatedDirectory:'motion-reisolated',dryRun:false},context);const task=JSON.parse(await readFile(path.join(isolated.taskContext.workspaceRoot,isolated.recordPath),'utf8'));assert.ok(task.inputs.some((d:any)=>d.path==='b.pose.json'));assert.equal(isolated.isolation.journalCopied,false);
  }finally{await host.stop();}
  const c1=await startHostServer(context,{writeEnabled:true});try{const c1Client=new HostClient(context),opened=await c1Client.open({path:'interval-v2.motion.json'});assert.equal((await c1Client.state()).capabilities.editing.motionIntervals.supported,false);await assert.rejects(c1Client.rpc('/api/pin',{expectedRevision:opened.version}),{code:'CAPABILITY_MISSING'});}finally{await c1.stop();}
},{neutralSetup:true}));
