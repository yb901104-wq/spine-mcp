import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {derivedFingerprint,HostError,strictHash} from './hostContracts.js';
import {resolveWorkspacePath,type ToolContext} from './spineJson.js';
import {hashObject,mappingFingerprint,saveJson} from './mappingTools.js';
import {renderPoseComparison} from './poseWorkflow.js';
import {renderAnimationGif} from './previewRenderTools.js';
import {generateReferenceRetargetTarget} from './referenceRetarget.js';
import {expectedRetargetManifestProblem} from './animationAcceptancePolicy.js';
import {writeAnimationRecord,type AnimationSession} from './hostAnimationSession.js';
import {createEvidenceEnvelope} from './evidenceEnvelope.js';
import {runtimeBuildIdentity,runtimeBuildLineage} from './buildIdentity.js';

/** MCP 制作完整审查产物与准备令牌；令牌不是批准或 Host 提交授权。 */
export async function createHostAnimationBundle(snapshot:any,derived:any,candidate:any,mapping:any,args:any,gate:any,reportPath:string,context:ToolContext,verify:()=>Promise<void>){
 const keys=snapshot.document.poseWorkflow?.keyPoses;
 if(!Array.isArray(keys)||keys.length>60)throw new HostError('CAPABILITY_MISSING','当前完整姿态联系图最多 60 个已审查关键姿态；请明确阶段范围，不省略审查。',409);
 const dir=path.posix.join(path.posix.dirname(derived.live.path),'reviews',randomUUID());
 await verify();
 const poses=await renderPoseComparison({posePaths:keys.map((k:any)=>k.posePath),targetTimes:keys.map((k:any)=>k.time),stageIds:keys.map((k:any)=>k.stageId),outputDir:dir+'/poses'},context);
 const visualRigPath=snapshot.project?.manifest?.characters?.[snapshot.characterId!]?.visualRigPath;
 const animation=await renderAnimationGif({filePath:args.filePath,atlasPath:mapping.atlasPath,skin:mapping.skin,animation:args.animation,jsonOverride:candidate,frames:Math.min(240,Math.max(2,Math.ceil(snapshot.document.duration*30))),fps:30,width:320,height:320,bounds:poses.bounds,visualRigPath,outputDir:dir+'/animation'},context);
 await verify();
 const read=(p:string)=>readFile(resolveWorkspacePath(p,context));
 const manifest=JSON.parse((await read(animation.manifestPath)).toString());
 const referenceKeys:Array<{key:any;pose:any}>=keys.map((key:any)=>({key,pose:null}));
 for(const item of referenceKeys)item.pose=JSON.parse((await read(item.key.posePath)).toString());
 const expectedEntries:any[]=[];
 for(const item of referenceKeys){
  if(!item.pose.referencePosePath)continue;
  const standardPosePath=item.pose.standardPosePath??snapshot.document.poseWorkflow?.standardPosePath;
  const sequencePath=item.pose.sequencePath;
  const stageId=item.key.stageId??item.pose.stageId;
  const itemVisualRigPath=item.pose.visualRigPath??visualRigPath;
  if(!standardPosePath||!sequencePath||!stageId||!itemVisualRigPath)throw new HostError('CAPABILITY_MISSING','参考动画阶段缺少 standardPosePath、sequencePath、stageId 或 visualRigPath，不能生成 expected target。',409);
  const generated=await generateReferenceRetargetTarget({referencePosePath:item.pose.referencePosePath,visualRigPath:itemVisualRigPath,standardPosePath,sequencePath,stageId,facing:item.pose.facing,targetTime:item.key.time,retargetMode:args.retargetMode},context);
  const problem=expectedRetargetManifestProblem(generated);if(problem)throw new HostError('COMMIT_NOT_AUTHORIZED',problem,409);
  expectedEntries.push(generated);
 }
 let retargetManifest:any=null,retargetManifestPath:string|undefined;
 if(expectedEntries.length){
  const first=expectedEntries[0],expectedTargets=expectedEntries.map(entry=>entry.expectedTarget),expectedTargetManifestHash=hashObject(expectedTargets);
  const targetTimes=expectedTargets.map(target=>target.targetTime);
  const referenceApprovalFingerprint=hashObject(expectedEntries.map(entry=>entry.referenceApprovalFingerprint));
  const actionBindingFingerprint=hashObject(expectedEntries.map(entry=>entry.actionBindingFingerprint));
  const visualRigFingerprints=[...new Set(expectedEntries.map(entry=>entry.visualRigFingerprint))];
  const targetCharacterFingerprints=[...new Set(expectedEntries.map(entry=>entry.targetCharacterFingerprint))];
  if(visualRigFingerprints.length!==1||targetCharacterFingerprints.length!==1)throw new HostError('PROJECT_BINDING_CONFLICT','参考关键阶段的 visualRig 或目标角色指纹不一致，不能合并为一条正式比较链。',409);
  retargetManifest={version:1,kind:'reference-retarget-generation',comparisonMode:'retargeted',acceptanceMode:'diagnostic',acceptanceEligible:false,formalEligible:false,rawDiagnosticOnly:false,retargetMode:first.retargetMode??args.retargetMode??'adaptive',status:expectedEntries.some(entry=>entry.status==='geometric-adapted')?'geometric-adapted':'semantic-pass',retargetQuality:Math.min(...expectedEntries.map(entry=>entry.retargetQuality??1)),semanticQuality:Math.min(...expectedEntries.map(entry=>entry.semanticQuality??1)),structuralQuality:Math.min(...expectedEntries.map(entry=>entry.structuralQuality??1)),styleQuality:Math.min(...expectedEntries.map(entry=>entry.styleQuality??1)),preservedConstraints:[...new Set(expectedEntries.flatMap(entry=>entry.preservedConstraints??[]))],relaxedConstraints:[...new Set(expectedEntries.flatMap(entry=>entry.relaxedConstraints??[]))],residuals:Object.fromEntries(expectedEntries.map(entry=>[entry.stageId,entry.residuals??{}])),semanticFailures:[...new Set(expectedEntries.flatMap(entry=>entry.semanticFailures??[]))],reachabilityFailures:expectedEntries.flatMap(entry=>entry.reachabilityFailures??[]),structuralResiduals:Object.fromEntries(expectedEntries.map(entry=>[entry.stageId,entry.structuralResiduals??{}])),styleResiduals:Object.fromEntries(expectedEntries.map(entry=>[entry.stageId,entry.styleResiduals??{}])),
   referencePosePath:first.referencePosePath,referenceApprovalDecision:'approved',referenceApprovalFingerprint,expectedTargets,expectedTarget:expectedTargets[0],expectedTargetSource:'reference-retarget-kernel',expectedTargetManifestHash,
   expectedSampleFingerprint:hashObject({targetTimes}),actualTargetSource:null,actualTargetManifestHash:null,targetTimes,
   targetCharacterPath:first.targetCharacterPath,targetCharacterFingerprint:targetCharacterFingerprints[0],visualRigPath:first.visualRigPath,visualRigFingerprint:visualRigFingerprints[0],actionBindingFingerprint,
   correspondenceFingerprint:first.correspondenceFingerprint,correspondence:first.correspondence,stageIds:expectedEntries.map(entry=>entry.stageId),sequenceFingerprints:expectedEntries.map(entry=>entry.sequenceFingerprint),
   targetAnimation:args.animation,targetManifestPath:animation.manifestPath,createdAt:new Date().toISOString()};
  retargetManifest.retargetManifestFingerprint=hashObject({retargetMode:retargetManifest.retargetMode,status:retargetManifest.status,retargetQuality:retargetManifest.retargetQuality,semanticQuality:retargetManifest.semanticQuality,structuralQuality:retargetManifest.structuralQuality,styleQuality:retargetManifest.styleQuality,preservedConstraints:retargetManifest.preservedConstraints,relaxedConstraints:retargetManifest.relaxedConstraints,residuals:retargetManifest.residuals,semanticFailures:retargetManifest.semanticFailures,reachabilityFailures:retargetManifest.reachabilityFailures,expectedTargetManifestHash,referenceApprovalFingerprint,targetCharacterFingerprint:retargetManifest.targetCharacterFingerprint,visualRigFingerprint:retargetManifest.visualRigFingerprint,actionBindingFingerprint,expectedSampleFingerprint:retargetManifest.expectedSampleFingerprint});
  retargetManifestPath=`${dir}/retarget-generation.json`;await saveJson(retargetManifestPath,retargetManifest,context);
 }
 const paths=new Set<string>([derived.live.path,reportPath,poses.manifestPath,animation.manifestPath,animation.gifPath,...manifest.frames??[]]);
 if(retargetManifestPath)paths.add(retargetManifestPath);
 for(const file of poses.evidence??[])paths.add(file.filePath);
 for(const page of poses.pages??[])for(const field of ['clean','diagnostic'])if(page[field])paths.add(page[field]);
 if(mapping.reportPath)paths.add(mapping.reportPath);
 const artifacts=[];for(const filePath of [...paths].sort())artifacts.push({filePath,hash:strictHash(await read(filePath))});
 const binding={version:snapshot.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,derivedHash:derivedFingerprint(snapshot.snapshotHash,derived),candidateHash:derived.live.hash,sourceHash:strictHash(await read(args.filePath))};
 const retargetBinding=retargetManifest?{retargetManifestPath,retargetManifestFingerprint:retargetManifest.retargetManifestFingerprint,referenceApprovalFingerprint:retargetManifest.referenceApprovalFingerprint,targetCharacterFingerprint:retargetManifest.targetCharacterFingerprint,actionBindingFingerprint:retargetManifest.actionBindingFingerprint,visualRigFingerprint:retargetManifest.visualRigFingerprint}:{};
 const evidenceEnvelope=createEvidenceEnvelope({projectId:context.projectId??null,documentId:snapshot.version.documentId,versionRef:snapshot.version,sourceHash:binding.sourceHash,candidateHash:binding.candidateHash,buildFingerprint:(await runtimeBuildIdentity).buildFingerprint,buildLineageFingerprint:(await runtimeBuildLineage).lineageFingerprint,evidence:artifacts,retargetManifestFingerprint:retargetManifest?.retargetManifestFingerprint,generatedAt:new Date().toISOString()});
 const tokenData={retargetMode:retargetManifest?.retargetMode??args.retargetMode??'adaptive',poseReview:gate.fingerprint,fileHash:binding.sourceHash,mapping:mappingFingerprint(mapping),motion:hashObject(snapshot.document),animation:args.animation,value:hashObject(candidate.animations[args.animation]),thresholds:[args.footContactTolerance,args.handTolerance,args.vertexTolerance],overwrite:args.overwrite??false,hostBinding:binding,retargetBinding,artifacts:hashObject(artifacts)};
 const baseToken=hashObject(tokenData),recordPath=`.spine-mcp/reviews/${baseToken}.json`;
 const record={tokenData,reviewToken:baseToken,candidatePath:derived.live.path,candidateHash:hashObject(candidate),sourcePath:args.filePath,sourceHash:binding.sourceHash,mappingPath:args.mappingPath,motionPath:snapshot.path,duration:snapshot.document.duration,reportPath,requiresReferenceComparison:!!poses.reference,poseManifestPath:poses.manifestPath,previewManifestPath:animation.manifestPath,...retargetBinding,numericOk:true,keyGraphsOk:true,artifacts,evidenceEnvelope};
 await verify();const recordHash=await writeAnimationRecord(recordPath,record,context);await verify();
 const session:AnimationSession={...binding,...retargetBinding,candidatePath:derived.live.path,sourcePath:args.filePath,animation:args.animation,baseToken,recordPath,recordHash,poseManifestPath:poses.manifestPath,previewManifestPath:animation.manifestPath};
 return {session,posePreview:poses,animationPreview:animation};
}
