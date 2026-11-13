import { createHash } from 'node:crypto';
import { toolErrorPayload } from './toolError.js';
export interface VersionRef { sessionId: string; documentId: string; openEpoch: string; revision: number }
export type DocumentKind = 'pose' | 'motion' | 'skeleton';
export class HostError extends Error {
  constructor(public code: string, message: string, public status = 400, public detail?: unknown) { super(message); }
}
export const stableJson = (value: any): string => {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, sorted(v[k])])) : v;
  return JSON.stringify(sorted(value));
};
export const strictHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const objectHash = (value: unknown) => strictHash(stableJson(value));
export const derivedFingerprint = (snapshotHash: string, result: any) => objectHash({ snapshotHash, result: { ...result, ...(result.live ? { live: { ...result.live, path: undefined } } : {}) } });
export function assertVersion(expected: any, actual: VersionRef) {
  const keys = ['sessionId', 'documentId', 'openEpoch', 'revision'] as const;
  if (!expected || typeof expected !== 'object' || keys.some(k => expected[k] !== actual[k]) || Object.keys(expected).length !== 4) {
    const reason = !expected || expected.sessionId !== actual.sessionId ? 'session' : expected.documentId !== actual.documentId ? 'document' : expected.openEpoch !== actual.openEpoch ? 'openEpoch' : 'stale';
    throw new HostError('REVISION_CONFLICT', '完整版本不匹配，请重新查询当前文档。', 409, { reason, version: actual });
  }
}
export function rejectFields(value: any, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostError('INVALID_ARGUMENT', '请求必须是对象。');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new HostError('INVALID_ARGUMENT', `未声明的请求字段：${key}`);
}
export const hostFailure = toolErrorPayload;
