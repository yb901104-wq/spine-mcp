import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { referenceRoles, referenceChecks, createReferencePose, renderReferencePoseSheet, reviewReferencePose, requireReferencePose, drawReferenceSkeleton } from '../src/referencePose.js';
import {referenceFrameAt} from '../src/animationReview.js';

test('synchronized reference frames respect floating point event boundaries',()=>{
 const frames=[{time:0,id:'start'},{time:.84,id:'lift'},{time:.9000000000000002,id:'thrust'},{time:1.6000000000000008,id:'rest'}];
 assert.equal(referenceFrameAt(frames,.9-2.4e-8).id,'thrust');assert.equal(referenceFrameAt(frames,1.6).id,'rest');assert.equal(referenceFrameAt(frames,.88).id,'lift');
});

test('reference annotations must declare every joint, inferred visibility, and bind review to image and evidence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-reference-')),c={workspaceRoot:root};
 try{
  const cv=createCanvas(100,100);await writeFile(path.join(root,'ref.png'),cv.toBuffer('image/png'));
  const points:any=Object.fromEntries(referenceRoles.map((r,i)=>[r,{visibility:'visible',x:20+i,y:20+i,confidence:.7,basis:'测试轮廓'}]));
  points.leftElbow={visibility:'occluded',x:30,y:30,estimated:true,confidence:.3,basis:'测试推测'};points.rightElbow={visibility:'unknown'};
  const observation={imagePath:'ref.png',time:0,facing:'right',crop:[0,0,100,100],height:80,groundY:90,basis:'测试参考',points};
  await assert.rejects(()=>createReferencePose({referencePosePath:'bad.json',observation:{...observation,points:{head:points.head}}},c),/必须声明/);
  await assert.rejects(()=>createReferencePose({referencePosePath:'bad.json',observation:{...observation,points:{...points,leftElbow:{...points.leftElbow,estimated:false}}}},c),/estimated/);
  await createReferencePose({referencePosePath:'ref.pose.json',observation,dryRun:false},c);
  await assert.rejects(()=>requireReferencePose('ref.pose.json',c),/尚未审查/);
  const sheet=await renderReferencePoseSheet({referencePosePaths:['ref.pose.json'],outputDir:'sheet'},c);
  assert.equal(sheet.layout,'reference-raw-above-annotated');assert.ok(sheet.warnings.some(s=>s.includes('unknown')));
  await reviewReferencePose({referencePosePath:'ref.pose.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'test-stub',reason:'只测试审查绑定，不代表美术结论',checks:referenceChecks,dryRun:false},c);
  assert.equal((await requireReferencePose('ref.pose.json',c)).status,'confirmed');
  const record=JSON.parse(await readFile(path.join(root,'ref.pose.json'),'utf8'));record.observation.points.head.x++;
  await writeFile(path.join(root,'changed.json'),JSON.stringify(record));await assert.rejects(()=>requireReferencePose('changed.json',c),/标注已改变/);
  await writeFile(path.join(root,sheet.pages[0]),'tampered');await assert.rejects(()=>requireReferencePose('ref.pose.json',c),/证据已改变/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('reference connections distinguish visible, inferred, and unknown joints',()=>{
 const paths:any[]=[],ctx:any={setLineDash(v:any){this.dash=v},beginPath(){this.current=[]},moveTo(...v:any[]){this.current.push(v)},lineTo(...v:any[]){this.current.push(v)},stroke(){if(this.current.length===2)paths.push({dash:this.dash,points:this.current})},arc(){},fill(){},fillText(){}};
 const o={points:{leftShoulder:{visibility:'visible',x:1,y:1},leftElbow:{visibility:'visible',x:2,y:2},leftWrist:{visibility:'occluded',x:3,y:3},rightShoulder:{visibility:'visible',x:4,y:4},rightElbow:{visibility:'unknown'},rightWrist:{visibility:'visible',x:6,y:6}}};
 drawReferenceSkeleton(ctx,o,(x,y)=>[x,y]);assert.equal(paths.length,2);assert.deepEqual(paths[0].dash,[]);assert.deepEqual(paths[1].dash,[5,4]);
});
