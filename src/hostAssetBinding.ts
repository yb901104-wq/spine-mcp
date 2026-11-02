import { readFile } from 'node:fs/promises';
import type { ProjectManifest } from './projectSchema.js';
import { HostError, rejectFields } from './hostContracts.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { validateMotion } from './motionEngine.js';
import { validatePoseInput } from './poseSchemas.js';
import { poseDependencies } from './poseDigest.js';

export type AssetBinding = ProjectManifest['documents'][number];
export interface CommittedDocumentEntry {path:string;kind:string;characterId:string;sourceDocument:string;hash:string;documentId:string;assetBinding?:AssetBinding}
const conflict=(message:string):never=>{throw new HostError('PROJECT_BINDING_CONFLICT',message,409);};
/** 只信 journal 的已提交记录；普通修订继承绑定，新资产明确记录类型/参考来源。 */
export function managedDocumentBinding(file:string,manifest:ProjectManifest,index:CommittedDocumentEntry[],context:ToolContext):AssetBinding {
  const key=(p:string)=>{const absolute=resolveWorkspacePath(p,context);return process.platform==='win32'?absolute.toLowerCase():absolute;};
  const visited=new Set<string>();
  const find=(p:string):AssetBinding=>{
    const id=key(p),root=manifest.documents.find(d=>key(d.path)===id);if(root)return structuredClone(root);
    if(visited.has(id)||visited.size>=2048)conflict('受管来源循环或超过上限。');visited.add(id);
    const entries=index.filter(e=>key(e.path)===id);if(entries.length!==1)conflict('资产未登记或存在重复提交路径。');
    const entry=entries[0],source=find(entry.sourceDocument);
    if(source.characterId!==entry.characterId)conflict('资产来源角色不一致。');
    if(!entry.assetBinding){if(source.kind!==entry.kind)conflict('普通修订不能改变文档类型。');return {...source,path:p};}
    const binding=entry.assetBinding;
    rejectFields(binding,['path','kind','characterId','referencePosePath','sequencePath','stageId','standardPosePath']);
    if(!['pose','motion'].includes(binding.kind)||binding.kind!==entry.kind||binding.characterId!==entry.characterId||key(binding.path)!==id)conflict('新资产登记的路径、类型或角色不一致。');
    return structuredClone(binding);
  };
  return find(file);
}

/** Host 只核对结构与登记关系；数值、参考内容和视觉门禁仍由 MCP 执行。 */
export async function validateAssetBinding(value:any,binding:AssetBinding,manifest:ProjectManifest,index:CommittedDocumentEntry[],context:ToolContext,draftOnly=true) {
  rejectFields(binding,['path','kind','characterId','referencePosePath','sequencePath','stageId','standardPosePath']);
  const character=manifest.characters[binding.characterId];if(!character)conflict('新资产缺少受管角色。');
  const same=(a:any,b:any)=>typeof a==='string'&&typeof b==='string'&&resolveWorkspacePath(a,context)===resolveWorkspacePath(b,context);
  const pose=(file:string)=>{const b=managedDocumentBinding(file,manifest,index,context);if(b.kind!=='pose'||b.characterId!==binding.characterId)conflict('姿态依赖未登记在同一角色。');return b;};
  if(binding.standardPosePath)pose(binding.standardPosePath);
  if(binding.kind==='pose'){
    if(value.version!==1||!['standing','action'].includes(value.kind)||draftOnly&&(value.status!=='draft'||value.review||value.solution||value.reviewToken||value.authorization))conflict('新姿态只接收无求解/批准的 draft 候选。');
    validatePoseInput('frame',value.frame);
    if(!same(value.filePath,character.skeletonPath)||!same(value.mappingPath,character.mappingPath)||value.visualRigPath&&!same(value.visualRigPath,character.visualRigPath))conflict('新姿态角色资源绑定不符。');
    for(const field of ['referencePosePath','sequencePath','standardPosePath','stageId']as const)if((value[field]??undefined)!==binding[field])conflict(`新姿态 ${field} 未精确登记。`);
    if(value.kind==='action'&&!binding.standardPosePath)conflict('动作姿态必须登记标准站姿。');
    if(value.reference&&!binding.referencePosePath)conflict('参考动作必须登记已审查标注。');
  }else if(binding.kind==='motion'){
    validateMotion(value);if(value.version!==2||!value.poseWorkflow||value.poseWorkflow.standardPosePath!==binding.standardPosePath)conflict('只登记具有标准/关键姿态来源的 v2 motion。');
    if(!Array.isArray(value.poseWorkflow.keyPoses)||value.poseWorkflow.keyPoses.length<2||value.poseWorkflow.keyPoses.length>2000)conflict('motion 登记必须包含 2–2000 项关键姿态来源。');
    for(const k of value.poseWorkflow.keyPoses){const b=pose(k.posePath);if(b.stageId&&b.stageId!==k.stageId)conflict('motion 阶段与姿态登记不符。');}
  }else conflict('资产创建只支持 pose/motion，不能创建或覆盖骨架源文件。');
  if(binding.referencePosePath&&!manifest.references.posePaths.some(p=>same(p,binding.referencePosePath)))conflict('参考标注未在根清单登记。');
  if(binding.sequencePath){
    if(!manifest.references.sequencePaths.some(p=>same(p,binding.sequencePath)))conflict('动作级参考未在根清单登记。');
    const sequence=JSON.parse(await readFile(resolveWorkspacePath(binding.sequencePath,context),'utf8'));
    const stages=sequence.stages?.filter((s:any)=>s.stageId===binding.stageId);
    if(stages?.length!==1||!same(stages[0].referencePosePath,binding.referencePosePath))conflict('动作阶段与参考标注不一致。');
  }
}

export async function assetDependencies(value:any,binding:AssetBinding,manifest:ProjectManifest,context:ToolContext){
  const character=manifest.characters[binding.characterId],values=new Map<string,Buffer>();
  if(binding.kind==='pose')return (await poseDependencies(value,context,values)).dependencies;
  await poseDependencies({filePath:character.skeletonPath,mappingPath:character.mappingPath,visualRigPath:character.visualRigPath,standardPosePath:binding.standardPosePath},context,values);
  for(const k of value.poseWorkflow.keyPoses){
    if(values.size>2048)conflict('资产依赖图超过上限。');
    const bytes=await readFile(resolveWorkspacePath(k.posePath,context));values.set(k.posePath,bytes);
    await poseDependencies({...JSON.parse(bytes.toString()),standardPosePath:k.posePath},context,values);
  }
  return (await poseDependencies({},context,values)).dependencies;
}
