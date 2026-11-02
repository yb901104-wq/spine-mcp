import { readFile } from 'node:fs/promises';
import { HostError, objectHash, strictHash } from './hostContracts.js';
import type { HostEditorStore } from './hostEditorStore.js';
import type { ToolContext } from './spineJson.js';
import { summarizeObservation } from './hostObservation.js';
import { hostBuildFingerprint, newEvidencePath, OBSERVATION_ROOT, ObservationAuthority, observationPublicKey, readSignedFile, relativeFile, releaseBinding, REVIEW_CHECKS, writeEvidenceFile, type ProtectFile } from './hostReleaseEvidence.js';

export const C1_ROLLOUT_SCOPE = 'c1-pose-single-hand-draft-v1';
const MAX_REVIEW_AGE_MS = 24 * 60 * 60 * 1000;
export interface ReleaseEvidenceFiles { regression: string; clientPerformance: string; transactions: string; desktop: string }
export async function preflightRolloutReview(report: string, evidence: ReleaseEvidenceFiles, context: ToolContext) {
  const candidate = await hostBuildFingerprint(), checked = await checkedObservationReport(report, context, candidate.hash, Date.now());
  return { candidateHash: candidate.hash, reportHash: checked.fileHash, windowSpanMs: checked.report.windowSpanMs, monitoredMs: checked.report.monitoredMs,
    gapCount: checked.report.gapCount, uncleanSessions: checked.report.uncleanSessions, inconclusiveSamples: checked.report.inconclusiveSamples, evidence: await checkAcceptanceFiles(evidence, context) };
}
async function checkAcceptanceFiles(files: ReleaseEvidenceFiles, context: ToolContext) {
  const values: any = {}, hashes: Record<string, { file: string; hash: string }> = {};
  for (const key of ['regression', 'clientPerformance', 'transactions', 'desktop'] as const) {
    const bytes = await readFile(relativeFile(files[key], context)); values[key] = JSON.parse(bytes.toString('utf8')); hashes[key] = { file: files[key], hash: strictHash(bytes) };
  }
  const regression = values.regression.regression ?? values.regression.tests;
  const total = regression?.tests ?? regression?.total;
  if (values.regression.build?.exitCode !== 0 || !Number.isSafeInteger(total) || total <= 0 || regression.pass !== total || regression.fail !== 0 || regression.cancelled !== 0 || regression.skipped !== 0)
    throw new HostError('ROLLOUT_EVIDENCE_MISSING', '需完整通过的构建/回归记录，不能跳过或取消。', 409);
  for (const key of ['clientPerformance', 'transactions']) if (values[key].allRoundsPassed !== true || values[key].aggregatePassed !== true || values[key].sampleCount < 30)
    throw new HostError('ROLLOUT_EVIDENCE_MISSING', '编辑和事务性能须逐轮及总体通过。', 409);
  const desktop = values.desktop;
  if (desktop.passed !== true || desktop.native?.ok !== true || desktop.sourceUnchanged !== true || desktop.allInputsUnchanged !== true || desktop.savedPoseReverified !== true || desktop.reconnectPixelsIdentical !== true || desktop.capturePerformance?.budgetPassed !== true || desktop.native?.performance?.budgetPassed !== true)
    throw new HostError('ROLLOUT_EVIDENCE_MISSING', '需真实角色的桌面/player、像素回读、重载/截图预算及保存姿态复验报告。', 409);
  return hashes;
}
async function checkedObservationReport(file: string, context: ToolContext, candidateHash: string, now: number) {
  const publicPem = await observationPublicKey(context), signed = await readSignedFile(file, context, publicPem), report = signed.payload;
  const binding = await releaseBinding(context);
  if (report.kind !== 'host-observation-report' || report.candidateHash !== candidateHash || objectHash(report.binding) !== objectHash(binding) || !Number.isFinite(report.generatedAt) || report.generatedAt > now || now - report.generatedAt > MAX_REVIEW_AGE_MS)
    throw new HostError('ROLLOUT_EVIDENCE_STALE', '观察报告不属于当前构建/工程，或超过 24 小时新鲜度。', 409);
  const current = await summarizeObservation(context, candidateHash, now);
  if (!current.readyForHumanReview || !report.readyForHumanReview || current.catalogHash !== report.catalogHash || objectHash(current.sessions) !== objectHash(report.sessions) || objectHash(current.errors) !== objectHash(report.errors) || objectHash(current.excluded) !== objectHash(report.excluded))
    throw new HostError('ROLLOUT_OBSERVATION_INCOMPLETE', '真实两周窗口尚未满足，或记录在生成报告后变化/损坏。', 409);
  return { report, publicPem, fileHash: signed.fileHash };
}

/** 只由交互式本地审查 CLI 调用；没有 HTTP 或 MCP 的批准入口。 */
export async function createRolloutReview(input: { report: string; reviewedBy: string; checks: Record<string, string>; evidence: ReleaseEvidenceFiles }, context: ToolContext, protect: ProtectFile) {
  const candidate = await hostBuildFingerprint(), now = Date.now();
  const checked = await checkedObservationReport(input.report, context, candidate.hash, now);
  if (!input.reviewedBy?.trim() || Object.keys(input.checks).length !== REVIEW_CHECKS.length || REVIEW_CHECKS.some(key => !input.checks[key]?.trim()) || new Set(REVIEW_CHECKS.map(key => input.checks[key].trim())).size !== REVIEW_CHECKS.length)
    throw new HostError('INVALID_ARGUMENT', '需审查者及六项各自具体的理由。');
  const evidence = await checkAcceptanceFiles(input.evidence, context), authority = await ObservationAuthority.load(context, protect);
  const payload = { kind: 'host-rollout-review', schema: 1, scope: C1_ROLLOUT_SCOPE, decision: 'approved', binding: checked.report.binding, candidateHash: candidate.hash,
    report: input.report, reportHash: checked.fileHash, reviewedBy: input.reviewedBy.trim(), checks: input.checks, evidence, approvedAt: now, expiresAt: now + MAX_REVIEW_AGE_MS };
  const file = newEvidencePath('reviews'); await writeEvidenceFile(file, authority.seal(payload), context);
  return { file, reviewHash: objectHash(payload), expiresAt: payload.expiresAt };
}

export async function validateRolloutApproval(file: string, context: ToolContext) {
  const candidate = await hostBuildFingerprint(), publicPem = await observationPublicKey(context), signed = await readSignedFile(file, context, publicPem), review = signed.payload, now = Date.now();
  if (review.kind !== 'host-rollout-review' || review.schema !== 1 || review.scope !== C1_ROLLOUT_SCOPE || review.decision !== 'approved' || review.candidateHash !== candidate.hash || objectHash(review.binding) !== objectHash(await releaseBinding(context)) || !Number.isFinite(review.approvedAt) || review.approvedAt > now || now - review.approvedAt > MAX_REVIEW_AGE_MS || review.expiresAt !== review.approvedAt + MAX_REVIEW_AGE_MS || now >= review.expiresAt)
    throw new HostError('ROLLOUT_APPROVAL_INVALID', '审批签名/范围、构建、工程或有效期不匹配。', 409);
  if (!review.reviewedBy?.trim() || !review.checks || Object.keys(review.checks).length !== REVIEW_CHECKS.length || REVIEW_CHECKS.some(key => typeof review.checks[key] !== 'string' || !review.checks[key].trim()) || new Set(REVIEW_CHECKS.map(key => review.checks[key].trim())).size !== REVIEW_CHECKS.length)
    throw new HostError('ROLLOUT_APPROVAL_INVALID', '审批缺少逐项人工理由。', 409);
  const observation = await checkedObservationReport(review.report, context, candidate.hash, now);
  if (observation.fileHash !== review.reportHash) throw new HostError('ROLLOUT_APPROVAL_INVALID', '审批绑定的观察报告字节已变化。', 409);
  const files = Object.fromEntries(Object.entries(review.evidence ?? {}).map(([key, value]: any) => [key, value.file])) as unknown as ReleaseEvidenceFiles;
  if (objectHash(await checkAcceptanceFiles(files, context)) !== objectHash(review.evidence)) throw new HostError('ROLLOUT_APPROVAL_INVALID', '审批绑定的验收产物字节已变化。', 409);
  try { await readFile(relativeFile(`${OBSERVATION_ROOT}/revoked/${signed.envelope.hash}.json`, context)); throw new HostError('ROLLOUT_APPROVAL_REVOKED', '审批已被关闭操作撤销，需重新审查。', 409); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return { file, approvalHash: signed.envelope.hash, candidateHash: candidate.hash, reviewedBy: review.reviewedBy, scope: review.scope };
}

export class HostRollout {
  private active: Awaited<ReturnType<typeof validateRolloutApproval>> | null = null;
  private reason = '公开写入默认关闭；需真实观察与人工审批。';
  private code = 'ROLLOUT_NOT_REQUESTED';
  constructor(private readonly store: HostEditorStore, private readonly context: ToolContext, private readonly protect: ProtectFile) {
    if (process.env.SPINE_HOST_WRITE === '1') { this.code = 'ROLLOUT_APPROVAL_REQUIRED'; this.reason = '写入请求尚需 SPINE_HOST_ROLLOUT_APPROVAL 指向有效人工审批，当前保持观察。'; }
  }
  status() { return { writeRequested: process.env.SPINE_HOST_WRITE === '1', writeEnabled: this.store.writeMode === 'attached' && !this.store.frozen,
    scope: this.active?.scope ?? null, approvalHash: this.active?.approvalHash ?? null, code: this.code, message: this.reason }; }
  async enableFromApproval(file: string) {
    try {
      if (this.store.editProfile !== 'c1') throw new HostError('ROLLOUT_SCOPE_MISMATCH', 'C1 人工审批不能启用 C2 研发 profile。', 409);
      const approval = await validateRolloutApproval(file, this.context), authority = await ObservationAuthority.load(this.context, this.protect);
      await writeEvidenceFile(newEvidencePath('reviews'), authority.seal({ kind: 'host-rollout-audit', action: 'enable-requested', approvalHash: approval.approvalHash, at: Date.now() }), this.context);
      await this.store.enableWriting(); this.active = approval;
      try { await writeEvidenceFile(newEvidencePath('reviews'), authority.seal({ kind: 'host-rollout-audit', action: 'enabled', approvalHash: approval.approvalHash, at: Date.now() }), this.context); }
      catch (error) { await this.store.disableWriting(); this.active = null; throw error; }
      this.code = 'C1_ENABLED'; this.reason = '仅已审批的 C1 单 pose/单手草稿能力启用；各次写入仍需原门禁。';
    } catch (error) {
      this.code = error instanceof HostError ? error.code : 'ROLLOUT_ENABLE_FAILED'; this.reason = error instanceof Error ? error.message : '启用失败，保持观察。';
      return { ok: false, ...this.status() };
    }
    return { ok: true, ...this.status() };
  }
  async disable() {
    const approval = this.active;
    await this.store.disableWriting(async () => {
      if (approval) {
        const authority = await ObservationAuthority.load(this.context, this.protect), file = `${OBSERVATION_ROOT}/revoked/${approval.approvalHash}.json`;
        await writeEvidenceFile(file, authority.seal({ kind: 'host-rollout-revocation', approvalHash: approval.approvalHash, at: Date.now() }), this.context);
      }
    });
    this.active = null; this.code = 'C1_DISABLED'; this.reason = '在途事务已收束、journal 已落盘，写入权已释放；旧审批已撤销。';
    return { ok: true, ...this.status() };
  }
}
