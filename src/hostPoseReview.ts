import { readFile } from 'node:fs/promises';
import { materializeHostPose } from './hostPose.js';
import { assertVersion, HostError, strictHash, objectHash } from './hostContracts.js';
import { CAPTURE_EVIDENCE_SCHEMA } from './captureEvidence.js';
import { evidenceFiles, preparePoseReview } from './poseWorkflow.js';
import { verifySnapshotDependencies } from './hostEvaluator.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';

/** MCP 内容审查桥接；仅构造绑定当前不可变快照的记录，不写资产或批准状态。 */
export async function prepareHostPoseReview(snapshot:any,args:any,context:ToolContext) {
  assertVersion(args.expectedRevision,snapshot.version);
  if(snapshot.kind!=='pose'||!snapshot.derived?.live?.path||!snapshot.derivedHash)throw new HostError('NO_SOLUTION','审查前需显式求解并发布当前 pose 和 player 候选。',409);
  if(resolveWorkspacePath(args.posePath,context)!==resolveWorkspacePath(snapshot.path,context))throw new HostError('TARGET_DRIFT','审查路径与活动 pose 不一致。',409);
  await verifySnapshotDependencies(snapshot,context);
  const raw=await readFile(resolveWorkspacePath(args.manifestPath,context)),manifest=JSON.parse(raw.toString('utf8'));
  assertVersion(manifest.version,snapshot.version);
  if(manifest.evidenceSchema!==CAPTURE_EVIDENCE_SCHEMA||manifest.source!=='player'||manifest.snapshotHash!==snapshot.snapshotHash||manifest.contentHash!==snapshot.contentHash||manifest.dependencyFingerprint!==snapshot.dependencyFingerprint||manifest.derivedHash!==snapshot.derivedHash||manifest.candidateHash!==snapshot.derived.live?.hash||!Array.isArray(manifest.evidence)||manifest.evidence.length!==1)throw new HostError('CAPTURE_UNVERIFIED','审查需当前快照的 schema 2 官方 player manifest。',409);
  if(args.decision==='approved'&&(manifest.captureValidity?.status!=='verified'||manifest.evidenceEligible!==true||manifest.advisory!==false))throw new HostError('CAPTURE_UNVERIFIED','诊断截图不能用于批准。',409);
  const pose=materializeHostPose(snapshot.document,snapshot.derived),files=[...manifest.evidence.map((e:any)=>e.filePath),args.manifestPath];
  const evidence=[];
  for(const item of manifest.evidence){
    if(strictHash(await readFile(resolveWorkspacePath(item.filePath,context)))!==item.hash)throw new HostError('CAPTURE_UNVERIFIED','player PNG 已改变。',409);
    evidence.push({...item,source:'player',manifestPath:args.manifestPath});
  }
  evidence.push({filePath:args.manifestPath,hash:strictHash(raw),source:'manifest'});
  if((pose.reference||pose.referencePosePath)&&(args.decision==='approved'||snapshot.derived.comparison)){
    const reportPath=snapshot.derived.live.path.replace(/pose\.json$/,'comparison.json');
    if(args.comparisonPath&&resolveWorkspacePath(args.comparisonPath,context)!==resolveWorkspacePath(reportPath,context))throw new HostError('TARGET_DRIFT','审查只接受当前派生版本的关系比较报告。',409);
    pose.comparisonPath=reportPath;
    const bytes=await readFile(resolveWorkspacePath(reportPath,context));
    if(objectHash(JSON.parse(bytes.toString('utf8')))!==objectHash(snapshot.derived.comparison))throw new HostError('TARGET_DRIFT','不可变比较报告与当前派生结果不一致。',409);
    files.push(reportPath);evidence.push({filePath:reportPath,hash:strictHash(bytes),source:'comparison'});
  }
  const record=await preparePoseReview(pose,{...args,comparisonPath:pose.comparisonPath},await evidenceFiles(files,context),context,true);
  // 记录沿用既有文件证据哈希格式，Host 外层另用严格字节哈希。
  const reviewRecord={decision:args.decision,record:{...record,hostBinding:{version:snapshot.version,snapshotHash:snapshot.snapshotHash,derivedHash:snapshot.derivedHash}},evidence};
  await verifySnapshotDependencies(snapshot,context);
  return {expectedRevision:snapshot.version,snapshotHash:snapshot.snapshotHash,derivedHash:snapshot.derivedHash,reviewRecord,dryRun:args.dryRun!==false};
}
