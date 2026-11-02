/** 图像部件观测：误差由标注者以像素显式给出，confidence 不转成误差半径。 */
export const partNodes:Record<string,[string,string]> = Object.fromEntries(['left','right'].flatMap(side => [
  [`${side}Arm.0`,[`${side}Shoulder`,`${side}Elbow`]], [`${side}Arm.1`,[`${side}Elbow`,`${side}Wrist`]],
  [`${side}Leg.0`,[`${side}Hip`,`${side}Knee`]], [`${side}Leg.1`,[`${side}Knee`,`${side}Ankle`]],
])) as Record<string,[string,string]>;
const finite = (p:any) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const axisError=(a:number,b:number)=>Math.abs(((a-b+270)%180+180)%180-90);
export const referencePartsPolicyVersion=2;
export function validateReferenceParts(r:any) {
  for(const [id,p] of Object.entries(r.points??{}) as any)if(p.uncertaintyRadius!==undefined&&(!Number.isFinite(p.uncertaintyRadius)||p.uncertaintyRadius<0||p.visibility==='unknown'))throw new Error(`${id} 的误差半径需非负有限像素数，未知点不能附半径。`);
  if(r.parts===undefined)return;
  if(!r.parts||Array.isArray(r.parts)||Object.keys(r.parts).length<1||Object.keys(r.parts).length>8)throw new Error('parts 需 1–8 个规范部件。');
  for(const [id,p] of Object.entries(r.parts) as any){
    if(!Object.hasOwn(partNodes,id)||!p||Object.keys(p).some(k=>!['source','outline','radius','basis'].includes(k))||!['rigidSlice','clothing','unknown'].includes(p.source)||typeof p.basis!=='string'||!p.basis.trim())throw new Error(`部件 ${id} 需规范身份、source 与具体轮廓依据。`);
    if(p.outline!==undefined&&(!Array.isArray(p.outline)||p.outline.length<4||p.outline.length>128||p.outline.some((v:any)=>!finite(v)||Object.keys(v).some(k=>!['x','y'].includes(k)))))throw new Error(`${id} outline 需按边界顺序的 4–128 个有限图像点。`);
    if(p.radius!==undefined&&(!Number.isFinite(p.radius)||p.radius<0))throw new Error(`${id} radius 需非负有限像素数。`);
  }
}
/** 等弧长采样避免轮廓某一侧点密度改变主轴；主轴仍可能因衣服/遮挡失真。 */
export function outlineAxis(outline:Array<{x:number;y:number}>,radius:number) {
  if(!Array.isArray(outline)||outline.length<3||!outline.every(finite)||!Number.isFinite(radius)||radius<0)return null;
  const area=outline.reduce((sum,p,i)=>{const q=outline[(i+1)%outline.length];return sum+p.x*q.y-p.y*q.x;},0);
  if(Math.abs(area)<=1e-8)return null;
  const edges=outline.map((p,i)=>({p,q:outline[(i+1)%outline.length],length:Math.hypot(p.x-outline[(i+1)%outline.length].x,p.y-outline[(i+1)%outline.length].y)}));
  const perimeter=edges.reduce((s,e)=>s+e.length,0);if(perimeter<=1e-8)return null;
  const samples=Array.from({length:64},(_,i)=>{let t=i*perimeter/64;for(const e of edges){if(t<=e.length&&e.length>0)return {x:e.p.x+(e.q.x-e.p.x)*t/e.length,y:e.p.y+(e.q.y-e.p.y)*t/e.length};t-=e.length;}return edges[0].p;});
  const center={x:samples.reduce((s,p)=>s+p.x,0)/samples.length,y:samples.reduce((s,p)=>s+p.y,0)/samples.length};
  let xx=0,xy=0,yy=0;for(const p of samples){const x=p.x-center.x,y=p.y-center.y;xx+=x*x/samples.length;xy+=x*y/samples.length;yy+=y*y/samples.length;}
  const gap=Math.hypot(xx-yy,2*xy),total=xx+yy;
  const degrees=Math.atan2(2*xy,xx-yy)*90/Math.PI;
  const extent=Math.max(...samples.map(p=>Math.hypot(p.x-center.x,p.y-center.y)));
  // 居中后每个采样最多移动 2r，以协方差扰动界估算敏感度；不是置信概率。
  const perturbation=4*extent*radius+4*radius*radius;
  const sensitivityDegrees=gap>2*perturbation?Math.asin(Math.min(1,perturbation/(gap-perturbation)))*180/Math.PI:null;
  return {center,degrees,anisotropy:total>1e-10?gap/total:0,sensitivityDegrees,extent,method:'equalArcPCA',uncertaintyKind:'boundedPixelPerturbation'};
}
export function analyzeReferenceParts(r:any) {
  validateReferenceParts(r);
  const parts=Object.entries(r.parts??{}).map(([id,p]:[string,any])=>{
    const nodes=partNodes[id],a=r.points?.[nodes[0]],b=r.points?.[nodes[1]],reasons:string[]=[];
    const length=finite(a)&&finite(b)&&a.visibility!=='unknown'&&b.visibility!=='unknown'?Math.hypot(a.x-b.x,a.y-b.y):null;
    const radii=Number.isFinite(a?.uncertaintyRadius)&&Number.isFinite(b?.uncertaintyRadius)?a.uncertaintyRadius+b.uncertaintyRadius:null;
    const pointHalfAngle=length!==null&&radii!==null&&length>radii?Math.asin(radii/length)*180/Math.PI:null;
    const pointDegrees=length!==null&&length>0?Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI:null;
    const axis=p.outline&&p.radius!==undefined?outlineAxis(p.outline,p.radius):null;
    if(a?.visibility==='unknown'||b?.visibility==='unknown'||pointHalfAngle===null)reasons.push('端点未知、缺少显式误差圆或误差圆重叠，方向不可辨识。');
    if(pointHalfAngle!==null&&pointHalfAngle>15)reasons.push('端点误差传播超过既有 15° 方向预算。');
    if(p.source!=='rigidSlice')reasons.push('未确认刚性身体切片，服装/未知轮廓不能充当身体主轴。');
    if(!axis||axis.anisotropy<.5||axis.sensitivityDegrees===null||axis.sensitivityDegrees>15)reasons.push('轮廓主轴退化、缺失采样误差或对误差过于敏感。');
    const disagreement=axis&&pointDegrees!==null?axisError(axis.degrees,pointDegrees):null;
    if(disagreement!==null&&disagreement>15)reasons.push('轮廓主轴与关节连线相互矛盾，不能自动融合。');
    const contourConflict=p.source==='rigidSlice'&&axis&&axis.anisotropy>=.5&&axis.sensitivityDegrees!==null&&axis.sensitivityDegrees<=15
      &&pointHalfAngle!==null&&pointHalfAngle<=15&&disagreement!==null&&disagreement>15;
    const method=!reasons.length?'contour':contourConflict?'conflict':length!==null&&length>1e-8?'twoPoint':'unavailable';
    const status=method==='contour'?'measurable':method==='twoPoint'?'estimated':method==='conflict'?'conflict':'unverifiable';
    return {id,nodes,status,method,usable:method==='contour'||method==='twoPoint',directionDegrees:method==='contour'||method==='conflict'?axis!.degrees:pointDegrees,
      reliability:method==='contour'?'bounded':method==='twoPoint'?'estimated':'unknown',uncertaintyKnown:method==='contour'||pointHalfAngle!==null,
      reasons,length,pointDegrees,pointHalfAngle,axis,disagreement,basis:p.basis};
  });
  return {version:referencePartsPolicyVersion,ok:parts.length>0&&parts.every(p=>p.usable),status:parts.length?'analyzed':'missing',parts,
    note:'优先可靠刚性轮廓与误差圆；增强观测不可用时回退到两个既有节点的连线，标记 estimated。ok 表示有可用观测，不是动作批准；未知坐标不编造，可靠证据相互冲突仍需复核。'};
}
export function drawReferenceParts(ctx:any,r:any,project:(x:number,y:number)=>number[]) {
  if(!r.parts)return;
  for(const p of Object.values(r.points??{}) as any[]){if(!finite(p)||!Number.isFinite(p.uncertaintyRadius))continue;const a=project(p.x,p.y),b=project(p.x+p.uncertaintyRadius,p.y);ctx.strokeStyle='#ffe07c';ctx.setLineDash([2,2]);ctx.beginPath();ctx.arc(a[0],a[1],Math.hypot(a[0]-b[0],a[1]-b[1]),0,Math.PI*2);ctx.stroke();}
  for(const part of analyzeReferenceParts(r).parts){const p=r.parts[part.id];ctx.strokeStyle=part.method==='contour'?'#cfabff':part.method==='twoPoint'?'#ffe07c':'#ff668a';ctx.setLineDash([3,2]);if(p.outline){ctx.beginPath();p.outline.forEach((v:any,i:number)=>i?ctx.lineTo(...project(v.x,v.y)):ctx.moveTo(...project(v.x,v.y)));ctx.closePath();ctx.stroke();}
    if(part.method==='twoPoint'){const a=r.points[part.nodes[0]],b=r.points[part.nodes[1]];ctx.beginPath();ctx.moveTo(...project(a.x,a.y));ctx.lineTo(...project(b.x,b.y));ctx.stroke();ctx.fillText(part.id+' twoPoint / estimated',...project((a.x+b.x)/2,(a.y+b.y)/2));}
    else if(part.axis){const a=part.axis,t=a.degrees*Math.PI/180;ctx.beginPath();ctx.moveTo(...project(a.center.x-a.extent*Math.cos(t),a.center.y-a.extent*Math.sin(t)));ctx.lineTo(...project(a.center.x+a.extent*Math.cos(t),a.center.y+a.extent*Math.sin(t)));ctx.stroke();ctx.fillText(part.id+' '+part.status,...project(a.center.x,a.center.y));}}
  ctx.setLineDash([]);
}
