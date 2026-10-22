import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,symlink,unlink,utimes } from 'node:fs/promises';
import path from 'node:path';
import { withHostFixture } from './helpers/hostFixture.js';
import { strictFileChecks } from '../src/strictFileChecks.js';
import { strictHash } from '../src/hostContracts.js';
import { resolveWorkspacePath } from '../src/spineJson.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
import { createMotionRuntime,worldVertices } from '../src/motionRuntime.js';
import { applyRenderSnapshot } from '../src/renderSnapshot.js';

test('并发严格读取保持输入次序，缺文件不遗留后台结果，同 size/mtime 改动不复用旧核验',async()=>withHostFixture(async({root,context})=>{
  const files=[];for(let i=0;i<18;i++){const filePath=`strict-${i}.json`,value=JSON.stringify({n:i});await writeFile(path.join(root,filePath),value);files.push({filePath,hash:strictHash(value)});}
  files.splice(5,0,{filePath:'missing.json',hash:'none'});
  const resolve=(file:string)=>resolveWorkspacePath(file,context),first=await strictFileChecks(files,resolve);
  assert.deepEqual(first.map(r=>r.filePath),files.map(f=>f.filePath));assert.ok(first[5].error);assert.equal(first.at(-1)!.actual,files.at(-1)!.hash);
  const file=path.join(root,files[0].filePath),time=new Date('2020-01-01');await utimes(file,time,time);await strictFileChecks([files[0]],resolve);await writeFile(file,'{"n":9}');await utimes(file,time,time);
  assert.notEqual((await strictFileChecks([files[0]],resolve))[0].actual,files[0].hash);
}));

test('原生 realpath 每次识别 junction 目标变化，缺失子路径也不能借旧边界检查越界',async()=>withHostFixture(async({root,context})=>withHostFixture(async outside=>{
  const inner=path.join(root,'内部目录'),link=path.join(root,'切换链接');await mkdir(inner);await writeFile(path.join(inner,'input.json'),'{}');
  await symlink(inner,link,process.platform==='win32'?'junction':'dir');assert.equal(resolveWorkspacePath('切换链接/input.json',context),path.join(link,'input.json'));
  assert.equal(resolveWorkspacePath('切换链接/未创建/output.json',context),path.join(link,'未创建/output.json'));
  await unlink(link);await symlink(outside.root,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>resolveWorkspacePath('切换链接/input.json',context),/工作区边界/);assert.throws(()=>resolveWorkspacePath('切换链接/未创建/output.json',context),/工作区边界/);
  await unlink(link);
})));

test('首次可信回放相机包含角色全部可见顶点，此后 patch/undo 保持相机固定',async()=>withHostFixture(async({root,context})=>{
  const file=path.join(root,'a.pose.json'),pose=JSON.parse(await readFile(file,'utf8'));pose.frame.body.y=3;delete pose.solution;delete pose.review;await writeFile(file,JSON.stringify(pose));
  const store=new HostEditorStore(context);await store.enableWriting();
  try{
    await store.open({path:'a.pose.json'});assert.equal(store.active!.cameraInitialized,false);
    const snapshot=await store.snapshot(store.active!.version),result=await evaluateHostSnapshot(snapshot,context);await store.publishDerived({expectedRevision:snapshot.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result});
    const camera=structuredClone(store.active!.camera),rt=createMotionRuntime(store.active!.skeletonJson,store.active!.atlasRaw);
    applyRenderSnapshot(rt.skeleton,{bones:result.bones,slotAttachments:store.active!.mapping.bones.slotAttachments,presentation:pose.frame.presentation});
    for(const vertices of Object.values(worldVertices(rt.skeleton)))for(let i=0;i<vertices.length;i+=2){assert.ok(vertices[i]>=camera.minX&&vertices[i]<=camera.maxX);assert.ok(vertices[i+1]>=camera.minY&&vertices[i+1]<=camera.maxY);}
    assert.equal(store.active!.cameraInitialized,true);await store.pin(store.active!.version);
    await store.patch({expectedRevision:store.active!.version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/rightHand',role:'rightHand',angle:-70}],dryRun:false});assert.deepEqual(store.active!.camera,camera);
    await store.history('undo',{expectedRevision:store.active!.version,dryRun:false});assert.deepEqual(store.active!.camera,camera);
  }finally{await store.shutdown();}
}));
