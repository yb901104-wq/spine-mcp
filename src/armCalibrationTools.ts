import { readFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { strictHash, HostError } from './hostContracts.js';
import { requireReviewedPose, preparePoseSource, solvePoseData } from './poseWorkflow.js';
import { solvePoseKernel } from './animationKernel.js';
import { poseDependencies } from './poseDigest.js';
import { captureRuntimeState } from './captureEvidence.js';
import { loadAtlasImages, rasterFrame } from './rasterRenderer.js';
import { armCalibrationChecks, calibrationReviewPath, verifyCalibrationReview } from './armCalibration.js';
import { writeEvidenceFile } from './hostReleaseEvidence.js';
import {calibrationSweep} from './armCalibrationSweep.js';

const file={type:'string',minLength:1},ratio={type:'number',exclusiveMinimum:0,maximum:1},width={type:'number',exclusiveMinimum:0,maximum:2};
const sample={type:'object',additionalProperties:false,properties:{id:file,upper:ratio,lower:ratio,widthUpper:width,widthLower:width,target:{type:'object',additionalProperties:false,properties:{x:{type:'number'},y:{type:'number'},angle:{type:'number'}},required:['x','y','angle']},body:{type:'object',additionalProperties:false,properties:{x:{type:'number'},y:{type:'number'},rotate:{type:'number'}},required:['x','y','rotate']}},required:['id','upper','lower','target']};
const common={projectId:{type:'string'},calibrationPath:file,dryRun:{type:'boolean',default:true}};
export const armCalibrationToolDefinitions=[
  {name:'spine_calibrate_arm_perspective',description:'生成独立单臂世界投影校准、样本图及批准前的连续性诊断 GIF/联系图；需已批准基准姿态和 visualRig。upper/lower 为世界段长比，局部 scale 由 runtime 求解。3–25 个明确样本（含 1/1 基准）按给定顺序扫掠，宽度未校准保持 1。默认 dryRun，不批准、不创建正式 motion、不改 Spine JSON。正式使用前逐个取得真实 player 图并独立审查。',inputSchema:{type:'object',additionalProperties:false,properties:{...common,posePath:file,bendDirection:{enum:[-1,1],description:'新校准固定的解剖弯曲分支；局部修正不能改变。省略沿用已确认基准。'},limb:{enum:['leftArm','rightArm']},basis:file,samples:{type:'array',minItems:3,maxItems:25,items:sample},sweepFrames:{type:'integer',minimum:17,maximum:121,default:33},sweepDuration:{type:'number',minimum:.25,maximum:10,default:2}},required:['posePath','calibrationPath','limb','basis','samples']}},
  {name:'spine_review_arm_perspective',description:'独立审查单臂校准：逐个核验真实 player 样本、切片连接、末端方向、连续性、范围及深度依据。旧诊断批准不迁移；默认 dryRun，批准记录新建且绑定校准字节。未通过仍禁止正式透视。',inputSchema:{type:'object',additionalProperties:false,properties:{...common,calibrationHash:{type:'string',pattern:'^[a-f0-9]{64}$'},decision:{enum:['approved','rejected']},reviewedBy:file,reason:file,samples:{type:'array',minItems:3,maxItems:25,items:{type:'object',additionalProperties:false,properties:{sampleId:file,manifestPath:file},required:['sampleId','manifestPath']}},checkResults:{type:'object',additionalProperties:false,properties:Object.fromEntries(armCalibrationChecks.map(k=>[k,{type:'object',additionalProperties:false,properties:{status:{enum:['pass','fail','unverifiable']},reason:file},required:['status','reason']}]))}},required:['calibrationPath','calibrationHash','decision','reviewedBy','reason','samples','checkResults']}}
];
export async function callArmCalibration(name:string,args:any,context:ToolContext,signal?:AbortSignal,progress?:(stage:string)=>void){
  const check=()=>{if(signal?.aborted)throw new HostError('TASK_CANCELLED','单臂校准已取消，未生成批准。',409);};check();
  if(name==='spine_review_arm_perspective'){
    const raw=await readFile(resolveWorkspacePath(args.calibrationPath,context)),record=JSON.parse(raw.toString());
    if(strictHash(raw)!==args.calibrationHash||record.format!=='spine-arm-projection-calibration')throw new HostError('TARGET_STALE','校准字节或格式不匹配。',409);
    const review={format:'spine-arm-projection-review',version:1,calibrationHash:args.calibrationHash,decision:args.decision,reviewedBy:args.reviewedBy,reason:args.reason,checkResults:args.checkResults,samples:[]as any[],createdAt:new Date().toISOString()};
    for(const item of args.samples)review.samples.push({...item,manifestHash:strictHash(await readFile(resolveWorkspacePath(item.manifestPath,context)))});
    for(const d of record.dependencies)if(strictHash(await readFile(resolveWorkspacePath(d.filePath,context)))!==d.hash)throw new HostError('TARGET_STALE','校准依赖变化，重新制作。',409);
    if(args.decision==='approved')await verifyCalibrationReview(record,review,context);
    check();if(args.dryRun===false)await writeEvidenceFile(calibrationReviewPath(args.calibrationPath),review,context);
    return {ok:true,dryRun:args.dryRun!==false,decision:args.decision,calibrationHash:args.calibrationHash,reviewPath:calibrationReviewPath(args.calibrationPath),review};
  }
  const pose=await requireReviewedPose(args.posePath,context);
  if(pose.frame.perspective||!pose.visualRigPath)throw new HostError('CAPABILITY_MISSING','校准需没有透视的已批准基准姿态和已审查 visualRig。',409);
  if(!Array.isArray(args.samples)||args.samples.length<3||args.samples.length>25||new Set(args.samples.map((s:any)=>s.id)).size!==args.samples.length||!args.samples.some((s:any)=>s.upper===1&&s.lower===1&&(s.widthUpper??1)===1&&(s.widthLower??1)===1))throw new HostError('INVALID_ARGUMENT','需 3–25 个唯一样本，包含世界投影 1/1 的宽度 1 基准。');
  const {source,visualReader}=await preparePoseSource(pose,context),solved=await solvePoseData(pose,context),chain=source.mapping.bones[args.limb as 'leftArm'];
  if(chain?.length!==3)throw new HostError('CAPABILITY_MISSING','单臂校准需三段骨骼链。',409);
  const [a,b,c]=chain.map(n=>solved.skeleton.findBone(n)!),role=args.limb.replace('Arm','Hand'),bounds=(values:number[])=>[Math.min(...values),Math.max(...values)];
  const values=new Map<string,Buffer>();await poseDependencies({...pose,standardPosePath:args.posePath},context,values);
  const dependencies=[...values].map(([filePath,raw])=>({filePath,hash:strictHash(raw)})).sort((a,b)=>a.filePath.localeCompare(b.filePath));
  const bendDirection=args.bendDirection??pose.frame.bendDirections?.[args.limb]??source.mapping.bones.bendDirections?.[args.limb as 'leftArm'];if(![1,-1].includes(bendDirection))throw new HostError('INVALID_ARGUMENT','单臂校准缺少固定弯曲分支。');
  pose.frame.bendDirections={...pose.frame.bendDirections,[args.limb]:bendDirection};
  const record:any={bendDirection,format:'spine-arm-projection-calibration',version:1,createdAt:new Date().toISOString(),sourceFingerprint:source.fingerprint,facing:pose.facing,posePath:args.posePath,visualRigPath:pose.visualRigPath,limb:args.limb,basis:args.basis,dependencies,
    baseline:{projection:[Math.hypot(b.worldX-a.worldX,b.worldY-a.worldY),Math.hypot(c.worldX-b.worldX,c.worldY-b.worldY)],endNorm:[Math.hypot(c.a,c.c),Math.hypot(c.b,c.d)],frame:pose.frame},
    localScaleBounds:[[.05,2],[.05,2]],ranges:Object.fromEntries(['upper','lower','widthUpper','widthLower'].map(k=>[k,bounds(args.samples.map((s:any)=>s[k]??1))])),
    bodyRange:Object.fromEntries(['x','y','rotate'].map(k=>[k,bounds(args.samples.map((s:any)=>(s.body??pose.frame.body)[k]))])),targetRange:Object.fromEntries(['x','y','angle'].map(k=>[k,bounds(args.samples.map((s:any)=>s.target[k]))])),samples:[]};
  const images=await loadAtlasImages(solved.rt.atlas,source.mapping.atlasPath!,context),pictures:Buffer[]=[];
  for(const sample of args.samples){check();progress?.(`计算世界投影校准样本 ${sample.id}`);
    if(!sample.id||!['upper','lower'].every(k=>Number.isFinite(sample[k])&&sample[k]>0&&sample[k]<=1)||!['x','y','angle'].every(k=>Number.isFinite(sample.target?.[k])))throw new HostError('INVALID_ARGUMENT','样本需要有限目标及 0 < 世界段长比 <= 1。');
    const input={upper:sample.upper,lower:sample.lower,widthUpper:sample.widthUpper??1,widthLower:sample.widthLower??1,basis:''};
    const p=structuredClone(pose);p.frame.body=sample.body??p.frame.body;p.frame.targets[role]={...p.frame.targets[role],...sample.target};p.frame.perspective={...input,basis:args.basis,mode:'calibration',limb:args.limb,calibrationPath:args.calibrationPath,calibrationHash:'0'.repeat(64)};
    record.samples.push({input,frame:{body:p.frame.body,targets:{[role]:p.frame.targets[role]}}});
    const result=solvePoseKernel(p,{...source,perspectiveCalibration:record}as any,visualReader);
    record.samples.pop();record.samples.push({id:sample.id,input,frame:{body:p.frame.body,targets:{[role]:p.frame.targets[role]}},numeric:result.report.perspective,runtime:captureRuntimeState(result.skeleton),sliceConnections:result.report.visual?.attachments??[],renderBounds:result.report.bounds,endDirection:result.report.perspective?.angleError});
    pictures.push(rasterFrame(result.skeleton,images,result.report.bounds,480,480,'#20242b').toBuffer('image/png'));
  }
  record.endCompensationBounds=[0,1].map(i=>bounds(record.samples.map((s:any)=>s.numeric.endLocalScale[i])));
  check();const ok=record.samples.every((s:any)=>s.numeric?.ok===true);
  if(!ok)return {ok:false,dryRun:args.dryRun!==false,persisted:false,calibration:record,message:'存在数值/世界投影失败的样本，保留部分诊断，不创建可批准校准。'};
  const sweepFrames=args.sweepFrames??33,sweepDuration=args.sweepDuration??2;
  if(!Number.isInteger(sweepFrames)||sweepFrames<17||sweepFrames>121||!Number.isFinite(sweepDuration)||sweepDuration<.25||sweepDuration>10)throw new HostError('INVALID_ARGUMENT','连续性诊断需 17–121 帧、0.25–10 秒。');
  const sweep=await calibrationSweep(pose,source,visualReader,record,args.samples,images,sweepFrames,sweepDuration,signal,progress);
  record.continuity={...sweep.report,artifacts:[{filePath:args.calibrationPath+'.samples/continuity.gif',hash:strictHash(sweep.gif)},{filePath:args.calibrationPath+'.samples/continuity-sheet.png',hash:strictHash(sweep.sheet)}]};
  const dir=args.calibrationPath+'.samples',sheet=createCanvas(480*3,480*Math.ceil(record.samples.length/3)),ctx=sheet.getContext('2d');
  const {loadImage}=await import('@napi-rs/canvas');for(let i=0;i<pictures.length;i++){ctx.drawImage(await loadImage(pictures[i]),i%3*480,Math.floor(i/3)*480);ctx.fillStyle='#eff';ctx.font='16px sans-serif';ctx.fillText(record.samples[i].id,i%3*480+8,Math.floor(i/3)*480+20);}
  const recordHash=strictHash(JSON.stringify(record,null,2)+'\n');
  for(const d of dependencies)if(strictHash(await readFile(resolveWorkspacePath(d.filePath,context)))!==d.hash)throw new HostError('TARGET_STALE','计算期间校准依赖变化。',409);
  if(args.dryRun===false){await writeEvidenceFile(args.calibrationPath,record,context);const absolute=resolveWorkspacePath(dir,context);await mkdir(absolute,{recursive:true});
    for(const [name,bytes]of [...pictures.map((p,i)=>[`${i}.png`,p]as const),['sheet.png',sheet.toBuffer('image/png')]as const,['continuity.gif',sweep.gif]as const,['continuity-sheet.png',sweep.sheet]as const]){const handle=await open(path.join(absolute,name),'wx');try{await handle.writeFile(bytes);}finally{await handle.close();}}}
  return {ok:true,dryRun:args.dryRun!==false,calibrationPath:args.calibrationPath,calibrationHash:recordHash,samples:record.samples.map((s:any,i:number)=>({id:s.id,input:s.input,frame:s.frame,numeric:s.numeric,imagePath:`${dir}/${i}.png`})),sheetPath:`${dir}/sheet.png`,continuity:{numericOk:sweep.report.numericOk,branchStable:sweep.report.branchStable,frameCount:sweepFrames,duration:sweepDuration,maximumJointStepNormalized:sweep.report.maximumJointStepNormalized,gifPath:`${dir}/continuity.gif`,sheetPath:`${dir}/continuity-sheet.png`},approved:false,nextAction:{tool:'spine_review_arm_perspective',instruction:'逐个加载 calibration 样本并取得真实 player 截图，再独立核对切片连接、末端方向和连续范围；生成样本不产生正式批准。'}};
}
