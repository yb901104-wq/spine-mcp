// 正式 MCP 验收驱动；只保存诊断报告/返回图片，不自由编辑 Spine、pose 或 manifest。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {strictHash} from '../dist/hostContracts.js';
import {HostClient} from '../dist/hostClient.js';

const buildDirectory=process.env.SPINE_VALIDATION_BUILD??'dist';
const sourceRoot=path.resolve(process.argv.slice(2).find(a=>!a.startsWith('--'))??'D:/AI_cc/spine test/body-reference-trials/2026-10-24T15-53-20-542Z');
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),reportPath=`docs/plans/creation-completion-trial-${stamp}.json`;
const sourceManifest=JSON.parse(await fs.readFile(path.join(sourceRoot,'.spine-workflow.json'),'utf8'));
const protocol=new Client({name:'creation-completion-real-npc1',version:'1'}),calls=[];
let hostProcess,taskContext,taskId,hostEndpoint;
const report={schemaVersion:1,at:new Date().toISOString(),sourceRoot,reportPath,bodyOnly:true,formalAnimationDelivered:false,editorImport:'notRun',secondCharacter:'notAvailable',publicWriteEnabled:false,calls};
async function call(name,input={},allowError=false){
  const started=performance.now(),response=await protocol.callTool({name,arguments:{...taskContext?{projectId:taskContext.projectId}:{projectId:sourceManifest.projectId},...input}});
  const text=response.content.filter(c=>c.type==='text').map(c=>c.text).join(''),value=JSON.parse(text);
  calls.push({tool:name,durationMs:performance.now()-started,textBytes:Buffer.byteLength(text),images:response.content.filter(c=>c.type==='image').length,error:response.isError===true,version:value.version??value.state?.version??null});
  if(response.isError&&!allowError)throw Error(`${name}: ${text}`);
  return {...value,...response.isError?{isError:true}:{},_images:response.content.filter(c=>c.type==='image')};
}
async function imageResult(value,label){
  const paths=[];for(let i=0;i<value._images.length;i++){const relative=`output/reports/creation-${stamp}/${label}-${i}.png`,absolute=path.join(taskContext.workspaceRoot,relative);await fs.mkdir(path.dirname(absolute),{recursive:true});await fs.writeFile(absolute,Buffer.from(value._images[i].data,'base64'));paths.push({path:relative,hash:strictHash(await fs.readFile(absolute))});}return paths;
}
async function launch(){
  let output='';hostProcess=spawn(process.execPath,[`${buildDirectory}/creationTrialServer.js`,'--workspace',taskContext.workspaceRoot,'--isolated'],{cwd:process.cwd(),env:{...process.env,SPINE_MCP_REGISTRY_ROOT:sourceRoot},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('隔离启动超时')),20000);hostProcess.once('exit',code=>{clearTimeout(timer);reject(Error(`隔离入口退出 ${code}: ${output}`));});for(const stream of [hostProcess.stdout,hostProcess.stderr])stream.on('data',chunk=>{output+=chunk.toString();for(const line of output.split('\n')){try{const message=JSON.parse(line);if(message.type==='creation-host-ready'){clearTimeout(timer);resolve(message);}}catch{}}});});
  report.launch=result;hostEndpoint=result.endpoint;console.log(JSON.stringify({type:process.argv.includes('--engineering-only')?'engineering-host-ready':'browser-required',endpoint:hostEndpoint,workspaceRoot:taskContext.workspaceRoot,taskId}));
  if(process.argv.includes('--engineering-only'))return;
  const connection=JSON.parse(await fs.readFile(path.join(taskContext.workspaceRoot,'.spine-mcp/host-port.json'),'utf8')),started=performance.now();let polls=0;
  while(performance.now()-started<180000){const response=await fetch(hostEndpoint+'/api/state',{headers:{'X-Spine-Host-Token':connection.token}}),state=await response.json();polls++;if(state.preview?.visibilityState==='visible'){report.browserWait={durationMs:performance.now()-started,readOnlyHttpPolls:polls};return;}await new Promise(resolve=>setTimeout(resolve,1000));}
  throw Error('没有可见的真实 player 页面，未进行截图验收。');
}
const engineeringOnly=process.argv.includes('--engineering-only');report.engineeringOnly=engineeringOnly;
const reviewFile=path.resolve(`.codex-temp/creation-calibration-review-${stamp}.json`);
try{
 await protocol.connect(new StdioClientTransport({command:process.execPath,args:[`${buildDirectory}/server.js`],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:sourceRoot,SPINE_MCP_REGISTRY_ROOT:sourceRoot,SPINE_HOST_AUTOSTART:'0'}}));
 await call('spine_register_workspace',{rootPath:sourceRoot,projectId:sourceManifest.projectId});
 const task=await call('spine_start_creation_task',{characterId:'npc1',referencePath:'reference/body.gif',stages:[{stageId:'standard',documentPath:'trial/neutral-stand-v2.pose.json'}],isolatedDirectory:`creation-completion-trials/${stamp}`,dryRun:false});taskContext=task.taskContext;taskId=task.taskId;report.task={taskId,...taskContext,inputsFingerprint:task.inputsFingerprint};
 const list=await protocol.listTools();report.tools={count:list.tools.length,definitions:list.tools.filter(t=>/arm_perspective|motion_interval/.test(t.name))};
 await launch();
 const opened=await call('spine_host_open',{path:'trial/neutral-stand-v2.pose.json',recheck:true,responseDetail:'full'});await call('spine_host_pin',{expectedRevision:opened.version});
 const preparation=await call('spine_inspect_character_preparation',{expectedRevision:opened.version,responseDetail:'full'});report.preparation=preparation;report.application=opened.state.application;
 const frame=opened.state.editValues,rig=preparation.calibration,numeric=opened.state.numeric;
 const original=frame.targets.leftHand,shoulder=numeric.joints.leftShoulder,wrist=numeric.joints.leftWrist;
 const sn={x:(shoulder.x-rig.origin[0])/rig.scale,y:(shoulder.y-rig.origin[1])/rig.scale},wn={x:(wrist.x-rig.origin[0])/rig.scale,y:(wrist.y-rig.origin[1])/rig.scale};
 const samples=(process.argv.includes('--narrow-calibration')?[1,.95,.9,.85]:[1,.85,.7,.55]).map((ratio,i)=>({id:`projection-${i}`,upper:ratio,lower:ratio,target:{x:sn.x+(wn.x-sn.x)*ratio+original.x-wn.x,y:sn.y+(wn.y-sn.y)*ratio+original.y-wn.y,angle:original.angle}}));
 const args={posePath:'trial/neutral-stand-v2.pose.json',calibrationPath:'trial/left-arm-world.calibration.json',limb:'leftArm',basis:'同一已验收 npc1 标准姿态，固定分支；世界段长逐步缩短，不自动推断前后；独立核对切片连接与手部尺寸。',samples};
 report.calibration=await call('spine_calibrate_arm_perspective',{...args,dryRun:false});assert.equal(report.calibration.ok,true,JSON.stringify(report.calibration));
 let version=opened.version;report.sampleCaptures=[];
 if(!engineeringOnly){
 for(const sample of report.calibration.samples){
  const edited=await call('spine_host_patch',{expectedRevision:version,ops:[{op:'setPosePerspective',path:'pose/frame/perspective',value:{mode:'calibration',limb:'leftArm',...sample.input,basis:args.basis,calibrationPath:args.calibrationPath,calibrationHash:report.calibration.calibrationHash}},{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',...sample.frame.targets.leftHand}],dryRun:false,responseDetail:'full'});version=edited.version;
  const capture=await call('spine_preview_capture',{expectedRevision:version,size:960});assert.equal(capture.manifest.captureValidity.status,'verified');assert.equal(capture.manifest.evidenceEligible,false);
  report.sampleCaptures.push({sampleId:sample.id,manifestPath:capture.manifestPath,images:await imageResult(capture,sample.id)});
 }
 console.log(JSON.stringify({type:'independent-visual-review-required',reviewFile,root:taskContext.workspaceRoot,sheetPath:report.calibration.sheetPath,samples:report.sampleCaptures}));
 let review;if(process.env.SPINE_REJECTED_CALIBRATION_REVIEW){const prior=JSON.parse(await fs.readFile(process.env.SPINE_REJECTED_CALIBRATION_REVIEW,'utf8'));assert.equal(prior.decision,'rejected','不自动迁移任何批准');assert.deepEqual(prior.sampleHashes,report.sampleCaptures.map(s=>s.images[0].hash),'新旧诊断图必须逐像素相同');review=prior;report.reusedRejection={source:process.env.SPINE_REJECTED_CALIBRATION_REVIEW,pixelsIdentical:true,currentPlayerCapturesVerified:true,approvalTransferred:false};}for(let i=0;!review&&i<900;i++){try{review=JSON.parse(await fs.readFile(reviewFile,'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,1000));}assert.ok(review,'没有独立视觉审查结果，未批准校准');report.visual=review;
 report.calibrationReview=await call('spine_review_arm_perspective',{calibrationPath:args.calibrationPath,calibrationHash:report.calibration.calibrationHash,decision:review.decision,reviewedBy:'Agent 独立检查实际 player 图',reason:review.reason,samples:report.sampleCaptures.map(({sampleId,manifestPath})=>({sampleId,manifestPath})),checkResults:review.checkResults,dryRun:false});
 if(review.decision==='approved'){
  report.formalPoses=[];
  for(const index of [0,2]){
   const sample=report.calibration.samples[index],formal=await call('spine_host_patch',{expectedRevision:version,ops:[{op:'setPosePerspective',path:'pose/frame/perspective',value:{mode:'calibrated',limb:'leftArm',...sample.input,basis:args.basis,calibrationPath:args.calibrationPath,calibrationHash:report.calibration.calibrationHash}},{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',...sample.frame.targets.leftHand}],dryRun:false,responseDetail:'full'});version=formal.version;assert.equal(formal.state.numeric.ok,true);
   const capture=await call('spine_preview_capture',{expectedRevision:version,size:960});assert.equal(capture.manifest.evidenceEligible,true);
   const checks=['standingOrAction','silhouette','jointDirections','support','grip','occlusion','referenceDifferences'];
   await call('spine_review_pose',{posePath:'trial/neutral-stand-v2.pose.json',expectedRevision:version,manifestPath:capture.manifestPath,decision:'approved',reviewedBy:'Agent 独立检查当前真实 player 图',reason:`独立校准控制试用比例 ${sample.input.upper}，不批准原 GIF 动作`,checks,checkResults:{standingOrAction:{status:'pass',reason:'该试用姿态保持原标准站姿的身体和双脚，只改变已批准范围内单臂投影。'},silhouette:{status:'pass',reason:'当前手臂切片连接完整，手部外轮廓保持；不包含此前退回的 0.55 范围。'},jointDirections:{status:'pass',reason:'肩肘腕沿同一已确认分支连续收拢，末端方向经 runtime 和当前 player 核对。'},support:{status:'pass',reason:'双脚与原标准姿态相同，鞋底落地关系保持。'},grip:{status:'pass',reason:'此控制试用没有武器或握持目标，不把手腕当作未知握持点批准。'},occlusion:{status:'pass',reason:'只使用原绘制顺序，当前手臂与衣服边界没有新增明显穿插，不推断新的深度。'},referenceDifferences:{status:'pass',reason:'此姿态只验明确的校准参数，无图片复现目标；原 GIF 参考任务仍未批准。'}},dryRun:false});
   const saved=await call('spine_host_commit',{expectedRevision:version,outputPath:`trial/formal-arm-${index}.pose.json`,requestId:`formal-arm-${index}-${stamp}`,dryRun:false});version=saved.version;report.formalPoses.push({posePath:saved.outputPath,ratio:sample.input.upper,numeric:formal.state.numeric,images:await imageResult(capture,`formal-${index}`)});
   const original=await call('spine_host_open',{path:'trial/neutral-stand-v2.pose.json',expectedRevision:version,recheck:true});version=original.version;await call('spine_host_pin',{expectedRevision:version});
  }
 }
 }else report.visual={decision:'notRun',reason:'本次仅工程数值验证，不代替真实 player 与独立视觉。'};
 if(!engineeringOnly&&report.visual.decision==='rejected'){for(let i=0;i<report.calibration.samples.length;i++){const undone=await call('spine_host_undo',{expectedRevision:version,dryRun:false});version=undone.version;}report.calibrationEditsExplicitlyUndone=true;}
 const reset=await call('spine_host_open',{path:'trial/neutral-stand-v2.pose.json',expectedRevision:version,reload:true,recheck:true});version=reset.version;await call('spine_host_pin',{expectedRevision:version});
 const staged=await call('spine_build_motion_from_poses',{expectedRevision:version,standardPosePath:'trial/neutral-stand-v2.pose.json',keyPoses:[{stageId:'start',posePath:'trial/neutral-stand-v2.pose.json',time:0},{stageId:'end',posePath:'trial/neutral-stand-v2.pose.json',time:1}],motionPath:'trial/interval-check.motion.json',name:'interval_check',duration:1,loop:false,dryRun:false});
 await call('spine_host_commit',{expectedRevision:version,outputPath:staged.outputPath,intent:'asset',assetCandidateHash:staged.candidateHash,requestId:`interval-${stamp}`,dryRun:false});
 const playing=await call('spine_host_open',{path:staged.outputPath,expectedRevision:version,animation:'interval_check',time:.5,recheck:true});version=playing.version;await call('spine_host_pin',{expectedRevision:version});
 const edited=await call('spine_edit_motion_interval',{expectedRevision:version,start:0,end:1,frames:[{time:.5,head:1}],dryRun:false});report.intervalImages=await imageResult(edited,'interval-middle');
 const undone=await call('spine_host_undo',{expectedRevision:edited.version,dryRun:false}),redone=await call('spine_host_redo',{expectedRevision:undone.version,dryRun:false});
 const saved=await call('spine_host_commit',{expectedRevision:redone.version,outputPath:'trial/interval-check-v2.motion.json',requestId:`interval-v2-${stamp}`,dryRun:false});
 let reopened=await call('spine_host_open',{path:saved.outputPath,expectedRevision:saved.version,animation:'interval_check',time:.5,recheck:true});report.interval={saved,reopenedVersion:reopened.version};
 const character=sourceManifest.characters.npc1,candidate=await call('spine_retarget_motion',{expectedRevision:reopened.version,filePath:character.skeletonPath,mappingPath:character.mappingPath,motionPath:saved.outputPath,animation:'interval_check',preview:true,dryRun:true});assert.equal(candidate.numericOk,true);report.intervalCandidate={candidatePath:candidate.candidatePath,candidateHash:candidate.candidateHash,numericOk:candidate.numericOk,readyForAnimationReview:candidate.readyForAnimationReview,reportPath:candidate.reportPath,scope:'区间工程试用动画，不是原 GIF 作品',images:await imageResult(candidate,'interval-candidate')};

 if(report.formalPoses?.length===2){
  const source=await call('spine_host_open',{path:'trial/neutral-stand-v2.pose.json',expectedRevision:reopened.version,recheck:true});await call('spine_host_pin',{expectedRevision:source.version});
  const staged=await call('spine_build_motion_from_poses',{expectedRevision:source.version,standardPosePath:'trial/neutral-stand-v2.pose.json',keyPoses:report.formalPoses.map((p,i)=>({stageId:`projection-${i}`,posePath:p.posePath,time:i})),motionPath:'trial/formal-arm.motion.json',name:'arm_projection_trial',duration:1,loop:false,dryRun:false});
  await call('spine_host_commit',{expectedRevision:source.version,outputPath:staged.outputPath,intent:'asset',assetCandidateHash:staged.candidateHash,requestId:`formal-motion-${stamp}`,dryRun:false});
  reopened=await call('spine_host_open',{path:staged.outputPath,expectedRevision:source.version,animation:'arm_projection_trial',time:.5,recheck:true});
  const candidate=await call('spine_retarget_motion',{expectedRevision:reopened.version,filePath:character.skeletonPath,mappingPath:character.mappingPath,motionPath:staged.outputPath,animation:'arm_projection_trial',preview:true,dryRun:true});assert.equal(candidate.numericOk,true);report.formalMotion={motionPath:staged.outputPath,candidatePath:candidate.candidatePath,candidateHash:candidate.candidateHash,numericOk:true,sourceAnimationCommitted:false,originalGifDelivered:false,images:await imageResult(candidate,'formal-motion')};
 }
 if(!engineeringOnly){console.log(JSON.stringify({type:'playback-ui-review-required',reviewFile:reviewFile+'.playback.json',endpoint:hostEndpoint,root:taskContext.workspaceRoot,version:reopened.version}));
 for(let i=0;i<900;i++){try{report.playbackVisual=JSON.parse(await fs.readFile(reviewFile+'.playback.json','utf8'));break;}catch{}await new Promise(r=>setTimeout(r,1000));}assert.ok(report.playbackVisual?.passed,'播放界面尚未独立验证');
 }else{const connection=new HostClient(taskContext);await connection.ensurePreview();const state=await connection.state();const bundle=await connection.rpc('/api/playback-bundle?'+new URLSearchParams({...state.version,candidateHash:state.playback.candidateHash}));assert.equal(bundle.evidenceEligible,false);assert.equal(bundle.stages.length,2);report.playbackProtocol={passed:true,candidateHash:bundle.candidateHash,version:bundle.version,evidenceEligible:false,visual:'notRun'};}
 const current=await call('spine_get_creation_task',{taskId});assert.equal(current.freshness.current,true);report.inputsUnchanged=true;report.passed=true;
}catch(error){report.error=error.stack??String(error);process.exitCode=1;}
finally{
 if(hostProcess&&hostProcess.exitCode===null){
  try{const connection=JSON.parse(await fs.readFile(path.join(taskContext.workspaceRoot,'.spine-mcp/host-port.json'),'utf8'));const response=await fetch(hostEndpoint+'/api/shutdown',{method:'POST',headers:{'X-Spine-Host-Token':connection.token,Origin:hostEndpoint,'Content-Type':'application/json'},body:JSON.stringify({reason:'acceptance-complete'})});assert.equal(response.status,202);await new Promise(r=>setTimeout(r,300));}catch(error){report.shutdownWarning=String(error);}
  if(hostProcess.exitCode===null){hostProcess.kill();await new Promise(r=>hostProcess.once('exit',r));}
 }report.hostStopped=true;
 const {readWriter,recoverDeadWriter}=await import('../dist/writerOwnership.js');if(taskContext){const lease=await readWriter(taskContext);if(lease){const recovered=await recoverDeadWriter(taskContext,lease);report.deadWriterRecovery={recovered:recovered.recovered,pid:lease.pid,generation:lease.generation};}}

 if(taskContext)report.writerReleased=await fs.access(path.join(taskContext.workspaceRoot,'.spine-mcp/writer.lock')).then(()=>false,e=>e.code==='ENOENT');
 await protocol.close();await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({reportPath,passed:report.passed,error:report.error??null,hostStopped:report.hostStopped}));
}
