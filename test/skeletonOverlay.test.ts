import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import gifenc from 'gifenc';
import { createCanvas } from '@napi-rs/canvas';
import {
  renderAnimationComparison,
  skeletonProjections,
  resolveSkeletonMapping,
  targetSkeletonPoints,
} from '../src/animationReview.js';
import {
  animationComparisonLayouts,
  skeletonFormalAcceptanceReady,
  comparisonGifNames,
  comparisonLayoutMatchesGif,
  comparisonManifestFingerprint,
  comparisonManifestProblem,
  retargetManifestProblem,
  isSkeletonEvidence,
  isRawOnlyEvidence,
  hasExpectedRetargetTarget,
  hasActualTarget,
  retargetFormalAcceptanceReady,
  expectedRetargetManifestProblem,
} from '../src/animationAcceptancePolicy.js';
import { hashObject } from '../src/mappingTools.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const DIR = `.test-output-skeleton-overlay-${randomUUID()}`;
const W = 128, H = 128, N = 4;
const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const ROLES = [
  'head', 'face', 'body', 'leftShoulder', 'leftElbow', 'leftWrist',
  'rightShoulder', 'rightElbow', 'rightWrist', 'leftHip', 'leftKnee', 'leftAnkle',
  'rightHip', 'rightKnee', 'rightAnkle',
];

async function writePng(p: string, fill: string, i: number) {
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = fill; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e04f5f'; ctx.fillRect(40, 20 + i * 12, 32, 32);
  await writeFile(p, c.toBuffer('image/png'));
}
async function writeGif(p: string) {
  const gif = GIFEncoder();
  for (let i = 0; i < N; i++) {
    const c = createCanvas(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = '#20242b'; ctx.fillRect(0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data, palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: 100, repeat: 0 });
  }
  gif.finish();
  await writeFile(p, gif.bytes());
}
async function writeJson(p: string, obj: unknown) { await writeFile(p, JSON.stringify(obj, null, 2)); }
function gifSize(bytes: Buffer) { return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }; }

/** 15 个关节点的简单坐标；目标骨骼世界坐标与之同形，便于数值断言。 */
function referencePoints() {
  const out: Record<string, { x: number; y: number; visibility: string }> = {};
  for (const [i, role] of ROLES.entries()) out[role] = { x: 20 + (i % 5) * 18, y: 20 + Math.floor(i / 5) * 30, visibility: 'visible' };
  return out;
}
function trajectoryBones(i: number) {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [k, role] of ROLES.entries()) out[role] = { x: 20 + (k % 5) * 18 + i * 2, y: 20 + Math.floor(k / 5) * 30 };
  return out;
}

async function buildFixtures(): Promise<{
  targetManifestPath: string; referenceManifestPath: string; poseManifestPath: string; visualRigPath: string;
}> {
  await mkdir(`${DIR}/ref`, { recursive: true });
  await mkdir(`${DIR}/tgt`, { recursive: true });
  const refFrames = [], tgtFrames = [], trajectories = [];
  for (let i = 0; i < N; i++) {
    const rp = `${DIR}/ref/frame-${i}.png`, tp = `${DIR}/tgt/frame-${i}.png`;
    await writePng(rp, '#20242b', i);
    await writePng(tp, '#1a1e25', i);
    refFrames.push({ index: i, time: i * 0.25, filePath: rp });
    tgtFrames.push(tp);
    trajectories.push({ time: i * 0.25, semantic: {}, bones: trajectoryBones(i) });
  }
  const gifPath = `${DIR}/tgt/target.gif`;
  await writeGif(gifPath);
  const target = `${DIR}/target-manifest.json`, reference = `${DIR}/reference-manifest.json`;
  const poses = `${DIR}/pose-manifest.json`, visualRigPath = `${DIR}/visual-rig.json`;
  await writeJson(target, {
    ok: true, duration: 1, frameCount: N, frames: tgtFrames, gifPath, jsonHash: 'h'.repeat(64),
    filePath: 'target.json', trajectories,
    canvas: { width: W, height: H, background: '#20242b' }, bounds: BOUNDS, outputDir: `${DIR}/tgt`,
  });
  await writeJson(reference, { ok: true, duration: 1, frames: refFrames });
  await writeJson(poses, {
    ok: true, bounds: BOUNDS, standardHeight: H, targetScale: 1,
    reference: { imagePath: `${DIR}/ref/frame-0.png`, crop: [0, 0, W, H], height: H, groundY: H * 0.9, facing: 'left', time: 0, points: referencePoints() },
  });
  const nodes: Record<string, unknown> = {};
  for (const role of ROLES) nodes[role] = { type: 'boneLocal', bone: role, point: [0, 0], calibrated: true, basis: '夹具' };
  await writeJson(visualRigPath, { version: 2, filePath: 'target.json', skin: 'default', nodes, segments: {} });
  return { targetManifestPath: target, referenceManifestPath: reference, poseManifestPath: poses, visualRigPath };
}

const phaseMap = [{ targetTime: 0, referenceTime: 0 }, { targetTime: 1, referenceTime: 1 }];
const correspondence = { left: 'left', right: 'right', basis: '夹具机械验证', anatomicalIdentity: '同侧', projectedOrder: '固定' };

test.before(async () => { await rm(DIR, { recursive: true, force: true }); });
test.after(async () => { await rm(DIR, { recursive: true, force: true }); });

test('投影：两套 rs 口径一致，且目标投影复用 rasterFrame 的居中公式', async () => {
  const f = await buildFixtures();
  const target = JSON.parse(await readFile(f.targetManifestPath, 'utf8'));
  const poses = JSON.parse(await readFile(f.poseManifestPath, 'utf8'));
  const { rs, refX, refY, sc, projectRef, projectTarget } = skeletonProjections(target, poses);
  // 夹具下 rs=1；另用非平凡参数验证两套 rs 定义等价（计划 K1 的真实结论：一致，不是冲突）
  assert.equal(rs, 1, '夹具下 rs=1');
  const t2 = { canvas: { width: 320, height: 320 }, bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 }, filePath: 'x' };
  const standardHeight = 206.52791139707227;
  const p2 = {
    reference: { crop: [10, 20, 300, 400], height: 250, groundY: 300 },
    targetScale: 320 * .7 / standardHeight, standardHeight, bounds: t2.bounds,
  };
  assert.ok(Math.abs(skeletonProjections(t2, p2).rs - 320 * .7 / 250) < 1e-9, 'animationReview 的 rs 展开即 poseWorkflow 的 height*.7/r.height');
  assert.equal(sc, Math.min(W / 100, H / 100), 'sc 必须用 min(w/Δx,h/Δy)');
  // 参考投影：裁剪左上角必须落在 (refX,refY)
  assert.deepEqual(projectRef(0, 0), [refX, refY]);
  // 目标投影：与 rasterFrame 公式 [w/2+(x-cx)*sc, h/2-(y-cy)*sc] 完全一致
  assert.deepEqual(projectTarget(50, 50), [W / 2, H / 2]);
  assert.deepEqual(projectTarget(0, 100), [W / 2 - 50 * sc, H / 2 - 50 * sc]);
  // 两个投影都落在同一 w×h 画布内，无假性错位
  const rp = projectRef(poses.reference.crop[2], poses.reference.crop[3]);
  assert.ok(rp[0] <= W && rp[1] <= H, '参考投影落在画布内');
  for (const [x, y] of [[0, 0], [100, 100], [50, 50]]) {
    const tp = projectTarget(x, y);
    assert.ok(tp[0] >= -1e-6 && tp[0] <= W + 1e-6 && tp[1] >= -1e-6 && tp[1] <= H + 1e-6, '目标投影落在画布内');
  }
});

test('resolveSkeletonMapping：完整映射通过；部分节点失效时降级为部分映射并显式列出', async () => {
  const f = await buildFixtures();
  const target = JSON.parse(await readFile(f.targetManifestPath, 'utf8'));
  const rig = JSON.parse(await readFile(f.visualRigPath, 'utf8'));
  const good = resolveSkeletonMapping(rig, target);
  assert.equal(good.ok, true);
  assert.equal(good.complete, true);
  assert.deepEqual(good.unmappedRoles, []);
  assert.equal(Object.keys(good.nodes).length, ROLES.length);

  // 个别节点骨骼名未命中 / 局部点非原点 → 部分映射，跳过该 role 但保留其余语义骨架
  const badBone = { ...rig, nodes: { ...rig.nodes, head: { ...rig.nodes.head, bone: 'nonexistent' } } };
  const partialBone = resolveSkeletonMapping(badBone, target);
  assert.equal(partialBone.ok, true);
  assert.equal(partialBone.complete, false);
  assert.deepEqual(partialBone.unmappedRoles, ['head']);
  assert.equal(partialBone.nodes.head, undefined);
  assert.match(partialBone.reasons.join(''), /骨骼名未命中/);

  const offOrigin = { ...rig, nodes: { ...rig.nodes, head: { ...rig.nodes.head, point: [3, 4] } } };
  const partialOff = resolveSkeletonMapping(offOrigin, target);
  assert.equal(partialOff.ok, true);
  assert.equal(partialOff.complete, false);
  assert.deepEqual(partialOff.unmappedRoles, ['head']);
  assert.match(partialOff.reasons.join(''), /非原点/);

  // 整份 rig 不可信 → 硬拒绝
  const badVersion = { ...rig, version: 1 };
  assert.equal(resolveSkeletonMapping(badVersion, target).ok, false);
  assert.match(resolveSkeletonMapping(badVersion, target).reasons.join(''), /版本/);
  const badPath = { ...rig, filePath: 'other.json' };
  assert.equal(resolveSkeletonMapping(badPath, target).ok, false);
  assert.match(resolveSkeletonMapping(badPath, target).reasons.join(''), /角色路径不一致/);
  const allBad = { ...rig, nodes: Object.fromEntries(Object.entries(rig.nodes).map(([k, v]: any) => [k, { ...v, point: [1, 1] }])) };
  assert.equal(resolveSkeletonMapping(allBad, target).ok, false, '无任何精确节点时必须硬拒绝');
});

test('targetSkeletonPoints：按映射取点，缺骨骼跳过不编造', () => {
  const nodes = Object.fromEntries(ROLES.map(r => [r, { type: 'boneLocal', bone: r, point: [0, 0] }]));
  const frame = { bones: { head: { x: 1, y: 2 }, face: { x: 3, y: 4 } } };
  const pts = targetSkeletonPoints(frame, nodes);
  assert.deepEqual(Object.keys(pts).sort(), ['face', 'head']);
  assert.deepEqual(pts.head, { x: 1, y: 2 });
  assert.equal(targetSkeletonPoints({ bones: {} }, nodes).head, undefined);
});

test('skeleton 布局：产出骨架叠加 GIF，报告显式标注单帧与语义映射状态', async () => {
  const f = await buildFixtures();
  const r: any = await renderAnimationComparison({ ...f, phaseMap, correspondence, outputDir: `${DIR}/out-skeleton`, layout: 'skeleton' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.layout, 'skeleton');
  assert.ok(r.gifPath.endsWith('reference-skeleton.gif'));
  const size = gifSize(await readFile(r.gifPath));
  assert.deepEqual(size, { width: W, height: H + 44 }, '骨架布局为单幅高 + 两行标签');
  assert.equal(r.comparisonMode, 'legacy-raw-diagnostic');
  assert.equal(r.skeletonSource, 'reference-single-frame', '必须显式标注参考骨架是单帧，不得伪装逐帧');
  assert.equal(r.targetSource, 'trajectories.bones');
  assert.equal(r.rawTargetSource, 'trajectories.bones');
  assert.equal(r.expectedTargetSource, null);
  assert.equal(r.actualTargetSource, null);
  assert.equal(r.rawDiagnosticOnly, true);
  assert.equal(r.formalEligible, false);
  assert.equal(r.correspondence, correspondence);
  assert.equal(r.targetFacing, null);
  assert.equal(r.acceptanceMode, 'diagnostic');
  assert.equal(r.diagnosticOnly, true);
  assert.equal(r.verifiedRig, false);
  assert.equal(r.semanticMapped, true);
  assert.equal(r.semanticComplete, true);
  assert.equal(r.acceptanceEligible, false, '诊断模式不得直接成为正式验收证据');
  assert.deepEqual(r.unmappedRoles, []);
  assert.ok(r.evidence.length > 0, '骨架布局同样必须绑定证据');
  assert.equal(r.frameCount, N);
});

test('skeleton 布局：缺 visualRigPath 时降级，不静默当作已校准', async () => {
  const f = await buildFixtures();
  const { visualRigPath, ...withoutRig } = f;
  const r: any = await renderAnimationComparison({ ...withoutRig, phaseMap, outputDir: `${DIR}/out-degraded`, layout: 'skeleton' }, {});
  assert.equal(r.semanticMapped, false);
  assert.match(r.semanticMappingReason, /visualRigPath/);
  assert.equal(r.skeletonMetrics, null);
  assert.equal(r.metricsAvailable, false);
  assert.equal(r.metricsAcceptanceReady, false);
  assert.equal(r.acceptanceEligible, false);
  assert.match(r.metricsUnavailableReason, /语义映射/);
  assert.ok(r.evidence.length > 0, '降级产物仍须绑定证据');
});

test('metrics：取不到 correspondence 时输出原因，metrics=false 时完全不计算', async () => {
  const f = await buildFixtures();
  const noCorr: any = await renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-nocorr`, layout: 'skeleton' }, {});
  assert.equal(noCorr.skeletonMetrics, null);
  assert.match(noCorr.metricsUnavailableReason, /correspondence/);

  const off: any = await renderAnimationComparison({ ...f, phaseMap, correspondence, outputDir: `${DIR}/out-metricsoff`, layout: 'skeleton', metrics: false }, {});
  assert.equal(off.skeletonMetrics, null);
  assert.equal(off.metricsAvailable, false);
  assert.equal(off.metricsAcceptanceReady, false);
  assert.equal(off.acceptanceEligible, false);
  assert.match(off.metricsUnavailableReason, /关闭了 metrics/);
});

test('metrics：有合法 correspondence 时逐选中帧输出 compareGraphs 摘要，只作证据', async () => {
  const f = await buildFixtures();
  const r: any = await renderAnimationComparison({ ...f, phaseMap, correspondence, targetFacing: 'left', outputDir: `${DIR}/out-metrics`, layout: 'skeleton', times: [0, 0.5] }, {});
  assert.equal(r.frameCount, 2);
  assert.ok(Array.isArray(r.skeletonMetrics), 'metrics 应随选中帧输出');
  assert.equal(r.metricsAvailable, true);
  assert.equal(r.targetFacing, 'left');
  assert.deepEqual(r.correspondence, correspondence);
  assert.equal(r.metricsAcceptanceReady, false, '夹具缺少轮廓/附件证据，指标可诊断但不能正式验收');
  assert.match(r.metricsAcceptanceReason, /不可验证/);
  assert.equal(r.skeletonMetrics.length, 2);
  for (const entry of r.skeletonMetrics) {
    assert.ok(Array.isArray(entry.metrics) && entry.metrics.length > 0);
    assert.ok(entry.metrics.every((m: any) => typeof m.id === 'string' && ['pass', 'fail', 'unverifiable'].includes(m.status)));
    assert.ok(!('ok' in entry), '不得输出 compareGraphs.ok 作为自动判定');
  }
  assert.equal(r.metricsUnavailableReason, null);
});

test('formal 骨架验收：未确认 visualRig 或缺少完整指标时直接拒绝', async () => {
  const f = await buildFixtures();
  await assert.rejects(
    () => renderAnimationComparison({ ...f, phaseMap, correspondence, targetFacing: 'left', acceptanceMode: 'formal', outputDir: `${DIR}/out-formal` , layout: 'skeleton' }, {}),
    /formal 骨架验收前置条件不满足|visualRig 正式校验失败|legacy-raw-diagnostic/,
  );
});

test('times 与 skeleton 组合：只出指定帧', async () => {
  const f = await buildFixtures();
  const r: any = await renderAnimationComparison({ ...f, phaseMap, correspondence, outputDir: `${DIR}/out-times`, layout: 'skeleton', times: [0.25, 0.75] }, {});
  assert.equal(r.frameCount, 2);
  assert.deepEqual(r.frameTimes.map((v: number) => +v.toFixed(3)), [0.25, 0.75]);
});

test('审查门禁接受三种布局，且证据绑定校验未被削弱', async () => {
  const src = await readFile(new URL('../src/animationReview.ts', import.meta.url), 'utf8');
  const gateLine = src.split('\n').find(l => l.includes('requiresReferenceComparison') && l.includes('includes(m.layout)'));
  assert.ok(gateLine, '必须存在布局门禁行');
  assert.ok(gateLine.includes('animationComparisonLayouts.includes(m.layout)'), '门禁必须复用共享布局策略');
  assert.deepEqual(animationComparisonLayouts, ['reference-above-target', 'overlay', 'skeleton']);
  const evidenceLine = src.split('\n').find(l => l.includes('requiresReferenceComparison') && l.includes('m.evidence'));
  assert.ok(evidenceLine, '放宽布局后仍须保留证据绑定校验');
});

test('既有两布局行为不变（画布尺寸与 layout 字段）', async () => {
  const f = await buildFixtures();
  const def: any = await renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-reg-default` }, {});
  assert.equal(def.layout, 'reference-above-target');
  assert.deepEqual(gifSize(await readFile(def.gifPath)), { width: W, height: (H + 28) * 2 });
  const ov: any = await renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-reg-overlay`, layout: 'overlay', opacity: 0.5 }, {});
  assert.equal(ov.layout, 'overlay');
  assert.deepEqual(gifSize(await readFile(ov.gifPath)), { width: W, height: H + 44 });
});

test('布局指纹：生成时落盘，且能检出 layout 与骨架证据字段漂移', async () => {
  const f = await buildFixtures();
  const r: any = await renderAnimationComparison({ ...f, phaseMap, correspondence, targetFacing: 'right', outputDir: `${DIR}/out-fingerprint`, layout: 'skeleton' }, {});
  assert.match(r.layoutFingerprint, /^[0-9a-f]{64}$/);
  const persisted = JSON.parse(await readFile(r.manifestPath, 'utf8'));
  assert.equal(persisted.layoutFingerprint, r.layoutFingerprint, '落盘 manifest 必须带同一指纹');
  assert.equal(comparisonManifestFingerprint(persisted), r.layoutFingerprint, '落盘后重算必须一致');
  assert.notEqual(comparisonManifestFingerprint({ ...persisted, layout: 'overlay' }), r.layoutFingerprint, '改 layout 必须改变指纹');
  assert.notEqual(comparisonManifestFingerprint({ ...persisted, semanticComplete: false }), r.layoutFingerprint, '改骨架证据字段必须改变指纹');
});

test('layout 与 GIF 产物名一一对应，三种布局均匹配', async () => {
  const f = await buildFixtures();
  const cases = [
    ['reference-above-target', 'out-name-default'],
    ['overlay', 'out-name-overlay'],
    ['skeleton', 'out-name-skeleton'],
  ] as const;
  for (const [layout, out] of cases) {
    const r: any = await renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/${out}`, layout }, {});
    assert.ok(r.gifPath.endsWith(comparisonGifNames[layout]), `${layout} 产物名须与策略一致`);
    assert.equal(comparisonLayoutMatchesGif(r), true);
  }
  assert.equal(comparisonLayoutMatchesGif({ layout: 'overlay', gifPath: 'x/reference-skeleton.gif' }), false, '伪造 layout 与骨架产物名不匹配');
  assert.equal(comparisonLayoutMatchesGif({ layout: 'unknown', gifPath: 'x/reference-overlay.gif' }), false);
});

test('骨架证据按语义判定：改 layout、删字段都不能绕过正式批准门禁', async () => {
  const f = await buildFixtures();
  const r: any = await renderAnimationComparison({ ...f, phaseMap, correspondence, targetFacing: 'right', outputDir: `${DIR}/out-gate`, layout: 'skeleton', acceptanceMode: 'diagnostic' }, {});
  assert.equal(isSkeletonEvidence(r), true);
  assert.match(comparisonManifestProblem(r, 'approved', true) ?? '', /legacy-raw-diagnostic|正式批准必须使用 acceptanceMode:formal/);

  // 核心回归：只把 layout 改成 overlay，仍应被识别为骨架证据并拒绝。
  const relabelled = { ...r, layout: 'overlay' };
  assert.equal(isSkeletonEvidence(relabelled), true);
  assert.match(comparisonManifestProblem(relabelled, 'approved', true) ?? '', /布局与 GIF 产物名不一致|布局\/证据字段已变化|正式批准|legacy-raw-diagnostic/);

  // 更彻底：删光骨架字段、改 layout 并伪造 gif 名 → 指纹漂移仍拒绝。
  const skeletonKeys = ['skeletonSource', 'targetSource', 'diagnosticOnly', 'acceptanceMode', 'verifiedRig', 'semanticMapped', 'semanticComplete', 'unmappedRoles', 'semanticMappingReason', 'correspondenceSource', 'correspondence', 'targetFacing', 'skeletonMetrics', 'metricsAvailable', 'metricsAcceptanceReady', 'metricsUnavailableReason', 'metricsAcceptanceReason', 'acceptanceEligible'];
  const stripped: any = { ...r };
  for (const key of skeletonKeys) delete stripped[key];
  stripped.layout = 'overlay';
  stripped.gifPath = stripped.gifPath.replace('reference-skeleton.gif', 'reference-overlay.gif');
  assert.equal(isSkeletonEvidence(stripped), true, 'comparisonMode/rawDiagnosticOnly 仍然表明这是骨架诊断证据');
  assert.match(comparisonManifestProblem(stripped, 'approved', true) ?? '', /legacy-raw-diagnostic|布局\/证据字段已变化|布局与 GIF/, '删字段后仍必须拒绝正式批准');

  // 兼容：旧 manifest 无指纹、普通 overlay、approved 应放行。
  const legacy = { layout: 'overlay', gifPath: 'x/reference-overlay.gif', jsonHash: 'h'.repeat(64) };
  assert.equal(comparisonManifestProblem(legacy, 'approved', true), null);
  // 旧 raw 骨架即使伪造 formal 字段，也不能进入正式审查。
  const noFingerprint: any = { ...r };
  delete noFingerprint.layoutFingerprint;
  assert.match(comparisonManifestProblem({ ...noFingerprint, acceptanceMode: 'formal', acceptanceEligible: true }, 'approved', true) ?? '', /legacy-raw-diagnostic/);
  assert.equal(comparisonManifestProblem({ ...r }, 'rejected', true), null, 'rejected 不需要 formal 资格');
});

test('expected target contract：expected 与 actual 数值可不同但必须共同采样；内容、时间、visualPoints 漂移均阻断', async () => {
  const hash = 'a'.repeat(64);
  const expectedTarget = {
    targetTime: 0.25,
    visualPointsAvailable: true,
    visualPoints: { head: { x: 10, y: 20, source: 'boneLocal', exact: true } },
  };
  const manifest: any = {
    comparisonMode: 'retargeted',
    referenceApprovalDecision: 'approved',
    referenceApprovalFingerprint: hash,
    expectedTargetSource: 'reference-retarget-kernel',
    expectedTargetManifestHash: hashObject(expectedTarget),
    expectedSampleFingerprint: hashObject({ targetTimes: [0.25] }),
    expectedTarget,
    visualPointsAvailable: true,
    formalEligible: false,
    acceptanceMode: 'diagnostic',
  };
  assert.equal(expectedRetargetManifestProblem(manifest), null);
  assert.equal(manifest.expectedTarget.visualPoints.head.x, 10);

  const actual = { visualPointsAvailable: true, visualPoints: { head: { x: 10.1, y: 20.1, source: 'boneLocal', exact: true } } };
  assert.notDeepEqual(actual.visualPoints, expectedTarget.visualPoints, 'expected 与 actual 必须允许数值不同，由比较器计算误差');
  assert.equal(hashObject({ targetTimes: [0.25] }), manifest.expectedSampleFingerprint);

  assert.match(expectedRetargetManifestProblem({ ...manifest, expectedTarget: { ...expectedTarget, visualPoints: { head: { ...expectedTarget.visualPoints.head, x: 11 } } } }) ?? '', /哈希/);
  assert.match(expectedRetargetManifestProblem({ ...manifest, expectedSampleFingerprint: hashObject({ targetTimes: [0.5] }) }) ?? '', /采样指纹/);
  assert.match(expectedRetargetManifestProblem({ ...manifest, expectedTarget: { ...expectedTarget, targetTime: 0.5 } }) ?? '', /哈希|采样指纹/);
  assert.match(expectedRetargetManifestProblem({ ...manifest, expectedTarget: { ...expectedTarget, visualPointsAvailable: false } }) ?? '', /visualPoints/);
  assert.match(expectedRetargetManifestProblem({ ...manifest, expectedTargetManifestHash: hash }) ?? '', /哈希/);

  const multi = {
    ...manifest,
    expectedTargets: [expectedTarget, { ...expectedTarget, targetTime: 0.75 }],
    expectedTargetManifestHash: hashObject([expectedTarget, { ...expectedTarget, targetTime: 0.75 }]),
    expectedSampleFingerprint: hashObject({ targetTimes: [0.25, 0.75] }),
  };
  assert.equal(expectedRetargetManifestProblem(multi), null);
  assert.match(expectedRetargetManifestProblem({ ...multi, expectedTargets: [{ ...expectedTarget, targetTime: 0.75 }, expectedTarget] }) ?? '', /严格递增/);
});

test('retargeted comparison：按 targetTime 对齐 expected 与 candidate runtime actual，数值误差由 visualPoints 比较产生', async () => {
  const f = await buildFixtures();
  const target = JSON.parse(await readFile(f.targetManifestPath, 'utf8'));
  const expectedTargets = target.trajectories.map((trajectory: any, index: number) => ({
    source: 'reference-retarget-kernel',
    targetTime: trajectory.time,
    visualPointsAvailable: true,
    visualPoints: Object.fromEntries(Object.entries(trajectory.bones).map(([role, point]: any) => [role, { ...point, source: 'boneLocal', exact: true }])),
  }));
  target.visualPointsAvailable = true;
  target.trajectories = target.trajectories.map((trajectory: any, index: number) => ({
    ...trajectory,
    visualPointsAvailable: true,
    visualPoints: Object.fromEntries(Object.entries(trajectory.bones).map(([role, point]: any) => [role, { ...point, source: 'boneLocal', exact: true }])),
  }));
  await writeJson(f.targetManifestPath, target);
  const approval = 'a'.repeat(64);
  const retarget = {
    version: 1,
    comparisonMode: 'retargeted',
    acceptanceMode: 'diagnostic',
    acceptanceEligible: false,
    formalEligible: false,
    rawDiagnosticOnly: false,
    referencePosePath: 'reference.json',
    referenceApprovalDecision: 'approved',
    referenceApprovalFingerprint: approval,
    expectedTargetSource: 'reference-retarget-kernel',
    expectedTargets,
    expectedTarget: expectedTargets[0],
    expectedTargetManifestHash: hashObject(expectedTargets),
    expectedSampleFingerprint: hashObject({ targetTimes: expectedTargets.map((entry: any) => entry.targetTime) }),
    visualPointsAvailable: true,
    targetCharacterFingerprint: 'b'.repeat(64),
    actionBindingFingerprint: 'c'.repeat(64),
    visualRigFingerprint: 'd'.repeat(64),
  };
  const retargetPath = `${DIR}/retarget-generation.json`;
  await writeJson(retargetPath, retarget);
  const result: any = await renderAnimationComparison({ ...f, phaseMap, visualRigPath: f.visualRigPath, retargetManifestPath: retargetPath, outputDir: `${DIR}/out-retargeted`, layout: 'skeleton', times: [0, 0.25, 0.5, 0.75] }, {});
  assert.equal(result.comparisonMode, 'retargeted');
  assert.equal(result.expectedTargetSource, 'reference-retarget-kernel');
  assert.equal(result.actualTargetSource, 'candidate-runtime.actual-target-manifest');
  assert.equal(result.visualPointsAvailable, true);
  assert.equal(result.expectedSampleFingerprint, result.actualSampleFingerprint, '共同采样指纹只绑定 targetTime，不比较 expected/actual 数值');
  assert.equal(result.formalEligible, true, '诊断调用下仍应生成可复核的 expected-vs-actual 通过证据');
  assert.ok(result.skeletonMetrics.every((metric: any) => metric.status === 'pass'));

  const drifted = structuredClone(target);
  drifted.trajectories[1].visualPoints.head.x += 1;
  await writeJson(f.targetManifestPath, drifted);
  const failed: any = await renderAnimationComparison({ ...f, phaseMap, visualRigPath: f.visualRigPath, retargetManifestPath: retargetPath, outputDir: `${DIR}/out-retargeted-drift`, layout: 'skeleton', times: [0, 0.25, 0.5, 0.75] }, {});
  assert.equal(failed.formalEligible, false);
  assert.ok(failed.skeletonMetrics.some((metric: any) => metric.status === 'fail'));

  const missing = structuredClone(target);
  missing.trajectories[2].visualPointsAvailable = false;
  missing.visualPointsAvailable = false;
  await writeJson(f.targetManifestPath, missing);
  const unavailable: any = await renderAnimationComparison({ ...f, phaseMap, visualRigPath: f.visualRigPath, retargetManifestPath: retargetPath, outputDir: `${DIR}/out-retargeted-missing`, layout: 'skeleton', times: [0, 0.25, 0.5, 0.75] }, {});
  assert.equal(unavailable.visualPointsAvailable, false);
  assert.equal(unavailable.formalEligible, false);
});

test('raw evidence contract：旧骨架证据永远不能进入 formal', async () => {
  const f = await buildFixtures();
  const r: any = await renderAnimationComparison({ ...f, phaseMap, correspondence, targetFacing: 'right', outputDir: `${DIR}/out-raw-contract`, layout: 'skeleton' }, {});
  assert.equal(isRawOnlyEvidence(r), true);
  assert.equal(hasExpectedRetargetTarget(r), false);
  assert.equal(hasActualTarget(r), false);
  assert.equal(retargetFormalAcceptanceReady(r), false);
  assert.match(comparisonManifestProblem(r, 'approved', true) ?? '', /legacy-raw-diagnostic|正式动作一致性/);

  const hash = 'a'.repeat(64);
  const retargeted = {
    ...r,
    comparisonMode: 'retargeted',
    rawDiagnosticOnly: false,
    formalEligible: true,
    referenceApprovalDecision: 'approved',
    referenceApprovalFingerprint: hash,
    expectedTargetSource: 'reference-retarget-generation.expectedTarget',
    actualTargetSource: 'candidate-runtime.actualTarget',
    expectedTargetManifestHash: hash,
    actualTargetManifestHash: hash,
    expectedSampleFingerprint: hash,
    actualSampleFingerprint: hash,
    visualPointsAvailable: true,
  };
  assert.equal(isRawOnlyEvidence(retargeted), false);
  assert.equal(hasExpectedRetargetTarget(retargeted), true);
  assert.equal(hasActualTarget(retargeted), true);
  assert.equal(retargetFormalAcceptanceReady(retargeted), false, '旧 skeleton acceptanceEligible 未被伪装成 retarget formal');
  assert.equal(retargetManifestProblem(retargeted), null, 'retarget manifest 的结构条件已满足，formal 字段由共享 skeleton 门禁单独判断');
  assert.match(comparisonManifestProblem(retargeted, 'approved', true) ?? '', /布局\/证据字段已变化|正式批准/);

  const formallyEligible: any = { ...retargeted, acceptanceMode: 'formal', acceptanceEligible: true };
  formallyEligible.layoutFingerprint = comparisonManifestFingerprint(formallyEligible);
  assert.equal(retargetFormalAcceptanceReady(formallyEligible), true);
  assert.equal(comparisonManifestProblem(formallyEligible, 'approved', true), null);

  const rejectedReference = { ...formallyEligible, referenceApprovalDecision: 'rejected' };
  assert.match(comparisonManifestProblem(rejectedReference, 'approved', true) ?? '', /rejected|布局\/证据字段已变化/);
  const missingVisualPoints: any = { ...formallyEligible, visualPointsAvailable: false };
  missingVisualPoints.layoutFingerprint = comparisonManifestFingerprint(missingVisualPoints);
  assert.match(comparisonManifestProblem(missingVisualPoints, 'approved', true) ?? '', /visualPoints/);
});
