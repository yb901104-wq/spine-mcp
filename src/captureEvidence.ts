import type { Skeleton } from '@esotericsoftware/spine-core';
import { worldVertices } from './motionRuntime.js';
import { HostError } from './hostContracts.js';

export const CAPTURE_EVIDENCE_SCHEMA = 2;
/** 与浏览器分别回读实际 runtime；不把目标点当成实际节点。 */
export function captureRuntimeState(skeleton: Skeleton) {
  return {
    skin: skeleton.skin?.name ?? null,
    attachments: skeleton.slots.map(s => [s.data.name, s.getAttachment()?.name ?? null]),
    drawOrder: skeleton.drawOrder.map(s => s.data.name),
    bones: skeleton.bones.map(b => [b.data.name, b.worldX, b.worldY, b.a, b.b, b.c, b.d]),
    vertices: worldVertices(skeleton),
  };
}
/** 逐字段、逐有限数值比对；缺项、额外字段、NaN 及无穷均不通过。 */
export function assertCaptureReadback(actual: unknown, expected: unknown, field = 'runtime') {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > 1e-4) throw new HostError('CAPTURE_UNVERIFIED', `player 实际回读失配：${field}。`, 409);
  } else if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(expected) || JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())) throw new HostError('CAPTURE_UNVERIFIED', `player 回读字段不完整：${field}。`, 409);
    for (const key of Object.keys(expected)) assertCaptureReadback((actual as any)[key], (expected as any)[key], `${field}.${key}`);
  } else if (actual !== expected) throw new HostError('CAPTURE_UNVERIFIED', `player 实际回读失配：${field}。`, 409);
}
