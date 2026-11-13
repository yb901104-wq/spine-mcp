import { readFile } from 'node:fs/promises';
import { createMotionRuntime } from './motionRuntime.js';
import { HostError, objectHash, strictHash, type DocumentKind } from './hostContracts.js';
import type { HostDocument } from './hostDocumentStore.js';
import type { ToolContext } from './spineJson.js';
import { resolveWorkspacePath } from './spineJson.js';
import { captureRuntimeState } from './captureEvidence.js';

export interface HostViewSelection { animation: string | null; time: number }
export const hasView = (args: any) => Object.hasOwn(args, 'animation') || Object.hasOwn(args, 'time');
export const playbackInputHash = (kind: DocumentKind, document: any, view: HostViewSelection) => objectHash({ kind, document, view });
export function animationCatalog(kind: DocumentKind, value: any, json: any, atlas: string) {
  if (kind === 'motion') return value.version === 2 ? [{ name: value.name, duration: value.duration }] : [];
  const runtime = createMotionRuntime(json, atlas);
  return runtime.data.animations.map(animation => ({ name: animation.name, duration: animation.duration }));
}
export function selectView(kind: DocumentKind, args: any, animations: Array<{ name: string; duration: number }>, enabled: boolean): HostViewSelection | null {
  if (!hasView(args)) return null;
  if (kind === 'pose') throw new HostError('INVALID_ARGUMENT', 'pose 使用自身记录时间，不接受动画/时间选择参数。');
  if (!enabled) throw new HostError('CAPABILITY_MISSING', '当前 profile 未开放 motion/skeleton 呈现。', 409);
  if (!Object.hasOwn(args, 'animation') || !Object.hasOwn(args, 'time') || !Number.isFinite(args.time) || args.time < 0 || args.animation !== null && (typeof args.animation !== 'string' || !args.animation))
    throw new HostError('INVALID_ARGUMENT', '须显式成对提供 animation（名称或 null）与非负有限 time。');
  if (args.animation === null) {
    if (kind !== 'skeleton' || args.time !== 0) throw new HostError('INVALID_ARGUMENT', '仅 skeleton 的 animation:null、time:0 表示 setup 呈现。');
  } else {
    const entry = animations.find(animation => animation.name === args.animation);
    if (!entry || args.time > entry.duration) throw new HostError('INVALID_ARGUMENT', '动画名称不存在或时间超出该动画区间，不自动选择或循环取模。');
  }
  return { animation: args.animation, time: args.time };
}
export function assertViewRequest(doc: HostDocument, args: any, enabled: boolean) {
  if (doc.kind === 'pose') {
    if (Object.hasOwn(args, 'animation') || args.time !== undefined && (!Number.isFinite(args.time) || args.time !== doc.value.frame.time))
      throw new HostError('INVALID_ARGUMENT', '单 pose 不接受 animation，只允许其记录的时间。');
    return;
  }
  if (!enabled) throw new HostError('UNSUPPORTED_DOC_KIND', '当前 profile 未开放该文档的呈现。', 409);
  if (!doc.view) throw new HostError('VIEW_NOT_SELECTED', '先通过 spine_host_open 显式选择 animation/time；没有默认动画。', 409);
  if (Object.hasOwn(args, 'animation') && args.animation !== doc.view.animation || args.time !== undefined && args.time !== doc.view.time)
    throw new HostError('VIEW_SELECTION_MISMATCH', '请求与活动动画/时间不一致；请携带当前完整版本显式重新打开选择。', 409);
}
export function assertPlaybackSelection(doc:HostDocument){
  const live = doc.derived?.live;
  if (!live || !doc.view || live.animation !== doc.view.animation || live.time !== doc.view.time) throw new HostError('NO_SOLUTION', '缺少当前动画/时间的已发布候选。', 409);
  return live;
}
export async function loadPlayback(doc: HostDocument, context: ToolContext) {
  const live=assertPlaybackSelection(doc);
  const raw = await readLiveFile(doc, context);
  const runtime = createMotionRuntime(JSON.parse(raw.toString()), doc.atlasRaw);
  const skeleton = runtime.sample(live.animation ?? undefined, live.time, doc.mapping?.skin);
  return { runtime, skeleton, actual: captureRuntimeState(skeleton) };
}
export async function readLiveFile(doc: HostDocument, context: ToolContext) {
  const live = doc.derived?.live;
  if (!live) throw new HostError('NO_SOLUTION', '缺少已发布的 live 候选。', 409);
  const raw = await readFile(resolveWorkspacePath(live.path, context));
  if (strictHash(raw) !== live.hash) throw new HostError('SOLUTION_STALE', '已发布候选字节发生变化。', 409);
  return raw;
}
