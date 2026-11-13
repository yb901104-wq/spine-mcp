export type RetargetMode = 'adaptive' | 'strict';
export type ConstraintTier = 'semanticHard' | 'structuralSoft' | 'styleDiagnostic';

export const retargetModes = ['adaptive', 'strict'] as const;

/** 新请求默认 adaptive；缺少字段的旧资产在复核时仍按 strict 解释。 */
export function resolveRetargetMode(value: unknown, legacy = false): RetargetMode {
  if (value === 'strict' || value === 'adaptive') return value;
  return legacy ? 'strict' : 'adaptive';
}

const semanticExact = new Set([
  'body.torsoDirection',
  'body.twist',
  'grip.direction',
  'left.support',
  'right.support',
  'action.weaponHand',
  'action.bodyView',
  'action.occlusion',
]);

export function constraintTier(id: string): ConstraintTier {
  if (semanticExact.has(id) || id.startsWith('action.occlusion.') || id.startsWith('depth.')) return 'semanticHard';
  if (id.endsWith('.bendSide') || id.endsWith('.extension') || id.endsWith('.frontGrip')) return 'semanticHard';
  if (id.includes('Silhouette') || id.startsWith('head.orientation') || id.startsWith('head.turnBand')) return 'styleDiagnostic';
  return 'structuralSoft';
}

export function isBlockingMetric(metric: any, mode: RetargetMode): boolean {
  if (mode === 'strict') return metric.required !== false;
  return constraintTier(String(metric?.id ?? '')) === 'semanticHard';
}

export function adaptationStatus(metrics: any[], conflicts: string[] = []) {
  if (conflicts.length) return 'unresolved' as const;
  const failedSoft = metrics.some(m => m.status === 'fail' && m.constraintTier === 'structuralSoft');
  const failedDiagnostic = metrics.some(m => m.status === 'fail' && m.constraintTier === 'styleDiagnostic');
  return failedSoft || failedDiagnostic ? 'geometric-adapted' as const : 'semantic-pass' as const;
}

export function adaptationSummary(metrics: any[], mode: RetargetMode, conflicts: string[] = []) {
  const preservedConstraints = metrics.filter(m => isBlockingMetric(m, mode) && m.status === 'pass').map(m => m.id);
  const relaxedConstraints = mode === 'adaptive'
    ? metrics.filter(m => !isBlockingMetric(m, mode) && m.status === 'fail').map(m => m.id)
    : [];
  const residuals = Object.fromEntries(metrics.filter(m => Number.isFinite(m.error)).map(m => [m.id, m.error]));
  const blockingFailures = metrics.filter(m => isBlockingMetric(m, mode) && m.status !== 'pass').map(m => m.id);
  const status = adaptationStatus(metrics, [...conflicts, ...blockingFailures]);
  const total = metrics.filter(m => m.status === 'pass' || m.status === 'fail').length;
  const quality = total ? Math.max(0, Math.min(1, 1 - relaxedConstraints.length / total)) : 0;
  const byTier = (tier: ConstraintTier) => metrics.filter(m => m.constraintTier === tier && (m.status === 'pass' || m.status === 'fail'));
  const tierQuality = (tier: ConstraintTier) => {
    const values = byTier(tier);
    return values.length ? Math.max(0, Math.min(1, values.filter(m => m.status === 'pass').length / values.length)) : 1;
  };
  const semanticFailures = metrics.filter(m => m.constraintTier === 'semanticHard' && m.status !== 'pass').map(m => m.id);
  const structuralResiduals = Object.fromEntries(metrics.filter(m => m.constraintTier === 'structuralSoft' && m.status === 'fail' && Number.isFinite(m.error)).map(m => [m.id, m.error]));
  const styleResiduals = Object.fromEntries(metrics.filter(m => m.constraintTier === 'styleDiagnostic' && m.status === 'fail' && Number.isFinite(m.error)).map(m => [m.id, m.error]));
  return {
    status,
    retargetQuality: quality,
    semanticQuality: tierQuality('semanticHard'),
    structuralQuality: tierQuality('structuralSoft'),
    styleQuality: tierQuality('styleDiagnostic'),
    preservedConstraints,
    relaxedConstraints,
    residuals,
    semanticFailures,
    structuralResiduals,
    styleResiduals,
    blockingFailures,
  };
}

/**
 * 完整 motion 的 runtime 验证结果分层。adaptive 只能放宽压缩产生的数值残差；
 * 脚底、握持、不可达和结构/规范错误仍然属于语义或运行时硬失败。
 */
export function classifyMotionValidation(validation: any, mode: RetargetMode, unreachable: any[] = []) {
  const issues = Array.isArray(validation?.issues) ? validation.issues : [];
  const relaxable = mode === 'adaptive'
    ? issues.filter((issue: unknown) => typeof issue === 'string' && /网格压缩误差|runtime 旋转压缩误差|runtime 位移压缩误差/.test(issue))
    : [];
  const blocking = issues.filter((issue: unknown) => !relaxable.includes(issue));
  const meaningfulUnreachable = unreachable.filter((entry: any) => entry?.meaningful !== false && !(Number.isFinite(entry?.error) && Number.isFinite(entry?.tolerance) && entry.error <= entry.tolerance));
  if (meaningfulUnreachable.length) blocking.push(`存在 ${meaningfulUnreachable.length} 个不可达手脚目标。`);
  const uniqueBlocking = [...new Set(blocking)];
  const relaxedConstraints = relaxable.map((issue: string) =>
    issue.includes('网格') ? 'meshCompression' : issue.includes('旋转') ? 'runtimeRotationCompression' : 'runtimeTranslationCompression');
  const preservedConstraints = uniqueBlocking.length === 0
    ? ['runtime', 'footContacts', 'handTargets']
    : ['runtime'];
  const status = uniqueBlocking.length ? 'unresolved' as const : relaxable.length ? 'geometric-adapted' as const : 'semantic-pass' as const;
  const total = Math.max(1, uniqueBlocking.length + relaxable.length + 3);
  return {
    ok: uniqueBlocking.length === 0,
    status,
    retargetQuality: Math.max(0, Math.min(1, 1 - relaxable.length / total)),
    semanticQuality: uniqueBlocking.length ? 0 : 1,
    structuralQuality: relaxable.length ? Math.max(0, 1 - relaxable.length / total) : 1,
    styleQuality: 1,
    preservedConstraints,
    relaxedConstraints: [...new Set(relaxedConstraints)],
    residuals: {
      maxFootError: validation?.maxFootError ?? null,
      maxHandError: validation?.maxHandError ?? null,
      maxTargetError: validation?.maxTargetError ?? null,
      maxVertexError: validation?.maxVertexError ?? null,
      maxRotationError: validation?.maxRotationError ?? null,
      maxTranslationError: validation?.maxTranslationError ?? null,
    },
    blockingIssues: uniqueBlocking,
    semanticFailures: uniqueBlocking.filter(issue => !/压缩误差|runtime/.test(String(issue))),
    reachabilityFailures: meaningfulUnreachable,
  };
}
