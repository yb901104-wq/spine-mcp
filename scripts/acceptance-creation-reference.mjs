// 正式 MCP：原 GIF 准备任务、拆帧、复用已审查标注创建新序列、在新副本登记；不手改清单。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {strictHash} from '../dist/hostContracts.js';
const sourceRoot=path.resolve(process.argv[2]??'D:/AI_cc/spine test/body-reference-trials/2026-10-24T15-53-20-542Z');
const sourceManifest=JSON.parse(await fs.readFile(path.join(sourceRoot,'.spine-workflow.json'),'utf8'));
const sourceSequence=JSON.parse(await fs.readFile(path.join(sourceRoot,'reference/body.sequence.json'),'utf8'));
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),reportPath=`docs/plans/creation-reference-${stamp}.json`,client=new Client({name:'creation-reference-real-npc1',version:'1'});
const report={schemaVersion:1,at:new Date().toISOString(),sourceRoot,scope:'使用原 GIF，复用原有已审查 ready 标注；验证正式准备/序列创建/新副本登记，不宣称重新标注或参考匹配成功。',calls:[],passed:false};let context={workspaceRoot:sourceRoot,projectId:sourceManifest.projectId};
async function call(name,args={},allowError=false){const start=performance.now(),r=await client.callTool({name,arguments:{projectId:context.projectId,...args}}),text=r.content.filter(c=>c.type==='text').map(c=>c.text).join(''),v=JSON.parse(text);report.calls.push({tool:name,durationMs:performance.now()-start,textBytes:Buffer.byteLength(text),error:r.isError===true,code:v.code??null});if(r.isError&&!allowError)throw Error(`${name}: ${text}`);return {...v,isError:r.isError===true};}
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:sourceRoot,SPINE_MCP_REGISTRY_ROOT:sourceRoot,SPINE_HOST_AUTOSTART:'0'}}));
  await call('spine_register_workspace',{rootPath:sourceRoot,projectId:sourceManifest.projectId});
  const task=await call('spine_start_creation_task',{characterId:'npc1',referencePath:'reference/body.gif',isolatedDirectory:`creation-reference-trials/${stamp}`,dryRun:false});context=task.taskContext;assert.equal(task.phase,'referencePreparation');report.preparationTask={taskId:task.taskId,...context};
  const beforeManifest=strictHash(await fs.readFile(path.join(context.workspaceRoot,'.spine-workflow.json')));
  const analysis=await call('spine_analyze_reference_gif',{filePath:'reference/body.gif',outputDir:'output/reports/reference-frames',loop:false});assert.equal(analysis.frames,undefined);assert.equal(analysis.frameCount,171);assert.equal(analysis.loop,false);report.gif={manifestPath:analysis.manifestPath,frameCount:analysis.frameCount,duration:analysis.duration,sourceHash:analysis.sourceHash,loop:analysis.loop};
  const keys=await call('spine_extract_reference_keyframes',{manifestPath:analysis.manifestPath,count:3});assert.equal(keys.keyframes.length,3);report.keyframes=keys.keyframes;
  const args={sequencePath:'reference/body-created.sequence.json',id:`body-created-${stamp}`,basis:'复用已审查的原参考起始帧，仅验证正式序列创建与新副本登记；身体动作尚未通过，不扩展到其它未标注阶段。',confirmedBy:'Agent：复用本项目既有标注审查记录',visualRigPath:sourceSequence.visualRigPath,correspondence:sourceSequence.correspondence,weaponHand:null,stages:sourceSequence.stages.map(({stageId,referencePosePath})=>({stageId,referencePosePath}))};
  const dry=await call('spine_create_pose_sequence',args);assert.equal(dry.dryRun,true);await assert.rejects(fs.access(path.join(context.workspaceRoot,args.sequencePath)),e=>e.code==='ENOENT');
  const created=await call('spine_create_pose_sequence',{...args,dryRun:false});assert.equal(created.validation.ok,true);assert.equal(created.approvedAnimation,false);assert.equal(created.registered,false);report.sequence={path:args.sequencePath,fingerprint:created.validation.fingerprint,approvedAnimation:false};
  const overwrite=await call('spine_create_pose_sequence',{...args,dryRun:false},true);assert.equal(overwrite.isError,true);report.overwriteDenied=true;
  const premature=await call('spine_start_creation_task',{characterId:'npc1',referencePath:'reference/body.gif',sequencePath:args.sequencePath,dryRun:false},true);assert.equal(premature.isError,true);report.inPlaceBindingChangeDenied=true;
  const onboarding=await call('spine_start_creation_task',{characterId:'npc1',referencePath:'reference/body.gif',sequencePath:args.sequencePath,isolatedDirectory:'prepared-reference',dryRun:false});report.onboarding={taskId:onboarding.taskId,...onboarding.taskContext};
  const manifest=JSON.parse(await fs.readFile(path.join(onboarding.taskContext.workspaceRoot,'.spine-workflow.json'),'utf8'));assert.ok(manifest.references.sequencePaths.includes(args.sequencePath));
  assert.equal(strictHash(await fs.readFile(path.join(context.workspaceRoot,'.spine-workflow.json'))),beforeManifest);report.sourceManifestUnchanged=true;
  const original=await call('spine_get_creation_task',{taskId:task.taskId});assert.equal(original.freshness.current,true);report.preparationInputsUnchanged=true;
  context=onboarding.taskContext;
  const current=await call('spine_get_creation_task',{taskId:onboarding.taskId});assert.equal(current.freshness.current,true);assert.deepEqual(current.stageContexts,[]);report.onboardingInputsUnchanged=true;report.nextAction=current.nextAction;
  const validate=await call('spine_validate_pose_sequence',{sequencePath:args.sequencePath});assert.equal(validate.ok,true);report.revalidated=true;
  for(const root of [report.preparationTask.workspaceRoot,context.workspaceRoot]){await assert.rejects(fs.access(path.join(root,'.spine-mcp/host-port.json')),e=>e.code==='ENOENT');await assert.rejects(fs.access(path.join(root,'.spine-mcp/writer.lock')),e=>e.code==='ENOENT');await assert.rejects(fs.access(path.join(root,'.spine-mcp/journals')),e=>e.code==='ENOENT');}
  report.noHostOrWriterOrCopiedJournal=true;report.referencePoseApprovedByThisRun=false;report.formalAnimationDelivered=false;report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{await client.close();await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({reportPath,passed:report.passed,error:report.error??null}));}
