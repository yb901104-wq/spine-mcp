import { randomUUID } from 'node:crypto';
import { HostDocumentStore, editableValue, type HostDocument } from './hostDocumentStore.js';
import { validateAssetBinding, assetDependencies, type AssetBinding } from './hostAssetBinding.js';
import { readCommittedIndex } from './hostJournal.js';
import { objectHash, strictHash, HostError } from './hostContracts.js';
import { policyFingerprint,referenceBendDirections } from './poseGraph.js';
import { type ToolContext } from './spineJson.js';
import { strictFileChecks } from './strictFileChecks.js';
import { readFile } from 'node:fs/promises';
import { sequenceForPose } from './poseSequence.js';
import { requireReferencePose } from './referencePose.js';

export interface DiagnosticPoseContext {
  id:string; sourcePath:string; sourceHash:string; proposedOutputPath:string;
  binding:AssetBinding; baselineHash:string; policyFingerprint:string;
}
export function diagnosticIdentity(context:Omit<DiagnosticPoseContext,'id'>,projectId:string|undefined){
  return objectHash({projectId,sourcePath:context.sourcePath,sourceHash:context.sourceHash,baselineHash:context.baselineHash,
    binding:{...context.binding,path:context.proposedOutputPath},policyFingerprint:context.policyFingerprint});
}
/** 仅装配受管资源、绑定和依赖；不求解、不批准，不创建姿态资产文件。 */
export async function buildDiagnosticPose(input:{sourcePath:string;sourceHash:string;document:any;outputPath:string;characterId:string},sessionId:string,c:ToolContext){
  const reader=new HostDocumentStore(c,'mirror');await reader.open({path:input.sourcePath});
  const source=reader.active!,project=reader.project;
  if(project?.mode!=='managed'||source.characterId!==input.characterId||source.fileHash!==input.sourceHash||!['pose','skeleton'].includes(source.kind))throw new HostError('PROJECT_BINDING_CONFLICT','诊断来源角色、字节或文档类型不匹配。',409);
  const value=editableValue(input.document);
  if(value.kind!=='action'||!value.referencePosePath||!value.sequencePath||!value.stageId||!value.standardPosePath)throw new HostError('PROJECT_BINDING_CONFLICT','新诊断阶段必须明确标准姿态、已登记参考、动作记录和阶段。',409);
  const character=project.manifest.characters[input.characterId];
  if(!character?.visualRigPath||value.visualRigPath!==character.visualRigPath)throw new HostError('PROJECT_BINDING_CONFLICT','新参考阶段必须使用当前角色已登记的视觉绑定。',409);
  const reference=await requireReferencePose(value.referencePosePath,c);await sequenceForPose(value,c);
  if(objectHash(reference.observation)!==objectHash(value.reference))throw new HostError('TARGET_STALE','诊断内嵌参考与当前已审查标注不一致。',409);
  const standard=JSON.parse(await readFile(reader.resolve(value.standardPosePath),'utf8'));
  if(value.sourceFingerprint!==standard.sourceFingerprint)throw new HostError('PROJECT_BINDING_CONFLICT','诊断与标准姿态角色指纹不一致。',409);
  const branches=referenceBendDirections(reference.observation,value.correspondence,value.facing);
  for(const side of ['left','right']){
    const refSide=value.correspondence[side],contact=reference.observation.support?.[refSide];
    if(typeof contact!=='boolean'||value.frame.targets?.[side+'Foot']?.contact!==contact)throw new HostError('PROJECT_BINDING_CONFLICT','诊断支撑与固定参考身份不一致。',409);
    for(const part of ['Arm','Leg']){const role=side+part;if((value.frame.bendDirections?.[role]??source.mapping.bones.bendDirections?.[role])!==branches[role])throw new HostError('PROJECT_BINDING_CONFLICT','诊断必须使用新阶段参考确定的固定弯曲分支。',409);}
  }
  const baseline=Buffer.from(JSON.stringify(value,null,2)+'\n'),binding:AssetBinding={path:input.outputPath,kind:'pose',characterId:input.characterId,
    referencePosePath:value.referencePosePath,sequencePath:value.sequencePath,stageId:value.stageId,standardPosePath:value.standardPosePath};
  const index=await readCommittedIndex(c);await validateAssetBinding(value,binding,project.manifest,index,c);
  const dependencies=await assetDependencies(value,binding,project.manifest,c),files=new Map(dependencies.map(d=>[d.filePath,d.hash]));
  for(const d of [{filePath:source.path,hash:source.fileHash},{filePath:project.manifestPath,hash:project.manifestHash}]){
    if(files.has(d.filePath)&&files.get(d.filePath)!==d.hash)throw new HostError('TARGET_STALE','诊断来源与目标依赖不一致。',409);files.set(d.filePath,d.hash);
  }
  const deps=[...files].map(([filePath,hash])=>({filePath,hash})).sort((a,b)=>a.filePath.localeCompare(b.filePath));
  const initial={sourcePath:source.path,sourceHash:source.fileHash,proposedOutputPath:input.outputPath,binding,baselineHash:strictHash(baseline),policyFingerprint};
  const id=diagnosticIdentity(initial,c.projectId),virtualPath=`.spine-mcp/diagnostics/${id}.pose.json`;
  const context:DiagnosticPoseContext={...initial,id,binding:{...binding,path:virtualPath}};
  const doc:HostDocument={...source,path:virtualPath,kind:'pose',value,baseline,fileHash:strictHash(baseline),contentHash:'',diagnostic:context,
    version:{sessionId,documentId:id,openEpoch:randomUUID(),revision:0},dependencies:deps,dependencyFingerprint:objectHash({files:deps,policyFingerprint}),snapshotHash:'',
    undo:[],redo:[],uncommitted:false,derived:null,derivedHash:null,review:null,reviewHash:null,cameraInitialized:false,view:null,animations:[]};
  const checks=await strictFileChecks(deps,p=>reader.resolve(p));if(checks.some(d=>d.error||d.actual!==d.hash))throw new HostError('TARGET_STALE','装配诊断草稿期间依赖发生变化。',409);
  return {document:doc,project,characterCatalog:reader.capabilities().characters??[]};
}
