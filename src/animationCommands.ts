/** 命令定义同时用于公开 schema、运行时校验与 Host 白名单。 */
export const endpointRoles = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const;
export type EndpointRole = typeof endpointRoles[number];
export type PoseCommand =
  | { op: 'target'; role: EndpointRole; x?: number; y?: number; angle?: number; contact?: boolean }
  | { op: 'channel'; name: string; rotate?: number; x?: number; y?: number }
  | { op: 'weapon'; weapon: { x: number; y: number; angle: number; grips: { left: number; right: number } } | null };
const coordinate = { type: 'number', description: 'normalizedSkeleton 坐标；禁止传入图片像素坐标。' };
const rotation = { type: 'number', description: '角度，单位度；channel.rotate 是 setup pose 的旋转增量。' };
const targetProperties = {
  role: { type: 'string', enum: endpointRoles }, x: coordinate, y: coordinate,
  angle: { type: 'number', description: '末端的期望世界方向，单位度。' },
  contact: { type: 'boolean', description: '脚底接触标志；手目标不能设置。' },
};
const channelProperties = { name: { type: 'string', minLength: 1, description: 'mapping.bones.channels 中的语义通道名。' }, rotate: rotation, x: coordinate, y: coordinate };
const weaponSchema = { anyOf: [
  { type: 'null' },
  { type: 'object', additionalProperties: false, properties: {
    x: coordinate, y: coordinate, angle: rotation,
    grips: { type: 'object', additionalProperties: false, properties: { left: coordinate, right: coordinate }, required: ['left', 'right'] },
  }, required: ['x', 'y', 'angle', 'grips'] },
] };
export const poseCommandSchema = { oneOf: [
  { type: 'object', additionalProperties: false, properties: { op: { const: 'target' }, ...targetProperties }, required: ['op', 'role'], anyOf: ['x', 'y', 'angle', 'contact'].map(k => ({ required: [k] })) },
  { type: 'object', additionalProperties: false, properties: { op: { const: 'channel' }, ...channelProperties }, required: ['op', 'name'], anyOf: ['rotate', 'x', 'y'].map(k => ({ required: [k] })) },
  { type: 'object', additionalProperties: false, properties: { op: { const: 'weapon' }, weapon: weaponSchema }, required: ['op', 'weapon'] },
] };
export const poseOperationProperties: Record<string, Record<string, any>> = {
  spine_set_pose_target: targetProperties,
  spine_set_pose_channel: channelProperties,
  spine_batch_pose_ops: { ops: { type: 'array', minItems: 1, maxItems: 200, items: poseCommandSchema } },
};
export const poseOperationArguments:Record<string,string[]>={
  spine_calibrate_visual_rig:['projectId','filePath','mappingPath','visualRigPath','anatomicalSides','nodes','segments','viewProfiles','outputDir','detailed','dryRun'],
  spine_review_visual_rig:['projectId','visualRigPath','decision','reviewedBy','reason','dryRun'],
  spine_validate_pose_sequence:['projectId','sequencePath','posePaths','reportPath','dryRun'],
  spine_refine_reference_pose:['projectId','posePath','outputPosePath','comparisonPath','reportPath','detailed','dryRun'],
  spine_retarget_reference_pose:['projectId','referencePosePath','visualRigPath','standardPosePath','posePath','sequencePath','stageId','correspondence','facing','time','id','weapon','headFromReference','weaponFromReference','reportPath','detailed','dryRun'],
  spine_compare_pose_graphs:['projectId','posePath','candidatePath','animation','time','reportPath','detailed','dryRun'],
  spine_create_reference_pose:['projectId','referencePosePath','observation','id','dryRun'],
  spine_render_reference_pose_sheet:['projectId','referencePosePaths','outputDir'],
  spine_review_reference_pose:['projectId','referencePosePath','manifestPath','decision','reviewedBy','reason','checks','issues','dryRun'],
  spine_upgrade_reference_pose:['projectId','referencePosePath','outputReferencePosePath','face','silhouette','orientation','depth','dryRun'],
  spine_get_pose_state:['projectId','posePath','recheck'],
  spine_recheck_pose:['projectId','posePath'],
  spine_explain_pose:['projectId','posePath','recheck'],
  spine_create_pose_draft:['projectId','filePath','mappingPath','posePath','kind','facing','id','frame','groundY','standardPosePath','referencePosePath','reference','weapon','kneeFlexionMax','thresholdReason','visualRigPath','correspondence','sequencePath','stageId','dryRun'],
  spine_solve_pose:['projectId','posePath','dryRun'],
  spine_adjust_pose:['projectId','posePath','outputPosePath','patch','dryRun'],
  spine_render_pose_comparison:['projectId','posePaths','stageIds','targetTimes','outputDir','width','height','region'],
  spine_build_motion_from_poses:['projectId','standardPosePath','keyPoses','motionPath','name','duration','loop','dryRun'],
  spine_review_animation:['projectId','reviewToken','manifestPath','decision','reviewedBy','reason','checks','issues','dryRun'],
  spine_render_animation_comparison:['projectId','targetManifestPath','referenceManifestPath','poseManifestPath','phaseMap','outputDir'],
  spine_review_pose:['projectId','posePath','manifestPath','expectedRevision','comparisonPath','decision','reviewedBy','reason','checks','checkResults','stageId','issues','dryRun'],
  spine_set_pose_target:['projectId','posePath','outputPosePath','dryRun',...Object.keys(targetProperties)],
  spine_set_pose_channel:['projectId','posePath','outputPosePath','dryRun',...Object.keys(channelProperties)],
  spine_batch_pose_ops:['projectId','posePath','outputPosePath','dryRun','ops','render','region'],
};
export function validatePoseOperationArguments(tool:string,args:any,required:readonly string[]=[]){
  const allowed=poseOperationArguments[tool];if(!allowed)return;
  fields(args,allowed);
  for(const key of required)if(args[key]===undefined||args[key]===null)throw new Error(`${key} 必须提供。`);
  for(const key of Object.keys(args).filter(k=>k.endsWith('Path')))if(typeof args[key]!=='string'||!args[key].trim())throw new Error(`${key} 必须是非空路径。`);
  for(const key of ['dryRun','render'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw new Error(`${key} 必须为布尔值。`);
  if(tool==='spine_batch_pose_ops'){
    if(!Array.isArray(args.ops)||!args.ops.length||args.ops.length>200)throw new Error('ops 不能为空，且最多 200 项。');
    for(const op of args.ops)validatePoseCommand(op);
  }
}

function fields(value: any, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('操作必须是对象。');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`操作包含未声明字段 ${key}。`);
}
const name = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || ['__proto__', 'prototype', 'constructor'].includes(value)) throw new Error('通道名必须是安全的非空字符串。');
};
function finiteValues(value: any, keys: string[]) {
  for (const key of keys) if (value[key] !== undefined && !Number.isFinite(value[key])) throw new Error(`${key} 必须为有限数。`);
}
export function validatePoseCommand(op: any): asserts op is PoseCommand {
  if (op?.op === 'target') {
    fields(op, ['op', ...Object.keys(targetProperties)]);
    if (!endpointRoles.includes(op.role)) throw new Error(`目标必须是 ${endpointRoles.join('/')}。`);
    finiteValues(op, ['x', 'y', 'angle']);
    if (op.contact !== undefined && (typeof op.contact !== 'boolean' || op.role.endsWith('Hand'))) throw new Error('contact 只能是脚目标的布尔值。');
    if (!['x', 'y', 'angle', 'contact'].some(k => op[k] !== undefined)) throw new Error('至少给 x/y/angle/contact 中一项。');
  } else if (op?.op === 'channel') {
    fields(op, ['op', ...Object.keys(channelProperties)]); name(op.name); finiteValues(op, ['rotate', 'x', 'y']);
    if (!['rotate', 'x', 'y'].some(k => op[k] !== undefined)) throw new Error('channel 至少给 rotate/x/y 中一项。');
  } else if (op?.op === 'weapon') {
    fields(op, ['op', 'weapon']);
    if (op.weapon !== null) {
      fields(op.weapon, ['x', 'y', 'angle', 'grips']); fields(op.weapon.grips, ['left', 'right']);
      if (![op.weapon.x, op.weapon.y, op.weapon.angle, op.weapon.grips.left, op.weapon.grips.right].every(Number.isFinite)) throw new Error('weapon 需要有限 x/y/angle/grips.left/right。');
    }
  } else throw new Error(`未知操作 ${op?.op}；只支持 target/channel/weapon。`);
}

export function invalidatePose(pose: any) {
  pose.status = 'draft';
  for (const key of ['solution', 'review', 'comparisonPath', 'comparison', 'authorization', 'reviewToken']) delete pose[key];
  return pose;
}

export function applyPoseCommands(source: any, ops: unknown[]) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 200) throw new Error('ops 不能为空，且最多 200 项。');
  for (const op of ops) validatePoseCommand(op);
  const pose = structuredClone(source), applied: string[] = [];
  pose.frame ??= {};
  for (const op of ops as PoseCommand[]) {
    if (op.op === 'target') {
      const { op: _, role, ...patch } = op;
      pose.frame.targets ??= {};
      pose.frame.targets[role] = { ...pose.frame.targets[role], ...patch };
      applied.push(`target:${role}`);
    } else if (op.op === 'channel') {
      const { op: _, name: channel, ...patch } = op;
      pose.frame.channels ??= {};
      pose.frame.channels[channel] = { ...pose.frame.channels[channel], ...patch };
      applied.push(`channel:${channel}`);
    } else { pose.weapon = structuredClone(op.weapon); applied.push('weapon'); }
  }
  return { pose: invalidatePose(pose), applied };
}

export interface InputDiff { path: string; before: unknown; after: unknown }
export function inputDiff(before: any, after: any, prefix = ''): InputDiff[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(k => inputDiff(before[k], after[k], `${prefix}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [{ path: prefix, before: before ?? null, after: after ?? null }];
}
