import { readFile } from "node:fs/promises";
import { readSpineDocument, resolveWorkspacePath, writeGeneratedAnimation, validateSpineJson, validateOfficialAnimationSpec, type ToolContext } from "./spineJson.js";
import { readCharacterMapping, readMotionDefinition, validateMapping, validateMotion, type CharacterMapping, type MotionDefinition, type MotionBuildOptions } from "./motionEngine.js";
import { assertConfirmedMapping, hashObject, mappingFingerprint, saveJson } from "./mappingTools.js";
import { loadMotionRuntime, worldVertices } from "./motionRuntime.js";
import { fitCubicBezierTimeline, lockFootContact, sampleTimeline, solveTwoBoneIK, wrapAngle, type Point } from "./motionMath.js";

import {applyPosePresentation,presentationTimelines} from './posePresentation.js';
type SemanticFrame = NonNullable<MotionDefinition["frames"]>[number];
const roles = ["leftFoot", "rightFoot", "leftHand", "rightHand"] as const;
const angle = (bone: any) => Math.atan2(bone.c, bone.a) * 180 / Math.PI;
function pointWorld(bone: any, p: Point): Point { return [bone.worldX + bone.a * p[0] + bone.b * p[1], bone.worldY + bone.c * p[0] + bone.d * p[1]]; }
function applyAttachments(skeleton: any, mapping: CharacterMapping) {
  for (const [slot, attachment] of Object.entries(mapping.bones.slotAttachments ?? {})) skeleton.setAttachment(slot, attachment);
}
function anchorWorld(bone: any, anchor: any): Point {
  const p = pointWorld(bone, anchor.point);
  if (anchor.solePoints?.length) p[1] = Math.min(...anchor.solePoints.map((v: Point) => pointWorld(bone, v)[1]));
  return p;
}
function poseAnimation(json: any, poses: any[], channels: string[]) {
  const animation: any = { bones: {} };
  for (const name of channels) {
    animation.bones[name] = { rotate: [], translate: [] };
    for (const pose of poses) {
      const value = pose.bones[name] ?? { rotate: 0, translate: { x: 0, y: 0 } };
      animation.bones[name].rotate.push({ time: pose.time, value: value.rotate ?? 0 });
      animation.bones[name].translate.push({ time: pose.time, x: value.translate?.x ?? 0, y: value.translate?.y ?? 0 });
    }
  }
  return animation;
}
export function semanticAt(motion: MotionDefinition, t: number): SemanticFrame {
  const frames = motion.frames!;
  const group = (selector: (f: SemanticFrame) => any, key: string) => sampleTimeline(frames.map(f => ({ time: f.time, v: selector(f)?.[key] ?? 0 })), t, "v");
  const preceding = frames.filter(f => f.time <= t + 1e-9).at(-1) ?? frames[0];
  const result: SemanticFrame = { time: t, body: { x: group(f => f.body, "x"), y: group(f => f.body, "y"), rotate: group(f => f.body, "rotate") }, targets: {}, head: sampleTimeline(frames.map(f => ({ time: f.time, value: f.head ?? 0 })), t, "value"), channels: {}, bendDirections: preceding.bendDirections, action: preceding.action, presentation:preceding.presentation };
  for (const key of roles) if (frames[0].targets[key]) result.targets[key] = { x: group(f => f.targets[key], "x"), y: group(f => f.targets[key], "y"), angle: group(f => f.targets[key], "angle"), contact: preceding.targets[key]?.contact ?? false };
  for (const key of Object.keys(frames[0].channels ?? {})) result.channels![key] = { rotate: group(f => f.channels?.[key], "rotate"), x: group(f => f.channels?.[key], "x"), y: group(f => f.channels?.[key], "y") };
  return result;
}

export async function extractMotion(args: { filePath: string; mappingPath: string; animation: string; motionPath: string; reportPath?: string; samples?: number; loop?: boolean; groundY?: number; contactTolerance?: number; dryRun?: boolean }, context: ToolContext = {}) {
  const document = await readSpineDocument(args.filePath, context), mapping = await readCharacterMapping(args.mappingPath, context);
  validateMapping(mapping, document.json);
  await assertConfirmedMapping(mapping, document.json, document.hash, context);
  const runtime = await loadMotionRuntime(document.json, mapping.atlasPath!, context);
  const animation = runtime.data.findAnimation(args.animation);
  if (!animation || animation.duration <= 0) throw new Error("参考动画不存在或时长为零。");
  const count = args.samples ?? Math.max(73, Math.ceil(animation.duration * 120) + 1);
  if (!Number.isInteger(count) || count < 3 || count > 10001) throw new Error("samples 必须为 3 到 10001 的整数。");
  const scale = mapping.calibration!.scale, origin = mapping.calibration!.origin!, ground = args.groundY ?? 0;
  const frames: SemanticFrame[] = [];
  for (let i = 0; i < count; i++) {
    const time = animation.duration * i / (count - 1), skeleton = runtime.sample(args.animation, time, mapping.skin);
    applyAttachments(skeleton, mapping);
    const body = skeleton.findBone(mapping.bones.body)!;
    const frame: SemanticFrame = { time, body: { x: (body.x - body.data.x) / scale, y: (body.y - body.data.y) / scale, rotate: body.rotation - body.data.rotation }, head: 0, targets: {}, channels: {} };
    if (mapping.bones.head) { const head = skeleton.findBone(mapping.bones.head)!; frame.head = head.rotation - head.data.rotation; }
    for (const key of roles) {
      const anchor = mapping.bones.anchors?.[key]; if (!anchor) continue;
      const bone = skeleton.findBone(anchor.bone)!, point = anchorWorld(bone, anchor);
      frame.targets[key] = { x: (point[0] - origin[0]) / scale, y: (point[1] - origin[1]) / scale, angle: angle(bone), ...(key.endsWith("Foot") ? { contact: Math.abs(point[1] - ground) <= (args.contactTolerance ?? .001) } : {}) };
    }
    for (const [semantic, name] of Object.entries(mapping.bones.channels ?? {})) {
      const bone = skeleton.findBone(name)!; frame.channels![semantic] = { rotate: bone.rotation - bone.data.rotation, x: (bone.x - bone.data.x) / scale, y: (bone.y - bone.data.y) / scale };
    }
    frames.push(frame);
  }
  // 支撑期使用精确地面高度，离地首姿态仍在地面，之后才抬脚。
  for(const role of ['leftFoot','rightFoot'] as const) for(let i=0;i<frames.length;i++) {
    const target=frames[i].targets[role];
    if(target&&(target.contact||i>0&&frames[i-1].targets[role]?.contact)) target.y=(ground-origin[1])/scale;
  }
  const loop = args.loop ?? true;
  if (loop) {
    const end = frames.at(-1)!, first = frames[0];
    const error = Math.max(Math.abs(end.body.x - first.body.x), Math.abs(end.body.y - first.body.y), Math.abs(wrapAngle(end.body.rotate - first.body.rotate)), ...roles.map(k => Math.hypot((end.targets[k]?.x ?? 0) - (first.targets[k]?.x ?? 0), (end.targets[k]?.y ?? 0) - (first.targets[k]?.y ?? 0))));
    if (error > .001) throw new Error(`参考动画首尾不闭合：${error}，请先修正参考或使用 loop:false。`);
    frames[frames.length - 1] = { ...structuredClone(first), time: animation.duration };
  }
  const events: any[] = [];
  for (const [side, role] of [["left", "leftFoot"], ["right", "rightFoot"]] as const) for (let i = 0; i < frames.length; i++) if (i === 0 || frames[i].targets[role]?.contact !== frames[i - 1].targets[role]?.contact) events.push({ time: frames[i].time, side, type: frames[i].targets[role]?.contact ? "contact" : "release" });
  const motion: MotionDefinition = { name: args.animation, version: 2, duration: animation.duration, loop, coordinateSystem: "normalizedSkeleton", groundY: (ground - origin[1]) / scale, frames, events };
  validateMotion(motion);
  const report = { ok: true, referenceHash: document.hash, mappingFingerprint: mappingFingerprint(mapping), samples: count, duration: animation.duration, contactSource: "锚点与水平地面的几何距离；提取后需检查接触阶段", runtime: "spine-core 4.1.56" };
  if (args.dryRun === false) { await saveJson(args.motionPath, motion, context); await saveJson(args.reportPath ?? args.motionPath.replace(/\.json$/, ".report.json"), report, context); }
  return { ok: true, dryRun: args.dryRun ?? true, motion, report };
}

function setWorldAngle(bone: any, desired: number) {
  bone.rotation += wrapAngle(desired - angle(bone));
}
export function applyFollowThrough(mapping: CharacterMapping, motion: MotionDefinition, t: number, scale: number) {
  return (mapping.bones.follow ?? []).map(rule => {
    const driverRole = Object.entries(mapping.bones.channels ?? {}).find(([, bone]) => bone === rule.driver)?.[0];
    const driver = (time: number) => { const f = semanticAt(motion, ((time % motion.duration) + motion.duration) % motion.duration); return rule.driver === mapping.bones.body ? f.body.rotate : rule.driver === mapping.bones.head ? f.head ?? 0 : driverRole ? f.channels?.[driverRole]?.rotate ?? 0 : 0; };
    const h = 1 / 240, delay = rule.delay ?? 0;
    const target = (time: number) => -rule.gain * driver(time - delay) - (rule.velocityGain ?? 0) * (driver(time - delay + h) - driver(time - delay - h)) / (2 * h);
    let value = target(t);
    if (rule.stiffness !== undefined) {
      let x = 0, v = 0; const stiffness = rule.stiffness, damping = rule.damping ?? 2 * Math.sqrt(stiffness);
      for (let s = t - motion.duration * 8; s < t; s += h) { v += (stiffness * (target(s) - x) - damping * v) * h; x += v * h; }
      value = x;
    }
    return { bone: rule.bone, value };
  });
}

export function solveSemanticPose(runtime: Awaited<ReturnType<typeof loadMotionRuntime>>, mapping: CharacterMapping, f: SemanticFrame, groundY = 0, follows: Array<{bone:string; value:number}> = []) {
  const channels = [...new Set([mapping.bones.body, mapping.bones.head, ...Object.values(mapping.bones.channels ?? {}), ...[mapping.bones.leftLeg, mapping.bones.rightLeg, mapping.bones.leftArm, mapping.bones.rightArm].flatMap(c => c ?? []), ...(mapping.bones.follow ?? []).map(f => f.bone)].filter(Boolean) as string[])];
  const skeleton = runtime.sample(undefined, 0, mapping.skin);
  const unreachable: any[] = [];
  const scale = mapping.calibration!.scale, origin = mapping.calibration!.origin!;
  const time = f.time;
    applyAttachments(skeleton, mapping);
    applyPosePresentation(skeleton,f.presentation);
    const body = skeleton.findBone(mapping.bones.body)!;
    body.x += f.body.x * scale; body.y += f.body.y * scale; body.rotation += f.body.rotate;
    if (mapping.bones.head) skeleton.findBone(mapping.bones.head)!.rotation += f.head ?? 0;
    for (const [semantic, name] of Object.entries(mapping.bones.channels ?? {})) {
      const v = f.channels?.[semantic]; if (!v) continue;
      const b = skeleton.findBone(name)!; b.rotation += v.rotate; b.x += v.x * scale; b.y += v.y * scale;
    }
    skeleton.updateWorldTransform();
    for (const role of roles) {
      const target = f.targets[role]; if (!target) continue;
      const side = role.startsWith("left") ? "left" : "right", limb = `${side}${role.endsWith("Foot") ? "Leg" : "Arm"}` as "leftLeg" | "rightLeg" | "leftArm" | "rightArm";
      const chain = mapping.bones[limb], anchor = mapping.bones.anchors?.[role];
      if (!chain || chain.length !== 3 || !anchor || anchor.bone !== chain[2]) throw new Error(`${role} 缺少三段链或末端锚点。`);
      const [a, b, c] = chain.map(n => skeleton.findBone(n)!);
      const desiredAngle = target.angle ?? anchor.angle ?? angle(c);
      const world: Point = [origin[0] + target.x * scale, origin[1] + target.y * scale];
      if (target.contact) world[1] = origin[1] + (groundY) * scale;
      const factor = Math.hypot(c.a, c.c);
      const endpoint = lockFootContact(world, [anchor.point[0] * factor, anchor.point[1] * factor], desiredAngle);
      if (anchor.solePoints?.length) {
        const rad = desiredAngle * Math.PI / 180;
        endpoint[1] = world[1] - Math.min(...anchor.solePoints.map(p => factor * (p[0] * Math.sin(rad) + p[1] * Math.cos(rad))));
      }
      const lengths = mapping.calibration!.lengths?.[limb]; if (!lengths) throw new Error(`${limb} 未校准长度。`);
      const bend = f.bendDirections?.[limb] ?? mapping.bones.bendDirections?.[limb]; if (!bend) throw new Error(`${limb} 未确认弯曲方向。`);
      const ik = solveTwoBoneIK([a.worldX, a.worldY], endpoint, lengths[0], lengths[1], bend);
      if (!ik.reachable) unreachable.push({ time, role, error: ik.error });
      setWorldAngle(a, ik.upperAngle - Math.atan2(b.data.y, b.data.x) * 180 / Math.PI); skeleton.updateWorldTransform();
      setWorldAngle(b, ik.lowerAngle - Math.atan2(c.data.y, c.data.x) * 180 / Math.PI); skeleton.updateWorldTransform();
      setWorldAngle(c, desiredAngle); skeleton.updateWorldTransform();
    }
    for (const follow of follows) skeleton.findBone(follow.bone)!.rotation += follow.value;
    const bones: any = {};
    for (const name of channels) {
      const b = skeleton.findBone(name)!; let rotation = wrapAngle(b.rotation - b.data.rotation);
      const limit = mapping.bones.jointLimits?.[name]; rotation = Math.max(limit?.min ?? -Infinity, Math.min(limit?.max ?? Infinity, rotation));
      b.rotation = b.data.rotation + rotation;
      bones[name] = { rotate: rotation, translate: { x: b.x - b.data.x, y: b.y - b.data.y } };
    }
  skeleton.updateWorldTransform();
  return { skeleton, bones, unreachable };
}

function ensureAnimationDuration(animation:any,body:string,duration:number) {
 const times=Object.values(animation.bones??{}).flatMap((tls:any)=>Object.values(tls).flatMap((frames:any)=>frames.map((f:any)=>f.time??0)));
 if(Math.max(0,...times)<duration-1e-8){const frames=animation.bones[body].rotate;frames.push({...frames.at(-1),time:duration});delete frames.at(-1).curve;}
}

export async function buildSemanticAnimation(json: any, mapping: CharacterMapping, motion: MotionDefinition, options: MotionBuildOptions, context: ToolContext = {}) {
  validateMapping(mapping, json); validateMotion(motion);
  const runtime = await loadMotionRuntime(json, options.atlasPath ?? mapping.atlasPath!, context);
  const scale = mapping.calibration!.scale, origin = mapping.calibration!.origin!, duration = options.duration ?? motion.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("duration 必须是正数。");
  const count = Math.max(motion.frames!.length, Math.ceil(duration * 120) + 1);
  if (count > 10001) throw new Error("求解采样超过 10001；请缩短周期。");
  const channels = [...new Set([mapping.bones.body, mapping.bones.head, ...Object.values(mapping.bones.channels ?? {}), ...[mapping.bones.leftLeg, mapping.bones.rightLeg, mapping.bones.leftArm, mapping.bones.rightArm].flatMap(c => c ?? []), ...(mapping.bones.follow ?? []).map(f => f.bone)].filter(Boolean) as string[])];
  const poses: any[] = []; const unreachable: any[] = [];
  const sampleTimes=new Set(Array.from({length:count},(_,i)=>motion.duration*i/(count-1)));
  const intervalSamples=motion.frames!.length<=64?32:1;
  for(let i=1;i<motion.frames!.length;i++) {
    const previous=motion.frames![i-1],current=motion.frames![i];
    sampleTimes.add(current.time);
    // 快速挥击可能只有几毫秒；仅固定 120Hz 会在关键姿态之间漏掉 IK 的非线性。
    // 每个语义区间保留内部求解样本，输出仍由曲线拟合压缩，不烘焙所有样本。
    for(let step=1;step<intervalSamples;step++)sampleTimes.add(previous.time+(current.time-previous.time)*step/intervalSamples);
    for(const role of ['leftFoot','rightFoot'] as const) {
      const a=previous.targets[role],b=current.targets[role],sole=mapping.bones.anchors?.[role]?.solePoints;
      if(!a||!b||!sole||a.angle===undefined||b.angle===undefined||a.angle===b.angle)continue;
      // 脚底最低顶点切换时轨迹存在拐点，必须保留该姿态。
      for(let u=0;u<sole.length;u++)for(let v=u+1;v<sole.length;v++) {
        const dx=sole[u][0]-sole[v][0],dy=sole[u][1]-sole[v][1],base=Math.atan2(-dy,dx)*180/Math.PI;
        for(let k=Math.ceil((Math.min(a.angle,b.angle)-base)/180);k<=Math.floor((Math.max(a.angle,b.angle)-base)/180);k++) {
          const ratio=(base+k*180-a.angle)/(b.angle-a.angle);
          if(ratio>0&&ratio<1)sampleTimes.add(previous.time+(current.time-previous.time)*ratio);
        }
      }
    }
  }
  const orderedTimes=[...sampleTimes].sort((a,b)=>a-b).filter((t,i,all)=>i===0||t-all[i-1]>1e-9);
  if(orderedTimes.length>10001)throw new Error('约束关键姿态超过 10001，请减少采样或脚底顶点。');
  for (const inputTime of orderedTimes) {
    const time = duration * inputTime / motion.duration, f = semanticAt(motion, inputTime);
    const solved = solveSemanticPose(runtime, mapping, f, motion.groundY ?? 0, applyFollowThrough(mapping, motion, inputTime, scale));
    const bones = solved.bones;
    unreachable.push(...solved.unreachable);
    poses.push({ time, bones });
  }
  // 以连续角度表示 timeline，避免 ±180 度分支产生跳变。
  for (const name of channels) for (let i = 1; i < poses.length; i++) poses[i].bones[name].rotate = poses[i - 1].bones[name].rotate + wrapAngle(poses[i].bones[name].rotate - poses[i - 1].bones[name].rotate);
  const dense = poseAnimation(json, poses, channels), fitted = structuredClone(dense), stats: any[] = [];
  if (mapping.bones.slotAttachments) {
    dense.slots = Object.fromEntries(Object.entries(mapping.bones.slotAttachments).map(([slot, name]) => [slot, { attachment: [name === null ? {} : { name }] }]));
    fitted.slots = structuredClone(dense.slots);
  }
  if(motion.frames!.some(f=>f.presentation)){const visual=presentationTimelines(json,mapping,motion,duration);Object.assign(dense,visual);Object.assign(fitted,structuredClone(visual));}
  for (const [bone, tls] of Object.entries(fitted.bones) as any) for (const [kind, frames] of Object.entries(tls) as any) {
    const fit = fitCubicBezierTimeline(frames, kind === "rotate" ? ["value"] : ["x", "y"], kind === "rotate" ? options.rotationTolerance ?? .3 : options.translationTolerance ?? .07,8,0,kind==='rotate'?179:Infinity);
    tls[kind] = fit.frames; stats.push({ bone, timeline: kind, originalCount: fit.originalCount, compressedCount: fit.compressedCount, maxError: fit.maxError });
  }
  ensureAnimationDuration(fitted,mapping.bones.body,duration);
  return { animation: fitted, dense, unreachable, stats, duration };
}

export async function validateMotionResult(args: { filePath: string; mappingPath: string; motionPath: string; animation: string; duration?: number; footContactTolerance?: number; handTolerance?: number; vertexTolerance?: number }, context: ToolContext = {}) {
  const document = await readSpineDocument(args.filePath, context), mapping = await readCharacterMapping(args.mappingPath, context), motion = await readMotionDefinition(args.motionPath, context);
  if (motion.version !== 2) throw new Error("动作结果验证需要 v2 motion。");
  return evaluateResult(document.json, mapping, motion, args.animation, args, context);
}
async function evaluateResult(json: any, mapping: CharacterMapping, motion: MotionDefinition, animationName: string, options: any, context: ToolContext, dense?: any) {
  const runtime = await loadMotionRuntime(json, mapping.atlasPath!, context), duration = options.duration ?? motion.duration;
  const issues: string[] = [], scale = mapping.calibration!.scale, origin = mapping.calibration!.origin!;
  let maxFootError = 0, maxHandError = 0, maxVertexError = 0, maxTargetError = 0, loopError = 0, maxRotationError = 0, maxTranslationError = 0;
  let worstHandTime = 0, worstFootTime = 0, worstHandRole = '';
  const count = Math.max(337, Math.ceil(duration * 240) + 1), first: any = {};
  const denseName = "__motion_dense_check";
  let denseRuntime: Awaited<ReturnType<typeof loadMotionRuntime>> | undefined;
  if (dense) { const copy = structuredClone(json); copy.animations[denseName] = dense; denseRuntime = await loadMotionRuntime(copy, mapping.atlasPath!, context); }
  for (let i = 0; i < count; i++) {
    const t = duration * i / (count - 1), f = semanticAt(motion, motion.duration * i / (count - 1)), skeleton = runtime.sample(animationName, t, mapping.skin);
    for (const bone of skeleton.bones) {
      if (![bone.worldX, bone.worldY, bone.a, bone.b, bone.c, bone.d].every(Number.isFinite)) issues.push(`骨骼 ${bone.data.name} 出现非有限变换。`);
      if (i === 0) first[bone.data.name] = [bone.worldX, bone.worldY, bone.a, bone.b, bone.c, bone.d];
      if (i === count - 1 && motion.loop) [bone.worldX, bone.worldY, bone.a, bone.b, bone.c, bone.d].forEach((v, j) => loopError = Math.max(loopError, Math.abs(v - first[bone.data.name][j])));
    }
    for (const role of roles) {
      const target = f.targets[role], anchor = mapping.bones.anchors?.[role]; if (!target || !anchor) continue;
      const actual = anchorWorld(skeleton.findBone(anchor.bone)!, anchor);
      const x = origin[0] + target.x * scale, y = origin[1] + (target.contact ? motion.groundY ?? 0 : target.y) * scale;
      const e = Math.hypot(actual[0] - x, actual[1] - y); maxTargetError = Math.max(maxTargetError, e);
      if (role.endsWith("Hand")) {if(e>maxHandError){maxHandError=e;worstHandTime=t;worstHandRole=role;}}
      else if (target.contact&&e>maxFootError) {maxFootError=e;worstFootTime=t;}
    }
    const vertices = worldVertices(skeleton);
    if (Object.values(vertices).some(v => v.some(x => !Number.isFinite(x)))) issues.push("网格出现非有限顶点。");
    if (denseRuntime) {
      const oldSkeleton = denseRuntime.sample(denseName, t, mapping.skin), old = worldVertices(oldSkeleton);
      for (let b = 0; b < skeleton.bones.length; b++) { maxRotationError = Math.max(maxRotationError, Math.abs(skeleton.bones[b].rotation - oldSkeleton.bones[b].rotation)); maxTranslationError = Math.max(maxTranslationError, Math.abs(skeleton.bones[b].x - oldSkeleton.bones[b].x), Math.abs(skeleton.bones[b].y - oldSkeleton.bones[b].y)); }
      for (const [name, points] of Object.entries(vertices)) if (old[name]) for (let j = 0; j < points.length; j += 2) maxVertexError = Math.max(maxVertexError, Math.hypot(points[j] - old[name][j], points[j + 1] - old[name][j + 1]));
    }
  }
  if (loopError > 1e-4) issues.push(`首尾姿态误差 ${loopError}。`);
  if (maxFootError > (options.footContactTolerance ?? .001)) issues.push(`脚底接触误差 ${maxFootError} 超过阈值。`);
  if (maxHandError > (options.handTolerance ?? .1)) issues.push(`手腕误差 ${maxHandError} 超过阈值。`);
  if (maxVertexError > (options.vertexTolerance ?? 1.2)) issues.push(`网格压缩误差 ${maxVertexError} 超过阈值。`);
  if (dense && maxRotationError > (options.rotationTolerance ?? .3) + 1e-8) issues.push(`runtime 旋转压缩误差 ${maxRotationError} 超过阈值。`);
  if (dense && maxTranslationError > (options.translationTolerance ?? .07) + 1e-8) issues.push(`runtime 位移压缩误差 ${maxTranslationError} 超过阈值。`);
  for (const [name, tls] of Object.entries(json.animations[animationName].bones ?? {}) as any) {
    const frames = tls.rotate ?? [];
    for (let i = 1; i < frames.length; i++) if (Math.abs((frames[i].value ?? 0) - (frames[i - 1].value ?? 0)) >= 180) issues.push(`${name} 存在旋转跳变。`);
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)], samples: count, loopError, maxFootError, maxHandError, worstHandTime, worstHandRole, worstFootTime, maxTargetError, maxRotationError: dense ? maxRotationError : null, maxTranslationError: dense ? maxTranslationError : null, maxVertexError: dense ? maxVertexError : null, runtime: "spine-core 4.1.56", meshComparison: dense ? "压缩结果与同角色稠密求解结果" : "未提供稠密基线，未评估压缩顶点偏差" };
}

export async function retargetSemanticMotion(args: MotionBuildOptions, context: ToolContext = {}) {
  return (await import('./jobTools.js')).withFileLock(args.filePath, context, () => retargetSemanticMotionLocked(args, context));
}
async function retargetSemanticMotionLocked(args: MotionBuildOptions, context: ToolContext = {}) {
  if (args.diagnosticPreview && args.dryRun === false) throw new Error('diagnosticPreview 仅支持 dryRun，不能提交诊断动画。');
  const document = await readSpineDocument(args.filePath, context), mapping = await readCharacterMapping(args.mappingPath, context), motion = await readMotionDefinition(args.motionPath!, context);
  validateMapping(mapping, document.json); validateMotion(motion);
  const calibrationReport = await assertConfirmedMapping(mapping, document.json, document.hash, context);
  if (args.expectedHash && args.expectedHash !== document.hash) throw new Error("expectedHash mismatch。");
  if (args.dryRun === false && !args.expectedHash) throw new Error("真实写入必须传入 dryRun 返回的 expectedHash 和 reviewToken。");
  const build = await buildSemanticAnimation(document.json, mapping, motion, args, context);
  const candidate = structuredClone(document.json); candidate.animations ??= {}; candidate.animations[args.animation] = build.animation;
  let structure = validateSpineJson(candidate), spec = validateOfficialAnimationSpec(candidate);
  let validation = await evaluateResult(candidate, mapping, motion, args.animation, { ...args, duration: build.duration }, context, build.dense);
  // 曲线压缩也会放大末端接触/手腕误差；收紧拟合后重新验证，不能放宽门槛。
  for (let attempt = 1; attempt <= 6 && !validation.ok && !build.unreachable.length && validation.issues.some(x => /压缩误差|脚底接触误差|手腕误差/.test(x)); attempt++) {
    const fitted = structuredClone(build.dense);
    const retryStats: any[] = [];
    for (const [bone, tls] of Object.entries(fitted.bones) as any) for (const [kind, frames] of Object.entries(tls)) { const fit = fitCubicBezierTimeline(frames as any, kind === 'rotate' ? ['value'] : ['x','y'], (kind === 'rotate' ? args.rotationTolerance ?? .3 : args.translationTolerance ?? .07) / (4 ** attempt)); tls[kind] = fit.frames; retryStats.push({ bone, timeline: kind, originalCount: fit.originalCount, compressedCount: fit.compressedCount, maxError: fit.maxError, runtimeRefitAttempt: attempt }); }
    ensureAnimationDuration(fitted,mapping.bones.body,build.duration);
    candidate.animations[args.animation] = fitted;
    build.animation = fitted;
    build.stats = retryStats;
    structure = validateSpineJson(candidate); spec = validateOfficialAnimationSpec(candidate);
    validation = await evaluateResult(candidate, mapping, motion, args.animation, { ...args, duration: build.duration }, context, build.dense);
  }
  if (build.unreachable.length) { validation.ok = false; validation.issues.push(`存在 ${build.unreachable.length} 个不可达手脚目标。`); }
  const ok = structure.ok && spec.ok && validation.ok;
  const workflow=await (await import('./poseWorkflow.js')).poseGate(motion,context);
  if(workflow.ok&&workflow.sourceFingerprint!==(await (await import('./poseWorkflow.js')).characterFingerprint(args.filePath,args.mappingPath,context)).fingerprint){workflow.ok=false;workflow.issues.push('姿态审查与当前目标角色不匹配。');}
  const tokenData = { poseReview:workflow.fingerprint, fileHash: document.hash, mapping: mappingFingerprint(mapping), motion: hashObject(motion), animation: args.animation, value: hashObject(build.animation), thresholds: [args.footContactTolerance, args.handTolerance, args.vertexTolerance], overwrite: args.overwrite ?? false };
  const reviewToken = hashObject(tokenData), reviewPath = `.spine-mcp/reviews/${reviewToken}.json`;
  const resultReportPath = `previews/reports/motion-${reviewToken}.json`;
  await saveJson(resultReportPath, { ok, sourceHash: document.hash, mappingFingerprint: mappingFingerprint(mapping), motionHash: hashObject(motion), animation: args.animation, thresholds: tokenData.thresholds, calibrationReport: mapping.reportPath, validation, structure, spec, unreachable: build.unreachable, stats: build.stats }, context);
  let preview: any = null;
  if (ok && args.preview !== false) {
    try { preview = await (await import('./previewRenderTools.js')).renderContactSheet({ filePath: args.filePath, atlasPath: args.atlasPath ?? mapping.atlasPath!, mappingPath: args.mappingPath, motionPath: args.motionPath, skin: mapping.skin, animation: args.animation, jsonOverride: candidate, frames: 8 }, context); }
    catch (e) { preview = { ok: false, error: String(e), message: '视觉产物生成失败；数值门禁与视觉检查分开报告。' }; }
  }
  if (args.diagnosticPreview) {
    const outputDir = `previews/jobs/diagnostic-${reviewToken}`;
    const candidatePath = `${outputDir}/candidate.json`;
    await saveJson(candidatePath, candidate, context);
    let posePreview:any=null, animationPreview:any=null;
    const previewIssues:string[]=[];
    try {
      if (motion.poseWorkflow?.keyPoses.length) posePreview=await (await import('./poseWorkflow.js')).renderPoseComparison({posePaths:motion.poseWorkflow.keyPoses.map(p=>p.posePath),targetTimes:motion.poseWorkflow.keyPoses.map(p=>p.time),stageIds:motion.poseWorkflow.keyPoses.map(p=>p.stageId),outputDir:`${outputDir}/poses`},context);
      animationPreview=await (await import('./previewRenderTools.js')).renderAnimationGif({filePath:args.filePath,atlasPath:mapping.atlasPath!,skin:mapping.skin,animation:args.animation,jsonOverride:candidate,frames:Math.min(240,Math.max(2,Math.ceil(build.duration*30))),fps:30,width:320,height:320,bounds:posePreview?.bounds,outputDir:`${outputDir}/animation`},context);
    } catch(e) { previewIssues.push(String(e)); }
    const keyGraphs=await (await import('./referenceRetarget.js')).compareAnimationKeyPoses(candidatePath,args.animation,motion,build.duration,context);
    const result={ok:false,diagnosticOnly:true,dryRun:true,wroteFile:false,readyToCommit:false,readyForAnimationReview:false,numericOk:ok,motionValidation:validation,structure,spec,unreachable:build.unreachable.slice(0,20),stats:build.stats,poseGate:workflow,keyGraphs,posePreview,animationPreview,previewIssues,candidatePath,reportPath:resultReportPath,message:'完整诊断候选：保留全部失败项，无 reviewToken，不批准或写入原角色。'};
    await saveJson(`${outputDir}/diagnostic-report.json`,result,context);
    return result;
  }
  if (!ok) return { ok: false, dryRun: true, wroteFile: false, validation, structure, spec, unreachable: build.unreachable.slice(0, 20), stats: build.stats, reportPath: resultReportPath, message: "动作门禁未通过，未写入角色文件。" };
  if (args.dryRun !== false) {
    const candidatePath=`previews/jobs/candidate-${reviewToken}/candidate.json`;
    await saveJson(candidatePath,candidate,context);
    let posePreview:any=null,animationPreview:any=null;
    if(workflow.ok){
      posePreview=await (await import('./poseWorkflow.js')).renderPoseComparison({posePaths:motion.poseWorkflow!.keyPoses.map(p=>p.posePath),targetTimes:motion.poseWorkflow!.keyPoses.map(p=>p.time),stageIds:motion.poseWorkflow!.keyPoses.map(p=>p.stageId),outputDir:`previews/jobs/candidate-${reviewToken}/poses`},context);
      animationPreview=await (await import('./previewRenderTools.js')).renderAnimationGif({filePath:args.filePath,atlasPath:mapping.atlasPath!,skin:mapping.skin,animation:args.animation,jsonOverride:candidate,frames:Math.min(240,Math.max(2,Math.ceil(build.duration*30))),fps:30,width:320,height:320,bounds:posePreview.bounds,outputDir:`previews/jobs/candidate-${reviewToken}/animation`},context);
    }
    const result = await writeGeneratedAnimation(args.filePath, { ...args, value: build.animation, expectedHash: document.hash, dryRun: true }, context);
    const keyGraphs=workflow.ok?await (await import('./referenceRetarget.js')).compareAnimationKeyPoses(candidatePath,args.animation,motion,build.duration,context):{ok:false,reports:[],issues:workflow.issues};
    await saveJson(`${candidatePath}.key-graphs.json`,keyGraphs,context);
    await saveJson(reviewPath, { tokenData, reviewToken, candidatePath, duration:build.duration,candidateHash:hashObject(candidate), motionPath:args.motionPath, requiresReferenceComparison:!!posePreview?.reference }, context);
    return { ...result, ok: true, readyToCommit:false,readyForAnimationReview:workflow.ok&&keyGraphs.ok,reviewToken, poseGate:workflow, keyGraphs,posePreview, animationPreview, candidatePath, motionValidation: validation, stats: build.stats, preview, reportPath: resultReportPath,message:'ok 仅表示候选数值生成成功；提交还需姿态关系及完整动画审查。' };
  }
  if(!workflow.ok)throw new Error(workflow.issues.join('；'));
  await (await import('./animationReview.js')).assertAnimationReview(reviewToken,args.reviewToken,context);
  if (args.preview !== false && preview?.ok !== true) throw new Error('视觉预览未成功，不能完成默认流水线提交。请修复资源或明确 preview:false 仅执行数值流程。');
  const review = JSON.parse(await readFile(resolveWorkspacePath(reviewPath, context), "utf8"));
  if (review.reviewToken !== reviewToken || hashObject(review.tokenData) !== reviewToken) throw new Error("缺少有效 dryRun 审查记录。");
  const result = await writeGeneratedAnimation(args.filePath, { ...args, value: build.animation, expectedHash: document.hash, dryRun: false }, context);
  mapping.sourceHash = result.hashAfter!; calibrationReport.sourceHash = result.hashAfter!;
  await saveJson(mapping.reportPath!, calibrationReport, context); await saveJson(args.mappingPath, mapping, context);
  return { ...result, ok: true, reviewToken, motionValidation: validation, stats: build.stats, preview, reportPath: resultReportPath };
}
