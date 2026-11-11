import {withStrict} from './runtimeCache.js';
import {taskCheckpoint,reportProgress} from './taskControl.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as gifencModule from 'gifenc';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { saveJson, hashObject } from './mappingTools.js';
import { readJson, evidenceFiles, verifyEvidence, animationChecks, poseGate } from './poseWorkflow.js';
import { drawReferenceSkeleton, referenceRoles } from './referencePose.js';
import { drawVisualGraph, requireVisualRig } from './visualRig.js';
import { compareGraphs } from './poseGraph.js';
import { animationComparisonLayouts, assertAnimationComparisonLayout, comparisonManifestFingerprint, comparisonManifestProblem, expectedRetargetManifestProblem } from './animationAcceptancePolicy.js';

const gifenc: any = (gifencModule as any).GIFEncoder ? gifencModule : (gifencModule as any).default;
const {GIFEncoder,quantize,applyPalette}=gifenc;
// Spine runtime 用 float32 保存时长；边界容差防止 0.9s 错取上一帧。
export const referenceFrameAt=(frames:any[],time:number)=>frames.filter(v=>v.time<=time+1e-6).at(-1)??frames[0];

/**
 * 骨架叠加用的两套投影，纯函数便于数值断言。
 * - projectRef：参考「图像像素坐标」→ 画布，复用既有叠加 drawImage 的 rs/refX/refY。
 *   rs = targetScale*standardHeight/view.height，展开即 poseWorkflow 的 height*.7/r.height，两套口径一致。
 * - projectTarget：目标「骨骼世界坐标」→ 画布，**必须复用 rasterFrame 的 min(w/Δx,h/Δy) + 居中**，
 *   否则骨架会与已渲染的目标 PNG 错位（不能用 poseWorkflow 的 (x-minX)*sc，那是姿态级 bounds 口径）。
 */
export function skeletonProjections(target:any,poses:any){
 const view=poses.reference,w=target.canvas.width,h=target.canvas.height;
 const rs=poses.targetScale*poses.standardHeight/view.height;
 const refY=h*.9-(view.groundY-view.crop[1])*rs,refX=w/2-view.crop[2]*rs/2;
 const projectRef=(px:number,py:number)=>[refX+(px-view.crop[0])*rs,refY+(py-view.crop[1])*rs];
 const b=target.bounds,sc=Math.min(w/(b.maxX-b.minX),h/(b.maxY-b.minY)),cx=(b.minX+b.maxX)/2,cy=(b.minY+b.maxY)/2;
 const projectTarget=(x:number,y:number)=>[w/2+(x-cx)*sc,h/2-(y-cy)*sc];
 return {rs,refX,refY,sc,projectRef,projectTarget};
}

/**
 * 语义映射核对（纯函数）：不重跑 runtime、不加载 skeleton。
 * 逐帧轨迹只有 worldX/worldY，没有骨骼 a/b/c/d 矩阵：
 * - node.point 非原点 → 该 role 无法精确还原，跳过并在 unmappedRoles 显式列出，不静默按原点处理；
 * - 骨骼名未命中 → 同样跳过；
 * - 版本非 v2 / 角色路径不一致 / 无任何精确节点 → 整份 rig 不可信，硬拒绝并降级为灰点。
 * 因此支持「部分映射」：能精确还原的四肢节点仍画语义骨架，不因个别偏移节点全盘放弃。
 */
export function resolveSkeletonMapping(rig:any,target:any){
 const hard:string[]=[],skipped:string[]=[],unmappedRoles:string[]=[];
 if(rig?.version!==2)hard.push(`visualRig 版本 v${rig?.version??'?'},需 v2`);
 const rigPath=rig?.filePath,targetPath=target?.filePath;
 if(rigPath&&targetPath&&rigPath!==targetPath)hard.push(`角色路径不一致:rig=${rigPath} target=${targetPath}`);
 const boneNames=new Set(Object.keys(target?.trajectories?.[0]?.bones??{}));
 const entries=Object.entries(rig?.nodes??{}) as any[];
 if(!entries.length)hard.push('visualRig 无 nodes');
 const nodes:any={};
 for(const [role,n]of entries){
  const validBoneLocal=n?.type==='boneLocal'&&Array.isArray(n.point)&&n.point.length===2&&n.point.every((v:number)=>Number.isFinite(v));
  const off=validBoneLocal&&n.point.some((v:number)=>v!==0);
  if(!validBoneLocal){unmappedRoles.push(role);skipped.push(`${role}:节点不是可由骨骼原点还原的 boneLocal`);}
  else if(!boneNames.has(n.bone)){unmappedRoles.push(role);skipped.push(`${role}:骨骼名未命中逐帧轨迹`);}
  else if(off){unmappedRoles.push(role);skipped.push(`${role}:node.point 非原点,逐帧轨迹缺骨骼矩阵无法还原`);}
  else nodes[role]=n;
 }
 for(const role of referenceRoles)if(!nodes[role]&&!unmappedRoles.includes(role)){unmappedRoles.push(role);skipped.push(`${role}:visualRig 未提供必需语义节点`);}
 if(!Object.keys(nodes).length)hard.push('无任何可精确还原的语义节点');
 const ok=hard.length===0,complete=ok&&referenceRoles.every(role=>!!nodes[role])&&unmappedRoles.length===0;
 return {ok,complete,nodes,unmappedRoles,reasons:ok?skipped:hard.concat(skipped).slice(0,6)};
}

/** 从逐帧轨迹按语义映射取出目标侧关节点；缺骨骼直接跳过，不编造。 */
export function targetSkeletonPoints(frame:any,nodes:any){
 const out:Record<string,{x:number;y:number}>={};
 for(const [role,n] of Object.entries(nodes) as any){
  const b=frame?.bones?.[n.bone];
  if(b&&Number.isFinite(b.x)&&Number.isFinite(b.y))out[role]={x:b.x,y:b.y};
 }
 return out;
}

function finiteVisualPoint(point:any): point is {x:number;y:number} {
 return !!point&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&point.source!=='unavailable';
}

function retargetExpectedTargets(manifest:any):any[] {
 const values=Array.isArray(manifest?.expectedTargets)?manifest.expectedTargets:[manifest?.expectedTarget];
 return values.filter(Boolean).sort((a:any,b:any)=>a.targetTime-b.targetTime);
}

function retargetExpectedForTime(targets:any[],time:number):any|null {
 const exact=targets.find(target=>Number.isFinite(target.targetTime)&&Math.abs(target.targetTime-time)<=1e-6);
 if(exact)return exact;
 if(!targets.length||!Number.isFinite(time))return null;
 let best=targets[0],distance=Math.abs(best.targetTime-time);
 for(const target of targets.slice(1)){const next=Math.abs(target.targetTime-time);if(next<distance){best=target;distance=next;}}
 return distance<=1e-5?best:null;
}

function compareExpectedActualVisualPoints(expected:any,actual:any):any {
 const expectedPoints=expected?.visualPoints??{},actualPoints=actual?.visualPoints??{},roles=[...new Set([...Object.keys(expectedPoints),...Object.keys(actualPoints)])].sort();
 const tolerance=.15,metrics=roles.map(role=>{
  const e=expectedPoints[role],a=actualPoints[role],known=finiteVisualPoint(e)&&finiteVisualPoint(a);
  const error=known?Math.hypot(e.x-a.x,e.y-a.y):null;
  return {id:`visualPoint.${role}`,nodes:[role],reference:e??null,target:a??null,error,tolerance,required:true,status:known?(error!<=tolerance+1e-8?'pass':'fail'):'unverifiable'};
 });
 return {version:1,tolerance,ok:metrics.length>0&&metrics.every(metric=>metric.status==='pass'),metrics,expectedRoles:Object.keys(expectedPoints).sort(),actualRoles:Object.keys(actualPoints).sort(),message:'expected target 与 candidate runtime actual target 按共同 visualPoints 逐点比较；缺失点不可正式验收。'};
}

export async function renderAnimationComparison(a:any,c:ToolContext={}) {
 const target=await readJson(a.targetManifestPath,c),reference=await readJson(a.referenceManifestPath,c),poses=await readJson(a.poseManifestPath,c),map=a.phaseMap;
 const retargetManifest=a.retargetManifestPath?await readJson(a.retargetManifestPath,c):null;
 if(a.retargetManifestPath){
  const problem=expectedRetargetManifestProblem(retargetManifest);
  if(problem)throw new Error(problem);
  if(retargetManifest.referencePosePath&&a.referencePosePath&&a.referencePosePath!==retargetManifest.referencePosePath)throw new Error('retarget manifest 与 referenceManifestPath 不是同一已批准参考。');
  if(retargetManifest.visualRigPath&&a.visualRigPath&&retargetManifest.visualRigPath!==a.visualRigPath)throw new Error('retarget manifest 与 visualRigPath 不一致。');
 }
 if(a.acceptanceMode==='formal'&&!a.retargetManifestPath)throw new Error("formal 骨架验收前置条件不满足：当前证据是 legacy-raw-diagnostic，必须先生成 comparisonMode:'retargeted' 的 expected/actual 证据。");
 if(!Array.isArray(map)||map.length<2||map[0].targetTime!==0||Math.abs(map.at(-1).targetTime-target.duration)>1e-5||map.some((v:any,i:number)=>![v.targetTime,v.referenceTime].every(Number.isFinite)||v.referenceTime<0||v.referenceTime>reference.duration+1e-6||i>0&&(v.targetTime<=map[i-1].targetTime||v.referenceTime<=map[i-1].referenceTime)))throw new Error('阶段时间映射必须严格递增且覆盖完整目标动画。');
 if(!poses.reference||!target.gifPath||!target.frames?.length||hashObject(poses.bounds)!==hashObject(target.bounds))throw new Error('需参考观察参数、目标原速 GIF，且沿用姿态对比的固定相机。');
 const layout=a.layout??'reference-above-target';
 assertAnimationComparisonLayout(layout);
 if(retargetManifest&&layout!=='skeleton')throw new Error("显式 retargetManifestPath 只能用于 skeleton 比较；overlay/reference-above-target 仍是外观诊断，不得冒充 expected-vs-actual 验收。");
 const opacity=a.opacity??0.6;
 if(!Number.isFinite(opacity)||opacity<0.1||opacity>1)throw new Error('叠加不透明度 opacity 必须为0.1–1。');
 const overlay=layout==='overlay',skeleton=layout==='skeleton';
 const view=poses.reference,w=target.canvas.width,h=target.canvas.height;
 const {rs,refX,refY,projectRef,projectTarget}=skeletonProjections(target,poses);
 // times 可选：只输出指定时间点，避免必须整段渲染。目标帧是既已渲染的 PNG，故按最接近的采样时间取帧。
 const frameTimes:number[]=Array.isArray(target.sampleTimes)&&target.sampleTimes.length===target.frames.length?target.sampleTimes:Array.from({length:target.frames.length},(_,k)=>target.duration*k/target.frames.length);
 const retargetTargets=retargetManifest?retargetExpectedTargets(retargetManifest):[];
 let selected:number[];
 if(a.times===undefined||a.times===null)selected=frameTimes.map((_,k)=>k);
 else{
  if(!Array.isArray(a.times)||!a.times.length||!a.times.every((v:any)=>Number.isFinite(v)&&v>=0&&v<=target.duration+1e-6))throw new Error('times 必须为非空数组，且每个值在0到目标时长之间。');
  selected=a.times.map((v:number)=>{let best=0,bd=Infinity;for(let k=0;k<frameTimes.length;k++){const d=Math.abs(frameTimes[k]-v);if(d<bd){bd=d;best=k;}}return best;});
 }
 // skeleton 布局：准备语义映射与（可选）compareGraphs 结构指标。全部只读；formal 模式额外复用完整 visualRig 门禁。
 let skel:any=null;
 if(skeleton){
  const acceptanceMode=a.acceptanceMode??'diagnostic';
  if(!['diagnostic','formal'].includes(acceptanceMode))throw new Error("acceptanceMode 必须为 'diagnostic' 或 'formal'。");
  let rig:any=null,verifiedRig=false,mappingReason:string|null=null,mappingOk=false,mappingComplete=false,nodes:any={},unmappedRoles:string[]=[],correspondenceSource:'explicit'|null=null;
  if(!a.visualRigPath)mappingReason='未提供 visualRigPath';
  else if(acceptanceMode==='formal'){
   try{
    const verified=await requireVisualRig(a.visualRigPath,c,true);
    rig=verified.rig;verifiedRig=true;
    if(resolveWorkspacePath(rig.filePath,c)!==resolveWorkspacePath(target.filePath,c))mappingReason=`角色路径不一致:rig=${rig.filePath} target=${target.filePath}`;
   }catch(e:any){mappingReason=`visualRig 正式校验失败:${e.message}`;}
  }else{
   try{rig=await readJson(a.visualRigPath,c);}catch(e:any){mappingReason=`visualRig 读取失败:${e.message}`;}
  }
  if(rig&&!mappingReason){const m=resolveSkeletonMapping(rig,target);mappingOk=m.ok;mappingComplete=m.complete;nodes=m.nodes;unmappedRoles=m.unmappedRoles;if(m.reasons.length)mappingReason=m.reasons.join('；');}
  const correspondence=a.correspondence??null;
  if(correspondence)correspondenceSource='explicit';
  const targetFacing=a.targetFacing??null;
  skel={acceptanceMode,verifiedRig,mappingOk,mappingComplete,unmappedRoles,nodes,mappingReason,correspondence,correspondenceSource,targetFacing,metrics:null,metricsAvailable:false,metricsAcceptanceReady:false,metricsUnavailableReason:null,metricsAcceptanceReason:null,acceptanceEligible:false};
  if(a.metrics!==false){
   if(!mappingOk)skel.metricsUnavailableReason=`缺少有效语义映射:${mappingReason??'未知原因'}`;
   else if(!correspondence)skel.metricsUnavailableReason='缺少显式 correspondence（左右对应/解剖身份/前后关系及依据），不自动推断';
   else if(!['left','right'].includes(targetFacing))skel.metricsUnavailableReason='目标朝向 targetFacing 未明确，不能把参考朝向当作目标朝向';
   else{
    try{
     skel.metrics=selected.map(k=>{
      const pts=targetSkeletonPoints(target.trajectories[k],nodes);
      const g=compareGraphs({points:view.points,facing:view.facing,actionSemantics:view.actionSemantics},{points:pts,facing:targetFacing,actionState:null},correspondence,{retargetMode:a.retargetMode});
      return {targetTime:frameTimes[k],retargetMode:g.retargetMode,metrics:g.metrics.map((m:any)=>({id:m.id,status:m.status,error:m.error,tolerance:m.tolerance,nodes:m.nodes,required:m.required,constraintTier:m.constraintTier,blocking:m.blocking,referenceValue:m.referenceValue,targetValue:m.targetValue,residual:m.residual,relaxed:m.relaxed,preserved:m.preserved}))};
     });
     skel.metricsAvailable=skel.metrics.length>0;
     skel.metricsAcceptanceReady=skel.metricsAvailable&&skel.metrics.every((entry:any)=>entry.metrics.every((m:any)=>m.required!==true||m.status!=='unverifiable'));
     if(!skel.metricsAcceptanceReady)skel.metricsAcceptanceReason='存在必需结构指标不可验证，指标可供诊断但不能作为正式验收依据';
    }catch(e:any){skel.metricsUnavailableReason=`compareGraphs 失败:${e.message}`;}
   }
  }else skel.metricsUnavailableReason='调用方关闭了 metrics，不能进入正式验收';
  skel.acceptanceEligible=acceptanceMode==='formal'&&verifiedRig&&mappingComplete&&!!correspondence&&skel.metricsAcceptanceReady;
  if(acceptanceMode==='formal')throw new Error("当前 skeleton renderer 只生成 legacy-raw-diagnostic；formal 必须先生成 comparisonMode:'retargeted' 的 expected/actual 证据。");
 }

 const out=a.outputDir??target.outputDir;await mkdir(resolveWorkspacePath(out,c),{recursive:true});const gif=GIFEncoder();
 for(let n=0;n<selected.length;n++){const i=selected[n];await taskCheckpoint('动画对比');reportProgress(n,selected.length,'逐帧生成参考对比');const t=frameTimes[i];let k=map.findIndex((v:any)=>v.targetTime>t);if(k<0)k=map.length-1;k=Math.max(1,k);const l=map[k-1],r=map[k],rt=l.referenceTime+(r.referenceTime-l.referenceTime)*(t-l.targetTime)/(r.targetTime-l.targetTime);const f=referenceFrameAt(reference.frames,rt);
  // 叠加/骨架布局标签区为两行（h+44）：单行放不下"参考/目标时间 + 附加信息"，窄画布会裁切。
  const canvas=createCanvas(w,skeleton||overlay?h+44:(h+28)*2),ctx=canvas.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,canvas.width,canvas.height);
  if(skeleton){
   // 骨架叠加只看「线条与关节点是否重合」，文字标签全是干扰：
   // 两套骨架共用同一套 graphEdges，E 编号完全重复；drawVisualGraph 还画完整 role 名。
   // 320 画布上这些标签必然堆叠，故两侧都禁用文字，只留点线；左右由绿/橙、参考/目标由半透明深浅区分。
   const originalFillText=ctx.fillText;
   const noText=(()=>{}) as any;
   // 参考骨架：单帧静态标注，半透明绘制以与目标骨架区分；复用既有 drawReferenceSkeleton。
   ctx.save();ctx.globalAlpha=.55;ctx.fillText=noText;
   try{drawReferenceSkeleton(ctx,view,projectRef);}finally{ctx.fillText=originalFillText;}
   ctx.restore();
   if(skel.mappingOk){
    // 目标骨架：语义映射成立时按统一语义图连线（复用 drawVisualGraph，comparison 省略）。
    const pts=targetSkeletonPoints(target.trajectories[i],skel.nodes);
    ctx.fillText=noText;
    try{drawVisualGraph(ctx,{points:pts},projectTarget);}finally{ctx.fillText=originalFillText;}
   }else{
    // 降级：只画逐帧骨骼点，不连线、不伪装成已校准骨架。
    ctx.fillStyle='#9aa6b8';
    for(const b of Object.values(target.trajectories[i]?.bones??{}) as any){const q=projectTarget(b.x,b.y);ctx.beginPath();ctx.arc(q[0],q[1],1.5,0,Math.PI*2);ctx.fill();}
   }
  }
  else{
   const im=await loadImage(await readFile(resolveWorkspacePath(f.filePath,c)));ctx.save();ctx.beginPath();ctx.rect(0,0,w,h);ctx.clip();ctx.drawImage(im,...view.crop as [number,number,number,number],refX,refY,view.crop[2]*rs,view.crop[3]*rs);ctx.restore();
   const targetImage=await loadImage(await readFile(resolveWorkspacePath(target.frames[i],c)));
   if(overlay){ctx.save();ctx.globalAlpha=opacity;ctx.drawImage(targetImage,0,0);ctx.restore();}
   else ctx.drawImage(targetImage,0,h+28);
  }
  ctx.fillStyle='white';ctx.font='14px sans-serif';
  if(skeleton){
   // 标签必须区分「有映射」「完整映射」「仅诊断」：布尔 mapped true 会把 13/15 的部分映射
   // 显示成已完整校准，与报告 semanticComplete:false 冲突，读图者会误判证据强度。
   const mappedRoles=Object.keys(skel.nodes??{}).length;
   const mapLabel=skel.mappingOk
    ? `mapped ${mappedRoles}/${referenceRoles.length}${skel.mappingComplete?' complete':' PARTIAL'}`
    : `mapped 0/${referenceRoles.length} UNMAPPED`;
  const modeLabel=retargetManifest?(a.acceptanceMode==='formal'?'formal expected-vs-actual':'diagnostic expected-vs-actual'):(skel.acceptanceMode==='formal'?'formal':'diagnostic');
  const refLabel=retargetManifest?`expected ${rt.toFixed(3)}s visualPoints`:`ref ${rt.toFixed(3)}s skeleton (single-frame)`;
  for(const [n,label] of [[0,refLabel],[1,`tgt ${t.toFixed(3)}s ${mapLabel} ${modeLabel}`]] as const){
    let font=12;ctx.font=`${font}px sans-serif`;
    while(font>8&&ctx.measureText(label).width>w-16){font-=1;ctx.font=`${font}px sans-serif`;}
    ctx.fillText(label,8,h+18+n*18);
   }
  }
  else if(overlay){
   // 两行短标签；字号按实测宽度收缩，下限 8px，避免窄画布裁切。
   ctx.fillStyle='white';
   for(const [n,label] of [[0,`ref ${rt.toFixed(3)}s`],[1,`tgt ${t.toFixed(3)}s alpha ${opacity}`]] as const){
    let font=12;ctx.font=`${font}px sans-serif`;
    while(font>8&&ctx.measureText(label).width>w-16){font-=1;ctx.font=`${font}px sans-serif`;}
    ctx.fillText(label,8,h+18+n*18);
   }
  }
  else {ctx.fillText(`reference ${rt.toFixed(3)}s`,8,h+20);ctx.fillText(`target ${t.toFixed(3)}s`,8,2*h+48);}
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data,palette=quantize(pixels,256);const tNext=n+1<selected.length?frameTimes[selected[n+1]]:target.duration;const delay=Math.max(10,(Math.round(tNext*100)-Math.round(t*100))*10);gif.writeFrame(applyPalette(pixels,palette),canvas.width,canvas.height,{palette,delay,repeat:0});
 }
 gif.finish();reportProgress(selected.length,selected.length,'动画对比已编码');
 const gifPath=`${out}/${skeleton?'reference-skeleton':overlay?'reference-overlay':'reference-above-target'}.gif`;await writeFile(resolveWorkspacePath(gifPath,c),gif.bytes());
 const manifestPath=`${out}/animation-comparison.json`;
 const evidence=await evidenceFiles([gifPath,a.targetManifestPath,target.gifPath,a.referenceManifestPath,a.poseManifestPath,...reference.frames.map((f:any)=>f.filePath),...(skeleton&&skel.mappingOk&&a.visualRigPath?[a.visualRigPath]:[])],c);
 const actualTarget=retargetManifest?{
  source:'candidate-runtime.actual-target-manifest',
  coordinateSystem:'normalizedSkeleton',
  targetTimes:selected.map(k=>frameTimes[k]),
  visualPoints:selected.map(k=>target.trajectories[k]?.visualPoints??{}),
  visualPointsAvailable:target.visualPointsAvailable===true&&selected.every(k=>target.trajectories[k]?.visualPointsAvailable===true),
  trajectories:selected.map(k=>target.trajectories[k]),
 }:null;
 const expectedByFrame=retargetManifest?selected.map(k=>retargetExpectedForTime(retargetTargets,frameTimes[k])):[];
 const expectedAvailable=!!retargetManifest&&expectedByFrame.length>0&&expectedByFrame.every(Boolean);
 const actualAvailable=!!actualTarget?.visualPointsAvailable;
 const retargetComparison=retargetManifest?expectedByFrame.map((expected:any,n:number)=>expected?compareExpectedActualVisualPoints(expected,{visualPoints:actualTarget!.visualPoints[n]}):{ok:false,metrics:[],message:'共同采样时间没有对应 expected target。'}):null;
 const retargetMetrics=retargetComparison?retargetComparison.flatMap((entry:any,n:number)=>entry.metrics.map((metric:any)=>({...metric,targetTime:frameTimes[selected[n]]}))):null;
 const retargetSourceProblem=retargetManifest?expectedRetargetManifestProblem(retargetManifest):null;
 const retargetFormalReady=!!retargetManifest&&!retargetSourceProblem&&expectedAvailable&&actualAvailable&&!!retargetMetrics?.length&&retargetComparison!.every((entry:any)=>entry.ok)&&retargetManifest.referenceApprovalDecision==='approved';
 const commonSampleFingerprint=retargetManifest
  ? hashObject({targetTimes:expectedByFrame.filter(Boolean).map((entry:any)=>entry.targetTime)})
  : null;
 const skeletonFields=skeleton?{
  // 旧 renderer 只读取 reference.frames 与 trajectories.bones；它不是 retarget 后的目标轨迹。
  // 提供显式 retarget manifest 后，formal 证据改为 expected visualPoints 与 runtime actual visualPoints 的逐点比较。
  comparisonMode:retargetManifest?'retargeted':'legacy-raw-diagnostic',
  skeletonSource:retargetManifest?'expected-target.visualPoints':'reference-single-frame',
  targetSource:retargetManifest?'candidate-runtime.actual-target-manifest.visualPoints':'trajectories.bones',
  rawTargetSource:'trajectories.bones',
  expectedTargetSource:retargetManifest?retargetManifest.expectedTargetSource:null,
  retargetMode:retargetManifest?retargetManifest.retargetMode:null,
  retargetStatus:retargetManifest?retargetManifest.status:null,
  retargetQuality:retargetManifest?retargetManifest.retargetQuality:null,
  preservedConstraints:retargetManifest?retargetManifest.preservedConstraints??[]:[],
  relaxedConstraints:retargetManifest?retargetManifest.relaxedConstraints??[]:[],
  retargetResiduals:retargetManifest?retargetManifest.residuals??{}:{},
  actualTargetSource:retargetManifest?actualTarget?.source:null,
  expectedTargetManifestHash:retargetManifest?retargetManifest.expectedTargetManifestHash:null,
  actualTargetManifestHash:retargetManifest&&actualTarget?hashObject(actualTarget):null,
  referenceApprovalDecision:retargetManifest?retargetManifest.referenceApprovalDecision:null,
  referenceApprovalFingerprint:retargetManifest?retargetManifest.referenceApprovalFingerprint:null,
  visualPointsAvailable:retargetManifest?actualAvailable:false,
  expectedSampleFingerprint:retargetManifest?retargetManifest.expectedSampleFingerprint:null,
  actualSampleFingerprint:retargetManifest?commonSampleFingerprint:null,
  rawDiagnosticOnly:!retargetManifest,
  formalEligible:retargetManifest?retargetFormalReady:false,
  diagnosticOnly:!retargetManifest,
  acceptanceMode:retargetManifest?(a.acceptanceMode==='formal'&&retargetFormalReady?'formal':'diagnostic'):skel.acceptanceMode,
  verifiedRig:skel.verifiedRig,
  semanticMapped:skel.mappingOk,semanticComplete:skel.mappingComplete,unmappedRoles:skel.unmappedRoles,
  correspondenceSource:skel.correspondenceSource,
  correspondence:skel.correspondence,
  targetFacing:skel.targetFacing,
  ...(skel.mappingReason?{semanticMappingReason:skel.mappingReason}:{}),
  skeletonMetrics:retargetManifest?retargetMetrics:skel.metrics,
  metricsAvailable:retargetManifest?!!retargetMetrics?.length:skel.metricsAvailable,
  metricsAcceptanceReady:retargetManifest?retargetFormalReady:skel.metricsAcceptanceReady,
  metricsUnavailableReason:retargetManifest?(!expectedAvailable?'缺少与选中时间一一对应的 expected target':!actualAvailable?'candidate runtime actual target 缺少完整 visualPoints':null):skel.metricsUnavailableReason,
  metricsAcceptanceReason:retargetManifest?(!retargetFormalReady?'expected vs actual 尚未满足正式逐点比较门禁':null):skel.metricsAcceptanceReason,
  acceptanceEligible:retargetManifest?retargetFormalReady&&a.acceptanceMode==='formal':skel.acceptanceEligible,
  ...(retargetManifest?{retargetManifestPath:a.retargetManifestPath,retargetManifestFingerprint:retargetManifest.retargetManifestFingerprint,referenceApprovalFingerprint:retargetManifest.referenceApprovalFingerprint,targetCharacterFingerprint:retargetManifest.targetCharacterFingerprint,actionBindingFingerprint:retargetManifest.actionBindingFingerprint,visualRigFingerprint:retargetManifest.visualRigFingerprint,expectedTargetManifest:retargetManifest,actualTarget}:{}),
 }:{};
 const comparison={ok:true,layout,jsonHash:target.jsonHash,gifPath,originalSpeedGif:target.gifPath,phaseMap:map,evidence,manifestPath,frameCount:selected.length,frameTimes:selected.map(k=>frameTimes[k]),...(overlay?{opacity}:{}),...skeletonFields};
 // 把 layout 与骨架证据关键字段固化进 manifest：字段漂移时 review/commit 会算出不同指纹并拒绝。
 const result={...comparison,layoutFingerprint:comparisonManifestFingerprint(comparison)};
 await saveJson(manifestPath,result,c);return result;
}
export async function reviewAnimation(a:any,c:ToolContext={}) {
 return withStrict(async()=>{

 if(!/^[0-9a-f]{64}$/.test(a.reviewToken))throw new Error('reviewToken 格式无效。');
 const record=await readJson(`.spine-mcp/reviews/${a.reviewToken}.json`,c),candidate=await readJson(record.candidatePath,c);
 if(hashObject(candidate)!==record.candidateHash)throw new Error('候选动画已改变。');
 const motion=await readJson(record.motionPath,c),gate=await poseGate(motion,c);if(!gate.ok||gate.fingerprint!==record.tokenData.poseReview)throw new Error('关键姿态确认已过期。');
 const keyGraphs=await (await import('./referenceRetarget.js')).compareAnimationKeyPoses(record.candidatePath,record.tokenData.animation,motion,record.duration??motion.duration,c);
 if(a.decision==='approved'&&!keyGraphs.ok)throw new Error('插值后实际关键时间的参考骨架关系失败，不能批准完整动画。');
 const m=await readJson(a.manifestPath,c);if(m.jsonHash!==record.candidateHash||!m.gifPath)throw new Error('视觉证据不是当前完整候选动画。');
 // 有参考的任务必须提供同步对比：上下排列、外观叠加、骨架叠加三种布局都接受，但都必须是真实渲染且绑定证据。
 // 放宽布局不等于放宽要求——布局名、gifPath 与 evidence 仍缺一不可。
 if(record.requiresReferenceComparison&&!animationComparisonLayouts.includes(m.layout))throw new Error('有参考的任务需同步对比 GIF（上下排列/外观叠加/骨架叠加）和原速 GIF。');
 if(record.requiresReferenceComparison&&!(m.evidence?.length))throw new Error('同步对比必须绑定证据文件。');
 // 正式批准门禁按「证据实际是不是骨架叠加」判定，而不是按可编辑的 layout 字符串；
 // 同时核对 layout 与 GIF 产物名、以及生成时固化的布局指纹，防止字段漂移绕过门禁。
 const comparisonProblem=comparisonManifestProblem(m,a.decision,!!record.requiresReferenceComparison);
 if(comparisonProblem)throw new Error(comparisonProblem);
 if(!a.reviewedBy?.trim()||!a.reason?.trim()||!['approved','rejected'].includes(a.decision)||animationChecks.some(k=>!a.checks?.includes(k))||a.decision==='approved'&&a.issues?.length)throw new Error('完整动画审查需确认者、理由、全部检查项，未解决问题不得确认。');
 const evidence=[...m.evidence??[],...await evidenceFiles([a.manifestPath,m.gifPath,...m.originalSpeedGif?[m.originalSpeedGif]:[],...m.frames??[]],c)];await verifyEvidence(evidence,c);
 const review={decision:a.decision,reviewedBy:a.reviewedBy,reason:a.reason,checks:a.checks,issues:a.issues??[],keyGraphsFingerprint:keyGraphs.fingerprint,evidence,at:new Date().toISOString(),baseToken:a.reviewToken,candidateHash:record.candidateHash};const reviewToken=hashObject({base:a.reviewToken,review});
 if(a.dryRun===false)await saveJson(`.spine-mcp/reviews/${a.reviewToken}.visual.json`,{review,reviewToken},c);return {ok:true,dryRun:a.dryRun??true,reviewToken,review};

 });
}
export async function assertAnimationReview(base:string,approval:string|undefined,c:ToolContext) {const r=await readJson(`.spine-mcp/reviews/${base}.visual.json`,c);if(r.review.decision!=='approved'||approval!==r.reviewToken||hashObject({base,review:r.review})!==r.reviewToken)throw new Error('缺少有效完整动画视觉审查。');const record=await readJson(`.spine-mcp/reviews/${base}.json`,c),candidate=await readJson(record.candidatePath,c);if(hashObject(candidate)!==record.candidateHash)throw new Error('完整候选已改变。');const motion=await readJson(record.motionPath,c),graphs=await (await import('./referenceRetarget.js')).compareAnimationKeyPoses(record.candidatePath,record.tokenData.animation,motion,record.duration??motion.duration,c);if(!graphs.ok||graphs.fingerprint!==r.review.keyGraphsFingerprint)throw new Error('实际动画关键时间关系比较失败或已过期。');await verifyEvidence(r.review.evidence,c);return r;}
