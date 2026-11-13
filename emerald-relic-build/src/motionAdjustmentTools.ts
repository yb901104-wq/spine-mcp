import { readMotionDefinition, validateMotion } from './motionEngine.js';
import { saveJson } from './mappingTools.js';
import type { ToolContext } from './spineJson.js';

export async function adjustMotion(name: string, args: { motionPath: string; outputMotionPath: string; side?: 'left' | 'right'; time?: number; x?: number; y?: number; angle?: number; contact?: boolean; factor?: number; bodyBob?: number; sway?: number; dryRun?: boolean }, context: ToolContext = {}) {
  const motion = structuredClone(await readMotionDefinition(args.motionPath, context));
  if (motion.version !== 2 || !motion.frames) throw new Error('局部约束工具要求 v2 motion。');
  if (args.motionPath === args.outputMotionPath) throw new Error('请使用新 outputMotionPath，保留原始动作。');
  if (name.includes('target') || name.includes('contact')) {
    if (!args.side || args.time === undefined || !Number.isFinite(args.time) || args.time < 0 || args.time > motion.duration) throw new Error('必须指定 side 和动作周期内的 time。');
    const frame = motion.frames.find(f => Math.abs(f.time - args.time!) < 1e-6);
    if (!frame) throw new Error('time 必须对应现有主要姿态，请先查看 motion。');
    const role = `${args.side}${name.includes('hand') ? 'Hand' : 'Foot'}` as 'leftFoot';
    const target = frame.targets[role]; if (!target) throw new Error('动作缺少目标点。');
    Object.assign(target, { ...(args.x === undefined ? {} : { x: args.x }), ...(args.y === undefined ? {} : { y: args.y }), ...(args.angle === undefined ? {} : { angle: args.angle }), ...(args.contact === undefined ? {} : { contact: args.contact }) });
    if (name.includes('lock_foot')) { target.contact = true; target.y = motion.groundY ?? 0; }
    if (motion.loop && (frame === motion.frames[0] || frame === motion.frames.at(-1))) { const other = frame === motion.frames[0] ? motion.frames.at(-1)! : motion.frames[0]; other.targets[role] = structuredClone(target); }
  } else if (name.includes('body')) {
    for (const f of motion.frames) { if (args.bodyBob !== undefined) f.body.y += args.bodyBob * Math.sin(2 * Math.PI * f.time / motion.duration); if (args.sway !== undefined) f.body.x += args.sway * Math.sin(2 * Math.PI * f.time / motion.duration); }
  } else {
    if (!Number.isFinite(args.factor) || args.factor! <= 0) throw new Error('factor 必须大于0。');
    for (const role of (name.includes('arm') ? ['leftHand', 'rightHand'] : ['leftFoot', 'rightFoot']) as Array<'leftFoot'>) {
      const points = motion.frames.map(f => f.targets[role]).filter(Boolean); const center = points.reduce((sum, p) => sum + p!.x, 0) / points.length;
      for (const p of points) p!.x = center + (p!.x - center) * args.factor!;
    }
  }
  if (motion.loop) { const first = structuredClone(motion.frames[0]); first.time = motion.duration; motion.frames[motion.frames.length - 1] = first; }
  validateMotion(motion);
  if (args.dryRun === false) await saveJson(args.outputMotionPath, motion, context);
  return { ok: true, dryRun: args.dryRun ?? true, motion, outputMotionPath: args.outputMotionPath, nextStep: '用新 motion 调用 spine_retarget_motion，自动重算 IK、曲线和验证；该工具不直接旋转骨骼。' };
}
