import {withStrict} from './runtimeCache.js';
import {visualRigFingerprint} from './domainFingerprints.js';
export {visualRigFingerprint} from './domainFingerprints.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { MeshAttachment, RegionAttachment } from '@esotericsoftware/spine-core';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { hashObject, saveJson } from './mappingTools.js';
import { worldVertices } from './motionRuntime.js';
import { referenceRoles } from './referencePose.js';
import { graphEdges, limbNodes } from './poseGraph.js';
import {torsoAxis} from './poseGraph.js';
import { loadAtlasImages, rasterFrame } from './rasterRenderer.js';
import { validateActionRig } from './actionSemantics.js';

export function visualSummary(data:any){return {...data,attachments:(data.attachments??[]).map((a:any)=>({slot:a.slot,attachment:a.attachment,type:a.type,bone:a.bone,weighted:a.weighted,vertexCount:a.vertices.length/2,influenceBones:[...new Set(a.influences.map((i:any)=>i.bone))]}))};}
const read=async(p:string,c:ToolContext)=>JSON.parse(await readFile(resolveWorkspacePath(p,c),'utf8'));
const evidence=async(p:string,c:ToolContext)=>({filePath:p,hash:hashObject((await readFile(resolveWorkspacePath(p,c))).toString('base64'))});
function applyMappingAttachments(skeleton:any,mapping:any){
 for(const [slot,attachment] of Object.entries(mapping?.bones?.slotAttachments??{})){
  if(attachment===null)skeleton.findSlot(slot)?.setAttachment(null);
  else skeleton.setAttachment(slot,attachment as string);
 }
}
export function attachmentSnapshot(skeleton:any){
 const vertices=worldVertices(skeleton);
 return skeleton.slots.flatMap((slot:any)=>{
  const a:any=slot.getAttachment();
  const isMesh=a instanceof MeshAttachment || (Array.isArray(a?.triangles) && Number.isFinite(a?.worldVerticesLength));
  const isRegion=a instanceof RegionAttachment || (!isMesh && typeof a?.computeWorldVertices==='function');
  if(!isMesh&&!isRegion)return [];
  const influences:any[]=[];
  if(isMesh&&a.bones){let v=0,index=0;for(let i=0;i<a.bones.length;){const count=a.bones[i++];for(let j=0;j<count;j++){const b=skeleton.bones[a.bones[i++]];influences.push({vertex:index,bone:b.data.name,local:[a.vertices[v],a.vertices[v+1]],weight:a.vertices[v+2]});v+=3;}index++;}}
  else influences.push({bone:slot.bone.data.name,weight:1});
  return [{slot:slot.data.name,attachment:a.name,type:isMesh?'mesh':'region',bone:slot.bone.data.name,weighted:isMesh&&!!a.bones,influences,localTransform:isRegion?{x:a.x,y:a.y,rotation:a.rotation,scaleX:a.scaleX,scaleY:a.scaleY}:null,triangles:isMesh?Array.from(a.triangles):[0,1,2,2,3,0],vertices:vertices[slot.data.name+':'+a.name]}];
 });
}
export function readVisualNodes(skeleton:any,rig:any){
 const sampled=sampleVisualPoints(skeleton,rig);
 if(!sampled.available)throw new Error(sampled.unavailableReason??'视觉节点不可用。');
 return {points:Object.fromEntries(Object.entries(sampled.points).map(([role,p]:any)=>[role,{x:p.x,y:p.y,confidence:p.confidence??null,basis:p.basis??null,anchorType:p.anchorType}])),torsoAxis:torsoAxis(sampled.points),attachments:sampled.attachments,edges:graphEdges,segments:rig.segments};
}

/**
 * 按当前 runtime skeleton 采样 visualRig 的视觉点。
 * 与 readVisualNodes 不同，这个函数不会因为一个节点失效而丢弃整帧，
 * 而是为该节点输出 source:'unavailable' 与明确 reason，供逐帧预览和 formal 门禁消费。
 */
export function sampleVisualPoints(skeleton:any,rig:any){
 const points:any={},snapshot=attachmentSnapshot(skeleton),reasons:string[]=[];
 for(const [role,n]of Object.entries(rig?.nodes??{}) as any){
  const base={confidence:n?.confidence??null,basis:n?.basis??null,anchorType:n?.type??null};
  if(n?.type==='boneLocal'){
   const b=skeleton.findBone(n.bone);
   if(!b||!Array.isArray(n.point)||n.point.length!==2||!n.point.every(Number.isFinite)){
    const reason=!b?`骨骼 ${n?.bone??'?'} 不存在`: 'boneLocal point 必须是有限二维坐标';
    points[role]={source:'unavailable',exact:false,reason,...base};reasons.push(`${role}:${reason}`);continue;
   }
   points[role]={x:b.worldX+b.a*n.point[0]+b.b*n.point[1],y:b.worldY+b.c*n.point[0]+b.d*n.point[1],source:'boneLocal',bone:n.bone,localPoint:[n.point[0],n.point[1]],exact:true,...base};
  }else if(n?.type==='meshTriangle'){
   const a=snapshot.find((v:any)=>v.slot===n.slot&&v.attachment===n.attachment);
   const valid=!!a&&a.type==='mesh'&&Number.isInteger(n.triangle)&&n.triangle>=0&&n.triangle*3+2<a.triangles.length&&Array.isArray(n.weights)&&n.weights.length===3&&n.weights.every((w:number)=>Number.isFinite(w)&&w>=0)&&Math.abs(n.weights.reduce((x:number,y:number)=>x+y,0)-1)<=1e-6;
   if(!valid){const reason='meshTriangle 的附件、三角形索引或重心坐标无效';points[role]={source:'unavailable',exact:false,reason,...base};reasons.push(`${role}:${reason}`);continue;}
   const ids=a.triangles.slice(n.triangle*3,n.triangle*3+3);
   points[role]={x:ids.reduce((sum:number,k:number,i:number)=>sum+a.vertices[k*2]*n.weights[i],0),y:ids.reduce((sum:number,k:number,i:number)=>sum+a.vertices[k*2+1]*n.weights[i],0),source:'meshTriangle',slot:n.slot,attachment:n.attachment,triangle:n.triangle,weights:[...n.weights],exact:true,...base};
  }else{const reason='视觉节点类型必须是 boneLocal 或 meshTriangle';points[role]={source:'unavailable',exact:false,reason,...base};reasons.push(`${role}:${reason}`);}
 }
 const unavailableReason=reasons.length?reasons.join('；'):Object.keys(points).length?'': 'visualRig 无可用 nodes';
 return {points,available:Object.keys(points).length>0&&reasons.length===0,unavailableReason:unavailableReason||null,attachments:snapshot,edges:graphEdges,segments:rig?.segments};
}

/**
 * 绑定层的“视觉可用性”审查。
 * confirmed 只说明文件结构和校准证据存在，不能代替检查节点是否仍是
 * 骨骼原点候选、是否有低置信度关键点，或 face 是否真的提供了前脸方向。
 * 统一任务入口在正式求解前调用本审查；失败时停在 binding，而不是把
 * 错误映射继续传给 IK。
 */
export function auditVisualMappingBinding(rig:any,mapping:any){
 const issues:any[]=[],warnings:any[]=[];
 const limbs:any={leftArm:['leftShoulder','leftElbow','leftWrist'],rightArm:['rightShoulder','rightElbow','rightWrist'],leftLeg:['leftHip','leftKnee','leftAnkle'],rightLeg:['rightHip','rightKnee','rightAnkle']};
 for(const [limb,nodes] of Object.entries(limbs) as any){
  const chain=mapping?.bones?.[limb];
  if(!Array.isArray(chain)||chain.length!==3){issues.push({code:'MAPPING_CHAIN_INCOMPLETE',limb,message:`${limb} 缺少三段骨骼链。`});continue;}
  for(let i=0;i<2;i++){
   const id=`${limb}.${i}`,seg=rig?.segments?.[id];
   if(!seg){issues.push({code:'MAPPING_SEGMENT_MISSING',limb,segment:id,message:`visualRig 缺少 ${id}。`});continue;}
   if(JSON.stringify(seg.nodes)!==JSON.stringify(nodes.slice(i,i+2)))issues.push({code:'MAPPING_SEGMENT_NODE_MISMATCH',limb,segment:id,message:`${id} 的节点段与语义链不一致。`});
   if(!Array.isArray(seg.bones)||seg.bones.length===0||seg.bones.some((b:string)=>!chain.includes(b)))issues.push({code:'MAPPING_SEGMENT_BONE_MISMATCH',limb,segment:id,message:`${id} 的骨骼不属于 ${limb} 语义链。`});
   if(i>0){const prev=rig?.segments?.[`${limb}.${i-1}`];const same=JSON.stringify(prev?.attachments??[])===JSON.stringify(seg.attachments??[]);if(same&&Array.isArray(seg.attachments)&&seg.attachments.length)warnings.push({code:'MAPPING_SEGMENT_ATTACHMENT_REUSED',limb,segment:id,message:`${id} 与上一段复用了同一 attachment 声明；若该 attachment 是跨骨骼加权网格需保留，否则应拆分切片。`});}
  }
 }
 const mappingPath=rig?.mappingPath&&mapping?.filePath;if(mappingPath&&String(mappingPath)!==String(rig.mappingPath))issues.push({code:'MAPPING_PATH_MISMATCH',message:`visualRig.mappingPath=${rig.mappingPath} 与当前 mapping=${mappingPath} 不一致。`});
 const anatomical=rig?.anatomicalSides;if(!anatomical?.basis||anatomical.left!=='left'||anatomical.right!=='right')issues.push({code:'MAPPING_ANATOMICAL_SIDE_MISMATCH',message:'mapping/visualRig 未明确固定 anatomical left/right。'});
 return {ok:issues.length===0,issues,warnings};
}

/** 只读 runtime 回读：确认 visualRig 指向的骨骼和 visualPoints 能实际采样。 */
export function auditVisualRigRuntimeBinding(rig:any,skeleton:any){
 const sampled=sampleVisualPoints(skeleton,rig),issues:any[]=[];
 if(!sampled.available)issues.push({code:'MAPPING_RUNTIME_MISMATCH',message:sampled.unavailableReason??'runtime 无法完整采样 visualPoints。'});
 for(const [role,p] of Object.entries(sampled.points??{}) as any){
  if(p?.source==='unavailable')issues.push({code:'MAPPING_RUNTIME_NODE_MISSING',role,message:p.reason??`${role} runtime 节点不可用。`});
 }
 return {ok:issues.length===0,issues,visualPointsAvailable:sampled.available,points:sampled.points};
}

export function auditVisualRigBinding(rig:any,mapping:any){
 const issues:any[]=[];
 const limbRoles=['leftShoulder','leftElbow','leftWrist','rightShoulder','rightElbow','rightWrist','leftHip','leftKnee','leftAnkle','rightHip','rightKnee','rightAnkle'];
 const originOnly=limbRoles.filter(role=>{const n=rig?.nodes?.[role];return n?.type==='boneLocal'&&Array.isArray(n.point)&&n.point.every((v:number)=>Math.abs(v)<=1e-9);});
 if(originOnly.length>0)issues.push({code:'VISUAL_RIG_ORIGIN_ONLY',message:`${originOnly.length} 个四肢视觉节点仍是骨骼原点候选：${originOnly.join('、')}。需依据切片接缝或 meshTriangle 重新校准；adaptive 不能替代视觉关节。`,roles:originOnly});
 const lowConfidence=limbRoles.filter(role=>Number(rig?.nodes?.[role]?.confidence??0)<0.7);
 if(lowConfidence.length)issues.push({code:'VISUAL_RIG_LOW_CONFIDENCE',message:`以下视觉节点置信度低于 0.7：${lowConfidence.join('、')}。它们不能作为正式重定向的可靠关节。`,roles:lowConfidence});
 const face=rig?.nodes?.face;
 const faceBasis=String(face?.basis??'');
 if(!face||face.type!=='meshTriangle'&&(!faceBasis.includes('鼻尖')||faceBasis.includes('不是鼻尖'))){issues.push({code:'FACE_ANCHOR_UNVERIFIED',message:'face 仍是未验证的骨骼/嘴部支点，缺少真正的面部前缘或鼻尖依据；只能诊断，不能确认朝向。'});}
 const sides=rig?.anatomicalSides?.left&&rig?.anatomicalSides?.right&&rig?.anatomicalSides?.basis;
 if(!sides)issues.push({code:'ANATOMICAL_SIDE_BASIS_MISSING',message:'visualRig 缺少解剖左右对应依据。'});
 const segmentIssues:any[]=[];const roleNodes:any={leftArm:['leftShoulder','leftElbow','leftWrist'],rightArm:['rightShoulder','rightElbow','rightWrist'],leftLeg:['leftHip','leftKnee','leftAnkle'],rightLeg:['rightHip','rightKnee','rightAnkle']};
 for(const limb of Object.keys(roleNodes)){const chain=mapping?.bones?.[limb];if(!Array.isArray(chain)||chain.length!==3)segmentIssues.push(`${limb} 链缺少三段骨骼`);for(let i=0;i<2;i++){const seg=rig?.segments?.[`${limb}.${i}`];const expected=roleNodes[limb].slice(i,i+2);if(!seg||JSON.stringify(seg.nodes)!==JSON.stringify(expected))segmentIssues.push(`${limb}.${i} 节点段与语义链不一致`);}}
 if(segmentIssues.length)issues.push({code:'VISUAL_RIG_SEGMENT_BINDING',message:segmentIssues.join('；'),details:segmentIssues});
 const mappingAudit=auditVisualMappingBinding(rig,mapping);
 issues.push(...mappingAudit.issues);
 return {ok:issues.length===0,issues,originOnly,lowConfidence,mappingAudit,warnings:mappingAudit.warnings};
}
export function drawVisualGraph(ctx:any,data:any,project:(x:number,y:number)=>number[],comparison?:any){
 ctx.font='10px sans-serif';ctx.lineWidth=2;
 const axis=torsoAxis(data.points);if(axis){const a=project(axis.hip.x,axis.hip.y),b=project(axis.shoulder.x,axis.shoulder.y);ctx.strokeStyle=comparison?.metrics?.find((m:any)=>m.id==='body.torsoDirection')?.status==='fail'?'#ff4264':'#78d4ff';ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.fillText('Torso',(a[0]+b[0])/2,(a[1]+b[1])/2);ctx.setLineDash([]);}
 // v3 结构辅助线：肩线、髋线、面部朝向；失败项与节点同色变红。
 const failedBy=(id:string)=>comparison?.metrics?.find((m:any)=>m.id===id)?.status==='fail';
 const line=(a:any,b:any,id:string)=>{if(!a||!b)return;ctx.strokeStyle=failedBy(id)?'#ff4264':'#8ea2c9';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(...project(a.x,a.y));ctx.lineTo(...project(b.x,b.y));ctx.stroke();ctx.setLineDash([]);};
 line(data.points.leftShoulder,data.points.rightShoulder,'body.shoulderLine');
 line(data.points.leftHip,data.points.rightHip,'body.hipLine');
 if(data.points.head&&data.points.face){const a=project(data.points.head.x,data.points.head.y),b=project(data.points.face.x,data.points.face.y);ctx.strokeStyle=failedBy('head.orientation')?'#ff4264':'#fff17a';ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=ctx.strokeStyle;ctx.fillText('Face',b[0]+4,b[1]-4);}
 const failed=new Set(comparison?.metrics.filter((m:any)=>m.status!=='pass').flatMap((m:any)=>m.nodes)??[]);
 for(const a of data.attachments??[]){ctx.strokeStyle='#acb6c566';ctx.lineWidth=.7;const boundary=new Map<string,{count:number;ids:number[]}>();for(let i=0;i<a.triangles.length;i+=3){const tri=a.triangles.slice(i,i+3);for(let j=0;j<3;j++){const ids=[tri[j],tri[(j+1)%3]].sort((u:number,v:number)=>u-v),key=ids.join(':');const old=boundary.get(key);boundary.set(key,{ids,count:(old?.count??0)+1});}}ctx.beginPath();for(const e of boundary.values())if(e.count===1){ctx.moveTo(...project(a.vertices[e.ids[0]*2],a.vertices[e.ids[0]*2+1]));ctx.lineTo(...project(a.vertices[e.ids[1]*2],a.vertices[e.ids[1]*2+1]));}ctx.stroke();}
 ctx.lineWidth=2;for(const [id,[a,b]]of graphEdges.entries()){const p=data.points[a],q=data.points[b];if(!p||!q)continue;ctx.strokeStyle=failed.has(a)||failed.has(b)?'#ff4264':a.startsWith('left')?'#65dfab':a.startsWith('right')?'#ffba6b':'#78d4ff';ctx.beginPath();ctx.moveTo(...project(p.x,p.y));ctx.lineTo(...project(q.x,q.y));ctx.stroke();const m=project((p.x+q.x)/2,(p.y+q.y)/2);ctx.fillStyle=ctx.strokeStyle;ctx.fillText('E'+id,m[0],m[1]);}
 for(const [id,p]of Object.entries(data.points) as any){const q=project(p.x,p.y);ctx.fillStyle=failed.has(id)?'#ff4264':'#ffffff';ctx.beginPath();ctx.arc(q[0],q[1],3,0,Math.PI*2);ctx.fill();ctx.fillText(id,q[0]+4,q[1]-4);}
}
export async function requireVisualRig(p:string,c:ToolContext,confirmed=true,prepared?:any){
 const rig=await read(p,c),same=prepared&&resolveWorkspacePath(rig.filePath,c)===resolveWorkspacePath(prepared.filePath,c)&&resolveWorkspacePath(rig.mappingPath,c)===resolveWorkspacePath(prepared.mappingPath,c),s=same?prepared:await (await import('./poseWorkflow.js')).characterFingerprint(rig.filePath,rig.mappingPath,c);
 if(rig.version!==2||rig.sourceFingerprint!==s.fingerprint||rig.skin!==s.mapping.skin)throw new Error(`visualRig 需要 v2（含面部朝向锚点 face）：当前版本 v${rig.version??'?'} 或角色、mapping、skin 已失效，请重新校准并审查。`);
 const skeleton=s.rt.sample(undefined,0,rig.skin);applyMappingAttachments(skeleton,s.mapping);
 const actual=readVisualNodes(skeleton,rig);
 validateActionRig(rig,skeleton);
 validateRig(rig,actual,s.mapping);
 if(confirmed){if(rig.status!=='confirmed'||rig.review?.decision!=='approved'||rig.review.fingerprint!==visualRigFingerprint(rig))throw new Error('visualRig 尚未确认或已改变。');for(const e of rig.review.evidence??[])if((await evidence(e.filePath,c)).hash!==e.hash)throw new Error('visualRig 图像证据已改变。');if(!rig.review.evidence?.length)throw new Error('visualRig 缺少校准图像证据。');}
 return {rig,...s};
}
function validateRig(rig:any,actual:any,mapping:any){
 for(const role of referenceRoles){if(!rig.nodes[role])throw new Error(`visualRig 缺少 ${role}。`);}
 for(const [role,n]of Object.entries(limbNodes))for(let i=0;i<2;i++){
  const id=role+'.'+i,seg=rig.segments[id];if(!seg||hashObject(seg.nodes)!==hashObject(n.slice(i,i+2))||!seg.bones?.length||seg.bones.some((b:string)=>!mapping.bones[role].includes(b)))throw new Error(`线段 ${id} 骨骼链/节点不匹配。`);
  if(!seg.attachments?.length)throw new Error(`线段 ${id} 缺少切片关联。`);
  for(const a of seg.attachments){const found=actual.attachments.find((v:any)=>v.slot===a.slot&&v.attachment===a.attachment);if(!found||!found.influences.some((v:any)=>seg.bones.includes(v.bone)))throw new Error(`线段 ${id} 切片缺失或没有实际骨骼影响。`);}
 }
}
export async function calibrateVisualRig(a:any,c:ToolContext={}){
 const s=await (await import('./poseWorkflow.js')).characterFingerprint(a.filePath,a.mappingPath,c),sk=s.rt.sample(undefined,0,s.mapping.skin);applyMappingAttachments(sk,s.mapping);
 const attachments=attachmentSnapshot(sk),nodes:any={};
 for(const [role,chain]of Object.entries(limbNodes))chain.forEach((node,i)=>nodes[node]={type:'boneLocal',bone:(s.mapping.bones as any)[role][i],point:[0,0],calibrated:false,basis:'仅骨骼原点候选，必须依据切片轮廓校准，不能自动确认。'});
 nodes.body={type:'boneLocal',bone:s.mapping.bones.body,point:[0,0],calibrated:false};nodes.head={type:'boneLocal',bone:s.mapping.bones.head,point:[0,0],calibrated:false};nodes.face={type:'boneLocal',bone:s.mapping.bones.head,point:[0,0],calibrated:false,basis:'面部朝向锚点候选：必须按鼻尖或面部切片校准，头骨原点不能代替。'};Object.assign(nodes,a.nodes??{});
 const segments:any={};for(const [role,n]of Object.entries(limbNodes))for(let i=0;i<2;i++){const bone=(s.mapping.bones as any)[role][i];segments[role+'.'+i]={nodes:n.slice(i,i+2),bones:[bone],attachments:attachments.filter((v:any)=>v.influences.some((w:any)=>w.bone===bone)).map((v:any)=>({slot:v.slot,attachment:v.attachment}))};}Object.assign(segments,a.segments??{});
 const rig={version:2,status:'draft',filePath:a.filePath,mappingPath:a.mappingPath,skin:s.mapping.skin,sourceFingerprint:s.fingerprint,nodes,segments,anatomicalSides:a.anatomicalSides,viewProfiles:a.viewProfiles,torsoAxis:{version:1,method:'shoulderHipCenters',basis:'由已校准左右肩和左右髋计算；不使用头部中心作为躯干方向。'}};
 validateActionRig(rig,sk);
 const actual=readVisualNodes(sk,rig),issues:string[]=[];try{validateRig(rig,actual,s.mapping);}catch(e){issues.push(String(e));}
 for(const [k,v]of Object.entries(nodes) as any)if(v.calibrated!==true||!v.basis?.trim())issues.push(`${k} 尚未视觉校准。`);
 const all=attachments.flatMap((v:any)=>v.vertices),xs=all.filter((_:any,i:number)=>i%2===0),ys=all.filter((_:any,i:number)=>i%2===1);const bounds={minX:Math.min(-1,...xs)-5,maxX:Math.max(1,...xs)+5,minY:Math.min(-1,...ys)-5,maxY:Math.max(1,...ys)+5};
 const w=420,h=420,images=await loadAtlasImages(s.rt.atlas,s.mapping.atlasPath!,c),scale=Math.min(w/(bounds.maxX-bounds.minX),h/(bounds.maxY-bounds.minY));const project=(x:number,y:number)=>[w/2+(x-(bounds.minX+bounds.maxX)/2)*scale,h/2-(y-(bounds.minY+bounds.maxY)/2)*scale];
 const image=rasterFrame(sk,images,bounds,w,h,'#20242b'),overlay=createCanvas(w,h),ctx=overlay.getContext('2d');ctx.drawImage(image,0,0);drawVisualGraph(ctx,actual,project);
 const dir=a.outputDir??a.visualRigPath.replace(/\.json$/,'-calibration'),report={version:1,ok:!issues.length,fingerprint:visualRigFingerprint(rig),issues,actual,bounds,paths:[`${dir}/character.png`,`${dir}/nodes.png`,`${dir}/slices.png`]};
 if(a.dryRun===false){try{await readFile(resolveWorkspacePath(a.visualRigPath,c));throw new Error('visualRig 已存在，请使用新修订路径。');}catch(e:any){if(e.code!=='ENOENT')throw e;}await mkdir(resolveWorkspacePath(dir,c),{recursive:true});await writeFile(resolveWorkspacePath(report.paths[0],c),image.toBuffer('image/png'));await writeFile(resolveWorkspacePath(report.paths[1],c),overlay.toBuffer('image/png'));
  const cols=4,rows=Math.max(1,Math.ceil(attachments.length/cols)),sheet=createCanvas(w*cols,h*rows),sx=sheet.getContext('2d');const saved=sk.slots.map(slot=>slot.getAttachment());
  for(let i=0;i<attachments.length;i++){sk.slots.forEach((slot,j)=>slot.setAttachment(slot.data.name===attachments[i].slot?saved[j]:null));sx.drawImage(rasterFrame(sk,images,bounds,w,h,'#20242b'),i%cols*w,Math.floor(i/cols)*h);sx.fillStyle='white';sx.font='14px sans-serif';sx.fillText(attachments[i].slot+'/'+attachments[i].attachment,i%cols*w+5,Math.floor(i/cols)*h+18);const owners=Object.entries(segments).filter(([,seg]:any)=>seg.attachments.some((v:any)=>v.slot===attachments[i].slot&&v.attachment===attachments[i].attachment)).map(([key])=>key);sx.fillText(owners.join(', ')||'非四肢附件',i%cols*w+5,Math.floor(i/cols)*h+38);}sk.slots.forEach((slot,j)=>slot.setAttachment(saved[j]));await writeFile(resolveWorkspacePath(report.paths[2],c),sheet.toBuffer('image/png'));
  const manifestPath=`${dir}/visual-rig-calibration.json`;await saveJson(manifestPath,{...report,evidence:await Promise.all(report.paths.map(p=>evidence(p,c)))},c);await saveJson(a.visualRigPath,{...rig,manifestPath},c);return {...report,actual:a.detailed?actual:visualSummary(actual),dryRun:false,visualRigPath:a.visualRigPath,manifestPath};}
 return {...report,actual:a.detailed?actual:visualSummary(actual),dryRun:true,rig};
}
export async function reviewVisualRig(a:any,c:ToolContext={}){
 return withStrict(async()=>{

 const {rig}=await requireVisualRig(a.visualRigPath,c,false),m=await read(rig.manifestPath,c);
 if(!a.reason?.trim()||!a.reviewedBy?.trim()||!['approved','rejected'].includes(a.decision))throw new Error('绑定审查需明确决定、确认者和依据。');
 if(a.decision==='approved'&&(!m.ok||m.fingerprint!==visualRigFingerprint(rig)||Object.values(rig.nodes).some((n:any)=>n.calibrated!==true||!n.basis?.trim())))throw new Error('未校准的骨骼原点候选或过期绑定不能批准。');
 if(!m.evidence?.length)throw new Error('缺少绑定证据。');for(const e of m.evidence)if((await evidence(e.filePath,c)).hash!==e.hash)throw new Error('校准证据已改变。');
 rig.review={decision:a.decision,reviewedBy:a.reviewedBy,reason:a.reason,fingerprint:visualRigFingerprint(rig),evidence:[...m.evidence,await evidence(rig.manifestPath,c)],at:new Date().toISOString()};rig.status=a.decision==='approved'?'confirmed':'rejected';if(a.dryRun===false)await saveJson(a.visualRigPath,rig,c);return {ok:true,dryRun:a.dryRun??true,review:rig.review};

 });
}
