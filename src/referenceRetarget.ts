import {withStrict} from './runtimeCache.js';
import {randomUUID} from 'node:crypto';
import {preparePoseSource} from './poseWorkflow.js';
import {retargetReferencePoseKernel} from './referenceRetargetKernel.js';
import { type ToolContext } from './spineJson.js';
import { readFile } from 'node:fs/promises';
import { resolveWorkspacePath } from './spineJson.js';
import { requireReferencePose, referenceFingerprint } from './referencePose.js';
import { requireVisualRig, readVisualNodes, visualRigFingerprint, visualSummary } from './visualRig.js';
import { compareGraphs, limbNodes, normalizedGraph, finitePoint, direction, distance, validateCorrespondence, policyFingerprint,torsoAxis,comparisonFingerprint,normalizeImagePoints,angleError } from './poseGraph.js';
import { hashObject, saveJson, rigHash } from './mappingTools.js';
import { readJson, poseFingerprint, solvePoseData, createPoseDraft, requireReviewedPose, solvePose } from './poseWorkflow.js';
import { readActionState } from './actionSemantics.js';
import {poseIssuesFromError} from './poseSequence.js';

export function runtimeGraph(skeleton:any,rig:any,mapping:any,p:any){
 const data=readVisualNodes(skeleton,rig),support:any={},grip:any={points:{}};
 for(const side of ['left','right']){
  const foot=mapping.bones.anchors[side+'Foot'],hand=mapping.bones.anchors[side+'Hand'];
  const b=skeleton.findBone(foot.bone),point=foot.point;const y=foot.solePoints?.length?Math.min(...foot.solePoints.map((q:number[])=>b.worldY+b.c*q[0]+b.d*q[1])):b.worldY+b.c*point[0]+b.d*point[1];
  support[side]=Math.abs(y-mapping.calibration.origin[1]-p.groundY*mapping.calibration.scale)<=.01;
  const h=skeleton.findBone(hand.bone),g=hand.gripPoint;if(g)grip.points[side]={x:h.worldX+h.a*g[0]+h.b*g[1],y:h.worldY+h.c*g[0]+h.d*g[1]};
 }
 if(grip.points.left&&grip.points.right){const f=p.facing==='left'?-1:1;grip.angle=direction({x:grip.points.left.x*f,y:grip.points.left.y},{x:grip.points.right.x*f,y:grip.points.right.y});}
 return {...data,support,grip,facing:p.facing,actionState:readActionState(skeleton,rig,p.frame)};
}
export async function comparePoseGraphs(a:any,c:ToolContext={}){
 const p=await readJson(a.posePath,c),report=await comparePoseData(p,a,c);
 const reportPath=a.reportPath??a.posePath.replace(/\.json$/,'.comparison.json');if(a.dryRun===false)await saveJson(reportPath,report,c);return {...report,target:a.detailed?report.target:visualSummary(report.target),dryRun:a.dryRun??true,reportPath};
}
/** 明确输入姿态，不按旧报告路径重读磁盘；Host 与 detached 共享关系门禁。 */
export async function comparePoseData(p:any,a:any,c:ToolContext={},prepared?:Awaited<ReturnType<typeof solvePoseData>>){
 if(!p.referencePosePath||!p.visualRigPath)throw new Error('参考比较需要 referencePosePath 和 visualRigPath。');
 const r=await requireReferencePose(p.referencePosePath,c),v=await requireVisualRig(p.visualRigPath,c),s=prepared??await solvePoseData(p,c);
 if(v.fingerprint!==p.sourceFingerprint)throw new Error('姿态与 visualRig 角色不匹配。');
 let skeleton=s.skeleton,sampleFingerprint:string|null=null;
 if(a.animation){if(!a.candidatePath||!Number.isFinite(a.time)||a.time<0)throw new Error('实际动画复核需 candidatePath、animation、非负 time。');const json=await readJson(a.candidatePath,c);if(rigHash(json)!==rigHash(v.doc.json))throw new Error('候选改变角色结构，不能进行姿态比较。');const rt=await (await import('./motionRuntime.js')).loadMotionRuntime(json,v.mapping.atlasPath!,c);skeleton=rt.sample(a.animation,a.time,v.mapping.skin);sampleFingerprint=hashObject({json,time:a.time,animation:a.animation});}
 const target=runtimeGraph(skeleton,v.rig,v.mapping,p),comparison=compareGraphs(r.observation,target,p.correspondence);
 let sequence:any;try{sequence=await (await import('./poseSequence.js')).sequenceForPose(p,c);}catch(e){sequence={fingerprint:null,issues:poseIssuesFromError(e,p.stageId)};}
 const report={...comparison,ok:comparison.ok&&!!sequence.fingerprint,sequenceFingerprint:sequence.fingerprint,sequenceIssues:sequence.issues??[],posePath:a.posePath,poseFingerprint:poseFingerprint(p),referenceFingerprint:referenceFingerprint(r),visualRigFingerprint:visualRigFingerprint(v.rig),sampleFingerprint,target,reference:r.observation,correspondence:p.correspondence};
 return report;
}
export async function requirePoseComparison(p:any,c:ToolContext){
 return withStrict(async()=>{

 if(!p.reference)return null;if(!p.visualRigPath||!p.comparisonPath)throw new Error('参考任务缺少 visualRig 或最新骨架关系比较报告。');
 await (await import('./poseSequence.js')).sequenceForPose(p,c);
 const old=await readJson(p.comparisonPath,c),fresh=await comparePoseData(p,{posePath:old.posePath,detailed:true},c);
 if(!fresh.ok||fresh.sampleFingerprint||fresh.poseFingerprint!==poseFingerprint(p)||comparisonFingerprint(old)!==comparisonFingerprint(fresh))throw new Error(`参考关系比较失败、缺少必要点或报告已过期：${fresh.metrics.filter((m:any)=>m.required&&m.status!=='pass').map((m:any)=>`${m.id}(${m.status})`).join('、')||'指纹不一致'}。若参考仍为 v1，请先升级并重标注。`);return old;

 });
}
export async function retargetReferencePose(a:any,c:ToolContext={}){
 if(!a.sequencePath)return retargetReferencePoseSeed(a,c);
 if(a.dryRun!==false){const seed=await retargetReferencePoseSeed({...a,detailed:true},c);try{const sequence=await (await import('./poseSequence.js')).sequenceForPose(seed.pose,c),r=await requireReferencePose(a.referencePosePath,c),v=await requireVisualRig(a.visualRigPath,c),old={...seed.comparison,poseFingerprint:poseFingerprint(seed.pose),referenceFingerprint:referenceFingerprint(r),visualRigFingerprint:visualRigFingerprint(v.rig),sequenceFingerprint:sequence.fingerprint,sampleFingerprint:null,policyFingerprint};const mod=await import('./referencePoseRefinement.js'),result=await mod.refinePoseData(seed.pose,old,c);return {...mod.refinementSummary(result,a.detailed),dryRun:true,posePath:a.posePath,seedConflicts:seed.conflicts,...'frame' in result?{pose:a.detailed?{...seed.pose,frame:result.frame,solution:result.solution,status:result.ok?'solved':'failed'}:{id:seed.pose.id,status:result.ok?'solved':'failed',frame:result.frame}}:{pose:seed.pose}};}catch(e){return {...seed,ok:false,issues:poseIssuesFromError(e,a.stageId)};}}
 try{await readFile(resolveWorkspacePath(a.posePath,c));throw new Error('姿态已存在，请使用新修订路径。');}catch(e:any){if(e.code!=='ENOENT')throw e;}
 const seedPath=a.posePath.replace(/\.json$/,'.seed.json'),seed=await retargetReferencePoseSeed({...a,posePath:seedPath},c);
 try{
  const refinement=await (await import('./referencePoseRefinement.js')).refineReferencePose({posePath:seedPath,outputPosePath:a.posePath,dryRun:false},c);
  if(!('frame' in refinement))return {...seed,ok:false,issues:refinement.issues,message:refinement.message};
  return {...refinement,seedPath,seedReportPath:seed.reportPath,seedConflicts:seed.conflicts,pose:{status:refinement.ok?'solved':'failed',frame:refinement.frame}};
 }catch(e){return {...seed,ok:false,requestedPosePath:a.posePath,issues:poseIssuesFromError(e,a.stageId),message:'身份或能力检查阻止联合修正；保留初始诊断候选。'};}
}
export async function prepareReferenceRetargetInputs(a:any,c:ToolContext){
 validateCorrespondence(a.correspondence);
 const reference=await requireReferencePose(a.referencePosePath,c),visual=await requireVisualRig(a.visualRigPath,c),base=await requireReviewedPose(a.standardPosePath,c);
 if(base.sourceFingerprint!==visual.fingerprint)throw new Error('标准站姿与视觉绑定不匹配。');
 const {source}=await preparePoseSource(base,c);return{reference,visual,base,source};
}
async function retargetReferencePoseSeed(a:any,c:ToolContext={}){
 if(a.sequencePath){const sequence=await readJson(a.sequencePath,c);if(a.correspondence&&hashObject(a.correspondence)!==hashObject(sequence.correspondence))throw new Error('调用对应与动作级身份冲突。');a={...a,correspondence:sequence.correspondence};}
 if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.posePath,c));throw new Error('姿态已存在；请使用新修订路径，不覆盖现有审查。');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
 const prepared=await prepareReferenceRetargetInputs(a,c),{draft,solved,actual,comparison,changes,contactResiduals,conflicts,expected}=retargetReferencePoseKernel({...a,id:a.id??randomUUID()},prepared);
 try{await (await import('./poseSequence.js')).sequenceForPose(draft.pose,c);}catch(e){conflicts.push(String(e));}
 const ok=!conflicts.length,reportPath=a.reportPath??a.posePath.replace(/\.json$/,'.adaptation.json');
 if(a.dryRun===false){await saveJson(a.posePath,draft.pose,c);await solvePose({posePath:a.posePath,dryRun:false},c);const cmp=await comparePoseGraphs({posePath:a.posePath,dryRun:false},c);const p=await readJson(a.posePath,c);p.comparisonPath=cmp.reportPath;await saveJson(a.posePath,p,c);await saveJson(reportPath,{ok,conflicts,changes,expected,actual,comparison},c);}
 return {ok,dryRun:a.dryRun??true,posePath:a.posePath,pose:a.detailed?draft.pose:{id:draft.pose.id,status:draft.pose.status,frame:draft.pose.frame},reportPath,conflicts,contactResiduals,changes,expected,actual:a.detailed?actual:visualSummary(actual),comparison,message:ok?'仅生成草稿，尚需图像与逐阶段审查。':'冲突停止：仅生成诊断候选，不批准、不写角色。'};
}
export async function compareAnimationKeyPoses(candidatePath:string,animation:string,motion:any,duration:number,c:ToolContext){
 const reports=[];for(const k of motion.poseWorkflow?.keyPoses??[]){const p=await readJson(k.posePath,c);if(p.reference){const report=await comparePoseGraphs({posePath:k.posePath,candidatePath,animation,time:k.time*duration/motion.duration},c);reports.push({stageId:k.stageId,time:k.time,report});}}
 return {ok:reports.every(v=>v.report.ok),reports,fingerprint:hashObject(reports)};
}
