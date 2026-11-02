import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { HostClient } from '../src/hostClient.js';
import { objectHash } from '../src/hostContracts.js';
import { hostPoseCommandTools } from '../src/hostPoseCommands.js';

const decode=(response:any)=>{assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
const failure=(response:any,code?:string)=>{assert.equal(response.isError,true,JSON.stringify(response));const error=JSON.parse(response.content[0].text);if(code)assert.equal(error.code,code,JSON.stringify(error));return error;};
// 连接心跳独立更新连接记录及其原子临时文件；资产、journal、Writer 和其它路径仍逐项比较。
const commandTree=async(root:string)=>(await readdir(root,{recursive:true})).filter(file=>!/^\.spine-mcp\/connections(?:\/|$)/.test(file.replace(/\\/g,'/'))).sort();
async function mcp(root:string){
  const client=new Client({name:'host-pose-commands-test',version:'1'},{capabilities:{}});
  const env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>typeof e[1]==='string'));
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}}));return client;
}

test('C2 高层命令实际 stdio：四入口发现、dryRun 零编辑、内存累积/PNG、撤销及独立安全保存',async()=>withHostFixture(async({root,context})=>{
  const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=await mcp(root);
  const call=(name:string,args:any)=>client.callTool({name,arguments:{projectId:context.projectId,...args}});
  const inputPaths=['body.json','mapping.json','body.atlas','body.png','a.pose.json'];
  const inputs=await Promise.all(inputPaths.map(file=>readFile(path.join(root,file))));
  try{
    const listed=await client.listTools();assert.ok(listed.tools.length>=102);
    for(const name of hostPoseCommandTools){const schema=listed.tools.find(t=>t.name===name)!.inputSchema;assert.ok(schema.properties?.expectedRevision);assert.ok(schema.anyOf);assert.equal(schema.required!.includes('outputPosePath'),false);}
    const opened=decode(await call('spine_host_open',{path:'a.pose.json'}));decode(await call('spine_host_pin',{expectedRevision:opened.version}));
    assert.ok(opened.capabilities.editing.commandAdapters.every((item:any)=>item.supported&&item.execution==='host-memory'));
    const before=objectHash(host.store.active),files=await commandTree(root);
    const cases:[string,any][]=[['spine_adjust_pose',{patch:{frame:{body:{rotate:2},head:3}}}],['spine_set_pose_channel',{name:'torso',rotate:1}],['spine_set_pose_target',{role:'leftHand',angle:-85}],['spine_batch_pose_ops',{render:false,ops:[{op:'channel',name:'torso',rotate:2},{op:'target',role:'rightHand',angle:-84}]}]];
    for(const [name,args] of cases){const dry=decode(await call(name,{posePath:'a.pose.json',expectedRevision:opened.version,...args}));assert.equal(dry.dryRun,true);assert.equal(dry.adapter.persisted,false);assert.equal(objectHash(host.store.active),before);}
    assert.deepEqual(await commandTree(root),files);
    for(const [name,args] of cases){
      const previous=host.store.active!.version,response=await call(name,{posePath:'a.pose.json',expectedRevision:previous,...args,dryRun:false}),edited=decode(response);
      assert.equal(edited.version.revision,previous.revision+1);assert.ok((response.content as any[]).some(item=>item.type==='image'));assert.deepEqual(edited.state.version,edited.version);
    }
    assert.equal(host.store.active!.value.frame.head,3);assert.equal(host.store.active!.value.frame.channels.torso.rotate,2);
    assert.equal(host.store.active!.value.frame.targets.leftHand.angle,-85);assert.equal(host.store.active!.undo.length,4);
    const full=structuredClone(host.store.active!.value.frame),latest=host.store.active!.version;
    const undo=decode(await call('spine_host_undo',{expectedRevision:latest,dryRun:false}));assert.equal(host.store.active!.value.frame.channels.torso.rotate,1);
    const redo=decode(await call('spine_host_redo',{expectedRevision:undo.version,dryRun:false}));assert.deepEqual(host.store.active!.value.frame,full);
    const saved=decode(await call('spine_host_commit',{expectedRevision:redo.version,outputPath:'commands.pose.json',requestId:'commands-save',dryRun:false}));
    assert.equal(saved.committed,true);assert.ok(saved.backupPath);
    decode(await call('spine_host_open',{path:'commands.pose.json',expectedRevision:saved.version}));assert.deepEqual(host.store.active!.value.frame,full);
    for(let i=0;i<inputPaths.length;i++)assert.deepEqual(await readFile(path.join(root,inputPaths[i])),inputs[i]);
  }finally{await client.close();await host.stop();}
},{neutralSetup:true}));

test('C2 附着命令反例：缺/旧版本、错误路径、输出语义、后项越权与固定条件整批拒绝',async()=>withHostFixture(async({root,context})=>{
  const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=await mcp(root);
  const call=(name:string,args:any)=>client.callTool({name,arguments:{projectId:context.projectId,...args}});
  try{
    const opened=decode(await call('spine_host_open',{path:'a.pose.json'}));decode(await call('spine_host_pin',{expectedRevision:opened.version}));
    const base={posePath:'a.pose.json',expectedRevision:opened.version},before=objectHash(host.store.active),files=await commandTree(root);
    const invalid:[string,any,string?][]=[
      ['spine_set_pose_channel',{...base,expectedRevision:undefined,outputPosePath:'no.json',name:'torso',rotate:1},'REVISION_CONFLICT'],
      ['spine_set_pose_channel',{...base,expectedRevision:{...opened.version,revision:99},name:'torso',rotate:1},'REVISION_CONFLICT'],
      ['spine_set_pose_channel',{...base,posePath:'b.pose.json',name:'torso',rotate:1},'TARGET_DRIFT'],
      ['spine_set_pose_channel',{...base,outputPosePath:'no.json',name:'torso',rotate:1},'INVALID_ARGUMENT'],
      ['spine_set_pose_target',{...base,role:'leftFoot',contact:false},'INVALID_ARGUMENT'],
      ['spine_set_pose_target',{...base,role:'leftFoot',y:.1},'OPERATION_NOT_READY'],
      ['spine_batch_pose_ops',{...base,ops:[{op:'channel',name:'torso',rotate:1},{op:'weapon',weapon:null}]},'INVALID_ARGUMENT'],
      ['spine_batch_pose_ops',{...base,ops:[{op:'channel',name:'torso',rotate:1},{op:'channel',name:'missing',rotate:2}]},'CAPABILITY_MISSING'],
      ['spine_batch_pose_ops',{...base,ops:[{op:'channel',name:'torso',rotate:1},{op:'channel',name:'torso',x:2}]},'INVALID_ARGUMENT'],
      ['spine_batch_pose_ops',{...base,ops:[{op:'channel',name:'torso',rotate:1}],render:true},'INVALID_ARGUMENT'],
      ...[{weapon:null},{groundY:1},{referencePosePath:'other.json'},{frame:{time:.5}},{frame:{bendDirections:{leftArm:-1}}},{frame:{}},{frame:{channels:{}}},{frame:{head:180}},{frame:{presentation:{attachments:{bodySlot:'missing'}}}}].map(patch=>['spine_adjust_pose',{...base,patch}] as [string,any]),
    ];
    for(const [name,args,code] of invalid){failure(await call(name,{...args,dryRun:false}),code);assert.equal(objectHash(host.store.active),before);assert.deepEqual(await commandTree(root),files);}
    const presentation=decode(await call('spine_adjust_pose',{...base,patch:{frame:{head:4,presentation:{attachments:{bodySlot:null},drawOrder:['accentSlot','bodySlot']}}},dryRun:false}));
    assert.equal(presentation.version.revision,1);assert.equal(host.store.active!.derived.renderState.attachments[0][1],null);
    const stale=failure(await call('spine_set_pose_channel',{...base,name:'torso',rotate:1,dryRun:false}),'REVISION_CONFLICT');assert.ok(stale);
  }finally{await client.close();await host.stop();}
},{neutralSetup:true}));

test('命令取消/竞态/恢复：不发送已取消编辑，不猜新版本，已编辑但取消计算保留可恢复草稿',async()=>withHostFixture(async({context})=>{
  let host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
  try{
    const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
    const args={posePath:'a.pose.json',expectedRevision:opened.version,patch:{frame:{head:5}},dryRun:false};
    const cancelled=new AbortController();cancelled.abort();await assert.rejects(client.poseCommand('spine_adjust_pose',args,cancelled.signal),{code:'TASK_CANCELLED'});assert.equal(host.store.active!.version.revision,0);
    const duringProbe=new AbortController(),probe=client.ensurePreview.bind(client);let probes=0;
    client.ensurePreview=async(...request:Parameters<HostClient['ensurePreview']>)=>{const result=await probe(...request);if(++probes===2)duringProbe.abort();return result;};
    await assert.rejects(client.poseCommand('spine_adjust_pose',args,duringProbe.signal),{code:'TASK_CANCELLED'});assert.equal(host.store.active!.version.revision,0);client.ensurePreview=probe;
    const calculating=new AbortController();await assert.rejects(client.poseCommand('spine_adjust_pose',args,calculating.signal,()=>calculating.abort()),{code:'TASK_CANCELLED'});
    assert.equal(host.store.active!.version.revision,1);assert.equal(host.store.active!.value.frame.head,5);assert.equal(host.store.active!.derived,null);
    assert.equal((await host.store.state()).evaluationTasks.active.length,0);
    await host.stop();host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'});client=new HostClient(context);
    const restored=await client.open({path:'a.pose.json'});assert.equal(host.store.active!.value.frame.head,5);assert.equal(host.store.active!.undo.length,1);
    await client.rpc('/api/pin',{expectedRevision:restored.version});
    const originalPatch=client.patch.bind(client);client.patch=async(...request:Parameters<HostClient['patch']>)=>{await host.store.open({path:'b.pose.json',expectedRevision:host.store.active!.version});return originalPatch(...request);};
    await assert.rejects(client.poseCommand('spine_set_pose_channel',{posePath:'a.pose.json',expectedRevision:restored.version,name:'torso',rotate:9,dryRun:false}),{code:'REVISION_CONFLICT'});
    assert.equal(host.store.active!.path,'b.pose.json');assert.equal(host.store.active!.version.revision,0);
  }finally{await host.stop();}
},{neutralSetup:true}));

test('detached 保留新路径语义且不吞 Host 版本；C1 attached 不扩大旧工具权限',async()=>withHostFixture(async({root,context})=>{
  let client=await mcp(root);
  const call=(name:string,args:any)=>client.callTool({name,arguments:{projectId:context.projectId,...args}});
  try{
    const old=decode(await call('spine_set_pose_channel',{posePath:'a.pose.json',outputPosePath:'detached.pose.json',name:'torso',rotate:3}));assert.equal(old.pose.frame.channels.torso.rotate,3);
    failure(await call('spine_set_pose_channel',{posePath:'a.pose.json',expectedRevision:{sessionId:'fake',documentId:'fake',openEpoch:'fake',revision:0},name:'torso',rotate:3}),'WRITE_FORBIDDEN');
    failure(await call('spine_adjust_pose',{posePath:'a.pose.json',patch:{frame:{head:1}}}));
  }finally{await client.close();}
  const host=await startHostServer(context,{writeEnabled:true});client=await mcp(root);
  try{
    const opened=decode(await call('spine_host_open',{path:'a.pose.json'}));decode(await call('spine_host_pin',{expectedRevision:opened.version}));
    assert.ok(opened.capabilities.editing.commandAdapters.every((item:any)=>!item.supported));
    const before=objectHash(host.store.active);
    for(const [name,args] of [['spine_set_pose_target',{role:'leftHand',angle:0}],['spine_set_pose_channel',{name:'torso',rotate:1}],['spine_batch_pose_ops',{ops:[{op:'channel',name:'torso',rotate:1}]}],['spine_adjust_pose',{patch:{frame:{head:1}}}]] as [string,any][]){failure(await call(name,{posePath:'a.pose.json',expectedRevision:opened.version,dryRun:false,...args}),'WRITE_FORBIDDEN');assert.equal(objectHash(host.store.active),before);}
  }finally{await client.close();await host.stop();}
}));

test('motion poseWorkflow 的失败返回必须阻止发布，不能把 await 当作审批通过',async()=>withHostFixture(async({root,context,manifest})=>{
  const pose=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8'));
  const motion={version:2,name:'gated',duration:1,loop:false,coordinateSystem:'normalizedSkeleton',groundY:0,frames:[{...pose.frame,time:0},{...pose.frame,time:1}],poseWorkflow:{standardPosePath:'a.pose.json',keyPoses:[]}};
  await writeFile(path.join(root,'gated.motion.json'),JSON.stringify(motion));manifest.documents.push({path:'gated.motion.json',kind:'motion',characterId:'hero',standardPosePath:'a.pose.json'});
  await writeFile(path.join(root,'.spine-workflow.json'),JSON.stringify(manifest));
  const host=await startHostServer(context,{developmentProfile:'c2-pose'}),client=new HostClient(context);
  try{
    const opened=await client.open({path:'gated.motion.json',animation:'gated',time:.5});
    await assert.rejects(client.evaluate(opened.version),{code:'COMMIT_NOT_AUTHORIZED'});assert.equal(host.store.active!.derived,null);
    assert.equal((await host.store.state()).evaluationTasks.recent.at(-1).status,'failed');
    await assert.rejects(readFile(path.join(root,'.spine-mcp/live')),{code:'ENOENT'});
  }finally{await host.stop();}
},{neutralSetup:true}));
