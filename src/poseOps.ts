// 姿态编辑与状态查询：把「跑一遍才知道状态」和「整块 frame 覆盖」两件事分开做小。
import { readJson, adjustPose, solvePoseData } from './poseWorkflow.js';
import { saveJson } from './mappingTools.js';
import { compareGraphs } from './poseGraph.js';
import { requireReferencePose } from './referencePose.js';
import { requireVisualRig } from './visualRig.js';
import { runtimeGraph } from './referenceRetarget.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { applyPoseCommands, validatePoseCommand } from './animationCommands.js';
import { poseDigest } from './poseDigest.js';

const ENDPOINTS = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'];

// 指标 → 可调旋钮。不可调的项要明确说清楚，避免让调用方以为「再调一点就好」。
export function metricAdvice(id: string): { knob: string; note: string } {
  if (id === 'body.torsoDirection') return { knob: 'body.rotate', note: '整体倾斜；不改扭转。' };
  if (id === 'body.shoulderLine' || id === 'body.twist') return { knob: 'frame.channels.torso.rotate', note: '肩线朝向与扭转只能由躯干通道承担，body.rotate 会同时转肩髋。' };
  if (/Silhouette$/.test(id)) return { knob: '不可调', note: '绝对轮廓宽度含体型差异，只作诊断。' };
  if (id.startsWith('head.')) return { knob: 'frame.head', note: '头部朝向；注意参考锚点与目标锚点语义是否等价。' };
  if (/^arm\.\w+\.wrist(Reach|TorsoHeight|TorsoOffset|OutsideTorso)$/.test(id)) return { knob: `targets.${/left/.test(id) ? 'leftHand' : 'rightHand'} {x,y}`, note: '外伸/高度/偏置/轮廓内外都在手位目标上；够不到时会停在可达边界。' };
  if (/^arm\.\w+\.wristHeadGap$/.test(id)) return { knob: `targets.${/left/.test(id) ? 'leftHand' : 'rightHand'} {x,y}`, note: '手离头部太近/太远；同时会触发头部包围盒硬门禁。' };
  if (/^leg\.\w+\.ankleTorsoOffset$/.test(id)) return { knob: `targets.${/left/.test(id) ? 'leftFoot' : 'rightFoot'} x`, note: '踝的侧向偏置。' };
  if (id.startsWith('stance.')) return { knob: 'targets.{leftFoot,rightFoot}.x + body.y', note: '站距与前后站位。' };
  if (id.endsWith('.support')) return { knob: 'targets.*Foot.contact', note: '支撑关系是布尔的，只能改接触标记。' };
  if (id.startsWith('depth.')) return { knob: 'frame.presentation.drawOrder', note: '层序由绘制顺序决定，不是关节；交错时判 unverifiable。' };
  if (id.startsWith('action.')) return { knob: 'sequence / visualRig', note: '动作语义与已校准视角能力，属于绑定层。' };
  if (/^grip\./.test(id)) return { knob: 'pose.weapon 或手部 angle', note: '握距/握向；用 weapon 可把双手约束到同一根杆上。' };
  if (/\.(segment\d|flexion|bendSide|wrist|extension)$/.test(id)) return { knob: 'targets + bendDirections', note: '段方向/屈曲/弯曲分支；分支是离散量，自动优化只能试跳。' };
  return { knob: '未知', note: '没有登记的旋钮映射。' };
}

function digest(metrics: any[]) {
  return metrics.map((m: any) => ({
    id: m.id, status: m.status, required: m.required, tolerance: m.tolerance,
    error: typeof m.error === 'number' ? Number(m.error.toFixed(4)) : m.error,
    ...(m.status === 'pass' ? {} : metricAdvice(m.id)),
  }));
}

// 内存内比较：不写报告、不走序列校验，用于「现在是什么状态」的廉价查询。
async function inspect(p: any, s: any, c: ToolContext) {
  if (!p.referencePosePath || !p.visualRigPath) return null;
  try {
    const r = await requireReferencePose(p.referencePosePath, c), v = await requireVisualRig(p.visualRigPath, c);
    const target = runtimeGraph(s.skeleton, v.rig, v.mapping, p);
    const cmp = compareGraphs(r.observation, target, p.correspondence);
    return { ok: cmp.ok, version: cmp.version, policyFingerprint: cmp.policyFingerprint, metrics: digest(cmp.metrics) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), metrics: null };
  }
}

export async function getPoseState(a: any, c: ToolContext = {}) {
  const p = await readJson(a.posePath, c);
  if (a.recheck !== true) return poseDigest(p, c, a.posePath);
  const s = await solvePoseData(p, c);
  return {
    pose: { id: p.id, stageId: p.stageId ?? null, kind: p.kind, status: p.status ?? 'draft', frame: s.frame, weapon: p.weapon ?? null },
    solved: {
      ok: s.report.ok, issues: s.report.issues, warnings: s.report.warnings,
      joints: s.report.joints, flexion: s.report.flexion, errors: s.report.errors,
      headIntrusions: s.report.headIntrusions ?? [],
    },
    comparison: await inspect(p, s, c),
    note: '这是内存内摘要，不写报告；正式判定仍需 spine_compare_pose_graphs（含序列指纹）。',
  };
}

export async function explainPose(a: any, c: ToolContext = {}) {
  const p = await readJson(a.posePath, c);
  if(a.recheck!==true){const state=await poseDigest(p,c,a.posePath);const failing=state.stale.comparison.stale===false?digest(state.comparison?.metrics??[]).filter((m:any)=>m.required&&m.status!=='pass'):[];return{...state,posePath:a.posePath,failing,explanation:state.freshness==='current'?'读取已有结果与指标旋钮，不重新求解；正式审查仍严格复核。':'现有结果缺失、过期或无法证明新鲜；请显式 spine_recheck_pose。',issues:state.solved?.issues??[]};}
  const s = await solvePoseData(p, c), cmp = await inspect(p, s, c);
  if (!cmp) return { posePath: a.posePath, explanation: '该姿态没有参考绑定，只有数值与视觉检查。', issues: s.report.issues };
  const failing = (cmp.metrics ?? []).filter((m: any) => m.required && m.status !== 'pass');
  return {
    posePath: a.posePath, ok: cmp.ok, failing,
    summary: failing.length ? `${failing.length} 项必要指标未通过：${failing.map((m: any) => `${m.id}(${m.status}${typeof m.error === 'number' ? ' ' + m.error : ''})`).join('、')}` : '必要指标全部通过；仍需视觉审查确认轮廓与握持关系。',
    solver: { issues: s.report.issues, warnings: s.report.warnings },
  };
}

// 逐字段补丁：只改一个末端或一个通道，产出新修订并清掉旧的求解/审查。
function targetPatch(role: string, a: any) {
  validatePoseCommand({ op: 'target', role, ...Object.fromEntries(['x','y','angle','contact'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]])) });
  if (!ENDPOINTS.includes(role)) throw new Error(`目标必须是 ${ENDPOINTS.join('/')}。`);
  const t: any = {};
  for (const k of ['x', 'y', 'angle', 'contact'] as const) if (a[k] !== undefined) t[k] = a[k];
  if (!Object.keys(t).length) throw new Error('至少给 x/y/angle/contact 中一项。');
  return { frame: { targets: { [role]: t } } };
}

export async function setPoseTarget(a: any, c: ToolContext = {}) {
  const result = await adjustPose({ posePath: a.posePath, outputPosePath: a.outputPosePath, patch: targetPatch(a.role, a), dryRun: a.dryRun }, c);
  return { ...result, changed: { role: a.role } };
}

export async function setPoseChannel(a: any, c: ToolContext = {}) {
  validatePoseCommand({ op: 'channel', name: a.name, ...Object.fromEntries(['rotate','x','y'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]])) });
  if (!a.name?.trim()) throw new Error('通道名必填（例如 torso）。');
  const v: any = {};
  for (const k of ['rotate', 'x', 'y'] as const) if (a[k] !== undefined) v[k] = a[k];
  if (!Object.keys(v).length) throw new Error('至少给 rotate/x/y 中一项。');
  const result = await adjustPose({ posePath: a.posePath, outputPosePath: a.outputPosePath, patch: { frame: { channels: { [a.name]: v } } }, dryRun: a.dryRun }, c);
  return { ...result, changed: { channel: a.name } };
}

// 纯函数：把一组原子操作应用到草稿上，便于测试与批处理复用。
export function applyOps(draft: any, ops: any[]) {
  const result = applyPoseCommands(draft, ops);
  for (const key of Object.keys(draft)) delete draft[key];
  Object.assign(draft, result.pose);
  return result.applied;
}

export async function batchPoseOps(a: any, c: ToolContext = {}) {
  if (!a.outputPosePath) throw new Error('批处理需要 outputPosePath（不覆盖现有审查修订）。');
  const src = await readJson(a.posePath, c), draft = structuredClone(src);
  const applied = applyOps(draft, a.ops);
  if (a.dryRun === false) {
    try { await (await import('node:fs/promises')).readFile(resolveWorkspacePath(a.outputPosePath, c)); throw new Error('目标已存在，请使用新修订路径。'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    await saveJson(a.outputPosePath, draft, c);
    const { solvePose } = await import('./poseWorkflow.js'); await solvePose({ posePath: a.outputPosePath, dryRun: false }, c);
    const { comparePoseGraphs } = await import('./referenceRetarget.js');
    const cmp = await comparePoseGraphs({ posePath: a.outputPosePath, dryRun: false }, c).catch((e: any) => ({ ok: false, error: String(e?.message ?? e), metrics: [] }));
    const failing = (cmp as any).metrics?.filter((m: any) => m.required && m.status !== 'pass').map((m: any) => ({ id: m.id, status: m.status, error: m.error })) ?? [];
    const out: any = { ok: (cmp as any).ok ?? false, posePath: a.outputPosePath, applied, reportPath: (cmp as any).reportPath, failing };
    if (a.render) {
      const { renderPoseComparison } = await import('./poseWorkflow.js');
      const sheet = await renderPoseComparison({ posePaths: [a.outputPosePath], stageIds: [src.stageId ?? 'pose'], region: a.region }, c);
      out.pages = sheet.pages;
    }
    return out;
  }
  const s = await solvePoseData(draft, c);
  const cmp = await inspect(draft, s, c);
  const failing = cmp?.metrics?.filter((m: any) => m.required && m.status !== 'pass') ?? [];
  return { ok: s.report.ok && (cmp ? cmp.ok : true), dryRun: true, applied, solved: { issues: s.report.issues, warnings: s.report.warnings }, failing, note: 'dryRun 只算内存摘要，不写文件、不出图。' };
}
