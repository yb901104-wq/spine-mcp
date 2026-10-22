import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { withHostFixture } from './helpers/hostFixture.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
import { strictHash, objectHash } from '../src/hostContracts.js';
import { preparePoseSource } from '../src/poseWorkflow.js';
import { solvePoseKernel } from '../src/animationKernel.js';
import { getPoseState, explainPose } from '../src/poseOps.js';
import { createMotionRuntime, worldVertices } from '../src/motionRuntime.js';
import { applyRenderSnapshot } from '../src/renderSnapshot.js';
import { releaseWriter } from '../src/writerOwnership.js';
import { setBoneKeyframe } from '../src/spineJson.js';
import { saveJson } from '../src/mappingTools.js';
import { poseDependencies,poseDigest } from '../src/poseDigest.js';
const patch=(version:any,x=.11)=>({expectedRevision:version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',x}],dryRun:false});
const state=(s:HostEditorStore)=>s.active!.version;
async function evaluate(s:HostEditorStore){const snapshot=await s.snapshot(state(s)),result=await evaluateHostSnapshot(snapshot,s.context);await s.publishDerived({expectedRevision:snapshot.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result});return result;}
async function authorize(s:HostEditorStore,outputPath:string){const args={expectedRevision:state(s),outputPath,intent:'draft'},candidate=await s.commit(args,true),snapshot=await s.snapshot(state(s));return s.authorize({...args,candidateHash:candidate.candidateHash,snapshotHash:snapshot.snapshotHash,derivedHash:snapshot.derivedHash,reviewHash:s.active!.reviewHash,gateRecord:{gate:'pose-draft',passed:true,candidateHash:candidate.candidateHash}});}

test('快照依赖覆盖动作其它阶段与标准姿态的传递引用；facing 改动使缓存失效',async()=>withHostFixture(async({root,context})=>{
  const pose=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8'));
  assert.equal((await poseDigest(pose,context)).freshness,'current');
  assert.equal((await poseDigest({...pose,facing:pose.facing==='left'?'right':'left'},context)).freshness,'stale');
  await writeFile(path.join(root,'other-reference.json'),JSON.stringify({observation:{imagePath:'body.png',basis:'测试阶段一'}}));
  await writeFile(path.join(root,'dependency-sequence.json'),JSON.stringify({stages:[{referencePosePath:'other-reference.json'}]}));
  await writeFile(path.join(root,'dependency-standard.json'),JSON.stringify({sequencePath:'dependency-sequence.json'}));
  const input={...pose,standardPosePath:'dependency-standard.json'},before=await poseDependencies(input,context);
  assert.ok(before.dependencies.some(d=>d.filePath==='other-reference.json'));
  await writeFile(path.join(root,'other-reference.json'),JSON.stringify({observation:{imagePath:'body.png',basis:'测试阶段二'}}));
  assert.notEqual((await poseDependencies(input,context)).dependencyFingerprint,before.dependencyFingerprint);
}));

test('纯求解不重读文件，默认姿态摘要零求解；完整回放含 setup/皮肤/附件/层序',async()=>withHostFixture(async({root,context})=>{
  const p=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8')),prepared=await preparePoseSource(p,context);
  await rename(path.join(root,'body.json'),path.join(root,'body.hold'));
  let solved:any;try{solved=solvePoseKernel(p,prepared.source,prepared.visualReader);}finally{await rename(path.join(root,'body.hold'),path.join(root,'body.json'));}
  const digest=await getPoseState({posePath:'a.pose.json'},context);assert.equal(digest.solveCount,0);assert.equal(digest.freshness,'current');
  assert.equal((await explainPose({posePath:'a.pose.json'},context)).solveCount,0);
  const rt=createMotionRuntime(prepared.source.doc.json,await readFile(path.join(root,'body.atlas'),'utf8'));
  applyRenderSnapshot(rt.skeleton,{bones:solved.bones,slotAttachments:prepared.source.mapping.bones.slotAttachments,presentation:p.frame.presentation});
  assert.deepEqual(worldVertices(rt.skeleton),worldVertices(solved.skeleton));
  for(const b of rt.skeleton.bones){const actual=solved.skeleton.findBone(b.data.name)!;assert.ok(Math.abs(b.worldX-actual.worldX)<1e-4);assert.ok(Math.abs(b.worldY-actual.worldY)<1e-4);}
  applyRenderSnapshot(rt.skeleton,{bones:{},skin:'alternate',presentation:{attachments:{accentSlot:null},drawOrder:['accentSlot','bodySlot']}});
  assert.equal(rt.skeleton.skin?.name,'alternate');assert.equal(rt.skeleton.findSlot('accentSlot')!.getAttachment(),null);assert.equal(rt.skeleton.drawOrder[0].data.name,'accentSlot');
  applyRenderSnapshot(rt.skeleton,{bones:{}});assert.equal(rt.skeleton.findSlot('accentSlot')!.getAttachment()?.name,'body');
  assert.throws(()=>applyRenderSnapshot(rt.skeleton,{bones:{body:{scale:{x:1,y:1}}as any}}),/增量字段/);
}));

test('只读 Host：幂等打开、ABA、外部漂移、显式重载及确定性 PNG',async()=>withHostFixture(async({root,context})=>{
  const s=new HostEditorStore(context,'mirror');await assert.rejects(s.frame({expectedRevision:{}as any}),/先显式打开/);
  await s.open({manifestPath:'.spine-workflow.json'});assert.equal((await s.state()).activeDoc,null);
  assert.equal((await s.state()).capabilities.characters[0].characterId,'hero');
  await s.open({path:'a.pose.json'});const a=structuredClone(state(s));
  assert.equal((await s.open({path:'a.pose.json'})).reopened,true);assert.deepEqual(state(s),a);
  const one=await s.frame({expectedRevision:a}),two=await s.frame({expectedRevision:a});assert.equal(strictHash(one.png),strictHash(two.png));
  await s.open({path:'b.pose.json',expectedRevision:a});await assert.rejects(s.snapshot(a),/完整版本/);
  await s.open({path:'a.pose.json',expectedRevision:state(s)});assert.notEqual(state(s).openEpoch,a.openEpoch);await assert.rejects(s.snapshot(a),/完整版本/);
  await writeFile(path.join(root,'a.pose.json'),(await readFile(path.join(root,'a.pose.json'),'utf8'))+' ');
  assert.equal((await s.state()).targetStale,true);await assert.rejects(s.open({path:'a.pose.json'}),/磁盘或依赖/);
  const before=state(s);await s.open({path:'a.pose.json',reload:true,expectedRevision:before});assert.notEqual(state(s).openEpoch,before.openEpoch);
  await s.open({path:'body.json',expectedRevision:state(s)});await assert.rejects(s.frame({expectedRevision:state(s)}),/只支持 pose/);
}));

test('持久编辑：100 patch + 20 undo，默认 dryRun 零变更、并发版本冲突、旧结果拒绝',async()=>withHostFixture(async({root,context})=>{
  const s=new HostEditorStore(context);await s.enableWriting();
  try{
    await s.open({path:'a.pose.json'});await assert.rejects(s.patch(patch(state(s))),/先调用 spine_host_pin/);await s.pin(state(s));
    // 查询观测时间会推进；比较真实文档/事务状态，不把时间戳当成编辑。
    const stableState=async()=>JSON.stringify(await s.state(false));
    const original=await readFile(path.join(root,'a.pose.json')),before=await stableState(),files=await readdir(root,{recursive:true});
    await s.patch({...patch(state(s)),dryRun:true});assert.equal(await stableState(),before);assert.deepEqual(await readdir(root,{recursive:true}),files);
    const old=await s.snapshot(state(s));
    for(let i=0;i<100;i++){await s.patch(patch(state(s),.01+i*.0001));assert.equal(state(s).revision,i+1);}
    for(let i=0;i<20;i++){await s.history('undo',{expectedRevision:state(s),dryRun:false});assert.equal(state(s).revision,101+i);}
    assert.deepEqual(await readFile(path.join(root,'a.pose.json')),original);
    const both=await Promise.allSettled([s.patch(patch(state(s),.03)),s.patch(patch(state(s),.04))]);assert.equal(both.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(s.publishDerived({expectedRevision:old.version,snapshotHash:old.snapshotHash,dependencyFingerprint:old.dependencyFingerprint,result:{}}),/完整版本/);
    await assert.rejects(s.open({path:'a.pose.json',reload:true,expectedRevision:state(s)}),/未提交/);
    await evaluate(s);const image=await s.frame({expectedRevision:state(s)});assert.ok(image.png.length>50);
    const src=JSON.parse(original.toString());src.weapon={x:0,y:.6,angle:0,grips:{left:-.15,right:.15}};
    s.active!.value.weapon=src.weapon;await assert.rejects(s.patch(patch(state(s))),/weapon\/grip/);delete s.active!.value.weapon;
  }finally{await s.shutdown();}
}));

test('精确授权、备份、新修订、响应丢失幂等及重开索引',async()=>withHostFixture(async({root,context})=>{
  let committedArgs:any;const s=new HostEditorStore(context);await s.enableWriting();
  try{
    await s.open({path:'a.pose.json'});await s.pin(state(s));await s.patch(patch(state(s)));await evaluate(s);
    const args={expectedRevision:structuredClone(state(s)),outputPath:'poses/new.pose.json',intent:'draft',dryRun:false,requestId:'commit-one'};
    committedArgs=args;await assert.rejects(s.commit(args),/授权/);
    const candidate=await s.commit({...args,dryRun:true},true);assert.equal(strictHash(candidate.candidateBytes),candidate.candidateHash);
    const auth=await authorize(s,args.outputPath),before=await readFile(path.join(root,'a.pose.json'));
    const receipt=await s.commit({...args,authorizationId:auth.authorizationId});assert.equal(receipt.committed,true);
    assert.equal(strictHash(await readFile(path.join(root,args.outputPath))),candidate.candidateHash);assert.deepEqual(await readFile(path.join(root,receipt.backupPath)),before);assert.deepEqual(await readFile(path.join(root,'a.pose.json')),before);
    const retry=await s.commit(args);assert.equal(retry.replayed,true);assert.deepEqual(retry.version,receipt.version);
    await assert.rejects(s.commit({...args,outputPath:'another.json'}),/requestId/);
    assert.equal(s.pinned,null);assert.equal(s.active!.undo.length,0);
  }finally{await s.shutdown();}
  const reopen=new HostEditorStore(context);await reopen.open({path:'poses/new.pose.json'});assert.equal(reopen.active!.characterId,'hero');assert.equal(reopen.active!.review,null);
  const retryAfterRestart=await reopen.commit(committedArgs);assert.equal(retryAfterRestart.replayed,true);
}));

test('故障：journal 不发布编辑；备份失败不落资产；publish 后故障按哈希裁决',async()=>withHostFixture(async({root,context})=>{
  const s=new HostEditorStore(context);await s.enableWriting();let args:any;
  try{
    await s.open({path:'a.pose.json'});await s.pin(state(s));const initial=structuredClone(state(s));
    s.fault=point=>{if(point==='journal')throw Error('注入 journal 失败');};await assert.rejects(s.patch(patch(state(s))),/journal/);assert.deepEqual(state(s),initial);
    s.fault=undefined;await s.patch(patch(state(s)));await evaluate(s);
    let auth=await authorize(s,'backup-fail.json');s.fault=point=>{if(point==='backup')throw Error('注入备份失败');};
    await assert.rejects(s.commit({expectedRevision:state(s),outputPath:'backup-fail.json',dryRun:false,requestId:'backup-fail',authorizationId:auth.authorizationId}),/备份失败/);await assert.rejects(readFile(path.join(root,'backup-fail.json')));
    s.fault=undefined;auth=await authorize(s,'published.pose.json');args={expectedRevision:structuredClone(state(s)),outputPath:'published.pose.json',dryRun:false,requestId:'published',authorizationId:auth.authorizationId};
    s.fault=point=>{if(point==='afterPublish')throw Error('模拟发布后断电');};await assert.rejects(s.commit(args),/保持冻结/);assert.equal(s.frozen,true);
  }finally{if(s.writer)await releaseWriter(s.writer,context);}
  const recovered=new HostEditorStore(context);await recovered.enableWriting();
  try{await recovered.open({path:'a.pose.json'});const result=await recovered.commit(args);assert.equal(result.replayed,true);await recovered.open({path:'published.pose.json',expectedRevision:state(recovered)});assert.equal(recovered.active!.characterId,'hero');}finally{await recovered.shutdown();}
}));

test('排他写入权覆盖旧 JSON 写入与 saveJson；磁盘变化后不自动接管',async()=>withHostFixture(async({context})=>{
  const s=new HostEditorStore(context);await s.enableWriting();
  try{
    await assert.rejects(setBoneKeyframe('body.json',{animation:'original',bone:'body',timeline:'rotate',time:0,value:1,dryRun:false},context),/写入者或锁/);
    await assert.rejects(saveJson('bypass.pose.json',{kind:'standing',frame:{}},context),/写入者或锁/);
    const other=new HostEditorStore(context);await assert.rejects(other.enableWriting(),/写入者或锁/);
  }finally{await s.shutdown();}
}));
