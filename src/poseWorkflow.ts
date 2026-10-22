import {withStrict} from './runtimeCache.js';
import {poseFingerprint} from './domainFingerprints.js';
export {poseFingerprint} from './domainFingerprints.js';
import { checkpoint,taskCheckpoint,reportProgress } from './taskControl.js';
import { validatePoseInput } from './poseSchemas.js';
import { solvePoseKernel, poseInputHash } from './animationKernel.js';
import { poseDependencies } from './poseDigest.js';
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
import { comparisonFingerprint } from './poseGraph.js';

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
function validateReference(r:any) {
  if(!r)return;
  if(!r.imagePath||!r.facing||!r.basis||!Number.isFinite(r.time)||r.time<0||!Number.isFinite(r.height)||r.height<=0||!Number.isFinite(r.groundY)||!Array.isArray(r.crop)||r.crop.length!==4||!r.crop.every(Number.isFinite)||r.crop[2]<=0||r.crop[3]<=0)throw new Error('参考记录需 imagePath/time/facing/crop/height/groundY/basis；图像坐标仅用于观察。');
  for(const v of Object.values(r.points??{}) as any[])if(!['visible','occluded','unknown'].includes(v.visibility)||v.visibility==='visible'&&(!Number.isFinite(v.x)||!Number.isFinite(v.y)))throw new Error('参考关键点必须声明可见性，可见点需有限图像坐标。');
}
export async function createPoseDraft(a:any,c:ToolContext={}) {
  if(a.frame!==undefined)validatePoseInput('frame',a.frame);
  if(a.weapon!==undefined)validatePoseInput('weapon',a.weapon);
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
  validatePoseInput('patch',patch);
  for(const k of Object.keys(patch))if(!['frame','weapon','reference','referencePosePath','groundY','policy','visualRigPath','correspondence','sequencePath','stageId'].includes(k))throw new Error('只允许修改姿态参数。');
  const q=mergePose(p,patch);if(patch.referencePosePath){const record=await requireReferencePose(patch.referencePosePath,c);q.reference=record.observation;}q.id=randomUUID();q.status='draft';delete q.solution;delete q.review;delete q.comparisonPath;validateReference(q.reference);
  if(q.policy.kneeFlexionMax!==30&&!q.policy.reason?.trim())throw new Error('自定义膝部阈值需理由。');
  if(a.dryRun===false)await saveJson(a.outputPosePath,q,c);return {ok:true,dryRun:a.dryRun??true,pose:q,posePath:a.outputPosePath};
}
export async function preparePoseSource(p:any,c:ToolContext) {
  const source=await characterFingerprint(p.filePath,p.mappingPath,c);
  let visualReader:((skeleton:any)=>any)|undefined;
  if(p.visualRigPath){const mod=await import('./visualRig.js'),v=await mod.requireVisualRig(p.visualRigPath,c);if(v.fingerprint!==source.fingerprint)throw new Error('visualRig 与姿态角色不匹配。');visualReader=skeleton=>mod.readVisualNodes(skeleton,v.rig);}
  return {source,visualReader};
}
export async function solvePoseData(p:any,c:ToolContext) {
  checkpoint('单姿态求解');
  const {source,visualReader}=await preparePoseSource(p,c);
  const result=solvePoseKernel(p,source,visualReader);checkpoint('单姿态求解');return result;
}
export async function solvePose(a:any,c:ToolContext={}) {const p=await readJson(a.posePath,c),s=await solvePoseData(p,c);p.frame=s.frame;p.solution={bones:s.bones,...s.report,inputFingerprint:poseInputHash(p),dependencyFingerprint:(await poseDependencies(p,c)).dependencyFingerprint};p.status=s.report.ok?'solved':'failed';delete p.review;if(a.dryRun===false)await saveJson(a.posePath,p,c);return {ok:s.report.ok,dryRun:a.dryRun??true,pose:p,report:s.report};}
async function requirePoseReference(p:any,c:ToolContext){if(!p.reference&&!p.referencePosePath)return;if(!p.referencePosePath)throw new Error('参考姿态需先独立标注和审查。');if(!p.reference)throw new Error('目标姿态缺少已审查参考标注副本。');const r=await requireReferencePose(p.referencePosePath,c);if(hashObject(r.observation)!==hashObject(p.reference))throw new Error('参考标注与目标姿态不一致。');}
export async function requireReviewedPose(pth:string,c:ToolContext) {
 return withStrict(async()=>{
const p=await readJson(pth,c);const s=await solvePoseData(p,c);if(!s.report.ok)throw new Error('姿态当前数值校验失败。');await requirePoseReference(p,c);const comparison=await (await import('./referenceRetarget.js')).requirePoseComparison(p,c);if(p.status!=='confirmed'||p.review?.decision!=='approved'||p.review.poseFingerprint!==poseFingerprint(p)||comparison&&p.review.comparisonFingerprint!==comparisonFingerprint(comparison))throw new Error(`姿态未确认或已过期：${pth}`);await verifyEvidence(p.review.evidence,c);return p;
 });
}
export async function evidenceFiles(files:string[],c:ToolContext){return Promise.all(files.map(async filePath=>({filePath,hash:await fileHash(filePath,c)})));}
export async function verifyEvidence(e:any[],c:ToolContext){if(!e?.length)throw new Error('缺少视觉证据。');for(const v of e)if(await fileHash(v.filePath,c)!==v.hash)throw new Error('视觉证据已改变。');}
export function validatePoseReviewInput(a:any,referenceStage?:string,strictChecks=false) {
  if(typeof a.reviewedBy!=='string'||!a.reviewedBy.trim()||typeof a.reason!=='string'||!a.reason.trim()||!['approved','rejected'].includes(a.decision)||!Array.isArray(a.checks)||a.checks.length!==poseChecks.length||poseChecks.some(k=>!a.checks.includes(k)))throw new Error('需确认者、理由、decision 和全部姿态检查项。');
  if(a.issues!==undefined&&(!Array.isArray(a.issues)||a.issues.some((v:any)=>typeof v!=='string')))throw new Error('issues 必须为字符串数组。');
  if(a.decision==='approved'&&a.issues?.length)throw new Error('存在未解决问题不能批准。');
  if(a.checkResults!==undefined){
    if(!a.checkResults||typeof a.checkResults!=='object'||Array.isArray(a.checkResults)||Object.keys(a.checkResults).some(k=>!poseChecks.includes(k)))throw new Error('checkResults 只能包含声明的姿态检查项。');
    for(const item of Object.values(a.checkResults) as any[])if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['status','reason'].includes(k))||!['pass','fail','unverifiable'].includes(item.status)||typeof item.reason!=='string'||!item.reason.trim())throw new Error('每项 checkResults 需明确 status 与非空 reason。');
  }
  if(a.decision==='approved'&&(strictChecks||referenceStage!==undefined)){
    if(poseChecks.some(k=>typeof a.checkResults?.[k]?.reason!=='string'||!a.checkResults[k].reason.trim()||a.checkResults[k].status!=='pass')||new Set(poseChecks.map(k=>a.checkResults[k].reason.trim())).size!==poseChecks.length)throw new Error('批准需逐项 checkResults.status:pass 与具体理由；参考姿态还需逐阶段 stageId，统一文本不能代替。');
    if(referenceStage!==undefined&&(!referenceStage||a.stageId!==referenceStage))throw new Error('审查 stageId 必须与当前参考姿态阶段一致。');
  }
}
/** 两种 IO 适配共用内容门禁；不保存姿态或修改 Host。 */
export async function preparePoseReview(p:any,a:any,evidence:any[],c:ToolContext={},strictChecks=false) {
  validatePoseReviewInput(a);
  const solved=await solvePoseData(p,c);
  if(a.decision==='approved'){
    await requirePoseReference(p,c);
    if(!solved.report.ok)throw new Error('姿态当前数值校验失败。');
    if(!p.solution?.ok||a.issues?.length||hashObject(p.solution.bones)!==hashObject(solved.bones))throw new Error('数值失败、求解已过期或仍有问题不能确认。');
  }
  let comparison:any=null;
  if(a.decision==='approved'&&(p.reference||p.referencePosePath)){
    p.comparisonPath=a.comparisonPath??p.comparisonPath;
    comparison=await (await import('./referenceRetarget.js')).requirePoseComparison(p,c);
  }
  validatePoseReviewInput(a,p.reference||p.referencePosePath?p.stageId??'':undefined,strictChecks);
  await verifyEvidence(evidence,c);
  return {decision:a.decision,reviewedBy:a.reviewedBy,reason:a.reason,checks:a.checks,stageId:a.stageId,checkResults:a.checkResults,comparisonFingerprint:comparison?comparisonFingerprint(comparison):null,comparisonPath:p.comparisonPath??null,issues:a.issues??[],poseFingerprint:poseFingerprint(p),evidence,at:new Date().toISOString()};
}
export async function reviewPose(a:any,c:ToolContext={}) {
 return withStrict(async()=>{

  const p=await readJson(a.posePath,c),manifest=await readJson(a.manifestPath,c);
  if(!manifest.poses?.some((v:any)=>v.posePath===a.posePath&&v.fingerprint===poseFingerprint(p)))throw new Error('对比图不包含当前姿态修订。');
  const evidence=[...manifest.evidence,...await evidenceFiles([a.manifestPath],c)];
  p.review=await preparePoseReview(p,a,evidence,c);p.status=a.decision==='approved'?'confirmed':'rejected';if(a.dryRun===false)await saveJson(a.posePath,p,c);return {ok:true,dryRun:a.dryRun??true,review:p.review};

 });
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
  const entries:any[]=[];for(const posePath of a.posePaths){await taskCheckpoint('姿态对比');reportProgress(entries.length,a.posePaths.length,'准备姿态对比');const pose=await readJson(posePath,c),s=await solvePoseData(pose,c);if(!pose.solution||hashObject(pose.solution.bones)!==hashObject(s.bones))throw new Error('请先保存最新单姿态求解结果。');let comparison:any=null;if(pose.referencePosePath&&pose.visualRigPath)try{comparison=await (await import('./referenceRetarget.js')).comparePoseGraphs({posePath},c);}catch(e){comparison={ok:false,message:String(e),metrics:[]};}entries.push({posePath,pose,s,comparison});}
  if(a.targetTimes&&(a.targetTimes.length!==entries.length||a.targetTimes.some((v:any)=>!Number.isFinite(v)||v<0))||a.stageIds&&a.stageIds.length!==entries.length)throw new Error('阶段 ID 和时间必须与姿态数量一致。');
  const height=a.height??320,width=a.width??320;if(!Number.isInteger(width)||!Number.isInteger(height)||width<128||height<128||width>1024||height>1024)throw new Error('面板宽高需为128–1024。');
  const standard=entries[0].pose.kind==='standing'?entries[0].pose:await requireReviewedPose(entries[0].pose.standardPosePath,c);const standardHeight=standard.solution.height;
  if(entries.some(e=>e.pose.sourceFingerprint!==standard.sourceFingerprint))throw new Error('一个对比任务只能绑定一个目标角色。');
  const sc=height*.7/standardHeight,all=entries.map(e=>e.s.report.bounds),cx=(Math.min(...all.map(v=>v.minX))+Math.max(...all.map(v=>v.maxX)))/2,ground=standard.groundY*entries[0].s.mapping.calibration!.scale+entries[0].s.mapping.calibration!.origin![1];
  const bounds={minX:cx-width/(2*sc),maxX:cx+width/(2*sc),minY:ground-height*.1/sc,maxY:ground+height*.9/sc};
  const dir=a.outputDir??`previews/jobs/poses-${randomUUID()}`;await mkdir(resolveWorkspacePath(dir,c),{recursive:true});const images=await loadAtlasImages(entries[0].s.rt.atlas,entries[0].s.mapping.atlasPath!,c);
  const evidencePaths:string[]=[],pages:any[]=[];const project=(x:number,y:number)=>[(x-bounds.minX)*sc,(bounds.maxY-y)*sc];
  const reference=entries.find(e=>e.pose.reference)?.pose.reference;for(const e of entries)if(e.pose.reference&&hashObject({crop:e.pose.reference.crop,height:e.pose.reference.height,groundY:e.pose.reference.groundY})!==hashObject({crop:reference.crop,height:reference.height,groundY:reference.groundY}))throw new Error('参考序列必须使用固定裁剪、角色高度和地面线。');
  for(let start=0;start<entries.length;start+=6){await taskCheckpoint('姿态对比出图');reportProgress(start,entries.length,'逐页绘制姿态对比');const n=Math.min(6,entries.length-start),clean=createCanvas(width*n,(height+40)*2),diagnostic=createCanvas(width*n,(height+40)*2);for(const canvas of [clean,diagnostic]){const ctx=canvas.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,canvas.width,canvas.height);}
    for(let i=0;i<n;i++){const e=entries[start+i],r=e.pose.reference,x=i*width,y=height+40;const target=rasterFrame(e.s.skeleton,images,bounds,width,height,'#20242b');for(const canvas of [clean,diagnostic]){const ctx=canvas.getContext('2d');ctx.drawImage(target,x,y);ctx.fillStyle='white';ctx.font='14px sans-serif';ctx.fillText(`${start+i+1} ${a.stageIds?.[start+i]??e.pose.id} / target ${(a.targetTimes?.[start+i]??e.pose.frame.time).toFixed(3)}s ${e.pose.facing}`,x+5,y+height+22);
      if(r){const im=await loadImage(await readFile(resolveWorkspacePath(r.imagePath,c))),rs=height*.7/r.height;const [rx,ry,rw,rh]=r.crop;const dx=width/2-rw*rs/2,dy=height*.9-(r.groundY-ry)*rs;ctx.save();ctx.beginPath();ctx.rect(x,0,width,height);ctx.clip();ctx.drawImage(im,rx,ry,rw,rh,x+dx,dy,rw*rs,rh*rs);ctx.restore();ctx.fillText(`${a.stageIds?.[start+i]??e.pose.id} / reference ${r.time.toFixed(3)}s ${r.facing}`,x+5,height+22);
        if(canvas===diagnostic){ctx.strokeStyle='#78d4ff';ctx.beginPath();ctx.moveTo(x,height*.9);ctx.lineTo(x+width,height*.9);ctx.stroke();drawReferenceSkeleton(ctx,r,(px,py)=>[x+dx+(px-rx)*rs,dy+(py-ry)*rs]);}}
      else ctx.fillText('No reference: target standing calibration',x+5,height+22);
    }
    const ctx=diagnostic.getContext('2d');ctx.font='11px sans-serif';ctx.strokeStyle='#78d4ff';ctx.beginPath();ctx.moveTo(x,y+height*.9);ctx.lineTo(x+width,y+height*.9);ctx.stroke();
    if(e.s.report.visual){(await import('./visualRig.js')).drawVisualGraph(ctx,e.s.report.visual,(px,py)=>{const q=project(px,py);return [x+q[0],y+q[1]];},e.comparison);ctx.fillStyle=e.comparison?.ok?'#65dfab':'#ff4264';ctx.fillText(e.comparison?`Graph: ${e.comparison.ok?'PASS':'FAIL / UNVERIFIABLE'}`:'Visual calibration',x+5,y+16);if(e.pose.correspondence)ctx.fillText(`target L <- ref ${e.pose.correspondence.left}; R <- ref ${e.pose.correspondence.right}`,x+5,y+29);
      // 只诊断图列出未通过指标，干净图保持无文字干扰。
      const failedIds=(e.comparison?.metrics??[]).filter((m:any)=>m.required&&m.status!=='pass').map((m:any)=>`${m.id}:${m.status}`);if(failedIds.length){ctx.fillStyle='#ff4264';for(let i=0;i<Math.min(8,failedIds.length);i+=4)ctx.fillText(failedIds.slice(i,i+4).join('  '),x+5,y+56+Math.floor(i/4)*13);}}
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
  const manifest={ok:true,version:1,layout:'reference-above-target',poses:entries.map(e=>({posePath:e.posePath,id:e.pose.id,time:a.targetTimes?.[entries.indexOf(e)]??e.pose.frame.time,stageId:a.stageIds?.[entries.indexOf(e)]??e.pose.id,referenceTime:e.pose.reference?.time??null,fingerprint:poseFingerprint(e.pose)})),pages,bounds,standardHeight,targetScale:sc,reference:reference??null,evidence:await evidenceFiles([...new Set(evidencePaths)],c),legend:'左=绿色，右=橙色，肩线/髋线=灰虚线，面部朝向=黄虚线，实际关节=圆点，预期目标=紫色方框，握轴/假想杆=黄色；诊断图另列未通过指标。',warnings:['遮挡需 Agent 判断，不自动判为失败。']};reportProgress(entries.length,entries.length,'姿态对比已生成');const manifestPath=`${dir}/pose-comparison.json`;await saveJson(manifestPath,manifest,c);return {...manifest,manifestPath};
}
