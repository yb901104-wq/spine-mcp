import { drawReferenceSkeleton, requireReferencePose } from './referencePose.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readSpineDocument, resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { readCharacterMapping, validateMotion, type MotionDefinition } from './motionEngine.js';
import { hashObject, rigHash, mappingFingerprint, saveJson } from './mappingTools.js';
import { loadMotionRuntime, worldVertices } from './motionRuntime.js';
import { solveSemanticPose } from './retargetEngine.js';
import { loadAtlasImages, rasterFrame } from './rasterRenderer.js';

export const poseChecks = ['standingOrAction','silhouette','jointDirections','support','grip','occlusion','referenceDifferences'];
export const animationChecks = ['transitions','timing','followThrough','keyPoses','loop'];
export const readJson = async (p:string,c:ToolContext) => JSON.parse(await readFile(resolveWorkspacePath(p,c),'utf8'));
export const fileHash = async (p:string,c:ToolContext) => hashObject((await readFile(resolveWorkspacePath(p,c))).toString('base64'));
export function mergePose(a:any,b:any):any { const result=structuredClone(a??{}); for(const [k,v] of Object.entries(b??{})) result[k]=v&&typeof v==='object'&&!Array.isArray(v)?mergePose(result[k],v):structuredClone(v); return result; }
export async function characterFingerprint(filePath:string,mappingPath:string,c:ToolContext) {
  const doc=await readSpineDocument(filePath,c),mapping=await readCharacterMapping(mappingPath,c);
  if(mapping.status!=='confirmed'||mapping.rigHash!==rigHash(doc.json))throw new Error('姿态需要已确认且角色结构匹配的 mapping。');
  const rt=await loadMotionRuntime(doc.json,mapping.atlasPath!,c),assets=[];
  for(const page of rt.atlas.pages)assets.push(await fileHash(path.join(path.dirname(mapping.atlasPath!),page.name),c));
  return {fingerprint:hashObject({rig:rigHash(doc.json),mapping:mappingFingerprint(mapping),atlas:await fileHash(mapping.atlasPath!,c),assets}),doc,mapping,rt};
}
export function poseFingerprint(p:any) {return hashObject({version:p.version,id:p.id,kind:p.kind,facing:p.facing,frame:p.frame,groundY:p.groundY,standardPosePath:p.standardPosePath,referencePosePath:p.referencePosePath,reference:p.reference,weapon:p.weapon,policy:p.policy,visualRigPath:p.visualRigPath,correspondence:p.correspondence,sequencePath:p.sequencePath,stageId:p.stageId,sourceFingerprint:p.sourceFingerprint,solution:p.solution});}
function validateReference(r:any) {
  if(!r)return;
  if(!r.imagePath||!r.facing||!r.basis||!Number.isFinite(r.time)||r.time<0||!Number.isFinite(r.height)||r.height<=0||!Number.isFinite(r.groundY)||!Array.isArray(r.crop)||r.crop.length!==4||!r.crop.every(Number.isFinite)||r.crop[2]<=0||r.crop[3]<=0)throw new Error('参考记录需 imagePath/time/facing/crop/height/groundY/basis；图像坐标仅用于观察。');
  for(const v of Object.values(r.points??{}) as any[])if(!['visible','occluded','unknown'].includes(v.visibility)||v.visibility==='visible'&&(!Number.isFinite(v.x)||!Number.isFinite(v.y)))throw new Error('参考关键点必须声明可见性，可见点需有限图像坐标。');
}
export async function createPoseDraft(a:any,c:ToolContext={}) {
  const source=await characterFingerprint(a.filePath,a.mappingPath,c);let base:any={};
  if(a.standardPosePath){base=await requireReviewedPose(a.standardPosePath,c);if(base.kind!=='standing'||base.sourceFingerprint!==source.fingerprint)throw new Error('标准姿态角色不匹配。');}
  if(!['standing','action'].includes(a.kind))throw new Error('kind 必须为 standing/action。');
  if(a.kind==='action'&&!a.standardPosePath)throw new Error('动作姿态必须选择已确认标准站姿。');
  if(a.referencePosePath){const record=await requireReferencePose(a.referencePosePath,c);a.reference=record.observation;}
  validateReference(a.reference);
  const pose:any={version:1,id:a.id??randomUUID(),kind:a.kind,facing:a.facing??base.facing??'right',status:'draft',filePath:a.filePath,mappingPath:a.mappingPath,standardPosePath:a.standardPosePath??null,sourceFingerprint:source.fingerprint,frame:mergePose(base.frame??{time:0,body:{x:0,y:0,rotate:0},head:0,channels:{},targets:{}},a.frame),groundY:a.groundY??base.groundY??0,weapon:a.weapon??null,referencePosePath:a.referencePosePath??null,reference:a.reference??null,policy:{kneeFlexionMax:a.kneeFlexionMax??30,reason:a.thresholdReason??''}};
  if(!Number.isFinite(pose.policy.kneeFlexionMax)||pose.policy.kneeFlexionMax<0||pose.policy.kneeFlexionMax>180||pose.policy.kneeFlexionMax!==30&&!pose.policy.reason.trim())throw new Error('自定义膝部阈值需有限 0–180 度和明确理由。');
  Object.assign(pose,{visualRigPath:a.visualRigPath??null,correspondence:a.correspondence??null,...a.sequencePath?{sequencePath:a.sequencePath,stageId:a.stageId}:{}});
  if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.posePath,c));throw new Error('姿态文件已存在，请使用新路径。');}catch(e:any){if(e.code!=='ENOENT')throw e;}await saveJson(a.posePath,pose,c);}return {ok:true,dryRun:a.dryRun??true,pose,posePath:a.posePath};
}
export async function adjustPose(a:any,c:ToolContext={}) {
  if(a.posePath===a.outputPosePath)throw new Error('修改姿态需新 outputPosePath，保留原修订。');
  const p=await readJson(a.posePath,c),patch=a.patch??{};
  for(const k of Object.keys(patch))if(!['frame','weapon','reference','referencePosePath','groundY','policy','visualRigPath','correspondence','sequencePath','stageId'].includes(k))throw new Error('只允许修改姿态参数。');
  const q=mergePose(p,patch);if(patch.referencePosePath){const record=await requireReferencePose(patch.referencePosePath,c);q.reference=record.observation;}q.id=randomUUID();q.status='draft';delete q.solution;delete q.review;delete q.comparisonPath;validateReference(q.reference);
  if(q.policy.kneeFlexionMax!==30&&!q.policy.reason?.trim())throw new Error('自定义膝部阈值需理由。');
  if(a.dryRun===false)await saveJson(a.outputPosePath,q,c);return {ok:true,dryRun:a.dryRun??true,pose:q,posePath:a.outputPosePath};
}
function geometricFlex(a:any,b:any,d:any){const ux=a.x-b.x,uy=a.y-b.y,vx=d.x-b.x,vy=d.y-b.y;return 180-Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/(Math.hypot(ux,uy)*Math.hypot(vx,vy)))))*180/Math.PI;}
export async function solvePoseData(p:any,c:ToolContext) {
  if(!p.policy||!Number.isFinite(p.policy.kneeFlexionMax)||p.policy.kneeFlexionMax<0||p.policy.kneeFlexionMax>180||p.policy.kneeFlexionMax!==30&&!p.policy.reason?.trim())throw new Error('站姿阈值无效或缺少理由。');
  if(['leftFoot','rightFoot','leftHand','rightHand'].some(k=>!p.frame.targets?.[k]))throw new Error('姿态必须明确双手双脚目标。');
  const s=await characterFingerprint(p.filePath,p.mappingPath,c);if(s.fingerprint!==p.sourceFingerprint)throw new Error('姿态资源或 mapping 已改变，请重新建立姿态。');
  if(!Number.isFinite(p.frame.time)||p.frame.time<0)throw new Error('姿态时间需非负有限数。');
  const frame=structuredClone(p.frame),scale=s.mapping.calibration!.scale;
  if(p.weapon){const w=p.weapon;if(![w.x,w.y,w.angle,...Object.values(w.grips??{})].every(Number.isFinite)||!Number.isFinite(w.grips?.left)||!Number.isFinite(w.grips?.right))throw new Error('假想杆需 x/y/angle/grips.left/right，使用 normalizedSkeleton 坐标。');
    const r=w.angle*Math.PI/180;
    for(const side of ['left','right'] as const){const role=`${side}Hand` as const,anchor=s.mapping.bones.anchors?.[role];if(!anchor?.gripPoint)throw new Error(`${role} 未校准 gripPoint，不能假装手腕就是握持点。`);const t=frame.targets[role]??{};const angle=t.angle??w.angle;const h=angle*Math.PI/180,g=anchor.gripPoint,point=anchor.point;frame.targets[role]={...t,x:w.x+w.grips[side]*Math.cos(r)-((g[0]-point[0])*Math.cos(h)-(g[1]-point[1])*Math.sin(h))/scale,y:w.y+w.grips[side]*Math.sin(r)-((g[0]-point[0])*Math.sin(h)+(g[1]-point[1])*Math.cos(h))/scale,angle};}}
  validateMotion({version:2,name:'pose',duration:1,loop:false,coordinateSystem:'normalizedSkeleton',frames:[{...frame,time:0},{...frame,time:1}]});
  for(const v of Object.values(frame.bendDirections??{}))if(v!==1&&v!==-1)throw new Error('关节弯曲方向必须为 ±1。');
  const solved=solveSemanticPose(s.rt,s.mapping,frame,p.groundY),joints:any={},flexion:any={},errors:any={},issues:string[]=[];
  for(const role of ['leftLeg','rightLeg','leftArm','rightArm'] as const){const chain=s.mapping.bones[role]!;const labels=role.endsWith('Leg')?['Hip','Knee','Ankle']:['Shoulder','Elbow','Wrist'];const side=role.startsWith('left')?'left':'right';chain.forEach((n,i)=>{const b=solved.skeleton.findBone(n)!;joints[side+labels[i]]={x:b.worldX,y:b.worldY};});flexion[role]=geometricFlex(...chain.map(n=>{const b=solved.skeleton.findBone(n)!;return {x:b.worldX,y:b.worldY};}) as [any,any,any]);}
  if(p.kind==='standing'){for(const r of ['leftLeg','rightLeg'])if(flexion[r]>p.policy.kneeFlexionMax+1e-5)issues.push(`${r} 屈曲 ${flexion[r].toFixed(2)}° 超过站姿阈值 ${p.policy.kneeFlexionMax}°`);for(const r of ['leftFoot','rightFoot'])if(!frame.targets[r]?.contact)issues.push('标准站姿必须双脚接触地面。');}
  for(const [role,t] of Object.entries(frame.targets) as any){const a=s.mapping.bones.anchors![role as 'leftFoot']!;const b=solved.skeleton.findBone(a.bone)!;let x=b.worldX+b.a*a.point[0]+b.b*a.point[1],y=b.worldY+b.c*a.point[0]+b.d*a.point[1];if(a.solePoints?.length)y=Math.min(...a.solePoints.map(v=>b.worldY+b.c*v[0]+b.d*v[1]));const origin=s.mapping.calibration!.origin!;errors[role]=Math.hypot(x-origin[0]-t.x*scale,y-origin[1]-(t.contact?p.groundY:t.y)*scale);if(errors[role]>.01)issues.push(`${role} 目标误差 ${errors[role]}`);}
  if(solved.unreachable.length)issues.push('存在不可达手脚目标。');
  const vertexMap=worldVertices(solved.skeleton),vertices=Object.values(vertexMap).flat();if(!vertices.length)vertices.push(-1,-1,1,1);
  const xs=vertices.filter((_,i)=>i%2===0),ys=vertices.filter((_,i)=>i%2===1),bounds={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};
  if(!Object.values(bounds).every(Number.isFinite))issues.push('非有限渲染范围。');
  const gripErrors:any={};if(p.weapon){const w=p.weapon,r=w.angle*Math.PI/180,origin=s.mapping.calibration!.origin!;for(const side of ['left','right'] as const){const a=s.mapping.bones.anchors![`${side}Hand`]!,b=solved.skeleton.findBone(a.bone)!,g=a.gripPoint!;gripErrors[side]=Math.hypot(b.worldX+b.a*g[0]+b.b*g[1]-origin[0]-(w.x+w.grips[side]*Math.cos(r))*scale,b.worldY+b.c*g[0]+b.d*g[1]-origin[1]-(w.y+w.grips[side]*Math.sin(r))*scale);if(gripErrors[side]>.01)issues.push(`${side} 握持误差 ${gripErrors[side]}`);}}
  const warnings:string[]=[];const headSlot=s.doc.json.slots?.find((slot:any)=>slot.bone===s.mapping.bones.head);const hv=Object.entries(vertexMap).find(([name])=>name.startsWith(headSlot?.name+':'))?.[1];if(hv){const hx=hv.filter((_,i)=>i%2===0),hy=hv.filter((_,i)=>i%2===1);for(const side of ['left','right']){const w=joints[side+'Wrist'];if(w.x>=Math.min(...hx)&&w.x<=Math.max(...hx)&&w.y>=Math.min(...hy)&&w.y<=Math.max(...hy))warnings.push(`${side} 手腕进入头部包围盒，需视觉检查遮挡。`);}}
  let visual:any=null;if(p.visualRigPath){const mod=await import('./visualRig.js'),v=await mod.requireVisualRig(p.visualRigPath,c);if(v.fingerprint!==s.fingerprint)throw new Error('visualRig 与姿态角色不匹配。');visual=mod.readVisualNodes(solved.skeleton,v.rig);}
  return {...s,...solved,frame,report:{ok:!issues.length,issues,warnings,gripErrors,flexion,errors,joints,solverNodes:joints,visualNodes:visual?.points??null,visual,bounds,height:bounds.maxY-bounds.minY,unreachable:solved.unreachable}};
}
export async function solvePose(a:any,c:ToolContext={}) {const p=await readJson(a.posePath,c),s=await solvePoseData(p,c);p.frame=s.frame;p.solution={bones:s.bones,...s.report};p.status=s.report.ok?'solved':'failed';delete p.review;if(a.dryRun===false)await saveJson(a.posePath,p,c);return {ok:s.report.ok,dryRun:a.dryRun??true,pose:p,report:s.report};}
async function requirePoseReference(p:any,c:ToolContext){if(!p.reference)return;if(!p.referencePosePath)throw new Error('参考姿态需先独立标注和审查。');const r=await requireReferencePose(p.referencePosePath,c);if(hashObject(r.observation)!==hashObject(p.reference))throw new Error('参考标注与目标姿态不一致。');}
export async function requireReviewedPose(pth:string,c:ToolContext) {const p=await readJson(pth,c);const s=await solvePoseData(p,c);if(!s.report.ok)throw new Error('姿态当前数值校验失败。');await requirePoseReference(p,c);const comparison=await (await import('./referenceRetarget.js')).requirePoseComparison(p,c);if(p.status!=='confirmed'||p.review?.decision!=='approved'||p.review.poseFingerprint!==poseFingerprint(p)||comparison&&p.review.comparisonFingerprint!==hashObject(comparison))throw new Error(`姿态未确认或已过期：${pth}`);await verifyEvidence(p.review.evidence,c);return p;}
export async function evidenceFiles(files:string[],c:ToolContext){return Promise.all(files.map(async filePath=>({filePath,hash:await fileHash(filePath,c)})));}
export async function verifyEvidence(e:any[],c:ToolContext){if(!e?.length)throw new Error('缺少视觉证据。');for(const v of e)if(await fileHash(v.filePath,c)!==v.hash)throw new Error('视觉证据已改变。');}
export async function reviewPose(a:any,c:ToolContext={}) {
  const p=await readJson(a.posePath,c),manifest=await readJson(a.manifestPath,c);const solved=await solvePoseData(p,c);if(a.decision==='approved'){await requirePoseReference(p,c);if(!solved.report.ok)throw new Error('姿态当前数值校验失败。');}
  if(!manifest.poses?.some((v:any)=>v.posePath===a.posePath&&v.fingerprint===poseFingerprint(p)))throw new Error('对比图不包含当前姿态修订。');
  if(!a.reviewedBy?.trim()||!a.reason?.trim()||!['approved','rejected'].includes(a.decision)||poseChecks.some(k=>!a.checks?.includes(k)))throw new Error('需确认者、理由、decision 和全部姿态检查项。');
  if(a.decision==='approved'&&(!p.solution?.ok||a.issues?.length))throw new Error('数值失败或仍有问题不能确认。');
  let comparison:any=null;if(a.decision==='approved'&&p.reference){p.comparisonPath=a.comparisonPath??p.comparisonPath;comparison=await (await import('./referenceRetarget.js')).requirePoseComparison(p,c);if(poseChecks.some(k=>!a.checkResults?.[k]?.reason?.trim()||a.checkResults[k].status!=='pass')||!a.stageId?.trim()||new Set(poseChecks.map(k=>a.checkResults[k].reason.trim())).size!==poseChecks.length)throw new Error('参考姿态需逐阶段 stageId 与每项 checkResults.status/reason；统一文本不能代替。');}
  const evidence=[...manifest.evidence,...await evidenceFiles([a.manifestPath],c)];await verifyEvidence(evidence,c);
  p.review={decision:a.decision,reviewedBy:a.reviewedBy,reason:a.reason,checks:a.checks,stageId:a.stageId,checkResults:a.checkResults,comparisonFingerprint:comparison?hashObject(comparison):null,issues:a.issues??[],poseFingerprint:poseFingerprint(p),evidence,at:new Date().toISOString()};p.status=a.decision==='approved'?'confirmed':'rejected';if(a.dryRun===false)await saveJson(a.posePath,p,c);return {ok:true,dryRun:a.dryRun??true,review:p.review};
}
export async function buildMotionFromPoses(a:any,c:ToolContext={}) {
  const standard=await requireReviewedPose(a.standardPosePath,c);if(standard.kind!=='standing')throw new Error('需标准站姿。');
  if(!Array.isArray(a.keyPoses)||a.keyPoses.length<2||a.keyPoses[0].time!==0||a.keyPoses.at(-1).time!==a.duration||a.keyPoses.some((v:any,i:number)=>!v.stageId||!Number.isFinite(v.time)||i>0&&v.time<=a.keyPoses[i-1].time))throw new Error('关键姿态需唯一递增时间、阶段 ID，包含 0 和 duration。');
  if(new Set(a.keyPoses.map((v:any)=>v.stageId)).size!==a.keyPoses.length)throw new Error('阶段 ID 不可重复。');
  const frames=[],reasons=new Set();let referenceBinding:string|undefined;for(const v of a.keyPoses){const p=await requireReviewedPose(v.posePath,c);if(p.sourceFingerprint!==standard.sourceFingerprint||p.groundY!==standard.groundY||p.kind!=='standing'&&p.standardPosePath!==a.standardPosePath)throw new Error('关键姿态标准站姿或角色不匹配。');if(p.reference){const binding=hashObject({visualRig:(await readJson(p.comparisonPath,c)).visualRigFingerprint,sequence:(await readJson(p.comparisonPath,c)).sequenceFingerprint,left:p.correspondence.left,right:p.correspondence.right});if(referenceBinding&&referenceBinding!==binding)throw new Error('阶段之间视觉绑定或左右对应不一致，禁止临时交换。');referenceBinding=binding;const reason=hashObject({reason:p.review.reason,checkResults:p.review.checkResults});if(p.review.stageId!==v.stageId||reasons.has(reason))throw new Error('参考关键姿态阶段不符或使用统一文本批量批准。');reasons.add(reason);}frames.push({...p.frame,time:v.time});}
  const motion:MotionDefinition={version:2,name:a.name,duration:a.duration,loop:a.loop??false,groundY:standard.groundY,coordinateSystem:'normalizedSkeleton',frames,poseWorkflow:{standardPosePath:a.standardPosePath,keyPoses:a.keyPoses}};validateMotion(motion);
  if(a.dryRun===false)await saveJson(a.motionPath,motion,c);return {ok:true,dryRun:a.dryRun??true,motion};
}
export async function poseGate(motion:MotionDefinition,c:ToolContext) {
  try {if(!motion.poseWorkflow)throw new Error('缺少标准站姿与关键姿态审查；旧 motion 需补审查。');const standard=await requireReviewedPose(motion.poseWorkflow.standardPosePath,c);const stamps=[];
    const reasons=new Set();let referenceBinding:string|undefined;for(const k of motion.poseWorkflow.keyPoses){const p=await requireReviewedPose(k.posePath,c);const f=motion.frames?.find(f=>Math.abs(f.time-k.time)<1e-8);if(!f||hashObject({...f,time:0})!==hashObject({...p.frame,time:0})||p.sourceFingerprint!==standard.sourceFingerprint)throw new Error('motion 关键姿态已偏离确认结果。');if(p.reference){const binding=hashObject({visualRig:(await readJson(p.comparisonPath,c)).visualRigFingerprint,sequence:(await readJson(p.comparisonPath,c)).sequenceFingerprint,left:p.correspondence.left,right:p.correspondence.right});if(referenceBinding&&referenceBinding!==binding)throw new Error('阶段之间视觉绑定或左右对应改变。');referenceBinding=binding;const reason=hashObject({reason:p.review.reason,checkResults:p.review.checkResults});if(p.review.stageId!==k.stageId||reasons.has(reason))throw new Error('参考阶段不符或统一文本审查。');reasons.add(reason);}stamps.push({stageId:k.stageId,time:k.time,poseFingerprint:poseFingerprint(p),review:hashObject(p.review)});}
    if(!stamps.length||stamps[0].time!==0||stamps.at(-1)!.time!==motion.duration)throw new Error('审查必须覆盖开始与结束。');return {ok:true,sourceFingerprint:standard.sourceFingerprint,fingerprint:hashObject({standard:poseFingerprint(standard),review:standard.review,stamps}),issues:[] as string[]};
  }catch(e){return {ok:false,sourceFingerprint:null,fingerprint:null,issues:[String(e)]};}
}

export async function renderPoseComparison(a:any,c:ToolContext={}) {
  if(!Array.isArray(a.posePaths)||!a.posePaths.length||a.posePaths.length>60)throw new Error('posePaths 数量需为 1–60。');
  const entries:any[]=[];for(const posePath of a.posePaths){const pose=await readJson(posePath,c),s=await solvePoseData(pose,c);if(!pose.solution||hashObject(pose.solution.bones)!==hashObject(s.bones))throw new Error('请先保存最新单姿态求解结果。');let comparison:any=null;if(pose.referencePosePath&&pose.visualRigPath)try{comparison=await (await import('./referenceRetarget.js')).comparePoseGraphs({posePath},c);}catch(e){comparison={ok:false,message:String(e),metrics:[]};}entries.push({posePath,pose,s,comparison});}
  if(a.targetTimes&&(a.targetTimes.length!==entries.length||a.targetTimes.some((v:any)=>!Number.isFinite(v)||v<0))||a.stageIds&&a.stageIds.length!==entries.length)throw new Error('阶段 ID 和时间必须与姿态数量一致。');
  const height=a.height??320,width=a.width??320;if(!Number.isInteger(width)||!Number.isInteger(height)||width<128||height<128||width>1024||height>1024)throw new Error('面板宽高需为128–1024。');
  const standard=entries[0].pose.kind==='standing'?entries[0].pose:await requireReviewedPose(entries[0].pose.standardPosePath,c);const standardHeight=standard.solution.height;
  if(entries.some(e=>e.pose.sourceFingerprint!==standard.sourceFingerprint))throw new Error('一个对比任务只能绑定一个目标角色。');
  const sc=height*.7/standardHeight,all=entries.map(e=>e.s.report.bounds),cx=(Math.min(...all.map(v=>v.minX))+Math.max(...all.map(v=>v.maxX)))/2,ground=standard.groundY*entries[0].s.mapping.calibration!.scale+entries[0].s.mapping.calibration!.origin![1];
  const bounds={minX:cx-width/(2*sc),maxX:cx+width/(2*sc),minY:ground-height*.1/sc,maxY:ground+height*.9/sc};
  const dir=a.outputDir??`previews/jobs/poses-${randomUUID()}`;await mkdir(resolveWorkspacePath(dir,c),{recursive:true});const images=await loadAtlasImages(entries[0].s.rt.atlas,entries[0].s.mapping.atlasPath!,c);
  const evidencePaths:string[]=[],pages:any[]=[];const project=(x:number,y:number)=>[(x-bounds.minX)*sc,(bounds.maxY-y)*sc];
  const reference=entries.find(e=>e.pose.reference)?.pose.reference;for(const e of entries)if(e.pose.reference&&hashObject({crop:e.pose.reference.crop,height:e.pose.reference.height,groundY:e.pose.reference.groundY})!==hashObject({crop:reference.crop,height:reference.height,groundY:reference.groundY}))throw new Error('参考序列必须使用固定裁剪、角色高度和地面线。');
  for(let start=0;start<entries.length;start+=6){const n=Math.min(6,entries.length-start),clean=createCanvas(width*n,(height+40)*2),diagnostic=createCanvas(width*n,(height+40)*2);for(const canvas of [clean,diagnostic]){const ctx=canvas.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,canvas.width,canvas.height);}
    for(let i=0;i<n;i++){const e=entries[start+i],r=e.pose.reference,x=i*width,y=height+40;const target=rasterFrame(e.s.skeleton,images,bounds,width,height,'#20242b');for(const canvas of [clean,diagnostic]){const ctx=canvas.getContext('2d');ctx.drawImage(target,x,y);ctx.fillStyle='white';ctx.font='14px sans-serif';ctx.fillText(`${start+i+1} ${a.stageIds?.[start+i]??e.pose.id} / target ${(a.targetTimes?.[start+i]??e.pose.frame.time).toFixed(3)}s ${e.pose.facing}`,x+5,y+height+22);
      if(r){const im=await loadImage(await readFile(resolveWorkspacePath(r.imagePath,c))),rs=height*.7/r.height;const [rx,ry,rw,rh]=r.crop;const dx=width/2-rw*rs/2,dy=height*.9-(r.groundY-ry)*rs;ctx.save();ctx.beginPath();ctx.rect(x,0,width,height);ctx.clip();ctx.drawImage(im,rx,ry,rw,rh,x+dx,dy,rw*rs,rh*rs);ctx.restore();ctx.fillText(`${a.stageIds?.[start+i]??e.pose.id} / reference ${r.time.toFixed(3)}s ${r.facing}`,x+5,height+22);
        if(canvas===diagnostic){ctx.strokeStyle='#78d4ff';ctx.beginPath();ctx.moveTo(x,height*.9);ctx.lineTo(x+width,height*.9);ctx.stroke();drawReferenceSkeleton(ctx,r,(px,py)=>[x+dx+(px-rx)*rs,dy+(py-ry)*rs]);}}
      else ctx.fillText('No reference: target standing calibration',x+5,height+22);
    }
    const ctx=diagnostic.getContext('2d');ctx.font='11px sans-serif';ctx.strokeStyle='#78d4ff';ctx.beginPath();ctx.moveTo(x,y+height*.9);ctx.lineTo(x+width,y+height*.9);ctx.stroke();
    if(e.s.report.visual){(await import('./visualRig.js')).drawVisualGraph(ctx,e.s.report.visual,(px,py)=>{const q=project(px,py);return [x+q[0],y+q[1]];},e.comparison);ctx.fillStyle=e.comparison?.ok?'#65dfab':'#ff4264';ctx.fillText(e.comparison?`Graph: ${e.comparison.ok?'PASS':'FAIL / UNVERIFIABLE'}`:'Visual calibration',x+5,y+16);if(e.pose.correspondence)ctx.fillText(`target L <- ref ${e.pose.correspondence.left}; R <- ref ${e.pose.correspondence.right}`,x+5,y+29);}
    else {ctx.fillStyle='#ffba6b';ctx.fillText('Solver origins only — visualRig missing',x+5,y+16);for(const side of ['left','right'])for(const chain of [['Hip','Knee','Ankle'],['Shoulder','Elbow','Wrist']]){ctx.strokeStyle=side==='left'?'#65dfab':'#ffba6b';ctx.beginPath();chain.forEach((suffix,i)=>{const p=e.s.report.joints[side+suffix],q=project(p.x,p.y);i?ctx.lineTo(x+q[0],y+q[1]):ctx.moveTo(x+q[0],y+q[1]);});ctx.stroke();}}
    for(const [label,t] of Object.entries(e.s.frame.targets) as any){const origin=e.s.mapping.calibration!.origin!,scale=e.s.mapping.calibration!.scale,q=project(origin[0]+t.x*scale,origin[1]+(t.contact?e.pose.groundY:t.y)*scale);ctx.strokeStyle='#ff68db';ctx.strokeRect(x+q[0]-4,y+q[1]-4,8,8);ctx.fillStyle='#ff68db';ctx.fillText(`${label} target`,x+q[0]+5,y+q[1]+12);}
    for(const [label,p]of Object.entries(e.pose.adaptation?.expected??{}) as any){const q=project(p.x,p.y);ctx.strokeStyle='#fff17a';ctx.beginPath();ctx.moveTo(x+q[0]-3,y+q[1]);ctx.lineTo(x+q[0]+3,y+q[1]);ctx.moveTo(x+q[0],y+q[1]-3);ctx.lineTo(x+q[0],y+q[1]+3);ctx.stroke();}
    const grips=e.comparison?.target?.grip?.points;if(grips?.left&&grips?.right){ctx.strokeStyle='#fff17a';ctx.setLineDash([3,3]);ctx.beginPath();for(const [i,side]of ['left','right'].entries()){const q=project(grips[side].x,grips[side].y);i?ctx.lineTo(x+q[0],y+q[1]):ctx.moveTo(x+q[0],y+q[1]);ctx.strokeRect(x+q[0]-3,y+q[1]-3,6,6);}ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#fff17a';ctx.fillText('actual grip axis',x+5,y+43);}
    if(e.pose.weapon){const w=e.pose.weapon,scale=e.s.mapping.calibration!.scale,origin=e.s.mapping.calibration!.origin!,rad=w.angle*Math.PI/180;ctx.strokeStyle='#fff17a';ctx.beginPath();for(const [idx,v] of [-1,1].entries()){const q=project(origin[0]+(w.x+v*.8*Math.cos(rad))*scale,origin[1]+(w.y+v*.8*Math.sin(rad))*scale);idx?ctx.lineTo(x+q[0],y+q[1]):ctx.moveTo(x+q[0],y+q[1]);}ctx.stroke();}
    }
    const page={clean:`${dir}/page-${start/6+1}-clean.png`,diagnostic:`${dir}/page-${start/6+1}-diagnostic.png`};for(const [k,canvas] of [['clean',clean],['diagnostic',diagnostic]] as const){await writeFile(resolveWorkspacePath(page[k],c),canvas.toBuffer('image/png'));evidencePaths.push(page[k]);}pages.push(page);
  }
  for(const e of entries)if(e.pose.reference)evidencePaths.push(e.pose.reference.imagePath);
  if(a.region){const [rx,ry,rw,rh]=a.region;if(!a.region.every(Number.isFinite)||rx<0||ry<0||rw<=0||rh<=0||rx+rw>width||ry+rh>height)throw new Error('局部区域必须位于单个图像面板内。');for(const [i,page] of pages.entries())for(const kind of ['clean','diagnostic'] as const){const im=await loadImage(await readFile(resolveWorkspacePath(page[kind],c)));const columns=im.width/width,local=createCanvas(width*columns,2*(height+40)),ctx=local.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,local.width,local.height);for(let j=0;j<columns;j++)for(let row=0;row<2;row++){ctx.drawImage(im,j*width+rx,row*(height+40)+ry,rw,rh,j*width,row*(height+40),width,height);ctx.drawImage(im,j*width,row*(height+40)+height,width,40,j*width,row*(height+40)+height,width,40);}const p=`${dir}/page-${i+1}-${kind}-local.png`;await writeFile(resolveWorkspacePath(p,c),local.toBuffer('image/png'));page[kind+'Local']=p;evidencePaths.push(p);}}
  const manifest={ok:true,version:1,layout:'reference-above-target',poses:entries.map(e=>({posePath:e.posePath,id:e.pose.id,time:a.targetTimes?.[entries.indexOf(e)]??e.pose.frame.time,stageId:a.stageIds?.[entries.indexOf(e)]??e.pose.id,referenceTime:e.pose.reference?.time??null,fingerprint:poseFingerprint(e.pose)})),pages,bounds,standardHeight,targetScale:sc,reference:reference??null,evidence:await evidenceFiles([...new Set(evidencePaths)],c),legend:'左=绿色，右=橙色，实际关节=圆点，预期目标=紫色方框；图像坐标和骨骼坐标分别转换。',warnings:['遮挡需 Agent 判断，不自动判为失败。']};const manifestPath=`${dir}/pose-comparison.json`;await saveJson(manifestPath,manifest,c);return {...manifest,manifestPath};
}
