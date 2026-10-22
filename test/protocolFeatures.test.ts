import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,utimes,stat,copyFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { registerWorkspace,selectWorkspace,setWorkspaceRoots,resolveWorkspace } from '../src/workspaceTools.js';
import { getWorkspaceTree } from '../src/workspaceTree.js';
import { cachedDocument,cacheStats,invalidate,cachedValue,withFast,withStrict } from '../src/runtimeCache.js';
import { solvePoseData,requireReviewedPose } from '../src/poseWorkflow.js';
import { boundedLeastSquares } from '../src/poseRefinementMath.js';
import { boundedLeastSquaresTask } from '../src/poseRefinementTasks.js';
import { runTask } from '../src/taskControl.js';
import { toolErrorPayload } from '../src/toolError.js';
import { startHostServer } from '../src/hostServer.js';
import { HostClient } from '../src/hostClient.js';
import { HostLifecycle } from '../src/hostLifecycle.js';
import { readWriter } from '../src/writerOwnership.js';
import { adjustPose } from '../src/poseWorkflow.js';
import { preparePoseSource } from '../src/poseWorkflow.js';
import { buildSemanticAnimation,buildSemanticAnimationData } from '../src/retargetEngine.js';
const env=()=>Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>typeof e[1]==='string'));
const decode=(r:any)=>{assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};

test('roots 不覆盖显式选择；来源可观测、失效 active 回落 roots/env',async()=>withHostFixture(async({root,context})=>{
  const other=path.join(root,'other');await mkdir(other);
  await registerWorkspace({rootPath:other,projectId:'other',source:'root',setActive:false});await setWorkspaceRoots(['other']);
  assert.equal(resolveWorkspace().projectId,context.projectId);assert.equal(resolveWorkspace().resolvedFrom,'active');
  await selectWorkspace(context.projectId);await setWorkspaceRoots(['other']);assert.equal(resolveWorkspace().projectId,context.projectId);
  const file=path.join(root,'.spine-mcp/workspaces.json'),registry=JSON.parse(await readFile(file,'utf8'));registry.activeProjectId='missing';await writeFile(file,JSON.stringify(registry));
  assert.equal(resolveWorkspace().resolvedFrom,'roots');assert.equal(resolveWorkspace().root,other);
  await setWorkspaceRoots([]);assert.equal(resolveWorkspace().resolvedFrom,'env');assert.throws(()=>resolveWorkspace('missing'),/未登记/);
}));

test('缓存：20 次求解复用 SkeletonData、Skeleton 独立；严格读取抓同尺寸同 mtime 改动',async()=>withHostFixture(async({root,context})=>{
  invalidate();const initial=cacheStats(),pose=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8'));
  const first=await solvePoseData(pose,context),skeletons=new Set([first.skeleton]);
  for(let i=0;i<19;i++)skeletons.add((await solvePoseData(pose,context)).skeleton);
  assert.equal(cacheStats().skeletonDataBuilds-initial.skeletonDataBuilds,1);assert.equal(skeletons.size,20);
  first.skeleton.bones[0].rotation=900;assert.notEqual((await solvePoseData(pose,context)).skeleton.bones[0].rotation,900);
  const file=path.join(root,'cache.json'),time=new Date('2020-01-01T00:00:00Z');await writeFile(file,'{"v":1}');await utimes(file,time,time);
  const before=await withFast(()=>cachedDocument(file));await writeFile(file,'{"v":2}');await utimes(file,time,time);
  assert.deepEqual((await withFast(()=>cachedDocument(file))).json,before.json);assert.equal((await withStrict(()=>cachedDocument(file))).json.v,2);
  cachedValue('budget-a',()=>({}),80*1024*1024);cachedValue('budget-b',()=>({}),80*1024*1024);assert.ok(cacheStats().bytes<=128*1024*1024);invalidate();
  const body=path.join(root,'body.json'),bodyRaw=await readFile(body,'utf8');await utimes(body,time,time);await withFast(()=>cachedDocument(body));
  await writeFile(body,bodyRaw.replace('"x":4','"x":5'));await utimes(body,time,time);
  await assert.rejects(withFast(()=>requireReviewedPose('a.pose.json',context)),/角色结构匹配/);
}));

test('工程树有界快照分页、生成目录忽略，错误 root/游标拒绝',async()=>withHostFixture(async({root,context})=>{
  await mkdir(path.join(root,'node_modules'));await writeFile(path.join(root,'node_modules','hidden.json'),'{}');
  const all:any[]=[];let cursor:string|undefined;
  do{const page=await getWorkspaceTree({depth:2,maxEntries:500,pageSize:3,cursor},context);all.push(...page.entries);cursor=page.nextCursor??undefined;assert.ok(page.counts.dirsVisited<=40);assert.ok(page.counts.entriesVisited<=500);}while(cursor);
  assert.equal(new Set(all.map(e=>e.path)).size,all.length);assert.ok(all.some(e=>e.path==='a.pose.json'));assert.ok(all.every(e=>!e.path.includes('node_modules')&&!e.path.includes('.spine-mcp')));
  await assert.rejects(getWorkspaceTree({root:'../'},context),/工作区/);await assert.rejects(getWorkspaceTree({cursor:'invalid'},context),/游标/);
}));

test('任务控制不改变求解结果；迭代间可取消，结构化错误保留 issues',async()=>{
  const initial=[3,4],evaluate=(x:number[])=>[x[0]-1,x[1]-2],options={bounds:[[-10,10],[-10,10]]as Array<[number,number]>,steps:[.001,.001],iterations:60};
  const notifications:any[]=[];
  const sync=boundedLeastSquares(initial,evaluate,options),asyncResult=await runTask({progress:(current,total)=>notifications.push({current,total})},()=>boundedLeastSquaresTask(initial,evaluate,options));
  assert.deepEqual(asyncResult,sync);assert.equal(notifications.at(-1).current,notifications.at(-1).total);
  const abort=new AbortController();await assert.rejects(runTask({signal:abort.signal,progress:()=>abort.abort()},()=>boundedLeastSquaresTask(initial,evaluate,options)),(e:any)=>e.code==='CANCELLED');
  const issues=[{category:'identityConflict',message:'左右冲突'},{category:'inputMissing',message:'缺面部锚点'},{category:'relationMismatch',message:'支撑不同'}],payload=toolErrorPayload({message:'动作校验失败',issues},'test');
  assert.equal(payload.code,'CONFLICT');assert.equal(payload.error.issues.length,3);assert.equal(payload.error.tool,'test');assert.equal(toolErrorPayload({code:'ENOENT',message:'缺文件'}).code,'IO');
});

test('局部修正已取消时零评估；进度回调取消后不再启动下一次数值迭代',async()=>{
  const initial=[3,4],options={bounds:[[-10,10],[-10,10]]as Array<[number,number]>,steps:[.001,.001],iterations:60};
  let evaluations=0;const evaluate=(x:number[])=>{evaluations++;return[x[0]-1,x[1]-2];};
  const before=new AbortController();before.abort();
  await assert.rejects(runTask({signal:before.signal},()=>boundedLeastSquaresTask(initial,evaluate,options)),(error:any)=>error.code==='CANCELLED');
  assert.equal(evaluations,0,'已取消请求不能先执行初始评估');
  const during=new AbortController();
  await assert.rejects(runTask({signal:during.signal,progress:()=>during.abort()},()=>boundedLeastSquaresTask(initial,evaluate,options)),(error:any)=>error.code==='CANCELLED');
  assert.equal(evaluations,1,'仅初始评估已发生；回调取消后不得继续 Jacobian 或候选搜索');
});

test('完整动画异步任务与纯计算结果一致，取消在采样检查点停止且不改原角色',async()=>withHostFixture(async({root,context})=>{
  const before=await readFile(path.join(root,'body.json'),'utf8'),pose=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8')),{source}=await preparePoseSource(pose,context);
  const motion:any={version:2,name:'cancel-test',duration:1,loop:true,coordinateSystem:'normalizedSkeleton',frames:[{...pose.frame,time:0},{...pose.frame,time:1}]};
  const expected=buildSemanticAnimationData(source.doc.json,source.mapping,motion,{},source.rt);
  assert.deepEqual(await buildSemanticAnimation(source.doc.json,source.mapping,motion,{},context),expected);
  const controller=new AbortController(),started=performance.now();
  await assert.rejects(runTask({signal:controller.signal,progress:()=>controller.abort()},()=>buildSemanticAnimation(source.doc.json,source.mapping,motion,{},context)),(error:any)=>error.code==='CANCELLED');
  assert.ok(performance.now()-started<300);assert.equal(await readFile(path.join(root,'body.json'),'utf8'),before);
}));

test('真实 MCP：resources/prompts/logging 声明可兑现，只读不启动 Host，越权拒绝',async()=>withHostFixture(async({root,context,manifest})=>{
  await copyFile(path.join(root,'a.pose.json'),path.join(root,'neutral.json'));manifest.documents.push({path:'neutral.json',kind:'pose',characterId:'hero'});await writeFile(path.join(root,'.spine-workflow.json'),JSON.stringify(manifest));
  for(let i=0;i<60;i++)await writeFile(path.join(root,`reference-${i}-${'参考'.repeat(20)}.json`),'{"observation":{}}');
  const client=new Client({name:'protocol-features',version:'1'},{capabilities:{}});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env(),SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'1'}}));
    assert.equal(client.getServerVersion()?.version,'0.2.0');
    assert.ok(client.getServerCapabilities()?.resources);assert.ok(client.getServerCapabilities()?.prompts);assert.ok(client.getServerCapabilities()?.logging);
    assert.deepEqual(await client.setLoggingLevel('info'),{});
    const listed=await client.listResources();assert.ok(Buffer.byteLength(JSON.stringify(listed))<5000);assert.ok(listed.resources.some(r=>r.uri==='spine://session'));
    const resources=[...listed.resources];let cursor=listed.nextCursor;
    while(cursor){const page=await client.listResources({cursor});assert.ok(Buffer.byteLength(JSON.stringify(page))<5000);resources.push(...page.resources);cursor=page.nextCursor;}
    assert.equal(new Set(resources.map(r=>r.uri)).size,resources.length);assert.equal(resources.filter(r=>r.uri.startsWith('spine://reference/')).length,60);assert.ok(resources.some(r=>r.uri==='spine://pose/neutral.json'));
    assert.equal((await client.listResourceTemplates()).resourceTemplates.length,6);
    assert.equal((await client.listPrompts()).prompts.length,3);
    for(const name of ['pose-prepare','pose-diagnose','preview-verify'])assert.ok((await client.getPrompt({name,arguments:{posePath:'a.pose.json'}})).messages.length);
    const state=JSON.parse((await client.readResource({uri:'spine://session'})).contents[0].text as string);assert.equal(state.available,false);
    await assert.rejects(stat(path.join(root,'.spine-mcp/host-port.json')),(e:any)=>e.code==='ENOENT');
    const metrics=JSON.parse((await client.readResource({uri:'spine://metrics/a.pose.json'})).contents[0].text as string);assert.equal(metrics.solveCount,0);
    const resource=JSON.parse((await client.readResource({uri:'spine://doc/body.json/bones'})).contents[0].text as string);
    assert.deepEqual(resource,decode(await client.callTool({name:'spine_get_skeleton_hierarchy',arguments:{projectId:context.projectId,filePath:'body.json'}})));
    for(const uri of ['spine://pose/..%2Foutside.json','spine://pose/D%3A%2Fsecret.json','spine://unknown/a.json','spine://pose/%00.json'])await assert.rejects(client.readResource({uri}),(e:any)=>e.data?.code==='IO');
    const recheck=decode(await client.callTool({name:'spine_recheck_pose',arguments:{projectId:context.projectId,posePath:'a.pose.json'}}));assert.ok(recheck.solved);
    const invalid=await client.callTool({name:'spine_get_pose_state',arguments:{posePath:'a.pose.json',unknown:true}});assert.equal(invalid.isError,true);assert.equal(JSON.parse((invalid.content as any)[0].text).error.code,'VALIDATION_FAILED');
    const definitions=(await client.listTools()).tools;
    assert.equal(definitions.length,101);assert.ok(definitions.every(tool=>tool.inputSchema.additionalProperties===false));
    const frameSchema:any=definitions.find(t=>t.name==='spine_create_pose_draft')!.inputSchema.properties!.frame;
    assert.equal(frameSchema.additionalProperties,false);assert.equal(frameSchema.properties.channels.additionalProperties.properties.rotate.type,'number');
    const nestedInvalid=await client.callTool({name:'spine_adjust_pose',arguments:{posePath:'a.pose.json',outputPosePath:'bad.pose.json',patch:{frame:{targets:{leftHand:{x:.1,review:{decision:'approved'}}}}}}});
    assert.equal(nestedInvalid.isError,true);assert.equal(JSON.parse((nestedInvalid.content as any)[0].text).code,'VALIDATION_FAILED');
  }finally{await client.close();}
}));

test('姿态输入声明与回读一致：复合参数可合并，未知字段/原型/非有限数在写入前拒绝',async()=>withHostFixture(async({root,context})=>{
  const before=await readFile(path.join(root,'a.pose.json'),'utf8');
  const patch={frame:{body:{rotate:7},head:12,channels:{torso:{rotate:5}},targets:{leftHand:{x:.12}},bendDirections:{leftArm:-1},action:{driver:'rightHand'},presentation:{attachments:{accentSlot:null},drawOrder:['accentSlot','bodySlot']}},weapon:null};
  const result=await adjustPose({posePath:'a.pose.json',outputPosePath:'parameters.pose.json',patch,dryRun:false},context);
  const saved=JSON.parse(await readFile(path.join(root,'parameters.pose.json'),'utf8'));assert.deepEqual(saved,result.pose);assert.equal(saved.frame.head,12);assert.equal(saved.frame.body.rotate,7);assert.equal(saved.frame.channels.torso.rotate,5);assert.equal(saved.frame.presentation.attachments.accentSlot,null);assert.equal(saved.solution,undefined);assert.equal(saved.review,undefined);
  for(const bad of [{frame:{solution:{approved:true}}},{frame:{body:{rotate:NaN}}},JSON.parse('{"frame":{"channels":{"__proto__":{"rotate":8}}}}')])await assert.rejects(adjustPose({posePath:'a.pose.json',outputPosePath:'rejected.pose.json',patch:bad,dryRun:false},context),(e:any)=>e.code==='VALIDATION_FAILED');
  assert.equal(await readFile(path.join(root,'a.pose.json'),'utf8'),before);await assert.rejects(stat(path.join(root,'rejected.pose.json')),(e:any)=>e.code==='ENOENT');
}));

test('工程切换等待 Host 退役与锁释放，未提交 journal 可恢复；未确认交接不能连接新工程',async()=>withHostFixture(async first=>withHostFixture(async second=>{
  const registryRoot=process.env.SPINE_MCP_REGISTRY_ROOT;process.env.SPINE_MCP_REGISTRY_ROOT=first.root;
  const a=await startHostServer(first.context,{writeEnabled:true}),b=await startHostServer(second.context),clientA=new HostClient(first.context,true),clientB=new HostClient(second.context,true);
  try{
    await clientA.open({path:'a.pose.json'});const version=a.store.active!.version;
    await clientA.rpc('/api/pin',{expectedRevision:version});
    await clientA.rpc('/api/patch',{expectedRevision:version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',angle:14}],dryRun:false});
    assert.equal(await clientB.ensurePreview(),true);assert.equal(await readWriter(first.context),null);assert.equal(a.server.listening,false);
    await assert.rejects(stat(path.join(first.root,'.spine-mcp/host-port.json')),(e:any)=>e.code==='ENOENT');
    const reopened=await startHostServer(first.context,{writeEnabled:true});try{await reopened.store.open({path:'a.pose.json'});assert.equal(reopened.store.active!.value.frame.targets.leftHand.angle,14);assert.equal(reopened.store.active!.uncommitted,true);assert.equal(reopened.store.pinned,null);}finally{await reopened.stop();}
    const coordinator=new HostLifecycle();let connected=false;
    await coordinator.activate({shutdownForSwitch:async()=>{throw Error('尚未确认释放');}},async()=>true);
    await assert.rejects(coordinator.activate({shutdownForSwitch:async()=>{}},async()=>{connected=true;return true;}),(e:any)=>e.code==='WRITE_OWNERSHIP_UNCERTAIN');assert.equal(connected,false);
  }finally{try{await clientB.shutdownForSwitch();await a.stop();await b.stop();}finally{if(registryRoot===undefined)delete process.env.SPINE_MCP_REGISTRY_ROOT;else process.env.SPINE_MCP_REGISTRY_ROOT=registryRoot;}}
})));
