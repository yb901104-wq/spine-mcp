import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { installSimulatedHostPage } from './helpers/hostPage.js';
import { startHostServer } from '../src/hostServer.js';
import { HostClient } from '../src/hostClient.js';
import { strictHash } from '../src/hostContracts.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
import { createMotionRuntime } from '../src/motionRuntime.js';
import { HostEditorStore } from '../src/hostEditorStore.js';

const animations = { original: {}, move: { bones: { body: { rotate: [{value:0},{time:1,value:20}] } }, slots: {bodySlot:{attachment:[{name:'body'},{time:.5,name:'alternate'}]}}, drawOrder:[{time:.5,offsets:[{slot:'bodySlot',offset:1}]}] } };
const decode = (result:any) => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
async function withPlayback(fn:(fixture:any)=>Promise<void>) {
  await withHostFixture(async ({root,context,manifest}) => {
    const pose = JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8'));
    const motion = {version:2,name:'wave',duration:1,loop:false,coordinateSystem:'normalizedSkeleton',groundY:0,
      frames:[{...pose.frame,time:0},{...pose.frame,time:.5,head:10,presentation:{attachments:{bodySlot:'alternate'},drawOrder:['accentSlot','bodySlot']}},{...pose.frame,time:1,head:0}]};
    await writeFile(path.join(root,'wave.motion.json'),JSON.stringify(motion));
    manifest.documents.push({path:'wave.motion.json',kind:'motion',characterId:'hero'});
    await writeFile(path.join(root,'.spine-workflow.json'),JSON.stringify(manifest));
    await fn({root,context,manifest,motion});
  },{neutralSetup:true,animations});
}

test('动画 PNG 缓存命中不重建 runtime：仍前后校验 live 字节和选择，篡改不能借缓存返回旧图',async t=>withPlayback(async({root,context})=>{
 const host=await startHostServer(context,{developmentProfile:'c2-pose'}),client=new HostClient(context);
 try{
  const opened=await client.open({path:'body.json',animation:'move',time:.5,recheck:true}),doc=host.store.active!,args={expectedRevision:opened.version,size:480};
  const first=await host.store.frame(args),file=path.join(root,doc.derived.live.path),raw=await readFile(file,'utf8'),parse=JSON.parse;
  const mocked=t.mock.method(JSON,'parse',(...values:any[])=>{if(values[0]===raw)throw Error('缓存命中不应重新解析整份候选或构建 runtime');return (parse as any)(...values);});
  try{
   assert.deepEqual((await host.store.frame(args)).png,first.png);
   const otherSize=await host.store.frame({...args,size:320});assert.ok(otherSize.png.length>0,'新尺寸复用当前已核验 runtime，不能靠 PNG 命中掩盖重建');
  }finally{mocked.mock.restore();}
  const time=doc.derived.live.time;try{doc.derived.live.time=.25;await assert.rejects(host.store.frame(args),{code:'NO_SOLUTION'});}finally{doc.derived.live.time=time;}
  try{await writeFile(file,raw+' ');await assert.rejects(host.store.frame(args),{code:'SOLUTION_STALE'});}finally{await writeFile(file,raw);}
 }finally{await host.stop();}
}));

test('C2 skeleton 显式动画/时间、setup、无默认选择、新 epoch 与旧帧/旧候选隔离',async()=>withPlayback(async({root,context})=>{
  const host=await startHostServer(context,{developmentProfile:'c2-pose'}),client=new HostClient(context);
  const source=await readFile(path.join(root,'body.json'));
  try{
    const opened=await client.open({path:'body.json'});assert.equal(opened.activeDoc.view,null);
    assert.equal(opened.capabilities.operations.find((item:any)=>item.operation==='frame').reasons[0].code,'VIEW_NOT_SELECTED');
    await assert.rejects(client.frame({expectedRevision:opened.version}),{code:'VIEW_NOT_SELECTED'});
    for(const invalid of [{animation:'move'},{time:0},{animation:'missing',time:0},{animation:'move',time:2},{animation:null,time:.1}])
      await assert.rejects(client.open({path:'body.json',expectedRevision:opened.version,...invalid}));
    assert.deepEqual(host.store.active!.version,opened.version);
    const selected=await client.open({path:'body.json',animation:'move',time:.25,expectedRevision:opened.version});
    assert.notEqual(selected.version.openEpoch,opened.version.openEpoch);assert.equal(host.store.active!.derived,null);
    await assert.rejects(client.frame({expectedRevision:selected.version}),{code:'NO_SOLUTION'});
    const first=await client.open({path:'body.json',recheck:true});assert.ok(first.__imageData);
    assert.equal(first.state.numeric.status,'previewOnly');assert.equal(first.state.numeric.ok,undefined);
    const snapshot=await host.store.snapshot(first.version),oldResult=await evaluateHostSnapshot(snapshot,context);
    const next=await client.open({path:'body.json',animation:'move',time:.75,expectedRevision:first.version,recheck:true});
    assert.notEqual(first.__imageData,next.__imageData);assert.deepEqual(host.store.active!.derived.renderState.drawOrder,['accentSlot','bodySlot']);
    await assert.rejects(client.frame({expectedRevision:first.version}),{code:'REVISION_CONFLICT'});
    await assert.rejects(client.frame({expectedRevision:next.version,animation:'move',time:.25}),{code:'VIEW_SELECTION_MISMATCH'});
    await assert.rejects(host.store.publishDerived({expectedRevision:first.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result:oldResult}),{code:'REVISION_CONFLICT'});
    const same=await client.open({path:'body.json',animation:'move',time:.75});assert.deepEqual(same.version,next.version);
    const setup=await client.open({path:'body.json',animation:null,time:0,expectedRevision:next.version,recheck:true});assert.ok(setup.__imageData);
    assert.equal(host.store.active!.derived.live.animation,null);assert.deepEqual(host.store.active!.derived.renderState.drawOrder,['bodySlot','accentSlot']);
    assert.deepEqual(await readFile(path.join(root,'body.json')),source);assert.equal(host.store.writer,null);
  }finally{await host.stop();}
}));

test('C2 motion 由 MCP 预计算只读候选，实际采样/PNG，不授予写入；取消不发布候选',async()=>withPlayback(async({root,context})=>{
  const host=await startHostServer(context,{developmentProfile:'c2-pose'}),client=new HostClient(context);
  const source=await readFile(path.join(root,'body.json')),motion=await readFile(path.join(root,'wave.motion.json'));
  try{
    const opened=await client.open({path:'wave.motion.json',animation:'wave',time:.5,recheck:true});assert.ok(opened.__imageData);
    const doc=host.store.active!,live=JSON.parse(await readFile(path.join(root,doc.derived.live.path),'utf8'));
    assert.deepEqual(doc.derived.renderState.drawOrder,['accentSlot','bodySlot']);assert.equal(doc.derived.diagnosticOnly,true);
    assert.ok(live.animations.wave);assert.deepEqual(live.slots,JSON.parse(source.toString()).slots);
    const runtime=createMotionRuntime(live,doc.atlasRaw),sample=runtime.sample('wave',.5,doc.mapping.skin);
    assert.ok(Math.abs(sample.findBone('head')!.rotation-10)<1e-4);assert.equal(sample.findSlot('bodySlot')!.getAttachment()!.name,'alternate');
    assert.equal(doc.derived.live.hash,strictHash(await readFile(path.join(root,doc.derived.live.path))));
    await assert.rejects(host.store.pin(opened.version),{code:'CAPABILITY_MISSING'});
    const selected=await client.open({path:'wave.motion.json',animation:'wave',time:.2,expectedRevision:opened.version});
    const abort=new AbortController();await assert.rejects(client.evaluate(selected.version,abort.signal,stage=>{if(stage.includes('预计算'))abort.abort();}),{code:'TASK_CANCELLED'});
    assert.equal(host.store.active!.derived,null);assert.equal((await host.store.state()).evaluationTasks.active.length,0);
    assert.deepEqual(await readFile(path.join(root,'body.json')),source);assert.deepEqual(await readFile(path.join(root,'wave.motion.json')),motion);
  }finally{await host.stop();}
}));

test('实际 MCP open/recheck 显式选择并出图；截图协议绑定 kind/view，切换使在途截图失效',async()=>withPlayback(async({root,context})=>{
  const host=await startHostServer(context,{developmentProfile:'c2-pose',captureTimeoutMs:2000});installSimulatedHostPage(host.capture,host.store);
  const mcp=new Client({name:'playback-test',version:'1'},{capabilities:{}}),client=new HostClient(context);
  try{
    const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is[string,string]=>typeof entry[1]==='string'));
    await mcp.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}}));
    assert.ok((await mcp.listTools()).tools.length>=102);
    const openedResult=await mcp.callTool({name:'spine_host_open',arguments:{projectId:context.projectId,path:'body.json',animation:'move',time:.5,recheck:true}});
    assert.ok((openedResult.content as any[]).some(item=>item.type==='image'));const opened=decode(openedResult);
    const capture=await client.capture({expectedRevision:opened.version,animation:'move',time:.5,size:320});
    assert.equal(capture.manifest.kind,'skeleton');assert.deepEqual(capture.manifest.view,{animation:'move',time:.5});assert.equal(capture.manifest.captureValidity.status,'verified');
    await assert.rejects(client.capture({expectedRevision:opened.version,animation:'move',time:.6,size:320}),{code:'VIEW_SELECTION_MISMATCH'});
    let requested!:(task:any)=>void;const ready=new Promise<any>(resolve=>{requested=resolve;});host.capture.onRequest=requested;
    const pending=client.capture({expectedRevision:opened.version,size:320}).then(()=>null,error=>error);const task=await ready;
    await host.capture.bundle(task.id);
    const next=await client.open({path:'body.json',animation:'move',time:.8,expectedRevision:opened.version,recheck:true});
    await assert.rejects(host.capture.complete({captureId:task.id,visibilityState:'visible'}),{code:'REVISION_CONFLICT'});assert.equal((await pending).code,'REVISION_CONFLICT');
    assert.equal((await host.store.state()).capture,null);assert.notEqual(next.version.openEpoch,opened.version.openEpoch);
    const tamperReady=new Promise<any>(resolve=>{host.capture.onRequest=resolve;});
    const tamperPending=client.capture({expectedRevision:next.version,size:320}).then(()=>null,error=>error),tamperTask=await tamperReady;
    await host.capture.bundle(tamperTask.id);
    const livePath=path.join(root,host.store.active!.derived.live.path),liveRaw=await readFile(livePath);
    await writeFile(livePath,Buffer.concat([liveRaw,Buffer.from(' ')]));
    await assert.rejects(host.capture.complete({captureId:tamperTask.id,visibilityState:'visible'}),{code:'SOLUTION_STALE'});
    assert.equal((await tamperPending).code,'SOLUTION_STALE');assert.equal((await host.store.state()).capture,null);
  }finally{await mcp.close();await host.stop();}
}));

test('跨 pose/motion/skeleton 切换保留未提交 journal；新宿主重开仍须显式选择',async()=>withPlayback(async({context})=>{
  let host=await startHostServer(context,{developmentProfile:'c2-pose',writeEnabled:true});let client=new HostClient(context);
  try{
    const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
    const edited=await client.patch({expectedRevision:opened.version,ops:[{op:'setPoseParameters',path:'pose/frame/body',patch:{rotate:2}}],dryRun:false});
    const skeleton=await client.open({path:'body.json',animation:'move',time:.5,expectedRevision:edited.version,recheck:true});
    const motion=await client.open({path:'wave.motion.json',animation:'wave',time:.5,expectedRevision:skeleton.version,recheck:true});
    const restored=await client.open({path:'a.pose.json',expectedRevision:motion.version,recheck:true});
    assert.equal(host.store.active!.value.frame.body.rotate,2);assert.equal(host.store.active!.uncommitted,true);assert.ok(restored.__imageData);
    await host.stop();host=await startHostServer(context,{developmentProfile:'c2-pose',writeEnabled:true});client=new HostClient(context);
    const reopened=await client.open({path:'a.pose.json'});assert.equal(host.store.active!.value.frame.body.rotate,2);
    const raw=await client.open({path:'body.json',expectedRevision:reopened.version});assert.equal(raw.activeDoc.view,null);
    await assert.rejects(client.frame({expectedRevision:raw.version}),{code:'VIEW_NOT_SELECTED'});
  }finally{await host.stop();}
}));

test('C1/镜像不扩权，观察候选篡改和 motion 关键姿态依赖变化拒绝',async()=>withPlayback(async({root,context,manifest,motion})=>{
  const mirror=new HostEditorStore(context,'mirror','c2-pose');
  await assert.rejects(mirror.open({path:'body.json',animation:'move',time:0}),{code:'CAPABILITY_MISSING'});
  const mirrored=await mirror.open({path:'body.json'});
  assert.equal(mirrored.capabilities.viewing.supportedKinds.includes('skeleton'),false);
  let host=await startHostServer(context);let client=new HostClient(context);
  try{
    await assert.rejects(client.open({path:'body.json',animation:'move',time:0}),{code:'CAPABILITY_MISSING'});
    const opened=await client.open({path:'body.json'});await assert.rejects(client.frame({expectedRevision:opened.version}),{code:'UNSUPPORTED_DOC_KIND'});
  }finally{await host.stop();}
  host=await startHostServer(context,{developmentProfile:'c2-pose'});client=new HostClient(context);
  try{
    const opened=await client.open({path:'body.json',animation:'move',time:.5,recheck:true}),doc=host.store.active!;
    await writeFile(path.join(root,doc.derived.live.path),'tampered');await assert.rejects(client.frame({expectedRevision:opened.version}),{code:'SOLUTION_STALE'});
  }finally{await host.stop();}
  motion.poseWorkflow={standardPosePath:'a.pose.json',keyPoses:[{posePath:'b.pose.json',time:0}]};
  manifest.documents.find((item:any)=>item.kind==='motion').standardPosePath='a.pose.json';
  await writeFile(path.join(root,'wave.motion.json'),JSON.stringify(motion));await writeFile(path.join(root,'.spine-workflow.json'),JSON.stringify(manifest));
  host=await startHostServer(context,{developmentProfile:'c2-pose'});client=new HostClient(context);
  try{
    const opened=await client.open({path:'wave.motion.json',animation:'wave',time:0});
    assert.ok(host.store.active!.dependencies.some(item=>item.filePath==='b.pose.json'));
    const poseFile=path.join(root,'b.pose.json'),raw=await readFile(poseFile);await writeFile(poseFile,Buffer.concat([raw,Buffer.from(' ')]));
    await assert.rejects(client.frame({expectedRevision:opened.version}),{code:'TARGET_STALE'});
  }finally{await host.stop();}
}));

test('非 4.1 skeleton 与旧版 motion 保持结构只读，不声明无效动画能力',async()=>withPlayback(async({root,context,manifest,motion})=>{
  const sourcePath=path.join(root,'body.json'),original=await readFile(sourcePath),source=JSON.parse(original.toString());
  source.skeleton.spine='4.2.00';await writeFile(sourcePath,JSON.stringify(source));
  manifest.characters.hero.spineVersion='4.2.00';await writeFile(path.join(root,'.spine-workflow.json'),JSON.stringify(manifest));
  const host=await startHostServer(context,{developmentProfile:'c2-pose'}),client=new HostClient(context);
  try{
    const opened=await client.open({path:'body.json'});assert.equal(opened.activeDoc.view,null);
    assert.deepEqual(opened.capabilities.viewing.animations,[]);
    assert.equal(opened.capabilities.operations.find((item:any)=>item.operation==='frame').supported,false);
    await assert.rejects(client.open({path:'body.json',animation:null,time:0,expectedRevision:opened.version}),{code:'CAPABILITY_MISSING'});
    assert.deepEqual(host.store.active!.version,opened.version);
  }finally{await host.stop();}
  await writeFile(sourcePath,original);manifest.characters.hero.spineVersion='4.1.24';
  await writeFile(path.join(root,'.spine-workflow.json'),JSON.stringify(manifest));
  motion.version=1;await writeFile(path.join(root,'wave.motion.json'),JSON.stringify(motion));
  const legacyHost=await startHostServer(context,{developmentProfile:'c2-pose'}),legacyClient=new HostClient(context);
  try{
    const opened=await legacyClient.open({path:'wave.motion.json'});
    assert.equal(opened.capabilities.operations.find((item:any)=>item.operation==='evaluate').supported,false);
    assert.deepEqual(opened.capabilities.viewing.animations,[]);
    await assert.rejects(legacyClient.open({path:'wave.motion.json',animation:'wave',time:0,expectedRevision:opened.version}),{code:'CAPABILITY_MISSING'});
  }finally{await legacyHost.stop();}
}));
