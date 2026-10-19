import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readSpineDocument, resolveWorkspacePath, type ToolContext } from "./spineJson.js";
import { readCharacterMapping, validateMapping, type CharacterMapping } from "./motionEngine.js";
import { loadMotionRuntime } from "./motionRuntime.js";

export const hashObject = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const rigHash = (json: any) => hashObject(Object.fromEntries(Object.entries(json).filter(([k]) => k !== "animations" && k !== "skeleton")));
export const mappingFingerprint = (mapping: CharacterMapping) => hashObject({ bones: mapping.bones, calibration: mapping.calibration, atlasPath: mapping.atlasPath, skin: mapping.skin });
export async function saveJson(filePath: string, value: any, context: ToolContext = {}) {
  const absolute = resolveWorkspacePath(filePath, context);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(value, null, 2) + "\n", "utf8");
}
export async function createMappingDraft(args: { filePath: string; mappingPath: string; mapping: CharacterMapping; dryRun?: boolean }, context: ToolContext = {}) {
  const document = await readSpineDocument(args.filePath, context);
  const mapping = structuredClone(args.mapping);
  mapping.version = 2; mapping.status = "draft"; mapping.sourceHash = document.hash; mapping.rigHash = rigHash(document.json);
  delete mapping.confirmedBy; delete mapping.confirmedAt; delete mapping.reportPath;
  validateMapping(mapping, document.json);
  if (args.dryRun === false) {
    try { await readFile(resolveWorkspacePath(args.mappingPath, context)); throw new Error("mapping 已存在；请使用新路径，避免覆盖已确认映射。"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    await saveJson(args.mappingPath, mapping, context);
  }
  return { ok: true, dryRun: args.dryRun ?? true, mapping };
}
export async function calibrateMapping(args: { filePath: string; mappingPath: string; reportPath?: string; dryRun?: boolean }, context: ToolContext = {}) {
  const document = await readSpineDocument(args.filePath, context);
  const mapping = await readCharacterMapping(args.mappingPath, context);
  validateMapping(mapping, document.json);
  if (!mapping.atlasPath) throw new Error("校准必须提供 atlasPath，用官方 runtime 计算世界变换。");
  const runtime = await loadMotionRuntime(document.json, mapping.atlasPath, context);
  const skeleton = runtime.sample(undefined, 0, mapping.skin);
  const lengths: Record<string, [number, number]> = {};
  for (const role of ["leftLeg", "rightLeg", "leftArm", "rightArm"] as const) {
    const chain = mapping.bones[role]; if (!chain) continue;
    if (chain.length !== 3) throw new Error(`${role} 必须明确指定上段、下段、末端三根骨骼。`);
    const [a, b, c] = chain.map(n => skeleton.findBone(n)!);
    lengths[role] = [Math.hypot(b.worldX - a.worldX, b.worldY - a.worldY), Math.hypot(c.worldX - b.worldX, c.worldY - b.worldY)];
    if (lengths[role].some(l => l <= 1e-6)) throw new Error(`${role} 的骨骼链长度为零。`);
    // 解析 IK 第一版只接受正向统一缩放，其他结构明确拒绝。
    for (const bone of [a, b, c]) {
      const sx = Math.hypot(bone.a, bone.c), sy = Math.hypot(bone.b, bone.d);
      if (Math.abs(sx - sy) > 1e-5 || bone.a * bone.d - bone.b * bone.c <= 0 || bone.shearX || bone.shearY) throw new Error(`${role} 包含镜像、非均匀缩放或 shear，当前解析 IK 不支持。`);
    }
  }
  const legLengths = [lengths.leftLeg, lengths.rightLeg].filter(Boolean).map(l => l[0] + l[1]);
  const scale = mapping.calibration?.scale ?? (legLengths.length ? legLengths.reduce((a, b) => a + b, 0) / legLengths.length : 100);
  const root = skeleton.findBone(mapping.bones.root ?? document.json.bones[0].name)!;
  mapping.version = 2; mapping.status = "calibrated"; mapping.sourceHash = document.hash; mapping.rigHash = rigHash(document.json);
  mapping.calibration = { ...mapping.calibration, scale, lengths, origin: [root.worldX, root.worldY] };
  const reportPath = args.reportPath ?? args.mappingPath.replace(/\.json$/, ".calibration.json");
  mapping.reportPath = reportPath; delete mapping.confirmedBy; delete mapping.confirmedAt;
  const report = { version: 1, status: "calibrated", sourceHash: document.hash, rigHash: mapping.rigHash, mappingFingerprint: mappingFingerprint(mapping), calibration: mapping.calibration, anchors: mapping.bones.anchors, checks: ["骨骼引用", "连续链", "非零长度", "runtime 世界变换", "正向统一缩放"], confirmedBy: null as string | null, confirmedAt: null as string | null };
  if (args.dryRun === false) { await saveJson(reportPath, report, context); await saveJson(args.mappingPath, mapping, context); }
  return { ok: true, dryRun: args.dryRun ?? true, mapping, report };
}
export async function assertConfirmedMapping(mapping: CharacterMapping, json: any, sourceHash: string, context: ToolContext = {}) {
  if (mapping.status !== "confirmed" || !mapping.confirmedBy || !mapping.confirmedAt || !mapping.reportPath) throw new Error("真实求解写入必须使用 confirmed mapping 和校准报告。");
  const report = JSON.parse(await readFile(resolveWorkspacePath(mapping.reportPath, context), "utf8"));
  if (mapping.sourceHash !== sourceHash || report.sourceHash !== sourceHash || mapping.rigHash !== rigHash(json) || report.rigHash !== rigHash(json)) throw new Error("mapping 或校准报告的 sourceHash 与当前角色不一致；请重新校准确认。");
  if (report.mappingFingerprint !== mappingFingerprint(mapping) || report.status !== "confirmed" || report.confirmedBy !== mapping.confirmedBy) throw new Error("mapping 校准数据或确认记录已改变；请重新校准确认。");
  return report;
}
export async function confirmMapping(args: { filePath: string; mappingPath: string; confirmedBy: string; semanticChecks: string[]; dryRun?: boolean }, context: ToolContext = {}) {
  const document = await readSpineDocument(args.filePath, context), mapping = await readCharacterMapping(args.mappingPath, context);
  if (mapping.status !== "calibrated" || !mapping.reportPath || mapping.sourceHash !== document.hash) throw new Error("请先对当前角色执行校准。");
  if (!args.confirmedBy?.trim()) throw new Error("必须记录确认者。");
  const required = ["body", "head", "sides", "chains", "anchors", "bendDirections", "setupPose", "followBones"];
  if (required.some(k => !args.semanticChecks?.includes(k))) throw new Error(`语义确认必须包含：${required.join(", ")}。不需要跟随时也要确认空列表。`);
  validateMapping(mapping, document.json);
  if (!mapping.bones.head || !mapping.bones.root) throw new Error("确认必须指定 body、head、root。");
  for (const side of ["left", "right"] as const) {
    if (!mapping.bones[`${side}Leg`] || !mapping.bones[`${side}Arm`] || !mapping.bones.anchors?.[`${side}Foot`] || !mapping.bones.anchors?.[`${side}Hand`]) throw new Error(`确认缺少 ${side} 的手脚链或锚点。`);
    if (![1, -1].includes(mapping.bones.bendDirections?.[`${side}Leg`] ?? 0) || ![1, -1].includes(mapping.bones.bendDirections?.[`${side}Arm`] ?? 0)) throw new Error("必须指定膝盖和肘部弯曲方向 ±1。");
  }
  const report = JSON.parse(await readFile(resolveWorkspacePath(mapping.reportPath, context), "utf8"));
  if (report.sourceHash !== document.hash || report.mappingFingerprint !== mappingFingerprint(mapping)) throw new Error("校准报告已过期。");
  mapping.status = "confirmed"; mapping.confirmedBy = args.confirmedBy; mapping.confirmedAt = new Date().toISOString(); mapping.semanticChecks = [...args.semanticChecks];
  Object.assign(report, { status: "confirmed", confirmedBy: mapping.confirmedBy, confirmedAt: mapping.confirmedAt, semanticChecks: args.semanticChecks });
  if (args.dryRun === false) { await saveJson(mapping.reportPath, report, context); await saveJson(args.mappingPath, mapping, context); }
  return { ok: true, dryRun: args.dryRun ?? true, mapping, report };
}
