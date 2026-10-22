// 解剖身份与投影位置分开；从已审查切片配置回读身体视角。
export const bodyViews=['frontThreeQuarter','side','backThreeQuarter','sideOrBackThreeQuarter'] as const;
export function validateReferenceAction(a:any) {
 if(!a)return;
 if(a.version!==1||!['left','right'].includes(a.weaponHand)||!bodyViews.includes(a.bodyView)||!a.anatomicalBasis?.trim()||!a.bodyViewBasis?.trim())throw new Error('动作语义需 version:1、持杖解剖手、身体视角及分别说明的依据。');
 if(a.occlusion!==undefined&&(!Array.isArray(a.occlusion)||a.occlusion.some((v:any)=>!v.front?.trim()||!v.back?.trim()||v.front===v.back||!v.basis?.trim())))throw new Error('遮挡关系需 front/back 语义部位和依据。');
}
export function validateActionRig(rig:any,skeleton:any) {
 const a=rig.anatomicalSides;if(a&&(!['left','right'].includes(a.left)||!['left','right'].includes(a.right)||a.left===a.right||!a.basis?.trim()))throw new Error('解剖左右需绑定不同目标链，并提供依据。');
 const signatures=new Map<string,string>();
 for(const p of rig.viewProfiles??[]) {
  if(!bodyViews.includes(p.bodyView)||p.bodyView==='sideOrBackThreeQuarter'||!p.basis?.trim()||!p.attachments||!Object.keys(p.attachments).length||!p.bodySlots?.length||p.bodySlots.some((s:string)=>!(s in p.attachments)))throw new Error('视角配置需确定视角、切片状态、躯干插槽及校准依据。');
  for(const [slot,name]of Object.entries(p.attachments)){const s=skeleton.findSlot(slot);if(!s||name!==null&&(typeof name!=='string'||!skeleton.getAttachment(s.data.index,name)))throw new Error('视角配置引用不存在的插槽/附件。');}
  const key=JSON.stringify(Object.entries(p.attachments).sort());if(signatures.has(key)&&signatures.get(key)!==p.bodyView)throw new Error('同一切片状态不能确认成不同身体视角。');signatures.set(key,p.bodyView);
 }
}
export function readActionState(skeleton:any,rig:any,frame:any) {
 const attachments=Object.fromEntries(skeleton.slots.map((s:any)=>[s.data.name,s.getAttachment()?.name??null]));
 const profiles=(rig.viewProfiles??[]).filter((p:any)=>Object.entries(p.attachments).every(([s,n])=>attachments[s]===n));
 const views=[...new Set(profiles.map((p:any)=>p.bodyView))];
 const headBone=rig.nodes?.head?.bone;
 return {driver:frame.action?.driver??null,anatomicalSides:rig.anatomicalSides??null,observedView:views.length===1?views[0]:null,viewEvidence:profiles,attachments,drawOrder:skeleton.drawOrder.map((s:any)=>s.data.name),
  // 躯干切片与头部切片供轮廓宽度、层序回读使用；缺失时相关指标按 unverifiable 处理，不猜测。
  torsoSlots:[...new Set(profiles.flatMap((p:any)=>p.bodySlots??[]))] as string[],
  headSlot:headBone?((skeleton.slots as any[]).find((s:any)=>s.bone?.data?.name===headBone)?.data?.name??null):null};
}
export function compareActionSemantics(reference:any,target:any,correspondence:any) {
 const a=reference.actionSemantics;if(!a)return [];
 const s=target.actionState,metrics:any[]=[];
 const add=(id:string,r:any,t:any,known:boolean,pass:boolean,nodes:string[])=>metrics.push({id,reference:r,target:t,error:known?(pass?0:1):null,tolerance:0,required:true,status:known?(pass?'pass':'fail'):'unverifiable',nodes});
 const expected=s?.anatomicalSides?.[a.weaponHand],driver=s?.driver?.replace(/Hand$/,'');
 const identity=!!expected&&['left','right'].includes(driver)&&a.identityStatus==='confirmed';
 add('action.weaponHand',a.weaponHand,driver??null,identity,driver===expected&&correspondence[driver]===a.weaponHand,[`${expected??a.weaponHand}Shoulder`,`${expected??a.weaponHand}Wrist`]);
 const view=s?.observedView;add('action.bodyView',a.bodyView,view??null,!!view,a.bodyView===view||a.bodyView==='sideOrBackThreeQuarter'&&['side','backThreeQuarter'].includes(view),['body','head']);
 const slots=(part:string)=>part==='body'?s?.viewEvidence.flatMap((p:any)=>p.bodySlots)??[]:target.segments?.[part]?.attachments?.map((p:any)=>p.slot)??[];
 if(!a.occlusion?.length)add('action.occlusion',null,null,false,false,['body']);
 for(const [i,pair]of (a.occlusion??[]).entries()) {
  const order=s?.drawOrder??[],visible=(list:string[])=>list.filter(x=>s?.attachments[x]!==null&&order.includes(x));
  const f=visible(slots(pair.front)),b=visible(slots(pair.back)),known=f.length>0&&b.length>0;
  add(`action.occlusion.${i}`,pair,known?{front:f,back:b}:null,known,known&&Math.min(...f.map(x=>order.indexOf(x)))>Math.max(...b.map(x=>order.indexOf(x))),['body']);
 }
 return metrics;
}
// 前后层序：参考声明 {a,b,relation,kind}，目标只用 drawOrder 索引回读，不做三维推断。
function depthNodes(part:string){
 const side=part.startsWith('left')?'left':part.startsWith('right')?'right':null;
 if(!side)return [part==='torso'?'body':'head'];
 return part.endsWith('Arm')?[side+'Shoulder',side+'Elbow',side+'Wrist']:[side+'Hip',side+'Knee',side+'Ankle'];
}
export function compareDepth(reference:any,target:any){
 const d=reference.depth;if(!d?.evidence?.length)return [];
 const s=target.actionState,order:string[]=s?.drawOrder??[];
 const slotsFor=(part:string)=>part==='torso'?(s?.torsoSlots??[]):part==='head'?(s?.headSlot?[s.headSlot]:[]):['0','1'].flatMap(i=>target.segments?.[part+'.'+i]?.attachments?.map((p:any)=>p.slot)??[]);
 const visible=(list:string[])=>list.filter(x=>!!s?.attachments&&s.attachments[x]!==null&&order.includes(x));
 const bounds=(list:string[])=>{const idx=list.map(x=>order.indexOf(x));return [Math.min(...idx),Math.max(...idx)];};
 return (d.evidence as any[]).map(e=>{
  const a=visible(slotsFor(e.a)),b=visible(slotsFor(e.b));
  // kind:'scale' 靠投影缩短推断前后，2D 不能自动验证，交视觉审查。
  const base=a.length>0&&b.length>0&&e.kind!=='scale';
  const [front,back]=e.relation==='front'?[a,b]:[b,a];
  const fIdx=front.map(x=>order.indexOf(x)),bIdx=back.map(x=>order.indexOf(x));
  // 严格层序：前层每个槽都必须晚于后层的最晚槽；交错时不做猜测，交人工判断。
  const strictFront=base&&Math.min(...fIdx)>Math.max(...bIdx),strictBack=base&&Math.max(...fIdx)<Math.min(...bIdx);
  const known=base&&(strictFront||strictBack);
  return {
   id:`depth.${e.id}`,nodes:[...depthNodes(e.a),...depthNodes(e.b)],
   reference:{a:e.a,b:e.b,relation:e.relation,kind:e.kind},
   target:base?{aSlots:a,bSlots:b,orderA:bounds(a),orderB:bounds(b),interleaved:!strictFront&&!strictBack}:{aSlots:a,bSlots:b},
   error:known?(strictFront?0:1):null,tolerance:0,required:true,status:known?(strictFront?'pass':'fail'):'unverifiable',
  };
 });
}
