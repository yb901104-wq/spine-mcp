import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { solvePoseData } from './poseWorkflow.js';
import { poseInputHash } from './animationKernel.js';
import { poseDependencies } from './poseDigest.js';
import { policyFingerprint } from './poseGraph.js';
import { comparePoseData } from './referenceRetarget.js';
import { presentationTimelines } from './posePresentation.js';
import { createMotionRuntime, worldVertices } from './motionRuntime.js';
import { resolveWorkspacePath, validateOfficialAnimationSpec, validateSpineJson, type ToolContext } from './spineJson.js';
import { derivedFingerprint, HostError, strictHash } from './hostContracts.js';
import { materializeHostPose } from './hostPose.js';
import { strictFileChecks } from './strictFileChecks.js';

const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new HostError('TASK_CANCELLED', '重算已取消，已确认的编辑版本仍保留。', 409); };
export async function verifySnapshotDependencies(snapshot: any, context: ToolContext) {
  if(snapshot.policyFingerprint!==policyFingerprint)throw new HostError('TARGET_DRIFT','Host 与 MCP 的比较策略不一致。',409);
  const checks=await strictFileChecks(snapshot.dependencies,file=>resolveWorkspacePath(file,context));
  for(const dependency of checks){if(dependency.error)throw dependency.error;if(dependency.actual!==dependency.hash)throw new HostError('TARGET_DRIFT',`计算依赖发生变化：${dependency.filePath}`,409);}
}
/** MCP 使用不可变内存姿态；只读取严格匹配的角色依赖，不重读活动姿态路径。 */
export async function evaluateHostSnapshot(snapshot: any, context: ToolContext, signal?: AbortSignal, progress?: (stage: string) => void) {
  cancelled(signal); await verifySnapshotDependencies(snapshot, context); progress?.('准备角色依赖');
  if (snapshot.kind !== 'pose') throw new HostError('UNSUPPORTED_DOC_KIND', '当前内存求解桥仅支持 pose。');
  const p = structuredClone(snapshot.document), solved = await solvePoseData(p, context);
  cancelled(signal); progress?.('回读 runtime 实际节点');
  const proof = await poseDependencies(p, context);
  const materialized = materializeHostPose(p, { bones: solved.bones, numeric: solved.report, poseDependencyFingerprint: proof.dependencyFingerprint });
  let comparison: any = null;
  if (p.referencePosePath) {
    try {
      comparison = await comparePoseData(materialized, { posePath: snapshot.path, detailed: true }, context, solved);
    } catch (error) { comparison = { ok: false, status: 'unverifiable', message: String(error) }; }
  }
  const result: any = {
    bones: solved.bones, numeric: solved.report, frame: solved.frame,
    actualNodes: solved.report.visualNodes ?? solved.report.joints,
    comparison, inputFingerprint: poseInputHash(p), poseDependencyFingerprint: proof.dependencyFingerprint,
    diagnosticOnly: !solved.report.ok || comparison?.ok === false,
  };
  // player 只读不可变导出动画；不生成或覆盖角色源资产。
  const live = structuredClone(solved.doc.json), animation = '__host_pose', bones: any = {};
  for (const [name, value] of Object.entries(solved.bones) as any) bones[name] = {
    rotate: [{ value: value.rotate ?? 0 }, { time: 1, value: value.rotate ?? 0 }],
    translate: [{ x: value.translate?.x ?? 0, y: value.translate?.y ?? 0 }, { time: 1, x: value.translate?.x ?? 0, y: value.translate?.y ?? 0 }],
  };
  const presentation = presentationTimelines(live, solved.mapping, { frames: [{ ...solved.frame, time: 0 }], duration: 1 }, 1);
  live.animations ??= {}; live.animations[animation] = { bones, ...presentation };
  const structural = validateSpineJson(live), official = validateOfficialAnimationSpec(live);
  if (!structural.ok || !official.ok) throw new HostError('SOLUTION_INVALID', 'live 候选未通过结构与官方 JSON 规范审查。', 409, { structural, official });
  const atlasRaw = await readFile(resolveWorkspacePath(solved.mapping.atlasPath!, context), 'utf8');
  const rt = createMotionRuntime(live, atlasRaw), sampled = rt.sample(animation, 0, solved.mapping.skin);
  const actual = worldVertices(sampled), expected = worldVertices(solved.skeleton);
  let maximumError = 0;
  if (JSON.stringify(Object.keys(actual)) !== JSON.stringify(Object.keys(expected))) throw new HostError('SOLUTION_INVALID', 'live 回读的可见附件集合不同。');
  for (const key of Object.keys(actual)) {
    if (actual[key].length !== expected[key].length) throw new HostError('SOLUTION_INVALID', 'live 顶点数量不同。');
    actual[key].forEach((v, i) => { maximumError = Math.max(maximumError, Math.abs(v - expected[key][i])); });
  }
  for (const bone of sampled.bones) {
    const b = solved.skeleton.findBone(bone.data.name)!;
    maximumError = Math.max(maximumError, Math.abs(bone.worldX - b.worldX), Math.abs(bone.worldY - b.worldY), Math.abs(bone.a - b.a), Math.abs(bone.b - b.b), Math.abs(bone.c - b.c), Math.abs(bone.d - b.d));
  }
  const attachments = (s: any) => s.slots.map((slot: any) => [slot.data.name, slot.getAttachment()?.name ?? null]);
  if (maximumError > 1e-4 || JSON.stringify(attachments(sampled)) !== JSON.stringify(attachments(solved.skeleton)) || JSON.stringify(sampled.drawOrder.map(s => s.data.name)) !== JSON.stringify(solved.skeleton.drawOrder.map(s => s.data.name))) throw new HostError('SOLUTION_INVALID', 'live 完整回放与原求解的 runtime 状态不一致。', 409, { maximumError });
  result.renderState = { skin: solved.mapping.skin ?? null, attachments: attachments(sampled), drawOrder: sampled.drawOrder.map(s => s.data.name), maximumError, replaySchema: 1 };
  const raw = `${JSON.stringify(live, null, 2)}\n`, liveHash = strictHash(raw);
  result.live = { hash: liveHash, animation, time: 0 };
  const derivedHash = derivedFingerprint(snapshot.snapshotHash, result);
  result.live.path = `.spine-mcp/live/${snapshot.version.documentId}/${snapshot.version.openEpoch}/${derivedHash}/pose.json`;
  const target = resolveWorkspacePath(result.live.path, context);
  await mkdir(path.dirname(target), { recursive: true });
  cancelled(signal); await verifySnapshotDependencies(snapshot, context);
  try {
    const file = await open(target, 'wx', 0o600);
    try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
  } catch (error: any) { if (error.code !== 'EEXIST' || strictHash(await readFile(target)) !== liveHash) throw error; }
  if (comparison) {
    const reportPath = target.replace(/pose\.json$/, 'comparison.json'), bytes = JSON.stringify(comparison, null, 2) + '\n';
    try { const handle = await open(reportPath, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
    catch (error: any) { if (error.code !== 'EEXIST' || strictHash(await readFile(reportPath)) !== strictHash(bytes)) throw error; }
  }
  cancelled(signal); progress?.('发布当前求解与只读 player 候选'); await verifySnapshotDependencies(snapshot, context);
  return result;
}
