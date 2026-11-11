import {withStrict} from './runtimeCache.js';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {preparePoseSource} from './poseWorkflow.js';
import {retargetReferencePoseKernel} from './referenceRetargetKernel.js';
import { type ToolContext } from './spineJson.js';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveWorkspacePath } from './spineJson.js';
import { requireReferencePose, referenceFingerprint } from './referencePose.js';
import { requireVisualRig, readVisualNodes, sampleVisualPoints, visualRigFingerprint, visualSummary } from './visualRig.js';
import { compareGraphs, limbNodes, normalizedGraph, finitePoint, direction, distance, validateCorrespondence, policyFingerprint,torsoAxis,comparisonFingerprint,normalizeImagePoints,angleError } from './poseGraph.js';
import { hashObject, saveJson, rigHash, mappingFingerprint } from './mappingTools.js';
import { readJson, poseFingerprint, solvePoseData, requireReviewedPoseData, solvePose, type PoseDataReader } from './poseWorkflow.js';
import { readActionState } from './actionSemantics.js';
import {poseIssuesFromError} from './poseSequence.js';
import { resolveRetargetMode } from './retargetPolicy.js';
import { analyzeReferenceGif } from './referenceTools.js';
import { encodePngGif } from './previewRenderTools.js';
import { loadAtlasImages, rasterFrame } from './rasterRenderer.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';

async function diagnosticReferenceBinding(a:any, sequence:any, c:ToolContext) {
 if(!a.referenceGifPath)throw new Error('diagnosticPreview 需要 referenceGifPath，才能绑定诊断 GIF 的真实参考来源。');
 const gifPath=resolveWorkspacePath(a.referenceGifPath,c), bytes=await readFile(gifPath), hash=createHash('sha256').update(bytes).digest('hex');
 if(a.referenceGifHash&&a.referenceGifHash!==hash)throw new Error(`REFERENCE_BINDING_MISMATCH: referenceGifHash 不匹配，期望 ${a.referenceGifHash}，实际 ${hash}。`);
 const declared=sequence.referenceGifPath??sequence.sourceGifPath;
 if(declared&&resolveWorkspacePath(declared,c)!==gifPath)throw new Error(`REFERENCE_BINDING_MISMATCH: sequence 声明的参考 GIF 与 referenceGifPath 不一致。`);
 return {gifPath:a.referenceGifPath,gifHash:hash};
}
async function rawFileSha256(filePath:string,c:ToolContext) {
 return createHash('sha256').update(await readFile(resolveWorkspacePath(filePath,c))).digest('hex');
}

function stagePreviewFrames(frames:any[], sequence:any, stageId:string, targetTime:number){
 const stages=(sequence?.stages??[]).map((stage:any)=>({stageId:stage.stageId,time:Number.isFinite(stage.time)?stage.time:(Number.isFinite(stage.targetTime)?stage.targetTime:null)})).filter((stage:any)=>Number.isFinite(stage.time)).sort((a:any,b:any)=>a.time-b.time);
 const current=stages.findIndex((stage:any)=>stage.stageId===stageId);
 const declared=sequence?.stages?.find((stage:any)=>stage.stageId===stageId);
 if(Number.isInteger(declared?.frameStart)||Number.isInteger(declared?.frameEnd)){
  const start=Math.max(0,Number.isInteger(declared?.frameStart)?declared.frameStart:0),end=Math.min(frames.length-1,Number.isInteger(declared?.frameEnd)?declared.frameEnd:start);
  return frames.filter((frame:any)=>frame.index>=start&&frame.index<=end);
 }
 if(Number.isFinite(declared?.startTime)||Number.isFinite(declared?.endTime)){
  const start=Number.isFinite(declared?.startTime)?declared.startTime:0,end=Number.isFinite(declared?.endTime)?declared.endTime:start;
  return frames.filter((frame:any)=>frame.time>=start-1e-6&&frame.time<=end+1e-6);
 }
 const time=Number.isFinite(targetTime)?targetTime:(current>=0?stages[current].time:0);
 const previous=current>0?stages[current-1].time:-Infinity;
 const next=current>=0&&current<stages.length-1?stages[current+1].time:Infinity;
 const lower=Number.isFinite(previous)?(previous+time)/2:-Infinity;
 const upper=Number.isFinite(next)?(time+next)/2:Infinity;
 const selected=frames.filter((frame:any)=>frame.time>=lower-1e-6&&frame.time<=upper+1e-6);
 return selected.length?selected:frames.filter((frame:any)=>Math.abs(frame.time-time)<=Math.abs((frames[0]?.time??0)-time)+1e-6).slice(0,1);
}

async function renderReferenceDiagnosticArtifacts(a:any, generated:any, prepared:any, binding:any, sequence:any, c:ToolContext) {
 const mode=a.retargetMode??'adaptive', tag=binding.gifHash.slice(0,12), dir=a.diagnosticOutputDir??`previews/jobs/body-to-npc1-${tag}-${mode}-diagnostic`;
 await mkdir(resolveWorkspacePath(dir,c),{recursive:true});
 const referenceDiagnosticGifPath=`${dir}/body-to-npc1-${tag}-${mode}-reference-diagnostic.gif`;
 await copyFile(resolveWorkspacePath(binding.gifPath,c),resolveWorkspacePath(referenceDiagnosticGifPath,c));
 const referenceAnalysis=await analyzeReferenceGif({filePath:binding.gifPath,outputDir:`${dir}/reference-analysis`},c);
 const posePath=`${dir}/${a.stageId ?? 'stage'}.diagnostic.pose.json`;
 // kernel 已经求出目标 frame，但诊断姿态尚未经过一次独立的
 // solvePoseData 回读。先用同一份内存姿态重新求解并保存完整 solution，
 // 再进入 renderPoseComparison；否则阶段诊断会被“请先保存最新单姿态
 // 求解结果”错误阻断。
 const diagnosticSolved=await solvePoseData(generated.draft.pose,c);
 generated.draft.pose.frame=diagnosticSolved.frame;
 generated.draft.pose.solution={bones:diagnosticSolved.bones,...diagnosticSolved.report};
 await saveJson(posePath,generated.draft.pose,c);
 const posePreview=await (await import('./poseWorkflow.js')).renderPoseComparison({posePaths:[posePath],targetTimes:[a.targetTime],stageIds:[a.stageId],outputDir:`${dir}/pose-comparison`,width:320,height:320},c);
 const solved=await solvePoseData(generated.draft.pose,c),images=await loadAtlasImages(solved.rt.atlas,solved.mapping.atlasPath!,c);
 const targetCanvas=rasterFrame(solved.skeleton,images,posePreview.bounds,320,320,'#20242b');
 const previewFrames=stagePreviewFrames(referenceAnalysis.frames,sequence,a.stageId,a.targetTime);
 const reviewedFrameIndex=referenceAnalysis.frames.reduce((best:any,frame:any)=>!best||Math.abs(frame.time-a.targetTime)<Math.abs(best.time-a.targetTime)?frame:best,null)?.index;
 const reviewedIndices=(sequence.stages??[]).map((stage:any)=>referenceAnalysis.frames.reduce((best:any,frame:any)=>!best||Math.abs(frame.time-(Number.isFinite(stage.time)?stage.time:stage.targetTime??0))<Math.abs(best.time-(Number.isFinite(stage.time)?stage.time:stage.targetTime??0))?frame:best,null)?.index).filter((index:any)=>Number.isInteger(index));
 const unreviewedFrameIndices=referenceAnalysis.frames.map((frame:any)=>frame.index).filter((index:number)=>!reviewedIndices.includes(index));
 const status=generated.adaptation.status==='unresolved'?'UNRESOLVED':generated.adaptation.status.toUpperCase();
 const reviewedFrameCount=reviewedIndices.length||1,unreviewedCount=unreviewedFrameIndices.length;
 const failureCount=(generated.failureSummary?.semanticFailures?.length??0)+(generated.failureSummary?.reachabilityFailures?.length??0);
 const headerHeight=76,panelWidth=320,panelHeight=320,summary=createCanvas(panelWidth*2,headerHeight+panelHeight),summaryContext=summary.getContext('2d');
 summaryContext.fillStyle='#20242b';summaryContext.fillRect(0,0,summary.width,summary.height);
 summaryContext.fillStyle=generated.adaptation.status==='unresolved'?'#ff4264':'#65dfab';summaryContext.fillRect(0,0,summary.width,headerHeight);
 summaryContext.fillStyle='#11151b';summaryContext.font='bold 18px sans-serif';summaryContext.fillText(`DIAGNOSTIC ONLY · ${status}`,12,25);
 summaryContext.font='13px sans-serif';summaryContext.fillText(`READY ONLY · ${unreviewedCount} UNREVIEWED FRAMES · ${failureCount} HARD FAILURES`,12,48);
 summaryContext.fillText(`retargetMode=${mode} · semanticQuality=${(generated.adaptation.semanticQuality??0).toFixed(2)} · quality=${(generated.adaptation.retargetQuality??0).toFixed(2)}`,12,67);
 const drawContain=async(ctx:any,imagePath:string,x:number,y:number,w:number,h:number)=>{const im=await loadImage(await readFile(resolveWorkspacePath(imagePath,c))),scale=Math.min(w/im.width,h/im.height),dw=im.width*scale,dh=im.height*scale;ctx.drawImage(im,x+(w-dw)/2,y+(h-dh)/2,dw,dh);};
 await drawContain(summaryContext,(previewFrames[0]??referenceAnalysis.frames[0]).filePath,0,headerHeight,panelWidth,panelHeight);summaryContext.fillStyle='#fff';summaryContext.font='bold 15px sans-serif';summaryContext.fillText(`REFERENCE · ${a.stageId} preview`,10,headerHeight+22);
 const targetPng=`${dir}/npc1-ready-diagnostic.png`;const targetWithHeader=createCanvas(panelWidth,headerHeight+panelHeight),targetContext=targetWithHeader.getContext('2d');targetContext.fillStyle='#20242b';targetContext.fillRect(0,0,targetWithHeader.width,targetWithHeader.height);targetContext.fillStyle='#ff4264';targetContext.fillRect(0,0,targetWithHeader.width,headerHeight);targetContext.fillStyle='#11151b';targetContext.font='bold 16px sans-serif';targetContext.fillText(`NPC1 · ${status}`,10,26);targetContext.font='12px sans-serif';targetContext.fillText(`READY ONLY · DIAGNOSTIC ONLY · ${unreviewedCount} UNREVIEWED`,10,49);targetContext.fillText('Failure details are in diagnostic-manifest.json',10,67);targetContext.drawImage(targetCanvas,0,headerHeight,panelWidth,panelHeight);await writeFile(resolveWorkspacePath(targetPng,c),targetWithHeader.toBuffer('image/png'));
 summaryContext.drawImage(targetCanvas,panelWidth,headerHeight,panelWidth,panelHeight);summaryContext.fillStyle='#fff';summaryContext.font='bold 15px sans-serif';summaryContext.fillText(`TARGET NPC1 · ${status}`,panelWidth+10,headerHeight+22);
 const comparisonPng=`${dir}/body-to-npc1-${tag}-${mode}-comparison-diagnostic.png`;await writeFile(resolveWorkspacePath(comparisonPng,c),summary.toBuffer('image/png'));
 const comparisonGif=await encodePngGif({framePaths:[comparisonPng,comparisonPng],outputPath:`${dir}/body-to-npc1-${tag}-${mode}-comparison-diagnostic.gif`,delayMs:700},c);
 const targetGif=await encodePngGif({framePaths:[targetPng,targetPng],outputPath:`${dir}/body-to-npc1-${tag}-${mode}-target-diagnostic.gif`,delayMs:700},c);
 // 动态诊断只播放真实参考 GIF 帧；目标侧重复已审查 ready 姿态，禁止把未标注帧伪造成目标动作。
 // 这样人工可以看到参考动作时序，同时明确观察到目标侧尚未覆盖的阶段。
 const dynamicFramePaths:string[]=[];const dynamicDir=`${dir}/dynamic-comparison-frames`;await mkdir(resolveWorkspacePath(dynamicDir,c),{recursive:true});
 for(const frame of previewFrames){
  const canvas=createCanvas(panelWidth*2,headerHeight+panelHeight),ctx=canvas.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle=generated.adaptation.status==='unresolved'?'#ff4264':'#65dfab';ctx.fillRect(0,0,canvas.width,headerHeight);ctx.fillStyle='#11151b';ctx.font='bold 17px sans-serif';ctx.fillText(`DIAGNOSTIC ONLY · ${status}`,12,24);ctx.font='12px sans-serif';ctx.fillText(`REFERENCE FRAME ${frame.index} · ${(frame.time??0).toFixed(3)}s · TARGET ${a.stageId} HOLD · ${unreviewedCount} UNREVIEWED`,12,46);ctx.fillText('Target is the solved pose for this reviewed stage, held while the unreviewed reference frames play.',12,65);
  await drawContain(ctx,frame.filePath,0,headerHeight,panelWidth,panelHeight);ctx.fillStyle='#fff';ctx.font='bold 14px sans-serif';ctx.fillText(`REFERENCE · frame ${frame.index}`,10,headerHeight+21);ctx.drawImage(targetCanvas,panelWidth,headerHeight,panelWidth,panelHeight);ctx.fillText(`TARGET NPC1 · ${a.stageId} hold`,panelWidth+10,headerHeight+21);
  const p=`${dynamicDir}/frame-${String(frame.index).padStart(4,'0')}.png`;await writeFile(resolveWorkspacePath(p,c),canvas.toBuffer('image/png'));dynamicFramePaths.push(p);
 }
 const dynamicComparisonGif=await encodePngGif({framePaths:dynamicFramePaths,outputPath:`${dir}/body-to-npc1-${tag}-${mode}-dynamic-diagnostic.gif`,delayMs:100},c);
 return {diagnosticOutputDir:dir,referenceDiagnosticGifPath,diagnosticPosePath:posePath,targetDiagnosticGifPath:targetGif.gifPath,comparisonDiagnosticGifPath:comparisonGif.gifPath,dynamicComparisonDiagnosticGifPath:dynamicComparisonGif.gifPath,dynamicComparisonFrameCount:dynamicFramePaths.length,dynamicTargetMode:'stage-hold',targetStageId:a.stageId,diagnosticSummaryPng:comparisonPng,posePreviewManifestPath:posePreview.manifestPath,referenceAnalysisManifestPath:referenceAnalysis.manifestPath,referenceFrameCount:referenceAnalysis.frames.length,previewFrameIndices:previewFrames.map((frame:any)=>frame.index),previewFrameCount:previewFrames.length,coverageStages:[a.stageId],reviewedFrameIndices:reviewedIndices.length?reviewedIndices:[reviewedFrameIndex].filter((index:any)=>Number.isInteger(index)),reviewedFrameCount:reviewedIndices.length||1,unreviewedFrameCount:unreviewedFrameIndices.length,unreviewedFrameIndices,unreviewedStageIds:(sequence.stages??[]).map((s:any)=>s.stageId).filter((id:string)=>id!==a.stageId)};
}

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
 const target=runtimeGraph(skeleton,v.rig,v.mapping,p),comparison=compareGraphs(r.observation,target,p.correspondence,{retargetMode:p.retargetMode??'strict'});
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
 if(a.dryRun!==false)return retargetReferencePoseData(a,c);
 if(!a.sequencePath)return retargetReferencePoseSeed(a,c);
 try{await readFile(resolveWorkspacePath(a.posePath,c));throw new Error('姿态已存在，请使用新修订路径。');}catch(e:any){if(e.code!=='ENOENT')throw e;}
 const seedPath=a.posePath.replace(/\.json$/,'.seed.json'),seed=await retargetReferencePoseSeed({...a,posePath:seedPath},c);
 try{
  const refinement=await (await import('./referencePoseRefinement.js')).refineReferencePose({posePath:seedPath,outputPosePath:a.posePath,dryRun:false},c);
  if(!('frame' in refinement))return {...seed,ok:false,issues:refinement.issues,message:refinement.message};
  return {...refinement,seedPath,seedReportPath:seed.reportPath,seedConflicts:seed.conflicts,pose:{status:refinement.ok?'solved':'failed',frame:refinement.frame}};
 }catch(e){return {...seed,ok:false,requestedPosePath:a.posePath,issues:poseIssuesFromError(e,a.stageId),message:'身份或能力检查阻止联合修正；保留初始诊断候选。'};}
}
/** 明确输入标准姿态的只读计算入口；dryRun:false 也不会保存 seed/pose/report。 */
export async function retargetReferencePoseData(input:any,c:ToolContext={},reader:PoseDataReader=readJson){
 const a={...structuredClone(input),dryRun:true};
 return withStrict(async()=>{
  if(!a.sequencePath)return retargetReferencePoseSeed(a,c,reader);
  const seed=await retargetReferencePoseSeed({...a,detailed:true},c,reader);
  try{
   const sequence=await (await import('./poseSequence.js')).sequenceForPose(seed.pose,c),r=await requireReferencePose(a.referencePosePath,c),v=await requireVisualRig(a.visualRigPath,c),old={...seed.comparison,poseFingerprint:poseFingerprint(seed.pose),referenceFingerprint:referenceFingerprint(r),visualRigFingerprint:visualRigFingerprint(v.rig),sequenceFingerprint:sequence.fingerprint,sampleFingerprint:null,policyFingerprint};
   const mod=await import('./referencePoseRefinement.js'),result=await mod.refinePoseData(seed.pose,old,c);
   return {...mod.refinementSummary(result,a.detailed),dryRun:true,posePath:a.posePath,seedConflicts:seed.conflicts,...'frame' in result?{pose:a.detailed?{...seed.pose,frame:result.frame,solution:result.solution,status:result.ok?'solved':'failed'}:{id:seed.pose.id,status:result.ok?'solved':'failed',frame:result.frame}}:{pose:seed.pose}};
  }catch(e){return {...seed,ok:false,issues:poseIssuesFromError(e,a.stageId)};}
 });
}
export async function prepareReferenceRetargetInputs(a:any,c:ToolContext,reader:PoseDataReader=readJson){
 validateCorrespondence(a.correspondence);
 resolveWorkspacePath(a.standardPosePath,c);
 const reference=await requireReferencePose(a.referencePosePath,c),visual=await requireVisualRig(a.visualRigPath,c),base=await requireReviewedPoseData(await reader(a.standardPosePath,c),c,a.standardPosePath);
 if(base.kind!=='standing')throw new Error('参考适配需已确认标准站姿，不能以动作姿态替代。');
 if(base.sourceFingerprint!==visual.fingerprint)throw new Error('标准站姿与视觉绑定不匹配。');
 const {source}=await preparePoseSource(base,c);return{reference,visual,base,source};
}
async function retargetReferencePoseSeed(a:any,c:ToolContext={},reader:PoseDataReader=readJson){
 a={...a,retargetMode:resolveRetargetMode(a.retargetMode,false)};
 if(a.sequencePath){const sequence=await readJson(a.sequencePath,c);if(a.correspondence&&hashObject(a.correspondence)!==hashObject(sequence.correspondence))throw new Error('调用对应与动作级身份冲突。');a={...a,correspondence:sequence.correspondence};}
 if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.posePath,c));throw new Error('姿态已存在；请使用新修订路径，不覆盖现有审查。');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
 const prepared=await prepareReferenceRetargetInputs(a,c,reader),{draft,solved,actual,comparison,changes,contactResiduals,conflicts,expected}=retargetReferencePoseKernel({...a,id:a.id??randomUUID()},prepared);
 try{await (await import('./poseSequence.js')).sequenceForPose(draft.pose,c);}catch(e){conflicts.push(String(e));}
 const ok=!conflicts.length,reportPath=a.reportPath??a.posePath.replace(/\.json$/,'.adaptation.json');
 if(a.dryRun===false){await saveJson(a.posePath,draft.pose,c);await solvePose({posePath:a.posePath,dryRun:false},c);const cmp=await comparePoseGraphs({posePath:a.posePath,dryRun:false},c);const p=await readJson(a.posePath,c);p.comparisonPath=cmp.reportPath;await saveJson(a.posePath,p,c);await saveJson(reportPath,{ok,conflicts,changes,expected,actual,comparison},c);}
 return {ok,dryRun:a.dryRun??true,posePath:a.posePath,pose:a.detailed?draft.pose:{id:draft.pose.id,status:draft.pose.status,frame:draft.pose.frame},reportPath,conflicts,contactResiduals,changes,expected,actual:a.detailed?actual:visualSummary(actual),comparison,retargetMode:a.retargetMode,workflowProfile:a.workflowProfile??'creative',adaptation:draft.pose.adaptation,message:ok?'仅生成草稿，尚需图像与逐阶段审查。':'冲突停止：仅生成诊断候选，不批准、不写角色。'};
}
export async function compareAnimationKeyPoses(candidatePath:string,animation:string,motion:any,duration:number,c:ToolContext){
 const reports=[];for(const k of motion.poseWorkflow?.keyPoses??[]){const p=await readJson(k.posePath,c);if(p.reference){const report=await comparePoseGraphs({posePath:k.posePath,candidatePath,animation,time:k.time*duration/motion.duration},c);reports.push({stageId:k.stageId,time:k.time,report});}}
 return {ok:reports.every(v=>v.report.ok),reports,fingerprint:hashObject(reports)};
}

/**
 * 为一个已绑定阶段生成 target-side expected target。
 *
 * 这里故意只生成「参考重定向内核的期望目标」，不读取候选动画，也不把
 * 内核回读结果冒充 candidate runtime actual target。后续比较链必须另行
 * 读取候选 preview manifest，生成 actual target 后再合并两者。
 */
export async function generateReferenceRetargetTarget(a:any,c:ToolContext={}):Promise<any>{
 return withStrict(async()=>{
  const retargetMode=resolveRetargetMode(a.retargetMode,false);
  const workflowProfile=['creative','adaptive-preview','production'].includes(a.workflowProfile)?a.workflowProfile:'adaptive-preview';
  const diagnosticPreview=a.diagnosticPreview===true;
  if(diagnosticPreview&&a.dryRun===false)throw new Error('diagnosticPreview 仅支持 dryRun，不能写入 expected target 或角色资产。');
  if(!a?.referencePosePath||!a?.visualRigPath||!a?.standardPosePath||!a?.sequencePath||!a?.stageId)throw new Error('单阶段 retarget generation 需要 referencePosePath、visualRigPath、standardPosePath、sequencePath 和 stageId。');
  if(!Number.isFinite(a.targetTime)||a.targetTime<0)throw new Error('单阶段 retarget generation 需要非负 targetTime。');

  // 先读取原始记录，给 rejected reference 一个稳定且明确的阻断原因；不能
  // 让 v1/字段缺失等次级错误掩盖「参考已被撤回」这一根因。
  const referenceRecord=await readJson(a.referencePosePath,c);
  if(referenceRecord?.status==='rejected'||referenceRecord?.review?.decision==='rejected')throw new Error('参考动作当前为 rejected，禁止生成 expected target；请先创建新修订并完成 approved reference 审查。');

  const sequence=await readJson(a.sequencePath,c),stage=sequence.stages?.find((v:any)=>v.stageId===a.stageId);
  const sequenceHash=hashObject(sequence);
  if(a.sequenceHash&&a.sequenceHash!==sequenceHash)throw new Error(`REFERENCE_BINDING_MISMATCH: sequenceHash 不匹配，期望 ${a.sequenceHash}，实际 ${sequenceHash}。`);
  const referenceBinding=diagnosticPreview?await diagnosticReferenceBinding(a,sequence,c):null;
  if(!stage||stage.referencePosePath!==a.referencePosePath)throw new Error('stageId 与 referencePosePath 未按动作级阶段绑定，不能生成单阶段 expected target。');
  validateCorrespondence(sequence.correspondence);
  if(a.correspondence&&hashObject(a.correspondence)!==hashObject(sequence.correspondence))throw new Error('调用 correspondence 与动作级 correspondence 不一致。');
  const correspondence=sequence.correspondence;
  const sequenceValidation=await (await import('./poseSequence.js')).validatePoseSequenceData(sequence,{sequencePath:a.sequencePath},c);
  // 单阶段 generation 只允许当前 stage 的相关门禁阻断；其他阶段的能力问题
  // 必须保留在整段 validation 中，但不能把一个可验证阶段错误地变成不可生成。
  const relevantSequenceIssues=sequenceValidation.issues.filter((v:any)=>!v.stageId||v.stageId===a.stageId);
  if(relevantSequenceIssues.length)throw new Error(`动作级阶段校验失败：${relevantSequenceIssues.map((v:any)=>v.message).join('；')}`);

  const prepared=await prepareReferenceRetargetInputs({...a,correspondence},c);
  const targetFacing=a.facing??prepared.base.facing;
  if(!['left','right'].includes(targetFacing))throw new Error('单阶段 retarget generation 需要明确目标朝向 facing。');
  // 动作级 weaponHand 与 approved reference 的双握点共同构成“参考握持轴”
  // 的显式绑定。不能让调用方遗漏 weaponFromReference 后，比较器再用一个
  // 未约束的右手/左手组合生成假通过结果；同时保留 kernel 的严格可达性检查。
  const weaponFromReference=(sequence.weaponHand==='left'||sequence.weaponHand==='right')
    && !!prepared.reference.observation.grip?.points?.left
    && !!prepared.reference.observation.grip?.points?.right;
  const generated=retargetReferencePoseKernel({...a,retargetMode,correspondence,facing:targetFacing,time:prepared.reference.observation.time,weaponFromReference,dryRun:true},prepared);
  const unresolved=generated.conflicts.length>0||!generated.solved?.report?.ok||!generated.comparison?.ok;
  if(unresolved&&!diagnosticPreview)throw new Error(`参考重定向内核存在未解决冲突：${generated.conflicts.join('；')||'target-side 视觉关系比较未通过'}。`);

  const sampled=sampleVisualPoints(generated.solved.skeleton,prepared.visual.rig);
  if(!sampled.available)throw new Error(`expected target 缺少完整 visualPoints：${sampled.unavailableReason??'未知原因'}`);
  const scale=prepared.visual.mapping.calibration!.scale,origin=prepared.visual.mapping.calibration!.origin!;
  const normalizedPoints=Object.fromEntries(Object.entries(sampled.points).map(([role,point]:any)=>[role,{...point,x:(point.x-origin[0])/scale,y:(point.y-origin[1])/scale}]));
  const expectedTarget={
   source:'reference-retarget-kernel',
   coordinateSystem:'normalizedSkeleton',
   targetTime:a.targetTime,
   referenceTime:prepared.reference.observation.time,
   frame:structuredClone(generated.solved.frame),
   bones:structuredClone(generated.solved.bones),
   visualPoints:normalizedPoints,
   visualPointsAvailable:true,
   visualPointRoles:Object.keys(normalizedPoints).sort(),
   comparison:structuredClone(generated.comparison),
   retargetMode,
   workflowProfile,
   status:generated.adaptation.status,
   retargetQuality:generated.adaptation.retargetQuality,
   semanticQuality:generated.adaptation.semanticQuality,
   structuralQuality:generated.adaptation.structuralQuality,
   styleQuality:generated.adaptation.styleQuality,
   preservedConstraints:generated.adaptation.preservedConstraints,
   relaxedConstraints:generated.adaptation.relaxedConstraints,
   residuals:generated.adaptation.residuals,
   semanticFailures:generated.failureSummary?.semanticFailures??generated.adaptation.semanticFailures??[],
   semanticFailureDetails:generated.failureSummary?.semanticFailureDetails??[],
   reachabilityFailures:generated.failureSummary?.reachabilityFailures??[],
   structuralResiduals:generated.failureSummary?.structuralResiduals??generated.adaptation.structuralResiduals??{},
   styleResiduals:generated.failureSummary?.styleResiduals??generated.adaptation.styleResiduals??{},
   localProjections:structuredClone(generated.adaptation.localProjections??{}),
  };
  const kernelInternalActualTarget={
   source:'reference-retarget-kernel.runtimeGraph',
   coordinateSystem:'runtimeWorld',
   points:structuredClone(generated.actual.points),
   support:structuredClone(generated.actual.support),
   grip:structuredClone(generated.actual.grip),
   actionState:structuredClone(generated.actual.actionState),
   visualPointsWorld:structuredClone(sampled.points),
  };
  const expectedTargetManifestHash=hashObject(expectedTarget);
  // 采样指纹只描述 expected/actual 必须共同消费的采样时间，不把姿态数值混入；
  // expected 与 actual 的点本来就应当通过比较得出差异，不能因为点值不同而先被错误判为“采样不一致”。
  const expectedSampleFingerprint=hashObject({targetTimes:[a.targetTime]});
  const referenceApprovalFingerprint=referenceFingerprint(prepared.reference);
  const visualRigFingerprintValue=visualRigFingerprint(prepared.visual.rig);
  const targetCharacterFingerprint=rigHash(prepared.source.doc.json);
  const mappingFingerprintValue=mappingFingerprint(prepared.source.mapping);
  const atlasPath=prepared.visual.mapping.atlasPath!;
  const sourceAssetHashes={
   targetCharacter:await rawFileSha256(prepared.base.filePath,c),
   atlas:await rawFileSha256(atlasPath,c),
   atlasPages:Object.fromEntries(await Promise.all((prepared.source.rt.atlas.pages??[]).map(async(page:any)=>[page.name,await rawFileSha256(path.join(path.dirname(atlasPath),page.name),c)]))),
  };
  if(a.referencePoseHash&&a.referencePoseHash!==referenceApprovalFingerprint)throw new Error(`REFERENCE_BINDING_MISMATCH: referencePoseHash 不匹配，期望 ${a.referencePoseHash}，实际 ${referenceApprovalFingerprint}。`);
  if(a.visualRigHash&&a.visualRigHash!==visualRigFingerprintValue)throw new Error(`REFERENCE_BINDING_MISMATCH: visualRigHash 不匹配，期望 ${a.visualRigHash}，实际 ${visualRigFingerprintValue}。`);
  if(a.mappingHash&&a.mappingHash!==mappingFingerprintValue)throw new Error(`REFERENCE_BINDING_MISMATCH: mappingHash 不匹配，期望 ${a.mappingHash}，实际 ${mappingFingerprintValue}。`);
  if(a.targetCharacterHash&&a.targetCharacterHash!==targetCharacterFingerprint)throw new Error(`REFERENCE_BINDING_MISMATCH: targetCharacterHash 不匹配，期望 ${a.targetCharacterHash}，实际 ${targetCharacterFingerprint}。`);
  const actionBindingFingerprint=hashObject({sequencePath:a.sequencePath,sequenceId:sequence.id,stageId:a.stageId,referencePosePath:a.referencePosePath,standardPosePath:a.standardPosePath,correspondence,weaponHand:sequence.weaponHand,targetFacing,visualRigFingerprint:visualRigFingerprintValue});
  const formalCandidate=workflowProfile==='production'&&!diagnosticPreview&&!unresolved;
  const manifest:any={
   version:1,
   kind:'reference-retarget-generation',
   retargetMode,
   workflowProfile,
   status:generated.adaptation.status,
   retargetQuality:generated.adaptation.retargetQuality,
   semanticQuality:generated.adaptation.semanticQuality,
   structuralQuality:generated.adaptation.structuralQuality,
   styleQuality:generated.adaptation.styleQuality,
   preservedConstraints:generated.adaptation.preservedConstraints,
   relaxedConstraints:generated.adaptation.relaxedConstraints,
   residuals:generated.adaptation.residuals,
   semanticFailures:generated.failureSummary?.semanticFailures??generated.adaptation.semanticFailures??[],
   semanticFailureDetails:generated.failureSummary?.semanticFailureDetails??[],
   reachabilityFailures:generated.failureSummary?.reachabilityFailures??[],
   structuralResiduals:generated.failureSummary?.structuralResiduals??generated.adaptation.structuralResiduals??{},
   styleResiduals:generated.failureSummary?.styleResiduals??generated.adaptation.styleResiduals??{},
   localProjections:structuredClone(generated.adaptation.localProjections??{}),
   comparisonMode:'retargeted',
   acceptanceMode:formalCandidate?'formal-candidate':'diagnostic',
   acceptanceEligible:formalCandidate,
   formalEligible:formalCandidate,
   rawDiagnosticOnly:!formalCandidate,
   diagnosticOnly:!formalCandidate,
   readyToCommit:false,
   referencePosePath:a.referencePosePath,
   referenceApprovalDecision:'approved',
   referenceApprovalFingerprint,
   referenceTime:prepared.reference.observation.time,
   targetTime:a.targetTime,
   stageId:a.stageId,
   sequencePath:a.sequencePath,
   sequenceFingerprint:sequenceValidation.fingerprint,
   sequenceHash,
   standardPosePath:a.standardPosePath,
   expectedTargetSource:'reference-retarget-kernel',
   expectedTargetManifestHash,
   expectedSampleFingerprint,
   actualTargetSource:null,
   actualTargetManifestHash:null,
   targetCharacterPath:prepared.base.filePath,
   targetCharacterFingerprint:prepared.source.fingerprint,
   targetCharacterHash:targetCharacterFingerprint,
   mappingPath:prepared.base.mappingPath,
   mappingFingerprint:mappingFingerprintValue,
   sourceAssetHashes,
   visualRigPath:a.visualRigPath,
   visualRigFingerprint:visualRigFingerprintValue,
   actionBindingFingerprint,
   correspondenceFingerprint:hashObject(correspondence),
   correspondence:structuredClone(correspondence),
   targetFacing,
   ...(referenceBinding?{referenceGifPath:referenceBinding.gifPath,referenceGifHash:referenceBinding.gifHash}:{}),
   visualPointsAvailable:true,
   expectedTarget,
   kernelInternalActualTarget,
   retargetManifestFingerprint:hashObject({retargetMode,workflowProfile,status:generated.adaptation.status,retargetQuality:generated.adaptation.retargetQuality,semanticQuality:generated.adaptation.semanticQuality,structuralQuality:generated.adaptation.structuralQuality,styleQuality:generated.adaptation.styleQuality,preservedConstraints:generated.adaptation.preservedConstraints,relaxedConstraints:generated.adaptation.relaxedConstraints,residuals:generated.adaptation.residuals,localProjections:generated.adaptation.localProjections??{},semanticFailures:generated.failureSummary?.semanticFailures??[],semanticFailureDetails:generated.failureSummary?.semanticFailureDetails??[],reachabilityFailures:generated.failureSummary?.reachabilityFailures??[],expectedTargetManifestHash,referenceApprovalFingerprint,targetCharacterFingerprint:prepared.source.fingerprint,visualRigFingerprint:visualRigFingerprintValue,actionBindingFingerprint,expectedSampleFingerprint}),
   createdAt:new Date().toISOString(),
  };
  if(diagnosticPreview){
   const artifacts=await renderReferenceDiagnosticArtifacts(a,generated,prepared,referenceBinding!,sequence,c);
   const diagnosticManifest={...manifest,status:generated.adaptation.status,acceptanceMode:'diagnostic',formalEligible:false,acceptanceEligible:false,diagnosticOnly:true,conflicts:generated.conflicts,previewIssues:generated.solved?.report?.issues??[],semanticFailures:generated.failureSummary?.semanticFailures??[],semanticFailureDetails:generated.failureSummary?.semanticFailureDetails??[],reachabilityFailures:generated.failureSummary?.reachabilityFailures??[],structuralResiduals:generated.failureSummary?.structuralResiduals??{},styleResiduals:generated.failureSummary?.styleResiduals??{},...artifacts};
 const outputPath=a.retargetManifestPath??`${artifacts.diagnosticOutputDir}/${a.stageId ?? 'stage'}.diagnostic-manifest.json`;
   await saveJson(outputPath,diagnosticManifest,c);
   return {...diagnosticManifest,dryRun:true,retargetManifestPath:outputPath,message:'已生成 body.gif→目标角色诊断 GIF；当前仅覆盖已审查阶段，不产生提交令牌。'};
  }
  const outputPath=a.retargetManifestPath??a.outputPath;
  if(a.dryRun===false){
   if(!outputPath)throw new Error('真实写入 expected target manifest 必须提供 retargetManifestPath。');
   try{await readFile(resolveWorkspacePath(outputPath,c));throw new Error('expected target manifest 已存在，请使用新修订路径。');}catch(e:any){if(e.code!=='ENOENT')throw e;}
   await saveJson(outputPath,manifest,c);
  }
  return { ...manifest, ...(a.dryRun===false ? { dryRun:false, retargetManifestPath:outputPath } : { dryRun:a.dryRun??true, retargetManifestPath:outputPath??null }) };
 });
}
