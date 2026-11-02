import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {withHostFixture} from './helpers/hostFixture.js';
import {renderPoseComparison,reviewPose,poseChecks} from '../src/poseWorkflow.js';
import {startHostServer} from '../src/hostServer.js';
import {HostClient} from '../src/hostClient.js';
import {prepareHostAnimationCandidate} from '../src/hostAnimationCandidate.js';
import {prepareSemanticAnimationData} from '../src/retargetEngine.js';
import {auditGeneratedAnimationCandidate} from '../src/spineJson.js';
import {strictHash,objectHash} from '../src/hostContracts.js';
import {installSimulatedHostPage} from './helpers/hostPage.js';
import {assertAnimationReview} from '../src/animationReview.js';
import {fullAnimationChecks} from '../src/hostAnimationSession.js';
import {HostEditorStore} from '../src/hostEditorStore.js';
import {releaseWriter} from '../src/writerOwnership.js';
import {assertHostAnimationMapping} from '../src/hostAnimationMapping.js';

async function fixture(fn:(f:any)=>Promise<void>){return withHostFixture(async({root,context})=>{
 const sheet=await renderPoseComparison({posePaths:['a.pose.json']},context);
 await reviewPose({posePath:'a.pose.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'机械验证桩',reason:'验证协议与候选数值，不代表真实美术批准',checks:poseChecks,dryRun:false},context);
 const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
 try{
  const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
  const staged=await client.assetCommand('spine_build_motion_from_poses',{expectedRevision:opened.version,standardPosePath:'a.pose.json',keyPoses:[{posePath:'a.pose.json',time:0,stageId:'start'},{posePath:'a.pose.json',time:.3,stageId:'end'}],motionPath:'idle.motion.json',name:'idle',duration:.3,loop:true,dryRun:false});
  await client.commit({expectedRevision:opened.version,outputPath:staged.outputPath,intent:'asset',assetCandidateHash:staged.candidateHash,requestId:'candidate-motion',dryRun:false});
  const motion=await client.open({path:staged.outputPath,expectedRevision:opened.version,animation:'idle',time:.15,recheck:true});
  const args={projectId:context.projectId,expectedRevision:motion.version,filePath:'body.json',mappingPath:'mapping.json',motionPath:'idle.motion.json',animation:'idle'};
  await fn({root,context,host,client,args});
 }finally{await host.stop();}
},{neutralSetup:true});}
const decode=(response:any)=>{assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);};

test('C2 精确动画实际 stdio：当前 motion、原拟合/runtime 门禁、精确回放和完整字节报告，无源写入或提交授权',async()=>fixture(async({root,context,host,args})=>{
 const protocol=new Client({name:'host-animation-candidate-test',version:'1'},{capabilities:{}}),env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>typeof e[1]==='string'));
 await protocol.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}}));
 const paths=['body.json','mapping.json','mapping.json.calibration.json','a.pose.json','idle.motion.json','body.atlas','body.png','.spine-workflow.json'];
 // 校准报告路径由 mapping 显式声明，不猜产物名。
 const mapping=JSON.parse(await readFile(path.join(root,'mapping.json'),'utf8'));paths[2]=mapping.reportPath;
 const before=await Promise.all(paths.map(file=>readFile(path.join(root,file)))),version=structuredClone(host.store.active!.version);
 const dense=JSON.parse(await readFile(path.join(root,host.store.active!.derived.live.path),'utf8'));
 try{
  const tools=await protocol.listTools();assert.ok(tools.tools.length>=102);assert.ok(tools.tools.find(t=>t.name==='spine_retarget_motion')!.inputSchema.properties!.expectedRevision);
  const response=await protocol.callTool({name:'spine_retarget_motion',arguments:args}),result=decode(response);
  assert.equal(result.ok,true);assert.equal(result.numericOk,true);assert.equal(result.wroteFile,false);assert.match(result.reviewToken,/^[0-9a-f]{64}$/);assert.equal(result.readyToCommit,false);assert.equal(result.readyForAnimationReview,true);
  assert.ok((response.content as any[]).some(item=>item.type==='image'));assert.deepEqual(result.version,version);assert.equal(host.store.active!.derived.live.hash,result.candidateHash);
  const bytes=await readFile(path.join(root,result.candidatePath)),candidate=JSON.parse(bytes.toString());assert.equal(strictHash(bytes),result.candidateHash);
  const expected=await prepareSemanticAnimationData(JSON.parse(before[0].toString()),mapping,JSON.parse(before[4].toString()),args,context);assert.deepEqual(candidate,expected.candidate);
  assert.ok(dense.animations.idle.bones.body.rotate.length>candidate.animations.idle.bones.body.rotate.length);
  const reportBytes=await readFile(path.join(root,result.reportPath)),report=JSON.parse(reportBytes.toString());assert.equal(strictHash(reportBytes),result.reportHash);assert.equal(report.candidateHash,result.candidateHash);assert.equal(report.numeric.samples>=337,true);assert.equal(report.poseGate.ok,true);assert.equal(report.operationValidation.ok,true);assert.equal(report.authorizationGranted,false);
  assert.equal(result.state.numeric.status,'previewOnly');assert.equal(result.state.capabilities.editing.animationCandidates.sourceCommitSupported,true);
  for(let i=0;i<paths.length;i++)assert.deepEqual(await readFile(path.join(root,paths[i])),before[i]);
  const motion=JSON.parse(before[4].toString()),critical=structuredClone(motion.frames[0]),recover=structuredClone(motion.frames[0]);critical.time=.00001;critical.targets.leftHand.x=100;recover.time=.00002;motion.frames.splice(1,0,critical,recover);
  const failed=await prepareSemanticAnimationData(JSON.parse(before[0].toString()),mapping,motion,args,context);
  assert.equal(failed.ok,false);assert.ok(failed.validation.maxHandError>1000);assert.ok(Math.abs(failed.validation.worstHandTime-.00001)<1e-12,'runtime 必须回读短于均匀采样间隔的显式关键时刻');
 }finally{await protocol.close();}
}));

test('精确候选拒绝：旧版本、路径/名称/周期漂移、宽松门限、真实写入、版本绕过与校准漂移',async()=>fixture(async({root,context,host,args})=>{
 const snapshot=await host.store.snapshot(args.expectedRevision),before=objectHash(host.store.active),files=await readdir(root,{recursive:true});
 for(const change of [{expectedRevision:{...args.expectedRevision,revision:9}},{filePath:'other.json'},{motionPath:'a.pose.json'},{animation:'other'},{duration:1},{handTolerance:.35},{footContactTolerance:.01},{rotationTolerance:NaN},{dryRun:false},{reviewToken:'fake'},{allowUnsupportedVersion:true}]){
  await assert.rejects(prepareHostAnimationCandidate({...args,...change},snapshot,context));assert.equal(objectHash(host.store.active),before);assert.deepEqual(await readdir(root,{recursive:true}),files);
 }
 const sourcePath=path.join(root,'body.json'),source=await readFile(sourcePath);
 try{const changed=JSON.parse(source.toString());changed.skeleton.spine='4.1.25';await writeFile(sourcePath,JSON.stringify(changed));await assert.rejects(prepareHostAnimationCandidate(args,snapshot,context),{code:'UNSUPPORTED_VERSION'});}finally{await writeFile(sourcePath,source);}
 const mapping=JSON.parse(await readFile(path.join(root,'mapping.json'),'utf8')),reportPath=path.join(root,mapping.reportPath),report=await readFile(reportPath);
 try{await assert.rejects(prepareHostAnimationCandidate(args,snapshot,context,undefined,()=>{writeFileSync(reportPath,Buffer.concat([report,Buffer.from(' ')]));}),{code:'TARGET_DRIFT'});}finally{await writeFile(reportPath,report);}
}));

test('精确候选取消/跨 profile：取消前后不发布，C1 不扩权，失败诊断无动画令牌',async()=>fixture(async({context,host,client,args})=>{
 const before=objectHash(host.store.active),cancelled=new AbortController();cancelled.abort();
 await assert.rejects(client.animationCandidate(args,cancelled.signal),{code:'TASK_CANCELLED'});assert.equal(objectHash(host.store.active),before);
 const mid=new AbortController();await assert.rejects(client.animationCandidate(args,mid.signal,()=>mid.abort()),{code:'TASK_CANCELLED'});assert.equal(objectHash(host.store.active),before);
 const snapshot=await host.store.snapshot(args.expectedRevision);await assert.rejects(prepareHostAnimationCandidate(args,{...snapshot,viewProfile:'c1'},context),{code:'CAPABILITY_MISSING'});
 const diagnostic=await client.animationCandidate({...args,diagnosticPreview:true});assert.equal(diagnostic.ok,false);assert.equal(diagnostic.numericOk,true);assert.equal(diagnostic.reviewToken,undefined);assert.equal(diagnostic.readyToCommit,false);
}));

test('单动画审查复用官方规则：非目标结构/其它动画、隐式覆盖、版本和末帧 curve 拒绝',()=>{
 const source:any={skeleton:{spine:'4.1.24'},bones:[{name:'root'}],slots:[],skins:[],animations:{original:{}}},candidate=structuredClone(source);
 candidate.animations.idle={bones:{root:{rotate:[{time:0,value:0},{time:1,value:5}]}}};assert.equal(auditGeneratedAnimationCandidate(source,candidate,'idle').operationValidation.ok,true);
 for(const mutate of [(v:any)=>v.bones[0].x=2,(v:any)=>v.animations.original={bones:{}},(v:any)=>v.animations.idle.bones.root.rotate[1].curve=[.1,.2,.3,.4],(v:any)=>v.animations.idle.events=[],(v:any)=>v.animations.idle.deform={},(v:any)=>v.animations.idle.ik={},(v:any)=>v.animations.idle.bones.root.unsupported=[]]){const invalid=structuredClone(candidate);mutate(invalid);assert.throws(()=>auditGeneratedAnimationCandidate(source,invalid,'idle'));}
 const readonly=structuredClone(candidate);readonly.animations.idle.events=[];assert.throws(()=>auditGeneratedAnimationCandidate(readonly,candidate,'idle',true));
 assert.throws(()=>auditGeneratedAnimationCandidate(source,source,'original'));assert.throws(()=>auditGeneratedAnimationCandidate({...source,skeleton:{spine:'4.0.64'}},candidate,'idle'));assert.throws(()=>auditGeneratedAnimationCandidate(source,candidate,'__proto__'));
});

test('完整动画附着审查：原速 GIF 与模拟 player 协议证据、独立理由、预演零登记及持久审查；不是美术验收',async()=>fixture(async({root,context,host,client,args})=>{
 const candidate=await client.animationCandidate(args);assert.equal(candidate.readyForAnimationReview,true);
 installSimulatedHostPage(host.capture,host.store);const player=await client.capture({expectedRevision:args.expectedRevision,size:320});
 const reviewArgs={expectedRevision:args.expectedRevision,reviewToken:candidate.reviewToken,manifestPath:candidate.animationPreview.manifestPath,playerManifestPath:player.manifestPath,decision:'approved',reviewedBy:'动画审查机械桩',reason:'仅验证当前候选完整证据绑定，不代表真实美术批准',checks:fullAnimationChecks,checkResults:Object.fromEntries(fullAnimationChecks.map(k=>[k,{status:'pass',reason:k+' 合成协议的独立断言'}]))};
 await assert.rejects(client.animationReview({...reviewArgs,playerManifestPath:undefined}),{code:'CAPTURE_UNVERIFIED'});
 await assert.rejects(client.animationReview({...reviewArgs,checkResults:Object.fromEntries(fullAnimationChecks.map(k=>[k,{status:'pass',reason:'相同文本'}]))}),{code:'INVALID_ARGUMENT'});
 const files=await readdir(root,{recursive:true}),dry=await client.animationReview(reviewArgs);assert.equal(dry.dryRun,true);assert.equal((await client.state()).animationCandidate.reviewDecision,'notRun');assert.deepEqual(await readdir(root,{recursive:true}),files);
 const approved=await client.animationReview({...reviewArgs,dryRun:false});assert.equal(approved.dryRun,false);assert.equal((await client.state()).animationCandidate.reviewDecision,'approved');
 assert.equal((await assertAnimationReview(candidate.reviewToken,approved.reviewToken,context)).review.decision,'approved');
 const pngPath=path.join(root,player.filePath),png=await readFile(pngPath);try{await writeFile(pngPath,'changed');assert.equal((await client.state()).agentVisual.status,'stale');}finally{await writeFile(pngPath,png);}
 const next=await client.open({path:'idle.motion.json',animation:'idle',time:.2,expectedRevision:args.expectedRevision});assert.equal((await client.state()).animationCandidate,null);
 await assert.rejects(client.animationReview({...reviewArgs,expectedRevision:next.version}),{code:'NO_SOLUTION'});
}));

async function approvedCandidate(f:any){
 const candidate=await f.client.animationCandidate(f.args);assert.equal(candidate.readyForAnimationReview,true);
 installSimulatedHostPage(f.host.capture,f.host.store);const player=await f.client.capture({expectedRevision:f.args.expectedRevision,size:320});
 const approved=await f.client.animationReview({expectedRevision:f.args.expectedRevision,reviewToken:candidate.reviewToken,manifestPath:candidate.animationPreview.manifestPath,playerManifestPath:player.manifestPath,decision:'approved',reviewedBy:'事务机械验证桩',reason:'仅验证事务和完整证据绑定，不代表真实角色视觉批准',checks:fullAnimationChecks,checkResults:Object.fromEntries(fullAnimationChecks.map(k=>[k,{status:'pass',reason:k+' 的独立事务验证断言'}])),dryRun:false});
 return{candidate,save:{expectedRevision:f.args.expectedRevision,intent:'animation',outputPath:'body.json',animationCandidateHash:candidate.candidateHash,expectedHash:candidate.sourceHash,reviewToken:approved.reviewToken,requestId:'source-animation',dryRun:false}};
}

test('源动画事务：显式 pin、预演零写入、来源备份、单动画替换、幂等和不可变校准来源链',async()=>fixture(async f=>{
 const {root,host,client,args,context}=f,mapping=JSON.parse(await readFile(path.join(root,'mapping.json'),'utf8'));
 const paths=['body.json','mapping.json',mapping.reportPath,'idle.motion.json'],before=await Promise.all(paths.map(p=>readFile(path.join(root,p))));
 const {candidate,save}=await approvedCandidate(f);
 await assert.rejects(client.commit(save),{code:'TARGET_NOT_PINNED'});
 await client.rpc('/api/pin',{expectedRevision:args.expectedRevision,intent:'animation'});
 assert.equal((await client.state()).capabilities.editing.animationCandidates.readiness.commit.canRun,true);
 const files=await readdir(root,{recursive:true});assert.equal((await client.commit({...save,dryRun:true})).readyToCommit,true);assert.deepEqual(await readdir(root,{recursive:true}),files);
 for(const change of [{expectedHash:'bad'},{animationCandidateHash:'bad'},{reviewToken:'bad'},{outputPath:'mapping.json'}])await assert.rejects(client.commit({...save,...change}),{code:'COMMIT_NOT_AUTHORIZED'});
 const receipt=await client.commit(save);assert.equal(receipt.committed,true);assert.equal(receipt.switched,false);assert.equal(receipt.version.revision,args.expectedRevision.revision+1);
 const source=await readFile(path.join(root,'body.json'));assert.equal(strictHash(source),candidate.candidateHash);assert.deepEqual(await readFile(path.join(root,receipt.backupPath)),before[0]);
 auditGeneratedAnimationCandidate(JSON.parse(before[0].toString()),JSON.parse(source.toString()),'idle');
 for(let i=1;i<paths.length;i++)assert.deepEqual(await readFile(path.join(root,paths[i])),before[i]);
 assert.equal((await client.state()).targetStale,false);assert.equal((await client.state()).animationCandidate,null);assert.equal(host.store.active!.derived,null);
 assert.equal((await client.commit(save)).replayed,true);await assert.rejects(client.commit({...save,expectedHash:'different'}),{code:'REQUEST_CONFLICT'});
 const opened=await client.open({path:'idle.motion.json',expectedRevision:receipt.version,animation:'idle',time:.15,recheck:true});
 await assert.rejects(client.animationCandidate({...args,expectedRevision:opened.version}),{code:'INVALID_ARGUMENT'});
 const next=await client.animationCandidate({...args,expectedRevision:opened.version,overwrite:true});assert.equal(next.numericOk,true);assert.equal(next.readyForAnimationReview,true);
 const report=JSON.parse(await readFile(path.join(root,next.reportPath),'utf8'));assert.equal(report.calibration.provenance.kind,'host-animation-chain');
 const backup=await readFile(path.join(root,receipt.backupPath));try{await writeFile(path.join(root,receipt.backupPath),'{}');await assert.rejects(assertHostAnimationMapping(mapping,JSON.parse(source.toString()),strictHash(source),'body.json','mapping.json',context),{code:'TARGET_DRIFT'});}finally{await writeFile(path.join(root,receipt.backupPath),backup);}
}));

test('源动画故障：发布前备份失败和最终源漂移不替换目标',async()=>fixture(async f=>{
 const {root,host,client,args}=f,{save}=await approvedCandidate(f),source=await readFile(path.join(root,'body.json'));
 await client.rpc('/api/pin',{expectedRevision:args.expectedRevision,intent:'animation'});
 host.store.fault=p=>{if(p==='backup')throw Error('模拟备份失败');};await assert.rejects(client.commit(save));assert.deepEqual(await readFile(path.join(root,'body.json')),source);assert.equal(host.store.frozen,false);
 const changed=Buffer.concat([source,Buffer.from(' ')]);host.store.fault=p=>{if(p==='publish')writeFileSync(path.join(root,'body.json'),changed);};
 try{await assert.rejects(client.commit({...save,requestId:'source-drift'}));assert.deepEqual(await readFile(path.join(root,'body.json')),changed);assert.equal(host.store.frozen,false);}finally{host.store.fault=undefined;await writeFile(path.join(root,'body.json'),source);}
}));

test('源动画发布后中断：冻结、日志恢复与重复请求回执，校准来源证明保留',async()=>fixture(async f=>{
 const {root,host,client,args,context}=f,{save}=await approvedCandidate(f);await client.rpc('/api/pin',{expectedRevision:args.expectedRevision,intent:'animation'});
 host.store.fault=p=>{if(p==='afterPublish')throw Error('模拟源替换后退出');};await assert.rejects(client.commit(save),{code:'WRITE_OWNERSHIP_UNCERTAIN'});assert.equal(host.store.frozen,true);
 await releaseWriter(host.store.writer!,context);host.store.writer=null;
 const recovered=new HostEditorStore(context,'host','c2-pose');await recovered.enableWriting();
 try{await recovered.open({path:'idle.motion.json',animation:'idle',time:.15});const receipt=await recovered.commit(save);assert.equal(receipt.replayed,true);assert.equal(strictHash(await readFile(path.join(root,'body.json'))),receipt.hashAfter);
 const mapping=JSON.parse(await readFile(path.join(root,'mapping.json'),'utf8')),source=await readFile(path.join(root,'body.json'));
 assert.equal((await assertHostAnimationMapping(mapping,JSON.parse(source.toString()),strictHash(source),'body.json','mapping.json',context)).kind,'host-animation-chain');
 }finally{await recovered.shutdown();}
}));

test('完整动画真实 stdio 入口：发现五项 schema、准备/当前截图/视觉批准/animation pin/源提交及幂等',async()=>fixture(async({root,host,args})=>{
 const protocol=new Client({name:'source-animation-protocol',version:'1'},{capabilities:{}}),env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>typeof e[1]==='string'));
 await protocol.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env,SPINE_MCP_WORKSPACE:root,SPINE_HOST_AUTOSTART:'0'}}));
 const call=async(name:string,values:any)=>decode(await protocol.callTool({name,arguments:{projectId:args.projectId,...values}}));
 try{
  const tools=await protocol.listTools(),schema:any=tools.tools.find(t=>t.name==='spine_review_animation')!.inputSchema;
  assert.deepEqual(schema.properties.checks.items.enum,fullAnimationChecks);assert.deepEqual(Object.keys(schema.properties.checkResults.properties),fullAnimationChecks);
  const candidate=await call('spine_retarget_motion',args);installSimulatedHostPage(host.capture,host.store);
  const capture=await call('spine_preview_capture',{expectedRevision:args.expectedRevision,size:320});
  const review=await call('spine_review_animation',{expectedRevision:args.expectedRevision,reviewToken:candidate.reviewToken,manifestPath:candidate.animationPreview.manifestPath,playerManifestPath:capture.manifestPath,decision:'approved',reviewedBy:'stdio 协议验证桩',reason:'仅验证公开工具的合成事务，不代表真实美术批准',checks:fullAnimationChecks,checkResults:Object.fromEntries(fullAnimationChecks.map(k=>[k,{status:'pass',reason:k+' 的公开接口独立断言'}])),dryRun:false});
  await call('spine_host_pin',{expectedRevision:args.expectedRevision,intent:'animation'});
  const save={expectedRevision:args.expectedRevision,intent:'animation',animationCandidateHash:candidate.candidateHash,expectedHash:candidate.sourceHash,reviewToken:review.reviewToken,outputPath:'body.json',requestId:'stdio-animation-source',dryRun:false};
  assert.equal((await call('spine_host_commit',{...save,dryRun:true})).readyToCommit,true);
  const receipt=await call('spine_host_commit',save);assert.equal(receipt.committed,true);assert.equal(strictHash(await readFile(path.join(root,'body.json'))),candidate.candidateHash);assert.equal((await call('spine_host_commit',save)).replayed,true);
 }finally{await protocol.close();}
}));
