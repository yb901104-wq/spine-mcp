import { poseInputHash } from './animationKernel.js';

/** 同一份确定性候选用于求解比较、审查与保存，避免审查与落盘指纹分叉。 */
export function materializeHostPose(input: any, derived: any) {
  const pose = structuredClone(input);
  for (const key of ['solution','review','comparisonPath','comparison','reviewToken','authorization']) delete pose[key];
  pose.solution = { bones: derived.bones, ...derived.numeric, inputFingerprint: poseInputHash(input), dependencyFingerprint: derived.poseDependencyFingerprint };
  pose.status = derived.numeric.ok === true ? 'solved' : 'failed';
  return pose;
}
