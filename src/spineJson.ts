import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fitCubicBezierTimeline } from "./motionMath.js";
import { getWorkspaceRoot } from "./workspaceTools.js";
import { realpathSync, existsSync, lstatSync } from 'node:fs';
import { withFileLock } from './jobTools.js';
import { withWorkspaceWrite } from './writerOwnership.js';
import { checkpoint } from './taskControl.js';
import { cachedDocument,invalidate } from './runtimeCache.js';

export const SUPPORTED_SPINE_VERSION = "4.1.24";
export const OFFICIAL_JSON_SPEC_URL = "https://esotericsoftware.com/spine-json-format#JSON-export-format";

type JsonObject = Record<string, any>;
type BoneTimeline = "rotate" | "translate" | "scale" | "shear";
type SlotTimeline = "attachment";
type TargetType = "bone" | "slot" | "drawOrder" | "draworder";

export interface ToolContext {
  workspaceRoot?: string;
  backupRoot?: string;
  projectId?: string;
}

export interface SpineDocument {
  filePath: string;
  absolutePath: string;
  hash: string;
  json: JsonObject;
}

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  version: string | null;
  writable: boolean;
  issues: ValidationIssue[];
}

export interface JsonDiff {
  path: string;
  before: unknown;
  after: unknown;
}

export interface WriteOptions {
  dryRun?: boolean;
  expectedHash?: string;
  allowUnsupportedVersion?: boolean;
}

export interface WriteResult {
  dryRun: boolean;
  filePath: string;
  hashBefore: string;
  hashAfter: string | null;
  backupPath: string | null;
  affectedPaths: string[];
  diff: JsonDiff[];
  message: string;
  summary: WriteSummary;
  validation: ValidationResult;
  operationValidation: OperationValidationResult;
  officialSpecValidation: OfficialSpecValidationResult;
}

export interface TimeRange {
  start?: number;
  end?: number;
}

export interface TimelineTargetFilter {
  targetType: TargetType;
  names?: string[];
  timelines?: string[];
}

export interface PoseKeyframeInput {
  time: number;
  bones?: Record<string, {
    rotate?: number;
    translate?: { x?: number; y?: number };
    scale?: { x?: number; y?: number };
    shear?: { x?: number; y?: number };
  }>;
  slots?: Record<string, { attachmentName: string | null }>;
  curve?: string | number[];
}

interface TimelineRef {
  targetType: "bone" | "slot" | "drawOrder";
  targetName: string;
  timeline: string;
  keyframes: JsonObject[];
  path: string;
}

interface WriteGuard {
  operation: string;
  allowedPathPatterns: RegExp[];
}

export interface WriteSummary {
  operation: string;
  diffEntryCount: number;
  changedPathCount: number;
  changedTopLevelPaths: string[];
  changedKeyframeCount: number;
  wroteFile: boolean;
  nextStep: string;
}

export interface OperationValidationResult {
  ok: boolean;
  operation: string;
  allowedPathPatterns: string[];
  checkedPathCount: number;
  rejectedPaths: string[];
}

export interface TimelineSpecSummary {
  targetType: "bone" | "slot" | "drawOrder";
  timeline: string;
  naturalOperation: string;
  officialFields: string[];
  spine4124Fields: string[];
  allowedKeys: string[];
  writablePath: string;
  note: string;
}

export interface OfficialSpecValidationResult {
  ok: boolean;
  source: string;
  supportedVersion: string;
  checkedTimelineCount: number;
  checkedKeyframeCount: number;
  rulesApplied: string[];
  issues: ValidationIssue[];
}

const EPSILON = 0.000001;
const ANIMATION_SUBTREE_PATTERN = /^\/animations\/[^/]+(?:\/.*)?$/;
const BONE_TIMELINES = ["rotate", "translate", "scale", "shear"] as const;
const SLOT_TIMELINES = ["attachment"] as const;
const DRAW_ORDER_TIMELINES = ["drawOrder", "draworder"] as const;

const WRITABLE_TIMELINE_SPECS: TimelineSpecSummary[] = [
  {
    targetType: "bone",
    timeline: "rotate",
    naturalOperation: "旋转骨骼。",
    officialFields: ["time", "angle", "curve"],
    spine4124Fields: ["time", "value", "curve"],
    allowedKeys: ["time", "value", "curve"],
    writablePath: "/animations/*/bones/*/rotate",
    note: "官方在线文档的 rotate 示例字段常写作 angle；当前 4.1.24 样本导出使用 value，V1 写入按 4.1.24 适配为 value。",
  },
  {
    targetType: "bone",
    timeline: "translate",
    naturalOperation: "平移骨骼。",
    officialFields: ["time", "x", "y", "curve"],
    spine4124Fields: ["time", "x", "y", "curve"],
    allowedKeys: ["time", "x", "y", "curve"],
    writablePath: "/animations/*/bones/*/translate",
    note: "x/y 至少写入一个；未写入的轴由 Spine 按默认或上一关键帧处理。",
  },
  {
    targetType: "bone",
    timeline: "scale",
    naturalOperation: "缩放骨骼。",
    officialFields: ["time", "x", "y", "curve"],
    spine4124Fields: ["time", "x", "y", "curve"],
    allowedKeys: ["time", "x", "y", "curve"],
    writablePath: "/animations/*/bones/*/scale",
    note: "x/y 至少写入一个；V1 不修改 setup pose 中的 scaleX/scaleY。",
  },
  {
    targetType: "bone",
    timeline: "shear",
    naturalOperation: "错切骨骼。",
    officialFields: ["time", "x", "y", "curve"],
    spine4124Fields: ["time", "x", "y", "curve"],
    allowedKeys: ["time", "x", "y", "curve"],
    writablePath: "/animations/*/bones/*/shear",
    note: "x/y 至少写入一个；底层写入局部值，世界坐标由 runtime 采样层计算。",
  },
  {
    targetType: "slot",
    timeline: "attachment",
    naturalOperation: "切换或隐藏插槽附件。",
    officialFields: ["time", "name"],
    spine4124Fields: ["time", "name"],
    allowedKeys: ["time", "name"],
    writablePath: "/animations/*/slots/*/attachment",
    note: "没有 name 字段表示隐藏附件；有 name 时必须能在 skins 中找到对应 slot 的 attachment。",
  },
  {
    targetType: "drawOrder",
    timeline: "drawOrder",
    naturalOperation: "调整插槽绘制顺序。",
    officialFields: ["time", "offsets"],
    spine4124Fields: ["time", "offsets"],
    allowedKeys: ["time", "offsets"],
    writablePath: "/animations/*/drawOrder",
    note: "offsets 使用官方结构 { slot, offset }；slot 必须引用现有插槽。",
  },
  {
    targetType: "drawOrder",
    timeline: "draworder",
    naturalOperation: "调整插槽绘制顺序。",
    officialFields: ["time", "offsets"],
    spine4124Fields: ["time", "offsets"],
    allowedKeys: ["time", "offsets"],
    writablePath: "/animations/*/draworder",
    note: "兼容部分导出中的 draworder 小写字段；新写入优先使用已有字段，否则使用 drawOrder。",
  },
];

export async function readSpineDocument(filePath: string, context: ToolContext = {}): Promise<SpineDocument> {
  const absolutePath = resolveWorkspacePath(filePath, context);
  let loaded:Awaited<ReturnType<typeof cachedDocument>>;
  try {
    loaded = await cachedDocument(absolutePath);
  } catch (error) {
    throw new Error(`Invalid JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    filePath,
    absolutePath,
    hash: loaded.hash,
    json:loaded.json,
  };
}

export function resolveWorkspacePath(filePath: string, context: ToolContext = {}): string {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("filePath must be a non-empty string.");
  }
  const workspaceRoot = path.resolve(context.workspaceRoot ?? getWorkspaceRoot(context.projectId));
  const absolutePath = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`filePath must stay inside workspace root: ${workspaceRoot}`);
  }
  let ancestor = absolutePath;
  let ancestorStat: ReturnType<typeof lstatSync>;
  while (true) {
    try { ancestorStat=lstatSync(ancestor); break; }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
  }
  // 断开的符号链接也必须拒绝；existsSync 会把它当作「尚不存在」，写入时可能跟随到根外。
  if (ancestorStat.isSymbolicLink() && !existsSync(ancestor)) throw new Error('路径包含断开的符号链接，无法确认工作区边界。');
  // 原生 realpath 仍逐次核验实际目标；避免 JS 实现为每个路径分量重复执行 lstat。
  const realRelative = path.relative(realpathSync.native(workspaceRoot), realpathSync.native(ancestor));
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('路径符号链接越过工作区边界。');
  return absolutePath;
}

export function getDocumentSummary(document: SpineDocument) {
  const json = document.json;
  const version = getVersion(json);
  const animations = Object.keys(json.animations ?? {});
  return {
    filePath: document.filePath,
    absolutePath: document.absolutePath,
    hash: document.hash,
    version,
    supportedVersion: SUPPORTED_SPINE_VERSION,
    writable: version === SUPPORTED_SPINE_VERSION,
    topKeys: Object.keys(json),
    counts: {
      bones: asArray(json.bones).length,
      slots: asArray(json.slots).length,
      skins: getSkinEntries(json).length,
      animations: animations.length,
      events: json.events && typeof json.events === "object" ? Object.keys(json.events).length : 0,
      transformConstraints: asArray(json.transform).length,
      ikConstraints: asArray(json.ik).length,
      pathConstraints: asArray(json.path).length,
    },
  };
}

export function getSkeletonHierarchy(document: SpineDocument, includeSetupPose = false) {
  const bones = asArray(document.json.bones);
  const byParent = new Map<string | null, JsonObject[]>();
  for (const bone of bones) {
    const parent = typeof bone.parent === "string" ? bone.parent : null;
    const children = byParent.get(parent) ?? [];
    children.push(bone);
    byParent.set(parent, children);
  }

  const toNode = (bone: JsonObject): JsonObject => {
    const node: JsonObject = {
      name: bone.name,
      parent: bone.parent ?? null,
      children: (byParent.get(bone.name) ?? []).map(toNode),
    };
    if (includeSetupPose) {
      node.setupPose = {
        x: bone.x ?? 0,
        y: bone.y ?? 0,
        rotation: bone.rotation ?? 0,
        scaleX: bone.scaleX ?? 1,
        scaleY: bone.scaleY ?? 1,
        shearX: bone.shearX ?? 0,
        shearY: bone.shearY ?? 0,
        length: bone.length ?? 0,
      };
    }
    return node;
  };

  const roots = bones.filter((bone) => !bone.parent).map(toNode);
  return {
    boneCount: bones.length,
    roots,
  };
}

export function getSlots(document: SpineDocument) {
  return {
    slotCount: asArray(document.json.slots).length,
    slots: asArray(document.json.slots).map((slot, index) => ({
      index,
      name: slot.name,
      bone: slot.bone,
      attachment: slot.attachment ?? null,
      color: slot.color,
      dark: slot.dark,
      blend: slot.blend,
    })),
  };
}

export function getSkins(document: SpineDocument, includeAttachments = false) {
  const skins = getSkinEntries(document.json).map((skin) => {
    const slots = Object.entries(skin.attachments ?? {}).map(([slotName, attachments]) => {
      const attachmentEntries = Object.entries((attachments as JsonObject) ?? {});
      return {
        slot: slotName,
        attachmentCount: attachmentEntries.length,
        attachments: includeAttachments
          ? attachmentEntries.map(([name, attachment]) => ({
              name,
              type: ((attachment as JsonObject).type as string | undefined) ?? "region",
              path: (attachment as JsonObject).name ?? null,
            }))
          : undefined,
      };
    });
    return {
      name: skin.name,
      slotCount: slots.length,
      attachmentCount: slots.reduce((sum, slot) => sum + slot.attachmentCount, 0),
      slots: includeAttachments ? slots : undefined,
    };
  });
  return { skinCount: skins.length, skins };
}

export function getAnimations(document: SpineDocument) {
  const animations = Object.entries((document.json.animations as JsonObject | undefined) ?? {}).map(([name, animation]) => ({
    name,
    duration: estimateDuration(animation as JsonObject),
    timelineTypes: collectTimelineTypeCounts(animation as JsonObject),
  }));
  return {
    animationCount: animations.length,
    animations,
  };
}

export function getAnimationTimelines(
  document: SpineDocument,
  animationName: string,
  targetType?: string,
  targetName?: string,
) {
  const animation = getAnimation(document.json, animationName);
  const result: JsonObject = {
    animation: animationName,
    duration: estimateDuration(animation),
    targets: [],
  };

  const includeBone = !targetType || targetType === "bone";
  const includeSlot = !targetType || targetType === "slot";
  const includeDrawOrder = !targetType || targetType === "drawOrder" || targetType === "draworder";

  if (includeBone) {
    for (const [bone, timelines] of Object.entries((animation.bones as JsonObject | undefined) ?? {})) {
      if (targetName && bone !== targetName) continue;
      result.targets.push({
        targetType: "bone",
        targetName: bone,
        timelines: summarizeTimelineMap(timelines as JsonObject),
        raw: timelines,
      });
    }
  }

  if (includeSlot) {
    for (const [slot, timelines] of Object.entries((animation.slots as JsonObject | undefined) ?? {})) {
      if (targetName && slot !== targetName) continue;
      result.targets.push({
        targetType: "slot",
        targetName: slot,
        timelines: summarizeTimelineMap(timelines as JsonObject),
        raw: timelines,
      });
    }
  }

  if (includeDrawOrder) {
    const key = getDrawOrderKey(animation);
    if (key && (!targetName || targetName === key)) {
      result.targets.push({
        targetType: "drawOrder",
        targetName: key,
        timelines: summarizeTimelineArray(animation[key]),
        raw: animation[key],
      });
    }
  }

  return result;
}

export function getAnimationSheet(
  document: SpineDocument,
  animationName: string,
  targetType?: TargetType,
  targetName?: string,
) {
  const animation = getAnimation(document.json, animationName);
  const targets = targetType ? [{ targetType, names: targetName ? [targetName] : undefined }] : undefined;
  const rows = collectTimelineRefs(animation, animationName, targets).flatMap((ref) => ref.keyframes.map((keyframe, index) => ({
    targetType: ref.targetType,
    targetName: ref.targetName,
    timeline: ref.timeline,
    index,
    time: keyframe.time ?? 0,
    value: keyframeValue(ref.timeline, keyframe),
    curve: keyframe.curve,
    path: `${ref.path}/${index}`,
  })));

  return {
    animation: animationName,
    duration: estimateDuration(animation),
    rowCount: rows.length,
    rows,
  };
}

export function getOfficialSpecSummary() {
  return {
    source: OFFICIAL_JSON_SPEC_URL,
    supportedVersion: SUPPORTED_SPINE_VERSION,
    scope: "当前 MCP 只把官方 JSON 规范中的动画时间线子集做成可写规则；未纳入的字段保持只读保留。",
    writePolicy: [
      "写入前先校验输入参数。",
      "写入后对真实 JSON diff 做白名单审查。",
      "写入后对当前可写 timeline 子集做官方规范审查。",
      "官方在线文档和 Spine 4.1.24 样本存在字段差异时，按 4.1.24 版本适配规则写入，并在规则中记录差异。",
    ],
    writableTimelineSpecs: WRITABLE_TIMELINE_SPECS,
  };
}

export async function createAnimation(
  filePath: string,
  args: {
    animation: string;
    overwrite?: boolean;
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_create_animation"), (json, diff) => {
    assertAnimationName(args.animation);
    json.animations ??= {};
    if (json.animations[args.animation] && !args.overwrite) {
      throw new Error(`动画 '${args.animation}' 已存在。若要覆盖，请传 overwrite: true。`);
    }
    const pathBase = `/animations/${escapePath(args.animation)}`;
    const before = deepClone(json.animations[args.animation] ?? null);
    json.animations[args.animation] = {};
    diff.push({ path: pathBase, before, after: {} });
    return `已创建空动画 '${args.animation}'。`;
  });
}

export async function cloneAnimation(
  filePath: string,
  args: {
    sourceAnimation: string;
    targetAnimation: string;
    overwrite?: boolean;
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_clone_animation"), (json, diff) => {
    assertAnimationName(args.targetAnimation);
    const source = getAnimation(json, args.sourceAnimation);
    json.animations ??= {};
    if (json.animations[args.targetAnimation] && !args.overwrite) {
      throw new Error(`目标动画 '${args.targetAnimation}' 已存在。若要覆盖，请传 overwrite: true。`);
    }
    const pathBase = `/animations/${escapePath(args.targetAnimation)}`;
    const before = deepClone(json.animations[args.targetAnimation] ?? null);
    json.animations[args.targetAnimation] = deepClone(source);
    diff.push({ path: pathBase, before, after: deepClone(json.animations[args.targetAnimation]) });
    return `已将动画 '${args.sourceAnimation}' 复制为 '${args.targetAnimation}'。`;
  });
}

export async function deleteAnimation(
  filePath: string,
  args: {
    animation: string;
    confirm?: boolean;
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_delete_animation"), (json, diff) => {
    if (!args.confirm) throw new Error("删除动画属于高风险操作，必须显式传 confirm: true。");
    const animation = getAnimation(json, args.animation);
    const pathBase = `/animations/${escapePath(args.animation)}`;
    diff.push({ path: pathBase, before: deepClone(animation), after: null });
    delete json.animations[args.animation];
    return `已删除动画 '${args.animation}'。`;
  });
}

export async function shiftKeyframes(
  filePath: string,
  args: {
    animation: string;
    range?: TimeRange;
    targets?: TimelineTargetFilter[];
    deltaTime: number;
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_shift_keyframes"), (json, diff) => {
    if (!Number.isFinite(args.deltaTime)) throw new Error("deltaTime 必须是数字。");
    assertWritableTargetFilters(args.targets);
    const animation = getAnimation(json, args.animation);
    let changed = 0;
    for (const ref of collectTimelineRefs(animation, args.animation, args.targets)) {
      const before = deepClone(ref.keyframes);
      for (const keyframe of ref.keyframes) {
        const time = keyframe.time ?? 0;
        if (!timeInRange(time, args.range)) continue;
        const nextTime = normalizeTime(time + args.deltaTime);
        if (nextTime < 0) throw new Error(`时间平移后出现负数：${ref.path} ${time} -> ${nextTime}`);
        setKeyframeTime(keyframe, nextTime);
        changed++;
      }
      normalizeTimeline(ref.keyframes);
      pushDiffIfChanged(diff, ref.path, before, ref.keyframes);
    }
    return `已平移动画 '${args.animation}' 的 ${changed} 个关键帧，deltaTime=${args.deltaTime}。`;
  });
}

export async function scaleKeyframeTimes(
  filePath: string,
  args: {
    animation: string;
    range?: TimeRange;
    originTime: number;
    scale: number;
    targets?: TimelineTargetFilter[];
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_scale_keyframe_times"), (json, diff) => {
    if (!Number.isFinite(args.originTime) || args.originTime < 0) throw new Error("originTime 必须是非负数字。");
    if (!Number.isFinite(args.scale) || args.scale <= 0) throw new Error("scale 必须是大于 0 的数字。");
    assertWritableTargetFilters(args.targets);
    const animation = getAnimation(json, args.animation);
    let changed = 0;
    for (const ref of collectTimelineRefs(animation, args.animation, args.targets)) {
      const before = deepClone(ref.keyframes);
      for (const keyframe of ref.keyframes) {
        const time = keyframe.time ?? 0;
        if (!timeInRange(time, args.range)) continue;
        const nextTime = normalizeTime(args.originTime + (time - args.originTime) * args.scale);
        if (nextTime < 0) throw new Error(`时间缩放后出现负数：${ref.path} ${time} -> ${nextTime}`);
        setKeyframeTime(keyframe, nextTime);
        changed++;
      }
      normalizeTimeline(ref.keyframes);
      pushDiffIfChanged(diff, ref.path, before, ref.keyframes);
    }
    return `已缩放动画 '${args.animation}' 的 ${changed} 个关键帧时间，originTime=${args.originTime}，scale=${args.scale}。`;
  });
}

export async function deleteKeyframeRange(
  filePath: string,
  args: {
    animation: string;
    range: TimeRange;
    targets?: TimelineTargetFilter[];
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_delete_keyframe_range"), (json, diff) => {
    requireRange(args.range);
    assertWritableTargetFilters(args.targets);
    const animation = getAnimation(json, args.animation);
    let removed = 0;
    for (const ref of collectTimelineRefs(animation, args.animation, args.targets)) {
      const before = deepClone(ref.keyframes);
      const kept = ref.keyframes.filter((keyframe) => {
        const shouldRemove = timeInRange(keyframe.time ?? 0, args.range);
        if (shouldRemove) removed++;
        return !shouldRemove;
      });
      ref.keyframes.length = 0;
      ref.keyframes.push(...kept);
      pushDiffIfChanged(diff, ref.path, before, ref.keyframes);
    }
    return `已删除动画 '${args.animation}' 中 ${removed} 个范围内关键帧。`;
  });
}

export async function copyKeyframeRange(
  filePath: string,
  args: {
    sourceAnimation: string;
    targetAnimation: string;
    sourceRange: TimeRange;
    targetStartTime: number;
    targets?: TimelineTargetFilter[];
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_copy_keyframe_range"), (json, diff) => {
    requireRange(args.sourceRange);
    if (!Number.isFinite(args.targetStartTime) || args.targetStartTime < 0) throw new Error("targetStartTime 必须是非负数字。");
    assertWritableTargetFilters(args.targets);
    const source = getAnimation(json, args.sourceAnimation);
    json.animations ??= {};
    json.animations[args.targetAnimation] ??= {};
    const target = json.animations[args.targetAnimation];
    const sourceStart = args.sourceRange.start ?? 0;
    let copied = 0;

    for (const ref of collectTimelineRefs(source, args.sourceAnimation, args.targets)) {
      const targetRef = ensureTimelineRef(target, args.targetAnimation, ref.targetType, ref.targetName, ref.timeline);
      const before = deepClone(targetRef.keyframes);
      for (const keyframe of ref.keyframes) {
        const time = keyframe.time ?? 0;
        if (!timeInRange(time, args.sourceRange)) continue;
        const clone = deepClone(keyframe);
        setKeyframeTime(clone, normalizeTime(args.targetStartTime + (time - sourceStart)));
        upsertKeyframe(targetRef.keyframes, clone.time ?? 0, clone);
        copied++;
      }
      normalizeTimeline(targetRef.keyframes);
      pushDiffIfChanged(diff, targetRef.path, before, targetRef.keyframes);
    }
    return `已从动画 '${args.sourceAnimation}' 复制 ${copied} 个关键帧到 '${args.targetAnimation}'。`;
  });
}

export async function applyPoseKeyframes(
  filePath: string,
  args: {
    animation: string;
  } & PoseKeyframeInput & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_apply_pose_keyframes"), (json, diff) => {
    const animation = getAnimation(json, args.animation);
    const changed = applyPoseToAnimation(json, animation, args.animation, args, diff);

    return `已在动画 '${args.animation}' 的 ${args.time}s 批量写入 ${changed} 条姿态关键帧。`;
  });
}

export async function applyPoseSequence(
  filePath: string,
  args: {
    animation: string;
    overwrite?: boolean;
    duration?: number;
    closeLoop?: boolean;
    poses: PoseKeyframeInput[];
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_apply_pose_sequence"), (json, diff) => {
    assertAnimationName(args.animation);
    if (!Array.isArray(args.poses) || args.poses.length === 0) throw new Error("poses 必须是非空数组。");
    if (args.duration !== undefined && (!Number.isFinite(args.duration) || args.duration < 0)) throw new Error("duration 必须是非负数字。");

    const poses = args.poses.map((pose) => normalizePoseInput(pose, args.duration));
    poses.sort((a, b) => a.time - b.time);

    if (args.closeLoop) {
      if (args.duration === undefined) throw new Error("closeLoop: true 时必须传 duration。");
      const firstPose = poses.find((pose) => sameTime(pose.time, 0));
      if (!firstPose) throw new Error("closeLoop: true 时必须包含 time=0 的首帧姿态。");
      const closingPose = deepClone(firstPose);
      closingPose.time = args.duration;
      delete closingPose.curve;
      poses.push(closingPose);
      poses.sort((a, b) => a.time - b.time);
    }

    json.animations ??= {};
    if (json.animations[args.animation] && !args.overwrite) {
      throw new Error(`动画 '${args.animation}' 已存在。若要覆盖，请传 overwrite: true。`);
    }

    json.animations[args.animation] = {};
    const animation = json.animations[args.animation];
    let changed = 0;
    for (const pose of poses) {
      changed += applyPoseToAnimation(json, animation, args.animation, pose, diff);
    }

    const uniquePoseTimes = [...new Set(poses.map((pose) => normalizeTime(pose.time)))].length;
    return `已在动画 '${args.animation}' 中一次性写入 ${uniquePoseTimes} 个姿态时间点、${changed} 条关键帧。`;
  });
}

export async function fitAnimationCurves(
  filePath: string,
  args: { animation: string; rotationTolerance?: number; translationTolerance?: number; vertexTolerance?: number; atlasPath?: string; skin?: string; useCurves?: boolean } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult & { curveFitReport: any }> {
  let report: any;
  const result = await writeTransaction(filePath, args, context, animationOnlyGuard("spine_fit_animation_curves"), async (json, diff) => {
    const fitted = await (await import('./runtimeCurveFit.js')).fitRuntimeAnimation(json,args.animation,{...args,useCurves:args.useCurves??false},context);
    report=fitted.report;
    const before=deepClone(json.animations[args.animation]);json.animations[args.animation]=fitted.animation;
    pushDiffIfChanged(diff,`/animations/${escapePath(args.animation)}`,before,fitted.animation);
    return `已拟合 '${args.animation}'，关键帧 ${report.originalCount} → ${report.compressedCount}，runtime 验证=${report.runtimeVerified}。`;
  });
  return {...result,curveFitReport:report};
}

/** 完整动画结果通过已有事务层提交；求解层不直接写 Spine 文件。 */
export async function writeGeneratedAnimation(filePath: string, args: { animation: string; value: JsonObject; overwrite?: boolean } & WriteOptions, context: ToolContext = {}) {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_retarget_motion"), (json, diff) => {
    json.animations ??= {};
    if (json.animations[args.animation] && !args.overwrite) throw new Error(`动画 '${args.animation}' 已存在。若要覆盖，请传 overwrite: true。`);
    const before = json.animations[args.animation];
    json.animations[args.animation] = deepClone(args.value);
    diff.push({ path: `/animations/${escapePath(args.animation)}`, before, after: deepClone(args.value) });
    return `已提交求解完成的动画 '${args.animation}'。`;
  });
}

function reduceTimeline(frames: JsonObject[], tolerance: number) {
  if (frames.length < 3) return frames;
  const keep = [frames[0]];
  for (let i = 1; i < frames.length - 1; i++) {
    const previous = keep[keep.length - 1];
    const next = frames[i + 1];
    const t0 = previous.time ?? 0; const t1 = next.time ?? 0; const t = frames[i].time ?? 0;
    const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    const error = ["value", "x", "y"].reduce((max, key) => {
      if (frames[i][key] === undefined || previous[key] === undefined || next[key] === undefined) return max;
      const expected = previous[key] + (next[key] - previous[key]) * u;
      return Math.max(max, Math.abs(frames[i][key] - expected));
    }, 0);
    if (error > tolerance) keep.push(frames[i]);
  }
  keep.push(frames[frames.length - 1]);
  return keep.map((frame) => { const next = deepClone(frame); delete next.curve; return next; });
}

function applyPoseToAnimation(
  json: JsonObject,
  animation: JsonObject,
  animationName: string,
  pose: PoseKeyframeInput,
  diff: JsonDiff[],
) {
  const normalizedPose = normalizePoseInput(pose);
  let changed = 0;

  for (const [bone, bonePose] of Object.entries(normalizedPose.bones ?? {})) {
    requireKnownBone(json, bone);
    for (const timeline of BONE_TIMELINES) {
      const value = bonePose[timeline];
      if (value === undefined) continue;
      const ref = ensureTimelineRef(animation, animationName, "bone", bone, timeline);
      const before = deepClone(ref.keyframes);
      upsertKeyframe(ref.keyframes, normalizedPose.time, buildBoneKeyframe(timeline, normalizedPose.time, value, normalizedPose.curve));
      pushDiffIfChanged(diff, ref.path, before, ref.keyframes);
      changed++;
    }
  }

  for (const [slot, slotPose] of Object.entries(normalizedPose.slots ?? {})) {
    requireKnownSlot(json, slot);
    if (slotPose.attachmentName !== null) requireKnownAttachment(json, slot, slotPose.attachmentName);
    const ref = ensureTimelineRef(animation, animationName, "slot", slot, "attachment");
    const before = deepClone(ref.keyframes);
    const keyframe: JsonObject = sameTime(normalizedPose.time, 0) ? {} : { time: normalizedPose.time };
    if (slotPose.attachmentName !== null) keyframe.name = slotPose.attachmentName;
    upsertKeyframe(ref.keyframes, normalizedPose.time, keyframe);
    pushDiffIfChanged(diff, ref.path, before, ref.keyframes);
    changed++;
  }

  return changed;
}

function normalizePoseInput(pose: PoseKeyframeInput, duration?: number): PoseKeyframeInput {
  if (!pose || typeof pose !== "object" || Array.isArray(pose)) throw new Error("pose 必须是对象。");
  if (!Number.isFinite(pose.time) || pose.time < 0) throw new Error("pose.time 必须是非负数字。");
  if (duration !== undefined && pose.time - EPSILON > duration) throw new Error(`pose.time 不能超过 duration：${pose.time} > ${duration}`);
  if (pose.curve !== undefined) assertCurveValue(pose.curve);

  for (const [bone, bonePose] of Object.entries(pose.bones ?? {})) {
    if (!bonePose || typeof bonePose !== "object" || Array.isArray(bonePose)) throw new Error(`bones.${bone} 必须是对象。`);
    for (const timeline of BONE_TIMELINES) {
      const value = bonePose[timeline];
      if (value === undefined) continue;
      if (timeline === "rotate") {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`bones.${bone}.rotate 必须是数字。`);
      } else {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`bones.${bone}.${timeline} 必须是包含 x/y 的对象。`);
        const vector = value as { x?: number; y?: number };
        if (vector.x === undefined && vector.y === undefined) throw new Error(`bones.${bone}.${timeline} 必须至少包含 x 或 y。`);
        if (vector.x !== undefined && (typeof vector.x !== "number" || !Number.isFinite(vector.x))) throw new Error(`bones.${bone}.${timeline}.x 必须是数字。`);
        if (vector.y !== undefined && (typeof vector.y !== "number" || !Number.isFinite(vector.y))) throw new Error(`bones.${bone}.${timeline}.y 必须是数字。`);
      }
    }
  }

  for (const [slot, slotPose] of Object.entries(pose.slots ?? {})) {
    if (!slotPose || typeof slotPose !== "object" || Array.isArray(slotPose)) throw new Error(`slots.${slot} 必须是对象。`);
    if (!("attachmentName" in slotPose)) throw new Error(`slots.${slot}.attachmentName 是必填字段，可为字符串或 null。`);
    if (slotPose.attachmentName !== null && typeof slotPose.attachmentName !== "string") throw new Error(`slots.${slot}.attachmentName 必须是字符串或 null。`);
  }

  return {
    ...pose,
    time: normalizeTime(pose.time),
  };
}

function assertCurveValue(curve: string | number[]) {
  if (curve === "stepped") return;
  if (Array.isArray(curve) && curve.length >= 4 && curve.length % 2 === 0 && curve.every((value) => typeof value === "number" && Number.isFinite(value))) return;
  throw new Error("curve 必须是 'stepped' 或至少 4 个数字组成的偶数长度数组。");
}

export async function offsetBoneTimelineValues(
  filePath: string,
  args: {
    animation: string;
    bones: string[];
    timeline: BoneTimeline;
    range?: TimeRange;
    offset?: number | { x?: number; y?: number };
    scale?: number | { x?: number; y?: number };
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_offset_bone_timeline_values"), (json, diff) => {
    if (!Array.isArray(args.bones) || args.bones.length === 0) throw new Error("bones 必须是非空数组。");
    for (const bone of args.bones) requireKnownBone(json, bone);
    const animation = getAnimation(json, args.animation);
    let changed = 0;

    for (const ref of collectTimelineRefs(animation, args.animation, [{
      targetType: "bone",
      names: args.bones,
      timelines: [args.timeline],
    }])) {
      const before = deepClone(ref.keyframes);
      for (const keyframe of ref.keyframes) {
        if (!timeInRange(keyframe.time ?? 0, args.range)) continue;
        if (applyValueOffsetAndScale(keyframe, args.timeline, args.offset, args.scale)) changed++;
      }
      pushDiffIfChanged(diff, ref.path, before, ref.keyframes);
    }
    return `已批量调整动画 '${args.animation}' 中 ${changed} 个 '${args.timeline}' 关键帧数值。`;
  });
}

export async function makeLoop(
  filePath: string,
  args: {
    animation: string;
    sourceTime: number;
    targetTime: number;
    targets?: TimelineTargetFilter[];
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_make_loop"), (json, diff) => {
    if (!Number.isFinite(args.sourceTime) || args.sourceTime < 0) throw new Error("sourceTime 必须是非负数字。");
    if (!Number.isFinite(args.targetTime) || args.targetTime < 0) throw new Error("targetTime 必须是非负数字。");
    assertWritableTargetFilters(args.targets);
    const animation = getAnimation(json, args.animation);
    let copied = 0;
    for (const ref of collectTimelineRefs(animation, args.animation, args.targets)) {
      const source = ref.keyframes.find((keyframe) => sameTime(keyframe.time ?? 0, args.sourceTime));
      if (!source) continue;
      const before = deepClone(ref.keyframes);
      const clone = deepClone(source);
      setKeyframeTime(clone, args.targetTime);
      upsertKeyframe(ref.keyframes, args.targetTime, clone);
      normalizeTimeline(ref.keyframes);
      pushDiffIfChanged(diff, ref.path, before, ref.keyframes);
      copied++;
    }
    return `已将动画 '${args.animation}' 中 ${copied} 条 ${args.sourceTime}s 关键帧复制到 ${args.targetTime}s，用于闭合循环。`;
  });
}

export function validateSpineJson(json: JsonObject): ValidationResult {
  const issues: ValidationIssue[] = [];
  const version = getVersion(json);
  if (!version) {
    issues.push({ path: "/skeleton/spine", message: "Missing skeleton.spine version.", severity: "error" });
  }

  const bones = asArray(json.bones);
  if (!Array.isArray(json.bones)) {
    issues.push({ path: "/bones", message: "bones must be an array.", severity: "error" });
  }
  const boneNames = new Set<string>();
  bones.forEach((bone, index) => {
    if (!bone.name) {
      issues.push({ path: `/bones/${index}/name`, message: "Bone is missing name.", severity: "error" });
      return;
    }
    if (boneNames.has(bone.name)) {
      issues.push({ path: `/bones/${index}/name`, message: `Duplicate bone name '${bone.name}'.`, severity: "error" });
    }
    boneNames.add(bone.name);
  });
  bones.forEach((bone, index) => {
    if (bone.parent && !boneNames.has(bone.parent)) {
      issues.push({ path: `/bones/${index}/parent`, message: `Parent bone '${bone.parent}' does not exist.`, severity: "error" });
    }
  });

  const slots = asArray(json.slots);
  const slotNames = new Set<string>();
  slots.forEach((slot, index) => {
    if (!slot.name) {
      issues.push({ path: `/slots/${index}/name`, message: "Slot is missing name.", severity: "error" });
      return;
    }
    if (slotNames.has(slot.name)) {
      issues.push({ path: `/slots/${index}/name`, message: `Duplicate slot name '${slot.name}'.`, severity: "error" });
    }
    slotNames.add(slot.name);
    if (slot.bone && !boneNames.has(slot.bone)) {
      issues.push({ path: `/slots/${index}/bone`, message: `Slot bone '${slot.bone}' does not exist.`, severity: "error" });
    }
  });

  const attachmentIndex = buildAttachmentIndex(json);
  validateAnimations(json, boneNames, slotNames, attachmentIndex, issues);
  issues.push(...validateOfficialAnimationSpec(json).issues);

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    version,
    writable: version === SUPPORTED_SPINE_VERSION,
    issues,
  };
}

export function validateOfficialAnimationSpec(json: JsonObject): OfficialSpecValidationResult {
  const issues: ValidationIssue[] = [];
  let checkedTimelineCount = 0;
  let checkedKeyframeCount = 0;
  const rulesApplied = new Set<string>();
  const animations = json.animations;

  if (animations && typeof animations === "object" && !Array.isArray(animations)) {
    for (const [animationName, animation] of Object.entries(animations as JsonObject)) {
      const animationObject = animation as JsonObject;

      for (const [bone, timelines] of Object.entries((animationObject.bones as JsonObject | undefined) ?? {})) {
        for (const [timeline, keyframes] of Object.entries((timelines as JsonObject) ?? {})) {
          const spec = getWritableTimelineSpec("bone", timeline);
          if (!spec) continue;
          checkedTimelineCount++;
          rulesApplied.add(`${spec.targetType}.${spec.timeline}`);
          checkedKeyframeCount += validateOfficialKeyframeArray(
            keyframes,
            `/animations/${escapePath(animationName)}/bones/${escapePath(bone)}/${timeline}`,
            spec,
            issues,
          );
        }
      }

      for (const [slot, timelines] of Object.entries((animationObject.slots as JsonObject | undefined) ?? {})) {
        for (const [timeline, keyframes] of Object.entries((timelines as JsonObject) ?? {})) {
          const spec = getWritableTimelineSpec("slot", timeline);
          if (!spec) continue;
          checkedTimelineCount++;
          rulesApplied.add(`${spec.targetType}.${spec.timeline}`);
          checkedKeyframeCount += validateOfficialKeyframeArray(
            keyframes,
            `/animations/${escapePath(animationName)}/slots/${escapePath(slot)}/${timeline}`,
            spec,
            issues,
          );
        }
      }

      for (const timeline of DRAW_ORDER_TIMELINES) {
        const keyframes = animationObject[timeline];
        if (!Array.isArray(keyframes)) continue;
        const spec = getWritableTimelineSpec("drawOrder", timeline);
        if (!spec) continue;
        checkedTimelineCount++;
        rulesApplied.add(`${spec.targetType}.${spec.timeline}`);
        checkedKeyframeCount += validateOfficialKeyframeArray(
          keyframes,
          `/animations/${escapePath(animationName)}/${timeline}`,
          spec,
          issues,
        );
      }
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    source: OFFICIAL_JSON_SPEC_URL,
    supportedVersion: SUPPORTED_SPINE_VERSION,
    checkedTimelineCount,
    checkedKeyframeCount,
    rulesApplied: [...rulesApplied].sort(),
    issues,
  };
}

export async function setBoneKeyframe(
  filePath: string,
  args: {
    animation: string;
    bone: string;
    timeline: "rotate" | "translate" | "scale" | "shear";
    time: number;
    value: number | { x?: number; y?: number };
    curve?: string | number[];
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_set_bone_keyframe"), (json, diff) => {
    if (!getWritableTimelineSpec("bone", args.timeline)) throw new Error(`当前 MCP 不支持写入骨骼 timeline '${args.timeline}'。`);
    requireKnownBone(json, args.bone);
    const animation = getAnimation(json, args.animation);
    animation.bones ??= {};
    animation.bones[args.bone] ??= {};
    const timelines = animation.bones[args.bone];
    timelines[args.timeline] ??= [];
    if (!Array.isArray(timelines[args.timeline])) {
      throw new Error(`Bone timeline '${args.timeline}' must be an array.`);
    }
    const pathBase = `/animations/${escapePath(args.animation)}/bones/${escapePath(args.bone)}/${args.timeline}`;
    const before = deepClone(timelines[args.timeline]);
    const keyframe = buildBoneKeyframe(args.timeline, args.time, args.value, args.curve);
    upsertKeyframe(timelines[args.timeline], args.time, keyframe);
    diff.push({ path: pathBase, before, after: deepClone(timelines[args.timeline]) });
    return `Set ${args.timeline} keyframe on bone '${args.bone}' in animation '${args.animation}' at ${args.time}s.`;
  });
}

export async function setCurve(filePath: string, args: { animation: string; bone: string; timeline: 'rotate' | 'translate' | 'scale' | 'shear'; time: number; curve: string | number[] | null } & WriteOptions, context: ToolContext = {}) {
  return writeTransaction(filePath, args, context, animationOnlyGuard('spine_set_curve'), (json) => {
    const frames = json.animations?.[args.animation]?.bones?.[args.bone]?.[args.timeline];
    if (!Array.isArray(frames)) throw new Error('骨骼 timeline 不存在。');
    const index = frames.findIndex(f => sameTime(f.time ?? 0, args.time));
    if (index < 0) throw new Error('关键帧不存在。');
    if (args.curve !== null && index === frames.length - 1) throw new Error('最后一帧不能设置 curve。');
    if (args.curve === null) delete frames[index].curve; else frames[index].curve = args.curve;
    return '已调整现有关键帧曲线。';
  });
}

export async function setSlotAttachmentKeyframe(
  filePath: string,
  args: {
    animation: string;
    slot: string;
    time: number;
    attachmentName: string | null;
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_set_slot_attachment_keyframe"), (json, diff) => {
    if (!Number.isFinite(args.time) || args.time < 0) throw new Error("time 必须是非负数字。");
    requireKnownSlot(json, args.slot);
    if (args.attachmentName !== null) requireKnownAttachment(json, args.slot, args.attachmentName);
    const animation = getAnimation(json, args.animation);
    animation.slots ??= {};
    animation.slots[args.slot] ??= {};
    const timelines = animation.slots[args.slot];
    timelines.attachment ??= [];
    if (!Array.isArray(timelines.attachment)) {
      throw new Error("Slot attachment timeline must be an array.");
    }
    const pathBase = `/animations/${escapePath(args.animation)}/slots/${escapePath(args.slot)}/attachment`;
    const before = deepClone(timelines.attachment);
    const keyframe: JsonObject = args.time === 0 ? {} : { time: args.time };
    if (args.attachmentName !== null) keyframe.name = args.attachmentName;
    upsertKeyframe(timelines.attachment, args.time, keyframe);
    diff.push({ path: pathBase, before, after: deepClone(timelines.attachment) });
    const attachmentText = args.attachmentName === null ? "hidden attachment" : `attachment '${args.attachmentName}'`;
    return `Set slot '${args.slot}' to ${attachmentText} in animation '${args.animation}' at ${args.time}s.`;
  });
}

export async function setDrawOrderKeyframe(
  filePath: string,
  args: {
    animation: string;
    time: number;
    offsets: Array<{ slot: string; offset: number }>;
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_set_draw_order_keyframe"), (json, diff) => {
    if (!Number.isFinite(args.time) || args.time < 0) throw new Error("time 必须是非负数字。");
    for (const offset of args.offsets) requireKnownSlot(json, offset.slot);
    const animation = getAnimation(json, args.animation);
    const key = getDrawOrderKey(animation) ?? "drawOrder";
    animation[key] ??= [];
    if (!Array.isArray(animation[key])) {
      throw new Error(`${key} timeline must be an array.`);
    }
    const pathBase = `/animations/${escapePath(args.animation)}/${key}`;
    const before = deepClone(animation[key]);
    const keyframe: JsonObject = args.time === 0 ? {} : { time: args.time };
    keyframe.offsets = args.offsets.map((offset) => ({ slot: offset.slot, offset: offset.offset }));
    upsertKeyframe(animation[key], args.time, keyframe);
    diff.push({ path: pathBase, before, after: deepClone(animation[key]) });
    return `Set draw order keyframe in animation '${args.animation}' at ${args.time}s with ${args.offsets.length} offsets.`;
  });
}

export async function removeKeyframe(
  filePath: string,
  args: {
    animation: string;
    targetType: "bone" | "slot" | "drawOrder" | "draworder";
    targetName?: string;
    timeline: string;
    time: number;
  } & WriteOptions,
  context: ToolContext = {},
): Promise<WriteResult> {
  return writeTransaction(filePath, args, context, animationOnlyGuard("spine_remove_keyframe"), (json, diff) => {
    const animation = getAnimation(json, args.animation);
    let timelineArray: JsonObject[];
    let pathBase: string;

    if (args.targetType === "bone") {
      if (!args.targetName) throw new Error("targetName is required for bone keyframe removal.");
      if (!getWritableTimelineSpec("bone", args.timeline)) throw new Error(`当前 MCP 不支持删除骨骼 timeline '${args.timeline}'。`);
      requireKnownBone(json, args.targetName);
      timelineArray = animation.bones?.[args.targetName]?.[args.timeline];
      pathBase = `/animations/${escapePath(args.animation)}/bones/${escapePath(args.targetName)}/${args.timeline}`;
    } else if (args.targetType === "slot") {
      if (!args.targetName) throw new Error("targetName is required for slot keyframe removal.");
      if (!getWritableTimelineSpec("slot", args.timeline)) throw new Error(`当前 MCP 不支持删除插槽 timeline '${args.timeline}'。`);
      requireKnownSlot(json, args.targetName);
      timelineArray = animation.slots?.[args.targetName]?.[args.timeline];
      pathBase = `/animations/${escapePath(args.animation)}/slots/${escapePath(args.targetName)}/${args.timeline}`;
    } else {
      if (!getWritableTimelineSpec("drawOrder", args.timeline)) throw new Error(`当前 MCP 不支持删除绘制顺序 timeline '${args.timeline}'。`);
      const key = getDrawOrderKey(animation) ?? args.targetType;
      timelineArray = animation[key];
      pathBase = `/animations/${escapePath(args.animation)}/${key}`;
    }

    if (!Array.isArray(timelineArray)) throw new Error(`Timeline not found at ${pathBase}.`);
    const before = deepClone(timelineArray);
    const next = timelineArray.filter((keyframe) => !sameTime(keyframe.time ?? 0, args.time));
    timelineArray.length = 0;
    timelineArray.push(...next);
    diff.push({ path: pathBase, before, after: deepClone(timelineArray) });
    return `Removed ${args.timeline} keyframe at ${args.time}s from animation '${args.animation}'.`;
  });
}

async function writeTransaction(
  filePath: string,
  options: WriteOptions,
  context: ToolContext,
  guard: WriteGuard,
  mutate: (json: JsonObject, diff: JsonDiff[]) => string | Promise<string>,
): Promise<WriteResult> {
  const transaction = () => withFileLock(filePath, context, () => writeTransactionLocked(filePath, options, context, guard, mutate));
  return options.dryRun === false ? withWorkspaceWrite(context, transaction) : transaction();
}
async function writeTransactionLocked(filePath: string, options: WriteOptions, context: ToolContext, guard: WriteGuard, mutate: (json: JsonObject, diff: JsonDiff[]) => string | Promise<string>): Promise<WriteResult> {
  const document = await readSpineDocument(filePath, context);
  const version = getVersion(document.json);
  if (version !== SUPPORTED_SPINE_VERSION && !options.allowUnsupportedVersion) {
    throw new Error(`Writes support Spine ${SUPPORTED_SPINE_VERSION}; file is ${version ?? "unknown"}.`);
  }
  if (options.expectedHash && options.expectedHash !== document.hash) {
    throw new Error(`expectedHash mismatch. Current hash is ${document.hash}.`);
  }

  const nextJson = deepClone(document.json);
  const reportedDiff: JsonDiff[] = [];
  const message = await mutate(nextJson, reportedDiff);
  const actualDiff = collectJsonDiffs(document.json, nextJson);
  const operationValidation = validateOperationDiff(guard, actualDiff);
  if (!operationValidation.ok) {
    throw new Error(`操作 '${guard.operation}' 尝试修改未授权路径：${operationValidation.rejectedPaths.join(", ")}`);
  }
  const officialSpecValidation = validateOfficialAnimationSpec(nextJson);
  if (!officialSpecValidation.ok) {
    throw new Error(`官方规范审查失败：${officialSpecValidation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  const validation = validateSpineJson(nextJson);
  if (!validation.ok) {
    throw new Error(`Mutated JSON failed validation: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  const diff = reportedDiff.length ? reportedDiff : actualDiff;
  const dryRun = options.dryRun ?? true;
  const summary = buildWriteSummary(guard.operation, diff, !dryRun);
  const affectedPaths = uniquePaths(diff);

  if (dryRun) {
    return {
      dryRun,
      filePath,
      hashBefore: document.hash,
      hashAfter: null,
      backupPath: null,
      affectedPaths,
      diff,
      message: `${message} dryRun=true，仅返回差异，文件未修改。`,
      summary,
      validation,
      operationValidation,
      officialSpecValidation,
    };
  }

  checkpoint('动画提交');
  const backupPath = await backupFile(document, context);
  const serialized = `${JSON.stringify(nextJson, null, 2)}\n`;
  await writeFile(document.absolutePath, serialized, "utf8");
  invalidate(document.absolutePath);
  return {
    dryRun,
    filePath,
    hashBefore: document.hash,
    hashAfter: sha256(serialized),
    backupPath,
    affectedPaths,
    diff,
    message,
    summary,
    validation,
    operationValidation,
    officialSpecValidation,
  };
}

function animationOnlyGuard(operation: string): WriteGuard {
  return {
    operation,
    allowedPathPatterns: [ANIMATION_SUBTREE_PATTERN],
  };
}

function validateOperationDiff(guard: WriteGuard, diff: JsonDiff[]): OperationValidationResult {
  const rejectedPaths = diff
    .map((entry) => entry.path)
    .filter((pathValue) => !guard.allowedPathPatterns.some((pattern) => pattern.test(pathValue)));
  return {
    ok: rejectedPaths.length === 0,
    operation: guard.operation,
    allowedPathPatterns: guard.allowedPathPatterns.map((pattern) => pattern.source),
    checkedPathCount: diff.length,
    rejectedPaths,
  };
}

function buildWriteSummary(operation: string, diff: JsonDiff[], wroteFile: boolean): WriteSummary {
  const affectedPaths = uniquePaths(diff);
  const changedTopLevelPaths = [...new Set(affectedPaths.map((pathValue) => {
    const parts = pathValue.split("/").filter(Boolean);
    return parts.length >= 2 ? `/${parts[0]}/${parts[1]}` : pathValue;
  }))];
  return {
    operation,
    diffEntryCount: diff.length,
    changedPathCount: affectedPaths.length,
    changedTopLevelPaths,
    changedKeyframeCount: countChangedKeyframes(diff),
    wroteFile,
    nextStep: wroteFile
      ? "已写入文件并生成备份。建议继续调用 spine_validate_json 或使用预览工具检查效果。"
      : "这是 dryRun 结果。请检查 diff 和 summary，确认后再对目标文件使用 dryRun:false 提交。",
  };
}

function uniquePaths(diff: JsonDiff[]) {
  return [...new Set(diff.map((entry) => entry.path))];
}

function countChangedKeyframes(diff: JsonDiff[]) {
  let count = 0;
  for (const entry of diff) {
    if (Array.isArray(entry.before) || Array.isArray(entry.after)) {
      count += Math.max(Array.isArray(entry.before) ? entry.before.length : 0, Array.isArray(entry.after) ? entry.after.length : 0);
    } else {
      count += 1;
    }
  }
  return count;
}

function collectJsonDiffs(before: unknown, after: unknown, pathBase = ""): JsonDiff[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return [{ path: pathBase || "/", before: deepClone(before), after: deepClone(after) }];
  }

  const keys = new Set([...Object.keys(before as JsonObject), ...Object.keys(after as JsonObject)]);
  const diffs: JsonDiff[] = [];
  for (const key of keys) {
    const childPath = `${pathBase}/${escapePath(key)}`;
    diffs.push(...collectJsonDiffs((before as JsonObject)[key], (after as JsonObject)[key], childPath));
  }
  return diffs;
}

function validateAnimations(
  json: JsonObject,
  boneNames: Set<string>,
  slotNames: Set<string>,
  attachmentIndex: Map<string, Set<string>>,
  issues: ValidationIssue[],
) {
  const animations = json.animations;
  if (!animations || typeof animations !== "object" || Array.isArray(animations)) return;

  for (const [animationName, animation] of Object.entries(animations as JsonObject)) {
    const animationObject = animation as JsonObject;
    for (const [bone, timelines] of Object.entries((animationObject.bones as JsonObject | undefined) ?? {})) {
      if (!boneNames.has(bone)) {
        issues.push({
          path: `/animations/${escapePath(animationName)}/bones/${escapePath(bone)}`,
          message: `Animation references missing bone '${bone}'.`,
          severity: "error",
        });
      }
      for (const [timeline, keyframes] of Object.entries((timelines as JsonObject) ?? {})) {
        validateKeyframeArray(keyframes, `/animations/${escapePath(animationName)}/bones/${escapePath(bone)}/${timeline}`, issues);
      }
    }

    for (const [slot, timelines] of Object.entries((animationObject.slots as JsonObject | undefined) ?? {})) {
      if (!slotNames.has(slot)) {
        issues.push({
          path: `/animations/${escapePath(animationName)}/slots/${escapePath(slot)}`,
          message: `Animation references missing slot '${slot}'.`,
          severity: "error",
        });
      }
      for (const [timeline, keyframes] of Object.entries((timelines as JsonObject) ?? {})) {
        const pathBase = `/animations/${escapePath(animationName)}/slots/${escapePath(slot)}/${timeline}`;
        validateKeyframeArray(keyframes, pathBase, issues);
        if (timeline === "attachment" && Array.isArray(keyframes)) {
          keyframes.forEach((keyframe, index) => {
            if (typeof keyframe.name === "string" && !(attachmentIndex.get(slot)?.has(keyframe.name))) {
              issues.push({
                path: `${pathBase}/${index}/name`,
                message: `Attachment '${keyframe.name}' does not exist for slot '${slot}'.`,
                severity: "error",
              });
            }
          });
        }
      }
    }

    for (const key of ["drawOrder", "draworder"]) {
      if (Array.isArray(animationObject[key])) {
        validateKeyframeArray(animationObject[key], `/animations/${escapePath(animationName)}/${key}`, issues);
        animationObject[key].forEach((keyframe: JsonObject, index: number) => {
          for (const offset of asArray(keyframe.offsets)) {
            if (typeof offset.slot === "string" && !slotNames.has(offset.slot)) {
              issues.push({
                path: `/animations/${escapePath(animationName)}/${key}/${index}/offsets`,
                message: `Draw order references missing slot '${offset.slot}'.`,
                severity: "error",
              });
            }
          }
        });
      }
    }
  }
}

function collectTimelineRefs(
  animation: JsonObject,
  animationName: string,
  targets?: TimelineTargetFilter[],
): TimelineRef[] {
  const refs: TimelineRef[] = [];
  const normalizedTargets: TimelineTargetFilter[] = targets?.length ? targets : [
    { targetType: "bone" },
    { targetType: "slot" },
    { targetType: "drawOrder" },
  ];

  for (const filter of normalizedTargets) {
    const nameSet = filter.names ? new Set(filter.names) : null;
    const timelineSet = filter.timelines ? new Set(filter.timelines) : null;

    if (filter.targetType === "bone") {
      for (const [bone, timelines] of Object.entries((animation.bones as JsonObject | undefined) ?? {})) {
        if (nameSet && !nameSet.has(bone)) continue;
        for (const [timeline, keyframes] of Object.entries((timelines as JsonObject) ?? {})) {
          if (timelineSet && !timelineSet.has(timeline)) continue;
          if (!getWritableTimelineSpec("bone", timeline)) continue;
          if (!Array.isArray(keyframes)) continue;
          refs.push({
            targetType: "bone",
            targetName: bone,
            timeline,
            keyframes,
            path: `/animations/${escapePath(animationName)}/bones/${escapePath(bone)}/${timeline}`,
          });
        }
      }
    }

    if (filter.targetType === "slot") {
      for (const [slot, timelines] of Object.entries((animation.slots as JsonObject | undefined) ?? {})) {
        if (nameSet && !nameSet.has(slot)) continue;
        for (const [timeline, keyframes] of Object.entries((timelines as JsonObject) ?? {})) {
          if (timelineSet && !timelineSet.has(timeline)) continue;
          if (!getWritableTimelineSpec("slot", timeline)) continue;
          if (!Array.isArray(keyframes)) continue;
          refs.push({
            targetType: "slot",
            targetName: slot,
            timeline,
            keyframes,
            path: `/animations/${escapePath(animationName)}/slots/${escapePath(slot)}/${timeline}`,
          });
        }
      }
    }

    if (filter.targetType === "drawOrder" || filter.targetType === "draworder") {
      const key = getDrawOrderKey(animation);
      if (!key) continue;
      if (timelineSet && !timelineSet.has(key) && !timelineSet.has("drawOrder") && !timelineSet.has("draworder")) continue;
      refs.push({
        targetType: "drawOrder",
        targetName: key,
        timeline: key,
        keyframes: animation[key],
        path: `/animations/${escapePath(animationName)}/${key}`,
      });
    }
  }

  return refs;
}

function ensureTimelineRef(
  animation: JsonObject,
  animationName: string,
  targetType: "bone" | "slot" | "drawOrder",
  targetName: string,
  timeline: string,
): TimelineRef {
  if (targetType === "bone") {
    animation.bones ??= {};
    animation.bones[targetName] ??= {};
    animation.bones[targetName][timeline] ??= [];
    if (!Array.isArray(animation.bones[targetName][timeline])) throw new Error(`骨骼时间线不是数组：${targetName}/${timeline}`);
    return {
      targetType,
      targetName,
      timeline,
      keyframes: animation.bones[targetName][timeline],
      path: `/animations/${escapePath(animationName)}/bones/${escapePath(targetName)}/${timeline}`,
    };
  }

  if (targetType === "slot") {
    animation.slots ??= {};
    animation.slots[targetName] ??= {};
    animation.slots[targetName][timeline] ??= [];
    if (!Array.isArray(animation.slots[targetName][timeline])) throw new Error(`插槽时间线不是数组：${targetName}/${timeline}`);
    return {
      targetType,
      targetName,
      timeline,
      keyframes: animation.slots[targetName][timeline],
      path: `/animations/${escapePath(animationName)}/slots/${escapePath(targetName)}/${timeline}`,
    };
  }

  const key = getDrawOrderKey(animation) ?? "drawOrder";
  animation[key] ??= [];
  if (!Array.isArray(animation[key])) throw new Error(`绘制顺序时间线不是数组：${key}`);
  return {
    targetType,
    targetName: key,
    timeline: key,
    keyframes: animation[key],
    path: `/animations/${escapePath(animationName)}/${key}`,
  };
}

function keyframeValue(timeline: string, keyframe: JsonObject) {
  if (timeline === "rotate") return keyframe.value ?? 0;
  if (timeline === "translate" || timeline === "scale" || timeline === "shear") {
    return { x: keyframe.x ?? null, y: keyframe.y ?? null };
  }
  if (timeline === "attachment") return keyframe.name ?? null;
  if (timeline === "drawOrder" || timeline === "draworder") return keyframe.offsets ?? [];
  return deepClone(keyframe);
}

function timeInRange(time: number, range?: TimeRange): boolean {
  if (!range) return true;
  if (range.start !== undefined && time + EPSILON < range.start) return false;
  if (range.end !== undefined && time - EPSILON > range.end) return false;
  return true;
}

function requireRange(range: TimeRange | undefined) {
  if (!range) throw new Error("range 是必填参数。");
  if (range.start !== undefined && (!Number.isFinite(range.start) || range.start < 0)) throw new Error("range.start 必须是非负数字。");
  if (range.end !== undefined && (!Number.isFinite(range.end) || range.end < 0)) throw new Error("range.end 必须是非负数字。");
  if (range.start !== undefined && range.end !== undefined && range.end + EPSILON < range.start) {
    throw new Error("range.end 不能小于 range.start。");
  }
}

function assertWritableTargetFilters(targets?: TimelineTargetFilter[]) {
  for (const target of targets ?? []) {
    for (const timeline of target.timelines ?? []) {
      if (!getWritableTimelineSpec(normalizeTargetType(target.targetType), timeline)) {
        throw new Error(`当前 MCP 不支持写入 ${target.targetType} timeline '${timeline}'；请使用 docs/MCP操作清单.md 中列出的可写 timeline。`);
      }
    }
  }
}

function normalizeTargetType(targetType: TargetType): "bone" | "slot" | "drawOrder" {
  return targetType === "draworder" ? "drawOrder" : targetType;
}

function setKeyframeTime(keyframe: JsonObject, time: number) {
  const normalized = normalizeTime(time);
  if (sameTime(normalized, 0)) delete keyframe.time;
  else keyframe.time = normalized;
}

function normalizeTimeline(timeline: JsonObject[]) {
  const byTime = new Map<string, JsonObject>();
  for (const keyframe of timeline) byTime.set(String(normalizeTime(keyframe.time ?? 0)), keyframe);
  timeline.length = 0;
  timeline.push(...[...byTime.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, keyframe]) => keyframe));
  if (timeline.length > 0) delete timeline[timeline.length - 1].curve;
}

function pushDiffIfChanged(diff: JsonDiff[], path: string, before: unknown, after: unknown) {
  const afterClone = deepClone(after);
  if (JSON.stringify(before) !== JSON.stringify(afterClone)) diff.push({ path, before, after: afterClone });
}

function applyValueOffsetAndScale(
  keyframe: JsonObject,
  timeline: BoneTimeline,
  offset?: number | { x?: number; y?: number },
  scale?: number | { x?: number; y?: number },
): boolean {
  if (timeline === "rotate") {
    const before = keyframe.value ?? 0;
    const scaleValue = typeof scale === "number" ? scale : 1;
    const offsetValue = typeof offset === "number" ? offset : 0;
    keyframe.value = normalizeNumber(before * scaleValue + offsetValue);
    return !sameTime(before, keyframe.value);
  }

  let changed = false;
  for (const axis of ["x", "y"] as const) {
    const before = keyframe[axis] ?? 0;
    const scaleValue = typeof scale === "number" ? scale : scale?.[axis] ?? 1;
    const offsetValue = typeof offset === "number" ? offset : offset?.[axis] ?? 0;
    const after = normalizeNumber(before * scaleValue + offsetValue);
    if (!sameTime(before, after)) {
      keyframe[axis] = after;
      changed = true;
    }
  }
  return changed;
}

function assertAnimationName(animation: string) {
  if (!animation || typeof animation !== "string") throw new Error("animation 必须是非空字符串。");
  if (animation.includes("/") || animation.includes("\\")) throw new Error("animation 名称不能包含路径分隔符。");
}

function validateKeyframeArray(value: unknown, pathBase: string, issues: ValidationIssue[]) {
  if (!Array.isArray(value)) {
    issues.push({ path: pathBase, message: "Timeline must be an array.", severity: "error" });
    return;
  }
  let previous = -Infinity;
  value.forEach((keyframe, index) => {
    if (!keyframe || typeof keyframe !== "object" || Array.isArray(keyframe)) {
      issues.push({ path: `${pathBase}/${index}`, message: "关键帧必须是对象。", severity: "error" });
      return;
    }
    const time = typeof keyframe?.time === "number" ? keyframe.time : 0;
    if (time < 0) {
      issues.push({ path: `${pathBase}/${index}/time`, message: "Keyframe time cannot be negative.", severity: "error" });
    }
    if (keyframe.time !== undefined && typeof keyframe.time !== "number") {
      issues.push({ path: `${pathBase}/${index}/time`, message: "time 必须是数字。", severity: "error" });
    }
    if (time + EPSILON < previous) {
      issues.push({ path: `${pathBase}/${index}/time`, message: "Keyframes must be sorted by time.", severity: "error" });
    }
    validateSupportedTimelineKeyframe(pathBase, keyframe as JsonObject, index, issues);
    previous = time;
  });
}

function validateOfficialKeyframeArray(
  value: unknown,
  pathBase: string,
  spec: TimelineSpecSummary,
  issues: ValidationIssue[],
) {
  if (!Array.isArray(value)) {
    issues.push({ path: pathBase, message: "官方规范审查失败：timeline 必须是关键帧数组。", severity: "error" });
    return 0;
  }
  value.forEach((keyframe, index) => {
    if (!keyframe || typeof keyframe !== "object" || Array.isArray(keyframe)) {
      issues.push({ path: `${pathBase}/${index}`, message: "官方规范审查失败：关键帧必须是对象。", severity: "error" });
      return;
    }
    validateOfficialKeyframe(pathBase, keyframe as JsonObject, index, value.length, spec, issues);
  });
  return value.length;
}

function validateOfficialKeyframe(
  pathBase: string,
  keyframe: JsonObject,
  index: number,
  keyframeCount: number,
  spec: TimelineSpecSummary,
  issues: ValidationIssue[],
) {
  validateAllowedKeys(pathBase, keyframe, index, spec.allowedKeys, issues);

  if (keyframe.time !== undefined && (typeof keyframe.time !== "number" || !Number.isFinite(keyframe.time))) {
    issues.push({ path: `${pathBase}/${index}/time`, message: "官方规范审查失败：time 必须是数字。", severity: "error" });
  }
  if (typeof keyframe.time === "number" && keyframe.time < 0) {
    issues.push({ path: `${pathBase}/${index}/time`, message: "官方规范审查失败：time 不能为负数。", severity: "error" });
  }

  if (spec.targetType === "bone" && spec.timeline === "rotate") {
    if (keyframe.value !== undefined && (typeof keyframe.value !== "number" || !Number.isFinite(keyframe.value))) {
      issues.push({ path: `${pathBase}/${index}/value`, message: "官方规范审查失败：4.1.24 rotate.value 必须是数字。", severity: "error" });
    }
    if (keyframe.angle !== undefined) {
      issues.push({
        path: `${pathBase}/${index}/angle`,
        message: "官方规范审查失败：当前写入版本锁定 4.1.24，rotate 使用 value 字段；angle 只作为官方文档字段差异记录，不在 V1 写入子集中。",
        severity: "error",
      });
    }
  }

  if (spec.targetType === "bone" && ["translate", "scale", "shear"].includes(spec.timeline)) {
    for (const axis of ["x", "y"]) {
      if (keyframe[axis] !== undefined && (typeof keyframe[axis] !== "number" || !Number.isFinite(keyframe[axis]))) {
        issues.push({ path: `${pathBase}/${index}/${axis}`, message: `官方规范审查失败：${spec.timeline}.${axis} 必须是数字。`, severity: "error" });
      }
    }
  }

  if (spec.targetType === "slot" && spec.timeline === "attachment" && keyframe.name !== undefined && typeof keyframe.name !== "string") {
    issues.push({ path: `${pathBase}/${index}/name`, message: "官方规范审查失败：attachment.name 必须是字符串。", severity: "error" });
  }

  if (spec.targetType === "drawOrder" && keyframe.offsets !== undefined) {
    if (!Array.isArray(keyframe.offsets)) {
      issues.push({ path: `${pathBase}/${index}/offsets`, message: "官方规范审查失败：drawOrder.offsets 必须是数组。", severity: "error" });
    } else {
      keyframe.offsets.forEach((offset, offsetIndex) => {
        if (!offset || typeof offset !== "object" || Array.isArray(offset)) {
          issues.push({ path: `${pathBase}/${index}/offsets/${offsetIndex}`, message: "官方规范审查失败：offset 必须是对象。", severity: "error" });
          return;
        }
        validateAllowedKeys(`${pathBase}/${index}/offsets`, offset as JsonObject, offsetIndex, ["slot", "offset"], issues);
        if (typeof offset.slot !== "string") {
          issues.push({ path: `${pathBase}/${index}/offsets/${offsetIndex}/slot`, message: "官方规范审查失败：offset.slot 必须是字符串。", severity: "error" });
        }
        if (typeof offset.offset !== "number" || !Number.isFinite(offset.offset)) {
          issues.push({ path: `${pathBase}/${index}/offsets/${offsetIndex}/offset`, message: "官方规范审查失败：offset.offset 必须是数字。", severity: "error" });
        }
      });
    }
  }

  if (keyframe.curve !== undefined) {
    if (index === keyframeCount - 1) {
      issues.push({
        path: `${pathBase}/${index}/curve`,
        message: "官方规范审查失败：curve 描述当前关键帧到下一关键帧的插值，最后一帧不能包含 curve。",
        severity: "error",
      });
    } else {
      validateCurve(pathBase, keyframe.curve, index, issues);
    }
  }
}

function validateSupportedTimelineKeyframe(pathBase: string, keyframe: JsonObject, index: number, issues: ValidationIssue[]) {
  const timeline = pathBase.split("/").pop() ?? "";
  const spec = getWritableTimelineSpec(targetTypeFromTimelinePath(pathBase), timeline);
  if (spec) {
    validateAllowedKeys(pathBase, keyframe, index, spec.allowedKeys, issues);
  }

  if (timeline === "rotate" && keyframe.value !== undefined && typeof keyframe.value !== "number") {
    issues.push({ path: `${pathBase}/${index}/value`, message: "rotate.value 必须是数字。", severity: "error" });
  }
  if (["translate", "scale", "shear"].includes(timeline)) {
    for (const axis of ["x", "y"]) {
      if (keyframe[axis] !== undefined && typeof keyframe[axis] !== "number") {
        issues.push({ path: `${pathBase}/${index}/${axis}`, message: `${timeline}.${axis} 必须是数字。`, severity: "error" });
      }
    }
  }
  if (timeline === "attachment" && keyframe.name !== undefined && typeof keyframe.name !== "string") {
    issues.push({ path: `${pathBase}/${index}/name`, message: "attachment.name 必须是字符串。", severity: "error" });
  }
  if ((timeline === "drawOrder" || timeline === "draworder") && keyframe.offsets !== undefined) {
    if (!Array.isArray(keyframe.offsets)) {
      issues.push({ path: `${pathBase}/${index}/offsets`, message: "drawOrder.offsets 必须是数组。", severity: "error" });
    } else {
      keyframe.offsets.forEach((offset, offsetIndex) => {
        if (!offset || typeof offset !== "object" || Array.isArray(offset)) {
          issues.push({ path: `${pathBase}/${index}/offsets/${offsetIndex}`, message: "offset 必须是对象。", severity: "error" });
          return;
        }
        validateAllowedKeys(`${pathBase}/${index}/offsets`, offset as JsonObject, offsetIndex, ["slot", "offset"], issues);
        if (typeof offset.slot !== "string") {
          issues.push({ path: `${pathBase}/${index}/offsets/${offsetIndex}/slot`, message: "offset.slot 必须是字符串。", severity: "error" });
        }
        if (typeof offset.offset !== "number") {
          issues.push({ path: `${pathBase}/${index}/offsets/${offsetIndex}/offset`, message: "offset.offset 必须是数字。", severity: "error" });
        }
      });
    }
  }
  if (keyframe.curve !== undefined) validateCurve(pathBase, keyframe.curve, index, issues);
}

function getWritableTimelineSpec(targetType: "bone" | "slot" | "drawOrder", timeline: string) {
  return WRITABLE_TIMELINE_SPECS.find((spec) => spec.targetType === targetType && spec.timeline === timeline);
}

function targetTypeFromTimelinePath(pathBase: string): "bone" | "slot" | "drawOrder" {
  if (pathBase.includes("/bones/")) return "bone";
  if (pathBase.includes("/slots/")) return "slot";
  return "drawOrder";
}

function validateAllowedKeys(pathBase: string, object: JsonObject, index: number, allowedKeys: string[], issues: ValidationIssue[]) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) {
      issues.push({
        path: `${pathBase}/${index}/${key}`,
        message: `字段 '${key}' 不属于当前支持的 ${pathBase.split("/").pop()} timeline schema。`,
        severity: "error",
      });
    }
  }
}

function validateCurve(pathBase: string, curve: unknown, index: number, issues: ValidationIssue[]) {
  if (curve === "stepped") return;
  if (Array.isArray(curve) && curve.length >= 4 && curve.length % 2 === 0 && curve.every((value) => typeof value === "number" && Number.isFinite(value))) return;
  issues.push({ path: `${pathBase}/${index}/curve`, message: "curve 必须是 'stepped' 或至少 4 个数字组成的偶数长度数组。", severity: "error" });
}

function buildAttachmentIndex(json: JsonObject): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const skin of getSkinEntries(json)) {
    for (const [slot, attachments] of Object.entries((skin.attachments as JsonObject | undefined) ?? {})) {
      const names = index.get(slot) ?? new Set<string>();
      for (const name of Object.keys((attachments as JsonObject) ?? {})) names.add(name);
      index.set(slot, names);
    }
  }
  return index;
}

function getSkinEntries(json: JsonObject): JsonObject[] {
  if (Array.isArray(json.skins)) return json.skins;
  if (json.skins && typeof json.skins === "object") {
    return Object.entries(json.skins as JsonObject).map(([name, skin]) => ({
      name,
      ...(skin as JsonObject),
    }));
  }
  return [];
}

function getAnimation(json: JsonObject, animationName: string): JsonObject {
  const animation = json.animations?.[animationName];
  if (!animation || typeof animation !== "object") throw new Error(`Animation '${animationName}' does not exist.`);
  return animation;
}

function requireKnownBone(json: JsonObject, boneName: string) {
  if (!asArray(json.bones).some((bone) => bone.name === boneName)) throw new Error(`Bone '${boneName}' does not exist.`);
}

function requireKnownSlot(json: JsonObject, slotName: string) {
  if (!asArray(json.slots).some((slot) => slot.name === slotName)) throw new Error(`Slot '${slotName}' does not exist.`);
}

function requireKnownAttachment(json: JsonObject, slotName: string, attachmentName: string) {
  if (!(buildAttachmentIndex(json).get(slotName)?.has(attachmentName))) {
    throw new Error(`Attachment '${attachmentName}' does not exist for slot '${slotName}'.`);
  }
}

function buildBoneKeyframe(
  timeline: "rotate" | "translate" | "scale" | "shear",
  time: number,
  value: number | { x?: number; y?: number },
  curve?: string | number[],
): JsonObject {
  if (!Number.isFinite(time) || time < 0) throw new Error("time must be a non-negative number.");
  const keyframe: JsonObject = time === 0 ? {} : { time };
  if (timeline === "rotate") {
    if (typeof value !== "number") throw new Error("rotate value must be a number.");
    keyframe.value = value;
  } else {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${timeline} value must be an object with x and/or y.`);
    }
    if (value.x !== undefined) keyframe.x = value.x;
    if (value.y !== undefined) keyframe.y = value.y;
    if (value.x === undefined && value.y === undefined) throw new Error(`${timeline} value must include x and/or y.`);
  }
  if (curve !== undefined) keyframe.curve = curve;
  return keyframe;
}

function upsertKeyframe(timeline: JsonObject[], time: number, keyframe: JsonObject) {
  const existing = timeline.find((entry) => sameTime(entry.time ?? 0, time));
  if (existing) {
    for (const key of Object.keys(existing)) delete existing[key];
    Object.assign(existing, keyframe);
  } else {
    timeline.push(keyframe);
  }
  normalizeTimeline(timeline);
}

function estimateDuration(value: unknown): number {
  let max = 0;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const object = node as JsonObject;
    if (typeof object.time === "number" && object.time > max) max = object.time;
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return max;
}

function collectTimelineTypeCounts(animation: JsonObject) {
  const counts: JsonObject = {
    bones: {},
    slots: {},
    topLevel: {},
  };
  for (const key of Object.keys(animation)) counts.topLevel[key] = (counts.topLevel[key] ?? 0) + 1;
  for (const timelines of Object.values((animation.bones as JsonObject | undefined) ?? {})) {
    for (const type of Object.keys((timelines as JsonObject) ?? {})) counts.bones[type] = (counts.bones[type] ?? 0) + 1;
  }
  for (const timelines of Object.values((animation.slots as JsonObject | undefined) ?? {})) {
    for (const type of Object.keys((timelines as JsonObject) ?? {})) counts.slots[type] = (counts.slots[type] ?? 0) + 1;
  }
  return counts;
}

function summarizeTimelineMap(timelines: JsonObject) {
  return Object.fromEntries(
    Object.entries(timelines).map(([type, keyframes]) => [type, summarizeTimelineArray(keyframes)]),
  );
}

function summarizeTimelineArray(keyframes: unknown) {
  if (!Array.isArray(keyframes)) return { keyframeCount: 0, startTime: null, endTime: null };
  const times = keyframes.map((keyframe) => keyframe.time ?? 0);
  return {
    keyframeCount: keyframes.length,
    startTime: times.length ? Math.min(...times) : null,
    endTime: times.length ? Math.max(...times) : null,
  };
}

function getDrawOrderKey(animation: JsonObject): "drawOrder" | "draworder" | null {
  if (Array.isArray(animation.drawOrder)) return "drawOrder";
  if (Array.isArray(animation.draworder)) return "draworder";
  return null;
}

async function backupFile(document: SpineDocument, context: ToolContext): Promise<string> {
  const workspaceRoot = path.resolve(context.workspaceRoot ?? getWorkspaceRoot(context.projectId));
  const backupsDir = context.backupRoot ? path.resolve(context.backupRoot) : path.join(workspaceRoot, "backups");
  await mkdir(backupsDir, { recursive: true });
  const parsed = path.parse(document.absolutePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupsDir, `${parsed.name}.${stamp}${parsed.ext}`);
  await writeFile(backupPath, JSON.stringify(document.json, null, 2) + "\n", "utf8");
  return backupPath;
}

function getVersion(json: JsonObject): string | null {
  return typeof json.skeleton?.spine === "string" ? json.skeleton.spine : null;
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value as JsonObject[] : [];
}

function deepClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sameTime(a: number, b: number) {
  return Math.abs(a - b) < EPSILON;
}

function normalizeTime(value: number) {
  return normalizeNumber(value);
}

function normalizeNumber(value: number) {
  return Number(value.toFixed(4));
}

function escapePath(value: string) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

