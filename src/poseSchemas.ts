import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ToolError } from './toolError.js';

// 语义输入与工具发现共用。frame 是可合并的部分输入，求解仍检查完整性和角色能力。
const number = { type: 'number' };
const object = (properties: Record<string, any>, extra: Record<string, any> = {}) => ({ type: 'object', additionalProperties: false, properties, ...extra });
const transform = object({ x: number, y: number, rotate: number });
const endpoint = object({ x: number, y: number, angle: number, contact: { type: 'boolean' } });
const safeNames = { not: { enum: ['__proto__', 'prototype', 'constructor'] }, minLength: 1 };
const dictionary = (value: any) => ({ type: 'object', propertyNames: safeNames, additionalProperties: value, maxProperties: 500 });
export const weaponInputSchema = { anyOf: [{ type: 'null' }, object({ x: number, y: number, angle: number, grips: object({ left: number, right: number }, { required: ['left', 'right'] }) }, { required: ['x', 'y', 'angle', 'grips'] })] };
export const frameInputSchema = object({
  time: { type: 'number', minimum: 0 }, body: transform, head: number,
  channels: dictionary(transform),
  targets: object(Object.fromEntries(['leftHand', 'rightHand', 'leftFoot', 'rightFoot'].map(role => [role, role.endsWith('Hand') ? object({ x: number, y: number, angle: number }) : endpoint]))),
  bendDirections: object(Object.fromEntries(['leftArm', 'rightArm', 'leftLeg', 'rightLeg'].map(role => [role, { type: 'integer', enum: [-1, 1] }]))),
  action: object({ driver: { anyOf: [{ type: 'string', enum: ['leftHand', 'rightHand'] }, { type: 'null' }] } }),
  presentation: object({ attachments: dictionary({ type: ['string', 'null'] }), drawOrder: { type: 'array', uniqueItems: true, maxItems: 500, items: { type: 'string' } } }),
}, { description: 'normalizedSkeleton 语义参数；body/channels.rotate 为 setup 增量，head 为角度；不接受骨骼、solution 或批准字段。' });
export const policyInputSchema = object({ kneeFlexionMax: { type: 'number', minimum: 0, maximum: 180 }, reason: { type: 'string' } });
export const posePatchInputSchema = object({
  frame: frameInputSchema, weapon: { anyOf: [{ type: 'null' }, object({ x: number, y: number, angle: number, grips: object({ left: number, right: number }) })] }, groundY: number, policy: policyInputSchema,
  // 参考/绑定数据由各自的正式审查层验证；不能由此产生批准。
  reference: { type: ['object', 'null'] }, correspondence: { type: ['object', 'null'] },
  ...Object.fromEntries(['referencePosePath', 'visualRigPath', 'sequencePath', 'stageId'].map(key => [key, { type: ['string', 'null'] }])),
}, { minProperties: 1, description: '只合并已公布的姿态参数；新修订清除旧求解、比较和审查。' });
const provider = new AjvJsonSchemaValidator();
const validators = { frame: provider.getValidator(frameInputSchema), patch: provider.getValidator(posePatchInputSchema), weapon: provider.getValidator(weaponInputSchema) };
export function validatePoseInput(kind: keyof typeof validators, value: unknown) {
  const inspect = (item: any, depth: number) => {
    if (depth > 16) throw new ToolError('VALIDATION_FAILED', '姿态输入嵌套过深。');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new ToolError('VALIDATION_FAILED', '姿态输入必须使用有限数。');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ToolError('VALIDATION_FAILED', '姿态输入包含不安全字段。');
      inspect(child, depth + 1);
    }
  };
  inspect(value, 0);
  const result = validators[kind](value);
  if (!result.valid) throw new ToolError('VALIDATION_FAILED', `${kind} 不符合已公布的姿态输入 schema。`, 'validation', { validation: result.errorMessage });
}
