import {referenceFingerprint} from './domainFingerprints.js';
export {referenceFingerprint} from './domainFingerprints.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { hashObject, saveJson } from './mappingTools.js';
import { graphEdges,torsoAxis } from './poseGraph.js';
import { validateReferenceAction } from './actionSemantics.js';
import { analyzeReferenceParts, validateReferenceParts, drawReferenceParts, referencePartsPolicyVersion } from './referenceParts.js';

export const referenceRoles = ['head','face','body','leftShoulder','leftElbow','leftWrist','rightShoulder','rightElbow','rightWrist','leftHip','leftKnee','leftAnkle','rightHip','rightKnee','rightAnkle'];
export const referenceChecks = ['jointLocations','visibility','connections','facing','support','uncertainty','orientation','depth','silhouette'];
const edges = graphEdges;
const shortLabels:Record<string,string>={head:'Head',face:'Face',body:'Body',leftShoulder:'L.S',leftElbow:'L.E',leftWrist:'L.W',rightShoulder:'R.S',rightElbow:'R.E',rightWrist:'R.W',leftHip:'L.H',leftKnee:'L.K',leftAnkle:'L.A',rightHip:'R.H',rightKnee:'R.K',rightAnkle:'R.A'};
const read = async (p:string,c:ToolContext)=>JSON.parse(await readFile(resolveWorkspacePath(p,c),'utf8'));
const hashFile = async (p:string,c:ToolContext)=>hashObject((await readFile(resolveWorkspacePath(p,c))).toString('base64'));

const depthParts = ['leftArm','rightArm','leftLeg','rightLeg','torso','head'];

/**
 * 对参考图上的关键点做最小的视觉一致性审查。
 *
 * 参考点不是 IK 坐标，但可见点仍必须落在角色前景附近。过去只校验
 * JSON 结构，导致背景坐标也能被标成 confirmed，随后所有弯曲方向和支撑
 * 关系都会从错误输入开始。这里不尝试识别关节，只回答一个更基础的问题：
 * 该点是否真的靠近这张参考图中的角色像素。
 */
export async function auditReferenceObservationImage(observation:any,c:ToolContext={}):Promise<any>{
 const image=await loadImage(await readFile(resolveWorkspacePath(observation.imagePath,c)));
 const canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
 const pixels=ctx.getImageData(0,0,image.width,image.height).data;
 const sample=(x:number,y:number)=>{const xx=Math.max(0,Math.min(image.width-1,Math.round(x))),yy=Math.max(0,Math.min(image.height-1,Math.round(y))),i=(yy*image.width+xx)*4;return [pixels[i],pixels[i+1],pixels[i+2],pixels[i+3]];};
 const bgSamples=[sample(0,0),sample(image.width-1,0),sample(0,image.height-1),sample(image.width-1,image.height-1)];
 const bg=bgSamples[0];
 const foreground=(x:number,y:number)=>{const p=sample(x,y);if(p[3]===0)return false;const nearestBg=Math.min(...bgSamples.map(b=>Math.abs(p[0]-b[0])+Math.abs(p[1]-b[1])+Math.abs(p[2]-b[2])));return nearestBg>30;};
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(let y=0;y<image.height;y+=2)for(let x=0;x<image.width;x+=2)if(foreground(x,y)){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
 const nearest=(x:number,y:number,maxRadius=24)=>{if(foreground(x,y))return 0;for(let r=1;r<=maxRadius;r++){for(let dy=-r;dy<=r;dy++)for(const dx of [-r,r])if(foreground(x+dx,y+dy))return r;for(let dx=-r+1;dx<=r-1;dx++)for(const dy of [-r,r])if(foreground(x+dx,y+dy))return r;}return Infinity;};
 const points:any[]=[];
 for(const [role,p] of Object.entries(observation.points??{}) as any){if(!Number.isFinite(p?.x)||!Number.isFinite(p?.y))continue;const distance=nearest(p.x,p.y);const hard=p.visibility==='visible'&&distance>8;const warning=p.visibility==='occluded'&&p.estimated===true&&distance>24;points.push({role,visibility:p.visibility,distance:Number.isFinite(distance)?distance:null,ok:!hard&&!warning,blocking:hard,warning,code:hard?'KEYPOSE_FOREGROUND_MISMATCH':warning?'KEYPOSE_OCCLUDED_FOREGROUND_MISMATCH':undefined,reason:hard?'可见点远离参考角色前景，不能作为已确认关节。':warning?'遮挡推测点也远离角色前景，请重新估计。':'参考点位于角色前景附近。'});}
 const silhouette:any[]=[];for(const [band,value] of [['shoulder',observation.silhouette?.shoulder],['hip',observation.silhouette?.hip]] as any){for(const [side,p] of Object.entries(value??{}) as any){if(!Number.isFinite(p?.x)||!Number.isFinite(p?.y))continue;const distance=nearest(p.x,p.y);silhouette.push({role:`silhouette.${band}.${side}`,visibility:p.visibility,distance:Number.isFinite(distance)?distance:null,ok:distance<=12,blocking:p.visibility==='visible'&&distance>12,reason:distance>12?'轮廓点远离参考角色前景。':'轮廓点位于角色前景附近。'});}}
 const blocking=[...points,...silhouette].filter(v=>v.blocking);const warnings=[...points,...silhouette].filter(v=>v.warning);return {ok:blocking.length===0,blocking,warnings,points,silhouette,image:{width:image.width,height:image.height,background:bg.slice(0,3),backgroundSamples:bgSamples.map(v=>v.slice(0,3)),foregroundBounds:Number.isFinite(minX)?{minX,minY,maxX,maxY}:null}};
}

/**
 * 对单个 keypose 做语义绑定审查。
 * 图像前景检查只能回答“点是否落在角色附近”，不能回答左右身份、支撑、朝向
 * 和遮挡依据是否足够。这里把这些信息单独列出，避免 adaptive 模式把错误标注
 * 当成可以放宽的几何残差。
 */
export function auditReferenceKeypose(observation:any, imageAudit:any){
 const blocking:any[]=[];
 const identity=observation?.anatomicalIdentity;
 if(identity?.status!=='confirmed'||!identity?.basis?.trim())blocking.push({code:'KEYPOSE_IDENTITY_UNCONFIRMED',message:'参考 keypose 缺少已确认的解剖左右身份及依据。'});
 if(!['left','right'].includes(observation?.facing))blocking.push({code:'KEYPOSE_FACING_MISSING',message:'参考 keypose 缺少 facing(left/right)。'});
 const support=observation?.support;
 if(typeof support?.left!=='boolean'||typeof support?.right!=='boolean')blocking.push({code:'KEYPOSE_SUPPORT_UNCONFIRMED',message:'参考 keypose 必须明确左右支撑脚状态。'});
 const orientation=observation?.orientation;
 if(!orientation||!['front','threeQuarter','profile','back'].includes(orientation.band)||!orientation.basis?.trim())blocking.push({code:'KEYPOSE_ORIENTATION_UNCONFIRMED',message:'参考 keypose 缺少有效朝向档位和依据。'});
 const depth=observation?.depth;
 if(!depth||!Array.isArray(depth.evidence)||depth.evidence.length<1)blocking.push({code:'KEYPOSE_DEPTH_UNCONFIRMED',message:'参考 keypose 缺少前后遮挡/重叠证据。'});
 const required=['head','body','leftShoulder','rightShoulder','leftHip','rightHip'];
 for(const role of required){const p=observation?.points?.[role];if(!p||p.visibility==='unknown')blocking.push({code:'KEYPOSE_REQUIRED_POINT_UNKNOWN',role,message:`必要节点 ${role} 未知，不能建立稳定动作语义。`});}
 for(const [role,p] of Object.entries(observation?.points??{}) as any){
  if(p?.visibility==='visible'&&Number.isFinite(p.confidence)&&p.confidence<0.6)blocking.push({code:'KEYPOSE_LOW_CONFIDENCE_VISIBLE',role,message:`可见节点 ${role} 的置信度低于 0.6。`});
  if(p?.visibility==='occluded'&&p?.estimated!==true&&Number.isFinite(p?.x))blocking.push({code:'KEYPOSE_OCCLUDED_ESTIMATE_UNDECLARED',role,message:`遮挡节点 ${role} 带有坐标但未声明 estimated:true。`});
 }
 return {ok:!!imageAudit?.ok&&blocking.length===0,blocking,semantic:{identity:identity?.status??'missing',facing:observation?.facing??null,support:support??null,orientation:orientation?.band??null,depthEvidenceCount:depth?.evidence?.length??0}};
}
// 单点校验同时用于 15 个关节与 4 个轮廓点；未知点不得带坐标。
function validateNodePoint(p:any,label:string){
 if(!p||!['visible','occluded','unknown'].includes(p.visibility))throw new Error(`必须声明 ${label} 的可见性；无法确定可填 unknown。`);
 const hasX=p.x!==undefined,hasY=p.y!==undefined;
 if(hasX!==hasY||hasX&&(!Number.isFinite(p.x)||!Number.isFinite(p.y))||p.visibility==='visible'&&!hasX||p.visibility==='unknown'&&hasX)throw new Error(`${label} 坐标与可见性不一致。`);
 if(hasX&&(typeof p.confidence!=='number'||p.confidence<0||p.confidence>1||!p.basis?.trim()))throw new Error(`${label} 坐标需 confidence 0–1 与依据。`);
 if(p.visibility==='occluded'&&hasX&&p.estimated!==true)throw new Error(`${label} 遮挡坐标必须标明 estimated:true。`);
}
function validateSilhouette(s:any){
 if(!s||s.version!==1||!s.basis?.trim())throw new Error('参考 v2 需 silhouette：version:1、依据，以及肩线/髋线同高度的左右可见轮廓点。');
 for(const band of ['shoulder','hip'])for(const side of ['left','right'])validateNodePoint(s[band]?.[side],`silhouette.${band}.${side}`);
}
function validateOrientation(o:any){
 if(!o||o.version!==1||!['front','threeQuarter','profile','back'].includes(o.band)||!Number.isFinite(o.amplitude)||o.amplitude<0||o.amplitude>1||!o.basis?.trim())throw new Error('参考 v2 需 orientation：band(front/threeQuarter/profile/back)、amplitude 0–1 与依据；幅度只作同序列相对量，不是绝对角度。');
}
function validateDepth(d:any){
 if(!d||d.version!==1||!d.basis?.trim()||!Array.isArray(d.evidence)||d.evidence.length<1||d.evidence.length>8)throw new Error('参考 v2 需 depth：version:1、依据和 1–8 条前后证据；不能凭空给出 front/back 标签。');
 const seen=new Set<string>();
 for(const e of d.evidence){
  if(!e?.id?.trim()||seen.has(e.id))throw new Error('前后证据 id 必须非空且唯一。');seen.add(e.id);
  if(!depthParts.includes(e.a)||!depthParts.includes(e.b)||e.a===e.b)throw new Error(`前后证据 ${e.id} 的 a/b 必须是不同语义部位（leftArm/rightArm/leftLeg/rightLeg/torso/head）。`);
  if(!['front','back'].includes(e.relation)||!['occlusion','overlap','scale'].includes(e.kind)||!e.basis?.trim())throw new Error(`前后证据 ${e.id} 需 relation(front/back)、kind(occlusion/overlap/scale) 与依据。`);
 }
}
function validate(r:any) {
  validateReferenceParts(r);
  validateReferenceAction(r.actionSemantics);
  if(r.edges&&hashObject(r.edges)!==hashObject(graphEdges))throw new Error('参考连接关系必须使用统一语义图，禁止另一份脱节的连线。');
  if(r.support&&['left','right'].some(k=>typeof r.support[k]!=='boolean'))throw new Error('参考 support.left/right 必须明确 true/false。');
  if(r.grip&&(!r.grip.points||['left','right'].some(k=>!Number.isFinite(r.grip.points[k]?.x)||!Number.isFinite(r.grip.points[k]?.y))||!r.grip.basis?.trim()))throw new Error('参考握持需两个图像点及依据，不能伪造未知握持点。');
  if(!r.imagePath||!r.basis?.trim()||!['left','right'].includes(r.facing)||!Number.isFinite(r.time)||r.time<0||!Number.isFinite(r.height)||r.height<=0||!Number.isFinite(r.groundY)||r.crop?.length!==4||!r.crop.every(Number.isFinite)||r.crop[2]<=0||r.crop[3]<=0)throw new Error('参考姿态需图像、时间、方向、固定裁剪、身高、地面及判断依据。');
  for(const role of referenceRoles)validateNodePoint(r.points?.[role],role);
  validateSilhouette(r.silhouette);validateOrientation(r.orientation);validateDepth(r.depth);
}
// 版本只在记录级检查：v1 没有面部锚点、轮廓、朝向与前后证据，不能静默按 v2 处理。
function validateVersion(record:any){
 if(record?.version!==2)throw new Error(`参考标注当前为 v${record?.version??'?'}，需升级为 v2：先用 spine_upgrade_reference_pose 补 face/轮廓/朝向/前后依据，再重新审查。`);
}
export function drawReferenceSkeleton(ctx:any,r:any,project:(x:number,y:number)=>number[]) {
 drawReferenceParts(ctx,r,project);
 if(r.grip?.points?.left&&r.grip?.points?.right){const a=project(r.grip.points.left.x,r.grip.points.left.y),b=project(r.grip.points.right.x,r.grip.points.right.y);ctx.strokeStyle='#fff17a';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();for(const [side,p]of Object.entries(r.grip.points) as any){const q=project(p.x,p.y);ctx.strokeRect(q[0]-3,q[1]-3,6,6);ctx.fillStyle='#fff17a';ctx.fillText(side+' grip',q[0]+4,q[1]+9);}}
 const axis=torsoAxis(r.points);if(axis){const a=project(axis.hip.x,axis.hip.y),b=project(axis.shoulder.x,axis.shoulder.y);ctx.strokeStyle='#78d4ff';ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.fillStyle='#78d4ff';ctx.fillText('Torso',(a[0]+b[0])/2,(a[1]+b[1])/2);}
 // 可见轮廓：只在肩线/髋线同高度取外缘，用于区分「骨骼枢轴」与「画面轮廓」。
 const sil=r.silhouette;
 if(sil){const ring=(['shoulder.left','shoulder.right','hip.right','hip.left'] as const).map((k:string)=>{const [band,side]=k.split('.');const p=(sil as any)[band]?.[side];return Number.isFinite(p?.x)?project(p.x,p.y):null;});
  ctx.strokeStyle='#c7a4ff';ctx.setLineDash([4,3]);for(const q of ring){if(!q)continue;ctx.strokeRect(q[0]-2,q[1]-2,4,4);}
  const solid=ring.filter(Boolean) as number[][];if(solid.length>=2){ctx.beginPath();ctx.moveTo(solid[0][0],solid[0][1]);for(const q of solid.slice(1))ctx.lineTo(q[0],q[1]);if(solid.length===4)ctx.closePath();ctx.stroke();}
  ctx.setLineDash([]);ctx.fillStyle='#c7a4ff';if(solid[0])ctx.fillText('Silhouette',solid[0][0]+4,solid[0][1]-4);
 }
 // 面部朝向：头身连线不是朝向，只有面部锚点能给出方向。
 const hd=r.points?.head,fc=r.points?.face;
 if(Number.isFinite(hd?.x)&&Number.isFinite(fc?.x)){const a=project(hd.x,hd.y),b=project(fc.x,fc.y);ctx.strokeStyle='#fff17a';ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#fff17a';ctx.fillText('Face',b[0]+4,b[1]-4);}
  for(const [id,[a,b]]of edges.entries()){const p=r.points[a],q=r.points[b];if(!Number.isFinite(p?.x)||!Number.isFinite(q?.x))continue;ctx.strokeStyle=a.startsWith('left')||b.startsWith('left')?'#65dfab':a.startsWith('right')||b.startsWith('right')?'#ffba6b':'#78d4ff';ctx.setLineDash(p.visibility==='occluded'||q.visibility==='occluded'?[5,4]:[]);ctx.beginPath();const u=project(p.x,p.y),v=project(q.x,q.y);ctx.moveTo(...u);ctx.lineTo(...v);ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.fillText('E'+id,(u[0]+v[0])/2,(u[1]+v[1])/2);}
  ctx.setLineDash([]);ctx.font='11px sans-serif';for(const [role,p]of Object.entries(r.points) as any){if(!Number.isFinite(p.x))continue;const q=project(p.x,p.y);ctx.fillStyle=role.startsWith('left')?'#65dfab':role.startsWith('right')?'#ffba6b':'#78d4ff';ctx.strokeStyle=ctx.fillStyle;ctx.beginPath();ctx.arc(q[0],q[1],3,0,Math.PI*2);p.visibility==='visible'?ctx.fill():ctx.stroke();const label=(shortLabels[role]??role)+(p.visibility==='occluded'?'?':'');ctx.fillText(label,q[0]+4,q[1]-4);}
}
export async function createReferencePose(a:any,c:ToolContext={}) {
  a=structuredClone(a);a.observation.edges=graphEdges;
  validate(a.observation);const im=await loadImage(await readFile(resolveWorkspacePath(a.observation.imagePath,c)));const r=a.observation;
  if(r.crop[0]<0||r.crop[1]<0||r.crop[0]+r.crop[2]>im.width||r.crop[1]+r.crop[3]>im.height)throw new Error('参考裁剪超出图像。');
  for(const p of Object.values(r.points) as any[])if(Number.isFinite(p.x)&&(p.x<0||p.x>im.width||p.y<0||p.y>im.height))throw new Error('参考点超出图像。');
  for(const part of Object.values(r.parts??{}) as any[])for(const p of part.outline??[])if(p.x<0||p.x>im.width||p.y<0||p.y>im.height)throw new Error('部件轮廓超出图像。');
  const record={version:2,id:a.id??a.referencePosePath,status:'draft',observation:r,imageHash:await hashFile(r.imagePath,c)};
  if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.referencePosePath,c));throw new Error('参考姿态已存在，请使用新修订路径。');}catch(e:any){if(e.code!=='ENOENT')throw e;}await saveJson(a.referencePosePath,record,c);}return {ok:true,dryRun:a.dryRun??true,record};
}
export async function requireReferencePose(p:string,c:ToolContext,approved=true) {
  const r=await read(p,c);validateVersion(r);validate(r.observation);if(await hashFile(r.observation.imagePath,c)!==r.imageHash)throw new Error('参考图像已改变。');
  if(approved){if(r.status!=='confirmed'||r.review?.decision!=='approved'||r.review.fingerprint!==referenceFingerprint(r))throw new Error('参考姿态尚未审查或标注已改变。');if(r.observation.parts&&(r.review.partsPolicyVersion!==referencePartsPolicyVersion||!analyzeReferenceParts(r.observation).ok))throw new Error('参考部件策略已改变或缺少可用观测，请重出图并审查；不能继承旧批准。');for(const e of r.review.evidence??[])if(await hashFile(e.filePath,c)!==e.hash)throw new Error('参考审查图像证据已改变。');if(!r.review.evidence?.length)throw new Error('参考审查缺少图像证据。');}return r;
}
export async function renderReferencePoseSheet(a:any,c:ToolContext={}) {
  if(!a.referencePosePaths?.length||a.referencePosePaths.length>60)throw new Error('参考姿态数量需 1–60。');
  const records=[];for(const p of a.referencePosePaths)records.push({path:p,r:await requireReferencePose(p,c,false)});
  const width=320,height=320,dir=a.outputDir;await mkdir(resolveWorkspacePath(dir,c),{recursive:true});const pages=[],evidence=[];
  const fixed=records[0].r.observation;for(const {r}of records)if(hashObject([r.observation.crop,r.observation.height,r.observation.groundY])!==hashObject([fixed.crop,fixed.height,fixed.groundY]))throw new Error('参考序列必须固定裁剪、身高和地面。');
  for(let start=0;start<records.length;start+=6){const group=records.slice(start,start+6),canvas=createCanvas(group.length*width,720),ctx=canvas.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,canvas.width,canvas.height);
    for(const [i,{r}]of group.entries()){const o=r.observation,im=await loadImage(await readFile(resolveWorkspacePath(o.imagePath,c))),sc=height*.7/o.height,[rx,ry,rw,rh]=o.crop,dx=i*width+width/2-rw*sc/2,dy=height*.9-(o.groundY-ry)*sc;
      for(const row of [0,1]){ctx.save();ctx.beginPath();ctx.rect(i*width,row*360,width,height);ctx.clip();ctx.drawImage(im,rx,ry,rw,rh,dx,dy+row*360,rw*sc,rh*sc);if(row){drawReferenceSkeleton(ctx,o,(x,y)=>[dx+(x-rx)*sc,dy+360+(y-ry)*sc]);ctx.strokeStyle='#78d4ff';ctx.beginPath();ctx.moveTo(i*width,360+height*.9);ctx.lineTo((i+1)*width,360+height*.9);ctx.stroke();}ctx.restore();ctx.fillStyle='white';ctx.font='13px sans-serif';ctx.fillText(`${r.id} ${o.time.toFixed(3)}s / ${row?'annotated':'reference'} ${o.facing}`,i*width+4,row*360+height+20);}}
    const p:string=`${dir}/reference-page-${pages.length+1}.png`;await writeFile(resolveWorkspacePath(p,c),canvas.toBuffer('image/png'));pages.push(p);evidence.push({filePath:p,hash:await hashFile(p,c)});}
  const manifest={ok:true,version:1,partsPolicyVersion:referencePartsPolicyVersion,layout:'reference-raw-above-annotated',records:records.map(v=>({path:v.path,fingerprint:referenceFingerprint(v.r)})),pages,evidence,legend:'左绿右橙；实线=两端可见，虚线/空心点=遮挡推测；轮廓不可用时以黄色两点连线估计，未知坐标不编造。左右按角色自身定义。',warnings:records.flatMap(({r})=>referenceRoles.filter(k=>r.observation.points[k].visibility!=='visible').map(k=>`${r.id}: ${k} ${r.observation.points[k].visibility}`))};const manifestPath=`${dir}/reference-pose-sheet.json`;await saveJson(manifestPath,manifest,c);return {...manifest,manifestPath};
}
export async function reviewReferencePose(a:any,c:ToolContext={}) {
  const r=await requireReferencePose(a.referencePosePath,c,false),m=await read(a.manifestPath,c);
  if(a.decision==='approved'&&r.observation.parts){
    if(m.partsPolicyVersion!==referencePartsPolicyVersion)throw new Error('参考部件图使用旧策略，请重出图再审查。');
    if(!analyzeReferenceParts(r.observation).ok)throw new Error('部件观测没有可用方向或可靠证据相互冲突，不能批准；缺轮廓但有两点时允许估计回退。');
  }
  if(!m.records?.some((v:any)=>v.path===a.referencePosePath&&v.fingerprint===referenceFingerprint(r)))throw new Error('图像不包含当前参考标注。');
  if(!['approved','rejected'].includes(a.decision)||!a.reason?.trim()||!a.reviewedBy?.trim()||referenceChecks.some(k=>!a.checks?.includes(k))||a.decision==='approved'&&a.issues?.length)throw new Error('需完整参考审查项、确认者、理由及已解决的问题。');
  if(a.decision==='approved'&&r.observation.actionSemantics&&r.observation.actionSemantics.identityStatus!=='confirmed')throw new Error('持杖解剖身份尚未连续校准，不能批准参考。');
  for(const e of m.evidence??[])if(await hashFile(e.filePath,c)!==e.hash)throw new Error('参考图像证据已改变。');if(!m.evidence?.length)throw new Error('缺少参考图像证据。');
  r.review={decision:a.decision,reason:a.reason,reviewedBy:a.reviewedBy,checks:a.checks,issues:a.issues??[],fingerprint:referenceFingerprint(r),...(r.observation.parts?{partsPolicyVersion:referencePartsPolicyVersion,partMethods:analyzeReferenceParts(r.observation).parts.map(p=>({id:p.id,method:p.method,reliability:p.reliability,uncertaintyKnown:p.uncertaintyKnown}))}:{}),evidence:[...m.evidence,{filePath:a.manifestPath,hash:await hashFile(a.manifestPath,c)}],at:new Date().toISOString()};r.status=a.decision==='approved'?'confirmed':'rejected';if(a.dryRun===false)await saveJson(a.referencePosePath,r,c);return {ok:true,dryRun:a.dryRun??true,review:r.review};
}
// v1 → v2 只搬运既有骨架，不自动编造面部朝向、轮廓或前后依据；缺项时列出 pending 且不落盘。
export async function upgradeReferencePose(a:any,c:ToolContext={}) {
  const old=await read(a.referencePosePath,c);
  if(old.version===2)return {ok:false,pending:[],message:'参考标注已是 v2，无需升级。'};
  const observation=structuredClone(old.observation);
  observation.points={...(observation.points??{})};
  if(a.face)observation.points.face=a.face;
  if(a.silhouette)observation.silhouette=a.silhouette;
  if(a.orientation)observation.orientation=a.orientation;
  if(a.depth)observation.depth=a.depth;
  const pending:string[]=[];
  if(observation.points.face?.visibility!=='visible'&&observation.points.face?.visibility!=='occluded')pending.push('face');
  if(!observation.silhouette)pending.push('silhouette');
  if(!observation.orientation)pending.push('orientation');
  if(!observation.depth)pending.push('depth');
  if(pending.length)return {ok:false,pending,message:`参考 v2 需补全以下字段后再升级：${pending.join('、')}。面部锚点取鼻尖；轮廓取肩线/髋线同一高度的可见外缘；前后必须写清遮挡/重叠/尺度证据。`};
  validate(observation);
  const record={...old,version:2,status:'draft',observation,imageHash:old.imageHash};delete record.review;
  if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.outputReferencePosePath,c));throw new Error('目标路径已存在，请使用新修订路径。');}catch(e:any){if(e.code!=='ENOENT')throw e;}await saveJson(a.outputReferencePosePath,record,c);}
  return {ok:true,dryRun:a.dryRun??true,upgradedFrom:a.referencePosePath,record};
}
