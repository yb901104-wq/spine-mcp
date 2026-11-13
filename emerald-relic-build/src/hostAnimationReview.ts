import {readFile} from 'node:fs/promises';
import {assertVersion,HostError,strictHash} from './hostContracts.js';
import {resolveWorkspacePath,type ToolContext} from './spineJson.js';
import {assertAnimationSession,validateHostAnimationReview,type AnimationSession} from './hostAnimationSession.js';
import {reviewAnimation,renderAnimationComparison} from './animationReview.js';
import {hashObject} from './mappingTools.js';
import {fileHash} from './poseWorkflow.js';
import {comparisonManifestProblem,expectedRetargetManifestProblem} from './animationAcceptancePolicy.js';

export async function prepareHostAnimationReview(snapshot:any,session:AnimationSession,args:any,context:ToolContext){
 assertVersion(args.expectedRevision,snapshot.version);
 if(args.reviewToken!==session.baseToken)throw new HostError('COMMIT_NOT_AUTHORIZED','必须使用当前完整候选的准备令牌。',409);
 validateHostAnimationReview(args);await assertAnimationSession(session,snapshot,context);
 const record=JSON.parse(await readFile(resolveWorkspacePath(session.recordPath,context),'utf8'));
 if(session.retargetManifestPath!==undefined){
  if(args.retargetManifestPath!==session.retargetManifestPath)throw new HostError('TARGET_DRIFT','动画审查必须使用当前 session 绑定的 retarget manifest。',409);
  const retarget=JSON.parse(await readFile(resolveWorkspacePath(session.retargetManifestPath,context),'utf8'));
  const retargetProblem=expectedRetargetManifestProblem(retarget);
  if(retargetProblem)throw new HostError('COMMIT_NOT_AUTHORIZED',retargetProblem,409);
  if(retarget.retargetManifestFingerprint!==session.retargetManifestFingerprint||retarget.referenceApprovalFingerprint!==session.referenceApprovalFingerprint||retarget.targetCharacterFingerprint!==session.targetCharacterFingerprint||retarget.actionBindingFingerprint!==session.actionBindingFingerprint||retarget.visualRigFingerprint!==session.visualRigFingerprint)throw new HostError('COMMIT_NOT_AUTHORIZED','retarget manifest 与 session 来源指纹不一致。',409);
 } else if(args.retargetManifestPath!==undefined)throw new HostError('TARGET_DRIFT','当前 session 未绑定 retarget manifest，不能临时注入比较来源。',409);
 const original=await reviewAnimation({...args,dryRun:true},context);
 const evidence=new Map<string,any>((original.review.evidence as any[]).map(e=>[e.filePath,e]));
 let manifest:any=null;
 if(args.playerManifestPath){
  manifest=JSON.parse(await readFile(resolveWorkspacePath(args.playerManifestPath,context),'utf8'));assertVersion(manifest.version,snapshot.version);
  if(manifest.kind!=='motion'||manifest.source!=='player'||manifest.captureValidity?.status!=='verified'||manifest.advisory!==false||manifest.evidenceEligible!==true||manifest.snapshotHash!==snapshot.snapshotHash||manifest.derivedHash!==snapshot.derivedHash||manifest.dependencyFingerprint!==snapshot.dependencyFingerprint||manifest.candidateHash!==session.candidateHash)throw new HostError('CAPTURE_UNVERIFIED','需要当前完整动画候选的 player manifest。',409);
  for(const e of manifest.evidence??[])evidence.set(e.filePath,{filePath:e.filePath,hash:await fileHash(e.filePath,context)});
  evidence.set(args.playerManifestPath,{filePath:args.playerManifestPath,hash:await fileHash(args.playerManifestPath,context)});
 }
 if(args.decision==='approved'&&!manifest)throw new HostError('CAPTURE_UNVERIFIED','批准完整动画需要当前 playerManifestPath。',409);
 const review={...original.review,manifestPath:args.manifestPath,checkResults:args.checkResults,evidence:[...evidence.values()],hostBinding:{...record.tokenData.hostBinding,baseToken:session.baseToken}};
 const result={reviewToken:hashObject({base:session.baseToken,review}),review,evidence:[]as any[]};
 for(const file of review.evidence){
  const bytes=await readFile(resolveWorkspacePath(file.filePath,context)),player=(manifest?.evidence??[]).some((e:any)=>e.filePath===file.filePath);
  result.evidence.push({filePath:file.filePath,hash:strictHash(bytes),...player?{source:'player',manifestPath:args.playerManifestPath}:{}});
 }
 await assertAnimationSession(session,snapshot,context);
 return {expectedRevision:args.expectedRevision,baseToken:session.baseToken,reviewRecord:result,dryRun:args.dryRun??true};
}
export async function prepareHostAnimationComparison(snapshot:any,session:AnimationSession,args:any,context:ToolContext){
 assertVersion(args.expectedRevision,snapshot.version);await assertAnimationSession(session,snapshot,context);
 if(args.targetManifestPath!==session.previewManifestPath||args.poseManifestPath!==session.poseManifestPath)throw new HostError('TARGET_DRIFT','参考同步比较必须使用当前候选的原速 GIF 和姿态联系图。',409);
 if(session.retargetManifestPath!==undefined&&args.retargetManifestPath!==session.retargetManifestPath)throw new HostError('TARGET_DRIFT','参考同步比较必须使用当前 session 绑定的 retarget manifest。',409);
 if(session.retargetManifestPath===undefined&&args.retargetManifestPath!==undefined)throw new HostError('TARGET_DRIFT','当前 session 未绑定 retarget manifest，不能临时注入比较来源。',409);
 if(args.outputDir!==undefined&&!args.outputDir.startsWith(session.candidatePath.replace(/scene\.json$/,'')))throw new HostError('PATH_FORBIDDEN','attached 参考动画比较仅写当前 live 产物目录。',403);
 const result=await renderAnimationComparison({...args,outputDir:args.outputDir??session.candidatePath.replace(/scene\.json$/,'reference-comparison')},context);
 await assertAnimationSession(session,snapshot,context);return result;
}
