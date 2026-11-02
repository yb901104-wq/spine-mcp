import { readFile } from 'node:fs/promises';
import { strictHash, objectHash, HostError } from './hostContracts.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { validatePerspective, type PerspectiveInput } from './perspective.js';
import { assertCaptureReadback, CAPTURE_EVIDENCE_SCHEMA } from './captureEvidence.js';

export const armCalibrationChecks=['sliceConnections','endDirection','continuity','range','depthEvidence'];
export const calibrationReviewPath=(file:string)=>file+'.review.json';
export async function readArmCalibration(input:PerspectiveInput,context:ToolContext,sourceFingerprint?:string){
  validatePerspective(input);if(input.mode==='diagnostic')return undefined;
  const raw=await readFile(resolveWorkspacePath(input.calibrationPath!,context));
  if(strictHash(raw)!==input.calibrationHash)throw new HostError('TARGET_STALE','单臂校准文件哈希已变化。',409);
  const record=JSON.parse(raw.toString());
  if(record.format!=='spine-arm-projection-calibration'||record.version!==1||record.limb!==input.limb||sourceFingerprint&&record.sourceFingerprint!==sourceFingerprint||!record.samples?.length||!record.baseline?.projection?.every((v:number)=>Number.isFinite(v)&&v>0)||record.baseline.projection.length!==2||!record.baseline?.endNorm?.every((v:number)=>Number.isFinite(v)&&v>0)||record.baseline.endNorm.length!==2)throw new HostError('VALIDATION_FAILED','单臂校准格式、角色或基准无效。',409);
  for(const d of record.dependencies??[])if(strictHash(await readFile(resolveWorkspacePath(d.filePath,context)))!==d.hash)throw new HostError('TARGET_STALE','校准角色、切片、基准或视觉绑定证据已变化。',409);
  if(!record.dependencies?.length||record.samples.length<3||new Set(record.samples.map((s:any)=>s.id)).size!==record.samples.length||![1,-1].includes(record.bendDirection)||record.samples.some((s:any)=>s.numeric?.ok!==true))throw new HostError('VALIDATION_FAILED','校准样本数值未全部通过。',409);
  if(record.endCompensationBounds?.length!==2||record.endCompensationBounds.some((range:any)=>!Array.isArray(range)||range.length!==2||!range.every((v:any)=>Number.isFinite(v)&&v>0)||range[0]>range[1]))throw new HostError('VALIDATION_FAILED','校准缺少实际末端补偿范围。',409);
  if(input.mode==='calibration'){
    const sample=record.samples.find((s:any)=>s.input.upper===input.upper&&s.input.lower===input.lower&&(s.input.widthUpper??1)===(input.widthUpper??1)&&(s.input.widthLower??1)===(input.widthLower??1));
    if(!sample)throw new HostError('INVALID_ARGUMENT','校准诊断只显示已生成的样本；不能借待审查记录开放连续范围。');
  }else{
    const review=JSON.parse(await readFile(resolveWorkspacePath(calibrationReviewPath(input.calibrationPath!),context),'utf8'));
    if(review.format!=='spine-arm-projection-review'||review.calibrationHash!==input.calibrationHash||review.decision!=='approved')throw new HostError('COMMIT_NOT_AUTHORIZED','正式透视需独立的当前校准批准，旧 diagnostic 批准无效。',409);
    await verifyCalibrationReview(record,review,context);
  }
  return record;
}
export function assertCalibrationFrame(record:any,frame:any){
  for(const key of ['x','y','rotate']){const range=record.bodyRange[key],value=frame.body[key];if(!range||value<range[0]-1e-8||value>range[1]+1e-8)throw new HostError('INVALID_ARGUMENT','身体参数超出已审查单臂校准范围。');}
  for(const key of ['head','channels','action','presentation'])if(objectHash(frame[key]??null)!==objectHash(record.baseline.frame[key]??null))throw new HostError('INVALID_ARGUMENT','校准绑定的头部、声明通道、接管或层序已改变，请新增校准范围。');
  if((frame.bendDirections?.[record.limb]??record.bendDirection)!==record.bendDirection)throw new HostError('INVALID_ARGUMENT','校准使用固定弯曲分支，不能复用到其它分支。');
  const role=record.limb.replace('Arm','Hand'),target=frame.targets[role];
  if(!target)throw new HostError('INVALID_ARGUMENT','校准缺少对应手目标。');
  for(const key of ['x','y','angle']){const range=record.targetRange[key],value=target[key];if(!range||!Number.isFinite(value)||value<range[0]-1e-8||value>range[1]+1e-8)throw new HostError('INVALID_ARGUMENT','手目标超出已审查校准范围。');}
  if(frame.perspective.mode==='calibration'&&!record.samples.some((s:any)=>objectHash({body:s.frame.body,target:s.frame.targets[role],input:{...s.input,basis:''}})===objectHash({body:frame.body,target,input:{upper:frame.perspective.upper,lower:frame.perspective.lower,widthUpper:frame.perspective.widthUpper??1,widthLower:frame.perspective.widthLower??1,basis:''}})))throw new HostError('INVALID_ARGUMENT','待审查校准仅允许精确样本目标和身体参数。');
}
export async function verifyCalibrationReview(record:any,review:any,context:ToolContext){
  const continuity=record.continuity;
  if(continuity?.numericOk!==true||continuity.branchStable!==true||!Number.isInteger(continuity.frameCount)||continuity.frameCount<17||continuity.frames?.length!==continuity.frameCount||continuity.frames.some((f:any)=>f.numericOk!==true||f.branchOk!==true||!/^[a-f0-9]{64}$/.test(f.runtimeHash??''))||continuity.artifacts?.length!==2||new Set(continuity.artifacts.map((f:any)=>f.filePath)).size!==2)throw new HostError('COMMIT_NOT_AUTHORIZED','正式校准需当前完整连续性诊断及固定分支数值通过，不能只凭几个静态点批准。',409);
  for(const artifact of continuity.artifacts)if(strictHash(await readFile(resolveWorkspacePath(artifact.filePath,context)))!==artifact.hash)throw new HostError('REVIEW_STALE','校准连续性诊断产物已变化。',409);
  if(!armCalibrationChecks.every(k=>review.checkResults?.[k]?.status==='pass'&&typeof review.checkResults[k].reason==='string'&&review.checkResults[k].reason.trim())||new Set(armCalibrationChecks.map(k=>review.checkResults[k].reason.trim())).size!==armCalibrationChecks.length||!review.reviewedBy?.trim()||!review.reason?.trim())throw new HostError('COMMIT_NOT_AUTHORIZED','校准批准需要五项独立具体理由。',409);
  if(review.samples?.length!==record.samples.length||new Set(review.samples.map((v:any)=>v.sampleId)).size!==record.samples.length)throw new HostError('CAPTURE_UNVERIFIED','每个校准样本都需要独立的真实 player 截图。',409);
  for(const s of record.samples){
    const item=review.samples.find((v:any)=>v.sampleId===s.id),raw=await readFile(resolveWorkspacePath(item?.manifestPath,context));
    if(item.manifestHash&&strictHash(raw)!==item.manifestHash)throw new HostError('REVIEW_STALE','校准截图清单已变化。',409);
    const manifest=JSON.parse(raw.toString());
    if(manifest.evidenceSchema!==CAPTURE_EVIDENCE_SCHEMA||manifest.source!=='player'||manifest.captureValidity?.status!=='verified'||manifest.kind!=='pose'||!manifest.evidence?.length)throw new HostError('CAPTURE_UNVERIFIED','校准仅接受核验通过的真实 player 姿态截图；诊断截图不自动批准。',409);
    assertCaptureReadback(manifest.actual,s.runtime);
    for(const evidence of manifest.evidence)if(strictHash(await readFile(resolveWorkspacePath(evidence.filePath,context)))!==evidence.hash)throw new HostError('REVIEW_STALE','校准样本截图字节已变化。',409);
  }
}

export async function loadMotionArmCalibrations(motion:any,context:ToolContext){const map=new Map<string,any>();for(const f of motion.frames??[])if(f.perspective&&f.perspective.mode!=='diagnostic'&&!map.has(f.perspective.calibrationHash))map.set(f.perspective.calibrationHash,await readArmCalibration(f.perspective,context));return map;}

/** 回放上限属于校准，不属于 Agent 可填的骨骼增量。每次仍核验当前来源和独立批准。 */
export async function armReplayLimits(pose:any,mapping:any,context:ToolContext){
  const input=pose.frame?.perspective;if(!input||input.mode==='diagnostic')return undefined;
  const record=await readArmCalibration(input,context,pose.sourceFingerprint);assertCalibrationFrame(record,pose.frame);
  if(record.facing!==pose.facing||resolveWorkspacePath(record.visualRigPath,context)!==resolveWorkspacePath(pose.visualRigPath,context))throw new HostError('TARGET_STALE','校准视向或 visualRig 与回放姿态不同。',409);
  const chain=mapping.bones[input.limb];if(chain?.length!==3)throw new HostError('SOLUTION_INVALID','校准回放缺少三段臂链。');
  const expand=(r:number[]):[number,number]=>[Math.max(Number.MIN_VALUE,r[0]-1e-5),r[1]+1e-5];
  return {[chain[0]]:{x:expand(record.localScaleBounds[0]),y:expand(record.ranges.widthUpper)},[chain[1]]:{x:expand(record.localScaleBounds[1]),y:expand(record.ranges.widthLower)},[chain[2]]:{x:expand(record.endCompensationBounds[0]),y:expand(record.endCompensationBounds[1])}};
}
