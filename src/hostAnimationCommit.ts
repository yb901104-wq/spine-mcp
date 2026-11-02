import {readFile} from 'node:fs/promises';
import {assertVersion,HostError,objectHash,strictHash} from './hostContracts.js';
import {resolveWorkspacePath,auditGeneratedAnimationCandidate,type ToolContext} from './spineJson.js';
import {assertAnimationSession,assertHostAnimationReviewFresh,type AnimationSession} from './hostAnimationSession.js';
import {assertAnimationReview} from './animationReview.js';
import {poseGateData,characterFingerprint} from './poseWorkflow.js';
import {verifySnapshotDependencies} from './hostEvaluator.js';
import {assertHostAnimationMapping} from './hostAnimationMapping.js';
import {createMotionRuntime} from './motionRuntime.js';
import {assertCaptureReadback,captureRuntimeState} from './captureEvidence.js';

/** MCP 在授权前复验精确候选、不可变完整数值报告与当前参考/视觉证据；不写源资产。 */
export async function verifyHostAnimationCommit(snapshot:any,session:AnimationSession,args:any,context:ToolContext){
 assertVersion(args.expectedRevision,snapshot.version);
 if(snapshot.viewProfile!=='c2-pose'||snapshot.kind!=='motion'||args.intent!=='animation'||args.animationCandidateHash!==session.candidateHash||args.expectedHash!==session.sourceHash||args.outputPath!==session.sourcePath||session.review?.review.decision!=='approved'||args.reviewToken!==session.review?.reviewToken)throw new HostError('COMMIT_NOT_AUTHORIZED','源动画提交必须绑定当前批准、精确候选哈希、源预期哈希和目标路径。',409);
 await verifySnapshotDependencies(snapshot,context);const record=await assertAnimationSession(session,snapshot,context,true);
 const read=(file:string)=>readFile(resolveWorkspacePath(file,context)),sourceRaw=await read(session.sourcePath),candidateRaw=await read(session.candidatePath);
 if(strictHash(sourceRaw)!==session.sourceHash||strictHash(candidateRaw)!==session.candidateHash)throw new HostError('TARGET_DRIFT','源动画或候选字节已变化。',409);
 const source=JSON.parse(sourceRaw.toString()),candidate=JSON.parse(candidateRaw.toString());auditGeneratedAnimationCandidate(source,candidate,session.animation,record.tokenData.overwrite===true);
 const approved=await assertAnimationReview(session.baseToken,args.reviewToken,context);
 if(objectHash(approved)!==objectHash({review:session.review.review,reviewToken:session.review.reviewToken}))throw new HostError('REVIEW_STALE','完整动画批准记录与当前 Host 登记不符。',409);
 const mapping=JSON.parse((await read(record.mappingPath)).toString()),provenance=await assertHostAnimationMapping(mapping,source,session.sourceHash,session.sourcePath,record.mappingPath,context),report=JSON.parse((await read(record.reportPath)).toString());
 const gate=await poseGateData(snapshot.document,context);
 if(!gate.ok||gate.fingerprint!==record.tokenData.poseReview||gate.sourceFingerprint!==(await characterFingerprint(session.sourcePath,record.mappingPath,context)).fingerprint)throw new HostError('COMMIT_NOT_AUTHORIZED','标准/关键姿态或角色来源审查已失效。',409);
 if(report.candidateHash!==session.candidateHash||report.sourceHash!==session.sourceHash||report.motionHash!==snapshot.fileHash||report.snapshotHash!==snapshot.snapshotHash||report.numericOk!==true||report.numeric.ok!==true||report.numeric.samples<337||report.poseGate.fingerprint!==gate.fingerprint||objectHash(report.calibration.provenance)!==objectHash(provenance))throw new HostError('COMMIT_NOT_AUTHORIZED','不可变完整动画数值报告与当前精确输入不一致。',409);
 const rt=createMotionRuntime(candidate,(await read(mapping.atlasPath)).toString()),actual=captureRuntimeState(rt.sample(session.animation,snapshot.view.time,mapping.skin)),{maximumError,replaySchema,...expected}=snapshot.derived.renderState;
 if(maximumError!==0||replaySchema!==1)throw new HostError('SOLUTION_INVALID','缺少当前 runtime 精确回读。',409);assertCaptureReadback(actual,expected);
 await verifySnapshotDependencies(snapshot,context);await assertAnimationSession(session,snapshot,context,true);
 return {passed:true,gate:'animation',candidateHash:session.candidateHash,sourceHash:session.sourceHash,baseToken:session.baseToken,reviewToken:args.reviewToken,reviewHash:session.reviewHash};
}
