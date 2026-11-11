import { createHash } from 'node:crypto';
import { hashObject } from './mappingTools.js';

export const animationComparisonLayouts = ['reference-above-target','overlay','skeleton'] as const;
export type AnimationComparisonLayout = typeof animationComparisonLayouts[number];

export function isAnimationComparisonLayout(value: unknown): value is AnimationComparisonLayout {
  return typeof value === 'string' && (animationComparisonLayouts as readonly string[]).includes(value);
}

export function assertAnimationComparisonLayout(value: unknown): asserts value is AnimationComparisonLayout {
  if (!isAnimationComparisonLayout(value)) throw new Error("layout 必须为 'reference-above-target'（上参考下目标）、'overlay'（外观叠加）或 'skeleton'（骨架叠加）。");
}

export type AnimationComparisonMode = 'legacy-raw-diagnostic' | 'retargeted';

const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/**
 * 当前旧骨架 GIF 的证据合同：参考侧是单帧，目标侧是原始 bones 轨迹。
 * 这类证据可以帮助定位问题，但绝不能被解释为已完成重定向的动作比较。
 */
export function isRawOnlyEvidence(manifest: any): boolean {
  if (manifest?.comparisonMode === 'retargeted') return manifest?.rawDiagnosticOnly === true;
  return manifest?.comparisonMode === 'legacy-raw-diagnostic'
    || manifest?.rawDiagnosticOnly === true
    || manifest?.skeletonSource === 'reference-single-frame'
    || manifest?.targetSource === 'trajectories.bones';
}

export function hasExpectedRetargetTarget(manifest: any): boolean {
  return manifest?.comparisonMode === 'retargeted'
    && typeof manifest?.expectedTargetSource === 'string'
    && manifest.expectedTargetSource.trim().length > 0
    && sha256(manifest?.expectedTargetManifestHash);
}

export function hasActualTarget(manifest: any): boolean {
  return manifest?.comparisonMode === 'retargeted'
    && typeof manifest?.actualTargetSource === 'string'
    && manifest.actualTargetSource.trim().length > 0
    && sha256(manifest?.actualTargetManifestHash);
}

/**
 * expected-only generation 的来源门禁。它故意不要求 actual target；actual
 * 只有在候选动画通过 runtime 采样后，才能由比较器补齐。
 */
export function expectedRetargetManifestProblem(manifest: any): string | null {
  if (isRawOnlyEvidence(manifest)) return 'expected target 来源仍是 raw-only evidence，不能作为 retarget generation 输入。';
  if (manifest?.comparisonMode !== 'retargeted') return 'expected target manifest 必须明确 comparisonMode:retargeted。';
  if (manifest?.retargetMode != null && !['adaptive','strict'].includes(manifest.retargetMode)) return 'retarget manifest 的 retargetMode 无效。';
  if (manifest?.status != null && !['semantic-pass','geometric-adapted','unresolved'].includes(manifest.status)) return 'retarget manifest 的适配状态无效。';
  if (manifest?.status === 'unresolved') return 'retarget expected target 仍有未解决语义硬约束。';
  if (referenceApprovalDecision(manifest) !== 'approved') return 'expected target manifest 缺少 approved reference 绑定。';
  if (!sha256(referenceApprovalFingerprint(manifest))) return 'expected target manifest 缺少 reference approval fingerprint。';
  if (!hasExpectedRetargetTarget(manifest)) return 'expected target manifest 缺少完整 expected target 哈希。';
  const expectedTargets = Array.isArray(manifest?.expectedTargets)
    ? manifest.expectedTargets
    : manifest?.expectedTarget ? [manifest.expectedTarget] : [];
  if (manifest?.visualPointsAvailable !== true || !expectedTargets.length || expectedTargets.some((target: any) => target?.visualPointsAvailable !== true)) return 'expected target 缺少完整 visualPoints.';
  if (expectedTargets.some((target: any) => !Number.isFinite(target?.targetTime))) return 'expected target 缺少有效 targetTime。';
  const targetTimes = expectedTargets.map((target: any) => target.targetTime);
  if (targetTimes.some((time: number, index: number) => index > 0 && time <= targetTimes[index - 1])) return 'expected target 的 targetTime 必须严格递增。';
  const expectedTargetHash = Array.isArray(manifest?.expectedTargets)
    ? hashObject(expectedTargets)
    : hashObject(expectedTargets[0]);
  if (manifest?.expectedTargetManifestHash !== expectedTargetHash) return 'expected target manifest 哈希与 expected target 内容不一致。';
  if (manifest?.expectedSampleFingerprint !== undefined) {
    if (manifest.expectedSampleFingerprint !== hashObject({ targetTimes })) return 'expected target 采样指纹与 targetTime 不一致。';
  }
  if (manifest?.formalEligible === false && manifest?.acceptanceMode !== 'diagnostic') return 'expected target manifest 的 acceptance 标记不一致。';
  return null;
}

function referenceApprovalDecision(manifest: any): string | null {
  return manifest?.referenceApprovalDecision
    ?? manifest?.referenceApproval?.decision
    ?? manifest?.referenceStatus
    ?? null;
}

function referenceApprovalFingerprint(manifest: any): string | null {
  return manifest?.referenceApprovalFingerprint
    ?? manifest?.referenceApproval?.fingerprint
    ?? null;
}

export function isRejectedReferenceEvidence(manifest: any): boolean {
  return referenceApprovalDecision(manifest) === 'rejected';
}

export function retargetFormalAcceptanceReady(manifest: any): boolean {
  return manifest?.comparisonMode === 'retargeted'
    && manifest?.acceptanceMode === 'formal'
    && manifest?.acceptanceEligible === true
    && !isRawOnlyEvidence(manifest)
    && referenceApprovalDecision(manifest) === 'approved'
    && sha256(referenceApprovalFingerprint(manifest))
    && hasExpectedRetargetTarget(manifest)
    && hasActualTarget(manifest)
    && manifest?.visualPointsAvailable === true
    && (manifest?.expectedSampleFingerprint == null
      || manifest?.expectedSampleFingerprint === manifest?.actualSampleFingerprint)
    && manifest?.formalEligible !== false;
}

export function retargetManifestProblem(manifest: any): string | null {
  if (isRawOnlyEvidence(manifest)) return '当前证据仅包含参考单帧与目标原始 bones 轨迹（legacy-raw-diagnostic），不能作为正式动作一致性验收。';
  if (isRejectedReferenceEvidence(manifest)) return '参考动作当前为 rejected，不能生成或批准正式 retargeted comparison。';
  if (manifest?.comparisonMode !== 'retargeted') return '正式动作一致性验收必须明确 comparisonMode:retargeted，不能从旧 raw 证据推断。';
  if (manifest?.retargetMode != null && !['adaptive','strict'].includes(manifest.retargetMode)) return 'retarget manifest 的 retargetMode 无效。';
  if (manifest?.status != null && !['semantic-pass','geometric-adapted','unresolved'].includes(manifest.status)) return 'retarget manifest 的适配状态无效。';
  if (manifest?.status === 'unresolved') return 'retarget manifest 仍有未解决语义硬约束。';
  if (!referenceApprovalDecision(manifest) || referenceApprovalDecision(manifest) !== 'approved') return '正式 retargeted comparison 缺少 approved reference 绑定。';
  if (!sha256(referenceApprovalFingerprint(manifest))) return '正式 retargeted comparison 缺少 reference approval fingerprint。';
  if (!hasExpectedRetargetTarget(manifest)) return '缺少 expected target 重定向产物或其完整哈希，不能进行正式比较。';
  if (!hasActualTarget(manifest)) return '缺少 candidate runtime actual target 产物或其完整哈希，不能进行正式比较。';
  if (manifest?.visualPointsAvailable !== true) return 'actual target 缺少逐帧 visualPoints，非原点视觉节点不能进入正式验收。';
  if (manifest?.expectedSampleFingerprint != null && manifest.expectedSampleFingerprint !== manifest.actualSampleFingerprint) return 'expected target 与 actual target 的采样指纹不一致，不能进行正式比较。';
  if (manifest?.formalEligible === false) return 'retarget manifest 已明确标记为非正式证据。';
  return null;
}

export function skeletonFormalAcceptanceReady(manifest: any): boolean {
  if (manifest?.acceptanceMode !== 'formal' || manifest?.acceptanceEligible !== true) return false;
  if (isRawOnlyEvidence(manifest)) return false;
  return manifest?.comparisonMode === 'retargeted' ? retargetFormalAcceptanceReady(manifest) : true;
}

/** 渲染层固定产物名：layout 与 gif 文件名一一对应，禁止只改 layout 字段改变证据语义。 */
export const comparisonGifNames: Record<AnimationComparisonLayout, string> = {
  'reference-above-target': 'reference-above-target.gif',
  overlay: 'reference-overlay.gif',
  skeleton: 'reference-skeleton.gif',
};

export function comparisonLayoutMatchesGif(manifest: any): boolean {
  const expected = comparisonGifNames[manifest?.layout as AnimationComparisonLayout];
  if (!expected || typeof manifest?.gifPath !== 'string') return false;
  return manifest.gifPath.split(/[\\/]/).pop() === expected;
}

/**
 * 骨架证据判定不依赖可编辑的 layout 字符串：只要报告里带任一骨架渲染特征字段，
 * 它就仍是骨架叠加证据，必须走 formal 资格门禁，避免把 diagnostic manifest 改成
 * overlay/reference-above-target 后绕过正式批准检查。
 */
export function isSkeletonEvidence(manifest: any): boolean {
  return manifest?.skeletonSource === 'reference-single-frame'
    || manifest?.targetSource === 'trajectories.bones'
    || manifest?.acceptanceMode !== undefined
    || manifest?.semanticMapped !== undefined
    || manifest?.semanticComplete !== undefined
    || manifest?.acceptanceEligible !== undefined
    || manifest?.diagnosticOnly !== undefined
    || manifest?.verifiedRig !== undefined
    || manifest?.metricsAvailable !== undefined
    || manifest?.metricsAcceptanceReady !== undefined
    || manifest?.semanticMappingReason !== undefined
    || manifest?.comparisonMode !== undefined
    || manifest?.expectedTargetSource !== undefined
    || manifest?.actualTargetSource !== undefined
    || manifest?.rawTargetSource !== undefined
    || manifest?.expectedTargetManifestHash !== undefined
    || manifest?.actualTargetManifestHash !== undefined
    || manifest?.referenceApprovalDecision !== undefined
    || manifest?.referenceApprovalFingerprint !== undefined
    || manifest?.formalEligible !== undefined
    || Array.isArray(manifest?.unmappedRoles)
    || Array.isArray(manifest?.skeletonMetrics);
}

/** 生成时把布局与证据关键字段固化成指纹；旧 manifest 无此字段时由调用方跳过该校验。 */
const fingerprintFields = [
  'layout','gifPath','jsonHash','originalSpeedGif','frameCount','frameTimes',
  'skeletonSource','targetSource','acceptanceMode','verifiedRig','semanticMapped',
  'semanticComplete','unmappedRoles','correspondenceSource','targetFacing',
  'metricsAvailable','metricsAcceptanceReady','acceptanceEligible',
  'comparisonMode','expectedTargetSource','actualTargetSource','rawTargetSource',
  'expectedTargetManifestHash','actualTargetManifestHash','retargetManifestFingerprint',
  'retargetMode','retargetStatus','retargetQuality','preservedConstraints','relaxedConstraints','retargetResiduals',
  'referenceApprovalDecision','referenceApprovalFingerprint','targetCharacterFingerprint',
  'actionBindingFingerprint','visualRigFingerprint','expectedSampleFingerprint',
  'actualSampleFingerprint','visualPointsAvailable','rawDiagnosticOnly','formalEligible',
] as const;

export function comparisonManifestFingerprint(manifest: any): string {
  const payload = Object.fromEntries(fingerprintFields.map(key => [key, manifest?.[key] ?? null]));
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * 两端共用的对比证据校验。返回中文问题说明，由调用方按自身错误类型抛出：
 * detached reviewAnimation 抛 Error，Host commit 抛 HostError。
 * 校验顺序：GIF 存在 → 布局合法 → layout 与产物名一致 → 指纹未漂移 → 骨架证据 formal 资格。
 */
export function comparisonManifestProblem(manifest: any, decision: string, requiresReferenceComparison: boolean): string | null {
  if (!manifest?.gifPath) return '缺少同步对比 GIF。';
  if (requiresReferenceComparison) {
    if (!animationComparisonLayouts.includes(manifest.layout)) return '有参考的任务需同步对比 GIF（上下排列/外观叠加/骨架叠加）和原速 GIF。';
    if (!comparisonLayoutMatchesGif(manifest)) return '对比布局与 GIF 产物名不一致，不能通过修改 layout 字段改变证据语义。';
  }
  if (manifest.layoutFingerprint !== undefined && manifest.layoutFingerprint !== comparisonManifestFingerprint(manifest)) return '对比 manifest 的布局/证据字段已变化，请重新生成对比图。';
  if (decision === 'approved' && isSkeletonEvidence(manifest)) {
    const retargetProblem = manifest?.comparisonMode === 'retargeted' || isRawOnlyEvidence(manifest)
      ? retargetManifestProblem(manifest)
      : null;
    if (retargetProblem) return retargetProblem;
    if (!skeletonFormalAcceptanceReady(manifest)) return '骨架叠加证据只是诊断证据；正式批准必须使用 acceptanceMode:formal 且 acceptanceEligible:true。';
  }
  return null;
}
