import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { hashObject, saveJson } from './mappingTools.js';
import { graphEdges,torsoAxis } from './poseGraph.js';
import { validateReferenceAction } from './actionSemantics.js';

export const referenceRoles = ['head','body','leftShoulder','leftElbow','leftWrist','rightShoulder','rightElbow','rightWrist','leftHip','leftKnee','leftAnkle','rightHip','rightKnee','rightAnkle'];
export const referenceChecks = ['jointLocations','visibility','connections','facing','support','uncertainty'];
const edges = graphEdges;
const shortLabels:Record<string,string>={head:'Head',body:'Body',leftShoulder:'L.S',leftElbow:'L.E',leftWrist:'L.W',rightShoulder:'R.S',rightElbow:'R.E',rightWrist:'R.W',leftHip:'L.H',leftKnee:'L.K',leftAnkle:'L.A',rightHip:'R.H',rightKnee:'R.K',rightAnkle:'R.A'};
const read = async (p:string,c:ToolContext)=>JSON.parse(await readFile(resolveWorkspacePath(p,c),'utf8'));
const hashFile = async (p:string,c:ToolContext)=>hashObject((await readFile(resolveWorkspacePath(p,c))).toString('base64'));
export const referenceFingerprint = (r:any)=>hashObject({id:r.id,observation:r.observation,imageHash:r.imageHash});

function validate(r:any) {
  validateReferenceAction(r.actionSemantics);
  if(r.edges&&hashObject(r.edges)!==hashObject(graphEdges))throw new Error('参考连接关系必须使用统一语义图，禁止另一份脱节的连线。');
  if(r.support&&['left','right'].some(k=>typeof r.support[k]!=='boolean'))throw new Error('参考 support.left/right 必须明确 true/false。');
  if(r.grip&&(!r.grip.points||['left','right'].some(k=>!Number.isFinite(r.grip.points[k]?.x)||!Number.isFinite(r.grip.points[k]?.y))||!r.grip.basis?.trim()))throw new Error('参考握持需两个图像点及依据，不能伪造未知握持点。');
  if(!r.imagePath||!r.basis?.trim()||!['left','right'].includes(r.facing)||!Number.isFinite(r.time)||r.time<0||!Number.isFinite(r.height)||r.height<=0||!Number.isFinite(r.groundY)||r.crop?.length!==4||!r.crop.every(Number.isFinite)||r.crop[2]<=0||r.crop[3]<=0)throw new Error('参考姿态需图像、时间、方向、固定裁剪、身高、地面及判断依据。');
  for(const role of referenceRoles){const p=r.points?.[role];if(!p||!['visible','occluded','unknown'].includes(p.visibility))throw new Error(`必须声明 ${role} 的可见性；无法确定可填 unknown。`);const hasX=p.x!==undefined,hasY=p.y!==undefined;if(hasX!==hasY||hasX&&(!Number.isFinite(p.x)||!Number.isFinite(p.y))||p.visibility==='visible'&&!hasX||p.visibility==='unknown'&&hasX)throw new Error(`${role} 坐标与可见性不一致。`);if(hasX&&(typeof p.confidence!=='number'||p.confidence<0||p.confidence>1||!p.basis?.trim()))throw new Error(`${role} 坐标需 confidence 0–1 与依据。`);if(p.visibility==='occluded'&&hasX&&p.estimated!==true)throw new Error(`${role} 遮挡坐标必须标明 estimated:true。`);}
}
export function drawReferenceSkeleton(ctx:any,r:any,project:(x:number,y:number)=>number[]) {
 if(r.grip?.points?.left&&r.grip?.points?.right){const a=project(r.grip.points.left.x,r.grip.points.left.y),b=project(r.grip.points.right.x,r.grip.points.right.y);ctx.strokeStyle='#fff17a';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();for(const [side,p]of Object.entries(r.grip.points) as any){const q=project(p.x,p.y);ctx.strokeRect(q[0]-3,q[1]-3,6,6);ctx.fillStyle='#fff17a';ctx.fillText(side+' grip',q[0]+4,q[1]+9);}}
 const axis=torsoAxis(r.points);if(axis){const a=project(axis.hip.x,axis.hip.y),b=project(axis.shoulder.x,axis.shoulder.y);ctx.strokeStyle='#78d4ff';ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.fillStyle='#78d4ff';ctx.fillText('Torso',(a[0]+b[0])/2,(a[1]+b[1])/2);}
  for(const [id,[a,b]]of edges.entries()){const p=r.points[a],q=r.points[b];if(!Number.isFinite(p?.x)||!Number.isFinite(q?.x))continue;ctx.strokeStyle=a.startsWith('left')||b.startsWith('left')?'#65dfab':a.startsWith('right')||b.startsWith('right')?'#ffba6b':'#78d4ff';ctx.setLineDash(p.visibility==='occluded'||q.visibility==='occluded'?[5,4]:[]);ctx.beginPath();const u=project(p.x,p.y),v=project(q.x,q.y);ctx.moveTo(...u);ctx.lineTo(...v);ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.fillText('E'+id,(u[0]+v[0])/2,(u[1]+v[1])/2);}
  ctx.setLineDash([]);ctx.font='11px sans-serif';for(const [role,p]of Object.entries(r.points) as any){if(!Number.isFinite(p.x))continue;const q=project(p.x,p.y);ctx.fillStyle=role.startsWith('left')?'#65dfab':role.startsWith('right')?'#ffba6b':'#78d4ff';ctx.strokeStyle=ctx.fillStyle;ctx.beginPath();ctx.arc(q[0],q[1],3,0,Math.PI*2);p.visibility==='visible'?ctx.fill():ctx.stroke();const label=(shortLabels[role]??role)+(p.visibility==='occluded'?'?':'');ctx.fillText(label,q[0]+4,q[1]-4);}
}
export async function createReferencePose(a:any,c:ToolContext={}) {
  a=structuredClone(a);a.observation.edges=graphEdges;
  validate(a.observation);const im=await loadImage(await readFile(resolveWorkspacePath(a.observation.imagePath,c)));const r=a.observation;
  if(r.crop[0]<0||r.crop[1]<0||r.crop[0]+r.crop[2]>im.width||r.crop[1]+r.crop[3]>im.height)throw new Error('参考裁剪超出图像。');
  for(const p of Object.values(r.points) as any[])if(Number.isFinite(p.x)&&(p.x<0||p.x>im.width||p.y<0||p.y>im.height))throw new Error('参考点超出图像。');
  const record={version:1,id:a.id??a.referencePosePath,status:'draft',observation:r,imageHash:await hashFile(r.imagePath,c)};
  if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.referencePosePath,c));throw new Error('参考姿态已存在，请使用新修订路径。');}catch(e:any){if(e.code!=='ENOENT')throw e;}await saveJson(a.referencePosePath,record,c);}return {ok:true,dryRun:a.dryRun??true,record};
}
export async function requireReferencePose(p:string,c:ToolContext,approved=true) {
  const r=await read(p,c);validate(r.observation);if(await hashFile(r.observation.imagePath,c)!==r.imageHash)throw new Error('参考图像已改变。');
  if(approved){if(r.status!=='confirmed'||r.review?.decision!=='approved'||r.review.fingerprint!==referenceFingerprint(r))throw new Error('参考姿态尚未审查或标注已改变。');for(const e of r.review.evidence??[])if(await hashFile(e.filePath,c)!==e.hash)throw new Error('参考审查图像证据已改变。');if(!r.review.evidence?.length)throw new Error('参考审查缺少图像证据。');}return r;
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
  const manifest={ok:true,version:1,layout:'reference-raw-above-annotated',records:records.map(v=>({path:v.path,fingerprint:referenceFingerprint(v.r)})),pages,evidence,legend:'左绿右橙；实线=两端可见，虚线/空心点=遮挡推测，未知点不连线。左右按角色自身定义。',warnings:records.flatMap(({r})=>referenceRoles.filter(k=>r.observation.points[k].visibility!=='visible').map(k=>`${r.id}: ${k} ${r.observation.points[k].visibility}`))};const manifestPath=`${dir}/reference-pose-sheet.json`;await saveJson(manifestPath,manifest,c);return {...manifest,manifestPath};
}
export async function reviewReferencePose(a:any,c:ToolContext={}) {
  const r=await requireReferencePose(a.referencePosePath,c,false),m=await read(a.manifestPath,c);
  if(!m.records?.some((v:any)=>v.path===a.referencePosePath&&v.fingerprint===referenceFingerprint(r)))throw new Error('图像不包含当前参考标注。');
  if(!['approved','rejected'].includes(a.decision)||!a.reason?.trim()||!a.reviewedBy?.trim()||referenceChecks.some(k=>!a.checks?.includes(k))||a.decision==='approved'&&a.issues?.length)throw new Error('需完整参考审查项、确认者、理由及已解决的问题。');
  if(a.decision==='approved'&&r.observation.actionSemantics&&r.observation.actionSemantics.identityStatus!=='confirmed')throw new Error('持杖解剖身份尚未连续校准，不能批准参考。');
  for(const e of m.evidence??[])if(await hashFile(e.filePath,c)!==e.hash)throw new Error('参考图像证据已改变。');if(!m.evidence?.length)throw new Error('缺少参考图像证据。');
  r.review={decision:a.decision,reason:a.reason,reviewedBy:a.reviewedBy,checks:a.checks,issues:a.issues??[],fingerprint:referenceFingerprint(r),evidence:[...m.evidence,{filePath:a.manifestPath,hash:await hashFile(a.manifestPath,c)}],at:new Date().toISOString()};r.status=a.decision==='approved'?'confirmed':'rejected';if(a.dryRun===false)await saveJson(a.referencePosePath,r,c);return {ok:true,dryRun:a.dryRun??true,review:r.review};
}
