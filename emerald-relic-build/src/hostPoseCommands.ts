import { assertVersion, HostError, rejectFields } from './hostContracts.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { validatePoseInput } from './poseSchemas.js';
import { slotAttachmentPath } from './hostPosePatch.js';

export const hostPoseCommandTools = ['spine_set_pose_target','spine_set_pose_channel','spine_batch_pose_ops','spine_adjust_pose'] as const;
export const isHostPoseCommand = (name: string) => (hostPoseCommandTools as readonly string[]).includes(name);
export const hostPoseCommandCapabilities = (enabled: boolean) => hostPoseCommandTools.map(tool => ({ tool, supported: enabled, schemaVersion: 1,
  execution: 'host-memory', expectedRevision: 'required', outputPosePath: 'forbidden', readinessOperation: 'patch', saveTool: 'spine_host_commit' }));
const invalid = (message: string) => { throw new HostError('INVALID_ARGUMENT',message); };
const subset = (value: any, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]]));
function target(value: any) {
  if (Object.hasOwn(value,'contact')) invalid('附着命令不修改 contact；支撑条件须保持固定。');
  return {op:'setPoseTarget',path:`pose/frame/targets/${value.role}`,role:value.role,...subset(value,['x','y','angle'])};
}
const channel = (value: any) => ({op:'setPoseParameters',path:`pose/frame/channels/${value.name}`,patch:subset(value,['x','y','rotate'])});
function commands(ops: any[]) {
  if(!Array.isArray(ops)||!ops.length||ops.length>200)invalid('ops 必须为 1–200 项。');
  return ops.map(op=>{
    if(op?.op==='target'){rejectFields(op,['op','role','x','y','angle','contact']);return target(op);}
    if(op?.op==='channel'){rejectFields(op,['op','name','x','y','rotate']);return channel(op);}
    return invalid('附着批次仅支持 target/channel；weapon 及其他命令未开放，整批拒绝。');
  });
}
function adjustment(patch: any) {
  validatePoseInput('patch',patch);rejectFields(patch,['frame']);
  const frame=patch.frame;if(!frame)invalid('附着 adjust 需非空 frame 参数。');
  rejectFields(frame,['body','head','channels','targets','presentation','perspective']);
  const ops:any[]=[];
  if(frame.perspective!==undefined)ops.push({op:'setPosePerspective',path:'pose/frame/perspective',value:frame.perspective});
  if(frame.body!==undefined)ops.push({op:'setPoseParameters',path:'pose/frame/body',patch:frame.body});
  if(frame.head!==undefined)ops.push({op:'setPoseParameters',path:'pose/frame/head',patch:{rotate:frame.head}});
  for(const [name,patch] of Object.entries(frame.channels??{}))ops.push({op:'setPoseParameters',path:`pose/frame/channels/${name}`,patch});
  for(const [role,patch] of Object.entries(frame.targets??{}))ops.push(target({role,...patch as object}));
  for(const [slot,attachment] of Object.entries(frame.presentation?.attachments??{}))ops.push({op:'setSlotAttachment',path:slotAttachmentPath(slot),slot,attachment});
  if(frame.presentation?.drawOrder!==undefined)ops.push({op:'setDrawOrder',path:'pose/frame/presentation/drawOrder',order:frame.presentation.drawOrder});
  if(!ops.length||ops.length>200)invalid('附着 adjust 转换后必须为 1–200 项，空对象不算修改。');
  return ops;
}
/** 只把明确命令映射为现有 Host 补丁；不读旧姿态、不求解、不保存或放宽白名单。 */
export function prepareHostPoseCommand(name: string,args: any,state: any,context: ToolContext) {
  if(!isHostPoseCommand(name))invalid('未声明的附着姿态命令。');
  const fields=name==='spine_set_pose_target'?['role','x','y','angle','contact']:name==='spine_set_pose_channel'?['name','x','y','rotate']:name==='spine_batch_pose_ops'?['ops','render','region']:['patch'];
  rejectFields(args,['projectId','posePath','expectedRevision','outputPosePath','dryRun',...fields]);
  if(!state.available||state.writeMode==='frozen')throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','附着实例不可用或已冻结；不能回退旧磁盘姿态。',409);
  if(state.writeMode!=='attached'||state.capabilities?.editing?.profile!=='c2-pose')throw new HostError('WRITE_FORBIDDEN','该命令适配仅用于隔离 C2 attached 实例，不扩大 C1 或观察模式。',409);
  if(state.activeDoc?.kind!=='pose')throw new HostError('UNSUPPORTED_DOC_KIND','姿态命令需要当前 pose，不编辑 motion/skeleton。',409);
  assertVersion(args.expectedRevision,state.version);
  if(typeof args.posePath!=='string'||resolveWorkspacePath(args.posePath,context)!==resolveWorkspacePath(state.activeDoc.path,context))throw new HostError('TARGET_DRIFT','posePath 与当前 Host 文档不一致。',409);
  if(args.outputPosePath!==undefined)invalid('附着命令只修改内存，请省略 outputPosePath；保存新修订须另用 spine_host_commit。');
  if(args.render!==undefined&&args.render!==false||args.region!==undefined)invalid('附着批次返回当前帧，不支持旧对比图 render:true/region；请另行采集当前 player 证据。');
  if(args.dryRun!==undefined&&typeof args.dryRun!=='boolean')invalid('dryRun 必须为布尔值。');
  const ops=name==='spine_set_pose_target'?[target(args)]:name==='spine_set_pose_channel'?[channel(args)]:name==='spine_batch_pose_ops'?commands(args.ops):adjustment(args.patch);
  return {expectedRevision:args.expectedRevision,ops,dryRun:args.dryRun??true};
}
