import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {createMappingDraft,calibrateMapping,confirmMapping} from '../src/mappingTools.js';
import {createPoseDraft,solvePose,adjustPose,renderPoseComparison,reviewPose,buildMotionFromPoses,poseChecks,requireReviewedPose,poseGate,animationChecks} from '../src/poseWorkflow.js';
import {retargetMotion,batchRetarget} from '../src/motionEngine.js';
import {reviewAnimation,renderAnimationComparison} from '../src/animationReview.js';
import {renderAnimationFrames} from '../src/previewRenderTools.js';
import {analyzeReferenceGif} from '../src/referenceTools.js';
import {readSpineDocument} from '../src/spineJson.js';
import {createReferencePose,renderReferencePoseSheet,reviewReferencePose,referenceRoles,referenceChecks} from '../src/referencePose.js';
import { withV2 } from './helpers/referenceV2.js';
import {fitCubicBezierTimeline} from '../src/motionMath.js';

async function fixture(prefix='a',factor=1,root?:string){const workspaceRoot=root??await mkdtemp(path.join(os.tmpdir(),'spine-pose-')),c={workspaceRoot},n=(v:string)=>prefix+'_'+v;
 const bones:any[]=[{name:n('root')},{name:n('body'),parent:n('root'),y:80*factor},{name:n('head'),parent:n('body'),y:25*factor}],m:any={character:prefix,version:2,atlasPath:'empty.atlas',bones:{root:n('root'),body:n('body'),head:n('head'),anchors:{},bendDirections:{},follow:[]}};
 if(prefix==='b'){bones.splice(1,0,{name:n('pivot'),parent:n('root')});bones.find(b=>b.name===n('body')).parent=n('pivot');}
 for(const side of ['left','right'])for(const part of ['Leg','Arm']){const role=side+part,chain=[n(role+'1'),n(role+'2'),n(role+'3')],length=(part==='Leg'?40:60)*factor;bones.push({name:chain[0],parent:n('body'),x:(side==='left'?-12:12)*factor,y:(part==='Leg'?-5:25)*factor,rotation:-90,length},{name:chain[1],parent:chain[0],x:length,length},{name:chain[2],parent:chain[1],x:length});m.bones[role]=chain;m.bones.bendDirections[role]=1;m.bones.anchors[side+(part==='Leg'?'Foot':'Hand')]={bone:chain[2],point:[0,0],gripPoint:[3*factor,0]};}
 const filePath=prefix+'.json',mappingPath=prefix+'.mapping.json';await writeFile(path.join(workspaceRoot,filePath),JSON.stringify({skeleton:{spine:'4.1.24'},bones,slots:[],skins:[],animations:{original:{}}}));await writeFile(path.join(workspaceRoot,'empty.atlas'),'');await createMappingDraft({filePath,mappingPath,mapping:m,dryRun:false},c);await calibrateMapping({filePath,mappingPath,dryRun:false},c);await confirmMapping({filePath,mappingPath,confirmedBy:'test',semanticChecks:['body','head','sides','chains','anchors','bendDirections','setupPose','followBones'],dryRun:false},c);
 const frame={time:0,body:{x:0,y:.05,rotate:0},head:0,channels:{},targets:{leftFoot:{x:-.15,y:0,angle:-90,contact:true},rightFoot:{x:.15,y:0,angle:-90,contact:true},leftHand:{x:-.15,y:.6,angle:-90},rightHand:{x:.15,y:.6,angle:-90}}};return {c,filePath,mappingPath,frame,prefix};}
async function confirmedStanding(f:any){const posePath=f.prefix+'.standing.json';await createPoseDraft({...f,posePath,id:'standing',kind:'standing',frame:f.frame,dryRun:false},f.c);assert.equal((await solvePose({posePath,dryRun:false},f.c)).ok,true);const rendered=await renderPoseComparison({posePaths:[posePath]},f.c);await reviewPose({posePath,manifestPath:rendered.manifestPath,decision:'approved',reviewedBy:'test-visual-stub',reason:'测试记录，不代表实际美术验收',checks:poseChecks,dryRun:false},f.c);return posePath;}

test('fast sparse poses solve internally without baking output, and long rotation segments remain below jump threshold',async()=>{
 const turn=fitCubicBezierTimeline([{time:0,value:0},{time:1,value:360}],['value'],.1,8,0,179);
 assert.ok(turn.frames.length>2);for(let i=1;i<turn.frames.length;i++)assert.ok(Math.abs(turn.frames[i].value-turn.frames[i-1].value)<180);assert.equal(turn.frames.at(-1)?.curve,undefined);
 const f=await fixture();try{
  const start={...structuredClone(f.frame),bendDirections:{leftArm:-1,rightArm:-1}};
  const hit=structuredClone(start);hit.time=.015;hit.targets.leftHand={x:.35,y:.95,angle:0};
  const end={...structuredClone(hit),time:.3};await writeFile(path.join(f.c.workspaceRoot,'fast.motion.json'),JSON.stringify({version:2,name:'fast',duration:.3,loop:false,coordinateSystem:'normalizedSkeleton',frames:[start,hit,end]}));
  const dry=await retargetMotion({filePath:f.filePath,mappingPath:f.mappingPath,motionPath:'fast.motion.json',animation:'fast',rotationTolerance:.3,translationTolerance:.07,footContactTolerance:.15,handTolerance:.35,preview:false},f.c);
  assert.equal(dry.ok,true,JSON.stringify(dry.validation));assert.ok(dry.motionValidation.maxHandError<.35);assert.ok(dry.stats.some((s:any)=>s.compressedCount<s.originalCount));
 }finally{await rm(f.c.workspaceRoot,{recursive:true,force:true});}
});

test('target image-referenced pose cannot approve before independent reference review, and reference changes invalidate it',async()=>{
 const f=await fixture();try{
  const standing=await confirmedStanding(f),cv=createCanvas(100,100);await writeFile(path.join(f.c.workspaceRoot,'ref.png'),cv.toBuffer('image/png'));
  const observation=withV2({imagePath:'ref.png',time:0,facing:'right',crop:[0,0,100,100],height:80,groundY:90,basis:'测试',points:Object.fromEntries(referenceRoles.map(k=>[k,{visibility:'unknown'}]))});
  await createReferencePose({referencePosePath:'ref.pose.json',observation,dryRun:false},f.c);
  await assert.rejects(()=>createPoseDraft({...f,posePath:'linked.json',kind:'action',standardPosePath:standing,referencePosePath:'ref.pose.json',dryRun:false},f.c),/尚未审查/);
  await createPoseDraft({...f,posePath:'legacy.json',kind:'action',standardPosePath:standing,reference:observation,dryRun:false},f.c);await solvePose({posePath:'legacy.json',dryRun:false},f.c);
  const legacy=await renderPoseComparison({posePaths:['legacy.json']},f.c);await assert.rejects(()=>reviewPose({posePath:'legacy.json',manifestPath:legacy.manifestPath,decision:'approved',reviewedBy:'test',reason:'测试',checks:poseChecks,dryRun:false},f.c),/独立标注/);
  const ref=await renderReferencePoseSheet({referencePosePaths:['ref.pose.json'],outputDir:'ref-sheet'},f.c);await reviewReferencePose({referencePosePath:'ref.pose.json',manifestPath:ref.manifestPath,decision:'approved',reviewedBy:'test-stub',reason:'测试未知点保存，不代表视觉判断',checks:referenceChecks,dryRun:false},f.c);
  await createPoseDraft({...f,posePath:'linked.json',kind:'action',standardPosePath:standing,referencePosePath:'ref.pose.json',dryRun:false},f.c);await solvePose({posePath:'linked.json',dryRun:false},f.c);
  const sheet=await renderPoseComparison({posePaths:['linked.json'],region:[0,0,100,100]},f.c);assert.ok(sheet.pages[0].diagnosticLocal);
  await assert.rejects(()=>reviewPose({posePath:'linked.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'test-stub',reason:'测试',checks:poseChecks,dryRun:false},f.c),/缺少 visualRig/);await assert.rejects(()=>requireReviewedPose('linked.json',f.c),/缺少 visualRig/);
  const r=JSON.parse(await readFile(path.join(f.c.workspaceRoot,'ref.pose.json'),'utf8'));r.observation.basis+=' changed';await writeFile(path.join(f.c.workspaceRoot,'ref.pose.json'),JSON.stringify(r));await assert.rejects(()=>requireReviewedPose('linked.json',f.c),/标注已改变/);
 }finally{await rm(f.c.workspaceRoot,{recursive:true,force:true});}
});

test('standing rejects crouch, pose review binds image bytes and inherited revisions invalidate approval',async()=>{const f=await fixture();try{const standing=await confirmedStanding(f);await createPoseDraft({...f,posePath:'crouch.json',kind:'standing',frame:{...f.frame,body:{x:0,y:-.3,rotate:0}},dryRun:false},f.c);const bad=await solvePose({posePath:'crouch.json',dryRun:false},f.c);assert.equal(bad.ok,false);assert.ok(bad.report.flexion.leftLeg>30);
 await createPoseDraft({...f,posePath:'action.json',kind:'action',standardPosePath:standing,frame:{time:.5},dryRun:false},f.c);const action=await solvePose({posePath:'action.json',dryRun:false},f.c);assert.equal(action.ok,true);assert.deepEqual(action.pose.frame.targets,f.frame.targets);
 await adjustPose({posePath:standing,outputPosePath:'revision.json',patch:{frame:{body:{y:.04}}},dryRun:false},f.c);await assert.rejects(()=>requireReviewedPose('revision.json',f.c),/未确认/);
 const p=JSON.parse(await readFile(path.join(f.c.workspaceRoot,standing),'utf8'));await writeFile(path.join(f.c.workspaceRoot,p.review.evidence[0].filePath),'changed');await assert.rejects(()=>requireReviewedPose(standing,f.c),/证据已改变/);
 }finally{await rm(f.c.workspaceRoot,{recursive:true,force:true});}});

test('approved pose to motion to candidate GIF to animation review commits on two different rigs',async()=>{const a=await fixture();try{for(const f of [a,await fixture('b',.75,a.c.workspaceRoot)]){const standard=await confirmedStanding(f),motionPath=f.prefix+'.motion.json';await buildMotionFromPoses({standardPosePath:standard,keyPoses:[{posePath:standard,time:0,stageId:'start'},{posePath:standard,time:.3,stageId:'end'}],motionPath,name:'idle',duration:.3,loop:true,dryRun:false},f.c);const before=await readSpineDocument(f.filePath,f.c),args={filePath:f.filePath,mappingPath:f.mappingPath,motionPath,animation:'idle',footContactTolerance:.001,handTolerance:.1};const dry=await retargetMotion(args,f.c);assert.equal(dry.ok,true);assert.equal(dry.poseGate.ok,true);assert.equal((await readSpineDocument(f.filePath,f.c)).hash,before.hash);await assert.rejects(()=>retargetMotion({...args,dryRun:false,expectedHash:before.hash,reviewToken:dry.reviewToken,preview:false},f.c));
 const review=await reviewAnimation({reviewToken:dry.reviewToken,manifestPath:dry.animationPreview.manifestPath,decision:'approved',reviewedBy:'test-visual-stub',reason:'测试完整确认链，不作视觉美术结论',checks:animationChecks,dryRun:false},f.c);const written=await retargetMotion({...args,dryRun:false,expectedHash:before.hash,reviewToken:review.reviewToken},f.c);assert.equal(written.ok,true);const after=await readSpineDocument(f.filePath,f.c);assert.deepEqual(after.json.bones,before.json.bones);assert.deepEqual(after.json.animations.original,{});assert.ok(written.backupPath);assert.equal((await requireReviewedPose(standard,f.c)).status,'confirmed');const explicit=await renderAnimationFrames({filePath:f.filePath,atlasPath:'empty.atlas',animation:'idle',times:[0,.15,.3]},f.c);assert.equal(explicit.frameCount,3);assert.equal(explicit.sampleTimes.at(-1),.3);
 }}finally{await rm(a.c.workspaceRoot,{recursive:true,force:true});}});

test('reference layout paginates, grip constraints and WebP/static decoding are reusable',async()=>{const f=await fixture();try{const standing=await confirmedStanding(f),cv=createCanvas(100,100);cv.getContext('2d').fillRect(0,0,100,100);await writeFile(path.join(f.c.workspaceRoot,'reference.webp'),cv.toBuffer('image/webp'));const ref=await analyzeReferenceGif({filePath:'reference.webp'},f.c);assert.equal(ref.frames.length,1);const paths=[];for(let i=0;i<7;i++){const posePath=`p${i}.json`;paths.push(posePath);await createPoseDraft({...f,posePath,id:`phase${i}`,kind:'action',standardPosePath:standing,frame:{time:i*.1},reference:{imagePath:ref.frames[0].filePath,time:i*.1,facing:'right',crop:[0,0,100,100],height:80,groundY:90,basis:'测试固定视图',points:{leftWrist:{x:20,y:50,visibility:'visible'},leftElbow:{visibility:'occluded'}}},dryRun:false},f.c);assert.equal((await solvePose({posePath,dryRun:false},f.c)).ok,true);}
 const r=await renderPoseComparison({posePaths:paths},f.c);assert.equal(r.pages.length,2);assert.equal(r.layout,'reference-above-target');assert.equal(r.poses[6].id,'phase6');assert.equal(r.poses[6].referenceTime,.6+1e-16);
 await createPoseDraft({...f,posePath:'grip.json',kind:'action',standardPosePath:standing,weapon:{x:0,y:.6,angle:0,grips:{left:-.15,right:.15}},dryRun:false},f.c);assert.equal((await solvePose({posePath:'grip.json'},f.c)).ok,true);
 await assert.rejects(()=>renderAnimationComparison({targetManifestPath:r.manifestPath,referenceManifestPath:ref.manifestPath,poseManifestPath:r.manifestPath,phaseMap:[{targetTime:0,referenceTime:1},{targetTime:1,referenceTime:0}]},f.c),/映射/);
 }finally{await rm(f.c.workspaceRoot,{recursive:true,force:true});}});
