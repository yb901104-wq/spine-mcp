import { type ToolContext } from './spineJson.js';
import { readFile } from 'node:fs/promises';
import { resolveWorkspacePath } from './spineJson.js';
import { requireReferencePose, referenceFingerprint } from './referencePose.js';
import { requireVisualRig, readVisualNodes, visualRigFingerprint, visualSummary } from './visualRig.js';
import { compareGraphs, limbNodes, normalizedGraph, finitePoint, direction, distance, validateCorrespondence, policyFingerprint,torsoAxis } from './poseGraph.js';
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
 const p=await readJson(a.posePath,c);if(!p.referencePosePath||!p.visualRigPath)throw new Error('参考比较需要 referencePosePath 和 visualRigPath。');
 const r=await requireReferencePose(p.referencePosePath,c),v=await requireVisualRig(p.visualRigPath,c),s=await solvePoseData(p,c);
 if(v.fingerprint!==p.sourceFingerprint)throw new Error('姿态与 visualRig 角色不匹配。');
 let skeleton=s.skeleton,sampleFingerprint:string|null=null;
 if(a.animation){if(!a.candidatePath||!Number.isFinite(a.time)||a.time<0)throw new Error('实际动画复核需 candidatePath、animation、非负 time。');const json=await readJson(a.candidatePath,c);if(rigHash(json)!==rigHash(v.doc.json))throw new Error('候选改变角色结构，不能进行姿态比较。');const rt=await (await import('./motionRuntime.js')).loadMotionRuntime(json,v.mapping.atlasPath!,c);skeleton=rt.sample(a.animation,a.time,v.mapping.skin);sampleFingerprint=hashObject({json,time:a.time,animation:a.animation});}
 const target=runtimeGraph(skeleton,v.rig,v.mapping,p),comparison=compareGraphs(r.observation,target,p.correspondence);
 let sequence:any;try{sequence=await (await import('./poseSequence.js')).sequenceForPose(p,c);}catch(e){sequence={fingerprint:null,issues:poseIssuesFromError(e,p.stageId)};}
 const report={...comparison,ok:comparison.ok&&!!sequence.fingerprint,sequenceFingerprint:sequence.fingerprint,sequenceIssues:sequence.issues??[],posePath:a.posePath,poseFingerprint:poseFingerprint(p),referenceFingerprint:referenceFingerprint(r),visualRigFingerprint:visualRigFingerprint(v.rig),sampleFingerprint,target,reference:r.observation,correspondence:p.correspondence};
 const reportPath=a.reportPath??a.posePath.replace(/\.json$/,'.comparison.json');if(a.dryRun===false)await saveJson(reportPath,report,c);return {...report,target:a.detailed?target:visualSummary(target),dryRun:a.dryRun??true,reportPath};
}
export async function requirePoseComparison(p:any,c:ToolContext){
 if(!p.reference)return null;if(!p.visualRigPath||!p.comparisonPath)throw new Error('参考任务缺少 visualRig 或最新骨架关系比较报告。');
 await (await import('./poseSequence.js')).sequenceForPose(p,c);
 const old=await readJson(p.comparisonPath,c),fresh=await comparePoseGraphs({posePath:old.posePath,detailed:true},c);
 if(!fresh.ok||fresh.sampleFingerprint||fresh.poseFingerprint!==poseFingerprint(p)||hashObject({...old,reportPath:undefined,dryRun:undefined})!==hashObject({...fresh,reportPath:undefined,dryRun:undefined}))throw new Error('参考关系比较失败、缺少必要点或报告已过期。');return old;
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
async function retargetReferencePoseSeed(a:any,c:ToolContext={}){
 if(a.sequencePath){const sequence=await readJson(a.sequencePath,c);if(a.correspondence&&hashObject(a.correspondence)!==hashObject(sequence.correspondence))throw new Error('调用对应与动作级身份冲突。');a={...a,correspondence:sequence.correspondence};}
 if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.posePath,c));throw new Error('姿态已存在；请使用新修订路径，不覆盖现有审查。');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
 validateCorrespondence(a.correspondence);const r=await requireReferencePose(a.referencePosePath,c),v=await requireVisualRig(a.visualRigPath,c),base=await requireReviewedPose(a.standardPosePath,c);
 if(base.sourceFingerprint!==v.fingerprint)throw new Error('标准站姿与视觉绑定不匹配。');
 let s=await solvePoseData(base,c);const ref=normalizedGraph(r.observation.points,r.observation.facing,true),scale=v.mapping.calibration!.scale,origin=v.mapping.calibration!.origin!,targetFacing=a.facing??base.facing;
 const frame=structuredClone(base.frame),expected:any={},conflicts:string[]=[];frame.time=a.time??r.observation.time;frame.bendDirections={...frame.bendDirections};
 if(r.observation.actionSemantics){const anatomical=r.observation.actionSemantics.weaponHand,side=v.rig.anatomicalSides?.[anatomical];frame.action={driver:side?`${side}Hand`:null};if(!side)conflicts.push('未校准解剖持杖手到目标链的绑定。');}
 const calibrationNodes=readVisualNodes(s.skeleton,v.rig).points;
 const referenceAxis=torsoAxis(ref),targetAxis=torsoAxis(calibrationNodes);
 if(referenceAxis&&targetAxis&&distance(referenceAxis.hip,referenceAxis.shoulder)>1e-8){const sign=targetFacing==='left'?-1:1,desired=direction({x:referenceAxis.hip.x*sign,y:referenceAxis.hip.y},{x:referenceAxis.shoulder.x*sign,y:referenceAxis.shoulder.y}),current=direction(targetAxis.hip,targetAxis.shoulder),delta=((desired-current+540)%360)-180;frame.body.rotate+=delta;s=await solvePoseData({...base,frame},c);}
 else conflicts.push('肩中心—髋中心必要躯干轴未知。');
 const initial=readVisualNodes(s.skeleton,v.rig).points;
 for(const [role,n]of Object.entries(limbNodes)){
  const side=role.startsWith('left')?'left':'right',rs=a.correspondence[side],rn=n.map(k=>rs+k.slice(side.length));
  if(!rn.every(k=>finitePoint(ref[k]))){conflicts.push(`${role} 必要参考节点未知。`);continue;}
  const lengths=v.mapping.calibration!.lengths![role as 'leftArm'];const start=initial[n[0]],factor=targetFacing==='left'?-1:1;
  const u=direction(ref[rn[0]],ref[rn[1]])*Math.PI/180,l=direction(ref[rn[1]],ref[rn[2]])*Math.PI/180;
  expected[n[0]]=start;expected[n[1]]={x:start.x+factor*lengths[0]*Math.cos(u),y:start.y+lengths[0]*Math.sin(u)};expected[n[2]]={x:expected[n[1]].x+factor*lengths[1]*Math.cos(l),y:expected[n[1]].y+lengths[1]*Math.sin(l)};
  const cross=(ref[rn[1]].x-ref[rn[0]].x)*(ref[rn[2]].y-ref[rn[1]].y)-(ref[rn[1]].y-ref[rn[0]].y)*(ref[rn[2]].x-ref[rn[1]].x);frame.bendDirections[role]=cross*factor>=0?-1:1;
 }
 // 根据参考腿段同时计算两脚和身体高度；不可继承并腿准备姿态。
 const contacts=['left','right'].filter(side=>r.observation.support?.[a.correspondence[side]]===true);
 if(!contacts.length)conflicts.push('缺少明确支撑关系；第一版需至少一只支撑脚。');
 const deltas=contacts.map(side=>{
  const key=side+'Ankle',anchor=(v.mapping.bones.anchors as any)[side+'Foot'],node=v.rig.nodes[key],b=s.skeleton.findBone(anchor.bone)!;
  if(!expected[key]||node.type!=='boneLocal'||node.bone!==anchor.bone)return NaN;
  const rad=(frame.targets[side+'Foot'].angle??anchor.angle??0)*Math.PI/180,factor=Math.hypot(b.a,b.c),vertical=(p:number[])=>factor*(p[0]*Math.sin(rad)+p[1]*Math.cos(rad));
  // 地面锁定的是鞋底，不是踝；省略鞋底高度会把直腿准备误求解成深蹲。
  const lowest=anchor.solePoints?.length?Math.min(...anchor.solePoints.map(vertical)):vertical(anchor.point);
  const ankleHeight=base.groundY*scale+origin[1]-lowest+vertical(node.point);
  return ankleHeight-expected[key].y;
 });
 if(deltas.some(d=>!Number.isFinite(d)))conflicts.push('支撑脚必要节点未知。');
 // 保留主支撑脚的候选高度，另一侧差值必须明确报告并交联合求解，不取平均掩盖。
 const dy=deltas.length&&deltas.every(Number.isFinite)?deltas[0]:0;
 const contactResiduals=contacts.map((side,i)=>({side,requiredHeight:deltas[i],residual:deltas[i]-dy}));
 if(contactResiduals.some(v=>Math.abs(v.residual)>.15))conflicts.push('两脚接地高度要求冲突，需联合修正；未采用平均高度。');
 frame.body.y+=dy/scale;for(const point of Object.values(expected) as any[])point.y+=dy;
 // 身体移动后重新回读实际变换，用于视觉锚点到末端目标的转换。
 s=await solvePoseData({...base,frame},c);
 for(const side of ['left','right'])for(const part of ['Leg','Arm']){
  const role=side+part,n=limbNodes[role],end=expected[n[2]],hand=part==='Arm',key=side+(hand?'Hand':'Foot');if(!end)continue;
  const anchor=(v.mapping.bones.anchors as any)[key],node=v.rig.nodes[n[2]],b=s.skeleton.findBone(anchor.bone)!,angle=frame.targets[key].angle??anchor.angle??0,rad=angle*Math.PI/180,factor=Math.hypot(b.a,b.c);
  // 握持偏移方向来自已标注腕到握点，不继承站姿的垂手角度。
  if(hand&&r.observation.grip?.points?.[a.correspondence[side]]&&anchor.gripPoint){const g=r.observation.grip.points[a.correspondence[side]],w=r.observation.points[a.correspondence[side]+'Wrist'],dx=(g.x-w.x)*(targetFacing==='left'?-1:1),dy=-(g.y-w.y),local=Math.atan2(anchor.gripPoint[1]-anchor.point[1],anchor.gripPoint[0]-anchor.point[0]);if(Math.hypot(dx,dy)>1e-8)frame.targets[key].angle=(Math.atan2(dy,dx)-local)*180/Math.PI;}
  const targetAngle=frame.targets[key].angle??angle,targetRad=targetAngle*Math.PI/180;
  // 视觉末端与骨骼末端之间的偏移，转换到现有锚点目标。
  if(node.type!=='boneLocal'||node.bone!==anchor.bone){conflicts.push(`${n[2]} 非末端骨骼局部锚点，第一版不自动反解网格目标。`);continue;}
  const dx=(anchor.point[0]-node.point[0])*factor,dy=(anchor.point[1]-node.point[1])*factor;
  frame.targets[key]={x:(end.x+dx*Math.cos(targetRad)-dy*Math.sin(targetRad)-origin[0])/scale,y:(end.y+dx*Math.sin(targetRad)+dy*Math.cos(targetRad)-origin[1])/scale,angle:targetAngle,...!hand?{contact:r.observation.support?.[a.correspondence[side]]===true}:{}};
 }
 const draft=await createPoseDraft({filePath:v.rig.filePath,mappingPath:v.rig.mappingPath,posePath:a.posePath,id:a.id,kind:'action',standardPosePath:a.standardPosePath,referencePosePath:a.referencePosePath,visualRigPath:a.visualRigPath,correspondence:a.correspondence,sequencePath:a.sequencePath,stageId:a.stageId,facing:a.facing??base.facing,frame,weapon:a.weapon,dryRun:true},c);
 draft.pose.adaptation={expected,conflicts,contactResiduals,policyFingerprint,method:'参考两段方向与目标链长；躯干轴独立；双脚接地残差分别报告。'};
 const solved=await solvePoseData(draft.pose,c);draft.pose.frame=solved.frame;draft.pose.solution={bones:solved.bones,...solved.report};draft.pose.status=solved.report.ok?'solved':'failed';
 const actual=runtimeGraph(solved.skeleton,v.rig,v.mapping,draft.pose),comparison=compareGraphs(r.observation,actual,a.correspondence);
 const changes={coordinateSystem:'normalizedSkeleton',body:Object.fromEntries(['x','y','rotate'].map(k=>[k,solved.frame.body[k as 'x']-base.frame.body[k]])),targets:Object.fromEntries(Object.entries(solved.frame.targets).map(([key,t]:any)=>[key,Object.fromEntries(['x','y','angle'].map(k=>[k,(t[k]??0)-(base.frame.targets[key]?.[k]??0)]))])),bendDirections:{before:base.frame.bendDirections??v.mapping.bones.bendDirections,after:solved.frame.bendDirections}};
 if(!comparison.ok)conflicts.push(...comparison.metrics.filter(m=>m.required&&m.status!=='pass').map(m=>`${m.id}: ${m.status}`));if(!solved.report.ok)conflicts.push(...solved.report.issues);
 try{await (await import('./poseSequence.js')).sequenceForPose(draft.pose,c);}catch(e){conflicts.push(String(e));}
 const ok=!conflicts.length,reportPath=a.reportPath??a.posePath.replace(/\.json$/,'.adaptation.json');
 if(a.dryRun===false){await saveJson(a.posePath,draft.pose,c);await solvePose({posePath:a.posePath,dryRun:false},c);const cmp=await comparePoseGraphs({posePath:a.posePath,dryRun:false},c);const p=await readJson(a.posePath,c);p.comparisonPath=cmp.reportPath;await saveJson(a.posePath,p,c);await saveJson(reportPath,{ok,conflicts,changes,expected,actual,comparison},c);}
 return {ok,dryRun:a.dryRun??true,posePath:a.posePath,pose:a.detailed?draft.pose:{id:draft.pose.id,status:draft.pose.status,frame:draft.pose.frame},reportPath,conflicts,contactResiduals,changes,expected,actual:a.detailed?actual:visualSummary(actual),comparison,message:ok?'仅生成草稿，尚需图像与逐阶段审查。':'冲突停止：仅生成诊断候选，不批准、不写角色。'};
}
export async function compareAnimationKeyPoses(candidatePath:string,animation:string,motion:any,duration:number,c:ToolContext){
 const reports=[];for(const k of motion.poseWorkflow?.keyPoses??[]){const p=await readJson(k.posePath,c);if(p.reference){const report=await comparePoseGraphs({posePath:k.posePath,candidatePath,animation,time:k.time*duration/motion.duration},c);reports.push({stageId:k.stageId,time:k.time,report});}}
 return {ok:reports.every(v=>v.report.ok),reports,fingerprint:hashObject(reports)};
}
