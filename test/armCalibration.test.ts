import {applyRenderSnapshot} from '../src/renderSnapshot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionRuntime } from '../src/motionRuntime.js';
import { solveCalibratedArm, validatePerspective, isDiagnosticPerspective } from '../src/perspective.js';
import { semanticAt } from '../src/retargetEngine.js';
import { assertCalibrationFrame } from '../src/armCalibration.js';
import { readArmCalibration, armCalibrationChecks } from '../src/armCalibration.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strictHash } from '../src/hostContracts.js';
import { CAPTURE_EVIDENCE_SCHEMA } from '../src/captureEvidence.js';
import {calibrationSweep} from '../src/armCalibrationSweep.js';
import {withHostFixture} from './helpers/hostFixture.js';
import {readFile} from 'node:fs/promises';
import {preparePoseSource,solvePoseData} from '../src/poseWorkflow.js';
import {loadAtlasImages} from '../src/rasterRenderer.js';
const atlas='body.png\nsize: 32,32\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\nbody\n  rotate: false\n  xy: 0,0\n  size: 32,32\n  orig: 32,32\n  offset: 0,0\n  index: -1\n';
test('正式单臂按 runtime 世界投影求解：继承缩放不等于局部倍率，固定分支与末端补偿',()=>{
  for(const bend of [1,-1] as const)for(const transform of ['normal','noRotationOrReflection']){
    const json={skeleton:{spine:'4.1.24'},bones:[{name:'root',rotation:12},{name:'upper',parent:'root',x:5,y:7,length:60,rotation:10,transform},{name:'lower',parent:'upper',x:60,length:50,rotation:45},{name:'hand',parent:'lower',x:50,rotation:4}],slots:[],skins:[{name:'default',attachments:{}}],animations:{}};
    const runtime=createMotionRuntime(json,atlas),sk=runtime.sample(undefined,0),mapping={bones:{leftArm:['upper','lower','hand'],anchors:{leftHand:{bone:'hand',point:[3,2]}}},calibration:{scale:100,origin:[0,0]}};
    const a=sk.findBone('upper')!,b=sk.findBone('lower')!,c=sk.findBone('hand')!,baseline={projection:[60,50],endNorm:[Math.hypot(c.a,c.c),Math.hypot(c.b,c.d)]};
    a.scaleX=.8;b.scaleX=.75;a.rotation=30;b.rotation=bend*60;sk.updateWorldTransform();
    c.scaleX/=Math.hypot(c.a,c.c);c.scaleY/=Math.hypot(c.b,c.d);sk.updateWorldTransform();
    const target={x:(c.worldX+c.a*3+c.b*2)/100,y:(c.worldY+c.c*3+c.d*2)/100,angle:Math.atan2(c.c,c.a)*180/Math.PI};
    const lower=Math.hypot(c.worldX-b.worldX,c.worldY-b.worldY)/50;
    runtime.sample(undefined,0);
    const input={mode:'calibrated' as const,limb:'leftArm' as const,upper:.8,lower,basis:'机械测试',calibrationPath:'arm.json',calibrationHash:'a'.repeat(64)};
    const result=solveCalibratedArm(sk,mapping,input,target,bend,{limb:'leftArm',baseline,ranges:{upper:[.4,1],lower:[.4,1],widthUpper:[1,1],widthLower:[1,1]},localScaleBounds:[[.05,2],[.05,2]]});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.diagnosticOnly,false);assert.ok(result.projectionError<1e-4);assert.ok(result.error<.01);assert.ok(result.iterations<=60);assert.ok(Math.abs(result.localScales[1]-input.lower)>.01,'局部比例不应直接等于世界比例');
    assert.ok(Math.abs(result.endNorm[0]-baseline.endNorm[0])<1e-6);assert.ok(Math.abs(result.endNorm[1]-baseline.endNorm[1])<1e-6);
    const bones=Object.fromEntries(sk.bones.map(b=>[b.data.name,{rotate:b.rotation-b.data.rotation,translate:{x:b.x-b.data.x,y:b.y-b.data.y},scale:{x:b.scaleX/b.data.scaleX,y:b.scaleY/b.data.scaleY}}]));
    const replay=createMotionRuntime(json,atlas);assert.throws(()=>applyRenderSnapshot(replay.skeleton,{bones}),/scale/);
    const scaleLimits=Object.fromEntries(['upper','lower','hand'].map(name=>[name,{x:[Math.max(.0001,bones[name].scale.x-.0001),bones[name].scale.x+.0001],y:[Math.max(.0001,bones[name].scale.y-.0001),bones[name].scale.y+.0001]}]));
    applyRenderSnapshot(replay.skeleton,{bones,scaleLimits}as any);for(const b of sk.bones){const actual=replay.skeleton.findBone(b.data.name)!;for(const key of ['a','b','c','d','worldX','worldY']as const)assert.ok(Math.abs(actual[key]-b[key])<1e-6);}
    assert.throws(()=>applyRenderSnapshot(replay.skeleton,{bones:{...bones,hand:{...bones.hand,scale:{x:100,y:1}}},scaleLimits}as any),/scale/);

    assert.throws(()=>solveCalibratedArm(sk,mapping,{...input,upper:.3},target,bend,{limb:'leftArm',baseline,ranges:{upper:[.4,1],lower:[.4,1],widthUpper:[1,1],widthLower:[1,1]}}),/范围/);
  }
});
test('校准格式、分支和精确诊断样本不可借旧批准越界',()=>{
  const input={mode:'calibrated',limb:'leftArm',upper:.8,lower:.8,basis:'校准',calibrationPath:'arm.json',calibrationHash:'a'.repeat(64)};
  validatePerspective(input);assert.equal(isDiagnosticPerspective({perspective:input}),false);
  for(const patch of [{mode:'diagnostic'},{calibrationHash:'bad'},{widthUpper:0},{upper:1.2}])assert.throws(()=>validatePerspective({...input,...patch}));
  const frame={body:{x:0,y:0,rotate:0},head:0,channels:{},targets:{leftHand:{x:1,y:1,angle:0}},bendDirections:{leftArm:1},perspective:input};
  const record={limb:'leftArm',bendDirection:1,bodyRange:{x:[0,0],y:[0,0],rotate:[0,2]},targetRange:{x:[0,2],y:[0,2],angle:[0,0]},baseline:{frame},samples:[]};
  assertCalibrationFrame(record,frame);
  assert.throws(()=>assertCalibrationFrame(record,{...frame,bendDirections:{leftArm:-1}}),/分支/);
  assert.throws(()=>assertCalibrationFrame(record,{...frame,body:{...frame.body,rotate:3}}),/范围/);
  assert.throws(()=>assertCalibrationFrame(record,{...frame,perspective:{...input,mode:'calibration'}}),/精确样本/);
});
test('正式 motion 透视连续插值绑定同一校准，模式和哈希切换拒绝',()=>{
  const perspective={mode:'calibrated',limb:'leftArm',upper:1,lower:1,basis:'校准',calibrationPath:'arm.json',calibrationHash:'a'.repeat(64)};
  const frame=(time:number)=>({time,body:{x:0,y:0,rotate:0},targets:{},perspective:{...perspective,upper:1-time*.2,lower:1-time*.3}});
  const motion:any={frames:[frame(0),frame(1)]};
  const sampled=semanticAt(motion,.5);assert.ok(Math.abs(sampled.perspective!.upper-.9)<1e-8);assert.ok(Math.abs(sampled.perspective!.lower-.85)<1e-8);
  motion.frames[1].perspective.calibrationHash='b'.repeat(64);assert.throws(()=>semanticAt(motion,.5),/同一/);
});
test('校准依赖和独立批准逐次验证；旧诊断批准、篡改截图及错误哈希不能开放正式范围（机械协议桩）',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'spine-arm-record-')),context={workspaceRoot:root};
  try{
    await writeFile(path.join(root,'source.txt'),'fixed');await writeFile(path.join(root,'sample.png'),'protocol-stub');await writeFile(path.join(root,'sweep.gif'),'sweep-protocol-stub');
    const runtime={bones:[['arm',0,1,1,0,0,1]],vertices:{},attachments:[],drawOrder:[],skin:null};
    const record={format:'spine-arm-projection-calibration',version:1,limb:'leftArm',sourceFingerprint:'source',bendDirection:1,baseline:{projection:[60,50],endNorm:[1,1]},endCompensationBounds:[[.5,4],[.5,4]],dependencies:[{filePath:'source.txt',hash:strictHash('fixed')}],samples:[0,1,2].map(i=>({id:String(i),input:{upper:1-i*.1,lower:1-i*.1},numeric:{ok:true},runtime}))};
    Object.assign(record,{continuity:{numericOk:true,branchStable:true,frameCount:17,frames:Array.from({length:17},()=>({numericOk:true,branchOk:true,runtimeHash:strictHash('mechanical-stub')})),artifacts:[{filePath:'sample.png',hash:strictHash('protocol-stub')},{filePath:'sweep.gif',hash:strictHash('sweep-protocol-stub')}]}});
    const bytes=JSON.stringify(record);await writeFile(path.join(root,'arm.json'),bytes);
    const input:any={mode:'calibrated',limb:'leftArm',upper:.9,lower:.9,basis:'机械协议桩',calibrationPath:'arm.json',calibrationHash:strictHash(bytes)};
    await assert.rejects(readArmCalibration(input,context),{code:'ENOENT'});
    const samples=[];for(const s of record.samples){const name=`capture-${s.id}.json`,manifest={evidenceSchema:CAPTURE_EVIDENCE_SCHEMA,source:'player',captureValidity:{status:'verified'},kind:'pose',actual:runtime,evidence:[{filePath:'sample.png',hash:strictHash('protocol-stub')}]};const raw=JSON.stringify(manifest);await writeFile(path.join(root,name),raw);samples.push({sampleId:s.id,manifestPath:name,manifestHash:strictHash(raw)});}
    const review={format:'spine-arm-projection-review',calibrationHash:input.calibrationHash,decision:'approved',reviewedBy:'机械协议桩',reason:'测试字节绑定，不代表真实 player 或美术验收',checkResults:Object.fromEntries(armCalibrationChecks.map(k=>[k,{status:'pass',reason:`协议检查 ${k}`} ])),samples};
    await writeFile(path.join(root,'arm.json.review.json'),JSON.stringify({...review,format:'old-diagnostic-review'}));await assert.rejects(readArmCalibration(input,context),/独立/);
    await writeFile(path.join(root,'arm.json.review.json'),JSON.stringify(review));assert.equal((await readArmCalibration(input,context,'source')).limb,'leftArm');
    await assert.rejects(readArmCalibration({...input,calibrationHash:'b'.repeat(64)},context),{code:'TARGET_STALE'});
    await writeFile(path.join(root,'sample.png'),'changed');await assert.rejects(readArmCalibration(input,context),{code:'REVIEW_STALE'});
    await writeFile(path.join(root,'source.txt'),'drift');await assert.rejects(readArmCalibration(input,context),{code:'TARGET_STALE'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('批准前连续扫掠生成诊断 GIF/联系图，固定分支逐帧回读且不泄漏临时样本（机械夹具）',async()=>withHostFixture(async({root,context})=>{
  const pose=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8')),{source,visualReader}=await preparePoseSource(pose,context),solved=await solvePoseData(pose,context),mapping=source.mapping,chain=mapping.bones.leftArm!.map(n=>solved.skeleton.findBone(n)!),[a,b,c]=chain;
  const origin=mapping.calibration!.origin!,unit=mapping.calibration!.scale,hand=pose.frame.targets.leftHand,shoulder=[(a.worldX-origin[0])/unit,(a.worldY-origin[1])/unit],samples=[1,.9,.8].map((r,i)=>({id:String(i),upper:r,lower:r,target:{x:shoulder[0]+(hand.x-shoulder[0])*r,y:shoulder[1]+(hand.y-shoulder[1])*r,angle:hand.angle}}));
  const range=(v:number[])=>[Math.min(...v),Math.max(...v)],record:any={limb:'leftArm',bendDirection:1,basis:'机械连续性测试',baseline:{frame:pose.frame,projection:[Math.hypot(b.worldX-a.worldX,b.worldY-a.worldY),Math.hypot(c.worldX-b.worldX,c.worldY-b.worldY)],endNorm:[Math.hypot(c.a,c.c),Math.hypot(c.b,c.d)]},localScaleBounds:[[.05,2],[.05,2]],endCompensationBounds:[[.1,10],[.1,10]],ranges:{upper:[.8,1],lower:[.8,1],widthUpper:[1,1],widthLower:[1,1]},bodyRange:Object.fromEntries(['x','y','rotate'].map(k=>[k,[pose.frame.body[k],pose.frame.body[k]]])),targetRange:Object.fromEntries(['x','y','angle'].map(k=>[k,range(samples.map(s=>(s.target as any)[k]))])),samples:samples.map(s=>({renderBounds:solved.report.bounds,input:{upper:s.upper,lower:s.lower,widthUpper:1,widthLower:1,basis:''},frame:{body:pose.frame.body,targets:{leftHand:s.target}}}))};
  const before=JSON.stringify(pose),result=await calibrationSweep(pose,source,visualReader,record,samples,await loadAtlasImages(source.rt.atlas,mapping.atlasPath!,context),17,1);
  assert.equal(result.report.frameCount,17);assert.equal(result.report.numericOk,true,JSON.stringify(result.report));assert.equal(result.report.branchStable,true);assert.equal(result.report.formalMotion,false);assert.equal(record.samples.length,3);assert.equal(JSON.stringify(pose),before);assert.ok(result.gif.subarray(0,3).equals(Buffer.from('GIF')));assert.ok(result.sheet.subarray(1,4).equals(Buffer.from('PNG')));assert.equal(result.report.encodedDurationMs,1000);
},{neutralSetup:true}));
