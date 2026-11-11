import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReferenceCoverage, runReferenceRetargetFlow } from '../src/referenceCoverage.js';

test('body.gif 覆盖校验只承认 ready，未标注帧阻断正式流程', async () => {
  const context = { workspaceRoot: 'diagnostic-fixture' };
  const report = await validateReferenceCoverage({
    referenceGifPath: 'reference/body.gif',
    sequencePath: 'reference/body.sequence.json',
  }, context);
  assert.equal(report.frameCount, 171);
  assert.deepEqual(report.coverageStages, ['ready']);
  assert.equal(report.unreviewedFrameCount, 170);
  assert.equal(report.ok, false);
  assert.equal(report.formalEligible, false);
  assert.ok(report.issues.some((issue: any) => issue.code === 'REFERENCE_COVERAGE_INCOMPLETE'));
});

test('adaptive-preview 只返回已审查阶段诊断结果，不生成提交资格', async () => {
  const result = await runReferenceRetargetFlow({
    referenceGifPath: 'reference/body.gif',
    sequencePath: 'reference/body.sequence.json',
    standardPosePath: 'trial/neutral-stand-v2.pose.json',
    visualRigPath: 'trial/npc1.visual-rig.json',
    workflowProfile: 'adaptive-preview',
    retargetMode: 'adaptive',
    diagnosticPreview: true,
  }, { workspaceRoot: 'diagnostic-fixture' });
  assert.equal(result.formalEligible, false);
  assert.equal(result.readyToCommit, false);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.coverage.coverageStages[0], 'ready');
  assert.equal(result.stages[0].diagnosticOnly, true);
  assert.ok(['keypose-interpolated', 'stage-hold'].includes(result.previewMode));
  if (result.previewMode === 'stage-hold') assert.equal(result.diagnosticPreviewAvailable, false);
});

test('production 在 body.gif 覆盖不完整时直接阻断并保留流程报告', async () => {
  const result = await runReferenceRetargetFlow({
    referenceGifPath: 'reference/body.gif', sequencePath: 'reference/body.sequence.json',
    standardPosePath: 'trial/neutral-stand-v2.pose.json', visualRigPath: 'trial/npc1.visual-rig.json',
    workflowProfile: 'production', retargetMode: 'adaptive', outputDir: 'previews/test-production-flow',
  }, { workspaceRoot: 'diagnostic-fixture' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.formalEligible, false);
  assert.equal(result.stages.length, 0);
  assert.match(result.flowManifestPath, /body-to-npc1-.*production-flow-manifest\.json$/);
});
