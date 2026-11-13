import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectCharacter } from './motionEngine.js';
import { createPoseDraft, buildMotionFromPoses } from './poseWorkflow.js';
import { runReferenceRetargetFlow } from './referenceCoverage.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { strictHash } from './hostContracts.js';
import { saveJson } from './mappingTools.js';
import { auditReferenceObservationImage, auditReferenceKeypose } from './referencePose.js';
import { auditVisualRigBinding, auditVisualRigRuntimeBinding, requireVisualRig } from './visualRig.js';
import { runtimeBuildIdentity } from './buildIdentity.js';

export type TaskType = 'inspect' | 'create_pose' | 'create_motion' | 'retarget_reference' | 'prepare_review';
export type WorkflowProfile = 'creative' | 'adaptive-preview' | 'production';
export type RetargetMode = 'adaptive' | 'strict';
export type StopLayer = 'none' | 'binding' | 'coverage' | 'solve' | 'runtime' | 'evidence' | 'review' | 'commit';

export const taskToolDefinition = {
  name: 'spine_execute_task',
  description: '统一执行常见 Spine 任务：自动核对输入、选择工作流、调用现有工具、生成可观看证据，并在明确停止层返回下一步。默认只预演到可提交，不自动写入角色；正式写入仍须单独使用 Host 提交流程。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: { type: 'string' },
      taskType: { type: 'string', enum: ['inspect', 'create_pose', 'create_motion', 'retarget_reference', 'prepare_review'] },
      characterId: { type: 'string' },
      inputs: {
        type: 'object',
        additionalProperties: false,
        properties: {
          referencePath: { type: 'string' }, referenceGifPath: { type: 'string' }, sequencePath: { type: 'string' },
          referencePosePath: { type: 'string' }, standardPosePath: { type: 'string' }, visualRigPath: { type: 'string' },
          mappingPath: { type: 'string' }, targetCharacterPath: { type: 'string' }, motionPath: { type: 'string' },
          filePath: { type: 'string' }, posePath: { type: 'string' }, outputPosePath: { type: 'string' },
          outputMotionPath: { type: 'string' }, animation: { type: 'string' }, name: { type: 'string' },
          kind: { type: 'string', enum: ['standing', 'action'] }, duration: { type: 'number', exclusiveMinimum: 0 },
          keyPoses: { type: 'array', items: { type: 'object' } }, frame: { type: 'object' }, patch: { type: 'object' },
          stageId: { type: 'string' }, outputDir: { type: 'string' },
        },
      },
      options: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workflowProfile: { type: 'string', enum: ['auto', 'creative', 'adaptive-preview', 'production'], default: 'auto' },
          retargetMode: { type: 'string', enum: ['adaptive', 'strict'], default: 'adaptive' },
          previewPolicy: { type: 'string', enum: ['auto', 'none'], default: 'auto' },
          dryRun: { type: 'boolean', default: true },
          auditInputs: { type: 'boolean', default: true, description: '在参考重定向前审查关键点是否落在参考前景、visualRig 是否仍为真实视觉锚点。' },
        },
      },
    },
    required: ['taskType'],
  },
} as const;

function profileFor(taskType: TaskType, requested?: string): WorkflowProfile {
  if (requested && requested !== 'auto') return requested as WorkflowProfile;
  if (taskType === 'prepare_review') return 'production';
  if (taskType === 'retarget_reference') return 'adaptive-preview';
  return 'creative';
}

function baseResult(taskType: TaskType, profile: WorkflowProfile, mode: RetargetMode) {
  return {
    taskId: randomUUID(), taskType, status: 'failed', workflowProfile: profile, retargetMode: mode,
    stopLayer: 'none' as StopLayer, completedSteps: [] as string[], blockingReasons: [] as any[], nextAction: null as any,
    nextActions: [] as any[], artifacts: {} as Record<string, any>, inputHashes: {} as Record<string, string>,
    diagnosticOnly: false, formalEligible: false, readyToCommit: false,
  };
}

function missing(result: any, fields: string[]) {
  result.status = 'needs-input'; result.stopLayer = 'binding';
  result.blockingReasons = fields.map(field => ({ code: 'TASK_INPUT_MISSING', field, message: `缺少统一任务所需输入：${field}。` }));
  result.nextAction = { tool: 'spine_execute_task', instruction: `补充以下输入后重试：${fields.join('、')}。` };
  return result;
}

function mapReferenceResult(result: any) {
  const out: any = {
    status: result.status === 'formal-ready' ? 'needs-review' : (result.status === 'geometric-adapted' || result.diagnosticPreviewAvailable) ? 'preview-ready' : result.status,
    stopLayer: 'review' as StopLayer,
    completedSteps: result.completedSteps ?? [], blockingReasons: result.blockingReasons ?? [],
    artifacts: {
      flowManifestPath: result.flowManifestPath,
      motion: result.motion,
      runtimePreview: result.runtimePreview,
      referencePreview: result.referencePreview,
      comparison: result.comparison,
      evidence: result.evidence,
      diagnosticPreview: result.diagnosticPreviewManifestPath ? { manifestPath: result.diagnosticPreviewManifestPath, previewMode: result.previewMode, runtimePreview: result.runtimePreview, comparison: result.comparison, motion: result.motion } : null,
      stages: result.stages,
    },
    inputHashes: result.inputHashes ?? {}, diagnosticOnly: result.diagnosticOnly === true,
    formalEligible: result.formalEligible === true, readyToCommit: false,
  };
  if (result.coverage?.unreviewedFrameCount > 0) out.stopLayer = 'coverage';
  if (result.status === 'unresolved') out.stopLayer = 'solve';
  if (result.formalEligible) {
    out.nextAction = { tool: 'spine_review_animation', instruction: '读取候选动画和动态对比 GIF，完成正式人工视觉审查；审查通过后再使用 Host 提交。' };
    out.nextActions = [{ tool: 'spine_render_animation_comparison', instruction: '重新生成或切换对比布局后再审查。' }];
  } else if (out.stopLayer === 'coverage') {
    out.nextAction = { tool: 'spine_validate_reference_coverage', instruction: '补齐未覆盖 reference pose，并逐阶段审查后重新执行。' };
    out.nextActions = [{ tool: 'spine_analyze_reference_gif', instruction: '先分析未覆盖 GIF 的时序和关键帧候选；候选仍需人工标注。' }];
  } else {
    out.nextAction = { tool: 'spine_execute_task', instruction: result.diagnosticPreviewAvailable ? '通过 MCP 预览查看连续目标 GIF 和同步对比 GIF；诊断结果仍不能进入正式验收。' : (result.nextAction ?? '读取诊断产物、修复失败项后重新执行。') };
  }
  return out;
}

async function hashInputs(inputs: any, context: ToolContext) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (typeof value !== 'string' || !value || !/Path$/.test(key) && !['filePath', 'posePath', 'motionPath'].includes(key)) continue;
    try { result[key] = strictHash(await readFile(resolveWorkspacePath(value, context))); } catch { /* 下游返回可执行缺失输入。 */ }
  }
  return result;
}

async function persistManifest(result: any, args: any, context: ToolContext) {
  const outputDir = args.inputs?.outputDir ?? `previews/jobs/task-${result.taskId}`;
  const manifestPath = `${outputDir}/task-manifest.json`;
  await saveJson(manifestPath, { version: 1, kind: 'unified-task', createdAt: new Date().toISOString(), ...result }, context);
  result.artifacts = { ...(result.artifacts ?? {}), taskManifestPath: manifestPath };
  return result;
}

async function auditRetargetInputs(inputs:any, context:ToolContext){
  const sequence=JSON.parse(await readFile(resolveWorkspacePath(inputs.sequencePath,context),'utf8'));
  const rig=JSON.parse(await readFile(resolveWorkspacePath(inputs.visualRigPath,context),'utf8'));
  const mappingPath=inputs.mappingPath??rig.mappingPath;
  const mapping=mappingPath?JSON.parse(await readFile(resolveWorkspacePath(mappingPath,context),'utf8')):null;
  const binding:any=auditVisualRigBinding(rig,mapping);
  try{
    const loaded=await requireVisualRig(inputs.visualRigPath,context,false);
    const skeleton=loaded.rt.sample(undefined,0,loaded.rig.skin);
    const runtimeAudit=auditVisualRigRuntimeBinding(loaded.rig,skeleton);
    binding.runtimeAudit=runtimeAudit;
    if(!runtimeAudit.ok)binding.issues.push(...runtimeAudit.issues);
  }catch(error){
    binding.runtimeAudit={ok:false,issues:[{code:'MAPPING_RUNTIME_MISMATCH',message:error instanceof Error?error.message:String(error)}]};
    binding.issues.push(...binding.runtimeAudit.issues);
  }
  const keyposes:any[]=[];
  for(const stage of sequence.stages??[]){
    try{
      const pose=JSON.parse(await readFile(resolveWorkspacePath(stage.referencePosePath,context),'utf8'));
      const visual=await auditReferenceObservationImage(pose.observation,context);
      const semantic=auditReferenceKeypose(pose.observation,visual);
      keyposes.push({stageId:stage.stageId,referencePosePath:stage.referencePosePath,referenceFingerprint:pose.imageHash??null,...visual,...semantic,ok:visual.ok&&semantic.ok,blocking:[...(visual.blocking??[]),...(semantic.blocking??[])]});
    }catch(error){keyposes.push({stageId:stage.stageId,referencePosePath:stage.referencePosePath,ok:false,blocking:[{code:'REFERENCE_POSE_AUDIT_FAILED',message:error instanceof Error?error.message:String(error)}]});}
  }
  return {ok:binding.ok&&keyposes.every(v=>v.ok),binding,keyposes,blockingReasons:[...binding.issues,...keyposes.flatMap(v=>v.blocking??[])]};
}

export async function executeTask(args: any, context: ToolContext = {}) {
  const taskType = args.taskType as TaskType;
  const inputs = args.inputs ?? {};
  const options = args.options ?? {};
  const profile = profileFor(taskType, options.workflowProfile);
  const mode: RetargetMode = options.retargetMode ?? 'adaptive';
  const result: any = baseResult(taskType, profile, mode);
  result.buildIdentity = await runtimeBuildIdentity;
  if (result.buildIdentity.kind === 'compiled' && result.buildIdentity.stale) {
    result.status = 'blocked'; result.stopLayer = 'binding'; result.diagnosticOnly = true; result.formalEligible = false; result.readyToCommit = false;
    result.blockingReasons = [{ code: 'BUILD_STALE', message: '当前 MCP 编译产物与工作区源码不一致，请先重新执行 npm run build 并重启 MCP/Host。' }];
    result.nextAction = { tool: 'spine_execute_task', instruction: '先重新编译并重启当前 MCP/Host，再重试原提示词。' };
    return persistManifest(result, args, context);
  }
  result.inputHashes = await hashInputs(inputs, context);
  result.completedSteps.push('task-validated', 'mode-selected');
  try {
    if (taskType === 'inspect') {
      const filePath = inputs.targetCharacterPath ?? inputs.filePath;
      if (!filePath) return persistManifest(missing(result, ['inputs.targetCharacterPath 或 inputs.filePath']), args, context);
      result.artifacts.character = await inspectCharacter(filePath, context);
      result.status = 'completed'; result.stopLayer = 'none'; result.completedSteps.push('character-inspected');
      result.nextAction = { tool: 'spine_create_mapping_draft', instruction: '根据角色检查结果创建或校准 mapping；未经确认的 mapping 不能进入正式求解。' };
      return persistManifest(result, args, context);
    }
    if (taskType === 'create_pose') {
      const required = ['filePath', 'mappingPath', 'posePath', 'kind'].filter(k => inputs[k] === undefined);
      if (required.length) return persistManifest(missing(result, required.map(k => `inputs.${k}`)), args, context);
      const candidate = await createPoseDraft({ ...inputs, dryRun: options.dryRun ?? true }, context);
      result.artifacts.pose = candidate.pose; result.artifacts.posePath = candidate.posePath;
      result.status = 'preview-ready'; result.stopLayer = 'review'; result.diagnosticOnly = true; result.completedSteps.push('pose-candidate-created');
      result.nextAction = { tool: 'spine_solve_pose', arguments: { posePath: candidate.posePath }, instruction: '求解并生成姿态对比证据，然后进行人工视觉审查。' };
      return persistManifest(result, args, context);
    }
    if (taskType === 'create_motion') {
      const required = ['standardPosePath', 'keyPoses', 'motionPath', 'name', 'duration'].filter(k => inputs[k] === undefined);
      if (required.length) return persistManifest(missing(result, required.map(k => `inputs.${k}`)), args, context);
      const candidate = await buildMotionFromPoses({ ...inputs, dryRun: options.dryRun ?? true }, context);
      result.artifacts.motion = candidate.motion; result.artifacts.motionPath = inputs.motionPath;
      result.status = 'preview-ready'; result.stopLayer = 'review'; result.diagnosticOnly = true; result.completedSteps.push('motion-candidate-created');
      result.nextAction = { tool: 'spine_retarget_motion', arguments: { filePath: inputs.targetCharacterPath ?? inputs.filePath, mappingPath: inputs.mappingPath, motionPath: inputs.motionPath, animation: inputs.animation ?? inputs.name, dryRun: true, preview: true }, instruction: '使用目标角色 mapping 生成 runtime 候选、原速 GIF 和动态比较，再进入人工审查。' };
      return persistManifest(result, args, context);
    }
    const required = ['referenceGifPath', 'sequencePath', 'standardPosePath', 'visualRigPath'].filter(k => inputs[k] === undefined);
    if (required.length) return persistManifest(missing(result, required.map(k => `inputs.${k}`)), args, context);
    if (options.auditInputs !== false) {
      const audit=await auditRetargetInputs(inputs,context);
      result.artifacts.inputAudit=audit;
      if(!audit.ok){
        result.status='blocked'; result.stopLayer='binding'; result.diagnosticOnly=true; result.formalEligible=false; result.readyToCommit=false;
        result.blockingReasons=[...audit.blockingReasons];
        const codes=new Set((audit.blockingReasons??[]).map((v:any)=>v.code));
        if(codes.has('KEYPOSE_FOREGROUND_MISMATCH')||codes.has('KEYPOSE_REQUIRED_POINT_UNKNOWN')||codes.has('KEYPOSE_IDENTITY_UNCONFIRMED')||codes.has('KEYPOSE_SUPPORT_UNCONFIRMED')){
          result.nextAction={tool:'spine_render_reference_pose_sheet',instruction:'先生成参考帧放大联系表，逐阶段修正背景命中点、遮挡估计、解剖左右、支撑脚、朝向和前后证据；完成新的 reference pose 审查后再重试。'};
        }else if(codes.has('VISUAL_RIG_ORIGIN_ONLY')||codes.has('VISUAL_RIG_LOW_CONFIDENCE')||codes.has('FACE_ANCHOR_UNVERIFIED')){
          result.nextAction={tool:'spine_calibrate_visual_rig',instruction:'先重新生成 visualRig 校准图，使用切片接缝或 meshTriangle 确认肩肘腕髋膝踝，并补齐鼻尖/前脸锚点；不要只保留骨骼原点。'};
        }else{
          result.nextAction={tool:'spine_validate_mapping',instruction:'先核对 mapping 与 visualRig 的解剖左右、三段骨骼链、attachment 绑定和 hash，再重新执行。'};
        }
        result.nextActions=[{tool:'spine_render_reference_pose_sheet',instruction:'查看每个阶段的原图与节点叠加，未确认点改为 unknown，不得凭空补坐标。'},{tool:'spine_validate_mapping',instruction:'重新核对解剖左右、三段骨骼链、切片 attachment 和 visualRig 指纹绑定。'}];
        result.completedSteps.push('input-visual-audit-blocked');
        return persistManifest(result,args,context);
      }
      result.completedSteps.push('input-visual-audit-passed');
    }
    const flow = await runReferenceRetargetFlow({
      ...inputs, retargetMode: mode, workflowProfile: profile, diagnosticPreview: options.previewPolicy !== 'none', dryRun: true,
    }, context);
    const mapped = mapReferenceResult(flow);
    return persistManifest({ ...result, ...mapped, taskId: result.taskId, workflowProfile: profile, retargetMode: mode }, args, context);
  } catch (error) {
    result.status = 'failed'; result.stopLayer = 'solve';
    result.blockingReasons = [{ code: 'TASK_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) }];
    result.nextAction = { tool: 'spine_execute_task', instruction: '读取 blockingReasons，修复输入或目标角色绑定后重新执行；当前没有写入或提交授权。' };
    return persistManifest(result, args, context);
  }
}

