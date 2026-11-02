// 正式 MCP 验收驱动；只保存诊断报告/返回图片，不自由编辑 Spine、pose 或 manifest。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {strictHash} from '../dist/hostContracts.js';
import {HostClient} from '../dist/hostClient.js';

const sourceRoot=path.resolve(process.argv[2]??'D:/AI_cc/spine test/body-reference-trials/2026-10-24T15-53-20-542Z');
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),reportPath=`docs/plans/creation-usability-trial-${stamp}.json`;
const sourceManifest=JSON.parse(await fs.readFile(path.join(sourceRoot,'.spine-workflow.json'),'utf8'));
const protocol=new Client({name:'creation-workflow-real-npc1',version:'1'}),calls=[];
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
  let output='';hostProcess=spawn(process.execPath,['dist/creationTrialServer.js','--workspace',taskContext.workspaceRoot,'--isolated'],{cwd:process.cwd(),env:{...process.env,SPINE_MCP_REGISTRY_ROOT:sourceRoot},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('隔离启动超时')),20000);hostProcess.once('exit',code=>{clearTimeout(timer);reject(Error(`隔离入口退出 ${code}: ${output}`));});for(const stream of [hostProcess.stdout,hostProcess.stderr])stream.on('data',chunk=>{output+=chunk.toString();for(const line of output.split('\n')){try{const message=JSON.parse(line);if(message.type==='creation-host-ready'){clearTimeout(timer);resolve(message);}}catch{}}});});
  report.launch=result;hostEndpoint=result.endpoint;console.log(JSON.stringify({type:'browser-required',endpoint:hostEndpoint,workspaceRoot:taskContext.workspaceRoot,taskId}));
  const connection=JSON.parse(await fs.readFile(path.join(taskContext.workspaceRoot,'.spine-mcp/host-port.json'),'utf8')),started=performance.now();let polls=0;
  while(performance.now()-started<180000){const response=await fetch(hostEndpoint+'/api/state',{headers:{'X-Spine-Host-Token':connection.token}}),state=await response.json();polls++;if(state.preview?.visibilityState==='visible'){report.browserWait={durationMs:performance.now()-started,readOnlyHttpPolls:polls};return;}await new Promise(resolve=>setTimeout(resolve,1000));}
  throw Error('没有可见的真实 player 页面，未进行截图验收。');
}
try{
  await protocol.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:sourceRoot,SPINE_MCP_REGISTRY_ROOT:sourceRoot,SPINE_HOST_AUTOSTART:'0'}}));
  await call('spine_register_workspace',{rootPath:sourceRoot,projectId:sourceManifest.projectId});
  const task=await call('spine_start_creation_task',{characterId:'npc1',referencePath:'reference/body.gif',sequencePath:'reference/body.sequence.json',stages:[{stageId:'standard',documentPath:'trial/neutral-stand-v2.pose.json'},{stageId:'ready',documentPath:'trial/ready-v1.pose.json',referencePosePath:'reference/ready-v1.reference.json'}],isolatedDirectory:`creation-trials/${stamp}`,dryRun:false});
  taskContext=task.taskContext;taskId=task.taskId;report.task={taskId,...taskContext,inputsFingerprint:task.inputsFingerprint};
  await launch();
  const selected=await call('spine_select_creation_stage',{taskId,stageId:'standard',dryRun:false});
  await call('spine_host_pin',{expectedRevision:selected.version});
  const opened=await call('spine_host_open',{path:'trial/neutral-stand-v2.pose.json',expectedRevision:selected.version,recheck:true});
  report.baseline={numeric:opened.state.numeric.ok,images:await imageResult(opened,'standard-frame')};
  const changed=await call('spine_adjust_pose_intent',{expectedRevision:opened.version,headTilt:1,dryRun:false});assert.equal(changed.state.numeric.ok,true);
  report.edited={version:changed.version,images:await imageResult(changed,'edited-frame')};
  const capture=await call('spine_preview_capture',{expectedRevision:changed.version,size:960});assert.equal(capture.manifest.captureValidity.status,'verified');report.edited.capture={manifestPath:capture.manifestPath,evidenceEligible:capture.manifest.evidenceEligible,images:await imageResult(capture,'edited-player')};
  const undone=await call('spine_host_undo',{expectedRevision:changed.version,dryRun:false});
  const saved=await call('spine_host_commit',{expectedRevision:undone.version,outputPath:`trial/creation-${stamp}.pose.json`,requestId:`creation-${stamp}`,dryRun:false});assert.ok(saved.backupPath);
  const reopened=await call('spine_host_open',{path:saved.outputPath,expectedRevision:saved.version,recheck:true});report.closedLoop={passed:true,savedPath:saved.outputPath,backupPath:saved.backupPath,reopenedVersion:reopened.version};
  const taskAfterSave=await call('spine_get_creation_task',{taskId});assert.ok(taskAfterSave.stageContexts.find(s=>s.stageId==='standard').candidates.some(v=>v.documentPath===saved.outputPath&&v.verified));
  const resumedStage=await call('spine_select_creation_stage',{taskId,stageId:'standard',documentPath:saved.outputPath,expectedRevision:reopened.version,dryRun:false});assert.equal(resumedStage.state.activeDoc.path,saved.outputPath);report.savedRevisionSelection={passed:true,path:saved.outputPath,version:resumedStage.version};
  const wrongFamily=await call('spine_select_creation_stage',{taskId,stageId:'standard',documentPath:'trial/ready-v1.pose.json',expectedRevision:resumedStage.version},true);assert.equal(wrongFamily.isError,true);report.otherPoseFamilyDenied=true;
  const copiedRevision=await call('spine_start_creation_task',{characterId:'npc1',referencePath:'reference/body.gif',stages:[{stageId:'standard',documentPath:saved.outputPath}],isolatedDirectory:'isolated/saved-revision',dryRun:false});report.savedRevisionCopy={taskId:copiedRevision.taskId,...copiedRevision.taskContext};
  const copiedManifest=JSON.parse(await fs.readFile(path.join(copiedRevision.taskContext.workspaceRoot,'.spine-workflow.json'),'utf8'));assert.ok(copiedManifest.documents.some(d=>d.path===saved.outputPath));assert.equal(copiedRevision.isolation.journalCopied,false);
  const full=await call('spine_preview_state',{responseDetail:'full'}),fullCost=calls.at(-1).textBytes;
  const brief=await call('spine_preview_state',{});report.summary={sameVersion:JSON.stringify(full.version)===JSON.stringify(brief.version),fullTextBytes:fullCost,summaryTextBytes:calls.at(-1).textBytes};report.application=brief.application;
  const ready=await call('spine_select_creation_stage',{taskId,stageId:'ready',expectedRevision:reopened.version,dryRun:false});await call('spine_host_pin',{expectedRevision:ready.version});
  const compared=await call('spine_host_open',{path:'trial/ready-v1.pose.json',expectedRevision:ready.version,recheck:true});report.referenceBefore={numeric:compared.state.numeric.ok,quality:compared.state.creationQuality};
  report.precheck=await call('spine_precheck_pose',{expectedRevision:compared.version});delete report.precheck._images;
  report.preparation=await call('spine_inspect_character_preparation',{expectedRevision:compared.version});delete report.preparation._images;
  const refinement=await call('spine_refine_reference_pose',{posePath:'trial/ready-v1.pose.json',outputPosePath:`trial/ready-creation-${stamp}.pose.json`,expectedRevision:compared.version,dryRun:false},true);
  report.refinement={ok:refinement.ok??false,adopted:refinement.adopted??false,error:refinement.isError?{code:refinement.code,message:refinement.message}:null,version:refinement.version??compared.version,images:await imageResult(refinement,'ready-refined-frame')};
  const finalState=await call('spine_preview_state',{});report.referenceAfter=finalState.creationQuality;
  const readyCapture=await call('spine_preview_capture',{expectedRevision:finalState.version,size:960});assert.equal(readyCapture.manifest.captureValidity.status,'verified');report.referenceCapture={manifestPath:readyCapture.manifestPath,evidenceEligible:readyCapture.manifest.evidenceEligible,images:await imageResult(readyCapture,'ready-player')};
  if(finalState.creationQuality?.referenceStatus!=='passed'){
    const denied=await call('spine_host_commit',{expectedRevision:finalState.version,outputPath:`trial/failed-ready-${stamp}.pose.json`},true);assert.equal(denied.isError,true);assert.equal(denied.code,'COMMIT_NOT_AUTHORIZED');report.failedReferenceCommitDenied=true;
  }
  const taskResult=await call('spine_get_creation_task',{taskId,responseDetail:'full'});assert.equal(taskResult.freshness.current,true);report.taskMetrics=taskResult.metrics;report.frozenInputs=taskResult.task.inputs;report.allInputsUnchanged=true;
  report.visualReview={status:'pending',note:'真实 player 截图核验通过不等于参考匹配或美术批准。'};
  report.finished=true;
}catch(error){report.error=String(error);report.finished=false;console.error(String(error));process.exitCode=1;}
finally{
  if(hostProcess&&hostEndpoint&&taskContext){try{await new HostClient(taskContext).shutdownForSwitch();}catch(error){report.shutdownError=String(error);}}
  await protocol.close();
  if(hostProcess)await new Promise(resolve=>{if(hostProcess.exitCode!==null||hostProcess.signalCode!==null)return resolve();hostProcess.once('exit',resolve);setTimeout(resolve,10000);});
  report.hostStopped=!!hostProcess&&(hostProcess.exitCode!==null||hostProcess.signalCode!==null);
  if(taskContext){try{await fs.access(path.join(taskContext.workspaceRoot,'.spine-mcp/writer.lock'));report.writerReleased=false;}catch{report.writerReleased=true;}}
  await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({reportPath,finished:report.finished,closedLoop:report.closedLoop?.passed??false,reference:report.referenceAfter?.referenceStatus??null,hostStopped:report.hostStopped}));
}
