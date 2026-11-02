import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { callCreationTool } from '../src/creationTasks.js';
import { creationQuality, summarizeState } from '../src/creationQuality.js';
import { strictHash } from '../src/hostContracts.js';

const decode=(r:any)=>{assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
// 每次 MCP 调用会独立刷新连接握手（含瞬时原子文件）；预演核对任务和资产树，不误把握手当任务写入。
const taskTree=async(root:string)=>(await readdir(root,{recursive:true})).filter(p=>!/^\.spine-mcp\/connections(?:\/|$)/.test(p.replace(/\\/g,'/')));
test('创作任务：真实 stdio 冻结、选择、预演/修改、图、撤销、保存重开与计量；原输入不变',async()=>withHostFixture(async({root,context})=>{
  const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'});
  const client=new Client({name:'creation-workflow-protocol-test',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}as Record<string,string>}));
    const call=async(name:string,args:any)=>client.callTool({name,arguments:args});
    const inputs=await Promise.all(['body.json','body.png','body.atlas','mapping.json','a.pose.json'].map(async p=>[p,strictHash(await readFile(path.join(root,p)))]));
    decode(await call('spine_preview_state',{}));
    const before=await taskTree(root);
    const taskArgs={characterId:'hero',referencePath:'body.png',stages:[{stageId:'ready',documentPath:'a.pose.json'}]};
    const dry=decode(await call('spine_start_creation_task',taskArgs));assert.equal(dry.dryRun,true);assert.deepEqual(await taskTree(root),before);
    const started=decode(await call('spine_start_creation_task',{...taskArgs,dryRun:false}));assert.ok(started.taskId);
    const selectDry=decode(await call('spine_select_creation_stage',{taskId:started.taskId,stageId:'ready'}));assert.equal(selectDry.dryRun,true);assert.equal(host.store.active,null);
    const selected=decode(await call('spine_select_creation_stage',{taskId:started.taskId,stageId:'ready',dryRun:false}));assert.ok(selected.version);
    decode(await call('spine_host_pin',{expectedRevision:selected.version}));
    const baseline=await call('spine_preview_frame',{expectedRevision:selected.version});
    const ops=[{op:'setPoseParameters',path:'pose/frame/body',patch:{rotate:1}}];
    const trial=decode(await call('spine_host_patch',{expectedRevision:selected.version,ops}));assert.equal(trial.dryRun,true);assert.equal(host.store.active!.version.revision,0);
    const changedRaw=await call('spine_host_patch',{expectedRevision:selected.version,ops,dryRun:false}),changed=decode(changedRaw);
    assert.ok((changedRaw.content as any[]).some(c=>c.type==='image'));assert.deepEqual(changed.state.version,changed.version);assert.equal(changed.state.numeric.visual,undefined);
    const previousRaw=await call('spine_preview_frame',{expectedRevision:changed.version,variant:'previous'}),previous=decode(previousRaw);assert.equal(previous.advisory,true);assert.equal(previous.evidenceEligible,false);assert.deepEqual(previous.version,selected.version);assert.deepEqual(previous.currentVersion,changed.version);assert.equal((previousRaw.content as any[]).find(c=>c.type==='image').data,(baseline.content as any[]).find(c=>c.type==='image').data);
    const undone=decode(await call('spine_host_undo',{expectedRevision:changed.version,dryRun:false}));assert.equal(host.store.active!.value.frame.body.rotate,0);
    const saved=decode(await call('spine_host_commit',{expectedRevision:undone.version,outputPath:'creation-saved.pose.json',requestId:'creation-saved',dryRun:false}));assert.ok(saved.backupPath);
    const reopened=decode(await call('spine_host_open',{path:'creation-saved.pose.json',expectedRevision:saved.version,recheck:true}));
    assert.equal(reopened.state.numeric.visual,undefined,'打开回执同时含顶层状态与嵌套状态时也必须摘要');
    assert.equal(reopened.state.numeric.visualNodes,undefined);
    const info=decode(await call('spine_get_creation_task',{taskId:started.taskId}));assert.equal(info.freshness.current,true);assert.ok(info.metrics.calls>=8);assert.equal(info.metrics.tokens,null);assert.ok(info.metrics.images>=2);assert.equal(info.state.activeDoc.path,'creation-saved.pose.json');
    assert.equal(info.stageContexts[0].candidates.find((v:any)=>v.documentPath==='creation-saved.pose.json').verified,true);
    assert.equal(info.currentStageId,'ready');assert.equal(info.nextAction.tool,'spine_preview_state');
    const selectedSaved=decode(await call('spine_select_creation_stage',{taskId:started.taskId,stageId:'ready',documentPath:'creation-saved.pose.json',expectedRevision:reopened.version,dryRun:false}));assert.equal(selectedSaved.state.activeDoc.path,'creation-saved.pose.json');
    const otherFamily=await call('spine_select_creation_stage',{taskId:started.taskId,stageId:'ready',documentPath:'b.pose.json',expectedRevision:selectedSaved.version});assert.equal(otherFamily.isError,true);
    const savedBytes=await readFile(path.join(root,'creation-saved.pose.json'));await writeFile(path.join(root,'creation-saved.pose.json'),Buffer.concat([savedBytes,Buffer.from(' ')]));
    const tampered=await call('spine_select_creation_stage',{taskId:started.taskId,stageId:'ready',documentPath:'creation-saved.pose.json',expectedRevision:selectedSaved.version});assert.equal(tampered.isError,true);await writeFile(path.join(root,'creation-saved.pose.json'),savedBytes);
    const savedCopy=decode(await call('spine_start_creation_task',{...taskArgs,stages:[{stageId:'ready',documentPath:'creation-saved.pose.json'}],isolatedDirectory:'isolated/saved-revision',dryRun:false}));
    const clonedManifest=JSON.parse(await readFile(path.join(savedCopy.taskContext.workspaceRoot,'.spine-workflow.json'),'utf8'));assert.ok(clonedManifest.documents.some((d:any)=>d.path==='creation-saved.pose.json'));
    assert.ok(!(await readdir(path.join(savedCopy.taskContext.workspaceRoot,'.spine-mcp'))).includes('journals'));
    const full=decode(await call('spine_preview_state',{responseDetail:'full'})),brief=decode(await call('spine_preview_state',{}));assert.deepEqual(full.version,brief.version);assert.equal(brief.capabilities.characters,undefined);assert.ok(full.capabilities.characters);
    for(const[p,hash]of inputs)assert.equal(strictHash(await readFile(path.join(root,p))),hash);
    const stale=await call('spine_select_creation_stage',{taskId:started.taskId,stageId:'ready',expectedRevision:selected.version,dryRun:false});assert.equal(stale.isError,true);
    await writeFile(path.join(root,'body.png'),'changed reference');const staleTask=decode(await call('spine_get_creation_task',{taskId:started.taskId}));assert.equal(staleTask.freshness.current,false);
  }finally{await client.close();await host.stop();}
},{neutralSetup:true}));

test('创作质量：必要失败完整保留；固定支撑不建议 contact，未知点不生成可执行修正',()=>{
  const state={version:{sessionId:'s',documentId:'d',openEpoch:'o',revision:1},writeMode:'attached',numeric:{ok:true,visual:{vertices:[1,2,3]}},reference:{ok:false,metrics:[{id:'leg.left.support',required:true,status:'fail'},{id:'head.direction',required:true,status:'unverifiable'}]},capabilities:{operations:[{operation:'patch',canRun:true}]}};
  const quality=creationQuality(state);assert.equal(quality.failureCount,2);assert.equal(quality.canContinueEditing,true);assert.equal(quality.canReview,false);assert.equal(quality.failures[0].knob,null);assert.equal(quality.failures[1].nextAction,null);
  const summary=summarizeState(state);assert.equal(summary.numeric.visual,undefined);assert.deepEqual(summary.version,state.version);assert.equal(summary.reference.failures.length,2);
});

test('创作任务拒绝跨角色、重复阶段、越界参考与伪造任务路径',async()=>withHostFixture(async({context})=>{
  const args={characterId:'hero',referencePath:'body.png',stages:[{stageId:'ready',documentPath:'a.pose.json'}]};
  await assert.rejects(callCreationTool('spine_start_creation_task',{...args,characterId:'missing'},context),/角色/);
  await assert.rejects(callCreationTool('spine_start_creation_task',{...args,stages:[...args.stages,...args.stages]},context),/重复/);
  await assert.rejects(callCreationTool('spine_start_creation_task',{...args,referencePath:'../outside.png'},context));
  await assert.rejects(callCreationTool('spine_get_creation_task',{taskId:'../../escape'},context),/taskId/);
}));

test('真实 MCP：只提供原参考即可建立准备任务，不需要已有目标姿态，不隐式启动 Host',async()=>withHostFixture(async({root,context})=>{
  const client=new Client({name:'reference-preparation',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}as Record<string,string>}));
    const call=async(name:string,args:any)=>client.callTool({name,arguments:{projectId:context.projectId,...args}});
    decode(await call('spine_preview_state',{}));
    const before=await taskTree(root);
    const dry=decode(await call('spine_start_creation_task',{characterId:'hero',referencePath:'body.png'}));assert.equal(dry.candidate.phase,'referencePreparation');assert.deepEqual(dry.candidate.stages,[]);assert.deepEqual(await taskTree(root),before);
    const task=decode(await call('spine_start_creation_task',{characterId:'hero',referencePath:'body.png',dryRun:false}));assert.equal(task.phase,'referencePreparation');assert.equal(task.nextAction.tool,'spine_analyze_reference_gif');
    const info=decode(await call('spine_get_creation_task',{taskId:task.taskId}));assert.equal(info.freshness.current,true);assert.deepEqual(info.stageContexts,[]);assert.equal(info.state.available,false);
    await assert.rejects(readFile(path.join(root,'.spine-mcp/host-port.json')),(e:any)=>e.code==='ENOENT');
    const missing=await call('spine_select_creation_stage',{taskId:task.taskId,stageId:'invented',dryRun:false});assert.equal(missing.isError,true);
    const definitions=(await client.listTools()).tools;assert.ok(definitions.some(t=>t.name==='spine_create_pose_sequence'));assert.equal(definitions.find(t=>t.name==='spine_create_pose_sequence')!.inputSchema.additionalProperties,false);
    const invalid=await call('spine_create_pose_sequence',{sequencePath:'bad.json',stages:[]});assert.equal(invalid.isError,true);
  }finally{await client.close();}
}));

test('正式隔离准备：依赖完整复制、独立工程 ID、不带旧 journal；预演零落盘且拒绝覆盖',async()=>withHostFixture(async({root,context})=>{
  await mkdir(path.join(root,'.spine-mcp/journals'),{recursive:true});await writeFile(path.join(root,'.spine-mcp/journals','old.jsonl'),'旧观察记录，不应复制');
  const args={characterId:'hero',referencePath:'body.png',stages:[{stageId:'ready',documentPath:'a.pose.json'}],isolatedDirectory:'isolated/new-trial'};
  const before=await readdir(root,{recursive:true}),dry=await callCreationTool('spine_start_creation_task',args,context);assert.equal(dry.dryRun,true);assert.deepEqual(await readdir(root,{recursive:true}),before);
  const result=await callCreationTool('spine_start_creation_task',{...args,dryRun:false},context),next=result.taskContext;
  assert.notEqual(next.projectId,context.projectId);assert.equal(result.isolation.journalCopied,false);assert.deepEqual(await readFile(path.join(next.workspaceRoot,'body.json')),await readFile(path.join(root,'body.json')));
  assert.ok(!(await readdir(path.join(next.workspaceRoot,'.spine-mcp'))).includes('journals'));
  assert.equal(JSON.parse(await readFile(path.join(next.workspaceRoot,'.spine-workflow.json'),'utf8')).projectId,next.projectId);
  await assert.rejects(callCreationTool('spine_start_creation_task',{...args,dryRun:false},context),/已存在/);
  await assert.rejects(callCreationTool('spine_start_creation_task',{...args,isolatedDirectory:'../outside'},context),/隔离目录/);
}));
