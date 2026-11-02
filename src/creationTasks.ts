import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, unlink, copyFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, createProject } from './projectModel.js';
import { registerWorkspace } from './workspaceTools.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { hostClient } from './hostClient.js';
import { HostError, objectHash, strictHash, assertVersion } from './hostContracts.js';
import { withFileLock } from './jobTools.js';
import { partObservationPolicyFingerprint, policyFingerprint } from './poseGraph.js';
import { versionSchema } from './hostTools.js';
import { summarizeState } from './creationQuality.js';
import { poseDependencies } from './poseDigest.js';
import { runtimeBuildIdentity } from './buildIdentity.js';
import { readCommittedIndex, readDiagnosticIndex, HostJournal } from './hostJournal.js';
import { assetDependencies, managedDocumentBinding } from './hostAssetBinding.js';
import type { ProjectManifest } from './projectSchema.js';
import { validatePoseSequence } from './poseSequence.js';
import { strictFileChecks } from './strictFileChecks.js';

const base='.spine-mcp/creation-tasks';
const file={type:'string',minLength:1,description:'工作区内相对路径。'};
const taskId={type:'string',pattern:'^[a-zA-Z0-9_-]{1,80}$'};
const stages={type:'array',maxItems:64,default:[],description:'已有受管阶段；省略或空数组先进入参考准备，不创建或编造目标姿态。',items:{type:'object',additionalProperties:false,properties:{stageId:{type:'string',minLength:1},documentPath:file,referencePosePath:file},required:['stageId','documentPath']}};
export const creationToolDefinitions=[
  {name:'spine_start_creation_task',description:'冻结受管角色、原参考与阶段文档，建立持续创作任务及计量。stages 可省略以先准备参考；已有阶段可引用根清单或已确认提交的新修订。可用 isolatedDirectory 新建独立副本，不复制旧 journal。默认 dryRun；不批准参考、不改源角色，不接管 Writer。',inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string'},characterId:{type:'string'},referencePath:file,sequencePath:file,stages,isolatedDirectory:{...file,description:'可选新目录；只复制已声明资源及依赖，创建独立工程 ID，不覆盖现有目录。'},dryRun:{type:'boolean',default:true}},required:['characterId','referencePath']}},
  {name:'spine_get_creation_task',description:'读取冻结输入、新鲜度、当前 Host 完整版本、阶段、失败和调用计量；不求解、不自动恢复批准，token 未取得时为 null。',inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string'},taskId,eventOffset:{type:'integer',minimum:0},eventLimit:{type:'integer',minimum:1,maximum:100,default:20}},required:['taskId']}},
  {name:'spine_select_creation_stage',description:'显式选择任务阶段；documentPath 可选择该阶段经正式提交的后续修订，逐次核对 journal、字节与固定绑定。省略时打开冻结原文档。默认 dryRun，不自动 pin/批准，不绕过未保存修改或旧 journal。',inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string'},taskId,stageId:{type:'string'},documentPath:file,expectedRevision:versionSchema,dryRun:{type:'boolean',default:true}},required:['taskId','stageId']}}
];
function taskFile(id:string){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new HostError('INVALID_ARGUMENT','taskId 格式无效。');return `${base}/${id}.json`;}
async function readTask(id:string,c:ToolContext){const r=JSON.parse(await readFile(resolveWorkspacePath(taskFile(id),c),'utf8'));if(r.schemaVersion!==1||r.taskId!==id||r.projectId!==c.projectId||!Array.isArray(r.inputs)||r.inputs.length>4096||!Array.isArray(r.stages)||r.stages.length>64||r.inputs.some((v:any)=>typeof v.path!=='string'||!/^[a-f0-9]{64}$/.test(v.hash)))throw new HostError('PROJECT_BINDING_CONFLICT','任务格式、身份或工作区不匹配。',409);return r;}
const pathKey=(file:string,c:ToolContext)=>{const p=resolveWorkspacePath(file,c);return process.platform==='win32'?p.toLowerCase():p;};
async function taskBinding(file:string,manifest:ProjectManifest,index:Awaited<ReturnType<typeof readCommittedIndex>>,c:ToolContext){
  const key=pathKey(file,c),root=manifest.documents.find(d=>pathKey(d.path,c)===key),binding=managedDocumentBinding(file,manifest,index,c);
  if(!root){const entries=index.filter(e=>pathKey(e.path,c)===key);if(entries.length!==1||strictHash(await readFile(resolveWorkspacePath(file,c)))!==entries[0].hash)throw new HostError('PROJECT_BINDING_CONFLICT','任务文档字节与已确认提交记录不一致。',409);}
  return binding;
}
function descendsFrom(file:string,source:string,index:Awaited<ReturnType<typeof readCommittedIndex>>,c:ToolContext){
  const target=pathKey(source,c),seen=new Set<string>();let current=file;
  while(pathKey(current,c)!==target){const key=pathKey(current,c);if(seen.has(key)||seen.size>=2048)return false;seen.add(key);const entries=index.filter(e=>pathKey(e.path,c)===key);if(entries.length!==1)return false;current=entries[0].sourceDocument;}
  return true;
}
function taskNextAction(record:any,c:ToolContext){return record.stages.length?{tool:'spine_select_creation_stage',projectId:c.projectId,taskId:record.taskId,stageId:record.stages[0].stageId,dryRun:true}:record.sequencePath?{tool:'spine_validate_pose_sequence',arguments:{projectId:c.projectId,sequencePath:record.sequencePath},instruction:'动作级参考已登记；重验固定关系后用正式姿态创建/适配入口生成候选，失败不批准。'}:{tool:'spine_analyze_reference_gif',arguments:{projectId:c.projectId,filePath:record.referencePath,outputDir:`output/reports/reference-${record.taskId}`,loop:false},instruction:'先拆帧并保持原时序，再逐帧标注及审查参考；不猜测关节或自动批准。'};}
async function writeRecord(file:string,value:any,c:ToolContext,replace=false){
  const absolute=resolveWorkspacePath(file,c);await mkdir(path.dirname(absolute),{recursive:true});
  const temp=replace?resolveWorkspacePath(`${file}.${randomUUID()}.tmp`,c):absolute;
  try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}if(replace)await rename(temp,absolute);}finally{if(replace)await unlink(temp).catch(()=>{});}
}
async function frozenInputs(task:any,c:ToolContext){
  const changed=[];for(const input of task.inputs){try{if(strictHash(await readFile(resolveWorkspacePath(input.path,c)))!==input.hash)changed.push(input.path);}catch{changed.push(input.path);}}
  if(task.policy?.policyFingerprint!==policyFingerprint||task.policy?.partObservationPolicyFingerprint!==partObservationPolicyFingerprint)changed.push('comparisonPolicy');
  if(task.runtime?.buildFingerprint!==(await runtimeBuildIdentity).buildFingerprint)changed.push('runtimeBuild');
  return {current:changed.length===0,changed};
}
async function start(args:any,c:ToolContext,preparingIsolation=false):Promise<any>{
  args={...args,stages:args.stages??[]};
  if(args.isolatedDirectory!==undefined)return startIsolated(args,c);
  const project=await loadProject(c);if(project.mode!=='managed')throw new HostError('PROJECT_MANIFEST_REQUIRED','先使用 spine_create_project 初始化受管工程；此工具不隐式创建或覆盖 manifest。',409);
  const character=project.manifest.characters[args.characterId];if(!character)throw new HostError('PROJECT_BINDING_CONFLICT','角色未在工程登记。',409);
  if(new Set(args.stages.map((s:any)=>s.stageId)).size!==args.stages.length)throw new HostError('INVALID_ARGUMENT','阶段 ID 不能重复。');
  const files=new Set<string>(['.spine-workflow.json',args.referencePath,...Object.entries(character).filter(([key])=>key.endsWith('Path')).map(([,value])=>String(value))]);
  if(args.sequencePath){
    if(!project.manifest.references.sequencePaths.includes(args.sequencePath)){
      if(!preparingIsolation||args.stages.length)throw new HostError('PROJECT_BINDING_CONFLICT','新 sequencePath 只可在新隔离副本的空阶段准备任务中登记；不能改写已有阶段绑定。',409);
      const report=await validatePoseSequence({sequencePath:args.sequencePath},c);if(!report.ok)throw new HostError('PROJECT_BINDING_CONFLICT','新动作记录尚未通过参考关系校验。',409,report);
      const sequence=JSON.parse(await readFile(resolveWorkspacePath(args.sequencePath,c),'utf8'));
      if(!character.visualRigPath||pathKey(sequence.visualRigPath,c)!==pathKey(character.visualRigPath,c))throw new HostError('PROJECT_BINDING_CONFLICT','新动作记录的视觉绑定不属于当前受管角色。',409);
      for(const stage of sequence.stages){files.add(stage.referencePosePath);for(const dep of(await poseDependencies({referencePosePath:stage.referencePosePath},c)).dependencies)files.add(dep.filePath);}
    }
    files.add(args.sequencePath);
    // 准备任务还没有目标姿态时，也必须冻结序列引用的标注、原图与审查依据。
    const sequence=JSON.parse(await readFile(resolveWorkspacePath(args.sequencePath,c),'utf8'));
    for(const stage of sequence.stages??[]){files.add(stage.referencePosePath);for(const dep of(await poseDependencies({referencePosePath:stage.referencePosePath},c)).dependencies)files.add(dep.filePath);}
  }
  const index=await readCommittedIndex(c);
  for(const dependency of (await poseDependencies({filePath:character.skeletonPath,mappingPath:character.mappingPath,visualRigPath:character.visualRigPath},c)).dependencies)files.add(dependency.filePath);
  for(const stage of args.stages){
    const binding=await taskBinding(stage.documentPath,project.manifest,index,c);
    if(binding.characterId!==args.characterId)throw new HostError('PROJECT_BINDING_CONFLICT','阶段文档未绑定当前角色。',409);
    if(binding.stageId&&binding.stageId!==stage.stageId||binding.sequencePath&&binding.sequencePath!==args.sequencePath||stage.referencePosePath&&binding.referencePosePath!==stage.referencePosePath)throw new HostError('PROJECT_BINDING_CONFLICT','阶段/参考与文档绑定不一致。',409);
    files.add(stage.documentPath);for(const field of ['referencePosePath','sequencePath','standardPosePath']as const)if(binding[field])files.add(binding[field]!);
    const value=JSON.parse(await readFile(resolveWorkspacePath(stage.documentPath,c),'utf8'));
    if(binding.kind==='pose')for(const d of (await poseDependencies(value,c)).dependencies)files.add(d.filePath);
    else if(binding.kind==='motion')for(const d of await assetDependencies(value,binding,project.manifest,c))files.add(d.filePath);
  }
  // atlas 页面也是冻结输入，不只记录 JSON；路径解析仍限制在工作区。
  const {TextureAtlas}=await import('@esotericsoftware/spine-core');
  const atlas=new TextureAtlas(await readFile(resolveWorkspacePath(character.atlasPath,c),'utf8'));
  const mapping=JSON.parse(await readFile(resolveWorkspacePath(character.mappingPath,c),'utf8'));if(mapping.reportPath)files.add(mapping.reportPath);
  for(const page of atlas.pages)files.add(path.posix.join(path.posix.dirname(character.atlasPath.replace(/\\/g,'/')),page.name));
  const inputs=await Promise.all([...files].sort().map(async p=>({path:p,hash:strictHash(await readFile(resolveWorkspacePath(p,c)))})));
  const record={schemaVersion:1,taskId:randomUUID(),projectId:c.projectId,characterId:args.characterId,referencePath:args.referencePath,sequencePath:args.sequencePath??null,stages:args.stages,phase:args.stages.length?'editing':'referencePreparation',
    createdAt:new Date().toISOString(),inputs,inputsFingerprint:objectHash(inputs),policy:{policyFingerprint,partObservationPolicyFingerprint},runtime:{...await runtimeBuildIdentity,node:process.version,platform:process.platform,moduleHash:strictHash(await readFile(fileURLToPath(import.meta.url)))},
    scope:{bodyOnly:true,weapons:false,loop:false},externalDependencies:{secondCharacter:'未提供合适的第二真实角色，不使用拆分皮肤案例。',editorImport:'尚未取得真实 Spine 编辑器导入证据；runtime 不替代导入。'},tokens:null};
  if(args.dryRun!==false)return {ok:true,dryRun:true,candidate:record,nextAction:{tool:'spine_start_creation_task',instruction:'确认冻结范围后 dryRun:false 仅创建任务元数据。'}};
  return withFileLock(`${base}/active.json`,c,async()=>{await writeRecord(taskFile(record.taskId),record,c);await writeRecord(`${base}/active.json`,{taskId:record.taskId,stageId:null},c,true);return {ok:true,dryRun:false,taskId:record.taskId,phase:record.phase,taskContext:{projectId:c.projectId,workspaceRoot:c.workspaceRoot},recordPath:taskFile(record.taskId),inputsFingerprint:record.inputsFingerprint,nextAction:taskNextAction(record,c)};});
}
async function startIsolated(args:any,c:ToolContext):Promise<any>{
  const {isolatedDirectory,...plain}=args;
  if(typeof isolatedDirectory!=='string'||path.win32.isAbsolute(isolatedDirectory)||path.posix.isAbsolute(isolatedDirectory)||isolatedDirectory.replace(/\\/g,'/').split('/').some(p=>!p||p==='..'||p==='.'||/^(?:\.git|\.codex|\.agents|\.spine-mcp|node_modules|dist|backups|test-output)$/i.test(p)))throw new HostError('PATH_FORBIDDEN','隔离目录须为当前工作区内普通的新相对目录。',403);
  const root=resolveWorkspacePath(isolatedDirectory,c);try{await lstat(root);throw new HostError('TARGET_STALE','隔离目录已存在；不合并旧 journal，请选择新路径。',409);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const candidate=(await start({...plain,dryRun:true},c,true)).candidate;
  const project=await loadProject(c);if(project.mode!=='managed')throw new HostError('PROJECT_MANIFEST_REQUIRED','缺少受管工程。',409);
  const files=new Set<string>(candidate.inputs.map((v:any)=>v.path));
  for(const binding of Object.values(project.manifest.characters)){
    files.add(binding.skeletonPath);files.add(binding.mappingPath);files.add(binding.atlasPath);if(binding.visualRigPath)files.add(binding.visualRigPath);
    const mapping=JSON.parse(await readFile(resolveWorkspacePath(binding.mappingPath,c),'utf8'));if(mapping.reportPath)files.add(mapping.reportPath);
    for(const dependency of (await poseDependencies({filePath:binding.skeletonPath,mappingPath:binding.mappingPath,visualRigPath:binding.visualRigPath},c)).dependencies)files.add(dependency.filePath);
  }
  for(const d of project.manifest.documents){files.add(d.path);if(d.kind==='pose')for(const dep of (await poseDependencies(JSON.parse(await readFile(resolveWorkspacePath(d.path,c),'utf8')),c)).dependencies)files.add(dep.filePath);else if(d.kind==='motion')for(const dep of await assetDependencies(JSON.parse(await readFile(resolveWorkspacePath(d.path,c),'utf8')),d,project.manifest,c))files.add(dep.filePath);}
  for(const file of [...project.manifest.references.posePaths,...project.manifest.references.sequencePaths]){files.add(file);for(const dep of (await poseDependencies({referencePosePath:file},c)).dependencies)files.add(dep.filePath);}
  const inputs=await Promise.all([...files].sort().map(async file=>({path:file,hash:strictHash(await readFile(resolveWorkspacePath(file,c)))})));
  for(const input of inputs)if(/^(?:\.git|\.codex|\.agents|node_modules|dist|backups|test-output)(?:\/|$)/i.test(input.path.replace(/\\/g,'/'))||/^\.spine-mcp\/(?!live\/|captures\/)/i.test(input.path.replace(/\\/g,'/')))throw new HostError('PATH_FORBIDDEN','隔离资源不能包含配置、凭据、Writer、journal 或任务控制文件。',403);
  if(args.dryRun!==false)return {ok:true,dryRun:true,isolatedDirectory,sourceInputs:inputs,sourceTask:candidate,message:'只复制声明资源与审查依据；新副本的旧求解/批准须重新验证，不复制 Host journal、Writer 或提交令牌。'};
  await mkdir(path.dirname(root),{recursive:true});await mkdir(root);const nextContext={workspaceRoot:root,projectId:`creation-${randomUUID()}`};
  for(const input of inputs){if(input.path==='.spine-workflow.json')continue;const source=resolveWorkspacePath(input.path,c),target=resolveWorkspacePath(input.path,nextContext);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);if(strictHash(await readFile(target))!==input.hash||strictHash(await readFile(source))!==input.hash)throw new HostError('TARGET_STALE','隔离复制期间源资源发生变化；保留未完成副本供检查，未创建受管清单。',409);}
  await registerWorkspace({rootPath:root,projectId:nextContext.projectId,setActive:false});
  const documents=[...project.manifest.documents],index=await readCommittedIndex(c);
  // 已提交修订在新副本中显式登记为根文档；不复制旧 journal 或提交令牌。
  for(const entry of index)if(files.has(entry.path)&&!documents.some(d=>pathKey(d.path,c)===pathKey(entry.path,c)))documents.push(await taskBinding(entry.path,project.manifest,index,c));
  const references=structuredClone(project.manifest.references);
  if(plain.sequencePath&&!references.sequencePaths.includes(plain.sequencePath)){
    references.sequencePaths.push(plain.sequencePath);const sequence=JSON.parse(await readFile(resolveWorkspacePath(plain.sequencePath,nextContext),'utf8'));
    for(const stage of sequence.stages)if(!references.posePaths.includes(stage.referencePosePath))references.posePaths.push(stage.referencePosePath);
  }
  await createProject({manifest:{...project.manifest,documents,references,projectId:nextContext.projectId,name:`${project.manifest.name}（创作隔离）`},expectedAbsent:true,dryRun:false},nextContext);
  await writeRecord('.spine-mcp/creation-isolation.json',{schemaVersion:1,sourceRoot:c.workspaceRoot,registryRoot:process.env.SPINE_MCP_REGISTRY_ROOT??process.env.SPINE_MCP_WORKSPACE??process.cwd(),createdAt:new Date().toISOString(),sourceInputs:inputs,sourceInputsFingerprint:objectHash(inputs),journalCopied:false},nextContext);
  return {...await start({...plain,projectId:nextContext.projectId,dryRun:false},nextContext),isolation:{sourceUnchanged:true,journalCopied:false,workspaceRoot:root}};
}
async function get(args:any,c:ToolContext){
  const record=await readTask(args.taskId,c),freshness=await frozenInputs(record,c),state=await hostClient(c).state({autostart:false});
  const project=await loadProject(c),index=await readCommittedIndex(c),stageContexts=[];
  const diagnosticContexts=[];
  const diagnostics=(await readDiagnosticIndex(c)).filter(d=>d.binding?.characterId===record.characterId&&d.binding?.sequencePath===record.sequencePath);
  for(const d of diagnostics.slice(-20)){
    let verified=false,reason:string|null=null;
    try{if(!Array.isArray(d.dependencies)||d.dependencies.length>4096||d.policyFingerprint!==policyFingerprint)throw Error('诊断依赖或策略不能核验。');const checks=await strictFileChecks(d.dependencies,file=>resolveWorkspacePath(file,c));verified=checks.every(v=>!v.error&&v.actual===v.hash);if(!verified)reason='诊断来源或依赖已变化。';}catch(error){reason=String(error);}
    diagnosticContexts.push({diagnosticId:d.diagnosticId,stageId:d.binding.stageId,referencePosePath:d.binding.referencePosePath,documentPath:d.binding.path,sourcePath:d.sourcePath,sourceHash:d.sourceHash,proposedOutputPath:d.proposedOutputPath,lastEditRevision:d.lastEditRevision,committedOutputPath:d.committedOutputPath,verified,reason,memoryOnly:!d.committedOutputPath,status:d.committedOutputPath?'committed':'memoryDraft',approved:false,
      current:state.activeDoc?.diagnosticId===d.diagnosticId||!!(d.committedOutputPath&&state.activeDoc?.path&&pathKey(state.activeDoc.path,c)===pathKey(d.committedOutputPath,c)),nextAction:verified&&freshness.current&&state.available?d.committedOutputPath?{tool:'spine_host_open',arguments:{projectId:c.projectId,path:d.committedOutputPath,...state.version?{expectedRevision:state.version}:{}},instruction:'已另存为受管新修订；打开真实输出，不恢复旧内存草稿。'}:state.capabilities?.editing?.profile==='c2-pose'?{tool:'spine_resume_diagnostic_pose',arguments:{projectId:c.projectId,diagnosticId:d.diagnosticId,...state.version?{expectedRevision:state.version}:{},dryRun:true}}:null:null,
      note:'这不是正式资产；离线先显式启动隔离 Host --resume，实际恢复前预演来源与差异。'});
  }
  if(project.mode==='managed')for(const stage of record.stages){
    const entries=index.filter(e=>descendsFrom(e.path,stage.documentPath,index,c));
    const candidates=[];
    for(const entry of entries.slice(-20)){try{const binding=await taskBinding(entry.path,project.manifest,index,c);const source=await taskBinding(stage.documentPath,project.manifest,index,c);assertStageBinding(binding,source,c);candidates.push({documentPath:entry.path,hash:entry.hash,verified:true,approval:'需当前版本重新审查',nextAction:freshness.current?{tool:'spine_select_creation_stage',arguments:{projectId:c.projectId,taskId:record.taskId,stageId:stage.stageId,documentPath:entry.path,...state.version?{expectedRevision:state.version}:{},dryRun:true}}:null});}catch(error){candidates.push({documentPath:entry.path,hash:entry.hash,verified:false,reason:String(error)});}}
    stageContexts.push({...stage,candidates,truncated:entries.length>20,currentDocumentPath:state.activeDoc?.path&&descendsFrom(state.activeDoc.path,stage.documentPath,index,c)?state.activeDoc.path:null});
  }
  let events:any[]=[];try{events=(await readFile(resolveWorkspacePath(`${base}/${args.taskId}.jsonl`,c),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const offset=args.eventOffset??0,limit=args.eventLimit??20;
  const currentStage=stageContexts.find(s=>s.currentDocumentPath)??diagnosticContexts.find(d=>d.current);
  return {ok:true,task:record,freshness,stageContexts,diagnosticContexts,diagnosticContextsTruncated:diagnostics.length>20,currentStageId:currentStage?.stageId??null,nextAction:freshness.current?currentStage?{tool:'spine_preview_state',arguments:{projectId:c.projectId},instruction:'当前 Host 已在该任务阶段；按当前 readiness 和完整版本继续，不自动跳回原始修订。'}:taskNextAction(record,c):null,hostStateScope:'当前工作区的实际 Host；stage 选择和版本须另行核对，不能把旧任务当作当前活动文档。',state:summarizeState(state),metrics:{calls:events.length,durationMs:events.reduce((v,e)=>v+e.durationMs,0),textBytes:events.reduce((v,e)=>v+e.textBytes,0),images:events.reduce((v,e)=>v+e.images,0),tokens:null,scope:'任务建立后已成功落盘的 MCP 回执；不含浏览器 HTTP/模型推理及日志失败，完整性须与客户端调用日志核对。'},events:events.slice(offset,offset+limit),nextOffset:offset+limit<events.length?offset+limit:null};
}
function assertStageBinding(binding:ProjectManifest['documents'][number],source:ProjectManifest['documents'][number],c:ToolContext){
  for(const key of ['kind','characterId','stageId','referencePosePath','sequencePath','standardPosePath']as const){const a=binding[key],b=source[key];if(a===b)continue;if(key.endsWith('Path')&&a&&b&&pathKey(a,c)===pathKey(b,c))continue;throw new HostError('PROJECT_BINDING_CONFLICT',`任务修订改变了固定阶段绑定 ${key}。`,409);}
}
async function select(args:any,c:ToolContext,signal?:AbortSignal){
  const record=await readTask(args.taskId,c),stage=record.stages.find((s:any)=>s.stageId===args.stageId);
  if(!stage)throw new HostError('INVALID_ARGUMENT','任务不存在该阶段。');
  const project=await loadProject(c),index=await readCommittedIndex(c),binding=project.mode==='managed'?await taskBinding(stage.documentPath,project.manifest,index,c):null;
  if(!binding||binding.stageId&&binding.stageId!==stage.stageId||binding.sequencePath&&binding.sequencePath!==record.sequencePath||stage.referencePosePath&&binding.referencePosePath!==stage.referencePosePath)throw new HostError('PROJECT_BINDING_CONFLICT','任务阶段与当前工程角色/参考绑定不一致；不能通过任务元数据换身份。',409);
  const fresh=await frozenInputs(record,c);if(!fresh.current)throw new HostError('TARGET_STALE','冻结输入已变化；先复核并新建任务，不能继承旧批准。',409,fresh);
  const documentPath=args.documentPath??stage.documentPath;
  if(!descendsFrom(documentPath,stage.documentPath,index,c))throw new HostError('PROJECT_BINDING_CONFLICT','只能选择该阶段原文档或其正式提交的新修订，不能切换到其它姿态族。',409);
  if(project.mode!=='managed'||!binding)throw new HostError('PROJECT_BINDING_CONFLICT','任务工程不可用。',409);
  assertStageBinding(await taskBinding(documentPath,project.manifest,index,c),binding,c);
  const client=hostClient(c),before=await client.state({autostart:false});if(before.version)assertVersion(args.expectedRevision,before.version);
  if(signal?.aborted)throw new HostError('TASK_CANCELLED','选择阶段已取消。',409);
  if(args.dryRun!==false)return {ok:true,dryRun:true,stage,documentPath,version:before.version,nextAction:{tool:'spine_select_creation_stage',...args,dryRun:false}};
  const opened=await client.open({path:documentPath,...before.version?{expectedRevision:args.expectedRevision}:{}},signal);
  await withFileLock(`${base}/active.json`,c,()=>writeRecord(`${base}/active.json`,{taskId:record.taskId,stageId:stage.stageId,documentPath},c,true));
  return {ok:true,dryRun:false,taskId:record.taskId,stage,documentPath,version:opened.version,state:summarizeState(opened),nextAction:opened.capabilities?.operations?.find((op:any)=>op.operation==='pin')?.canRun?{tool:'spine_host_pin',expectedRevision:opened.version}:null};
}
export async function callCreationTool(name:string,args:any,c:ToolContext,signal?:AbortSignal){return name==='spine_start_creation_task'?start(args,c):name==='spine_get_creation_task'?get(args,c):select(args,c,signal);}

/** 仅记录 MCP 可见成本；日志失败由调用者单列，不能把已完成写入改报失败。 */
export async function recordCreationCall(c:ToolContext,event:{tool:string;durationMs:number;textBytes:number;images:number;error:boolean;version?:any}){
  let active:any;try{active=JSON.parse(await readFile(resolveWorkspacePath(`${base}/active.json`,c),'utf8'));}catch(e:any){if(e.code==='ENOENT')return;throw e;}
  const task=await readTask(active.taskId,c);
  let stageId=active.stageId,diagnosticId:string|null=null,contextMatch:string|null=null;
  if(/^[a-f0-9]{64}$/.test(event.version?.documentId??'')){const records=await new HostJournal(event.version.documentId,c).read(),header=records[0],diagnostic=header?.documentId===event.version.documentId?header.diagnostic:null;if(diagnostic){diagnosticId=diagnostic.id;const matches=diagnostic.binding?.characterId===task.characterId&&diagnostic.binding?.sequencePath===task.sequencePath;stageId=matches?diagnostic.binding.stageId:null;contextMatch=matches?'taskSequence':'otherContext';}}
  const target=`${base}/${active.taskId}.jsonl`;
  await withFileLock(target,c,async()=>{await appendFile(resolveWorkspacePath(target,c),JSON.stringify({at:new Date().toISOString(),taskId:active.taskId,stageId,diagnosticId,contextMatch,...event,tokens:null})+'\n',{mode:0o600});});
}
