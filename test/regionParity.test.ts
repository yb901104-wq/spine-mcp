import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,cp } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas,loadImage } from '@napi-rs/canvas';
import { withHostFixture } from './helpers/hostFixture.js';
import { solvePoseData } from '../src/poseWorkflow.js';
import { createMotionRuntime,worldVertices } from '../src/motionRuntime.js';
import { loadAtlasImages,rasterFrame } from '../src/rasterRenderer.js';
import { strictHash } from '../src/hostContracts.js';
import { validateHostGolden } from '../src/goldenValidation.js';

test('不透明 region 对照既有真实 player PNG：顶点相同、差异比例≤0.5%、最大通道差≤8',async()=>withHostFixture(async({root,context})=>{
  const fixture=path.join(process.cwd(),'test/fixtures/host'),manifest=JSON.parse(await readFile(path.join(fixture,'player-region.json'),'utf8')),raw=await readFile(path.join(fixture,'player-region.png'));
  assert.equal(strictHash(raw),manifest.evidence[0].hash);assert.equal(manifest.source,'player');
  const pose=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8')),solved=await solvePoseData(pose,context),vertices=worldVertices(solved.skeleton);
  assert.deepEqual(Object.keys(vertices),Object.keys(manifest.actual.vertices));
  for(const key of Object.keys(vertices))vertices[key].forEach((v,i)=>assert.ok(Math.abs(v-manifest.actual.vertices[key][i])<=1e-4));
  const actual=rasterFrame(solved.skeleton,await loadAtlasImages(solved.rt.atlas,'body.atlas',context),manifest.camera,320,320,'#20242b'),baseline=createCanvas(320,320);baseline.getContext('2d').drawImage(await loadImage(raw),0,0);
  const a=actual.getContext('2d').getImageData(0,0,320,320).data,b=baseline.getContext('2d').getImageData(0,0,320,320).data;let changed=0,maximum=0;
  for(let i=0;i<a.length;i+=4){let differs=false;for(let c=0;c<4;c++){const error=Math.abs(a[i+c]-b[i+c]);maximum=Math.max(maximum,error);differs||=error!==0;}if(differs)changed++;}
  assert.ok(changed/(320*320)<=.005);assert.ok(maximum<=8);
  // 这是 renderer 单样本回归，旧 manifest 不登记为新 Host 视觉证据。
}));

test('不透明重叠 region 逐样本合成，顶层覆盖相同样本且 drawOrder 回读有效',async()=>{
  const atlas=(name:string)=>`${name}.png\nsize: 1,1\nfilter: Linear,Linear\n${name}\n  bounds: 0,0,1,1\n`;
  const json={skeleton:{spine:'4.1.24'},bones:[{name:'root'}],slots:[{name:'a',bone:'root',attachment:'orange'},{name:'b',bone:'root',attachment:'blue'}],skins:[{name:'default',attachments:{a:{orange:{width:1.5,height:1.5}},b:{blue:{width:1.5,height:1.5}}}}],animations:{idle:{}}};
  const rt=createMotionRuntime(json,atlas('orange')+'\n'+atlas('blue')),s=rt.sample('idle',0),images=new Map();
  for(const [name,color]of [['orange','#efab55'],['blue','#55bcdd']]){const c=createCanvas(1,1);c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,1,1);images.set(name+'.png',await loadImage(c.toBuffer('image/png')));}
  const render=()=>rasterFrame(s,images,{minX:-1,maxX:1,minY:-1,maxY:1},2,2,'#20242b').toBuffer('image/png');
  const both=render();s.setAttachment('a',null);assert.deepEqual(render(),both,'底层被相同样本覆盖，不得先 resolve 造成漏色');
  s.setAttachment('a','orange');s.drawOrder.reverse();const reversed=render();assert.notDeepEqual(reversed,both);s.setAttachment('b',null);assert.deepEqual(render(),reversed);
});

test('三张真实 player 基线通过；基线文件变化和伪造回读均拒绝，缺基线不默认为通过',async()=>withHostFixture(async({root})=>{
  const verdict=await validateHostGolden();assert.equal(verdict.goldenPassed,true,JSON.stringify(verdict));assert.equal(verdict.cases?.length,3);
  assert.equal((await validateHostGolden(root)).goldenPassed,'unverified');
  await cp('test/golden/host',path.join(root,'test/golden/host'),{recursive:true});
  const manifestPath=path.join(root,'test/golden/host/manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8')),fixture=manifest.cases[0],capturePath=path.join(root,fixture.captureManifestPath),original=await readFile(capturePath,'utf8');
  await writeFile(capturePath,original+' ');assert.equal((await validateHostGolden(root)).goldenPassed,false);
  const capture=JSON.parse(original);capture.actual.bones[0][1]+=1;const forged=JSON.stringify(capture);await writeFile(capturePath,forged);fixture.files[fixture.captureManifestPath]=strictHash(forged);await writeFile(manifestPath,JSON.stringify(manifest));
  const rejected=await validateHostGolden(root);assert.equal(rejected.goldenPassed,false);assert.match(rejected.reasons.join(' '),/实际回读失配/);
}));
