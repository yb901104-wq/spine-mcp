import { hashObject } from './mappingTools.js';
import { compareActionSemantics } from './actionSemantics.js';

export type GraphPoint = {x:number;y:number;confidence?:number;visibility?:string};
export const limbNodes:Record<string,string[]> = Object.fromEntries(['left','right'].flatMap(s=>[[s+'Arm',[s+'Shoulder',s+'Elbow',s+'Wrist']],[s+'Leg',[s+'Hip',s+'Knee',s+'Ankle']]]));
export const graphEdges = [['head','body'], ...Object.values(limbNodes).flatMap(n=>[[n[0],n[1]],[n[1],n[2]]])];
// 版本升级才可变更；MCP 不接受调用时门限覆盖。
export const comparisonPolicy = Object.freeze({version:2,directionDegrees:15,flexionDegrees:15,stance:0.15,wrist:0.15,grip:0.15,extensionNeutral:0.15,bendNeutralDegrees:2});
export const policyFingerprint = hashObject(comparisonPolicy);
export function finitePoint(p:any):p is GraphPoint {return !!p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.visibility!=='unknown';}
export const distance=(a:GraphPoint,b:GraphPoint)=>Math.hypot(a.x-b.x,a.y-b.y);
export const direction=(a:GraphPoint,b:GraphPoint)=>Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
export const angleError=(a:number,b:number)=>Math.abs(((a-b+540)%360+360)%360-180);
export const signedAngle=(a:number,b:number)=>((b-a+540)%360+360)%360-180;
export function torsoAxis(p:Record<string,GraphPoint>){const keys=['leftShoulder','rightShoulder','leftHip','rightHip'];if(!keys.every(k=>finitePoint(p[k])))return null;return {hip:{x:(p.leftHip.x+p.rightHip.x)/2,y:(p.leftHip.y+p.rightHip.y)/2},shoulder:{x:(p.leftShoulder.x+p.rightShoulder.x)/2,y:(p.leftShoulder.y+p.rightShoulder.y)/2}};}
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
  if(Number.isFinite(reference.grip.angle)){const rad=reference.grip.angle*Math.PI/180,ra=Math.atan2(-Math.sin(rad),(reference.facing==='left'?-1:1)*Math.cos(rad))*180/Math.PI,ta=target.grip?.angle;const e=Number.isFinite(ta)?angleError(ra,ta):NaN;add('grip.direction',['leftWrist','rightWrist'],ra,ta??null,Number.isFinite(e)?Math.min(e,180-e):null,comparisonPolicy.directionDegrees);}
 }
 for(const m of metrics){m.targetNodes=m.nodes;m.referenceNodes=m.nodes.map((k:string)=>k.startsWith('left')?correspondence.left+k.slice(4):k.startsWith('right')?correspondence.right+k.slice(5):k);}
 return {version:2,ok:metrics.filter(m=>m.required).every(m=>m.status==='pass'),policy:comparisonPolicy,policyFingerprint,metrics,uncertainties:Object.entries(reference.points).filter(([,p]:any)=>p.visibility!=='visible'||p.confidence<.7).map(([node,p]:any)=>({node,visibility:p.visibility,confidence:p.confidence,basis:p.basis})),message:'必要指标独立判定；未知必要点、退回及超差阻止确认。头身中心连线仅用于旧数据诊断。'};
}
