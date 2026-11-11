import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTask, taskToolDefinition } from '../src/taskOrchestrator.js';

test('统一入口缺少参考输入时停在 binding，并返回可执行 nextAction', async () => {
  const result = await executeTask({ taskType: 'retarget_reference' }, { workspaceRoot: 'diagnostic-fixture' });
  assert.equal(result.status, 'needs-input');
  assert.equal(result.stopLayer, 'binding');
  assert.equal(result.nextAction.tool, 'spine_execute_task');
  assert.ok(result.blockingReasons.some((item: any) => item.field === 'inputs.referenceGifPath'));
});

test('统一入口 inspect 自动选择 creative 并返回角色检查产物', async () => {
  const result = await executeTask({ taskType: 'inspect', inputs: { targetCharacterPath: '目标/npc1.json' } }, { workspaceRoot: 'diagnostic-fixture' });
  assert.equal(result.workflowProfile, 'creative');
  assert.equal(result.status, 'completed');
  assert.equal(result.stopLayer, 'none');
  assert.ok(result.artifacts.character.bones.length > 0);
  assert.equal(result.readyToCommit, false);
});

test('统一入口参考重定向先审查 keypose 与 visualRig；输入不可信时停在 binding', async () => {
  const result = await executeTask({
    taskType: 'retarget_reference',
    inputs: {
      referenceGifPath: 'reference/body.gif', sequencePath: 'reference/body.sequence.json',
      standardPosePath: 'trial/neutral-stand-v2.pose.json', visualRigPath: 'trial/npc1.visual-rig.json',
    },
    options: { workflowProfile: 'auto', retargetMode: 'adaptive', dryRun: true },
  }, { workspaceRoot: 'diagnostic-fixture' });
  assert.equal(result.workflowProfile, 'adaptive-preview');
  assert.equal(result.retargetMode, 'adaptive');
  assert.equal(result.stopLayer, 'binding');
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.formalEligible, false);
  assert.equal(result.readyToCommit, false);
  assert.ok(result.artifacts.inputAudit);
  assert.ok(result.blockingReasons.some((item: any) => item.code === 'VISUAL_RIG_ORIGIN_ONLY'));
  assert.equal(result.nextAction.tool, 'spine_calibrate_visual_rig');
});

test('统一入口公开 schema 使用 auto/adaptive-preview 默认结构', () => {
  const props: any = taskToolDefinition.inputSchema.properties;
  assert.equal(taskToolDefinition.name, 'spine_execute_task');
  assert.deepEqual(props.options.properties.workflowProfile.enum, ['auto', 'creative', 'adaptive-preview', 'production']);
  assert.deepEqual(props.options.properties.retargetMode.enum, ['adaptive', 'strict']);
  assert.equal(props.options.properties.auditInputs.default, true);
});

test('统一入口 prepare_review 显式进入 production，输入绑定不可信时先停在 binding', async () => {
  const result = await executeTask({
    taskType: 'prepare_review',
    inputs: {
      referenceGifPath: 'reference/body.gif', sequencePath: 'reference/body.sequence.json',
      standardPosePath: 'trial/neutral-stand-v2.pose.json', visualRigPath: 'trial/npc1.visual-rig.json',
    },
    options: { workflowProfile: 'production', dryRun: true },
  }, { workspaceRoot: 'diagnostic-fixture' });
  assert.equal(result.workflowProfile, 'production');
  assert.equal(result.status, 'blocked');
  assert.equal(result.stopLayer, 'binding');
  assert.equal(result.formalEligible, false);
  assert.equal(result.nextAction.tool, 'spine_calibrate_visual_rig');
});

