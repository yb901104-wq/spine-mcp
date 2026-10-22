import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  comparisonPolicy,
  compareGraphs,
  lineError,
  torsoFrame,
  torsoCoordinate,
  headFacingTurn,
  headBandOf,
  normalizeImagePoints,
} from '../src/poseGraph.js';

// 合成姿态：面朝 +x、y 向上，躯干长 L=1（髋线 y=0，肩线 y=1）。
function pose(scale = 1) {
  const s = scale;
  return {
    head: { x: 0, y: 1.6 * s },
    face: { x: 0.2 * s, y: 1.6 * s },
    body: { x: 0, y: 0.8 * s },
    leftShoulder: { x: 0.25 * s, y: 1 * s },
    rightShoulder: { x: -0.25 * s, y: 1 * s },
    leftHip: { x: 0.2 * s, y: 0 },
    rightHip: { x: -0.2 * s, y: 0 },
    leftElbow: { x: 0.25 * s, y: 0.7 * s },
    leftWrist: { x: 0.25 * s, y: 0.4 * s },
    rightElbow: { x: -0.25 * s, y: 0.7 * s },
    rightWrist: { x: -0.25 * s, y: 0.4 * s },
    leftKnee: { x: 0.2 * s, y: -0.6 * s },
    leftAnkle: { x: 0.2 * s, y: -1.2 * s },
    rightKnee: { x: -0.2 * s, y: -0.6 * s },
    rightAnkle: { x: -0.2 * s, y: -1.2 * s },
  };
}

test('v3 策略与 policies/pose-comparison.v3.json 一致', async () => {
  const file = JSON.parse(await readFile('policies/pose-comparison.v3.json', 'utf8'));
  assert.deepEqual(file, comparisonPolicy);
  assert.equal(comparisonPolicy.version, 3);
  for (const key of ['lineDegrees', 'twistDegrees', 'silhouetteWidth', 'facingRatio', 'reach', 'torsoHeight', 'torsoOffset', 'footOffset', 'headGap', 'headDegrees']) {
    assert.equal(typeof (comparisonPolicy as any)[key], 'number', `缺少数值门限 ${key}`);
  }
});

test('躯干局部坐标与整体缩放无关', () => {
  const a = torsoCoordinate(torsoFrame(pose(1))!, pose(1).leftWrist);
  const b = torsoCoordinate(torsoFrame(pose(2.5))!, pose(2.5).leftWrist);
  assert.ok(Math.abs(a.a - b.a) < 1e-9 && Math.abs(a.n - b.n) < 1e-9);
  // 髋线 A=0，肩线 A=1；左腕在躯干左侧、介于髋肩之间
  const f = torsoFrame(pose())!;
  assert.ok(Math.abs(torsoCoordinate(f, pose().leftHip).a) < 1e-9);
  assert.ok(Math.abs(torsoCoordinate(f, pose().leftShoulder).a - 1) < 1e-9);
  assert.ok(Math.abs(a.a - 0.4) < 1e-9, '腕高应等于 0.4 个躯干长');
});

test('无向线误差容忍 180° 等价', () => {
  assert.equal(lineError(179, -179), 2);
  assert.equal(lineError(0, 180), 0);
  assert.equal(lineError(10, 30), 20);
});

test('头部朝向只由面部锚点决定', () => {
  // 鼻子正前方（+x）→ 0°
  assert.ok(Math.abs(headFacingTurn(pose())!) < 1e-9);
  // 鼻子朝下 → -90°
  const down = { ...pose(), face: { x: 0, y: 1.4 } };
  assert.ok(Math.abs(headFacingTurn(down)! + 90) < 1e-9);
  // 面部锚点未知 → 无法计算，不得用头身连线替代
  const unknown = { ...pose(), face: { x: 0, y: 1.6, visibility: 'unknown' } };
  assert.equal(headFacingTurn(unknown), null);
  assert.equal(headBandOf(0), 'forward');
  assert.equal(headBandOf(-35), 'turned');
  assert.equal(headBandOf(75), 'sharp');
});

test('图像坐标镜像与 normalizedGraph 使用同一规则', () => {
  const points = { head: { x: 3, y: 4 }, face: { x: 5, y: 6 } };
  const right = normalizeImagePoints(points, 'right');
  assert.deepEqual([right.head.x, right.head.y], [3, -4]);
  const left = normalizeImagePoints(points, 'left');
  assert.deepEqual([left.head.x, left.head.y], [-3, -4]);
  assert.throws(() => normalizeImagePoints(points, 'up' as any), /朝向/);
});

// 真实负例：同一份未修改的 v4 目标，v2 策略曾 27 项全 pass 却被真人退回。
// v3 必须给出可量化的失败原因；参考仍为 v1 时，轮廓/头部朝向必须 unverifiable 而不是 pass。
test('真实 ready 案例：v3 结构指标必须把「外伸变贴身」判为失败', async t => {
  const root = 'D:/AI_cc/spine test';
  const dir = 'previews/ready-refinement-2026-10-10T04-03-50.693Z';
  let ref: any, cmp: any;
  try {
    ref = JSON.parse(await readFile(`${root}/${dir}/ready.reference.json`, 'utf8'));
    cmp = JSON.parse(await readFile(`${root}/${dir}/ready-v4.pose.comparison.json`, 'utf8'));
  } catch { t.skip('未提供本地 npc1 ready 案例'); return; }
  const result = compareGraphs(ref.observation, cmp.target, cmp.correspondence);
  const status = (id: string) => result.metrics.find((m: any) => m.id === id)?.status;
  assert.equal(result.ok, false);
  assert.equal(result.version, 3);
  // 躯干：肩线倾斜与扭转，不再只看躯干轴一条线
  assert.equal(status('body.shoulderLine'), 'fail');
  assert.equal(status('body.twist'), 'fail');
  assert.equal(status('body.hipLine'), 'pass');
  // 手臂：外伸距离、腕高、与头部间隙同时失败，贴身收臂不能再靠方向角过关
  for (const id of ['arm.left.wristReach', 'arm.left.wristTorsoHeight', 'arm.left.wristHeadGap', 'arm.right.wristHeadGap']) assert.equal(status(id), 'fail', id);
  assert.equal(result.metrics.filter((m: any) => m.status === 'fail').length >= 6, true);
  // v1 参考没有轮廓/面部锚点/前后证据：不得静默通过
  for (const id of ['body.shoulderSilhouette', 'head.orientation', 'head.turnBand']) assert.equal(status(id), 'unverifiable', id);
  assert.ok(result.metrics.some((m: any) => m.id === 'leftArm.wrist' && m.status === 'pass'), '旧方向指标仍会通过，正是需要被新指标补偿的地方');
});
