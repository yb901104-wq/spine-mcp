import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { applyPoseCommands, endpointRoles, invalidatePose, inputDiff } from './animationCommands.js';
import { HostError } from './hostContracts.js';
import type { HostDocument } from './hostDocumentStore.js';
import { createMotionRuntime } from './motionRuntime.js';
import { applyPosePresentation } from './posePresentation.js';
import { perspectiveSchema, validatePerspective } from './perspective.js';

export type HostEditProfile = 'c1' | 'c2-pose';
const angle = { type: 'number', minimum: -180, exclusiveMaximum: 180, description: '角度，单位度，范围 [-180,180)。' };
const coordinate = { type: 'number', description: 'normalizedSkeleton 坐标；禁止图片像素。' };
const transform = { type: 'object', additionalProperties: false, minProperties: 1, description: '合并身体或声明通道的非空参数子集；rotate 为 setup 旋转增量。', properties: { x: coordinate, y: coordinate, rotate: angle } };
const target = (roles: readonly string[]) => ({ type: 'object', additionalProperties: false, properties: {
  op: { const: 'setPoseTarget' }, path: { type: 'string', enum: roles.map(role => `pose/frame/targets/${role}`) },
  role: { type: 'string', enum: roles, description: '既有语义末端，必须与 path 相同；不能创建新绑定。' }, x: coordinate, y: coordinate, angle,
}, required: ['op', 'path', 'role'], anyOf: ['x', 'y', 'angle'].map(key => ({ required: [key] })) });
const parameter = (path: object, patch: object) => ({ type: 'object', additionalProperties: false,
  properties: { op: { const: 'setPoseParameters' }, path, patch }, required: ['op', 'path', 'patch'] });
const presentationOperation = (op: string, properties: Record<string, any>, required: string[]) => ({ type: 'object', additionalProperties: false,
  properties: { op: { const: op }, ...properties }, required: ['op', ...required] });
const attachment = { description: '当前皮肤或 default 回退中的既有附件名；null 表示隐藏。', anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] };
const order = { type: 'array', uniqueItems: true, maxItems: 500, description: '现有全部插槽的唯一排列，不能只传局部层序。', items: { type: 'string', minLength: 1 } };
const presentationSchema = { type: 'object', additionalProperties: false, properties: {
  attachments: { type: 'object', maxProperties: 500, additionalProperties: attachment }, drawOrder: order,
} };
export const c1PatchOpsSchema = { type: 'array', minItems: 1, maxItems: 1, items: target(['leftHand', 'rightHand']) };
export const c2PosePatchOpsSchema = { type: 'array', minItems: 1, maxItems: 200, items: { oneOf: [
  presentationOperation('setPosePerspective',{path:{const:'pose/frame/perspective'},value:{anyOf:[{type:'null'},perspectiveSchema]}},['path','value']),
  target(endpointRoles), parameter({ const: 'pose/frame/body' }, transform),
  parameter({ const: 'pose/frame/head' }, { type: 'object', additionalProperties: false, properties: { rotate: angle }, required: ['rotate'] }),
  parameter({ type: 'string', pattern: '^pose/frame/channels/[^/~\\\\\u0000-\u001f]+$' }, transform),
  presentationOperation('setSlotAttachment', { path: { type: 'string', description: 'pose/frame/presentation/attachments/ 后接规范转义的 slot 名。' }, slot: { type: 'string', minLength: 1, description: '原始插槽名，path 中的 / 和 ~ 分别使用 ~1 和 ~0。' }, attachment }, ['path','slot','attachment']),
  presentationOperation('setDrawOrder', { path: { const: 'pose/frame/presentation/drawOrder' }, order }, ['path','order']),
] } };
const provider = new AjvJsonSchemaValidator();
const validators = { c1: provider.getValidator(c1PatchOpsSchema), 'c2-pose': provider.getValidator(c2PosePatchOpsSchema) };
const presentationValidator = provider.getValidator(presentationSchema);
const safeName = (name: string) => !!name && !['__proto__', 'prototype', 'constructor'].includes(name) && !/[/~\\\x00-\x1f]/.test(name);
const own = (value: any, key: string) => value && Object.hasOwn(value, key);
const point = (value: any) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const failure = (message: string, code = 'CAPABILITY_MISSING') => { throw new HostError(code, message, 409); };
function inspect(value: any, depth = 0) {
  if (depth > 8) failure('补丁值深度不能超过 8。', 'INVALID_ARGUMENT');
  if (typeof value === 'number' && !Number.isFinite(value)) failure('补丁只接受有限数。', 'INVALID_ARGUMENT');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || /[\x00-\x1f]/.test(key)) failure('补丁包含不安全字段。', 'INVALID_ARGUMENT');
    inspect(child, depth + 1);
  }
}
function controlledBone(doc: HostDocument, bone: string) {
  return ['leftArm','rightArm','leftLeg','rightLeg'].some(role => doc.mapping?.bones?.[role]?.includes(bone)) || doc.mapping?.bones?.follow?.some((rule: any) => rule.bone === bone);
}
function boneAvailable(doc: HostDocument, bone: any) {
  return typeof bone === 'string' && doc.skeletonJson.bones?.some((item: any) => item.name === bone) && !controlledBone(doc, bone);
}
export function poseParameterCapabilities(doc: HostDocument | null) {
  return { body: !!doc && boneAvailable(doc, doc.mapping?.bones?.body), head: !!doc && boneAvailable(doc, doc.mapping?.bones?.head),
    channels: Object.entries(doc?.mapping?.bones?.channels ?? {}).map(([name, bone]) => ({ name, supported: !!doc && safeName(name) && boneAvailable(doc, bone) })) };
}
export function posePerspectiveCapabilities(doc:HostDocument|null){
  return {mode:'diagnostic',modes:['diagnostic','calibration','calibrated'],calibrationTool:'spine_calibrate_arm_perspective',reviewTool:'spine_review_arm_perspective',formalRequires:'currentReviewedCalibrationHash',experimental:true,readyToCommit:false,op:'setPosePerspective',path:'pose/frame/perspective',resetValue:null,
    limbs:['leftArm','rightArm'].map(limb=>({limb,supported:!!doc?.mapping?.bones?.[limb]&&!!doc?.value.frame?.targets?.[limb.replace('Arm','Hand')]})),
    note:'只声明候选能力；骨架继承与现有约束由求解时严格检查，比例不是已校准美术范围。'};
}
export function poseTargetCapabilities(doc: HostDocument | null, roles: readonly string[] = endpointRoles) {
  return roles.map(role => {
    const anchor = doc?.mapping?.bones?.anchors?.[role], chainRole = role.replace('Hand', 'Arm').replace('Foot', 'Leg');
    const chain = doc?.mapping?.bones?.[chainRole];
    const supported = !!doc?.value.frame?.targets?.[role] && point(anchor?.point) && chain?.length === 3 && chain[2] === anchor?.bone
      && chain.every((name: string) => doc!.skeletonJson.bones?.some((bone: any) => bone.name === name));
    const controlledFields = role.endsWith('Hand') && doc?.value.weapon ? ['x', 'y'] : role.endsWith('Foot') && doc?.value.frame?.targets?.[role]?.contact ? ['y'] : [];
    return { role, supported: !!supported, controlledFields, availableFields: supported ? ['x', 'y', 'angle'].filter(key => !controlledFields.includes(key)) : [] };
  });
}
export const slotAttachmentPath = (slot: string) => `pose/frame/presentation/attachments/${slot.replace(/~/g, '~0').replace(/\//g, '~1')}`;
const safeSlot = (slot: string) => !!slot && !['__proto__','prototype','constructor'].includes(slot) && !/[\x00-\x1f]/.test(slot);
export function posePresentationCapabilities(doc: HostDocument | null) {
  const skins = doc?.skeletonJson.skins;
  const selected = Array.isArray(skins) ? skins.filter((skin: any) => ['default', doc?.mapping.skin ?? 'default'].includes(skin.name)) : [];
  return { slots: (doc?.skeletonJson.slots ?? []).map((slot: any) => ({ slot: slot.name, path: slotAttachmentPath(slot.name), supported: safeSlot(slot.name),
    attachments: [...new Set(selected.flatMap((skin: any) => Object.keys(skin.attachments?.[slot.name] ?? {})))], canHide: safeSlot(slot.name) })),
    drawOrder: { requiresAllSlots: true, source: 'skeleton.slots', verification: 'declared' } };
}
function validatePresentation(doc: HostDocument, value: any) {
  if (!presentationValidator(value).valid) failure('姿态呈现参数包含未声明字段或无效类型。', 'INVALID_ARGUMENT');
  inspect(value);
  try {
    const runtime = createMotionRuntime(doc.skeletonJson, doc.atlasRaw);
    applyPosePresentation(runtime.sample(undefined, 0, doc.mapping.skin), value);
  } catch { failure('呈现引用必须属于当前皮肤或其 default 回退；drawOrder 必须是已有全部插槽的唯一排列。', 'INVALID_ARGUMENT'); }
}
function assertTarget(doc: HostDocument, op: any) {
  if (op.path !== `pose/frame/targets/${op.role}`) failure('目标 path 与 role 不一致。', 'INVALID_ARGUMENT');
  const available = poseTargetCapabilities(doc, [op.role])[0];
  if (!available.supported) failure('目标缺少既有语义目标、有效三段链或末端锚点。');
  if (available.controlledFields.some(key => op[key] !== undefined)) failure('该目标字段由 weapon/grip 或脚底接触接管，不能用补丁声称已生效。', 'OPERATION_NOT_READY');
}
function parameterKind(doc: HostDocument, location: string) {
  const capabilities = poseParameterCapabilities(doc);
  if (location === 'pose/frame/body' && capabilities.body) return 'body';
  if (location === 'pose/frame/head' && capabilities.head) return 'head';
  const channel = location.slice('pose/frame/channels/'.length);
  if (location.startsWith('pose/frame/channels/') && capabilities.channels.some(item => item.name === channel && item.supported)) return channel;
  return failure('参数需要 mapping 中已声明且未被 IK/follow 接管的有效骨骼。');
}
/** 全批先校验，再制作独立候选；不修改源对象、绑定、支撑或弯曲分支。 */
export function applyHostPosePatch(doc: HostDocument, ops: any, profile: HostEditProfile) {
  if(profile==='c1'&&doc.value.frame?.perspective)failure('C1 不编辑透视诊断姿态；请使用隔离 C2。','OPERATION_NOT_READY');
  inspect(ops);
  const validation = validators[profile](ops);
  if (!validation.valid) failure(profile === 'c1' ? 'C1 每次只接受一个既有手目标的 x/y/angle。' : '补丁不符合 C2 pose 已公布的独立 schema。', profile === 'c1' ? 'CAPABILITY_MISSING' : 'INVALID_ARGUMENT');
  const paths = new Set<string>();
  for (const op of ops) {
    if ([...paths].some(previous => previous === op.path || previous.startsWith(op.path + '/') || op.path.startsWith(previous + '/'))) failure('整批操作路径不能重复或重叠。', 'INVALID_ARGUMENT');
    paths.add(op.path);
    if (op.op === 'setPoseTarget') assertTarget(doc, op);
    else if(op.op==='setPosePerspective'&&op.value!==null){
      validatePerspective(op.value);
      if(!posePerspectiveCapabilities(doc).limbs.some(v=>v.limb===op.value.limb&&v.supported))failure('透视诊断缺少已声明的手臂及手目标。');
    }
    else if (op.op === 'setPoseParameters') parameterKind(doc, op.path);
    else if (op.op === 'setSlotAttachment') {
      if (!safeSlot(op.slot) || op.path !== slotAttachmentPath(op.slot) || !doc.skeletonJson.slots?.some((slot: any) => slot.name === op.slot)) failure('附件 path 与安全的已有 slot 不一致。', 'INVALID_ARGUMENT');
    }
  }
  let candidate = structuredClone(doc.value);
  for (const op of ops) {
    if(op.op==='setPosePerspective'){
      if(op.value===null)delete candidate.frame.perspective;else candidate.frame.perspective=structuredClone(op.value);
    } else if (op.op === 'setPoseTarget') {
      candidate = applyPoseCommands(candidate, [{ op: 'target', role: op.role, ...Object.fromEntries(['x','y','angle'].filter(key => own(op, key)).map(key => [key, op[key]])) }]).pose;
    } else if (op.op === 'setSlotAttachment') {
      candidate.frame.presentation ??= {}; candidate.frame.presentation.attachments ??= {};
      candidate.frame.presentation.attachments[op.slot] = op.attachment;
    } else if (op.op === 'setDrawOrder') { candidate.frame.presentation ??= {}; candidate.frame.presentation.drawOrder = [...op.order]; }
    else if (op.path === 'pose/frame/body') candidate.frame.body = { ...candidate.frame.body, ...op.patch };
    else if (op.path === 'pose/frame/head') candidate.frame.head = op.patch.rotate;
    else {
      const channel = parameterKind(doc, op.path); candidate.frame.channels ??= {};
      candidate.frame.channels[channel] = { x: 0, y: 0, rotate: 0, ...candidate.frame.channels[channel], ...op.patch };
    }
  }
  if (ops.some((op: any) => ['setSlotAttachment','setDrawOrder'].includes(op.op))) validatePresentation(doc, candidate.frame.presentation);
  return invalidatePose(candidate);
}
/** 恢复不重放旧批准，也不能借 journal 扩大当前 profile 或固定绑定。 */
export function assertPoseRecovery(doc: HostDocument, value: any, profile: HostEditProfile) {
  if(profile==='c1'&&(value.frame?.perspective||doc.value.frame?.perspective))failure('C1 不恢复透视诊断编辑历史。');
  if (typeof value.id !== 'string' || !value.id) failure('恢复姿态 id 无效。');
  inspect(value.frame);
  for (const diff of inputDiff(doc.value, value)) {
    if (/^\/(?:id|status)$/.test(diff.path)) continue;
    if(profile==='c2-pose'&&(diff.path==='/frame/perspective'||diff.path.startsWith('/frame/perspective/'))){
      if(value.frame.perspective!==undefined){validatePerspective(value.frame.perspective);if(!posePerspectiveCapabilities(doc).limbs.some(v=>v.limb===value.frame.perspective.limb&&v.supported))failure('恢复缺少既有手臂绑定。');}
    } else if (/^\/frame\/targets\/(?:leftHand|rightHand)\/(?:x|y|angle)$/.test(diff.path) || profile === 'c2-pose' && /^\/frame\/targets\/(?:leftFoot|rightFoot)\/(?:x|y|angle)$/.test(diff.path)) {
      const [, , , role, key] = diff.path.split('/');
      assertTarget(doc, { role, path: `pose/frame/targets/${role}`, [key]: diff.after });
      if (!Number.isFinite(diff.after) || key === 'angle' && (Number(diff.after) < -180 || Number(diff.after) >= 180)) failure('恢复目标参数无效。');
    } else if (profile === 'c2-pose' && /^\/frame\/(?:body\/(?:x|y|rotate)|head|channels\/[^/~\\]+(?:\/(?:x|y|rotate))?)$/.test(diff.path)) {
      const segments = diff.path.split('/'), location = segments[2] === 'channels' ? `pose/frame/channels/${segments[3]}` : `pose/frame/${segments[2]}`;
      parameterKind(doc, location);
      const data = segments[2] === 'body' ? value.frame.body : segments[2] === 'head' ? { rotate: value.frame.head } : value.frame.channels?.[segments[3]];
      if (data === undefined && doc.value.frame.channels?.[segments[3]] !== undefined) failure('恢复不能删除原有通道。');
      if (data !== undefined && (typeof data !== 'object' || !data || Object.keys(data).some(key => !['x','y','rotate'].includes(key)) || (segments[2] === 'head' ? ['rotate'] : ['x','y','rotate']).some(key => !Number.isFinite(data[key])) || data.rotate < -180 || data.rotate >= 180)) failure('恢复姿态参数无效。');
    } else if (profile === 'c2-pose' && (diff.path === '/frame/presentation' || diff.path.startsWith('/frame/presentation/'))) {
      if (value.frame.presentation === undefined) { if (doc.value.frame.presentation !== undefined) failure('恢复不能删除原有 presentation。'); }
      else validatePresentation(doc, value.frame.presentation);
    } else failure('恢复内容超出当前 pose profile 或固定绑定白名单。');
  }
}
