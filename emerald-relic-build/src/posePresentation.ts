// 导出已有 slot attachment / drawOrder 时间线，不修改切片或绑定。
export function applyPosePresentation(skeleton:any,p:any) {
 if(!p)return;
 for(const [slot,name]of Object.entries(p.attachments??{})) {const s=skeleton.findSlot(slot);if(!s||name!==null&&(typeof name!=='string'||!skeleton.getAttachment(s.data.index,name)))throw new Error('姿态显示引用不存在的插槽或切片。');skeleton.setAttachment(slot,name);}
 if(p.drawOrder){const slots=skeleton.slots.map((s:any)=>s.data.name);if(!Array.isArray(p.drawOrder)||p.drawOrder.length!==slots.length||new Set(p.drawOrder).size!==slots.length||p.drawOrder.some((s:string)=>!slots.includes(s)))throw new Error('姿态 drawOrder 必须是现有全部插槽的唯一排列。');skeleton.drawOrder=p.drawOrder.map((name:string)=>skeleton.findSlot(name));}
}
export function presentationTimelines(json:any,mapping:any,motion:any,duration:number) {
 const base=Object.fromEntries((json.slots??[]).map((s:any)=>[s.name,s.attachment??null]));Object.assign(base,mapping.bones.slotAttachments??{});
 const slots:any={},drawOrder:any[]=[];let previous:any=null,previousOrder:string|null=null;
 for(const f of motion.frames){const state={...base,...f.presentation?.attachments},time=f.time*duration/motion.duration;
  for(const [slot,name]of Object.entries(state)){if(previous&&previous[slot]===name)continue;(slots[slot]??={attachment:[]}).attachment.push(name===null?{time}:{time,name});}
  const order=f.presentation?.drawOrder??json.slots.map((s:any)=>s.name),key=JSON.stringify(order);
  if(key!==previousOrder){drawOrder.push({time,offsets:json.slots.map((s:any,i:number)=>({slot:s.name,offset:order.indexOf(s.name)-i}))});previousOrder=key;}previous=state;
 }
 return {slots,drawOrder};
}
