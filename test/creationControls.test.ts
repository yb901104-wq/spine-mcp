import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { HostClient } from '../src/hostClient.js';
import { callCreationControl } from '../src/creationControls.js';
import { objectHash } from '../src/hostContracts.js';
import { compareGraphs, normalizeImagePoints, comparisonPolicy } from '../src/poseGraph.js';
import { referenceFeasibility } from '../src/referenceFeasibility.js';

test('新阶段诊断不扩张 C1，也不允许页面会话 token 调用控制端点',async()=>withHostFixture(async({root,context})=>{
  const host=await startHostServer(context,{writeEnabled:true}),client=new HostClient(context);
  try{
    const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});const source=await readFile(path.join(root,'a.pose.json'));
    await assert.rejects(client.rpc('/api/diagnostic-open',{expectedRevision:opened.version,snapshotHash:opened.snapshotHash,outputPath:'blocked.json',document:{},dependencies:[],dryRun:false},true),{code:'CAPABILITY_MISSING'});
    await assert.rejects(client.resumeDiagnostic({diagnosticId:'a'.repeat(64),expectedRevision:opened.version,dryRun:false}),{code:'WRITE_FORBIDDEN'});
    const port=JSON.parse(await readFile(path.join(root,'.spine-mcp/host-port.json'),'utf8'));
    for(const endpoint of ['/api/diagnostic-open','/api/diagnostic-resume']){const r=await fetch(host.endpoint+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Spine-Host-Token':port.token,Origin:host.endpoint},body:'{}'});assert.equal(r.status,403);assert.equal((await r.json()).code,'CONTROL_REQUIRED');}
    assert.deepEqual(await readFile(path.join(root,'a.pose.json')),source);
  }finally{await host.stop();}
}));

test('真实 MCP detached 不把 newStage 或恢复请求降级为磁盘姿态写入',async()=>withHostFixture(async({root})=>{
  const client=new Client({name:'diagnostic-detached-boundary',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}as Record<string,string>}));
    const rejected=await client.callTool({name:'spine_retarget_reference_pose',arguments:{referencePosePath:'missing.reference.json',visualRigPath:'missing.rig.json',standardPosePath:'a.pose.json',posePath:'not-written.json',diagnosticMode:'newStage',dryRun:false}});assert.equal(rejected.isError,true);assert.equal(JSON.parse(rejected.content[0].text as string).code,'WRITE_FORBIDDEN');
    const restore=await client.callTool({name:'spine_resume_diagnostic_pose',arguments:{diagnosticId:'a'.repeat(64),dryRun:false}});assert.equal(restore.isError,true);assert.equal(JSON.parse(restore.content[0].text as string).code,'HOST_UNAVAILABLE');
    await assert.rejects(readFile(path.join(root,'not-written.json')),(e:any)=>e.code==='ENOENT');
  }finally{await client.close();}
}));

test('任务工具目录：真实 stdio 动态发现/通知/调用一致；核心常驻且不扩张写权限',async()=>withHostFixture(async({root})=>{
  const client=new Client({name:'creation-dynamic-test',version:'1'});let notifications=0;
  client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{notifications++;});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0',SPINE_MCP_TOOL_DISCOVERY:'dynamic'}as Record<string,string>}));
    const first=await client.listTools();assert.ok(first.tools.some(t=>t.name==='spine_start_creation_task'));assert.ok(!first.tools.some(t=>t.name==='spine_set_bone_keyframe'));
    const hidden=await client.callTool({name:'spine_set_bone_keyframe',arguments:{}});assert.equal(hidden.isError,true);
    const preparation=await client.callTool({name:'spine_start_creation_task',arguments:{characterId:'hero',referencePath:'body.png',dryRun:false}});const task=JSON.parse(preparation.content[0].text as string);assert.equal(task.nextAction.tool,'spine_get_tool_catalog');assert.equal(task.nextAction.arguments.group,'reference');
    const select=await client.callTool({name:'spine_set_tool_groups',arguments:{groups:['animation']}});assert.equal(select.isError,undefined);assert.equal(notifications,0);
    await client.callTool({name:'spine_set_tool_groups',arguments:{groups:['animation'],dryRun:false}});
    const expanded=await client.listTools();assert.ok(expanded.tools.some(t=>t.name==='spine_set_bone_keyframe'));assert.ok(notifications>=1);
    const invalid=await client.callTool({name:'spine_set_tool_groups',arguments:{groups:['not-a-group'],dryRun:false}});assert.equal(invalid.isError,true);
    const catalog=await client.callTool({name:'spine_get_tool_catalog',arguments:{group:'animation'}});assert.match(JSON.stringify(catalog),/spine_set_bone_keyframe/);
  }finally{await client.close();}
}));

test('比较策略 v4：腕位/站距/握距统一躯干归一，不用自身臂腿长度吸收比例差异',()=>{
  const points:any={head:{x:0,y:-20},face:{x:10,y:-20},body:{x:0,y:50},leftShoulder:{x:-10,y:0},rightShoulder:{x:10,y:0},leftElbow:{x:-10,y:30},rightElbow:{x:10,y:30},leftWrist:{x:-10,y:60},rightWrist:{x:10,y:60},leftHip:{x:-10,y:100},rightHip:{x:10,y:100},leftKnee:{x:-10,y:140},rightKnee:{x:10,y:140},leftAnkle:{x:-10,y:180},rightAnkle:{x:10,y:180}};
  const reference={facing:'right',points,grip:{points:{left:points.leftWrist,right:points.rightWrist}}},target:any={facing:'right',points:normalizeImagePoints(points,'right')};
  for(const side of ['left','right']){target.points[side+'Elbow'].y=-60;target.points[side+'Wrist'].y=-120;target.points[side+'Knee'].y=-180;target.points[side+'Ankle'].y=-260;}
  target.grip={points:{left:target.points.leftWrist,right:target.points.rightWrist}};
  const correspondence={left:'left',right:'right',basis:'机械验证',anatomicalIdentity:'同侧',projectedOrder:'固定'},result=compareGraphs(reference,target,correspondence),metric=(id:string)=>result.metrics.find((m:any)=>m.id===id);
  assert.equal(comparisonPolicy.version,4);assert.ok(Math.abs(metric('leftArm.wrist').error-.6)<1e-8);assert.equal(metric('leftArm.wrist').status,'fail');assert.equal(metric('stance.width').error,0);assert.equal(metric('grip.spacing').error,0);
  delete target.points.leftHip;delete target.points.rightHip;const unknown=compareGraphs(reference,target,correspondence);assert.equal(unknown.metrics.find((m:any)=>m.id==='leftArm.wrist').status,'unverifiable');
});

test('参考预检：固定段长下肘角/伸展冲突在迭代前给出区间；重叠/未知/透视不冒充无解证明',()=>{
  const comparison={metrics:[{id:'arm.left.wristReach',reference:.3},{id:'leftArm.flexion',reference:0}]};
  const conflict=referenceFeasibility(comparison,{leftArm:[100,100]},100);assert.equal(conflict.checks[0].status,'conditionalConflict');assert.equal(conflict.globalUnsolvable,false);assert.equal(conflict.advisory,true);
  comparison.metrics[0].reference=2;assert.equal(referenceFeasibility(comparison,{leftArm:[100,100]},100).checks[0].status,'intervalsOverlap');
  assert.equal(referenceFeasibility(comparison,{leftArm:[100,100]},0).checks[0].status,'unknown');assert.equal(referenceFeasibility(comparison,{leftArm:[100,100]},100,true).checks[0].status,'unknown');
});

test('角色准备/一次预检/语义批次共用内存和求解器，缺视觉锚点拒绝；身份支撑不变',async()=>withHostFixture(async({root,context})=>{
  const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
  try{
    const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
    const original=await readFile(path.join(root,'body.json')),frame=objectHash(host.store.active!.value.frame);
    const prep=await callCreationControl('spine_inspect_character_preparation',{expectedRevision:opened.version},context);assert.equal(prep.visualRig.reviewed,false);assert.equal(prep.approved,false);assert.ok(prep.missing.length);
    const priorDerived=objectHash(host.store.active!.derived),check=await callCreationControl('spine_precheck_pose',{expectedRevision:opened.version},context);assert.equal(check.referenceIterations,0);assert.equal(check.globalUnsolvable,false);assert.equal(objectHash(host.store.active!.derived),priorDerived);
    const dry=await callCreationControl('spine_adjust_pose_intent',{expectedRevision:opened.version,bodyTilt:2,headTilt:3},context);assert.equal(dry.dryRun,true);assert.equal(objectHash(host.store.active!.value.frame),frame);
    await assert.rejects(callCreationControl('spine_adjust_pose_intent',{expectedRevision:opened.version,targets:[{role:'leftHand',lateral:.2,height:.6}]},context),/视觉锚点/);
    const changed=await callCreationControl('spine_adjust_pose_intent',{expectedRevision:opened.version,bodyTilt:2,headTilt:3,dryRun:false},context);assert.ok(changed.__imageData);assert.equal(host.store.active!.value.frame.body.rotate,2);assert.equal(host.store.active!.value.frame.targets.leftFoot.contact,true);
    await assert.rejects(callCreationControl('spine_adjust_pose_intent',{expectedRevision:opened.version,headTilt:1,dryRun:false},context),{code:'REVISION_CONFLICT'});
    assert.deepEqual(await readFile(path.join(root,'body.json')),original);
  }finally{await host.stop();}
},{neutralSetup:true}));

test('内存诊断修正：同绑定结构合法可编辑/撤销，改支撑或绑定拒绝，失败参考不给保存令牌',async()=>withHostFixture(async({context})=>{
  const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
  try{
    const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
    const before=await host.store.snapshot(opened.version),document=structuredClone(before.document);document.frame.body.rotate=2;
    const args={expectedRevision:opened.version,snapshotHash:before.snapshotHash,document};const dry=await host.store.adoptDiagnostic(args);assert.equal(dry.adopted,false);
    const broken=structuredClone(args);broken.document.frame.targets.leftFoot.contact=false;await assert.rejects(host.store.adoptDiagnostic({...broken,dryRun:false}),/恢复|固定|支撑|白名单/);
    await assert.rejects(host.store.adoptDiagnostic({...args,document:{...document,referencePosePath:'fake.json'},dryRun:false}),/绑定/);
    const adopted=await host.store.adoptDiagnostic({...args,dryRun:false});assert.equal(adopted.adopted,true);assert.equal(host.store.active!.value.frame.body.rotate,2);
    await client.history('undo',{expectedRevision:adopted.version,dryRun:false});assert.equal(host.store.active!.value.frame.body.rotate,0);
    // 直接布置内部失败状态以验证授权独立防线；不作为真实动作验收。
    host.store.active!.value.referencePosePath='missing.reference.json';
    await assert.rejects(host.store.commit({expectedRevision:host.store.active!.version,outputPath:'forbidden.pose.json'},true),/参考候选/);
  }finally{await host.stop();}
},{neutralSetup:true}));
