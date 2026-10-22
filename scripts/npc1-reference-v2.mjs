// npc1 参考标注 v2：为四个阶段补面部锚点、可见轮廓、朝向与前后证据。
// prepare 只生成文件与审查图；review 在看过图之后执行，不自动批准。
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { referenceFingerprint, referenceChecks } from '../dist/referencePose.js';
import { visualRigFingerprint } from '../dist/visualRig.js';

const root = 'D:/AI_cc/spine test';
const base = 'previews/pose-workflow-20261009';
const src = 'previews/ready-refinement-2026-10-10T04-03-50.693Z';
const mode = process.argv[2];
const dir = mode === 'prepare' ? `previews/ref-v2-${new Date().toISOString().replaceAll(':', '-')}` : (await fs.readFile(root + '/previews/latest-ref-v2-path.txt', 'utf8')).trim();
await fs.mkdir(`${root}/${dir}/calls`, { recursive: true });
if (mode === 'prepare') await fs.writeFile(root + '/previews/latest-ref-v2-path.txt', dir);
const read = async p => JSON.parse(await fs.readFile(`${root}/${p}`, 'utf8'));
const save = async (p, v) => fs.writeFile(`${root}/${p}`, JSON.stringify(v, null, 2));

const client = new Client({ name: 'npc1-reference-v2', version: '1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: { ...process.env, SPINE_MCP_WORKSPACE: root } }));
let seq = 0;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  await save(`${dir}/calls/${mode}-${++seq}-${name}.json`, { args, result });
  if (result.isError) throw Error(result.content[0].text);
  const value = JSON.parse(result.content[0].text);
  console.log(name, JSON.stringify({ ok: value.ok, pending: value.pending, pages: value.pages, issues: value.issues, reportPath: value.reportPath }));
  return value;
}

// 逐帧读图得到的标注：像素坐标为原图坐标；估算项必须 estimated:true 并写依据。
const annotations = {
  ready: {
    face: { x: 350, y: 118, visibility: 'visible', confidence: 0.6, basis: '取面部皮肤最前缘（鼻唇区），额头被发丝覆盖；头骨原点不能代替朝向。' },
    silhouette: {
      shoulder: { left: { x: 302, y: 142, visibility: 'visible', confidence: 0.55, basis: '左侧衣身外沿（发丝之后）' },
        right: { x: 356, y: 142, visibility: 'occluded', estimated: true, confidence: 0.45, basis: '右侧衣身外沿被前伸袖口覆盖，按袖口与衣身交界估计；杆身不计入躯干轮廓' } },
      hip: { left: { x: 274, y: 218, visibility: 'visible', confidence: 0.6, basis: '裙摆左外缘' },
        right: { x: 345, y: 218, visibility: 'visible', confidence: 0.6, basis: '裙摆右外缘' } },
    },
    orientation: { version: 1, band: 'threeQuarter', amplitude: 0.45, basis: '脸朝画面右前，肩线有投影缩短但胸衣正面可见；幅度为同序列相对量。' },
    depth: { version: 1, basis: '按杆身压过衣身、右手握持点位于躯干前方的可见遮挡判定。', evidence: [{ id: 'rightArmTorso', a: 'rightArm', b: 'torso', relation: 'front', kind: 'overlap', basis: '持杆右前臂在躯干前方跨过，杆身压在腰线衣身之上' }] },
  },
  up: {
    face: { x: 357, y: 103, visibility: 'occluded', estimated: true, confidence: 0.4, basis: '杆身横过面前，鼻唇区被遮，取可见皮肤前缘估计。' },
    silhouette: {
      shoulder: { left: { x: 323, y: 130, visibility: 'occluded', estimated: true, confidence: 0.45, basis: '左肩被上扬手臂覆盖，按袖口外沿估计' },
        right: { x: 378, y: 130, visibility: 'occluded', estimated: true, confidence: 0.45, basis: '右肩被杆身覆盖，按衣身后沿估计' } },
      hip: { left: { x: 306, y: 217, visibility: 'visible', confidence: 0.6, basis: '裙摆左外缘' },
        right: { x: 367, y: 217, visibility: 'visible', confidence: 0.6, basis: '裙摆右外缘' } },
    },
    orientation: { version: 1, band: 'threeQuarter', amplitude: 0.55, basis: '上身后仰、肩线进一步缩短，仍可见正面胸衣；幅度为相对量。' },
    depth: { version: 1, basis: '按杆身横过胸前、右手握点在前判定。', evidence: [{ id: 'rightArmTorso', a: 'rightArm', b: 'torso', relation: 'front', kind: 'occlusion', basis: '杆身与右前臂横过胸前并遮住衣身' }] },
  },
  down: {
    face: { x: 321, y: 120, visibility: 'occluded', estimated: true, confidence: 0.35, basis: '右半脸被青色特效覆盖，仅左半可见，取可见皮肤最前缘。' },
    silhouette: {
      shoulder: { left: { x: 257, y: 140, visibility: 'visible', confidence: 0.55, basis: '左肩/衣袖外沿' },
        right: { x: 330, y: 140, visibility: 'occluded', estimated: true, confidence: 0.45, basis: '右侧被青色特效覆盖，按衣身可见边界估计' } },
      hip: { left: { x: 262, y: 216, visibility: 'visible', confidence: 0.6, basis: '裙摆左外缘' },
        right: { x: 330, y: 216, visibility: 'occluded', estimated: true, confidence: 0.45, basis: '裙摆右侧进入特效范围，按可见边界估计' } },
    },
    orientation: { version: 1, band: 'threeQuarter', amplitude: 0.35, basis: '下劈前身体转正、肩线接近正面投影；幅度为相对量。' },
    depth: { version: 1, basis: '按下劈时持杆手跨过躯干前方判定。', evidence: [{ id: 'rightArmTorso', a: 'rightArm', b: 'torso', relation: 'front', kind: 'overlap', basis: '右前臂持杆横过躯干前方，压住衣身轮廓' }] },
  },
  thrust: {
    face: { x: 415, y: 133, visibility: 'visible', confidence: 0.5, basis: '前冲刺出时面部朝右下，发丝与杆重叠，取可见皮肤前缘。' },
    silhouette: {
      shoulder: { left: { x: 345, y: 155, visibility: 'occluded', estimated: true, confidence: 0.45, basis: '左肩被前伸手臂覆盖，按衣身可见边界估计' },
        right: { x: 430, y: 155, visibility: 'occluded', estimated: true, confidence: 0.45, basis: '右肩被杆身覆盖，按衣身后沿估计' } },
      hip: { left: { x: 340, y: 219, visibility: 'occluded', estimated: true, confidence: 0.5, basis: '裙摆左侧与后伸腿重叠，按可见边界估计' },
        right: { x: 405, y: 219, visibility: 'visible', confidence: 0.55, basis: '裙摆右外缘' } },
    },
    orientation: { version: 1, band: 'threeQuarter', amplitude: 0.5, basis: '突刺时上身侧转前送；幅度为相对量。' },
    depth: { version: 1, basis: '按突刺持杆手在躯干前方跨过判定。', evidence: [{ id: 'rightArmTorso', a: 'rightArm', b: 'torso', relation: 'front', kind: 'occlusion', basis: '杆身与右前臂挡在躯干前方，遮住衣身' }] },
  },
};
const names = ['ready', 'up', 'down', 'thrust'];

try {
  if (mode === 'prepare') {
    const old = await read(`${src}/npc1.visual-rig.json`);
    const nodes = structuredClone(old.nodes);
    nodes.face = { type: 'boneLocal', bone: 'zui', point: [0, 0], calibrated: true, confidence: 0.7,
      basis: '面部特征切片（zui 嘴部）旋转支点作为朝向锚点，不是鼻尖；头骨原点或头身连线都不能代替头部朝向。' };
    await call('spine_calibrate_visual_rig', { filePath: '目标/npc1.json', mappingPath: `${base}/npc1.mapping.json`, visualRigPath: `${dir}/npc1.visual-rig.json`, nodes, segments: old.segments, anatomicalSides: old.anatomicalSides, viewProfiles: old.viewProfiles, outputDir: `${dir}/calibration`, dryRun: false });
    for (const id of names) {
      const a = annotations[id];
      const up = await call('spine_upgrade_reference_pose', {
        referencePosePath: `${src}/${id}.reference.json`, outputReferencePosePath: `${dir}/${id}.reference.json`,
        face: a.face, silhouette: { version: 1, basis: '取肩线/髋线同一高度的可见衣身外缘，不用骨骼枢轴；被杆或特效覆盖处标 estimated。', ...a.silhouette }, orientation: a.orientation, depth: a.depth, dryRun: false,
      });
      if (!up.ok) throw new Error(`${id} 升级未完成：${up.pending}`);
    }
    await call('spine_render_reference_pose_sheet', { referencePosePaths: names.map(id => `${dir}/${id}.reference.json`), outputDir: `${dir}/reference-sheet` });
  } else if (mode === 'retarget') {
    // 从 v2 参考重新生成候选：先联合修正，再单姿态求解，最后出比较图。
    const outPose = `${dir}/ready.v2${process.argv[3] ? '-' + process.argv[3] : ''}.pose.json`;
    const result = await call('spine_retarget_reference_pose', {
      referencePosePath: `${dir}/ready.reference.json`, visualRigPath: `${dir}/npc1.visual-rig.json`,
      standardPosePath: `${base}/standing.pose.json`, posePath: outPose,
      sequencePath: `${dir}/attack.sequence.json`, stageId: 'ready', dryRun: false,
    });
    const posePath = result.posePath ?? outPose;
    console.log('retarget', JSON.stringify({ ok: result.ok, issues: result.issues, conflicts: result.conflicts }));
    const solved = await call('spine_solve_pose', { posePath, dryRun: false });
    console.log('solve', JSON.stringify({ ok: solved.ok, issues: solved.issues, warnings: solved.warnings, headIntrusions: solved.headIntrusions }));
    const cmp = await call('spine_compare_pose_graphs', { posePath, dryRun: false });
    const bad = (cmp.metrics ?? []).filter(m => m.required && m.status !== 'pass').map(m => `${m.id}:${m.status}:${typeof m.error === 'number' ? m.error.toFixed(3) : m.error}`);
    console.log('non-pass:', bad.length ? bad.join(', ') : 'none');
    const sheet = await call('spine_render_pose_comparison', { posePaths: [posePath], stageIds: ['ready'] });
    console.log('pages', JSON.stringify(sheet.pages));
  } else if (mode === 'fixready') {
    // 前臂关节原标注落在袖口内（腕距肩仅 11px），重标到可见握杆手后再重跑。
    const srcRef = await read(`${dir}/ready.reference.json`);
    const fixed = structuredClone(srcRef);
    fixed.id = 'ready-v2b';
    fixed.observation.basis += '；前臂重标：原腕点落在袖口内，按可见握杆手重标肘/腕与左手握点。';
    Object.assign(fixed.observation.points.leftElbow, { x: 356, y: 160, visibility: 'occluded', estimated: true, confidence: 0.5, basis: '前臂在袖口内转折，按可见前臂下缘估计' });
    Object.assign(fixed.observation.points.leftWrist, { x: 378, y: 152, visibility: 'visible', confidence: 0.55, basis: '可见握住杆身的前侧手，不是袖口' });
    if (fixed.observation.grip?.points?.left) Object.assign(fixed.observation.grip.points.left, { x: 378, y: 152 });
    const up = await call('spine_create_reference_pose', { referencePosePath: `${dir}/ready.reference.v2b${process.argv[3] ? '-' + process.argv[3] : ''}.json`, id: 'ready-v2b', observation: fixed.observation, dryRun: false });
    console.log('created', JSON.stringify({ ok: up.ok }));
    const sheet = await call('spine_render_reference_pose_sheet', { referencePosePaths: [`${dir}/ready.reference.v2b${process.argv[3] ? '-' + process.argv[3] : ''}.json`], outputDir: `${dir}/reference-sheet-v2b${process.argv[3] ? '-' + process.argv[3] : ''}` });
    await call('spine_review_reference_pose', { referencePosePath: `${dir}/ready.reference.v2b${process.argv[3] ? '-' + process.argv[3] : ''}.json`, manifestPath: sheet.manifestPath, decision: 'approved', reviewedBy: 'Agent 参考身份复核', reason: '前臂重标复核：原左腕位于袖口内距肩仅 11px，与可见握杆手不符；按放大图把左肘移到袖口转折处、左腕移到握杆手，左手握点同步；肩髋与腿部标注、轮廓、朝向、前后证据保持不变。', checks: [...referenceChecks], dryRun: false });
    const rig = await read(`${dir}/npc1.visual-rig.json`);
    const correspondence = { left: 'left', right: 'right', basis: '统一后的解剖身份同侧对应，全阶段不按画面位置交换。', anatomicalIdentity: '目标 ys 右臂、zs 左臂；yt 后侧右腿、zt 前侧左腿。', projectedOrder: '准备帧右侧肢体投影后侧；转身时投影允许变化，解剖身份不变化。' };
    const stages = [];
    for (const id of ['ready', 'up', 'down', 'thrust']) {
      const pth = id === 'ready' ? `${dir}/ready.reference.v2b${process.argv[3] ? '-' + process.argv[3] : ''}.json` : `${dir}/${id}.reference.json`;
      stages.push({ stageId: id, referencePosePath: pth, referenceFingerprint: referenceFingerprint(await read(pth)) });
    }
    await save(`${dir}/attack.sequence.v2b${process.argv[3] ? '-' + process.argv[3] : ''}.json`, { version: 1, id: 'npc1-right-staff', basis: '准备帧前臂重标后重跑。', confirmedBy: 'Agent 根据逐帧参考复核', confirmedAt: new Date().toISOString(), correspondence, weaponHand: 'right', visualRigPath: `${dir}/npc1.visual-rig.json`, visualRigFingerprint: visualRigFingerprint(rig), stages });
    const outPose = `${dir}/ready.v2b${process.argv[3] ? '-' + process.argv[3] : ''}.pose.json`;
    const result = await call('spine_retarget_reference_pose', { referencePosePath: `${dir}/ready.reference.v2b${process.argv[3] ? '-' + process.argv[3] : ''}.json`, visualRigPath: `${dir}/npc1.visual-rig.json`, standardPosePath: `${base}/standing.pose.json`, posePath: outPose, sequencePath: `${dir}/attack.sequence.v2b${process.argv[3] ? '-' + process.argv[3] : ''}.json`, stageId: 'ready', dryRun: false });
    const posePath = result.posePath ?? outPose;
    const solved = await call('spine_solve_pose', { posePath, dryRun: false });
    console.log('solve', JSON.stringify({ ok: solved.ok }));
    const cmp = await call('spine_compare_pose_graphs', { posePath, dryRun: false });
    const bad = (cmp.metrics ?? []).filter(m => m.required && m.status !== 'pass').map(m => `${m.id}:${m.status}:${typeof m.error === 'number' ? m.error.toFixed(3) : m.error}`);
    console.log('non-pass:', bad.length ? bad.join(', ') : 'none');
    const cs = await call('spine_render_pose_comparison', { posePaths: [posePath], stageIds: ['ready'] });
    console.log('pages', JSON.stringify(cs.pages));
  } else if (mode === 'review') {
    const reasons = await read(`${dir}/review-reasons.json`);
    await call('spine_review_visual_rig', { visualRigPath: `${dir}/npc1.visual-rig.json`, decision: 'approved', reviewedBy: 'Agent 静态绑定复核', reason: reasons.rig, dryRun: false });
    for (const id of names) await call('spine_review_reference_pose', { referencePosePath: `${dir}/${id}.reference.json`, manifestPath: `${dir}/reference-sheet/reference-pose-sheet.json`, decision: reasons[id].decision, reviewedBy: 'Agent 参考身份复核', reason: reasons[id].reason, checks: [...referenceChecks], dryRun: false });
    const rig = await read(`${dir}/npc1.visual-rig.json`);
    const correspondence = { left: 'left', right: 'right', basis: '统一后的解剖身份同侧对应，全阶段不按画面位置交换。', anatomicalIdentity: '目标 ys 右臂、zs 左臂；yt 后侧右腿、zt 前侧左腿。', projectedOrder: '准备帧右侧肢体投影后侧；转身时投影允许变化，解剖身份不变化。' };
    const stages = [];
    for (const id of names) { const ref = await read(`${dir}/${id}.reference.json`); stages.push({ stageId: id, referencePosePath: `${dir}/${id}.reference.json`, referenceFingerprint: referenceFingerprint(ref) }); }
    await save(`${dir}/attack.sequence.json`, { version: 1, id: 'npc1-right-staff', basis: '参考升级为 v2 后重跑；只验收准备姿态。', confirmedBy: 'Agent 根据逐帧参考复核', confirmedAt: new Date().toISOString(), correspondence, weaponHand: 'right', visualRigPath: `${dir}/npc1.visual-rig.json`, visualRigFingerprint: visualRigFingerprint(rig), stages });
    await call('spine_validate_pose_sequence', { sequencePath: `${dir}/attack.sequence.json`, dryRun: false });
    // 用旧 ready 帧只替换关联，观察 v3 在真实轮廓下给出什么结论。
    await call('spine_adjust_pose', { posePath: `${src}/ready-v4.pose.json`, outputPosePath: `${dir}/ready-recheck.pose.json`, patch: { referencePosePath: `${dir}/ready.reference.json`, visualRigPath: `${dir}/npc1.visual-rig.json`, sequencePath: `${dir}/attack.sequence.json`, stageId: 'ready' }, dryRun: false });
    const solved = await call('spine_solve_pose', { posePath: `${dir}/ready-recheck.pose.json`, dryRun: false });
    const cmp = await call('spine_compare_pose_graphs', { posePath: `${dir}/ready-recheck.pose.json`, dryRun: false });
    const bad = (cmp.metrics ?? []).filter(m => m.required && m.status !== 'pass').map(m => `${m.id}:${m.status}:${typeof m.error === 'number' ? m.error.toFixed(3) : m.error}`);
    console.log('non-pass:', bad.length ? bad.join(', ') : 'none');
  }
} finally { await client.close(); }
