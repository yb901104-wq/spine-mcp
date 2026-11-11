import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMotionValidation, resolveRetargetMode } from '../src/retargetPolicy.js';

test('adaptive motion 只放宽压缩残差，保留握持/接地/不可达硬门禁', () => {
  const adapted = classifyMotionValidation({
    issues: ['网格压缩误差 2 超过阈值。', 'runtime 旋转压缩误差 1 超过阈值。'],
    maxFootError: .001,
    maxHandError: .02,
    maxVertexError: 2,
    maxRotationError: 1,
    maxTranslationError: 0,
  }, 'adaptive');
  assert.equal(adapted.ok, true);
  assert.equal(adapted.status, 'geometric-adapted');
  assert.deepEqual(adapted.relaxedConstraints, ['meshCompression', 'runtimeRotationCompression']);

  const semanticFailure = classifyMotionValidation({
    issues: ['手腕误差 1 超过阈值。'],
    maxFootError: 0,
    maxHandError: 1,
  }, 'adaptive', [{ time: .2, role: 'leftHand' }]);
  assert.equal(semanticFailure.ok, false);
  assert.equal(semanticFailure.status, 'unresolved');
});

test('新调用默认 adaptive，旧资产复核可显式按 strict 解释', () => {
  assert.equal(resolveRetargetMode(undefined, false), 'adaptive');
  assert.equal(resolveRetargetMode(undefined, true), 'strict');
  assert.equal(resolveRetargetMode('strict'), 'strict');
});
