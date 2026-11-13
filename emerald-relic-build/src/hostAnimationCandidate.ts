import {mkdir,open,readFile} from 'node:fs/promises';
import path from 'node:path';
import {assertVersion,HostError,objectHash,rejectFields,strictHash} from './hostContracts.js';
import {auditGeneratedAnimationCandidate,resolveWorkspacePath,type ToolContext} from './spineJson.js';
import {assertHostAnimationMapping} from './hostAnimationMapping.js';
import {characterFingerprint,poseGateData} from './poseWorkflow.js';
import {prepareSemanticAnimationData} from './retargetEngine.js';
import {verifySnapshotDependencies} from './hostEvaluator.js';
import {evaluateAnimationSnapshot} from './hostAnimationEvaluator.js';
import {compareAnimationKeyPoses} from './referenceRetarget.js';
import {withStrict} from './runtimeCache.js';
import {createHostAnimationBundle} from './hostAnimationBundle.js';

export async function prepareHostAnimationCandidate(input:any,snapshot:any,context:ToolContext,signal?:AbortSignal,progress?:(stage:string)=>void){
 const args=structuredClone(input);snapshot=structuredClone(snapshot);
 return withStrict(async()=>{
  rejectFields(args,['projectId','expectedRevision','filePath','mappingPath','motionPath','animation','duration','overwrite','expectedHash','dryRun','reviewToken','allowUnsupportedVersion','atlasPath','rotationTolerance','translationTolerance','footContactTolerance','handTolerance','vertexTolerance','preview','diagnosticPreview','retargetMode','workflowProfile']);
  const check=()=>{if(signal?.aborted)throw new HostError('TASK_CANCELLED','动画候选计算已取消，源资源未写入。',409);};check();
  assertVersion(args.expectedRevision,snapshot.version);
  if(snapshot.viewProfile!=='c2-pose'||snapshot.kind!=='motion'||snapshot.project?.mode!=='managed'||snapshot.document.version!==2)throw new HostError('CAPABILITY_MISSING','精确动画候选仅用于隔离 C2 当前受管 v2 motion。',409);
  if(args.dryRun===false||args.reviewToken!==undefined)throw new HostError('WRITE_FORBIDDEN','attached 此工具只制作精确候选；完整动画批准后使用 spine_host_commit intent:animation 提交。',409);
  if(args.allowUnsupportedVersion)throw new HostError('UNSUPPORTED_VERSION','精确动画候选不接受版本绕过。',409);
  const binding=snapshot.project.manifest.characters[snapshot.characterId];
  const same=(a:any,b:any)=>typeof a==='string'&&typeof b==='string'&&resolveWorkspacePath(a,context)===resolveWorkspacePath(b,context);
  if(!binding||!same(args.filePath,binding.skeletonPath)||!same(args.mappingPath,binding.mappingPath)||!same(args.motionPath,snapshot.path)||args.atlasPath!==undefined&&!same(args.atlasPath,binding.atlasPath))throw new HostError('PROJECT_BINDING_CONFLICT','动画候选的角色、mapping、motion 或 atlas 与当前受管绑定不一致。',409);
  args.filePath=binding.skeletonPath;args.mappingPath=binding.mappingPath;args.motionPath=snapshot.path;if(args.atlasPath!==undefined)args.atlasPath=binding.atlasPath;
  if(!snapshot.view||snapshot.view.animation!==args.animation||args.animation!==snapshot.document.name||args.duration!==undefined&&args.duration!==snapshot.document.duration)throw new HostError('VIEW_SELECTION_MISMATCH','先显式选择当前 motion 同名动画和时间；候选不得静默改名或缩放周期。',409);
  if(typeof args.animation!=='string'||!args.animation.trim()||['__proto__','constructor','prototype'].includes(args.animation)||/[\x00-\x1f]/.test(args.animation))throw new HostError('INVALID_ARGUMENT','动画名称无效。');
  for(const[name,maximum]of Object.entries({rotationTolerance:.3,translationTolerance:.07,footContactTolerance:.001,handTolerance:.1,vertexTolerance:1.2})){
   const value=args[name];if(value!==undefined&&(!Number.isFinite(value)||value<0||value>maximum))throw new HostError('INVALID_ARGUMENT',`${name} 必须为 0–${maximum}；attached 不放宽既有验收阈值。`);
  }
  const read=(file:string)=>readFile(resolveWorkspacePath(file,context));
  const raw=await read(binding.skeletonPath),source=JSON.parse(raw.toString()),sourceHash=strictHash(raw);
  if(source.skeleton?.spine!=='4.1.24')throw new HostError('UNSUPPORTED_VERSION','精确动画候选仅支持 Spine 4.1.24。',409);
  if(args.expectedHash!==undefined&&args.expectedHash!==sourceHash)throw new HostError('TARGET_DRIFT','expectedHash 与当前角色字节不符。',409);
  if(Object.hasOwn(source.animations??{},args.animation)&&args.overwrite!==true)throw new HostError('INVALID_ARGUMENT','目标动画已存在，必须显式 overwrite:true。');
  const mapping=JSON.parse((await read(binding.mappingPath)).toString()),calibrationPath=mapping.reportPath;
  if(typeof calibrationPath!=='string')throw new HostError('DOC_INCOMPLETE','缺少已确认 mapping 校准报告。',409);
  const calibrationHash=strictHash(await read(calibrationPath));
  const verify=async()=>{check();await verifySnapshotDependencies(snapshot,context);if(strictHash(await read(snapshot.path))!==snapshot.fileHash||strictHash(await read(binding.skeletonPath))!==sourceHash||strictHash(await read(calibrationPath))!==calibrationHash)throw new HostError('TARGET_DRIFT','计算期间 motion、角色或校准报告字节发生变化。',409);};
  await verify();const calibrationProvenance=await assertHostAnimationMapping(mapping,source,sourceHash,binding.skeletonPath,binding.mappingPath,context);
  const gate=await poseGateData(snapshot.document,context);
  if(!gate.ok||gate.sourceFingerprint!==(await characterFingerprint(binding.skeletonPath,binding.mappingPath,context)).fingerprint)throw new HostError('COMMIT_NOT_AUTHORIZED','标准/关键姿态或目标角色的既有审查未通过。',409,gate);
  progress?.('计算完整拟合候选及 runtime 验证');
  const prepared=await prepareSemanticAnimationData(source,mapping,snapshot.document,{...args,retargetMode:args.retargetMode??'adaptive',dryRun:true},context);check();await verify();
  const audit=auditGeneratedAnimationCandidate(source,prepared.candidate,args.animation,args.overwrite===true);
  const derived=await evaluateAnimationSnapshot(snapshot,context,verify,signal,progress,{source:prepared.candidate,unreachableCount:prepared.build.unreachable.length});
  const keyGraphs=await compareAnimationKeyPoses(derived.live.path,args.animation,snapshot.document,prepared.build.duration,context);await verify();
  if(strictHash(await read(derived.live.path))!==derived.live.hash)throw new HostError('TARGET_DRIFT','精确候选在实际关键时间比较时发生变化。',409);
  const numericOk=prepared.ok,ok=numericOk&&gate.ok&&keyGraphs.ok&&!args.diagnosticPreview;
  const report={schemaVersion:1,purpose:'host-animation-candidate',version:snapshot.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,
   sourcePath:binding.skeletonPath,sourceHash,candidateHash:derived.live.hash,candidatePath:derived.live.path,motionPath:snapshot.path,motionHash:snapshot.fileHash,
   animation:args.animation,duration:prepared.build.duration,overwrite:args.overwrite===true,calibration:{path:calibrationPath,hash:calibrationHash,provenance:calibrationProvenance},
   retargetMode:args.retargetMode??'adaptive',retargetStatus:prepared.adaptation?.status??(prepared.ok?'semantic-pass':'unresolved'),retargetQuality:prepared.adaptation?.retargetQuality??0,semanticQuality:prepared.adaptation?.semanticQuality??null,structuralQuality:prepared.adaptation?.structuralQuality??null,styleQuality:prepared.adaptation?.styleQuality??null,preservedConstraints:prepared.adaptation?.preservedConstraints??[],relaxedConstraints:prepared.adaptation?.relaxedConstraints??[],retargetResiduals:prepared.adaptation?.residuals??{},semanticFailures:prepared.adaptation?.semanticFailures??[],reachabilityFailures:prepared.adaptation?.reachabilityFailures??[],numericOk,structure:prepared.structure,officialSpec:prepared.spec,operationValidation:audit.operationValidation,changedPaths:audit.diff.map(d=>d.path),
   numeric:prepared.validation,poseGate:gate,keyGraphs,unreachable:prepared.build.unreachable,stats:prepared.build.stats,
   ok,diagnosticOnly:true,readyToCommit:false,authorizationGranted:false,
   note:'精确拟合与当前 runtime 回读不代表完整动画视觉批准，须独立生成审查产物、核验当前 player 证据并授权。'};
  const reportPath=path.posix.join(path.posix.dirname(derived.live.path),'reports',objectHash(report)+'.json'),absolute=resolveWorkspacePath(reportPath,context),bytes=JSON.stringify(report,null,2)+'\n';
  await mkdir(path.dirname(absolute),{recursive:true});await verify();
  try{const file=await open(absolute,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}catch(error:any){if(error.code!=='EEXIST'||strictHash(await read(reportPath))!==strictHash(bytes))throw error;}
  await verify();let bundle:Awaited<ReturnType<typeof createHostAnimationBundle>>|undefined,previewError:string|undefined;
  if(ok&&args.preview!==false){try{bundle=await createHostAnimationBundle(snapshot,derived,prepared.candidate,mapping,args,gate,reportPath,context,verify);}catch(error:any){if(error.code==='TASK_CANCELLED'||error.code==='TARGET_DRIFT')throw error;previewError=String(error);}}
  await verify();
  return {derived,session:bundle?.session,summary:{ok,retargetMode:args.retargetMode??'adaptive',retargetStatus:prepared.adaptation?.status??(prepared.ok?'semantic-pass':'unresolved'),retargetQuality:prepared.adaptation?.retargetQuality??0,semanticQuality:prepared.adaptation?.semanticQuality??null,structuralQuality:prepared.adaptation?.structuralQuality??null,styleQuality:prepared.adaptation?.styleQuality??null,preservedConstraints:prepared.adaptation?.preservedConstraints??[],relaxedConstraints:prepared.adaptation?.relaxedConstraints??[],residuals:prepared.adaptation?.residuals??{},semanticFailures:prepared.adaptation?.semanticFailures??[],reachabilityFailures:prepared.adaptation?.reachabilityFailures??[],dryRun:true,wroteFile:false,numericOk,diagnosticOnly:true,readyForAnimationReview:!!bundle,readyToCommit:false,version:snapshot.version,sourceHash,candidateHash:derived.live.hash,candidatePath:derived.live.path,reportPath,reportHash:strictHash(bytes),poseGate:gate,keyGraphs:{ok:keyGraphs.ok,fingerprint:keyGraphs.fingerprint},motionValidation:prepared.validation,stats:prepared.build.stats,reviewToken:bundle?.session.baseToken,posePreview:bundle?.posePreview,animationPreview:bundle?.animationPreview,previewError,message:report.note}};
 });
}
