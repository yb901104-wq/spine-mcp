import { hashObject } from './mappingTools.js';
import { compareActionSemantics, compareDepth } from './actionSemantics.js';

export type GraphPoint = {x:number;y:number;confidence?:number;visibility?:string};
export const limbNodes:Record<string,string[]> = Object.fromEntries(['left','right'].flatMap(s=>[[s+'Arm',[s+'Shoulder',s+'Elbow',s+'Wrist']],[s+'Leg',[s+'Hip',s+'Knee',s+'Ankle']]]));
export const graphEdges = [['head','body'], ...Object.values(limbNodes).flatMap(n=>[[n[0],n[1]],[n[1],n[2]]])];
// 版本升级才可变更；MCP 不接受调用时门限覆盖。
// v3 增加肩髋线、轮廓宽度、朝向幅度、肢体相对躯干与头部朝向；长度统一以躯干长归一。
export const comparisonPolicy = Object.freeze({version:3,directionDegrees:15,flexionDegrees:15,stance:0.15,wrist:0.15,grip:0.15,extensionNeutral:0.15,bendNeutralDegrees:2,lineDegrees:12,twistDegrees:12,silhouetteWidth:0.15,facingRatio:0.25,reach:0.15,torsoHeight:0.12,torsoOffset:0.15,footOffset:0.2,headGap:0.2,headDegrees:18,headBandDegrees:[20,60]});
export const policyFingerprint = hashObject(comparisonPolicy);
// 只绑定判据本身：文案、uncertainties 或非判据字段变化不应让历史报告整体失效。
export const comparisonFingerprint=(r:any)=>hashObject({version:r?.version,policyFingerprint:r?.policyFingerprint,ok:r?.ok,poseFingerprint:r?.poseFingerprint,referenceFingerprint:r?.referenceFingerprint,visualRigFingerprint:r?.visualRigFingerprint,sequenceFingerprint:r?.sequenceFingerprint,metrics:(r?.metrics??[]).map((m:any)=>[m.id,m.required,m.status,m.error])});
export function finitePoint(p:any):p is GraphPoint {return !!p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.visibility!=='unknown';}
export const distance=(a:GraphPoint,b:GraphPoint)=>Math.hypot(a.x-b.x,a.y-b.y);
export const direction=(a:GraphPoint,b:GraphPoint)=>Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
export const angleError=(a:number,b:number)=>Math.abs(((a-b+540)%360+360)%360-180);
export const signedAngle=(a:number,b:number)=>((b-a+540)%360+360)%360-180;
export function torsoAxis(p:Record<string,GraphPoint>){const keys=['leftShoulder','rightShoulder','leftHip','rightHip'];if(!keys.every(k=>finitePoint(p[k])))return null;return {hip:{x:(p.leftHip.x+p.rightHip.x)/2,y:(p.leftHip.y+p.rightHip.y)/2},shoulder:{x:(p.leftShoulder.x+p.rightShoulder.x)/2,y:(p.leftShoulder.y+p.rightShoulder.y)/2}};}
// 无向线：肩线、髋线、握轴的 180° 等价；只看差的绝对值，不引入方向假设。
export const lineError=(a:number,b:number)=>Math.min(angleError(a,b),180-angleError(a,b));
export type TorsoFrame={hip:GraphPoint;shoulder:GraphPoint;u:GraphPoint;length:number};
// 躯干局部坐标：u=髋→肩。长度一律以躯干长归一，避免用各自臂长把比例差吸收掉。
// 前向固定取规范化后的 +x：两侧归一化后面朝 +x，因此不依赖躯干倾斜，也不会在镜像时翻符号。
export function torsoFrame(points:Record<string,GraphPoint>):TorsoFrame|null{
 const axis=torsoAxis(points);if(!axis)return null;
 const dx=axis.shoulder.x-axis.hip.x,dy=axis.shoulder.y-axis.hip.y,L=Math.hypot(dx,dy);
 if(!(L>1e-8))return null;
 return {hip:axis.hip,shoulder:axis.shoulder,u:{x:dx/L,y:dy/L},length:L};
}
// A=沿躯干轴的高度（0=髋线，1=肩线）；N=到髋中心的水平前向偏移（>0 面向前方）。
export function torsoCoordinate(f:TorsoFrame,p:GraphPoint){
 const dx=p.x-f.hip.x,dy=p.y-f.hip.y;
 return {a:(dx*f.u.x+dy*f.u.y)/f.length,n:dx/f.length};
}
// 头部朝向只认面部锚点：头身中心连线是位置关系，不是头部朝向。
export function headFacingTurn(points:Record<string,GraphPoint>){
 const head=points.head,face=points.face;
 if(!finitePoint(head)||!finitePoint(face))return null;
 return signedAngle(0,direction(head,face));
}
export function headBandOf(turn:number){
 const [forward,sharp]=comparisonPolicy.headBandDegrees as unknown as [number,number],a=Math.abs(turn);
 return a<=forward?'forward':a<=sharp?'turned':'sharp';
}
// 图像坐标统一按 normalizedGraph(image=true) 的同一规则镜像，禁止出现第二套符号约定。
export function normalizeImagePoints(points:Record<string,GraphPoint>,facing:string){
 if(!['left','right'].includes(facing))throw new Error('骨架必须明确朝向。');
 return Object.fromEntries(Object.entries(points).map(([k,p])=>[k,{...p,x:p.x*(facing==='left'?-1:1),y:-p.y}]));
}
export function flexion(a:GraphPoint,b:GraphPoint,c:GraphPoint){return angleError(direction(a,b),direction(b,c));}
export function normalizedGraph(points:Record<string,GraphPoint>,facing:string,image=false){
 if(!['left','right'].includes(facing))throw new Error('骨架必须明确朝向。');
 return Object.fromEntries(Object.entries(points).map(([k,p])=>[k,{...p,x:p.x*(facing==='left'?-1:1),y:p.y*(image?-1:1)}]));
}
export function validateCorrespondence(v:any){
 if(!v?.basis?.trim()||!['left','right'].includes(v.left)||!['left','right'].includes(v.right)||v.left===v.right||!v.anatomicalIdentity?.trim()||!v.projectedOrder?.trim())throw new Error('必须明确左右对应、解剖身份、画面前后关系及依据，禁止自动交换。');
}
export function compareGraphs(reference:any,target:any,correspondence:any){
 validateCorrespondence(correspondence);
 const r=normalizedGraph(reference.points,reference.facing,true),t=normalizedGraph(target.points,target.facing);
 const metrics:any[]=compareActionSemantics(reference,target,correspondence);
 const add=(id:string,nodes:string[],rv:any,tv:any,error:number|null,tolerance:number|null,extra:any={})=>metrics.push({id,nodes,reference:rv,target:tv,error,tolerance,required:true,status:error===null||!Number.isFinite(error)?'unverifiable':error<=(tolerance??0)+1e-8?'pass':'fail',...extra});
 const len=(p:any,n:string[])=>n.every(k=>finitePoint(p[k]))?distance(p[n[0]],p[n[1]])+distance(p[n[1]],p[n[2]]):NaN;
 const mapped:Record<string,GraphPoint>={};
 const ra=torsoAxis(r),ta=torsoAxis(t),axisKnown=ra&&ta&&distance(ra.hip,ra.shoulder)>1e-8&&distance(ta.hip,ta.shoulder)>1e-8;
 add('body.torsoDirection',['leftHip','rightHip','leftShoulder','rightShoulder'],axisKnown?direction(ra.hip,ra.shoulder):null,axisKnown?direction(ta.hip,ta.shoulder):null,axisKnown?angleError(direction(ra.hip,ra.shoulder),direction(ta.hip,ta.shoulder)):null,comparisonPolicy.directionDegrees);
 const bodyKnown=['body','head'].every(k=>finitePoint(r[k])&&finitePoint(t[k]))&&distance(r.body,r.head)>1e-8&&distance(t.body,t.head)>1e-8;
 add('body.headDirection',['body','head'],bodyKnown?direction(r.body,r.head):null,bodyKnown?direction(t.body,t.head):null,bodyKnown?angleError(direction(r.body,r.head),direction(t.body,t.head)):null,comparisonPolicy.directionDegrees,{required:false,diagnostic:'头身中心位置连线不是躯干轴，也不是头部自身朝向；仅保留旧报告诊断。'});
 for(const side of ['left','right'])for(const suffix of ['Shoulder','Elbow','Wrist','Hip','Knee','Ankle'])mapped[side+suffix]=r[correspondence[side]+suffix];
 // ── v3 结构指标：肩线/髋线、轮廓宽度、头部朝向、肢体相对躯干。长度一律以躯干长归一。
 const rf=torsoFrame(r),tf=torsoFrame(t);
 const lineOf=(p:any,a:string,b:string)=>finitePoint(p[a])&&finitePoint(p[b])?direction(p[a],p[b]):null;
 const rSh=lineOf(r,'leftShoulder','rightShoulder'),tSh=lineOf(t,'leftShoulder','rightShoulder');
 add('body.shoulderLine',['leftShoulder','rightShoulder'],rSh,tSh,rSh!==null&&tSh!==null?lineError(rSh,tSh):null,comparisonPolicy.lineDegrees);
 const rHl=lineOf(r,'leftHip','rightHip'),tHl=lineOf(t,'leftHip','rightHip');
 add('body.hipLine',['leftHip','rightHip'],rHl,tHl,rHl!==null&&tHl!==null?lineError(rHl,tHl):null,comparisonPolicy.lineDegrees);
 // 肩线与髋线的夹角即躯干扭转：两线同向 0°，拧腰时增大；不能用总误差抵消。
 const rTwist=rSh!==null&&rHl!==null?signedAngle(rHl,rSh):null,tTwist=tSh!==null&&tHl!==null?signedAngle(tHl,tSh):null;
 add('body.twist',['leftShoulder','rightShoulder','leftHip','rightHip'],rTwist,tTwist,rTwist!==null&&tTwist!==null?Math.abs(signedAngle(rTwist,tTwist)):null,comparisonPolicy.twistDegrees);
 // 轮廓宽度：参考用同高度的可见外缘，目标用躯干切片顶点带内极值；这是「投影缩短」的可测形式。
 const refBand=(band:'shoulder'|'hip')=>{const sil=reference.silhouette;if(!sil||!rf)return null;const L=sil[band]?.left,R=sil[band]?.right;if(!finitePoint(L)||!finitePoint(R))return null;return Math.abs(torsoCoordinate(rf,L).n-torsoCoordinate(rf,R).n);};
 const runBand=(lo:number,hi:number)=>{if(!tf)return null;const slots=target.actionState?.torsoSlots??[];if(!slots.length)return null;let min=Infinity,max=-Infinity,n=0;for(const a of target.attachments??[]){if(!slots.includes(a.slot))continue;for(let i=0;i<a.vertices.length;i+=2){const q=torsoCoordinate(tf,{x:a.vertices[i],y:a.vertices[i+1]});if(q.a<lo||q.a>hi)continue;min=Math.min(min,q.n);max=Math.max(max,q.n);n++;}}return n>1?max-min:null;};
 const rShW=refBand('shoulder'),rHpW=refBand('hip'),tShW=runBand(.85,1.15),tHpW=runBand(-.15,.15);
 // 绝对宽度同时编码体型与偏航：跨角色重定向时不能当姿态门禁，只作诊断；轮廓内外判定仍必要。
 const silhouetteNote={required:false,diagnostic:'绝对轮廓宽度含体型差异（chibi 与正常比例躯干长不同），只作诊断；姿态判定用 wristOutsideTorso 等各用自身轮廓的指标。'};
 add('body.shoulderSilhouette',['leftShoulder','rightShoulder'],rShW,tShW,rShW!==null&&tShW!==null?Math.abs(rShW-tShW):null,comparisonPolicy.silhouetteWidth,silhouetteNote);
 add('body.hipSilhouette',['leftHip','rightHip'],rHpW,tHpW,rHpW!==null&&tHpW!==null?Math.abs(rHpW-tHpW):null,comparisonPolicy.silhouetteWidth,silhouetteNote);
 // 头部朝向只认面部锚点；档位在连续角噪声大时兜底。
 // 参考取面部前缘，目标侧目前只能用嘴部支点，语义不等价，先降为诊断。
 const headNote={required:false,diagnostic:'参考锚点是面部前缘（鼻唇区），目标侧 zui 为嘴部旋转支点，两者语义不等价；等 visualRig 支持头部切片前缘锚点后再升级为必要项。'};
 const rTurn=headFacingTurn(r),tTurn=headFacingTurn(t);
 add('head.orientation',['head','face'],rTurn,tTurn,rTurn!==null&&tTurn!==null?Math.abs(signedAngle(rTurn,tTurn)):null,comparisonPolicy.headDegrees,{...headNote,referenceAmplitude:rTurn===null?null:Math.min(1,Math.abs(rTurn)/90),targetAmplitude:tTurn===null?null:Math.min(1,Math.abs(tTurn)/90),declaredBand:reference.orientation?.band??null,declaredAmplitude:reference.orientation?.amplitude??null});
 const rBand=rTurn===null?null:headBandOf(rTurn),tBand=tTurn===null?null:headBandOf(tTurn);
 add('head.turnBand',['head','face'],rBand,tBand,rBand&&tBand?Number(rBand!==tBand):null,0,{...headNote,declaredBand:reference.orientation?.band??null});
 // 肢体相对躯干轮廓：外伸/贴身、腕高、前后偏置、与头部间隙。
 const rHalf=(b:'shoulder'|'hip')=>{const w=b==='shoulder'?rShW:rHpW;return w===null?null:w/2;};
 const tHalf=(b:'shoulder'|'hip')=>{const w=b==='shoulder'?tShW:tHpW;return w===null?null:w/2;};
 const outside=(f:TorsoFrame|null,half:(b:'shoulder'|'hip')=>number|null,p:GraphPoint)=>{
  if(!f||!finitePoint(p))return null;const c=torsoCoordinate(f,p),hs=half('shoulder'),hh=half('hip');
  if(hs===null||hh===null)return null;const t=Math.min(1,Math.max(0,c.a));
  return Math.abs(c.n)>hh+(hs-hh)*t;
 };
 for(const side of ['left','right']){
  const W=mapped[side+'Wrist'],S=mapped[side+'Shoulder'],TW=t[side+'Wrist'],TS=t[side+'Shoulder'];
  const ok=!!rf&&!!tf&&finitePoint(W)&&finitePoint(S)&&finitePoint(TW)&&finitePoint(TS);
  const rr=ok?distance(W,S)/rf!.length:null,tr=ok?distance(TW,TS)/tf!.length:null;
  add(`arm.${side}.wristReach`,[side+'Shoulder',side+'Wrist'],rr,tr,rr!==null&&tr!==null?Math.abs(rr-tr):null,comparisonPolicy.reach);
  const rc=ok?torsoCoordinate(rf!,W):null,tc=ok?torsoCoordinate(tf!,TW):null;
  add(`arm.${side}.wristTorsoHeight`,[side+'Wrist'],rc?.a??null,tc?.a??null,rc&&tc?Math.abs(rc.a-tc.a):null,comparisonPolicy.torsoHeight);
  add(`arm.${side}.wristTorsoOffset`,[side+'Wrist'],rc?.n??null,tc?.n??null,rc&&tc?Math.abs(rc.n-tc.n):null,comparisonPolicy.torsoOffset);
  const ro=outside(rf,rHalf,W),to=outside(tf,tHalf,TW);
  add(`arm.${side}.wristOutsideTorso`,[side+'Wrist'],ro,to,ro!==null&&to!==null?Number(ro!==to):null,0);
  const rg=rf&&finitePoint(W)&&finitePoint(r.head)?distance(W,r.head)/rf.length:null;
  const tg=tf&&finitePoint(TW)&&finitePoint(t.head)?distance(TW,t.head)/tf.length:null;
  add(`arm.${side}.wristHeadGap`,[side+'Wrist','head'],rg,tg,rg!==null&&tg!==null?Math.abs(rg-tg):null,comparisonPolicy.headGap);
 }
 // 踝永远在髋线以下，「是否在躯干矩形内」对踝是空断言，只做侧向前后偏置。
 for(const side of ['left','right']){
  const A=mapped[side+'Ankle'],TA=t[side+'Ankle'];
  const rc=rf&&finitePoint(A)?torsoCoordinate(rf,A):null,tc=tf&&finitePoint(TA)?torsoCoordinate(tf,TA):null;
  add(`leg.${side}.ankleTorsoOffset`,[side+'Ankle'],rc?.n??null,tc?.n??null,rc&&tc?Math.abs(rc.n-tc.n):null,comparisonPolicy.footOffset);
 }
 for(const [role,n]of Object.entries(limbNodes)){
  const valid=n.every(k=>finitePoint(mapped[k])&&finitePoint(t[k]))&&len(mapped,n)>1e-8&&len(t,n)>1e-8;
  for(let i=0;i<2;i++){const rv=valid?direction(mapped[n[i]],mapped[n[i+1]]):null,tv=valid?direction(t[n[i]],t[n[i+1]]):null;add(role+'.segment'+i,n.slice(i,i+2),rv,tv,valid?angleError(rv!,tv!):null,comparisonPolicy.directionDegrees);}
  add(role+'.flexion',n,valid?flexion(...n.map(k=>mapped[k]) as [GraphPoint,GraphPoint,GraphPoint]):null,valid?flexion(...n.map(k=>t[k]) as [GraphPoint,GraphPoint,GraphPoint]):null,valid?Math.abs(flexion(...n.map(k=>mapped[k]) as [GraphPoint,GraphPoint,GraphPoint])-flexion(...n.map(k=>t[k]) as [GraphPoint,GraphPoint,GraphPoint])):null,comparisonPolicy.flexionDegrees);
  const bend=(p:any)=>{const turn=signedAngle(direction(p[n[0]],p[n[1]]),direction(p[n[1]],p[n[2]]));return Math.abs(turn)<=comparisonPolicy.bendNeutralDegrees?'straight':turn>0?'positive':'negative';};
  // 近直线参考的弯曲侧不可辨识，仍由屈曲门限检查，禁止伪造一个分支。
  const rb=valid?bend(mapped):null,tb=valid?bend(t):null;
  add(role+'.bendSide',n,rb,tb,valid?Number(rb!=='straight'&&tb!==rb):null,0);
  if(role.endsWith('Arm')){
   const rv=valid?[(mapped[n[2]].x-mapped[n[0]].x)/len(mapped,n),(mapped[n[2]].y-mapped[n[0]].y)/len(mapped,n)]:null,tv=valid?[(t[n[2]].x-t[n[0]].x)/len(t,n),(t[n[2]].y-t[n[0]].y)/len(t,n)]:null;
   add(role+'.wrist',n,rv,tv,rv&&tv?Math.hypot(rv[0]-tv[0],rv[1]-tv[1]):null,comparisonPolicy.wrist);
   const extension=(v:number)=>Math.abs(v)<comparisonPolicy.extensionNeutral?'neutral':v>0?'forward':'backward';
   add(role+'.extension',n,rv?extension(rv[0]):null,tv?extension(tv[0]):null,rv&&tv?Number(extension(rv[0])!==extension(tv[0])):null,0);
  }
 }
 const mean=(p:any,part:string)=>(len(p,limbNodes['left'+part])+len(p,limbNodes['right'+part]))/2;
 const spread=(p:any)=>finitePoint(p.leftAnkle)&&finitePoint(p.rightAnkle)?Math.abs(p.leftAnkle.x-p.rightAnkle.x)/mean(p,'Leg'):NaN;
 const rs=spread(mapped),ts=spread(t);add('stance.width',['leftAnkle','rightAnkle'],rs,ts,Math.abs(rs-ts),comparisonPolicy.stance);
 const order=(p:any)=>{const d=(p.leftAnkle.x-p.rightAnkle.x)/mean(p,'Leg');return Math.abs(d)<.05?'aligned':d>0?'leftAhead':'rightAhead';};
 add('stance.order',['leftAnkle','rightAnkle'],Number.isFinite(rs)?order(mapped):null,Number.isFinite(ts)?order(t):null,Number.isFinite(rs)&&Number.isFinite(ts)?Number(order(mapped)!==order(t)):null,0);
 // 分腿/并腿由节点导出；不能以手部低误差抵消站距错误。
 add('stance.relation',['leftAnkle','rightAnkle'],rs>=.35?'spread':'close',ts>=.35?'spread':'close',Number.isFinite(rs)&&Number.isFinite(ts)?Number((rs>=.35)!==(ts>=.35)):null,0);
 for(const side of ['left','right']){
  const rs=reference.support?.[correspondence[side]],ts=target.support?.[side];add(side+'.support',[side+'Ankle'],rs??null,ts??null,typeof rs==='boolean'&&typeof ts==='boolean'?Number(rs!==ts):null,0);
  if(reference.relations?.frontGrip===true){const a=mapped[side+'Wrist'],b=mapped[side+'Shoulder'],u=t[side+'Wrist'],v=t[side+'Shoulder'];const valid=[a,b,u,v].every(finitePoint);add(side+'.frontGrip',[side+'Shoulder',side+'Wrist'],valid?a.x>b.x:null,valid?u.x>v.x:null,valid?Number(a.x<=b.x||u.x<=v.x):null,0);}
 }
 if(reference.grip){
  const rp=reference.grip.points, tp=target.grip?.points;
  const rv=rp&&finitePoint(rp.left)&&finitePoint(rp.right)?distance(rp.left,rp.right)/mean(mapped,'Arm'):NaN;
  const tv=tp&&finitePoint(tp.left)&&finitePoint(tp.right)?distance(tp.left,tp.right)/mean(t,'Arm'):NaN;
  add('grip.spacing',['leftWrist','rightWrist'],rv,tv,Math.abs(rv-tv),comparisonPolicy.grip);
  // 握轴方向一律从两点现算，不再依赖存储的 angle 标量（那是有向角被当成无向轴存，基准不明）。
  // 参考握点是图像坐标，必须与 normalizedGraph 同规则翻转 y；目标点已是世界坐标，只按 facing 镜像 x。
  const mirrored=(p:any,f:string)=>({x:p.x*(f==='left'?-1:1),y:p.y});
  const rgl=rp&&finitePoint(rp.left)&&finitePoint(rp.right)?normalizeImagePoints({left:rp.left,right:rp.right},reference.facing) as any:null;
  const tgl=tp&&finitePoint(tp.left)&&finitePoint(tp.right)?{left:mirrored(tp.left,target.facing??reference.facing),right:mirrored(tp.right,target.facing??reference.facing)}:null;
  const rd=rgl?direction(rgl.left,rgl.right):null,td=tgl?direction(tgl.left,tgl.right):null,e=rd!==null&&td!==null?angleError(rd,td):null;
  add('grip.direction',['leftWrist','rightWrist'],rd,td,e===null?null:Math.min(e,180-e),comparisonPolicy.directionDegrees,{axis:'undirected',declaredAngle:reference.grip.angle??null});
 }
 // 前后层序：参考声明 + 目标 drawOrder 回读；尺度推断不可自动验证。
 metrics.push(...compareDepth(reference,target));
 for(const m of metrics){m.targetNodes=m.nodes;m.referenceNodes=m.nodes.map((k:string)=>k.startsWith('left')?correspondence.left+k.slice(4):k.startsWith('right')?correspondence.right+k.slice(5):k);}
 return {version:3,ok:metrics.filter(m=>m.required).every(m=>m.status==='pass'),policy:comparisonPolicy,policyFingerprint,metrics,uncertainties:Object.entries(reference.points).filter(([,p]:any)=>p.visibility!=='visible'||p.confidence<.7).map(([node,p]:any)=>({node,visibility:p.visibility,confidence:p.confidence,basis:p.basis})),message:'必要指标独立判定；未知必要点、退回及超差阻止确认。头身中心连线仅用于旧数据诊断。'};
}
