import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {withHostFixture} from './helpers/hostFixture.js';
import {startHostServer} from '../src/hostServer.js';
import {HostClient} from '../src/hostClient.js';
import {HostEditorStore} from '../src/hostEditorStore.js';
import {prepareHostAssetCandidate} from '../src/hostAssetCommands.js';
import {managedDocumentBinding} from '../src/hostAssetBinding.js';
import {readCommittedIndex} from '../src/hostJournal.js';
import {releaseWriter} from '../src/writerOwnership.js';
import {renderPoseComparison,reviewPose,poseChecks} from '../src/poseWorkflow.js';

const decode=(r:any)=>{assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
async function mcp(root:string){
 const client=new Client({name:'host-assets-test',version:'1'},{capabilities:{}});
 const env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>typeof e[1]==='string'));
 await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}}));return client;
}
const createArgs=(version:any)=>({expectedRevision:version,filePath:'body.json',mappingPath:'mapping.json',posePath:'created.pose.json',kind:'standing',id:'asset-test',frame:{time:0,body:{x:0,y:.05,rotate:0},head:0,channels:{},targets:{}}});
async function stage(store:HostEditorStore,context:any){
 const version=structuredClone(store.active!.version),snapshot=await store.snapshot(version);
 const prepared=await prepareHostAssetCandidate('spine_create_pose_draft',{...createArgs(version),dryRun:false},snapshot,context);
 return store.stageAsset(prepared);
}
async function authorize(store:HostEditorStore,staged:any){
 const args={expectedRevision:staged.version,outputPath:staged.outputPath,intent:'asset',assetCandidateHash:staged.candidateHash};
 const candidate=await store.commit(args,true),snapshot=await store.snapshot(staged.version);
 const authorization=await store.authorize({...args,candidateHash:candidate.candidateHash,snapshotHash:snapshot.snapshotHash,derivedHash:snapshot.derivedHash,reviewHash:snapshot.reviewHash,gateRecord:{gate:'asset-draft',passed:true,candidateHash:candidate.candidateHash}});
 return {...args,dryRun:false,requestId:'asset-request',authorizationId:authorization.authorizationId};
}

test('C2 新姿态实际 stdio：默认零落盘、暂存/精确提交/备份/幂等/重开，来源编辑保留',async()=>withHostFixture(async({root,context})=>{
 const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=await mcp(root);
 const call=(name:string,args:any)=>client.callTool({name,arguments:{projectId:context.projectId,...args}});
 try{
  const tools=await client.listTools();assert.ok(tools.tools.length>=102);assert.ok(tools.tools.find(t=>t.name==='spine_create_pose_draft')!.inputSchema.properties!.expectedRevision);
  const opened=decode(await call('spine_host_open',{path:'a.pose.json'}));decode(await call('spine_host_pin',{expectedRevision:opened.version}));
  const inputs=await Promise.all(['a.pose.json','body.json','.spine-workflow.json'].map(p=>readFile(path.join(root,p))));
  const args=createArgs(opened.version),files=await readdir(root,{recursive:true});
  const dry=decode(await call('spine_create_pose_draft',args));assert.equal(dry.staged,false);assert.deepEqual(await readdir(root,{recursive:true}),files);assert.equal((await host.store.state()).assetCandidate,null);
  const staged=decode(await call('spine_create_pose_draft',{...args,dryRun:false}));assert.equal(staged.persisted,false);assert.equal(staged.staged,true);
  await assert.rejects(readFile(path.join(root,args.posePath)),{code:'ENOENT'});
  const save={expectedRevision:opened.version,outputPath:staged.outputPath,intent:'asset',assetCandidateHash:staged.candidateHash,requestId:'stdio-asset',dryRun:false};
  const wrong=await call('spine_host_commit',{...save,assetCandidateHash:'bad'});assert.equal(wrong.isError,true);
  const receipt=decode(await call('spine_host_commit',save));assert.equal(receipt.switched,false);assert.deepEqual(receipt.version,opened.version);assert.ok(receipt.backupPath);
  assert.equal(host.store.active!.path,'a.pose.json');assert.equal(decode(await call('spine_host_commit',save)).replayed,true);
  for(const[i,p]of ['a.pose.json','body.json','.spine-workflow.json'].entries())assert.deepEqual(await readFile(path.join(root,p)),inputs[i]);
  assert.deepEqual(await readFile(path.join(root,receipt.backupPath)),inputs[0]);
  const created=decode(await call('spine_host_open',{path:args.posePath,expectedRevision:opened.version}));assert.equal(created.activeDoc.characterId,'hero');assert.equal(created.activeDoc.kind,'pose');
  assert.equal(JSON.parse(await readFile(path.join(root,args.posePath),'utf8')).status,'draft');
 }finally{await client.close();await host.stop();}
},{neutralSetup:true}));

test('C2 pose→motion 登记与只读回放：共用姿态门禁、角色来源、原子保存后重开',async()=>withHostFixture(async({root,context})=>{
 const sheet=await renderPoseComparison({posePaths:['a.pose.json']},context);
 await reviewPose({posePath:'a.pose.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'机械协议桩',reason:'只验证资产事务，不代表真实美术批准',checks:poseChecks,dryRun:false},context);
 const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
 try{
  const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
  const args={expectedRevision:opened.version,standardPosePath:'a.pose.json',keyPoses:[{posePath:'a.pose.json',time:0,stageId:'start'},{posePath:'a.pose.json',time:.3,stageId:'end'}],motionPath:'new.motion.json',name:'idle',duration:.3,loop:true,dryRun:false};
  const staged=await client.assetCommand('spine_build_motion_from_poses',args);
  const saved=await client.commit({expectedRevision:opened.version,outputPath:args.motionPath,intent:'asset',assetCandidateHash:staged.candidateHash,requestId:'motion-asset',dryRun:false});assert.equal(saved.switched,false);
  const index=await readCommittedIndex(context),binding=managedDocumentBinding(args.motionPath,host.store.project!.mode==='managed'?host.store.project!.manifest:null as never,index,context);assert.equal(binding.kind,'motion');assert.equal(binding.standardPosePath,'a.pose.json');
  const motion=await client.open({path:args.motionPath,expectedRevision:opened.version,animation:'idle',time:.1,recheck:true});assert.equal(motion.activeDoc.kind,'motion');assert.ok(host.store.active!.derived.live.hash);
  const bytes=await readFile(path.join(root,args.motionPath));await writeFile(path.join(root,args.motionPath),Buffer.concat([bytes,Buffer.from(' ')]));
  await assert.rejects(client.open({path:args.motionPath,reload:true,expectedRevision:host.store.active!.version}),{code:'PROJECT_BINDING_CONFLICT'});
 }finally{await host.stop();}
},{neutralSetup:true}));

test('C2 skeleton 明确资产来源 pin：创建首个站姿，普通 pin/源修改仍拒绝',async()=>withHostFixture(async({root,context})=>{
 const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
 try{
  const before=await readFile(path.join(root,'body.json')),opened=await client.open({path:'body.json'});
  assert.equal((await client.state()).capabilities.editing.assetDrafts.readiness.stage.canRun,false);
  await assert.rejects(client.rpc('/api/pin',{expectedRevision:opened.version}),{code:'CAPABILITY_MISSING'});
  await client.rpc('/api/pin',{expectedRevision:opened.version,intent:'asset'});
  const staged=await client.assetCommand('spine_create_pose_draft',{...createArgs(opened.version),dryRun:false});assert.equal(staged.staged,true);
  assert.equal((await client.state()).capabilities.editing.assetDrafts.readiness.commit.canRun,true);
  await assert.rejects(client.patch({expectedRevision:opened.version,ops:[{op:'setPoseParameters',path:'pose/frame/head',patch:{rotate:3}}],dryRun:false}),{code:'UNSUPPORTED_DOC_KIND'});
  await client.commit({expectedRevision:opened.version,outputPath:staged.outputPath,intent:'asset',assetCandidateHash:staged.candidateHash,requestId:'first-standing',dryRun:false});
  assert.deepEqual(await readFile(path.join(root,'body.json')),before);assert.equal(host.store.active!.kind,'skeleton');
  const pose=await client.open({path:staged.outputPath,expectedRevision:opened.version});assert.equal(pose.activeDoc.kind,'pose');assert.equal(pose.activeDoc.characterId,'hero');
 }finally{await host.stop();}
},{neutralSetup:true}));

test('C2 资产反例：C1/缺 pin/版本/依赖漂移/旧候选/路径/越权结构全部拒绝',async()=>withHostFixture(async({root,context})=>{
 const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
 try{
  const opened=await client.open({path:'a.pose.json'}),args={...createArgs(opened.version),dryRun:false};
  await assert.rejects(client.assetCommand('spine_create_pose_draft',args),{code:'TARGET_NOT_PINNED'});await client.rpc('/api/pin',{expectedRevision:opened.version});
  await assert.rejects(client.assetCommand('spine_create_pose_draft',{...args,expectedRevision:{...opened.version,revision:4}}),{code:'REVISION_CONFLICT'});
  for(const posePath of ['a.pose.json','.spine-mcp/no.json','output/reports/no.json','../escape.json'])await assert.rejects(client.assetCommand('spine_create_pose_draft',{...args,posePath}));
  const staged=await client.assetCommand('spine_create_pose_draft',args),snap=await host.store.snapshot(opened.version);
  const prepared=await prepareHostAssetCandidate('spine_create_pose_draft',args,snap,context),bad=structuredClone(prepared);bad.document.review={decision:'approved'};await assert.rejects(host.store.stageAsset(bad),{code:'PROJECT_BINDING_CONFLICT'});
  await assert.rejects(client.rpc('/api/asset-candidate',prepared),{code:'CONTROL_REQUIRED'});
  const atlas=await readFile(path.join(root,'body.atlas'));await writeFile(path.join(root,'body.atlas'),Buffer.concat([atlas,Buffer.from('\n')]));
  await assert.rejects(client.commit({expectedRevision:opened.version,outputPath:staged.outputPath,intent:'asset',assetCandidateHash:staged.candidateHash}),{code:'TARGET_STALE'});
  await writeFile(path.join(root,'body.atlas'),atlas);assert.equal((await host.store.state()).assetCandidate,null);
 }finally{await host.stop();}
 const c1=new HostEditorStore(context);await c1.enableWriting();try{await c1.open({path:'a.pose.json'});await c1.pin(c1.active!.version);await assert.rejects(stage(c1,context),{code:'CAPABILITY_MISSING'});}finally{await c1.shutdown();}
},{neutralSetup:true}));

test('资产事务故障与恢复：发布后不确定、日志裁决、重试幂等，不丢来源未提交编辑',async()=>withHostFixture(async({context})=>{
 const store=new HostEditorStore(context,'host','c2-pose');await store.enableWriting();let args:any;
 try{
  await store.open({path:'a.pose.json'});await store.pin(store.active!.version);
  await store.patch({expectedRevision:store.active!.version,ops:[{op:'setPoseParameters',path:'pose/frame/head',patch:{rotate:5}}],dryRun:false});
  const staged=await stage(store,context);args=await authorize(store,staged);
  store.fault=p=>{if(p==='afterPublish')throw Error('模拟发布后中断');};
  await assert.rejects(store.commit(args),{code:'WRITE_OWNERSHIP_UNCERTAIN'});assert.equal(store.frozen,true);
 }finally{if(store.writer)await releaseWriter(store.writer,context);}
 const recovered=new HostEditorStore(context,'host','c2-pose');await recovered.enableWriting();try{
  await recovered.open({path:'a.pose.json'});assert.equal(recovered.active!.value.frame.head,5);assert.equal(recovered.active!.undo.length,1);
  const receipt=await recovered.commit(args);assert.equal(receipt.replayed,true);assert.equal(receipt.switched,false);
  await recovered.open({path:'created.pose.json',expectedRevision:recovered.active!.version});assert.equal(recovered.active!.characterId,'hero');
 }finally{await recovered.shutdown();}
},{neutralSetup:true}));
