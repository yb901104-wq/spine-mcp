import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createMotionRuntime,worldVertices} from '../src/motionRuntime.js';
import {solvePerspectiveArm,validatePerspective,assertFormalPerspectiveAbsent} from '../src/perspective.js';
import {applyRenderSnapshot} from '../src/renderSnapshot.js';
import {requireReviewedPoseData,preparePoseReview,poseChecks} from '../src/poseWorkflow.js';
import {withHostFixture} from './helpers/hostFixture.js';
import {startHostServer} from '../src/hostServer.js';
import {HostClient} from '../src/hostClient.js';
import {strictHash} from '../src/hostContracts.js';
import {applyHostPosePatch,assertPoseRecovery} from '../src/hostPosePatch.js';

const atlas='image.png\nsize: 32,32\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\npart\n  rotate: false\n  xy: 0,0\n  size: 32,32\n  orig: 32,32\n  offset: 0,0\n  index: -1\n';
const input:any={mode:'diagnostic',limb:'leftArm',upper:.85,lower:.7,basis:'机械夹具纵向缩短测试，不代表美术校准'};
function fixture(upperTransform='normal'){
  const json={skeleton:{spine:'4.1.24'},bones:[{name:'root',rotation:17,x:5,y:2},{name:'body',parent:'root',y:70,rotation:8},
    {name:'upper',parent:'body',x:5,y:12,rotation:20,transform:upperTransform},{name:'lower',parent:'upper',x:45,y:3,rotation:55},{name:'hand',parent:'lower',x:32,y:2,rotation:-25}],
    slots:[{name:'upperSlot',bone:'upper',attachment:'part'},{name:'lowerSlot',bone:'lower',attachment:'part'}],
    skins:[{name:'default',attachments:{upperSlot:{part:{width:40,height:8,x:20}},lowerSlot:{part:{width:30,height:7,x:15}}}}],animations:{}};
  const mapping:any={bones:{body:'body',leftArm:['upper','lower','hand'],anchors:{leftHand:{bone:'hand',point:[3,2]}}},calibration:{origin:[5,2],scale:100}};
  return {runtime:createMotionRuntime(json,atlas),json,mapping};
}
test('单臂透视：非零 setup、父旋转、非零锚点与两种固定弯曲分支均按实际 runtime 求解',()=>{
  for(const transform of ['normal','noRotationOrReflection'])for(const bend of [1,-1] as const)for(const ratio of [1,.85,.65]){
    const {runtime,mapping}=fixture(transform),sk=runtime.sample(undefined,0),a=sk.findBone('upper')!,b=sk.findBone('lower')!,c=sk.findBone('hand')!;
    a.scaleX*=ratio;b.scaleX*=.8;b.rotation=bend*55;a.rotation=35;sk.updateWorldTransform();
    const target={x:(c.worldX+c.a*3+c.b*2-5)/100,y:(c.worldY+c.c*3+c.d*2-2)/100,angle:Math.atan2(c.c,c.a)*180/Math.PI};
    runtime.sample(undefined,0);
    const result=solvePerspectiveArm(sk,mapping,{...input,upper:ratio,lower:.8},target,bend);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.branchOk,true);assert.ok(result.iterations<=60);
    assert.equal(a.scaleX,ratio);assert.equal(b.scaleX,.8);assert.ok(result.angleError<1e-4);assert.ok(result.error<.01);
  }
});
test('缩放输入负例、不可达与既有约束：不放大、不翻转、不伪造可达',()=>{
  for(const patch of [{upper:0},{upper:-1},{upper:1.1},{lower:NaN},{mode:'approved'},{limb:'leftLeg'},{basis:' '},{front:'front'}])assert.throws(()=>validatePerspective({...input,...patch}));
  const {runtime,mapping}=fixture(),sk=runtime.sample(undefined,0);
  const failed=solvePerspectiveArm(sk,mapping,input,{x:100,y:100,angle:0},1);assert.equal(failed.ok,false);assert.ok(failed.error>1);assert.ok(failed.iterations<=60);
  runtime.sample(undefined,0);(sk as any).ikConstraints=[{bones:[sk.findBone('upper')]}];assert.throws(()=>solvePerspectiveArm(sk,mapping,input,{x:0,y:0},1),/约束/);
});
test('缩放回放：全部骨骼矩阵及切片顶点相同，拒绝不安全倍率',()=>{
  const {runtime,mapping,json}=fixture(),sk=runtime.sample(undefined,0);
  solvePerspectiveArm(sk,mapping,input,{x:.4,y:.9,angle:0},1);
  const bones=Object.fromEntries(sk.bones.map(b=>[b.data.name,{rotate:b.rotation-b.data.rotation,translate:{x:b.x-b.data.x,y:b.y-b.data.y},scale:{x:b.scaleX/b.data.scaleX,y:b.scaleY/b.data.scaleY}}]));
  const rt=createMotionRuntime(json,atlas);applyRenderSnapshot(rt.skeleton,{bones});
  const actual=worldVertices(rt.skeleton),expected=worldVertices(sk);
  assert.deepEqual(Object.keys(actual),Object.keys(expected));
  for(const key of Object.keys(actual))actual[key].forEach((v,i)=>assert.ok(Math.abs(v-expected[key][i])<1e-8));
  for(const b of sk.bones){const q=rt.skeleton.findBone(b.data.name)!;for(const k of ['a','b','c','d','worldX','worldY'] as const)assert.ok(Math.abs(b[k]-q[k])<1e-8);}
  assert.throws(()=>applyRenderSnapshot(rt.skeleton,{bones:{upper:{scale:{x:0,y:1}}}}),/scale/);
});
test('透视诊断即使伪造旧批准也不能成为正式姿态',async()=>{
  assert.throws(()=>assertFormalPerspectiveAbsent({perspective:input}),/诊断/);
  await assert.rejects(requireReviewedPoseData({frame:{perspective:input},status:'confirmed',review:{decision:'approved'}},{}),/诊断/);
});
test('Host C2 透视补丁：实际 live 回放、版本、撤销重做、诊断禁止批准、源输入不变',async()=>withHostFixture(async({root,context})=>{
  const originals=await Promise.all(['body.json','mapping.json','body.atlas','body.png','a.pose.json'].map(async f=>[f,strictHash(await readFile(path.join(root,f)))]));
  const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
  try{
    const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
    const frame=structuredClone(host.store.active!.value.frame);
    const op={op:'setPosePerspective',path:'pose/frame/perspective',value:{...input,upper:.9,lower:.85}};
    assert.throws(()=>applyHostPosePatch(host.store.active!,[op],'c1'),/C1/);
    await client.patch({expectedRevision:opened.version,ops:[op]});assert.deepEqual(host.store.active!.value.frame,frame);
    const edited=await client.patch({expectedRevision:opened.version,ops:[op],dryRun:false});
    const doc=host.store.active!;assert.deepEqual(doc.value.frame.perspective,op.value);assert.equal(doc.derived.diagnosticOnly,true);assert.equal(doc.derived.numeric.readyToCommit,false);
    assert.throws(()=>assertPoseRecovery(doc,doc.value,'c1'),/C1/);
    assert.ok(doc.derived.renderState.maximumError<=1e-4);assert.equal(doc.derived.bones.leftArm1.scale.x,.9);assert.ok(edited.__imageData);
    const live=JSON.parse(await readFile(path.join(root,doc.derived.live.path),'utf8'));assert.equal(live.animations.__host_pose.bones.leftArm1.scale[0].x,.9);
    await assert.rejects(preparePoseReview(doc.value,{decision:'approved',reviewedBy:'test',reason:'test',checks:poseChecks},[],context),/诊断/);
    const undone=await client.history('undo',{expectedRevision:edited.version,dryRun:false});assert.deepEqual(host.store.active!.value.frame,frame);
    const redone=await client.history('redo',{expectedRevision:undone.version,dryRun:false});assert.deepEqual(host.store.active!.value.frame.perspective,op.value);
    const reset=await client.patch({expectedRevision:redone.version,ops:[{...op,value:null}],dryRun:false});assert.equal(host.store.active!.value.frame.perspective,undefined);assert.ok(reset.__imageData);
    const failed=await client.patch({expectedRevision:reset.version,ops:[{...op,value:{...op.value,upper:.1,lower:.1}}],dryRun:false});
    assert.equal(host.store.active!.derived.numeric.ok,false);
    await assert.rejects(client.commit({expectedRevision:failed.version,outputPath:'failed-diagnostic.pose.json'}),/失败透视候选/);
    for(const [f,hash] of originals)assert.equal(strictHash(await readFile(path.join(root,f))),hash);
  }finally{await host.stop();}
},{neutralSetup:true}));
