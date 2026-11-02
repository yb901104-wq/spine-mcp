import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { requireReferencePose, referenceFingerprint } from './referencePose.js';
import { requireVisualRig, visualRigFingerprint } from './visualRig.js';
import { validatePoseSequenceData } from './poseSequence.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { HostError, strictHash } from './hostContracts.js';
import { withFileLock } from './jobTools.js';

const text={type:'string',minLength:1};
export const creationReferenceDefinitions=[{
  name:'spine_create_pose_sequence',description:'用已审查参考、visualRig 和显式左右对应创建动作级阶段记录，默认 dryRun。写入只新建记录，不覆盖旧序列、不登记工程、不批准目标姿态或完整动画；节点未知或固定关系冲突则拒绝。',
  inputSchema:{type:'object',additionalProperties:false,properties:{projectId:text,sequencePath:{...text,description:'工作区内新序列文件路径。'},id:text,basis:text,confirmedBy:{...text,description:'对应关系的确认者；不代表动作视觉批准。'},visualRigPath:text,correspondence:{type:'object',additionalProperties:false,properties:{left:{type:'string',enum:['left','right']},right:{type:'string',enum:['left','right']},basis:text,anatomicalIdentity:text,projectedOrder:text},required:['left','right','basis','anatomicalIdentity','projectedOrder']},weaponHand:{anyOf:[{type:'null'},{type:'string',enum:['left','right']}]},stages:{type:'array',minItems:1,maxItems:60,items:{type:'object',additionalProperties:false,properties:{stageId:text,referencePosePath:text},required:['stageId','referencePosePath']}},dryRun:{type:'boolean',default:true}},required:['sequencePath','id','basis','confirmedBy','visualRigPath','correspondence','weaponHand','stages']}
}];
export async function createPoseSequence(args:any,c:ToolContext={},signal?:AbortSignal){
  const target=resolveWorkspacePath(args.sequencePath,c),checkCancel=()=>{if(signal?.aborted)throw new HostError('TASK_CANCELLED','动作级记录创建已取消。',409);};
  const absent=async()=>{try{await lstat(target);throw new HostError('TARGET_STALE','序列路径已存在，请新建修订；不覆盖旧身份和批准。',409);}catch(e:any){if(e.code!=='ENOENT')throw e;}};
  checkCancel();await absent();
  if(!Array.isArray(args.stages)||!args.stages.length||args.stages.length>60||new Set(args.stages.map((s:any)=>s.stageId)).size!==args.stages.length)throw new HostError('VALIDATION_FAILED','阶段需 1–60 项，stageId 唯一。');
  const rig=await requireVisualRig(args.visualRigPath,c),inputs=new Map<string,string>();
  const freeze=async(file:string)=>{inputs.set(file,strictHash(await readFile(resolveWorkspacePath(file,c))));};
  await freeze(args.visualRigPath);
  const stages=[];
  for(const stage of args.stages){checkCancel();const reference=await requireReferencePose(stage.referencePosePath,c);await freeze(stage.referencePosePath);stages.push({stageId:stage.stageId,referencePosePath:stage.referencePosePath,referenceFingerprint:referenceFingerprint(reference)});}
  const record={version:1,id:args.id,basis:args.basis,confirmedBy:args.confirmedBy,confirmedAt:new Date().toISOString(),visualRigPath:args.visualRigPath,visualRigFingerprint:visualRigFingerprint(rig.rig),correspondence:args.correspondence,weaponHand:args.weaponHand,stages};
  const validate=()=>validatePoseSequenceData(record,{sequencePath:args.sequencePath},c);
  const validation=await validate();
  if(!validation.ok)throw new HostError('CONFLICT','动作级参考记录存在必要节点、身份、视角或支撑冲突。',409,{issues:validation.issues});
  checkCancel();
  const result={ok:true,dryRun:args.dryRun!==false,sequencePath:args.sequencePath,record,validation,registered:false,approvedAnimation:false,message:'仅创建动作级已审查参考对应；目标姿态、正式 motion 和工程登记仍须各自门禁。'};
  if(args.dryRun!==false)return result;
  return withFileLock(args.sequencePath,c,async()=>{
    checkCancel();await absent();
    // 重新检查审查证据与文件字节，拒绝计算期间换参考或绑定。
    for(const [file,hash]of inputs)if(strictHash(await readFile(resolveWorkspacePath(file,c)))!==hash)throw new HostError('TARGET_STALE','创建期间参考或视觉绑定发生变化。',409);
    const current=await validate();if(!current.ok||current.fingerprint!==validation.fingerprint)throw new HostError('TARGET_STALE','创建期间动作级记录失效。',409);
    const temp=resolveWorkspacePath(`${args.sequencePath}.${randomUUID()}.tmp`,c);await mkdir(path.dirname(target),{recursive:true});
    try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(record,null,2)+'\n');await handle.sync();}finally{await handle.close();}checkCancel();await link(temp,resolveWorkspacePath(args.sequencePath,c));}
    finally{await unlink(temp).catch(()=>{});}
    return result;
  });
}
