import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMapping } from '../src/motionEngine.js';
import { projectedSegmentDelta, projectedSegmentLength } from '../src/perspective.js';

test('透视点映射允许点骨骼插入实体链并拒绝错误父子关系', () => {
  const mapping: any = {
    character: 'demo', version: 2,
    bones: {
      body: 'body', leftArm: ['arm1', 'arm2', 'hand'],
      anchors: { leftHand: { bone: 'hand', point: [0, 0] } },
    },
    depthPoints: { arm1: 'arm1-toushipoint' },
    status: 'draft',
  };
  const json = { bones: [
    { name: 'body' }, { name: 'arm1', parent: 'body' },
    { name: 'arm1-toushipoint', parent: 'arm1' },
    { name: 'arm2', parent: 'arm1-toushipoint' }, { name: 'hand', parent: 'arm2' },
  ] };
  assert.deepEqual(validateMapping(mapping, json).depthPoints, [{ bone: 'arm1', perspectivePoint: 'arm1-toushipoint' }]);
  assert.throws(() => validateMapping(mapping, { bones: json.bones.map((b: any) => b.name === 'arm1-toushipoint' ? { ...b, parent: 'body' } : b) }), /直接子级/);
});

test('透视投影公式保持段长与位移定义', () => {
  const length = projectedSegmentLength(10, Math.PI / 3);
  assert.ok(Math.abs(length - 5) < 1e-10);
  assert.ok(Math.abs(projectedSegmentDelta(10, Math.PI / 3) - 5) < 1e-10);
});
