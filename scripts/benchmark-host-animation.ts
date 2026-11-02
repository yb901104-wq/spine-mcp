// 合成完整动画的实际 HostClient 候选/审查/源提交性能；模拟页面仅验证协议，不是真实 player 或美术验收。
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {withHostFixture} from '../test/helpers/hostFixture.js';
import {installSimulatedHostPage} from '../test/helpers/hostPage.js';
import {renderPoseComparison,reviewPose,poseChecks} from '../src/poseWorkflow.js';
import {fullAnimationChecks} from '../src/hostAnimationSession.js';
import {startHostServer} from '../src/hostServer.js';
import {HostClient} from '../src/hostClient.js';
import {strictHash} from '../src/hostContracts.js';
const output=`docs/plans/host-animation-performance-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
const report:any={startedAt:new Date().toISOString(),node:process.version,platform:os.platform(),release:os.release(),cpu:os.cpus()[0]?.model,warmups:2,sampleCount:30,samples:[],publicWriteEnabled:false,scope:'合成关节与两个 region，0.3 秒两个已批准同姿态关键帧。每次独立工作区；实际 HostClient、MCP 数值门禁、完整产物/证据哈希、一次性授权、fsync 备份/journal/原子替换，不含 stdio 或真实浏览器。模拟 player 不作为视觉验收。'};
try{
 report.codeHashes={};for(const file of ['src/hostClient.ts','src/hostEditorStore.ts','src/hostDocumentStore.ts','src/hostServer.ts','src/hostAnimationCandidate.ts','src/hostAnimationBundle.ts','src/hostAnimationSession.ts','src/hostAnimationCommit.ts','src/hostAnimationMapping.ts','src/hostJournal.ts','src/retargetEngine.ts','src/spineJson.ts','test/helpers/hostFixture.ts', 'scripts/benchmark-host-animation.ts'])report.codeHashes[file]=strictHash(await readFile(file));
 for(let index=-2;index<30;index++)await withHostFixture(async({root,context})=>{
  const sheet=await renderPoseComparison({posePaths:['a.pose.json']},context);
  await reviewPose({posePath:'a.pose.json',manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'性能协议桩',reason:'固定合成预期，不代表真实美术批准',checks:poseChecks,dryRun:false},context);
  const host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose'}),client=new HostClient(context);
  try{
   const opened=await client.open({path:'a.pose.json'});await client.rpc('/api/pin',{expectedRevision:opened.version});
   const motion=await client.assetCommand('spine_build_motion_from_poses',{expectedRevision:opened.version,standardPosePath:'a.pose.json',keyPoses:[{posePath:'a.pose.json',time:0,stageId:'start'},{posePath:'a.pose.json',time:.3,stageId:'end'}],motionPath:'idle.motion.json',name:'idle',duration:.3,loop:true,dryRun:false});
   await client.commit({expectedRevision:opened.version,intent:'asset',assetCandidateHash:motion.candidateHash,outputPath:motion.outputPath,requestId:'motion',dryRun:false});
   const current=await client.open({path:motion.outputPath,expectedRevision:opened.version,animation:'idle',time:.15,recheck:true}),version=current.version;
   const started=performance.now(),candidate=await client.animationCandidate({expectedRevision:version,filePath:'body.json',mappingPath:'mapping.json',motionPath:motion.outputPath,animation:'idle'}),candidateClientMs=performance.now()-started;assert.equal(candidate.readyForAnimationReview,true);
   installSimulatedHostPage(host.capture,host.store);const capture=await client.capture({expectedRevision:version,size:320});
   const review=await client.animationReview({expectedRevision:version,reviewToken:candidate.reviewToken,manifestPath:candidate.animationPreview.manifestPath,playerManifestPath:capture.manifestPath,decision:'approved',reviewedBy:'性能协议桩',reason:'固定合成夹具，仅事务性能',checks:fullAnimationChecks,checkResults:Object.fromEntries(fullAnimationChecks.map(k=>[k,{status:'pass',reason:k+' 独立合成预期断言'}])),dryRun:false});
   await client.rpc('/api/pin',{expectedRevision:version,intent:'animation'});
   const stateStart=performance.now();await client.state();const stateClientMs=performance.now()-stateStart;
   const frameStart=performance.now();await client.frame({expectedRevision:version,size:480});const frameClientMs=performance.now()-frameStart;
   const original=await readFile(path.join(root,'body.json')),mapping=await readFile(path.join(root,'mapping.json'));
   const trace:any[]=[],rpc=client.rpc.bind(client);client.rpc=async(...args:Parameters<HostClient['rpc']>)=>{const t=performance.now();try{return await rpc(...args);}finally{trace.push({route:args[0],durationMs:performance.now()-t});}};
   const commitStart=performance.now(),receipt=await client.commit({expectedRevision:version,intent:'animation',animationCandidateHash:candidate.candidateHash,expectedHash:candidate.sourceHash,reviewToken:review.reviewToken,outputPath:'body.json',requestId:'source',dryRun:false}),commitClientMs=performance.now()-commitStart;
   assert.equal(strictHash(await readFile(path.join(root,'body.json'))),candidate.candidateHash);assert.deepEqual(await readFile(path.join(root,receipt.backupPath)),original);assert.deepEqual(await readFile(path.join(root,'mapping.json')),mapping);
   if(index>=0)report.samples.push({candidateClientMs,stateClientMs,frameClientMs,commitClientMs,commitTrace:trace,backupVerified:true});else(report.warmupSamples??=[]).push({candidateClientMs,stateClientMs,frameClientMs,commitClientMs});
  }finally{await host.stop();}
 },{neutralSetup:true});
 report.phases=Object.fromEntries(['candidateClientMs','stateClientMs','frameClientMs','commitClientMs'].map(k=>{const values=report.samples.map((s:any)=>s[k]).sort((a:number,b:number)=>a-b);return[k,{p50:values[14],p95:values[28],maximum:values.at(-1)}];}));
 report.budgets={stateClientMs:20,frameClientMs:50,commitClientMs:200};report.budgetsPassed=Object.entries(report.budgets).every(([k,v])=>report.phases[k].p95<Number(v));report.mechanicsPassed=true;
}catch(error:any){report.error=error.stack;report.mechanicsPassed=false;process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,mechanicsPassed:report.mechanicsPassed,budgetsPassed:report.budgetsPassed,phases:report.phases,error:report.error}));}
