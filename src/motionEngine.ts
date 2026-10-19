import { readFile } from "node:fs/promises";
import { applyPoseSequence, readSpineDocument, resolveWorkspacePath, type PoseKeyframeInput, type ToolContext, type WriteOptions } from "./spineJson.js";

export interface BoneMapping {
  body: string;
  head?: string;
  root?: string;
  leftArm?: string[];
  rightArm?: string[];
  leftLeg?: string[];
  rightLeg?: string[];
  footContacts?: { left?: [number, number]; right?: [number, number] };
  jointLimits?: Record<string, { min?: number; max?: number }>;
  anchors?: Partial<Record<"leftFoot" | "rightFoot" | "leftHand" | "rightHand", { bone: string; point: [number, number]; angle?: number; gripPoint?: [number, number]; solePoints?: [number, number][] }>>;
  bendDirections?: Partial<Record<"leftLeg" | "rightLeg" | "leftArm" | "rightArm", 1 | -1>>;
  follow?: Array<{ bone: string; driver: string; gain: number; delay?: number; velocityGain?: number; stiffness?: number; damping?: number }>;
  channels?: Record<string, string>;
  slotAttachments?: Record<string, string | null>;
}

export interface CharacterMapping { character: string; version: 1 | 2; bones: BoneMapping; notes?: string; semanticChecks?: string[]; status?: "draft" | "validated" | "calibrated" | "confirmed"; atlasPath?: string; skin?: string; sourceHash?: string; rigHash?: string; reportPath?: string; confirmedBy?: string; confirmedAt?: string; calibration?: { scale: number; lengths?: Record<string, [number, number]>; origin?: [number, number] }; }
export interface MotionEvent { time: number; type: "contact" | "recoil" | "passing" | "high" | "release"; side?: "left" | "right"; }
export interface MotionDefinition {
  name: string;
  version: 1 | 2;
  duration: number;
  loop: boolean;
  poses?: Array<{ time: number; body?: { rotate?: number; x?: number; y?: number }; limbs?: Record<string, { rotate?: number; x?: number; y?: number }> }>;
  events?: MotionEvent[];
  parameters?: { bodyBob?: number; sway?: number; armSwing?: number; stepAngle?: number };
  coordinateSystem?: "normalizedSkeleton";
  poseWorkflow?: { standardPosePath: string; keyPoses: Array<{posePath:string; time:number; stageId:string}> };
  frames?: Array<{ presentation?: {attachments?: Record<string,string|null>;drawOrder?: string[]}; action?: {driver: string | null}; bendDirections?: Partial<Record<"leftLeg"|"rightLeg"|"leftArm"|"rightArm", 1|-1>>; time: number; body: { x: number; y: number; rotate: number }; head?: number; channels?: Record<string, { rotate: number; x: number; y: number }>; targets: Partial<Record<"leftFoot" | "rightFoot" | "leftHand" | "rightHand", { x: number; y: number; angle?: number; contact?: boolean }>> }>;
  groundY?: number;
}
export interface MotionBuildOptions extends WriteOptions { filePath: string; mappingPath: string; motionPath?: string; animation: string; duration?: number; overwrite?: boolean; atlasPath?: string; reviewToken?: string; rotationTolerance?: number; translationTolerance?: number; footContactTolerance?: number; handTolerance?: number; vertexTolerance?: number; preview?: boolean; diagnosticPreview?: boolean; }

export async function readCharacterMapping(filePath: string, context: ToolContext = {}): Promise<CharacterMapping> {
  const value = JSON.parse(await readFile(resolveWorkspacePath(filePath, context), "utf8")) as CharacterMapping;
  validateMapping(value);
  return value;
}

export async function readMotionDefinition(filePath: string, context: ToolContext = {}): Promise<MotionDefinition> {
  const value = JSON.parse(await readFile(resolveWorkspacePath(filePath, context), "utf8")) as MotionDefinition;
  validateMotion(value);
  return value;
}

export function validateMapping(value: CharacterMapping, json?: any) {
  if (!value || ![1, 2].includes(value.version) || typeof value.character !== "string") throw new Error("mapping 必须包含 character 和 version: 1 或 2。");
  if (!value.bones || typeof value.bones.body !== "string") throw new Error("mapping.bones.body 必须是骨骼名称。");
  if (value.status !== undefined && !["draft", "validated", "calibrated", "confirmed"].includes(value.status)) throw new Error("mapping.status 无效。");
  if (value.status === "confirmed" && (!value.confirmedBy || !value.confirmedAt || !value.reportPath || !value.sourceHash || !value.rigHash)) throw new Error("confirmed mapping 必须包含 confirmedBy、confirmedAt、reportPath、sourceHash 和 rigHash。");
  for (const name of ["leftArm", "rightArm", "leftLeg", "rightLeg"] as const) {
    const chain = value.bones[name];
    if (chain !== undefined && (!Array.isArray(chain) || chain.length < 2 || chain.some((item) => typeof item !== "string"))) throw new Error(`mapping.bones.${name} 必须是至少两根骨骼组成的数组。`);
  }
  for (const anchor of Object.values(value.bones.anchors ?? {})) {
    if (!anchor || typeof anchor.bone !== "string" || !Array.isArray(anchor.point) || anchor.point.length !== 2 || !anchor.point.every(Number.isFinite) || (anchor.angle !== undefined && !Number.isFinite(anchor.angle))) throw new Error("语义锚点必须包含 bone、有限二维 point 和可选 angle。");
  }
  if (value.version === 2) {
    const allChains = [value.bones.leftArm, value.bones.rightArm, value.bones.leftLeg, value.bones.rightLeg].flatMap(chain => chain ?? []);
    if (new Set(allChains).size !== allChains.length) throw new Error("语义骨骼链重复：手臂和腿部不能共用求解骨骼。");
    for (const [role, anchor] of Object.entries(value.bones.anchors ?? {})) {
      const limb = role.replace("Foot", "Leg").replace("Hand", "Arm") as "leftLeg";
      if (anchor!.bone !== value.bones[limb]?.at(-1)) throw new Error(`${role} 必须绑定对应骨骼链末端。`);
      if (anchor!.solePoints && (!anchor!.solePoints.length || anchor!.solePoints.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)))) throw new Error("solePoints 必须为有限二维点列表。");
    }
    for (const follow of value.bones.follow ?? []) {
      if (![follow.gain, follow.delay ?? 0, follow.velocityGain ?? 0, follow.stiffness ?? 1, follow.damping ?? 1].every(Number.isFinite) || (follow.delay ?? 0) < 0 || (follow.stiffness ?? 1) <= 0 || (follow.damping ?? 1) < 0) throw new Error("跟随参数无效。");
    }
  }
  for (const [name, limit] of Object.entries(value.bones.jointLimits ?? {})) {
    if ((limit.min !== undefined && !Number.isFinite(limit.min)) || (limit.max !== undefined && !Number.isFinite(limit.max)) || (limit.min ?? -Infinity) > (limit.max ?? Infinity)) throw new Error(`${name} 关节限制无效。`);
  }
  if (value.calibration && (!Number.isFinite(value.calibration.scale) || value.calibration.scale <= 0)) throw new Error("角色 scale 必须为正数。");
  const referenced = [value.bones.body, value.bones.head, value.bones.root, ...(value.bones.leftArm ?? []), ...(value.bones.rightArm ?? []), ...(value.bones.leftLeg ?? []), ...(value.bones.rightLeg ?? []), ...Object.values(value.bones.anchors ?? {}).map(a => a!.bone), ...(value.bones.follow ?? []).flatMap(f => [f.bone, f.driver])].filter(Boolean) as string[];
  if (json) {
    const bonesByName = new Map((json.bones ?? []).map((bone: any) => [bone.name, bone]));
    const names = new Set(bonesByName.keys());
    const missing = referenced.filter((name) => !names.has(name));
    if (missing.length) throw new Error(`mapping 引用了不存在的骨骼：${[...new Set(missing)].join(", ")}`);
    for (const name of ["leftArm", "rightArm", "leftLeg", "rightLeg"] as const) {
      const chain = value.bones[name];
      if (!chain) continue;
      for (let index = 1; index < chain.length; index++) {
        const parent = (bonesByName.get(chain[index]) as any)?.parent;
        if (parent !== chain[index - 1]) {
          throw new Error(`mapping.bones.${name} 不是连续骨骼链：${chain[index]} 的 parent 应为 ${chain[index - 1]}，实际为 ${parent ?? "root"}。`);
        }
      }
    }
  }
  return { ok: true, character: value.character, referencedBones: [...new Set(referenced)] };
}

export function validateMotion(value: MotionDefinition) {
  if (!value || ![1, 2].includes(value.version) || typeof value.name !== "string") throw new Error("motion 必须包含 name 和 version: 1 或 2。");
  if (!Number.isFinite(value.duration) || value.duration <= 0) throw new Error("motion.duration 必须是正数。");
  if (typeof value.loop !== "boolean") throw new Error("motion.loop 必须为布尔值。");
  for (const p of Object.values(value.parameters ?? {})) if (!Number.isFinite(p)) throw new Error("motion 参数必须为有限数。");
  for (const event of value.events ?? []) if (!Number.isFinite(event.time) || event.time < 0 || event.time > value.duration || !["contact", "recoil", "passing", "high", "release"].includes(event.type) || (event.side !== undefined && !["left", "right"].includes(event.side))) throw new Error("motion 接触事件或时间无效。");
  if (value.version === 2) {
    if (value.coordinateSystem !== "normalizedSkeleton" || !value.frames?.length || value.frames.length < 2) throw new Error("v2 motion 必须包含 normalizedSkeleton 坐标系和至少两个 frames。");
    let previous = -1;
    for (const f of value.frames) {
      if (!Number.isFinite(f.time) || f.time <= previous || f.time < 0 || f.time > value.duration || !f.body || !Object.values(f.body).every(Number.isFinite)) throw new Error("motion frame 时间或 body 无效。");
      previous = f.time;
      for (const [role, target] of Object.entries(f.targets)) {
        if (!["leftFoot", "rightFoot", "leftHand", "rightHand"].includes(role) || !target || !Number.isFinite(target.x) || !Number.isFinite(target.y) || (target.angle !== undefined && !Number.isFinite(target.angle)) || (target.contact !== undefined && typeof target.contact !== "boolean")) throw new Error("motion target 语义或数值无效。");
      }
    }
    if (value.frames[0].time !== 0 || Math.abs(value.frames.at(-1)!.time - value.duration) > 1e-6) throw new Error("motion frames 必须覆盖完整周期。");
    if (value.loop) {
      const first = { ...value.frames[0], time: 0 }, last = { ...value.frames.at(-1)!, time: 0 };
      if (JSON.stringify(first) !== JSON.stringify(last)) throw new Error("循环 motion 首尾姿态不一致。");
    }
  }
  if (value.poses && (!Array.isArray(value.poses) || value.poses.some((pose) => !Number.isFinite(pose.time) || pose.time < 0 || pose.time > value.duration))) throw new Error("motion.poses 的时间必须位于动画周期内。");
  return { ok: true, name: value.name, duration: value.duration, poseCount: value.poses?.length ?? 0, eventCount: value.events?.length ?? 0 };
}

export function builtInMotion(name: string, duration = name === "walk" ? 1.2 : name === "run" ? 0.6667 : 2.0): MotionDefinition {
  if (name === "walk") return { name, version: 1, duration, loop: true, parameters: { bodyBob: 4, sway: 2, armSwing: 16, stepAngle: 28 }, events: [{ time: 0, type: "contact", side: "left" }, { time: duration * .25, type: "passing", side: "left" }, { time: duration * .5, type: "contact", side: "right" }, { time: duration * .75, type: "passing", side: "right" }] };
  if (name === "run") return { name, version: 1, duration, loop: true, parameters: { bodyBob: 9, sway: 4, armSwing: 26, stepAngle: 42 }, events: [{ time: 0, type: "contact", side: "left" }, { time: duration * .5, type: "contact", side: "right" }] };
  return { name, version: 1, duration, loop: true, parameters: { bodyBob: 2, sway: 1, armSwing: 5, stepAngle: 4 }, events: [] };
}

function clamp(value: number, min = -Infinity, max = Infinity) { return Math.max(min, Math.min(max, value)); }
function limited(value: number, bone: string, mapping: CharacterMapping) { const limit = mapping.bones.jointLimits?.[bone]; return clamp(value, limit?.min, limit?.max); }

export function generateMotionPoses(mapping: CharacterMapping, motion: MotionDefinition, duration = motion.duration, samples = 9): PoseKeyframeInput[] {
  const poses: PoseKeyframeInput[] = [];
  const p = motion.parameters ?? {};
  for (let i = 0; i < samples; i++) {
    const t = duration * i / (samples - 1); const phase = i === samples - 1 ? 0 : (i / (samples - 1)) * Math.PI * 2;
    const bodyBob = (p.bodyBob ?? 0) * (0.5 - 0.5 * Math.cos(phase * 2)); const sway = (p.sway ?? 0) * Math.sin(phase); const armSwing = (p.armSwing ?? 0) * Math.sin(phase); const step = (p.stepAngle ?? 0) * Math.sin(phase);
    const bones: Record<string, any> = {};
    bones[mapping.bones.body] = { rotate: sway * .25, translate: { x: sway, y: bodyBob } };
    if (mapping.bones.head) bones[mapping.bones.head] = { rotate: -sway * .35, translate: { y: -bodyBob * .18 } };
    const setChain = (chain: string[] | undefined, sign: number, strength: number) => { if (!chain?.length) return; chain.forEach((bone, index) => { const weight = index === 0 ? 1 : index === 1 ? .55 : .25; bones[bone] = { rotate: limited(sign * strength * weight, bone, mapping) }; }); };
    setChain(mapping.bones.leftArm, 1, armSwing); setChain(mapping.bones.rightArm, -1, armSwing); setChain(mapping.bones.leftLeg, -1, step); setChain(mapping.bones.rightLeg, 1, step);
    const explicit = motion.poses?.find((pose) => Math.abs(pose.time - t) < 1e-6);
    if (explicit?.body) {
      bones[mapping.bones.body] = {
        ...bones[mapping.bones.body],
        ...(explicit.body.rotate === undefined ? {} : { rotate: explicit.body.rotate }),
        ...(explicit.body.x === undefined && explicit.body.y === undefined ? {} : { translate: { x: explicit.body.x ?? 0, y: explicit.body.y ?? 0 } }),
      };
    }
    for (const [semantic, value] of Object.entries(explicit?.limbs ?? {})) {
      const chain = mapping.bones[semantic as keyof BoneMapping] as string[] | undefined;
      if (!chain) continue;
      chain.forEach((bone, index) => {
        const weight = index === 0 ? 1 : index === 1 ? .55 : .25;
        bones[bone] = {
          ...(value.rotate === undefined ? {} : { rotate: limited(value.rotate * weight, bone, mapping) }),
          ...(value.x === undefined && value.y === undefined ? {} : { translate: { x: (value.x ?? 0) * weight, y: (value.y ?? 0) * weight } }),
        };
      });
    }
    poses.push({ time: Number(t.toFixed(6)), bones });
  }
  return poses;
}

export async function inspectCharacter(filePath: string, context: ToolContext = {}) {
  const document = await readSpineDocument(filePath, context);
  const bones = (document.json.bones ?? []).map((bone: any) => ({ name: bone.name, parent: bone.parent ?? null, length: bone.length ?? 0, rotation: bone.rotation ?? 0, x: bone.x ?? 0, y: bone.y ?? 0 }));
  const names: string[] = bones.map((b: { name: string }) => b.name), pick = (patterns: RegExp[]) => names.filter((name: string) => patterns.some(pattern => pattern.test(name.toLowerCase()))).slice(0, 12);
  return {
    filePath, hash: document.hash, version: document.json.skeleton?.spine ?? null, bones,
    slots: (document.json.slots ?? []).map((slot: any) => ({ name: slot.name, bone: slot.bone })), animations: Object.keys(document.json.animations ?? {}),
    mappingCandidates: { root: pick([/^root$/]), body: pick([/body/, /torso/, /^bone2$/]), head: pick([/head/, /tou/, /futou/, /face/]), left: pick([/^left/, /^l[_-]/, /^ys/, /^yt/]), right: pick([/^right/, /^r[_-]/, /^zs/, /^zt/]) },
    confirmationRequired: ["body", "head", "left/right arms", "left/right legs", "foot/hand anchors", "bend directions", "setup pose", "follow bones"],
  };
}

export async function retargetMotion(args: MotionBuildOptions, context: ToolContext = {}) {
  if (args.motionPath) {
    const input = await readMotionDefinition(args.motionPath, context);
    if (input.version === 2) return (await import("./retargetEngine.js")).retargetSemanticMotion(args, context);
  }
  if (args.dryRun === false) throw new Error("旧版角度生成器仅支持 dryRun；真实写入请使用已确认 mapping 和 v2 语义 motion。");
  const document = await readSpineDocument(args.filePath, context); const mapping = await readCharacterMapping(args.mappingPath, context); validateMapping(mapping, document.json);
  const motion = args.motionPath ? await readMotionDefinition(args.motionPath, context) : builtInMotion(args.animation, args.duration); const duration = args.duration ?? motion.duration; const poses = generateMotionPoses(mapping, motion, duration);
  return applyPoseSequence(args.filePath, { animation: args.animation, overwrite: args.overwrite, duration, closeLoop: motion.loop, poses, dryRun: args.dryRun, expectedHash: args.expectedHash, allowUnsupportedVersion: args.allowUnsupportedVersion }, context);
}

export interface BatchJob extends MotionBuildOptions { name?: string; }
export async function batchRetarget(jobPath: string, context: ToolContext = {}) {
  const raw = JSON.parse(await readFile(resolveWorkspacePath(jobPath, context), "utf8")) as { jobs?: BatchJob[] } | BatchJob[];
  const jobs = Array.isArray(raw) ? raw : raw.jobs;
  if (!jobs?.length) throw new Error("批处理任务必须是非空数组，或包含 jobs 数组。");
  const results = [];
  for (const job of jobs) {
    try {
      const result = await retargetMotion(job, context);
      results.push({ name: job.name ?? job.animation, ok: !('ok' in result) || result.ok !== false, result });
    } catch (error) {
      results.push({ name: job.name ?? job.animation, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const report = { ok: results.every((result) => result.ok), total: results.length, succeeded: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, results };
  const reportPath = `previews/reports/batch-${(await import('node:crypto')).randomUUID()}.json`;
  await (await import('./mappingTools.js')).saveJson(reportPath, report, context);
  return { ...report, reportPath };
}
