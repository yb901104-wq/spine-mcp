import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, metricAdvice } from '../src/poseOps.js';

test('指标说明必须给出可调旋钮，不可调项要明确写出来', () => {
  assert.equal(metricAdvice('body.twist').knob, 'frame.channels.torso.rotate');
  assert.equal(metricAdvice('body.torsoDirection').knob, 'body.rotate');
  assert.equal(metricAdvice('arm.left.wristReach').knob, 'targets.leftHand {x,y}');
  assert.equal(metricAdvice('arm.right.wristHeadGap').knob, 'targets.rightHand {x,y}');
  assert.equal(metricAdvice('leg.left.ankleTorsoOffset').knob, 'targets.leftFoot x');
  assert.equal(metricAdvice('depth.rightArmTorso').knob, 'frame.presentation.drawOrder');
  assert.equal(metricAdvice('body.shoulderSilhouette').knob, '不可调');
  assert.equal(metricAdvice('head.orientation').knob, 'frame.head');
  assert.equal(metricAdvice('grip.direction').knob, 'pose.weapon 或手部 angle');
});

test('批处理只改指定字段，并清掉旧求解与审查', () => {
  const draft: any = {
    frame: { time: 0, body: { x: 0, y: 0, rotate: 0 }, targets: { leftHand: { x: 1, y: 2, angle: 0 }, leftFoot: { x: 0, y: 0, contact: true } }, channels: {} },
    solution: { ok: true }, review: { decision: 'approved' },
  };
  const applied = applyOps(draft, [
    { op: 'target', role: 'leftHand', y: 0.5 },
    { op: 'channel', name: 'torso', rotate: 12 },
    { op: 'weapon', weapon: { x: 0, y: 0, angle: 30, grips: { left: 0.2, right: -0.2 } } },
  ]);
  assert.deepEqual(applied, ['target:leftHand', 'channel:torso', 'weapon']);
  assert.deepEqual(draft.frame.targets.leftHand, { x: 1, y: 0.5, angle: 0 });
  assert.deepEqual(draft.frame.targets.leftFoot, { x: 0, y: 0, contact: true });
  assert.equal(draft.frame.channels.torso.rotate, 12);
  assert.equal(draft.weapon.angle, 30);
  assert.equal(draft.solution, undefined, '旧求解必须清掉，避免过期结果被当真');
  assert.equal(draft.review, undefined, '旧审查必须清掉');
});

test('非法操作与空补丁必须报错', () => {
  const draft: any = { frame: { targets: {} } };
  assert.throws(() => applyOps(draft, []), /不能为空/);
  assert.throws(() => applyOps(draft, [{ op: 'nope' }]), /未知操作/);
  assert.throws(() => applyOps(draft, [{ op: 'target', role: 'waist', x: 1 }]), /目标必须是/);
  assert.throws(() => applyOps(draft, [{ op: 'target', role: 'leftHand' }]), /至少给/);
  assert.throws(() => applyOps(draft, [{ op: 'channel', name: 'torso' }]), /至少给/);
  assert.throws(() => applyOps(draft, [{ op: 'target', role: 'leftHand', x: NaN }]), /有限/);
  const before=structuredClone(draft);
  assert.throws(()=>applyOps(draft,[{op:'target',role:'leftHand',x:1},{op:'channel',name:'torso',rotate:Infinity}]),/有限/);
  assert.deepEqual(draft,before,'整批验证失败时不能半应用第一个操作');
});
