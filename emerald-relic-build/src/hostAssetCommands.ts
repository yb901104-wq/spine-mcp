import { readFile } from 'node:fs/promises';
import { assertVersion, HostError, objectHash, strictHash } from './hostContracts.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { buildMotionFromPosesData, createPoseDraftData, poseGateData, readJson, type PoseDataReader } from './poseWorkflow.js';
import { assetDependencies, validateAssetBinding, type AssetBinding } from './hostAssetBinding.js';
import { readCommittedIndex } from './hostJournal.js';
import { retargetReferencePoseData, comparePoseData } from './referenceRetarget.js';
import { refinePoseData } from './referencePoseRefinement.js';
import { materializeHostPose } from './hostPose.js';
import { solvePoseData } from './poseWorkflow.js';
import { buildDiagnosticPose } from './hostDiagnosticPose.js';
import { sequenceForPose } from './poseSequence.js';

export const hostAssetTools=['spine_create_pose_draft','spine_build_motion_from_poses','spine_retarget_reference_pose','spine_refine_reference_pose'];
export const isHostAssetCommand=(name:string)=>hostAssetTools.includes(name);
function memoryReader(snapshot:any,c:ToolContext):PoseDataReader{
  return async file=>{
    if(resolveWorkspacePath(file,c)!==resolveWorkspacePath(snapshot.path,c))return readJson(file,c);
    if(snapshot.uncommitted)throw new HostError('UNCOMMITTED_CHANGES','引用当前姿态前先保存新修订及批准；不能把尚未保存的内存帧登记为旧磁盘路径。',409);
    return structuredClone(snapshot.baselineDocument);
  };
}
/** 提交前重新执行 MCP 领域门禁，Host 不求解。 */
export async function verifyHostAssetCandidate(value:any,binding:AssetBinding,snapshot:any,c:ToolContext){
  const reader=memoryReader(snapshot,c);
  if(binding.kind==='motion'){
    const gate=await poseGateData(value,c,reader);
    if(!gate.ok)throw new HostError('COMMIT_NOT_AUTHORIZED','motion 姿态门禁失败。',409,gate);
  }else{
    const expected=await createPoseDraftData({...value,posePath:binding.path,kneeFlexionMax:value.policy?.kneeFlexionMax,thresholdReason:value.policy?.reason},c,reader);
    if(objectHash(expected)!==objectHash(value))throw new HostError('COMMIT_NOT_AUTHORIZED','姿态候选与当前资源/标准/参考输入不一致。',409);
    if(value.referencePosePath){
      const solved=await solvePoseData(value,c),comparison=await comparePoseData(value,{posePath:binding.path,detailed:true},c,solved);
      if(!solved.report.ok||!comparison.ok)throw new HostError('COMMIT_NOT_AUTHORIZED','参考姿态候选仅可诊断，数值或必要关系未通过。',409,{numeric:solved.report,comparison});
    }
  }
}
export async function prepareHostAssetCandidate(name:string,args:any,snapshot:any,c:ToolContext){
  if(!isHostAssetCommand(name)||snapshot.viewProfile!=='c2-pose'||!['pose','skeleton'].includes(snapshot.kind)||snapshot.project?.mode!=='managed')throw new HostError('CAPABILITY_MISSING','仅隔离 C2 的受管 pose/skeleton 来源可暂存新资产。',409);
  assertVersion(args.expectedRevision,snapshot.version);
  const outputPath=name==='spine_build_motion_from_poses'?args.motionPath:name==='spine_refine_reference_pose'?args.outputPosePath:args.posePath;
  const reader=memoryReader(snapshot,c);let document:any;
  if(name==='spine_create_pose_draft')document=await createPoseDraftData(args,c,reader);
  else if(name==='spine_build_motion_from_poses')document=await buildMotionFromPosesData(args,c,reader);
  else{
    if(args.reportPath!==undefined)throw new HostError('INVALID_ARGUMENT','attached 计算不写旧 reportPath，请读取返回的诊断并另行采集当前 player 证据。');
    let result:any,value:any;
    if(name==='spine_retarget_reference_pose'){
      result=await retargetReferencePoseData({...args,detailed:true},c,reader);value=result.pose;
    }else{
      if(snapshot.kind!=='pose')throw new HostError('UNSUPPORTED_DOC_KIND','参考局部修正需要当前 pose。',409);
      if(resolveWorkspacePath(args.posePath,c)!==resolveWorkspacePath(snapshot.path,c))throw new HostError('TARGET_DRIFT','局部修正必须使用当前内存 pose。',409);
      if(!snapshot.derived?.comparison||!snapshot.derived.live?.path)throw new HostError('NO_SOLUTION','局部修正前先重算当前参考姿态及完整静态比较。',409);
      const reportPath=snapshot.derived.live.path.replace(/pose\.json$/,'comparison.json');
      if(args.comparisonPath!==undefined&&args.comparisonPath!==reportPath)throw new HostError('TARGET_DRIFT','只使用当前派生比较，不能复用旧报告。',409);
      const source=materializeHostPose(snapshot.document,snapshot.derived);
      result=await refinePoseData(source,snapshot.derived.comparison,c);
      value={...source,id:`pose-${objectHash({version:snapshot.version,frame:result.frame}).slice(0,24)}`,frame:result.frame};
    }
    if(!result.ok||!value?.frame){
      if(name==='spine_retarget_reference_pose'&&args.diagnosticMode==='newStage'&&value?.frame){
        if(snapshot.diagnostic)throw new HostError('CAPABILITY_MISSING','先选择普通受管来源再建立其它新阶段；当前诊断仅能修正其固定上下文。',409);
        const clean=await createPoseDraftData({...value,posePath:outputPath,kneeFlexionMax:value.policy?.kneeFlexionMax,thresholdReason:value.policy?.reason},c,reader);
        if(clean.sourceFingerprint!==value.sourceFingerprint||objectHash(clean.reference)!==objectHash(value.reference))throw new HostError('TARGET_STALE','诊断计算后角色或参考发生变化。',409);
        try{await sequenceForPose(clean,c);}catch(error:any){return {diagnostic:true,ok:false,diagnosticOnly:true,partialResult:true,adopted:false,staged:false,persisted:false,version:snapshot.version,issues:error.issues??[{category:'inputMissing',message:String(error)}],comparison:result.comparison,numeric:result.numeric,dryRun:args.dryRun!==false,message:'必要节点、阶段身份或能力尚不能验证；保留已有比较和部分诊断，不编造完整姿态，也不载入新阶段。'};}
        const prepared=await buildDiagnosticPose({sourcePath:snapshot.path,sourceHash:snapshot.fileHash,document:clean,outputPath,characterId:snapshot.characterId},snapshot.version.sessionId,c);
        return {diagnostic:true,newStage:true,document:clean,dependencies:prepared.document.dependencies,outputPath,ok:false,dryRun:args.dryRun!==false,persisted:false,issues:result.issues??result.conflicts};
      }
      return {diagnostic:true,ok:false,diagnosticOnly:true,staged:false,persisted:false,version:snapshot.version,issues:result.issues??result.conflicts,comparison:result.comparison,numeric:result.numeric,...value?.frame?{document:value}:{},dryRun:args.dryRun!==false,message:'参考计算未通过；同绑定的结构合法候选可进入内存诊断修正，不授予保存令牌。'};
    }
    document=await createPoseDraftData({...value,posePath:outputPath,kneeFlexionMax:value.policy?.kneeFlexionMax,thresholdReason:value.policy?.reason},c,reader);
  }
  const binding:AssetBinding={path:outputPath,kind:name==='spine_build_motion_from_poses'?'motion':'pose',characterId:snapshot.characterId};
  for(const field of ['referencePosePath','sequencePath','stageId','standardPosePath']as const){const v=binding.kind==='pose'?document[field]:field==='standardPosePath'?document.poseWorkflow?.standardPosePath:undefined;if(v)binding[field]=v;}
  await validateAssetBinding(document,binding,snapshot.project.manifest,await readCommittedIndex(c),c);
  const dependencies=await assetDependencies(document,binding,snapshot.project.manifest,c);
  await verifyHostAssetCandidate(document,binding,snapshot,c);
  for(const d of dependencies)if(strictHash(await readFile(resolveWorkspacePath(d.filePath,c)))!==d.hash)throw new HostError('TARGET_STALE','计算期间资产依赖发生变化。',409);
  return {expectedRevision:args.expectedRevision,snapshotHash:snapshot.snapshotHash,outputPath,document,binding,dependencies,dryRun:args.dryRun??true};
}
