import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { installSimulatedHostPage } from './helpers/hostPage.js';
import { poseChecks,requireReviewedPose } from '../src/poseWorkflow.js';
import { prepareHostPoseReview } from '../src/hostPoseReview.js';
import { HostClient } from '../src/hostClient.js';
const decode=(response:any)=>{assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};
const env=()=>Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>typeof e[1]==='string'));
test('真实 MCP：无宿主镜像、完整版本、PNG 内容块与 rotate schema 可发现且可调用',async()=>withHostFixture(async({root,context})=>{
  const client=new Client({name:'host-mirror-test',version:'1'},{capabilities:{}});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env(),SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}}));
    const listed=await client.listTools(),channel=listed.tools.find(t=>t.name==='spine_set_pose_channel')!;
    assert.equal(listed.tools.length,101);
    assert.equal((channel.inputSchema.properties?.rotate as any).type,'number');
    for(const name of ['spine_create_project','spine_host_open','spine_host_pin','spine_host_patch','spine_host_commit','spine_host_undo','spine_host_redo','spine_preview_state','spine_preview_frame','spine_preview_capture'])assert.ok(listed.tools.some(t=>t.name===name),name);
    const adjusted=decode(await client.callTool({name:'spine_set_pose_channel',arguments:{projectId:context.projectId,posePath:'a.pose.json',outputPosePath:'channel.pose.json',name:'torso',rotate:12}}));assert.equal(adjusted.pose.frame.channels.torso.rotate,12);
    const opened=decode(await client.callTool({name:'spine_host_open',arguments:{projectId:context.projectId,path:'a.pose.json'}}));assert.equal(opened.mode,'mirror');assert.equal(opened.available,false);
    const frame=await client.callTool({name:'spine_preview_frame',arguments:{projectId:context.projectId,expectedRevision:opened.version,size:320}});assert.ok((frame.content as any[]).some(c=>c.type==='image'));assert.equal(decode(frame).source,'disk');
    const capture=decode(await client.callTool({name:'spine_preview_capture',arguments:{projectId:context.projectId,expectedRevision:opened.version}}));assert.equal(capture.available,false);assert.equal(capture.advisory,true);
  }finally{await client.close();}
}));
test('真实 MCP：隔离 attached patch→内存求解→图像→授权草稿提交与幂等回执',async()=>withHostFixture(async({root,context})=>{
  const host=await startHostServer(context,{writeEnabled:true}),client=new Client({name:'host-attached-test',version:'1'},{capabilities:{}});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env(),SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}}));
    const call=async(name:string,args:any)=>client.callTool({name,arguments:{projectId:context.projectId,...args}});
    const opened=decode(await call('spine_host_open',{path:'a.pose.json'}));assert.equal(opened.writeMode,'attached');
    decode(await call('spine_host_pin',{expectedRevision:opened.version}));
    const before=await readFile(path.join(root,'a.pose.json'));
    const edited=await call('spine_host_patch',{expectedRevision:opened.version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',x:.02}],dryRun:false});
    const actual=decode(edited);assert.equal(actual.version.revision,1);assert.ok((edited.content as any[]).some(c=>c.type==='image'));assert.deepEqual(await readFile(path.join(root,'a.pose.json')),before);
    const state=decode(await call('spine_get_pose_state',{posePath:'a.pose.json'}));assert.equal(state.version.revision,1);
    const unsupported=await call('spine_set_pose_channel',{posePath:'a.pose.json',outputPosePath:'forbidden.json',name:'torso',rotate:9,dryRun:false});assert.equal(unsupported.isError,true);assert.equal(JSON.parse((unsupported.content as any)[0].text).code,'WRITE_FORBIDDEN');
    const args={expectedRevision:actual.version,outputPath:'new.pose.json',dryRun:false,requestId:'actual-mcp-commit'};
    const committed=decode(await call('spine_host_commit',args));assert.equal(committed.committed,true);
    const repeated=decode(await call('spine_host_commit',args));assert.equal(repeated.replayed,true);assert.deepEqual(repeated.version,committed.version);
    assert.deepEqual(await readFile(path.join(root,'a.pose.json')),before);
  }finally{await client.close();await host.stop();}
}));

test('真实 MCP：附着审查默认预演、逐项批准、保存可复验；旧版本拒绝且新修改清批准',async()=>withHostFixture(async({root,context})=>{
  const host=await startHostServer(context,{writeEnabled:true,captureTimeoutMs:2000}),client=new Client({name:'host-review-test',version:'1'},{capabilities:{}});
  installSimulatedHostPage(host.capture,host.store);
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env(),SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}}));
    const call=async(name:string,args:any)=>client.callTool({name,arguments:{projectId:context.projectId,...args}});
    const schema=(await client.listTools()).tools.find(t=>t.name==='spine_review_pose')!.inputSchema;
    assert.equal(schema.additionalProperties,false);assert.ok(schema.properties?.expectedRevision);assert.equal(schema.properties?.outputPosePath,undefined);
    const opened=decode(await call('spine_host_open',{path:'a.pose.json'}));decode(await call('spine_host_pin',{expectedRevision:opened.version}));
    const source=await readFile(path.join(root,'a.pose.json'));
    const edited=decode(await call('spine_host_patch',{expectedRevision:opened.version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',x:.02}],dryRun:false}));
    assert.equal(edited.state.numeric.ok,true,JSON.stringify(edited.state.numeric.issues));
    const capture=decode(await call('spine_preview_capture',{expectedRevision:edited.version,size:320}));
    const readiness=decode(await call('spine_preview_state',{})).capabilities.operations.find((op:any)=>op.operation==='review');assert.equal(readiness.canRun,true);assert.equal(readiness.nextAction.tool,'spine_review_pose');
    const args={posePath:'a.pose.json',expectedRevision:edited.version,manifestPath:capture.manifestPath,decision:'approved',reviewedBy:'协议测试桩（非美术验收）',reason:'验证隔离测试审查流程',checks:poseChecks,checkResults:Object.fromEntries(poseChecks.map(k=>[k,{status:'pass',reason:k+' 独立机械用例断言；非真实视觉判断'}]))};
    const missing=await call('spine_review_pose',{...args,expectedRevision:undefined});assert.equal(missing.isError,true);assert.equal(JSON.parse((missing.content as any)[0].text).code,'REVISION_CONFLICT');
    const uniform=await call('spine_review_pose',{...args,checkResults:Object.fromEntries(poseChecks.map(k=>[k,{status:'pass',reason:'同一段笼统文本'}]))});assert.equal(uniform.isError,true);
    const before=JSON.stringify(await host.store.state(false)),files=await readdir(root,{recursive:true});
    const dry=decode(await call('spine_review_pose',args));assert.equal(dry.dryRun,true);assert.equal(JSON.stringify(await host.store.state(false)),before);assert.deepEqual(await readdir(root,{recursive:true}),files);
    const cancellation=new AbortController(),directClient=new HostClient(context);
    await assert.rejects(directClient.review({...args,dryRun:false},cancellation.signal,()=>cancellation.abort()),(e:any)=>e.code==='TASK_CANCELLED');
    assert.equal(JSON.stringify(await host.store.state(false)),before);assert.deepEqual(await readdir(root,{recursive:true}),files);
    const snapshot=await host.store.snapshot(edited.version),prepared=await prepareHostPoseReview(snapshot,args,context);
    const badEvidence=structuredClone(prepared);badEvidence.reviewRecord.record.evidence[0].hash='changed';await assert.rejects(host.store.registerReview(badEvidence),/持久审查证据哈希/);
    const badIssues=structuredClone(prepared);badIssues.reviewRecord.record.issues=['仍有问题'];await assert.rejects(host.store.registerReview(badIssues),/未解决问题/);
    const draft=await host.store.commit({expectedRevision:edited.version,outputPath:'reviewed.pose.json'},true);
    const oldAuthorization=await host.store.authorize({expectedRevision:edited.version,outputPath:'reviewed.pose.json',candidateHash:draft.candidateHash,snapshotHash:snapshot.snapshotHash,derivedHash:snapshot.derivedHash,reviewHash:null,gateRecord:{gate:'pose-draft',passed:true,candidateHash:draft.candidateHash}});
    const review=decode(await call('spine_review_pose',{...args,dryRun:false}));assert.equal(review.dryRun,false);assert.equal(host.store.active!.review.decision,'approved');
    await assert.rejects(host.store.commit({expectedRevision:edited.version,outputPath:'reviewed.pose.json',requestId:'obsolete-review-authorization',authorizationId:oldAuthorization.authorizationId,dryRun:false}),/授权/);
    const pngPath=path.join(root,capture.filePath),png=await readFile(pngPath);
    try{
      await writeFile(pngPath,'changed evidence after approval');
      assert.equal((await host.store.state()).agentVisual.status,'stale');
      await assert.rejects(host.store.commit({expectedRevision:edited.version,outputPath:'reviewed.pose.json'}),(e:any)=>e.code==='REVIEW_STALE');
    }finally{await writeFile(pngPath,png);}
    const saved=decode(await call('spine_host_commit',{expectedRevision:edited.version,outputPath:'reviewed.pose.json',requestId:'reviewed-pose',dryRun:false}));
    const confirmed=await requireReviewedPose('reviewed.pose.json',context);assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.review.poseFingerprint,review.review.poseFingerprint);
    assert.deepEqual(await readFile(path.join(root,'a.pose.json')),source);
    const stale=await call('spine_review_pose',{...args,dryRun:false});assert.equal(stale.isError,true);
    decode(await call('spine_host_pin',{expectedRevision:saved.version}));
    const changed=decode(await call('spine_host_patch',{expectedRevision:saved.version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',x:.03}],dryRun:false}));assert.equal(host.store.active!.review,null);
    const nextCapture=decode(await call('spine_preview_capture',{expectedRevision:changed.version,size:320}));
    decode(await call('spine_review_pose',{...args,posePath:'reviewed.pose.json',expectedRevision:changed.version,manifestPath:nextCapture.manifestPath,decision:'rejected',reason:'协议桩主动退回，保留问题',issues:['诊断退回'],dryRun:false}));
    decode(await call('spine_host_commit',{expectedRevision:changed.version,outputPath:'rejected.pose.json',requestId:'rejected-pose',dryRun:false}));
    const rejected=JSON.parse(await readFile(path.join(root,'rejected.pose.json'),'utf8'));assert.equal(rejected.status,'rejected');assert.equal(rejected.review.decision,'rejected');await assert.rejects(requireReviewedPose('rejected.pose.json',context),/未确认/);
  }finally{await client.close();await host.stop();}
},{neutralSetup:true}));
