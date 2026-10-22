import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,rename} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {comparisonPolicy,compareGraphs,graphEdges,torsoFrame,torsoCoordinate} from '../src/poseGraph.js';
import {calibrateVisualRig,reviewVisualRig,requireVisualRig,readVisualNodes,attachmentSnapshot,visualRigFingerprint} from '../src/visualRig.js';
import {createMappingDraft,calibrateMapping,confirmMapping,saveJson} from '../src/mappingTools.js';
import {createPoseDraft,solvePose,renderPoseComparison,reviewPose,poseChecks,requireReviewedPose,adjustPose} from '../src/poseWorkflow.js';
import {createReferencePose,renderReferencePoseSheet,reviewReferencePose,referenceChecks} from '../src/referencePose.js';
import {comparePoseGraphs,retargetReferencePose,compareAnimationKeyPoses,prepareReferenceRetargetInputs} from '../src/referenceRetarget.js';
import {retargetReferencePoseKernel} from '../src/referenceRetargetKernel.js';
import {requireReferencePose,referenceFingerprint} from '../src/referencePose.js';
import {validatePoseSequence} from '../src/poseSequence.js';
import {refineReferencePose} from '../src/referencePoseRefinement.js';
import { withV2 } from './helpers/referenceV2.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { HostCapture } from '../src/hostCapture.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
import { prepareHostPoseReview } from '../src/hostPoseReview.js';
import { materializeHostPose } from '../src/hostPose.js';
import { installSimulatedHostPage } from './helpers/hostPage.js';
const correspondence={left:'left',right:'right',basis:'测试已知左右链',anatomicalIdentity:'同侧',projectedOrder:'左前右后'};
async function fixture(factor=1,prefix='a',soleHeight=0){
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-visual-')),c={workspaceRoot:root},n=(s:string)=>prefix+s;
 const bones:any[]=[{name:n('root')},{name:n('body'),parent:n('root'),y:80*factor},{name:n('head'),parent:n('body'),y:25*factor}],slots:any[]=[],attachments:any={},mapping:any={version:2,character:prefix,skin:'default',atlasPath:'test.atlas',bones:{root:n('root'),body:n('body'),head:n('head'),anchors:{},bendDirections:{}}};
 if(prefix==='b'){bones.splice(1,0,{name:n('pivot'),parent:n('root')});bones.find(b=>b.name===n('body')).parent=n('pivot');}
 for(const side of ['left','right'])for(const part of ['Arm','Leg']){const role=side+part,chain=[1,2,3].map(i=>n(role+i)),length=(part==='Leg'?40:60)*factor;mapping.bones[role]=chain;mapping.bones.bendDirections[role]=1;
  bones.push({name:chain[0],parent:n('body'),x:(side==='left'?-12:12)*factor,y:(part==='Leg'?-5:25)*factor,rotation:-90},{name:chain[1],parent:chain[0],x:length*(prefix==='b'?.9:1)},{name:chain[2],parent:chain[1],x:length*(prefix==='b'?1.1:1)});
  mapping.bones.anchors[side+(part==='Arm'?'Hand':'Foot')]={bone:chain[2],point:[0,0],gripPoint:[3*factor,0],...part==='Leg'&&soleHeight?{solePoints:[[soleHeight,0]]}:{}};
  for(let i=0;i<2;i++){const slot=chain[i]+'slice';slots.push({name:slot,bone:chain[i],attachment:'slice'});attachments[slot]={slice:{type:'region',path:'pixel',width:10,height:10,x:8*factor}};}
 }
 // 加权网格跨两根骨骼；用于三角形重心实际回读和一个线段多附件。
 const weightBone=bones.findIndex(b=>b.name===mapping.bones.leftArm[0]),other=bones.findIndex(b=>b.name===mapping.bones.leftArm[1]);slots.push({name:'weighted',bone:mapping.bones.leftArm[0],attachment:'mesh'});
 attachments.weighted={mesh:{type:'mesh',path:'pixel',uvs:[0,0,1,0,0,1],triangles:[0,1,2],vertices:[2,weightBone,0,0,.5,other,0,0,.5,1,weightBone,10,0,1,1,other,0,10,1],hull:3}};
 // 躯干上下两片：轮廓宽度与前后层序指标需要真实躯干切片与视角配置。
 for(const [tag,dy]of [['torsoLow',-5],['torsoHigh',25]] as const){slots.push({name:n(tag),bone:n('body'),attachment:'slice'});attachments[n(tag)]={slice:{type:'region',path:'pixel',width:14*factor,height:6*factor,x:0,y:dy*factor}};}
 const viewProfiles=[{bodyView:'frontThreeQuarter',basis:'合成夹具：正面斜视躯干切片',attachments:{[n('torsoLow')]:'slice',[n('torsoHigh')]:'slice'},bodySlots:[n('torsoLow'),n('torsoHigh')]}];
 await writeFile(path.join(root,'test.atlas'),'page.png\nsize: 8,8\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\npixel\n  rotate: false\n  xy: 0,0\n  size: 8,8\n  orig: 8,8\n  offset: 0,0\n  index: -1\n');const cv=createCanvas(8,8);cv.getContext('2d').fillRect(0,0,8,8);await writeFile(path.join(root,'page.png'),cv.toBuffer('image/png'));
 const json={skeleton:{spine:'4.1.24'},bones,slots,skins:[{name:'default',attachments}],animations:{original:{}}};await saveJson('character.json',json,c);await createMappingDraft({filePath:'character.json',mappingPath:'mapping.json',mapping,dryRun:false},c);await calibrateMapping({filePath:'character.json',mappingPath:'mapping.json',dryRun:false},c);await confirmMapping({filePath:'character.json',mappingPath:'mapping.json',confirmedBy:'test',semanticChecks:['body','head','sides','chains','anchors','bendDirections','setupPose','followBones'],dryRun:false},c);
 const candidate=await calibrateVisualRig({filePath:'character.json',mappingPath:'mapping.json',visualRigPath:'candidate.json'},c),rig=(candidate as any).rig;
 for(const node of Object.values(rig.nodes) as any[])Object.assign(node,{calibrated:true,basis:'测试构造的显式视觉关节，已知切片边界'});
 // 非零偏移：不得回退为骨骼原点。
 rig.nodes.head.point=[8*factor,3*factor];rig.nodes.leftWrist.point=[0,2*factor];
 const calibration=await calibrateVisualRig({filePath:'character.json',mappingPath:'mapping.json',visualRigPath:'rig.json',nodes:rig.nodes,segments:rig.segments,viewProfiles,outputDir:'calibration',dryRun:false},c);assert.equal(calibration.ok,true);
 await reviewVisualRig({visualRigPath:'rig.json',decision:'approved',reviewedBy:'test-stub',reason:'已知合成夹具；不是美术审查',dryRun:false},c);
 const frame={time:0,body:{x:0,y:.05+soleHeight/(80*factor),rotate:0},head:0,targets:{leftFoot:{x:-.15,y:0,angle:-90,contact:true},rightFoot:{x:.15,y:0,angle:-90,contact:true},leftHand:{x:-.15,y:.6+soleHeight/(80*factor),angle:-90},rightHand:{x:.15,y:.6+soleHeight/(80*factor),angle:-90}},channels:{}};
 await createPoseDraft({filePath:'character.json',mappingPath:'mapping.json',posePath:'standing.json',kind:'standing',frame,dryRun:false},c);await solvePose({posePath:'standing.json',dryRun:false},c);const sheet=await renderPoseComparison({posePaths:['standing.json']},c);await reviewPose({posePath:'standing.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'test-stub',reason:'测试门禁',checks:poseChecks,dryRun:false},c);
 return {root,c,rig,frame,factor,prefix};
}
test('版本化默认比较策略与文件一致',async()=>{assert.deepEqual(JSON.parse(await readFile('policies/pose-comparison.v3.json','utf8')),comparisonPolicy);});
test('刚性、多附件、加权三角锚点使用实际 runtime 顶点；原点候选不能确认',async()=>{
 const f=await fixture();try{
  const v=await requireVisualRig('rig.json',f.c),sk=v.rt.sample(undefined,0,'default'),actual=readVisualNodes(sk,v.rig),head=sk.findBone(v.mapping.bones.head!)!;assert.ok(Math.hypot(actual.points.head.x-head.worldX,actual.points.head.y-head.worldY)>1);
  assert.equal(v.rig.segments['leftArm.0'].attachments.length,2);const mesh=actual.attachments.find((a:any)=>a.slot==='weighted');assert.equal(mesh.weighted,true);assert.equal(new Set(mesh.influences.map((i:any)=>i.bone)).size,2);
  const meshRig={nodes:{head:{type:'meshTriangle',slot:'weighted',attachment:'mesh',triangle:0,weights:[.2,.3,.5]}}};const p=readVisualNodes(sk,meshRig).points.head;assert.ok(Math.abs(p.x-(mesh.vertices[0]*.2+mesh.vertices[2]*.3+mesh.vertices[4]*.5))<1e-6);
  const b=sk.findBone(v.mapping.bones.leftArm![1])!;b.rotation+=30;sk.updateWorldTransform();assert.notEqual(readVisualNodes(sk,meshRig).points.head.x,p.x);
  await calibrateVisualRig({filePath:'character.json',mappingPath:'mapping.json',visualRigPath:'candidate.json',dryRun:false},f.c);await assert.rejects(()=>reviewVisualRig({visualRigPath:'candidate.json',decision:'approved',reviewedBy:'test',reason:'不能批准候选',dryRun:false},f.c),/未校准/);
  const json=JSON.parse(await readFile(path.join(f.root,'character.json'),'utf8'));json.animations.other={};await saveJson('character.json',json,f.c);await requireVisualRig('rig.json',f.c);await writeFile(path.join(f.root,'page.png'),'changed');await assert.rejects(()=>requireVisualRig('rig.json',f.c),/失效/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('窄站和错误手位独立失败；未知必要节点不可验证，不被其他低误差抵消',()=>{
 const points:any={head:{x:0,y:130},face:{x:5,y:130},body:{x:0,y:70},leftHip:{x:-10,y:60},leftKnee:{x:-25,y:30},leftAnkle:{x:-40,y:0},rightHip:{x:10,y:60},rightKnee:{x:25,y:30},rightAnkle:{x:40,y:0},leftShoulder:{x:-10,y:100},leftElbow:{x:15,y:90},leftWrist:{x:35,y:100},rightShoulder:{x:10,y:100},rightElbow:{x:30,y:80},rightWrist:{x:45,y:100}};
 const silhouette={version:1,basis:'已知合成轮廓：与目标躯干切片同宽',shoulder:{left:{x:-20,y:-100,visibility:'visible',confidence:.9,basis:'合成'},right:{x:20,y:-100,visibility:'visible',confidence:.9,basis:'合成'}},hip:{left:{x:-20,y:-60,visibility:'visible',confidence:.9,basis:'合成'},right:{x:20,y:-60,visibility:'visible',confidence:.9,basis:'合成'}}};
 const reference={points:Object.fromEntries(Object.entries(points).map(([k,p]:any)=>[k,{...p,y:-p.y,visibility:'visible',confidence:.9}])),facing:'right',support:{left:true,right:true},relations:{frontGrip:true},
  silhouette,orientation:{version:1,band:'threeQuarter',amplitude:.5,basis:'合成相对幅度'},depth:{version:1,basis:'合成遮挡',evidence:[{id:'armsLR',a:'leftArm',b:'rightArm',relation:'back',kind:'occlusion',basis:'右臂后绘制'}]}};
 // 目标侧的躯干轮廓与层序必须来自实际切片/绘制顺序，不能由参考复制。
 const extras={attachments:[{slot:'torso',vertices:[-20,55,20,55,20,100,-20,100]}],actionState:{drawOrder:['L0','L1','R0','R1','torso'],attachments:{L0:'s',L1:'s',R0:'s',R1:'s',torso:'s'},torsoSlots:['torso'],headSlot:null},segments:{'leftArm.0':{attachments:[{slot:'L0'}]},'leftArm.1':{attachments:[{slot:'L1'}]},'rightArm.0':{attachments:[{slot:'R0'}]},'rightArm.1':{attachments:[{slot:'R1'}]}}};
 const target:any={points:structuredClone(points),facing:'right',support:{left:true,right:true},...structuredClone(extras)};const good=compareGraphs(reference,target,correspondence);assert.equal(good.ok,true,JSON.stringify(good.metrics.filter((m:any)=>m.status!=='pass')));
 target.points.leftAnkle.x=-5;target.points.rightAnkle.x=5;target.points.leftWrist={x:-10,y:40};target.points.rightWrist={x:10,y:40};const bad=compareGraphs(reference,target,correspondence);assert.equal(bad.ok,false);assert.equal(bad.metrics.find(m=>m.id==='stance.width').status,'fail');assert.equal(bad.metrics.find(m=>m.id==='leftArm.wrist').status,'fail');
 // 手被收进躯干轮廓：外伸/偏置指标必须独立失败，不能被其他低误差抵消。
 assert.equal(bad.metrics.find(m=>m.id==='arm.left.wristOutsideTorso').status,'fail');
 reference.points.leftElbow={visibility:'unknown'};assert.equal(compareGraphs(reference,target,correspondence).metrics.find(m=>m.id==='leftArm.flexion').status,'unverifiable');assert.throws(()=>compareGraphs(reference,target,{...correspondence,left:'right'}),/左右对应/);
});
test('不同长度角色实际视觉节点比较、逐项门禁和修改后失效',async()=>{
 let commonPoints:any=null;
 for(const [factor,prefix,soleHeight]of [[1,'a',0],[.73,'b',0],[1,'sole',12]] as const){const f=await fixture(factor,prefix,soleHeight);try{
  const created=await createPoseDraft({filePath:'character.json',mappingPath:'mapping.json',posePath:'action.json',kind:'action',standardPosePath:'standing.json',visualRigPath:'rig.json',correspondence,dryRun:false},f.c);const solved=await solvePose({posePath:'action.json',dryRun:false},f.c);
  const cv=createCanvas(400,400);await writeFile(path.join(f.root,'ref.png'),cv.toBuffer('image/png'));const points=Object.fromEntries(Object.entries(solved.report.visualNodes).map(([k,p]:any)=>[k,{x:200+p.x/factor,y:200-p.y/factor,visibility:'visible',confidence:1,basis:'已知合成姿态投影'}]));
  // 参考图按目标自身投影生成：轮廓与前后层序必须来自真实躯干切片，不能手填。
  const full=(solved as any).report.visual,img=(p:any)=>({x:200+p.x/factor,y:200-p.y/factor,visibility:'visible',confidence:1,basis:'已知合成姿态投影'});
  const silPoint=(p:any)=>p?img(p):{visibility:'unknown'};
  const tf0=torsoFrame(full.points)!;
  const bandPts=(lo:number,hi:number)=>{let min:any=null,max:any=null;for(const a of full.attachments as any[]){if(!a.slot.startsWith(f.prefix+'torso'))continue;for(let i=0;i<a.vertices.length;i+=2){const q={x:a.vertices[i],y:a.vertices[i+1]},cc=torsoCoordinate(tf0,q);if(cc.a<lo||cc.a>hi)continue;if(!min||cc.n<min.n)min={...q,n:cc.n};if(!max||cc.n>max.n)max={...q,n:cc.n};}}return [min,max];};
  const [shA,shB]=bandPts(.85,1.15),[hpA,hpB]=bandPts(-.15,.15);
  const silhouette={version:1,basis:'合成夹具：参考图即目标切片投影',shoulder:{left:silPoint(shA),right:silPoint(shB)},hip:{left:silPoint(hpA),right:silPoint(hpB)}};
  const depth={version:1,basis:'合成夹具按实际 drawOrder 声明',evidence:[{id:'leftArmTorso',a:'leftArm',b:'torso',relation:'back',kind:'occlusion',basis:'躯干切片在双臂之后绘制'}]};
  const observation=withV2({imagePath:'ref.png',time:0,facing:'right',crop:[0,0,400,400],height:150,groundY:200,basis:'合成测试不代表实际参考',points,support:{left:true,right:true}},{silhouette,depth});
  commonPoints??=structuredClone(observation.points);observation.points=structuredClone(commonPoints);Object.assign(observation,{anatomicalIdentity:{status:'confirmed',basis:'已知合成夹具的固定左右解剖身份'}});
  await createReferencePose({referencePosePath:'reference.json',observation,dryRun:false},f.c);const rs=await renderReferencePoseSheet({referencePosePaths:['reference.json'],outputDir:'ref-sheet'},f.c);await reviewReferencePose({referencePosePath:'reference.json',manifestPath:rs.manifestPath,decision:'approved',reviewedBy:'test',reason:'已知投影测试',checks:referenceChecks,dryRun:false},f.c);
  const ref=await requireReferencePose('reference.json',f.c),vr=await requireVisualRig('rig.json',f.c);
  await saveJson('sequence.json',{version:1,id:'test-sequence',basis:'合成角色通用适配',confirmedBy:'test-stub',confirmedAt:new Date().toISOString(),correspondence,weaponHand:null,visualRigPath:'rig.json',visualRigFingerprint:visualRigFingerprint(vr.rig),stages:[{stageId:'ready',referencePosePath:'reference.json',referenceFingerprint:referenceFingerprint(ref)}]},f.c);
  const pose=solved.pose;Object.assign(pose,{sequencePath:'sequence.json',stageId:'ready'});pose.referencePosePath='reference.json';pose.reference=ref.observation;await saveJson('action.json',pose,f.c);
  const cmp=await comparePoseGraphs({posePath:'action.json',dryRun:false},f.c);assert.equal(cmp.ok,true,JSON.stringify(cmp.metrics));pose.comparisonPath=cmp.reportPath;await saveJson('action.json',pose,f.c);const sheet=await renderPoseComparison({posePaths:['action.json']},f.c);
  await retargetReferencePose({referencePosePath:'reference.json',visualRigPath:'rig.json',standardPosePath:'standing.json',posePath:'retarget.json',correspondence,sequencePath:'sequence.json',stageId:'ready',dryRun:false},f.c);
  const refinement=await refineReferencePose({posePath:'retarget.json',outputPosePath:'refined.json',dryRun:false},f.c);assert.equal(refinement.ok,true,JSON.stringify(refinement.issues));
  const mixed=structuredClone(pose);mixed.correspondence={...correspondence,left:'right',right:'left'};await saveJson('mixed.json',mixed,f.c);assert.equal((await validatePoseSequence({sequencePath:'sequence.json',posePaths:['mixed.json']},f.c)).ok,false);
  await assert.rejects(()=>refineReferencePose({posePath:'mixed.json',outputPosePath:'not-written.json'},f.c),/身份/);
  const stale=structuredClone(pose);stale.frame.body.y+=.02;await saveJson('stale.json',stale,f.c);await assert.rejects(()=>refineReferencePose({posePath:'stale.json',outputPosePath:'not-written.json'},f.c),/最新/);
  if(prefix==='a'){
   const unknown=structuredClone(observation);unknown.points.leftElbow={visibility:'unknown'};
   await createReferencePose({referencePosePath:'unknown.reference.json',observation:unknown,dryRun:false},f.c);const us=await renderReferencePoseSheet({referencePosePaths:['unknown.reference.json'],outputDir:'unknown-sheet'},f.c);await reviewReferencePose({referencePosePath:'unknown.reference.json',manifestPath:us.manifestPath,decision:'approved',reviewedBy:'test-stub',reason:'故意保留未知点以检查必要节点门禁；不是视觉批准',checks:referenceChecks,dryRun:false},f.c);
   const record=JSON.parse(await readFile(path.join(f.root,'sequence.json'),'utf8'));record.stages[0]={stageId:'ready',referencePosePath:'unknown.reference.json',referenceFingerprint:referenceFingerprint(await requireReferencePose('unknown.reference.json',f.c))};await saveJson('unknown.sequence.json',record,f.c);
   assert.ok((await validatePoseSequence({sequencePath:'unknown.sequence.json'},f.c)).issues.some(i=>i.category==='inputMissing'));
   const back=structuredClone(observation);Object.assign(back,{actionSemantics:{version:1,weaponHand:'right',identityStatus:'confirmed',bodyView:'backThreeQuarter',anatomicalBasis:'合成已知身份',bodyViewBasis:'能力负例',occlusion:[{front:'rightArm.1',back:'body',basis:'合成遮挡'}]}});
   await createReferencePose({referencePosePath:'back.reference.json',observation:back,dryRun:false},f.c);const bs=await renderReferencePoseSheet({referencePosePaths:['back.reference.json'],outputDir:'back-sheet'},f.c);await reviewReferencePose({referencePosePath:'back.reference.json',manifestPath:bs.manifestPath,decision:'approved',reviewedBy:'test-stub',reason:'已知合成能力负例，不代表目标支持背面',checks:referenceChecks,dryRun:false},f.c);
   record.stages[0]={stageId:'ready',referencePosePath:'back.reference.json',referenceFingerprint:referenceFingerprint(await requireReferencePose('back.reference.json',f.c))};await saveJson('back.sequence.json',record,f.c);assert.ok((await validatePoseSequence({sequencePath:'back.sequence.json'},f.c)).issues.some(i=>i.category==='resourceCapability'));
   await assert.rejects(()=>refineReferencePose({posePath:'refined.json',outputPosePath:'refined.json',dryRun:false},f.c),/新修订/);
   const snapshot=await readFile(path.join(f.root,'character.json'));const dryRetarget=await retargetReferencePose({referencePosePath:'reference.json',visualRigPath:'rig.json',standardPosePath:'standing.json',posePath:'dry-retarget.json',correspondence,sequencePath:'sequence.json',stageId:'ready'},f.c);assert.equal(dryRetarget.dryRun,true);assert.equal(dryRetarget.ok,true);await assert.rejects(()=>readFile(path.join(f.root,'dry-retarget.json')),/ENOENT/);await refineReferencePose({posePath:'retarget.json',outputPosePath:'dry-only.json'},f.c);await assert.rejects(()=>readFile(path.join(f.root,'dry-only.json')),/ENOENT/);assert.deepEqual(await readFile(path.join(f.root,'character.json')),snapshot);
  }
  await assert.rejects(()=>reviewPose({posePath:'action.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'test',reason:'统一文本',checks:poseChecks,dryRun:false},f.c),/逐阶段/);
  await reviewPose({posePath:'action.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'test',reason:'每项检查合成投影与实际节点',stageId:'ready',checkResults:Object.fromEntries(poseChecks.map(k=>[k,{status:'pass',reason:k+' 已知合成夹具的独立检查'}])),checks:poseChecks,dryRun:false},f.c);await requireReviewedPose('action.json',f.c);
  if(prefix==='a'){
    const kernelArgs={referencePosePath:'reference.json',visualRigPath:'rig.json',standardPosePath:'standing.json',posePath:'pure-reference.json',correspondence,sequencePath:'sequence.json',stageId:'ready',id:'pure-reference-test'};
    const prepared=await prepareReferenceRetargetInputs(kernelArgs,f.c),first=retargetReferencePoseKernel(kernelArgs,prepared);
    await rename(path.join(f.root,'character.json'),path.join(f.root,'character.hold'));
    try{const second=retargetReferencePoseKernel(kernelArgs,prepared);assert.deepEqual(second.solved.bones,first.solved.bones);assert.deepEqual(second.comparison,first.comparison);}finally{await rename(path.join(f.root,'character.hold'),path.join(f.root,'character.json'));}
    // 真参考/visualRig/sequence 门禁 + 模拟页面协议；不是美术视觉验收。
    const store=new HostEditorStore(f.c,'mirror');await store.open({path:'action.json'});
    const input=await store.snapshot(store.active!.version),derived=await evaluateHostSnapshot(input,f.c);
    assert.equal(derived.comparison.ok,true);await store.publishDerived({expectedRevision:input.version,snapshotHash:input.snapshotHash,dependencyFingerprint:input.dependencyFingerprint,result:derived});
    const capture=new HostCapture(store,2000);installSimulatedHostPage(capture,store);
    try{
      const screenshot=await capture.request({expectedRevision:input.version,size:320}),snapshot=await store.snapshot(input.version);
      const args={posePath:'action.json',manifestPath:screenshot.manifestPath,expectedRevision:input.version,decision:'approved',reviewedBy:'参考协议桩（不是美术验收）',reason:'验证当前内存参考关系与新修订指纹',stageId:'ready',checks:poseChecks,checkResults:Object.fromEntries(poseChecks.map(k=>[k,{status:'pass',reason:k+' 合成夹具独立断言'}])),dryRun:false};
      await assert.rejects(prepareHostPoseReview(snapshot,{...args,stageId:'other'},f.c),/stageId/);
      await assert.rejects(prepareHostPoseReview(snapshot,{...args,comparisonPath:cmp.reportPath},f.c),/当前派生版本/);
      const prepared=await prepareHostPoseReview(snapshot,args,f.c);await store.registerReview(prepared);
      const candidate=materializeHostPose(snapshot.document,snapshot.derived);candidate.status='confirmed';candidate.review=prepared.reviewRecord.record;candidate.comparisonPath=candidate.review.comparisonPath;
      await saveJson('host-reviewed.json',candidate,f.c);
      await rename(path.join(f.root,'action.json'),path.join(f.root,'action.hold'));
      try{assert.equal((await requireReviewedPose('host-reviewed.json',f.c)).status,'confirmed');}finally{await rename(path.join(f.root,'action.hold'),path.join(f.root,'action.json'));}
      const referenceBytes=await readFile(path.join(f.root,'reference.json'));
      try{await writeFile(path.join(f.root,'reference.json'),Buffer.concat([referenceBytes,Buffer.from(' ')]));await assert.rejects(store.registerReview(prepared),/磁盘|依赖/);}finally{await writeFile(path.join(f.root,'reference.json'),referenceBytes);}
    }finally{capture.close();}
  }
  await adjustPose({posePath:'action.json',outputPosePath:'changed.json',patch:{frame:{targets:{leftHand:{x:.4}}}},dryRun:false},f.c);await assert.rejects(()=>requireReviewedPose('changed.json',f.c),/比较报告/);
  const json=JSON.parse(await readFile(path.join(f.root,'character.json'),'utf8'));json.animations.bad={bones:{[f.rig.nodes.leftWrist.bone]:{rotate:[{time:0,value:0}],translate:[{time:0,x:60,y:0}]}}};await saveJson('candidate-animation.json',json,f.c);const keys=await compareAnimationKeyPoses('candidate-animation.json','bad',{duration:1,poseWorkflow:{keyPoses:[{posePath:'action.json',stageId:'ready',time:0}]}},1,f.c);assert.equal(keys.ok,false);
 }finally{await rm(f.root,{recursive:true,force:true});}}
});
test('真实 npc1 旧准备帧：低 IK 误差不抵消窄站、手位失败，Agent 不能覆盖',async t=>{
 const workspaceRoot='D:/AI_cc/spine test',base='previews/visual-rig-20261009',c={workspaceRoot},posePath=base+'/old-ready.pose.json';
 try{await readFile(path.join(workspaceRoot,posePath));}catch{t.skip('未提供本地 npc1 负例素材');return;}
 const before=await readFile(path.join(workspaceRoot,'目标/npc1.json'));
 const p=JSON.parse(await readFile(path.join(workspaceRoot,posePath),'utf8'));assert.equal(p.solution.ok,true);assert.ok(Math.max(...Object.values(p.solution.errors) as number[])<.0001);
 const cmp=await comparePoseGraphs({posePath},c).catch((e:any)=>{
   // v3 不再静默按新策略比较 v1 参考：必须显式升级并重标注。
   assert.match(String(e?.message),/需升级为 v2/);
   t.diagnostic('npc1 旧参考仍是 v1：v3 要求先升级并重标注，比较被明确拒绝。');
   return null;
 });
 if(cmp){assert.equal(cmp.ok,false);assert.equal(cmp.metrics.find(m=>m.id==='stance.width').status,'fail');assert.equal(cmp.metrics.find(m=>m.id==='leftArm.wrist').status,'fail');}
 await assert.rejects(()=>reviewPose({posePath,manifestPath:base+'/ready-comparison-v2/pose-comparison.json',comparisonPath:base+'/old-ready.pose.comparison.json',decision:'approved',reviewedBy:'test-fake-agent',reason:'模拟错误批准',stageId:'ready',checks:poseChecks,checkResults:Object.fromEntries(poseChecks.map(k=>[k,{status:'pass',reason:k+' 模拟错误判断'}])),dryRun:false},c),/比较失败|动作级身份|需要 v2/);
 assert.deepEqual(await readFile(path.join(workspaceRoot,'目标/npc1.json')),before);
});
