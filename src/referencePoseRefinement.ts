import {withStrict} from './runtimeCache.js';
import {type ToolContext} from './spineJson.js';
import {readJson,solvePoseData,adjustPose,solvePose,poseFingerprint} from './poseWorkflow.js';
import {requireReferencePose,referenceFingerprint} from './referencePose.js';
import {requireVisualRig,visualRigFingerprint} from './visualRig.js';
import {runtimeGraph,comparePoseGraphs} from './referenceRetarget.js';
import {solveSemanticPose} from './retargetEngine.js';
import {compareGraphs,policyFingerprint,signedAngle} from './poseGraph.js';
import {sequenceForPose,type PoseIssue} from './poseSequence.js';
import {boundedLeastSquaresTask} from './poseRefinementTasks.js';
import {saveJson} from './mappingTools.js';
import {readFile} from 'node:fs/promises';
import {resolveWorkspacePath} from './spineJson.js';

export function graphResiduals(report:any):number[]{
 const residuals:number[]=[];
 // 角度类必须走最短弧，否则 179°/-179° 会被当成巨大残差。
 const angular=/^(body\.(torsoDirection|shoulderLine|hipLine|twist)|head\.orientation|grip\.direction|.+\.segment\d)$/;
 // 二元/字符串判据对阻尼最小二乘不可导，只做门禁，不参与优化。
 const binary=/^(action\.|depth\.)|\.(bendSide|extension|order|relation|support|frontGrip|wristOutsideTorso)$|^head\.turnBand$/;
 for(const m of report.metrics){
  if(!m.required)continue;
  if(binary.test(m.id))continue;
  if(m.error===null){residuals.push(10);continue;}
  const tolerance=m.tolerance||1;
  if(Array.isArray(m.reference)&&Array.isArray(m.target))residuals.push(...m.reference.map((v:number,i:number)=>(m.target[i]-v)/tolerance));
  else if(typeof m.reference==='number'&&typeof m.target==='number'){let delta=angular.test(m.id)?signedAngle(m.reference,m.target):m.target-m.reference;if(m.id==='grip.direction'){if(delta>90)delta-=180;if(delta< -90)delta+=180;}residuals.push(delta/tolerance);}
  else residuals.push(m.error/tolerance);
 }
 return residuals;
}
export function refinementSummary(r:any,detailed=false){if(detailed)return r;const {visual,...numeric}=r.numeric??{};return {...r,solution:undefined,numeric};}
export async function refineReferencePose(a:any,c:ToolContext={}){
 if(a.outputPosePath===a.posePath)throw new Error('修正必须保存新修订，不能覆盖原姿态。');
 if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.outputPosePath,c));throw new Error('修订路径已存在，请使用新 outputPosePath。');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
 const p=await readJson(a.posePath,c),old=await readJson(a.comparisonPath??p.comparisonPath,c),result=await refinePoseData(p,old,c);
 if(!('frame' in result))return result;
 const reportPath=a.reportPath??a.outputPosePath.replace(/\.json$/,'.refinement.json');
 if(a.dryRun===false){if(poseFingerprint(await readJson(a.posePath,c))!==result.sourcePoseFingerprint||(await sequenceForPose(p,c)).fingerprint!==result.sequenceFingerprint)throw new Error('修正过程中输入改变，请从最新确认姿态重新开始。');await adjustPose({posePath:a.posePath,outputPosePath:a.outputPosePath,patch:{frame:result.frame},dryRun:false},c);await solvePose({posePath:a.outputPosePath,dryRun:false},c);const cmp=await comparePoseGraphs({posePath:a.outputPosePath,dryRun:false},c),q=await readJson(a.outputPosePath,c);q.comparisonPath=cmp.reportPath;await saveJson(a.outputPosePath,q,c);await saveJson(reportPath,{...result,sourceComparisonPath:a.comparisonPath??p.comparisonPath},c);}
 return {...refinementSummary(result,a.detailed),dryRun:a.dryRun??true,posePath:a.outputPosePath,reportPath};
}
export async function refinePoseData(p:any,old:any,c:ToolContext){
 return withStrict(async()=>{

 const sequence=await sequenceForPose(p,c),reference=await requireReferencePose(p.referencePosePath,c),rig=await requireVisualRig(p.visualRigPath,c),initial=await solvePoseData(p,c);
 if(old.poseFingerprint!==poseFingerprint(p)||old.referenceFingerprint!==referenceFingerprint(reference)||old.visualRigFingerprint!==visualRigFingerprint(rig.rig)||old.sequenceFingerprint!==sequence.fingerprint||old.sampleFingerprint||old.policyFingerprint!==policyFingerprint)throw new Error('修正需要当前姿态的最新静态比较报告，旧报告或实际动画报告不可复用。');
 if(old.metrics.some((m:any)=>m.required&&m.status==='unverifiable'))return {ok:false,issues:old.metrics.filter((m:any)=>m.required&&m.status==='unverifiable').map((m:any)=>({category:'inputMissing',metric:m.id,message:'必要关系无法验证，需先补标注或校准。'})),message:'未执行优化；未知输入不能用算法填补。'};
 const seed=structuredClone(initial.frame),variables:Array<{group:string;key:string;field:string;value:number;range:number;step:number}>=[];
 for(const field of ['x','y','rotate'])variables.push({group:'body',key:'',field,value:seed.body[field],range:field==='rotate'?45:1,step:field==='rotate'?.001:.0001});
 for(const [key,t]of Object.entries(seed.targets) as any){if(p.weapon&&key.endsWith('Hand'))continue;for(const field of ['x','y','angle']){if(field==='y'&&t.contact)continue;variables.push({group:'targets',key,field,value:t[field]??0,range:field==='angle'?(key.endsWith('Hand')?90:45):1,step:field==='angle'?.001:.0001});}}
 const frameAt=(x:number[])=>{const f=structuredClone(seed);variables.forEach((v,i)=>{if(v.group==='body')f.body[v.field]=x[i];else f.targets[v.key][v.field]=x[i];});return f;};
 const evaluate=(x:number[])=>{
  const f=frameAt(x),solved=solveSemanticPose(initial.rt,initial.mapping,f,p.groundY),target=runtimeGraph(solved.skeleton,rig.rig,initial.mapping,{...p,frame:f}),comparison=compareGraphs(reference.observation,target,p.correspondence),residuals=graphResiduals(comparison);
  const scale=initial.mapping.calibration!.scale,origin=initial.mapping.calibration!.origin!;
  // 同时优化实际锚点误差，防止参考误差下降而 IK/接地被破坏。
  for(const [key,t]of Object.entries(f.targets) as any){const anchor=(initial.mapping.bones.anchors as any)[key],b=solved.skeleton.findBone(anchor.bone)!,q=anchor.point,xw=b.worldX+b.a*q[0]+b.b*q[1];const yw=anchor.solePoints?.length?Math.min(...anchor.solePoints.map((v:number[])=>b.worldY+b.c*v[0]+b.d*v[1])):b.worldY+b.c*q[0]+b.d*q[1];residuals.push((xw-origin[0]-t.x*scale)/(key.endsWith('Foot')?.15:.35),(yw-origin[1]-(t.contact?p.groundY:t.y)*scale)/(t.contact?.01:.35));}
  // 相对关节指标不能确定全角色水平平移；固定这一自由度，避免数值漂移耗尽目标边界。
  residuals.push((f.body.x-seed.body.x)/.05);
  return residuals;
 };
 const result=await boundedLeastSquaresTask(variables.map(v=>v.value),evaluate,{bounds:variables.map(v=>[v.value-v.range,v.value+v.range]),steps:variables.map(v=>v.step),iterations:60}),frame=frameAt(result.x),candidate={...p,frame},final=await solvePoseData(candidate,c),graph=compareGraphs(reference.observation,runtimeGraph(final.skeleton,rig.rig,initial.mapping,candidate),p.correspondence),issues:PoseIssue[]=[];
 for(const metric of graph.metrics)if(metric.required&&metric.status!=='pass')issues.push({category:metric.status==='unverifiable'?'inputMissing':'relationMismatch',metric:metric.id,message:`${metric.id}: ${metric.status}`,stageId:p.stageId});
 if(!final.report.ok)issues.push({category:final.report.unreachable.length?'unreachable':'relationMismatch',message:final.report.issues.join('；'),stageId:p.stageId});
 return {ok:!issues.length,diagnosticOnly:!!issues.length,issues,sequenceFingerprint:sequence.fingerprint,sourcePoseFingerprint:poseFingerprint(p),optimizer:{method:'boundedDampedLeastSquares',...result,x:undefined,residuals:undefined},variables:variables.map((v,i)=>({...v,after:result.x[i]})),comparison:graph,numeric:final.report,solution:{bones:final.bones,...final.report},frame:final.frame,message:issues.length?'局部修正仍有冲突，保留诊断；不宣称全局无解。':'数值与关系通过；仍需出图与逐项视觉审查。'};

 });
}
