import { readFile } from 'node:fs/promises';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { HostError, objectHash } from './hostContracts.js';
import { semanticAt } from './retargetEngine.js';
import { validateMotion } from './motionEngine.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { editableValue, type HostDocument } from './hostDocumentStore.js';

const number={type:'number'}, angle={type:'number',minimum:-180,exclusiveMaximum:180};
const transform={type:'object',additionalProperties:false,minProperties:1,properties:{x:number,y:number,rotate:angle}};
const target={type:'object',additionalProperties:false,minProperties:1,properties:{x:number,y:number,angle}};
export const motionIntervalOperationSchema={type:'object',additionalProperties:false,properties:{
  op:{const:'editMotionInterval'},start:{type:'number',minimum:0},end:{type:'number',exclusiveMinimum:0},
  frames:{type:'array',maxItems:200,items:{type:'object',additionalProperties:false,properties:{time:number,body:transform,head:angle,channels:{type:'object',minProperties:1,maxProperties:100,additionalProperties:transform},targets:{type:'object',additionalProperties:false,minProperties:1,properties:Object.fromEntries(['leftHand','rightHand','leftFoot','rightFoot'].map(r=>[r,target]))}},required:['time'],anyOf:['body','head','channels','targets'].map(k=>({required:[k]}))}},
  keyPoses:{type:'array',maxItems:200,items:{type:'object',additionalProperties:false,properties:{stageId:{type:'string',minLength:1},posePath:{type:'string',minLength:1},time:number},required:['stageId'],anyOf:[{required:['posePath']},{required:['time']}]}},
},required:['op','start','end'],anyOf:[{required:['frames']},{required:['keyPoses']}]};
export const motionIntervalOpsSchema={type:'array',minItems:1,maxItems:1,items:motionIntervalOperationSchema};
const validator=new AjvJsonSchemaValidator().getValidator(motionIntervalOperationSchema);
const fail=(message:string):never=>{throw new HostError('INVALID_ARGUMENT',message,409);};
const safe=(name:string)=>!!name&&!['__proto__','prototype','constructor'].includes(name)&&!/[\\/~\x00-\x1f]/.test(name);
const fixed=(frame:any)=>Object.fromEntries(['action','bendDirections','presentation','perspective'].map(k=>[k,frame[k]??null]).concat([['contacts',Object.fromEntries(Object.entries(frame.targets).map(([r,t]:any)=>[r,t.contact??false]))]]));
function clean(source:any){const v=editableValue(source);delete v.status;delete v.id;return v;}
export async function intervalPoseValues(op:any,context:ToolContext){
  const result=new Map<string,any>();
  for(const k of op.keyPoses??[])if(k.posePath&&!result.has(k.posePath))result.set(k.posePath,JSON.parse(await readFile(resolveWorkspacePath(k.posePath,context),'utf8')));
  return result;
}
/** 只修改闭区间内部；边界值保持，因而邻接区间的插值保持。替换姿态仍由 MCP 完整门禁复核。 */
export function applyMotionInterval(source:any,op:any,poses:Map<string,any>,mapping:any){
  if(!validator(op).valid)fail('区间编辑参数不符合已公布 schema。');
  validateMotion(source);
  if(source.version!==2||!source.poseWorkflow)fail('区间编辑仅支持有标准和关键姿态来源的 v2 motion。');
  if(!(op.start<op.end)||op.end>source.duration||!source.frames.some((f:any)=>f.time===op.start)||!source.frames.some((f:any)=>f.time===op.end))fail('start/end 必须是递增的既有帧边界，且位于 motion 时长内。');
  if(!(op.frames?.length||op.keyPoses?.length))fail('至少提供一项帧或关键姿态修改。');
  const controlled=(bone:string)=>['leftArm','rightArm','leftLeg','rightLeg'].some(role=>mapping.bones[role]?.includes(bone))||(mapping.bones.follow??[]).some((v:any)=>v.bone===bone);
  const result=structuredClone(source),within=(t:number)=>Number.isFinite(t)&&t>op.start&&t<op.end;
  const stageIds=new Set<string>(),times=new Set<number>();
  for(const k of op.keyPoses??[]){
    if(stageIds.has(k.stageId))fail('同一阶段不能重复编辑。');stageIds.add(k.stageId);
    const entry=result.poseWorkflow.keyPoses.find((s:any)=>s.stageId===k.stageId);
    if(!entry||!within(entry.time)||!within(k.time??entry.time))fail('关键姿态原时间和新时间均须位于所选区间内部；不能移动其它阶段或边界。');
    const oldTime=entry.time,frame=result.frames.find((f:any)=>f.time===oldTime);
    if(!frame)fail('阶段必须精确对应已有关键帧。');
    const nextTime=k.time??oldTime;
    if(nextTime!==oldTime&&result.frames.some((f:any)=>f.time===nextTime))fail('新阶段时间与已有帧重叠。');
    if(k.posePath){const p=poses.get(k.posePath);if(!p?.frame||p.status!=='confirmed'||p.review?.decision!=='approved')fail('替换关键姿态必须是已确认并经批准的真实姿态修订。');
      if(objectHash(fixed(p.frame))!==objectHash(fixed(frame)))fail('区间不能借姿态替换改变支撑、分支、层序、附件或透视模式。');
      Object.keys(frame).forEach(key=>delete frame[key]);Object.assign(frame,structuredClone(p.frame));entry.posePath=k.posePath;
    }
    frame.time=nextTime;entry.time=nextTime;
  }
  for(const edit of op.frames??[]){
    if(!within(edit.time)||times.has(edit.time))fail('帧时间必须唯一且严格位于区间内部。');times.add(edit.time);
    if(result.poseWorkflow.keyPoses.some((k:any)=>k.time===edit.time)||source.poseWorkflow.keyPoses.some((k:any)=>k.time===edit.time))fail('已审查关键姿态只能通过 posePath 修订替换，不能直接覆盖其参数。');
    let frame=result.frames.find((f:any)=>f.time===edit.time);
    if(!frame){frame=structuredClone(semanticAt(source,edit.time));result.frames.push(frame);}
    if(edit.body&&controlled(mapping.bones.body))fail('身体骨骼已被现有链或跟随接管。');
    if(edit.body)frame.body={...frame.body,...edit.body};
    if(edit.head!==undefined){if(!mapping.bones.head||controlled(mapping.bones.head))fail('当前角色没有声明头部通道。');frame.head=edit.head;}
    for(const [name,patch]of Object.entries(edit.channels??{})){if(!safe(name)||!mapping.bones.channels?.[name]||controlled(mapping.bones.channels[name])||!frame.channels?.[name])fail('只能编辑既有且已声明的通道。');frame.channels[name]={...frame.channels[name],...patch as object};}
    for(const [role,patch]of Object.entries(edit.targets??{})as any){if(!frame.targets[role]||!mapping.bones.anchors?.[role])fail('只能编辑已有末端与锚点。');
      if(frame.targets[role].contact&&patch.y!==undefined)fail('固定支撑脚的地面高度不允许区间编辑。');
      frame.targets[role]={...frame.targets[role],...patch};}
  }
  result.frames.sort((a:any,b:any)=>a.time-b.time);
  const ordered=result.poseWorkflow.keyPoses;
  if(ordered.some((k:any,i:number)=>i>0&&k.time<=ordered[i-1].time))fail('阶段顺序冲突，不能隐式重排其它阶段。');
  if(result.frames.length>10001)fail('区间编辑后帧数超过 10001。');
  validateMotion(result);
  const outside=(value:any)=>({frames:value.frames.filter((f:any)=>f.time<=op.start||f.time>=op.end),keyPoses:value.poseWorkflow.keyPoses.filter((k:any)=>k.time<=op.start||k.time>=op.end)});
  if(objectHash(outside(source))!==objectHash(outside(result)))fail('区间外或边界内容发生变化。');
  return clean(result);
}
/** journal 不恢复批准；只恢复该 profile 的声明参数和同角色已登记姿态，拒绝其它字段。 */
export function assertMotionRecovery(doc:HostDocument,value:any){
  validateMotion(value);
  const source=clean(doc.value),candidate=clean(value);
  const header=(v:any)=>Object.fromEntries(Object.entries(v).filter(([k])=>!['frames','poseWorkflow'].includes(k)));
  if(objectHash(header(source))!==objectHash(header(candidate))||source.poseWorkflow?.standardPosePath!==candidate.poseWorkflow?.standardPosePath)fail('恢复不能改变 motion 名称、时长、事件、参数或标准绑定。');
  const keys=source.poseWorkflow?.keyPoses??[],next=candidate.poseWorkflow?.keyPoses??[];
  if(keys.length!==next.length||keys.some((k:any,i:number)=>k.stageId!==next[i]?.stageId))fail('恢复不能添加、删除或重排阶段。');
  for(const frame of candidate.frames){
    const at:any=semanticAt(source,frame.time);
    if(objectHash(fixed(frame))!==objectHash(fixed(at)))fail('恢复不能修改支撑、分支、呈现或透视模式。');
    if(Object.keys(frame).some(k=>!['time','body','head','channels','targets','action','bendDirections','presentation','perspective'].includes(k)))fail('恢复帧包含未声明字段。');
    if(Object.keys(frame.body).some(k=>!['x','y','rotate'].includes(k))||['x','y','rotate'].some(k=>!Number.isFinite(frame.body[k])))fail('恢复身体参数无效。');
    if(frame.head!==undefined&&!Number.isFinite(frame.head))fail('恢复头部参数无效。');
    for(const [role,t]of Object.entries(frame.targets)as any){if(!at.targets[role]||Object.keys(t).some(k=>!['x','y','angle','contact'].includes(k))||t.contact&&t.y!==at.targets[role]?.y)fail('恢复末端超出声明或改变支撑高度。');}
    for(const [name,t]of Object.entries(frame.channels??{})as any)if(!safe(name)||!doc.mapping.bones.channels?.[name]||Object.keys(t).some(k=>!['x','y','rotate'].includes(k))||Object.values(t).some(v=>!Number.isFinite(v)))fail('恢复通道超出声明。');
  }
}
