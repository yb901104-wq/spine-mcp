import {perspectiveSchema} from './perspective.js';
import { motionIntervalOperationSchema, applyMotionInterval, intervalPoseValues } from './motionInterval.js';
import { poseGateData } from './poseWorkflow.js';
import { readFile } from 'node:fs/promises';
import { hostClient } from './hostClient.js';
import { HostError, assertVersion, objectHash, strictHash } from './hostContracts.js';
import { characterFingerprint, solvePoseData } from './poseWorkflow.js';
import { requireVisualRig } from './visualRig.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { versionSchema } from './hostTools.js';
import { referenceFeasibility } from './referenceFeasibility.js';

const common={projectId:{type:'string'},expectedRevision:versionSchema};
const angle={type:'number',minimum:-180,exclusiveMaximum:180};
export const creationControlDefinitions=[
  {name:'spine_edit_motion_interval',description:'隔离 C2 按闭区间编辑 v2 motion；边界必须已有且保持不变，区间外不移动。内部帧只改已声明参数，关键姿态只能替换已批准修订或调整时间；冲突拒绝。默认 dryRun，实际修改自动重算出图，可撤销，保存使用 spine_host_commit。',inputSchema:{type:'object',additionalProperties:false,properties:{...common,...Object.fromEntries(Object.entries(motionIntervalOperationSchema.properties).filter(([k])=>k!=='op')),dryRun:{type:'boolean',default:true}},required:['expectedRevision','start','end'],anyOf:[{required:['frames']},{required:['keyPoses']}]}} ,
  {name:'spine_inspect_character_preparation',description:'只读汇总当前角色的已确认 mapping、切片视觉绑定、继承/约束和缺项；骨骼原点不自动当视觉关节，候选不自动批准。',inputSchema:{type:'object',additionalProperties:false,properties:common,required:['expectedRevision']}},
  {name:'spine_precheck_pose',description:'对当前内存姿态调用一次共享求解器，提前报告不可达、约束和参考缺项；不启动 60 次参考拟合、不发布、不保存，不宣称全局无解。',inputSchema:{type:'object',additionalProperties:false,properties:common,required:['expectedRevision']}},
  {name:'spine_adjust_pose_intent',description:'隔离 C2 语义修正：bodyTilt/headTilt 是 setup 相对平面角；末端 lateral/height 以已审查实际肩髋轴、髋中心和躯干长定义。默认 dryRun；支撑脚位置及武器接管字段不自动改变，不接收图像坐标；perspective 使用独立校准与精确哈希，未校准仅诊断。',inputSchema:{type:'object',additionalProperties:false,properties:{...common,perspective:perspectiveSchema,bodyTilt:angle,headTilt:angle,targets:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,properties:{role:{type:'string',enum:['leftHand','rightHand','leftFoot','rightFoot']},lateral:{type:'number'},height:{type:'number'},angle},required:['role','lateral','height']}},dryRun:{type:'boolean',default:true}},required:['expectedRevision']}}
];
async function current(args:any,c:ToolContext,purpose='control'){const client=hostClient(c);if(!await client.ensurePreview())throw new HostError('HOST_UNAVAILABLE','该操作需实际 Host 当前文档。',409);const snapshot=await client.rpc('/api/snapshot',{expectedRevision:args.expectedRevision,purpose},true);assertVersion(args.expectedRevision,snapshot.version);return {client,snapshot};}
export async function callCreationControl(name:string,args:any,c:ToolContext,signal?:AbortSignal,progress?:(stage:string)=>void){
  const {client,snapshot}=await current(args,c,['spine_adjust_pose_intent','spine_edit_motion_interval','spine_inspect_character_preparation'].includes(name)?'evaluate':'control');
  const check=async()=>{if(signal?.aborted)throw new HostError('TASK_CANCELLED','创作准备已取消。',409);const after=await client.rpc('/api/snapshot',{expectedRevision:args.expectedRevision,purpose:'evaluate'},true);if(after.snapshotHash!==snapshot.snapshotHash)throw new HostError('TARGET_STALE','准备期间输入已变化。',409);};
  if(name==='spine_inspect_character_preparation'){
    const binding=snapshot.project?.manifest?.characters?.[snapshot.characterId];if(!binding)throw new HostError('PROJECT_BINDING_CONFLICT','当前文档没有受管角色绑定。',409);
    const source=await characterFingerprint(binding.skeletonPath,binding.mappingPath,c),mapping=source.mapping;
    let rig:any=null,rigIssue:string|null=null;try{if(binding.visualRigPath)rig=await requireVisualRig(binding.visualRigPath,c);else rigIssue='缺少 visualRig；骨骼/锚点只能作候选，不能用于视觉关节批准。';}catch(error){rigIssue=String(error);}
    if(rig&&rig.fingerprint!==source.fingerprint){rigIssue='visualRig 与当前角色资源指纹不同。';rig=null;}
    const mappingRecord=JSON.parse(await readFile(resolveWorkspacePath(binding.mappingPath,c),'utf8'));
    const report={characterId:snapshot.characterId,version:snapshot.version,sourceFingerprint:source.fingerprint,mappingStatus:mapping.status,calibration:mapping.calibration,
      mappingReportHash:mappingRecord.reportPath?strictHash(await readFile(resolveWorkspacePath(mappingRecord.reportPath,c))):null,
      visualRig:{reviewed:!!rig,issue:rigIssue,nodes:rig?.rig.nodes??null,segments:rig?.rig.segments??null,views:rig?.rig.viewProfiles??[]},
      inheritance:source.doc.json.bones.map((b:any)=>({name:b.name,parent:b.parent??null,transform:b.transform??'normal'})),constraints:{ik:source.doc.json.ik??[],transform:source.doc.json.transform??[],path:source.doc.json.path??[]},
      missing:rigIssue?[rigIssue]:[],approved:false,note:'只汇总已核实绑定；该报告本身不批准角色、视角或动作范围。'};
    await check();return report;
  }
  if(name==='spine_edit_motion_interval'){
    if(snapshot.kind!=='motion'||snapshot.viewProfile!=='c2-pose')throw new HostError('CAPABILITY_MISSING','区间编辑仅限隔离 C2 当前 v2 motion。',409);
    const op={op:'editMotionInterval',...Object.fromEntries(['start','end','frames','keyPoses'].filter(k=>args[k]!==undefined).map(k=>[k,args[k]]))};
    const binding=snapshot.project.manifest.characters[snapshot.characterId],mapping=JSON.parse(await readFile(resolveWorkspacePath(binding.mappingPath,c),'utf8'));
    const candidate=applyMotionInterval(snapshot.document,op,await intervalPoseValues(op,c),mapping),gate=await poseGateData(candidate,c);
    if(!gate.ok)throw new HostError('COMMIT_NOT_AUTHORIZED','区间关键姿态或标准审查未通过。',409,gate);
    await check();return client.patch({expectedRevision:args.expectedRevision,ops:[op],dryRun:args.dryRun??true,expectedCandidateHash:objectHash(candidate)},signal,progress,true);
  }
  if(snapshot.kind!=='pose')throw new HostError('UNSUPPORTED_DOC_KIND','动作预检及语义姿态修正需要当前 pose。',409);
  if(name==='spine_precheck_pose'){
    progress?.('一次共享求解检查目标可达性');const solved=await solvePoseData(snapshot.document,c);await check();
    const axis=solved.report.visual?.torsoAxis,torso=axis?Math.hypot(axis.shoulder.x-axis.hip.x,axis.shoulder.y-axis.hip.y):NaN;
    return {ok:solved.report.ok,version:snapshot.version,numeric:solved.report.ok,unreachable:solved.report.unreachable,issues:solved.report.issues,errors:solved.report.errors,reference:snapshot.derived?.comparison??null,feasibility:referenceFeasibility(snapshot.derived?.comparison,solved.mapping.calibration?.lengths,torso,!!snapshot.document.frame.perspective),referenceIterations:0,globalUnsolvable:false,nextAction:{tool:'spine_explain_pose',posePath:snapshot.path,instruction:'不可达/冲突需复核目标或阶段定义；不能通过换支撑、换身份、改分支或降低阈值绕过。'}};
  }
  if(snapshot.viewProfile!=='c2-pose')throw new HostError('CAPABILITY_MISSING','语义编辑仅限隔离 C2。',409);
  const ops:any[]=[],preview=structuredClone(snapshot.document);
  if(args.perspective!==undefined){preview.frame.perspective=args.perspective;ops.push({op:'setPosePerspective',path:'pose/frame/perspective',value:args.perspective});}
  if(args.bodyTilt!==undefined){preview.frame.body.rotate=args.bodyTilt;ops.push({op:'setPoseParameters',path:'pose/frame/body',patch:{rotate:args.bodyTilt}});}
  if(args.headTilt!==undefined){preview.frame.head=args.headTilt;ops.push({op:'setPoseParameters',path:'pose/frame/head',patch:{rotate:args.headTilt}});}
  if(args.targets?.length){
    if(new Set(args.targets.map((t:any)=>t.role)).size!==args.targets.length)throw new HostError('INVALID_ARGUMENT','一个语义批次不能重复设置相同末端。');
    const solved=await solvePoseData(preview,c),axis=solved.report.visual?.torsoAxis,scale=solved.mapping.calibration!.scale,origin=solved.mapping.calibration!.origin!;
    if(!axis)throw new HostError('CAPABILITY_MISSING','躯干局部控制需已审查的实际肩髋视觉锚点，不能用骨骼原点或头中心替代。',409);
    const dx=axis.shoulder.x-axis.hip.x,dy=axis.shoulder.y-axis.hip.y,length=Math.hypot(dx,dy);if(!(length>1e-6))throw new HostError('CAPABILITY_MISSING','躯干轴退化。',409);
    for(const target of args.targets){if(preview.frame.targets[target.role]?.contact)throw new HostError('CAPABILITY_MISSING','支撑脚不接受可能改变地面接触的躯干局部目标，请使用已声明的固定地面修正入口。',409);
      const world=[axis.hip.x+dy*target.lateral+dx*target.height,axis.hip.y-dx*target.lateral+dy*target.height];
      ops.push({op:'setPoseTarget',path:`pose/frame/targets/${target.role}`,role:target.role,x:(world[0]-origin[0])/scale,y:(world[1]-origin[1])/scale,...target.angle!==undefined?{angle:target.angle}:{}});
    }
  }
  if(!ops.length)throw new HostError('INVALID_ARGUMENT','至少提供一个明确的身体、头部或末端意图。');
  if(signal?.aborted)throw new HostError('TASK_CANCELLED','语义编辑已取消。',409);return {...await client.patch({expectedRevision:args.expectedRevision,ops,dryRun:args.dryRun??true},signal,progress,true),intent:{coordinateSystem:'reviewedTorsoLocal',origin:'hipCenter',positiveLateral:'torsoRight',bodyTilt:'setupDeltaDegrees',opsHash:objectHash(ops)}};
}
