#!/usr/bin/env node
import {armCalibrationToolDefinitions,callArmCalibration} from './armCalibrationTools.js';
import { createPoseDraft, solvePose, adjustPose, renderPoseComparison, reviewPose, buildMotionFromPoses, poseChecks } from './poseWorkflow.js';
import {fullAnimationChecks} from './hostAnimationSession.js';
import { createReferencePose, renderReferencePoseSheet, reviewReferencePose, upgradeReferencePose, requireReferencePose, referenceFingerprint } from './referencePose.js';
import { analyzeReferenceParts } from './referenceParts.js';
import { creationToolDefinitions, callCreationTool, recordCreationCall } from './creationTasks.js';
import { creationReferenceDefinitions, createPoseSequence } from './creationReference.js';
import { summarizeHostResult } from './creationQuality.js';
import { catalogToolDefinitions, ToolCatalog } from './toolCatalog.js';
import { creationControlDefinitions, callCreationControl } from './creationControls.js';
import { reviewAnimation, renderAnimationComparison } from './animationReview.js';
import { calibrateVisualRig, reviewVisualRig } from './visualRig.js';
import { retargetReferencePose, comparePoseGraphs, generateReferenceRetargetTarget } from './referenceRetarget.js';
import {validatePoseSequence} from './poseSequence.js';
import {refineReferencePose} from './referencePoseRefinement.js';
import { getPoseState, explainPose, setPoseTarget, setPoseChannel, batchPoseOps } from './poseOps.js';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from 'node:url';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
  EmptyResultSchema,
  ListResourcesRequestSchema,ReadResourceRequestSchema,ListResourceTemplatesRequestSchema,ListPromptsRequestSchema,GetPromptRequestSchema,McpError,ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import {
  agentPing,
  getAgentConnectionStatus,
} from "./agentTools.js";
import { AgentConnectionMonitor } from './agentConnectionMonitor.js';
import {
  listBackups,
  restoreBackup,
} from "./backupTools.js";
import {
  checkPreviewAssets,
  getPreviewConfig,
  getPreviewUrl,
  runValidationPipeline,
  validatePreviewRuntime,
} from "./previewTools.js";
import {
  clearPreviewSession,
  getPreviewSession,
  setPreviewSession,
} from "./sessionTools.js";
import {
  applyPoseKeyframes,
  applyPoseSequence,
  cloneAnimation,
  copyKeyframeRange,
  createAnimation,
  deleteAnimation,
  deleteKeyframeRange,
  getAnimationSheet,
  getAnimationTimelines,
  getAnimations,
  getDocumentSummary,
  getOfficialSpecSummary,
  getSkeletonHierarchy,
  getSkins,
  getSlots,
  makeLoop,
  offsetBoneTimelineValues,
  readSpineDocument,
  removeKeyframe,
  scaleKeyframeTimes,
  setBoneKeyframe,
  setCurve,
  setDrawOrderKeyframe,
  setSlotAttachmentKeyframe,
  fitAnimationCurves,
  shiftKeyframes,
  validateSpineJson,
  resolveWorkspacePath,
} from "./spineJson.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from 'node:path';
import {
  inspectCharacter,
  batchRetarget,
  readCharacterMapping,
  readMotionDefinition,
  retargetMotion,
  validateMapping,
  validateMotion,
} from "./motionEngine.js";
import { calibrateMapping, confirmMapping, createMappingDraft } from "./mappingTools.js";
import { extractMotion, validateMotionResult } from "./retargetEngine.js";
import { comparePreviewReports, createPreviewManifest, renderAnimationGif, renderAnimationFrames, renderContactSheet, getPreviewReport } from "./previewRenderTools.js";
import { analyzeReferenceGif, extractReferenceKeyframes } from './referenceTools.js';
import { validateReferenceCoverage, runReferenceRetargetFlow } from './referenceCoverage.js';
import { adjustMotion } from './motionAdjustmentTools.js';
import { getWorkspaceInfo, listWorkspaces, registerWorkspace, selectWorkspace, getWorkspaceContext, runInWorkspace,setWorkspaceRoots } from "./workspaceTools.js";
import { createProject } from './projectModel.js';
import { createProjectSchema } from './projectSchema.js';
import { poseOperationProperties, poseOperationArguments, validatePoseOperationArguments } from './animationCommands.js';
import { hostToolDefinitions, callHostTool, versionSchema } from './hostTools.js';
import { hostClient } from './hostClient.js';
import { isHostPoseCommand } from './hostPoseCommands.js';
import { isHostAssetCommand } from './hostAssetCommands.js';
import { readWriter } from './writerOwnership.js';
import { HostError, hostFailure } from './hostContracts.js';
import { runTask,checkpoint } from './taskControl.js';
import { listResources,readResource,resourceTemplates,prompts,getPrompt } from './resources.js';
import { getWorkspaceTree } from './workspaceTree.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ToolError } from './toolError.js';
import { frameInputSchema, posePatchInputSchema, weaponInputSchema } from './poseSchemas.js';
import { checkEditorImport } from './editorImportAdvisory.js';
import { animationComparisonLayouts } from './animationAcceptancePolicy.js';
import { executeTask, taskToolDefinition } from './taskOrchestrator.js';
import { runtimeBuildIdentity } from './buildIdentity.js';
import { authoringDefinitions } from './authoringSchemas.js';
import { callAuthoringTool } from './authoringTools.js';

type ToolArgs = Record<string, any>;
const authoringProfile = process.env.SPINE_MCP_TOOL_PROFILE === 'authoring';
const authoringToolNames = new Set(authoringDefinitions.map(tool => tool.name));

const server = new Server(
  {
    name: "spine-json-mcp",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {listChanged:true},
      ...(authoringProfile ? {} : { resources:{subscribe:false,listChanged:false},prompts:{} }),logging:{},
    },
  },
);

const filePathProperty = {
  type: "string",
  description: "工作区根目录内的 Spine JSON 文件路径。",
};
const projectIdProperty = {
  type: "string",
  description: "工作区解析优先级：显式 projectId > 用户当前选择 > 客户端 roots > SPINE_MCP_WORKSPACE > cwd；roots 通知不覆盖用户选择。",
};

const writeProperties = {
  dryRun: { type: "boolean", default: true },
  expectedHash: { type: "string" },
  allowUnsupportedVersion: { type: "boolean", default: false },
};

const rangeProperty = {
  type: "object",
  properties: {
    start: { type: "number", minimum: 0 },
    end: { type: "number", minimum: 0 },
  },
};

const targetsProperty = {
  type: "array",
  items: {
    type: "object",
    properties: {
      targetType: { type: "string", enum: ["bone", "slot", "drawOrder", "draworder"] },
      names: { type: "array", items: { type: "string" } },
      timelines: { type: "array", items: { type: "string" } },
    },
    required: ["targetType"],
  },
};

const tools = [
  {
    name: "spine_agent_ping",
    description: "记录 Agent 身份与语义握手；历史握手不代表在线。连接绿灯由定期 MCP 协议 ping 判定。只写运行态记录，不写 Spine JSON。",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Agent 名称，例如 Codex、Claude Code、opencode。" },
        clientType: { type: "string", enum: ["codex", "claude-code", "opencode", "custom"], description: "Agent 客户端类型。" },
        clientVersion: { type: "string", description: "可选客户端版本。" },
        note: { type: "string", description: "可选备注。" },
      },
    },
  },
  {
    name: "spine_agent_get_connection_status",
    description: "读取 Agent 连接状态、最近握手、项目规则检测和 Codex/Claude Code/opencode 配置片段。只读，不写 Spine JSON。",
    inputSchema: {
      type: "object",
      properties: {
        clientType: { type: "string", enum: ["codex", "claude-code", "opencode", "custom"], description: "可选，只查看指定 Agent 类型。" },
      },
    },
  },
  {
    name: "spine_get_document_summary",
    description: "返回 Spine JSON 版本、文件哈希、顶层字段、数量统计，以及 V1 是否允许写入。",
    inputSchema: {
      type: "object",
      properties: { filePath: filePathProperty },
      required: ["filePath"],
    },
  },
  {
    name: "spine_check_editor_import",
    description: "§16 编辑器兼容性 advisory：回答「Spine 编辑器能否打开当前这些字节」，默认关闭，结果恒为非权威，不参与任何门禁。显式 enabled:true 且已配置环境变量 SPINE_EDITOR_CLI 才执行外部导入命令；未配置返回 unavailable（不是失败）。只读原名文件，唯一产物是 diagnostics 报告。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        filePath: filePathProperty,
        enabled: { type: "boolean", description: "默认 false。必须显式为 true 才会执行；不传则不探测也不启动外部程序。" },
        timeoutMs: { type: "number", description: "外部导入命令超时（毫秒），默认 60000；超时判 indeterminate，不构成文件结论。" },
        writeReport: { type: "boolean", description: "默认 true：把 advisory 报告写入 .spine-mcp/diagnostics/editor-import-advisory/。" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "spine_inspect_character",
    description: "读取角色的骨骼、插槽、动画和版本摘要，只读。适合在建立 mapping 前调用。",
    inputSchema: { type: "object", properties: { filePath: filePathProperty }, required: ["filePath"] },
  },
  {
    name: "spine_validate_mapping",
    description: "校验角色 mapping 文件，并检查其中引用的骨骼是否存在。只读。",
    inputSchema: { type: "object", properties: { filePath: filePathProperty, mappingPath: filePathProperty }, required: ["filePath", "mappingPath"] },
  },
  {
    name: "spine_create_mapping_draft",
    description: "根据 Agent 已确认的语义骨骼选择创建 draft mapping；默认 dryRun，不覆盖已有 mapping。",
    inputSchema: { type: "object", properties: { filePath: filePathProperty, mappingPath: filePathProperty, mapping: { type: "object" }, dryRun: { type: "boolean", default: true } }, required: ["filePath", "mappingPath", "mapping"] },
  },
  {
    name: "spine_calibrate_mapping",
    description: "使用官方 runtime 计算 mapping 的骨骼长度、根坐标和 rig 指纹，生成校准报告。",
    inputSchema: { type: "object", properties: { filePath: filePathProperty, mappingPath: filePathProperty, reportPath: filePathProperty, dryRun: { type: "boolean", default: true } }, required: ["filePath", "mappingPath"] },
  },
  {
    name: "spine_confirm_mapping",
    description: "记录 Agent 对 mapping 语义部位的确认，确认结果是后续真实动画写入的门禁。",
    inputSchema: { type: "object", properties: { filePath: filePathProperty, mappingPath: filePathProperty, confirmedBy: { type: "string" }, semanticChecks: { type: "array", items: { type: "string" } }, dryRun: { type: "boolean", default: true } }, required: ["filePath", "mappingPath", "confirmedBy", "semanticChecks"] },
  },
  {
    name: "spine_validate_motion",
    description: "校验角色无关的动作中间格式。只读。",
    inputSchema: { type: "object", properties: { motionPath: filePathProperty }, required: ["motionPath"] },
  },
  {
    name: "spine_retarget_motion",
    description: "使用角色 mapping 适配动作。detached 沿用原审查/写入流程；隔离 C2 attached 必须 expectedRevision 和当前已选择的同名 v2 motion，仅 dryRun 制作精确 4.1.24 拟合候选、完整报告及审查产物，返回准备令牌，不代表批准或写入授权。批准后另用 spine_host_commit intent:animation 提交；此入口不改源文件、mapping 或校准报告。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        mappingPath: filePathProperty,
        motionPath: filePathProperty,
        animation: { type: "string" },
        duration: { type: "number", exclusiveMinimum: 0 },
        atlasPath: { type: "string" },
        reviewToken: { type: "string" },
        rotationTolerance: { type: "number", minimum: 0 },
        translationTolerance: { type: "number", minimum: 0 },
        footContactTolerance: { type: "number", minimum: 0 },
        handTolerance: { type: "number", minimum: 0 },
        vertexTolerance: { type: "number", minimum: 0 },
        retargetMode: { type: 'string', enum: ['adaptive','strict'], default: 'adaptive', description: '重定向策略；adaptive 记录语义保留和几何适配，strict 保留完整数值门禁。' },
        workflowProfile: { type: 'string', enum: ['creative','adaptive-preview','production'], default: 'creative', description: '工作流用途：creative 快速创作；adaptive-preview 跨体型诊断；production 需要完整覆盖和正式证据。' },
        overwrite: { type: "boolean", default: false },
        ...writeProperties,
      },
      required: ["filePath", "mappingPath", "animation"],
    },
  },
  {
    name: "spine_extract_motion",
    description: "从已确认的参考角色动画提取角色无关的 v2 motion 文件；默认 dryRun，不写入文件。",
    inputSchema: { type: "object", properties: { filePath: filePathProperty, mappingPath: filePathProperty, animation: { type: "string" }, motionPath: filePathProperty, reportPath: filePathProperty, samples: { type: "integer", minimum: 3 }, loop: { type: "boolean" }, groundY: { type: "number" }, contactTolerance: { type: "number", minimum: 0 }, dryRun: { type: "boolean", default: true } }, required: ["filePath", "mappingPath", "animation", "motionPath"] },
  },
  {
    name: "spine_validate_motion_result",
    description: "验证已生成动画的语义锚点误差、脚底/手腕接触、首尾闭合、旋转跳变和 mesh 顶点偏差。",
    inputSchema: { type: "object", properties: { filePath: filePathProperty, mappingPath: filePathProperty, motionPath: filePathProperty, animation: { type: "string" }, duration: { type: "number", exclusiveMinimum: 0 }, footContactTolerance: { type: "number", minimum: 0 }, handTolerance: { type: "number", minimum: 0 }, vertexTolerance: { type: "number", minimum: 0 } }, required: ["filePath", "mappingPath", "motionPath", "animation"] },
  },
  {
    name: "spine_fit_animation_curves",
    description: "按误差阈值压缩骨骼关键帧，useCurves=true 时拟合三次贝塞尔；提供 atlasPath 后用官方 runtime 回读检查旋转、位移和顶点误差，超标自动收紧拟合或拒绝写入。默认 dryRun=true。",
    inputSchema: { type: "object", properties: { filePath: filePathProperty, animation: { type: "string" }, rotationTolerance: { type: "number", minimum: 0 }, translationTolerance: { type: "number", minimum: 0 }, useCurves: { type: "boolean", default: false }, ...writeProperties }, required: ["filePath", "animation"] },
  },
  {
    name: "spine_batch_retarget",
    description: "按 jobs JSON 逐个执行动作重定向；单个任务失败不会阻止其他任务，并返回成功、失败和错误信息。",
    inputSchema: { type: "object", properties: { jobPath: filePathProperty }, required: ["jobPath"] },
  },
  {
    name: "spine_get_official_spec_summary",
    description: "返回当前 MCP 内置的 Spine 官方 JSON 规范审查摘要、可写 timeline 规则和 4.1.24 字段适配说明。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "spine_get_skeleton_hierarchy",
    description: "返回骨骼树；可选返回 setup pose 的局部变换。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        includeSetupPose: { type: "boolean", default: false },
      },
      required: ["filePath"],
    },
  },
  {
    name: "spine_get_slots",
    description: "返回插槽绘制顺序、绑定骨骼、默认附件和显示属性。",
    inputSchema: {
      type: "object",
      properties: { filePath: filePathProperty },
      required: ["filePath"],
    },
  },
  {
    name: "spine_get_skins",
    description: "返回皮肤名称和附件摘要。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        includeAttachments: { type: "boolean", default: false },
      },
      required: ["filePath"],
    },
  },
  {
    name: "spine_get_animations",
    description: "返回动画名称、估算时长和时间线类型统计。",
    inputSchema: {
      type: "object",
      properties: { filePath: filePathProperty },
      required: ["filePath"],
    },
  },
  {
    name: "spine_get_animation_timelines",
    description: "返回指定动画的原始时间线和规范化摘要，可按目标类型和名称过滤。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        targetType: { type: "string", enum: ["bone", "slot", "drawOrder", "draworder"] },
        targetName: { type: "string" },
      },
      required: ["filePath", "animation"],
    },
  },
  {
    name: "spine_get_animation_sheet",
    description: "返回适合 Agent 编辑的关键帧表格，包含目标、时间线、时间、值、曲线和 JSON path。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        targetType: { type: "string", enum: ["bone", "slot", "drawOrder", "draworder"] },
        targetName: { type: "string" },
      },
      required: ["filePath", "animation"],
    },
  },
  {
    name: "spine_create_animation",
    description: "新建空动画。默认不覆盖已有动画。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        overwrite: { type: "boolean", default: false },
        ...writeProperties,
      },
      required: ["filePath", "animation"],
    },
  },
  {
    name: "spine_clone_animation",
    description: "复制一个已有动画，作为后续编辑模板。默认不覆盖目标动画。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        sourceAnimation: { type: "string" },
        targetAnimation: { type: "string" },
        overwrite: { type: "boolean", default: false },
        ...writeProperties,
      },
      required: ["filePath", "sourceAnimation", "targetAnimation"],
    },
  },
  {
    name: "spine_delete_animation",
    description: "删除动画。高风险操作，必须显式传 confirm: true。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        confirm: { type: "boolean", default: false },
        ...writeProperties,
      },
      required: ["filePath", "animation", "confirm"],
    },
  },
  {
    name: "spine_set_bone_keyframe",
    description: "为已有动画中的已有骨骼插入或更新 rotate/translate/scale/shear 关键帧。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        bone: { type: "string" },
        timeline: { type: "string", enum: ["rotate", "translate", "scale", "shear"] },
        time: { type: "number", minimum: 0 },
        value: {
          anyOf: [
            { type: "number" },
            {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
              },
            },
          ],
        },
        curve: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "number" }, minItems: 4 },
          ],
        },
        ...writeProperties,
      },
      required: ["filePath", "animation", "bone", "timeline", "time", "value"],
    },
  },
  {
    name: "spine_set_slot_attachment_keyframe",
    description: "插入或更新插槽附件关键帧。attachmentName 为 null 表示隐藏附件。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        slot: { type: "string" },
        time: { type: "number", minimum: 0 },
        attachmentName: { anyOf: [{ type: "string" }, { type: "null" }] },
        ...writeProperties,
      },
      required: ["filePath", "animation", "slot", "time", "attachmentName"],
    },
  },
  {
    name: "spine_set_draw_order_keyframe",
    description: "使用官方 draw order offsets 结构插入或更新绘制顺序关键帧。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        time: { type: "number", minimum: 0 },
        offsets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              slot: { type: "string" },
              offset: { type: "number" },
            },
            required: ["slot", "offset"],
          },
        },
        ...writeProperties,
      },
      required: ["filePath", "animation", "time", "offsets"],
    },
  },
  {
    name: "spine_shift_keyframes",
    description: "将指定动画、时间范围和目标过滤器内的关键帧整体前后平移。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        range: rangeProperty,
        targets: targetsProperty,
        deltaTime: { type: "number" },
        ...writeProperties,
      },
      required: ["filePath", "animation", "deltaTime"],
    },
  },
  {
    name: "spine_scale_keyframe_times",
    description: "以 originTime 为原点压缩或拉伸指定关键帧的时间。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        range: rangeProperty,
        originTime: { type: "number", minimum: 0 },
        scale: { type: "number", exclusiveMinimum: 0 },
        targets: targetsProperty,
        ...writeProperties,
      },
      required: ["filePath", "animation", "originTime", "scale"],
    },
  },
  {
    name: "spine_delete_keyframe_range",
    description: "删除某段时间范围内的关键帧，可按骨骼、插槽或绘制顺序过滤。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        range: rangeProperty,
        targets: targetsProperty,
        ...writeProperties,
      },
      required: ["filePath", "animation", "range"],
    },
  },
  {
    name: "spine_copy_keyframe_range",
    description: "把一个动画片段复制到另一个动画或同一动画的指定时间点。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        sourceAnimation: { type: "string" },
        targetAnimation: { type: "string" },
        sourceRange: rangeProperty,
        targetStartTime: { type: "number", minimum: 0 },
        targets: targetsProperty,
        ...writeProperties,
      },
      required: ["filePath", "sourceAnimation", "targetAnimation", "sourceRange", "targetStartTime"],
    },
  },
  {
    name: "spine_apply_pose_keyframes",
    description: "在同一时间点批量设置多个骨骼和插槽的姿态关键帧。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        time: { type: "number", minimum: 0 },
        bones: { type: "object" },
        slots: { type: "object" },
        curve: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "number" }, minItems: 4 },
          ],
        },
        ...writeProperties,
      },
      required: ["filePath", "animation", "time"],
    },
  },
  {
    name: "spine_apply_pose_sequence",
    description: "一次性创建或覆盖动画，并批量写入多个姿态时间点；适合减少多次写入、备份和审查调用。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        overwrite: { type: "boolean", default: false },
        duration: { type: "number", minimum: 0 },
        closeLoop: { type: "boolean", default: false },
        poses: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              time: { type: "number", minimum: 0 },
              bones: { type: "object" },
              slots: { type: "object" },
              curve: {
                anyOf: [
                  { type: "string" },
                  { type: "array", items: { type: "number" }, minItems: 4 },
                ],
              },
            },
            required: ["time"],
          },
        },
        ...writeProperties,
      },
      required: ["filePath", "animation", "poses"],
    },
  },
  {
    name: "spine_offset_bone_timeline_values",
    description: "批量调整骨骼时间线数值，可增加偏移或按比例缩放。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        bones: { type: "array", items: { type: "string" } },
        timeline: { type: "string", enum: ["rotate", "translate", "scale", "shear"] },
        range: rangeProperty,
        offset: {
          anyOf: [
            { type: "number" },
            { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
          ],
        },
        scale: {
          anyOf: [
            { type: "number" },
            { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
          ],
        },
        ...writeProperties,
      },
      required: ["filePath", "animation", "bones", "timeline"],
    },
  },
  {
    name: "spine_make_loop",
    description: "把 sourceTime 的已有关键帧复制到 targetTime，用于让循环动画首尾闭合。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        sourceTime: { type: "number", minimum: 0 },
        targetTime: { type: "number", minimum: 0 },
        targets: targetsProperty,
        ...writeProperties,
      },
      required: ["filePath", "animation", "sourceTime", "targetTime"],
    },
  },
  {
    name: "spine_remove_keyframe",
    description: "按时间从骨骼、插槽或绘制顺序时间线中删除关键帧。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        animation: { type: "string" },
        targetType: { type: "string", enum: ["bone", "slot", "drawOrder", "draworder"] },
        targetName: { type: "string" },
        timeline: { type: "string" },
        time: { type: "number", minimum: 0 },
        ...writeProperties,
      },
      required: ["filePath", "animation", "targetType", "timeline", "time"],
    },
  },
  {
    name: "spine_validate_json",
    description: "校验结构、版本、引用关系、关键帧排序和插槽附件引用。",
    inputSchema: {
      type: "object",
      properties: { filePath: filePathProperty },
      required: ["filePath"],
    },
  },
  {
    name: "spine_preview_get_config",
    description: "返回浏览器预览层默认配置、官方 runtime 版本和 URL 参数说明。只读，不写入 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", description: "可选预览服务地址，默认 http://127.0.0.1:5177。" },
      },
    },
  },
  {
    name: "spine_preview_check_assets",
    description: "检查预览所需的 JSON、atlas 和贴图；显式文件省略 animation 时仅检查资源，提供动画名才检查其存在。只读，不写入 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        atlasPath: { type: "string", description: "工作区根目录内的 Spine atlas 文件路径。" },
        animation: { type: "string", description: "可选目标动画名；显式文件省略时不检查动画，不使用示例动画。" },
      },
    },
  },
  {
    name: "spine_preview_get_url",
    description: "生成浏览器预览 URL；显式文件省略动画时不注入示例动画，支持皮肤、PMA、Mipmaps 和自动载入。只读，不写入 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        atlasPath: { type: "string", description: "工作区根目录内的 Spine atlas 文件路径。" },
        animation: { type: "string" },
        skin: { type: "string" },
        speed: { type: "number" },
        premultipliedAlpha: { type: "boolean" },
        mipmaps: { type: "boolean" },
        autoload: { type: "boolean" },
        baseUrl: { type: "string", description: "可选预览服务地址，默认 http://127.0.0.1:5177。" },
      },
    },
  },
  {
    name: "spine_runtime_validate",
    description: "使用官方 spine-core runtime 读取 JSON、atlas 和附件数据，验证资源是否能被当前 4.1 runtime 加载。只读，不写入 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        atlasPath: { type: "string", description: "工作区根目录内的 Spine atlas 文件路径。" },
        animation: { type: "string", description: "可选目标动画名；显式文件省略时只验证资源/皮肤加载，提供后检查 runtime 是否找到该动画。" },
        skin: { type: "string", description: "可选目标皮肤名；会检查 runtime 是否能找到该皮肤。" },
        scale: { type: "number", exclusiveMinimum: 0, description: "可选读取缩放，默认使用 runtime 的 1。" },
      },
    },
  },
  {
    name: "spine_run_validation_pipeline",
    description: "执行只读结构校验、官方 runtime 加载和预览 URL 生成；显式文件省略动画时不采样动画或生成联系图。不写入 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        atlasPath: { type: "string", description: "工作区根目录内的 Spine atlas 文件路径。" },
        animation: { type: "string", description: "目标动画名；会用于 runtime 验证和预览 URL。" },
        skin: { type: "string", description: "可选目标皮肤名。" },
        scale: { type: "number", exclusiveMinimum: 0, description: "可选 runtime 读取缩放。" },
        speed: { type: "number", description: "可选预览播放速度。" },
        premultipliedAlpha: { type: "boolean", description: "可选预览预乘 Alpha 设置。" },
        mipmaps: { type: "boolean", description: "可选预览 Mipmaps 设置。" },
        autoload: { type: "boolean", description: "预览链接打开后是否自动载入。" },
        baseUrl: { type: "string", description: "可选预览服务地址，默认 http://127.0.0.1:5177。" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "spine_list_backups",
    description: "列出 backups/ 中的 Spine JSON 备份，可按目标 filePath 过滤，并可校验备份 JSON 是否可用。只读，不写入 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "可选目标 Spine JSON 路径；传入后只列出该文件对应的备份。" },
        includeValidation: { type: "boolean", default: true, description: "是否对每个备份执行结构校验，默认 true。" },
      },
    },
  },
  {
    name: "spine_restore_backup",
    description: "将 backups/ 中的指定备份恢复到目标 JSON 文件。高风险操作，必须 confirm:true；默认 dryRun:true；真实恢复前会先备份当前目标文件。",
    inputSchema: {
      type: "object",
      properties: {
        backupPath: { type: "string", description: "工作区 backups/ 目录内的备份文件路径，例如 backups/skeleton-4.1.xxx.json。" },
        targetFilePath: filePathProperty,
        dryRun: { type: "boolean", default: true },
        expectedHash: { type: "string", description: "可选目标文件当前 hash，用于防止覆盖意外变化。" },
        confirm: { type: "boolean", default: false, description: "必须显式传 true 才允许执行 dryRun 或真实恢复。" },
      },
      required: ["backupPath", "targetFilePath", "confirm"],
    },
  },
  {
    name: "spine_preview_set_session",
    description: "设置 Agent 驱动的预览会话状态，让 WinForms 或浏览器预览层自动知道当前 JSON、atlas、动画和操作说明。只写会话状态，不写 Spine JSON。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        atlasPath: { type: "string", description: "工作区根目录内的 Spine atlas 文件路径。" },
        animation: { type: "string" },
        skin: { type: "string" },
        speed: { type: "number" },
        premultipliedAlpha: { type: "boolean" },
        mipmaps: { type: "boolean" },
        autoload: { type: "boolean" },
        operation: {
          type: "object",
          description: "当前 Agent 操作说明，例如 title/status/detail/toolName/dryRun。",
        },
        log: {
          type: "object",
          description: "可选追加一条控制台日志，字段为 level/message/toolName。",
        },
      },
    },
  },
  {
    name: "spine_preview_get_session",
    description: "读取当前 Agent 驱动的预览会话状态，并返回对应预览 URL。只读，不写入 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", description: "可选预览服务地址，默认 http://127.0.0.1:5177。" },
      },
    },
  },
  {
    name: "spine_preview_clear_session",
    description: "清空当前预览会话状态，恢复默认 JSON、atlas 和动画。只写会话状态，不写 Spine JSON。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "spine_render_animation_frames",
    description: "使用官方 spine-core 采样动画并生成固定相机的 PNG 贴图帧和 preview manifest。默认只读，不修改 Spine JSON。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: filePathProperty, atlasPath: { type: "string" }, animation: { type: "string" }, skin: { type: "string" }, mappingPath: filePathProperty, visualRigPath: filePathProperty, fps: { type: "integer", minimum: 1 }, frames: { type: "integer", minimum: 2 }, width: { type: "integer", minimum: 32 }, height: { type: "integer", minimum: 32 }, background: { type: "string" }, outputDir: { type: "string" }, jobId: { type: "string" } }, required: ["filePath", "atlasPath", "animation"] },
  },
  {
    name: "spine_render_contact_sheet",
    description: "生成固定相机的 contact sheet 和逐姿态 PNG 贴图帧，适合 Agent 低 token 视觉检查。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: filePathProperty, atlasPath: { type: "string" }, animation: { type: "string" }, fps: { type: "integer", minimum: 1 }, frames: { type: "integer", minimum: 2 }, width: { type: "integer", minimum: 32 }, height: { type: "integer", minimum: 32 }, columns: { type: "integer", minimum: 1 }, outputDir: { type: "string" }, jobId: { type: "string" } }, required: ["filePath", "atlasPath", "animation"] },
  },
  {
    name: "spine_render_animation_gif",
    description: "离线生成动画 GIF，固定相机、官方 runtime 姿态和 PNG 帧复用缓存。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: filePathProperty, atlasPath: { type: "string" }, animation: { type: "string" }, mappingPath: filePathProperty, visualRigPath: filePathProperty, fps: { type: "integer", minimum: 1 }, frames: { type: "integer", minimum: 2 }, outputDir: { type: "string" }, jobId: { type: "string" } }, required: ["filePath", "atlasPath", "animation"] },
  },
  {
    name: "spine_create_preview_manifest",
    description: "记录 JSON/atlas hash、runtime、采样、画布和固定相机参数，供缓存和审计使用。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: filePathProperty, atlasPath: { type: "string" }, animation: { type: "string" }, mappingPath: filePathProperty, visualRigPath: filePathProperty, fps: { type: "integer", minimum: 1 }, frames: { type: "integer", minimum: 2 }, width: { type: "integer", minimum: 32 }, height: { type: "integer", minimum: 32 } }, required: ["filePath", "atlasPath", "animation"] },
  },
  {
    name: "spine_compare_animation_previews",
    description: "生成并排图、叠加图和归一化语义轨迹报告；像素差异须同贴图同相机。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, firstManifestPath: filePathProperty, secondManifestPath: filePathProperty }, required: ["firstManifestPath", "secondManifestPath"] },
  },
  {
    name: "spine_list_workspaces",
    description: "列出已登记的 projectId 工作区和当前活动项目。只读。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spine_register_workspace",
    description: "登记 Agent 项目工作区并生成 projectId；后续工具可使用 projectId 访问该工作区。",
    inputSchema: { type: "object", properties: { rootPath: { type: "string" }, projectId: { type: "string" }, source: { type: "string", enum: ["explicit", "root"] } }, required: ["rootPath"] },
  },
  {
    name: "spine_get_workspace_info",
    description: "只读返回当前或指定工作区及工程清单状态；区分 legacy、managed、unsupported，不自动初始化或恢复批准。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
  },
  {
    name: "spine_select_workspace",
    description: "选择已登记的 projectId 作为当前活动工作区。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
  },
  {
    name: 'spine_create_project',
    description: '显式初始化工作区根 .spine-workflow.json。先登记工作区；默认 dryRun，只读验证资源与文档绑定并返回候选及 hash。expectedAbsent 必须为 true，已有清单禁止覆盖，不修改角色资源或批准状态。',
    inputSchema: createProjectSchema,
  },
];

const auxiliaryTools = [
  { name:'spine_validate_reference_coverage', description:'校验参考 GIF、动作级 sequence 与已审查 reference pose 的覆盖关系；只报告哪些帧/阶段可用，不把未标注帧伪装成完整动作。', inputSchema:{type:'object',properties:{referenceGifPath:filePathProperty,sequencePath:filePathProperty,reportPath:filePathProperty,dryRun:{type:'boolean',default:true}},required:['referenceGifPath','sequencePath']}},
  { name:'spine_run_reference_retarget_flow', description:'一条高层指令编排参考重定向：核对输入哈希和阶段覆盖，逐阶段生成目标角色 expected target；coverage 完整时继续自动生成 motion、目标 runtime 候选、原速 GIF 和同步动态对比 GIF。production 会在覆盖不完整或语义硬约束失败时明确暂停；adaptive-preview 只生成已审查阶段诊断，不把未标注帧插值成完整动作。全流程只产出隔离候选和证据，不绕过 Host 写入或正式人工审查。默认 dryRun。', inputSchema:{type:'object',properties:{referenceGifPath:filePathProperty,sequencePath:filePathProperty,standardPosePath:filePathProperty,visualRigPath:filePathProperty,targetCharacterPath:filePathProperty,mappingPath:filePathProperty,animation:{type:'string'},duration:{type:'number',exclusiveMinimum:0},previewFrames:{type:'integer',minimum:2,maximum:240,default:60},targetTimeByStage:{type:'object',additionalProperties:{type:'number'}},retargetMode:{type:'string',enum:['adaptive','strict'],default:'adaptive'},workflowProfile:{type:'string',enum:['creative','adaptive-preview','production'],default:'adaptive-preview'},diagnosticPreview:{type:'boolean',default:true},outputDir:filePathProperty,dryRun:{type:'boolean',default:true}},required:['referenceGifPath','sequencePath','standardPosePath','visualRigPath']}} ,
  {name:'spine_analyze_reference_parts',description:'优先分析可靠刚性轮廓与误差圆；遮挡或增强观测不足时回退两个既有节点连线，给出 estimated 方向和来源。ok 表示可用观测而非动作批准；节点未知不编造，可靠证据冲突仍复核。dryRun:false 只新建报告。',inputSchema:{type:'object',properties:{referencePosePath:filePathProperty,reportPath:filePathProperty,dryRun:{type:'boolean',default:true}},required:['referencePosePath']}},
  { name: 'spine_set_curve', description: '仅调整已有骨骼关键帧曲线；最后一帧禁止 curve；null 表示移除曲线。默认 dryRun，沿用备份和 diff 门禁。', inputSchema: { type: 'object', properties: { filePath: filePathProperty, animation: { type: 'string' }, bone: { type: 'string' }, timeline: { type: 'string', enum: ['rotate','translate','scale','shear'] }, time: { type: 'number', minimum: 0 }, curve: { anyOf: [{ type: 'string', enum: ['stepped'] }, { type: 'array', items: { type: 'number' } }, { type: 'null' }] }, ...writeProperties }, required: ['filePath','animation','bone','timeline','time','curve'] } },
  { name: 'spine_get_preview_report', description: '读取预览报告；默认返回摘要，需要轨迹时设置 detailed:true。', inputSchema: { type: 'object', properties: { manifestPath: filePathProperty, detailed: { type: 'boolean' } }, required: ['manifestPath'] } },
  { name: 'spine_analyze_reference_gif', description: '离线拆分参考 GIF，读取帧延迟、重复帧、循环扩展、统一画布和运动候选；阶段由 Agent 显式标注。candidateMode:keypose 只生成基于变化曲线的待审查候选，不自动批准姿态或阶段。', inputSchema: { type: 'object', properties: { filePath: filePathProperty, outputDir: filePathProperty, fallbackDelay: { type: 'number', minimum: 10 }, loop: { type: 'boolean' }, columns: { type: 'integer', minimum: 1, maximum: 12 }, maxTiles: { type: 'integer', minimum: 1, maximum: 32 }, candidateMode: { type: 'string', enum: ['uniform','keypose'] }, candidateCount: { type: 'integer', minimum: 2, maximum: 32 }, minCandidateGap: { type: 'integer', minimum: 1 }, phases: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, phase: { type: 'string' } }, required: ['time','phase'] } } }, required: ['filePath'] } },
  { name: 'spine_extract_reference_keyframes', description: '从参考 manifest 中提取代表帧或 KEYPOSE 候选。keypose 模式结合均匀覆盖、速度局部极小和方向转折，只输出待审查候选，不自动生成 IK 数据或批准阶段。', inputSchema: { type: 'object', properties: { manifestPath: filePathProperty, count: { type: 'integer', minimum: 2, maximum: 32 }, candidateMode: { type: 'string', enum: ['uniform','keypose'] }, minCandidateGap: { type: 'integer', minimum: 1 }, columns: { type: 'integer', minimum: 1, maximum: 12 }, maxTiles: { type: 'integer', minimum: 1, maximum: 32 } }, required: ['manifestPath'] } },
  ...['spine_set_foot_target','spine_lock_foot_contact','spine_set_hand_target','spine_adjust_body_motion','spine_adjust_step_length','spine_adjust_arm_swing'].map(name => ({ name, description: '修改角色无关 v2 motion 的目标或幅度，默认 dryRun；下一步重定向自动重算相关 IK、约束和曲线。', inputSchema: { type: 'object', properties: { motionPath: filePathProperty, outputMotionPath: filePathProperty, side: { type: 'string', enum: ['left','right'] }, time: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, angle: { type: 'number' }, contact: { type: 'boolean' }, factor: { type: 'number', exclusiveMinimum: 0 }, bodyBob: { type: 'number' }, sway: { type: 'number' }, dryRun: { type: 'boolean', default: true } }, required: ['motionPath','outputMotionPath'] } }))
];
const poseToolDefinitions = [
 ['spine_calibrate_visual_rig','校准视觉关节与实际骨骼、切片绑定，输出角色、切片分解和节点图；原点候选不能自动确认。',calibrateVisualRig,['filePath','mappingPath','visualRigPath']],
 ['spine_review_visual_rig','确认校准后的视觉绑定及图像证据；角色资源变化后失效。',reviewVisualRig,['visualRigPath','decision','reviewedBy','reason']],
 ['spine_validate_pose_sequence','校验动作级左右身份、阶段、参考指纹与视角能力；旧交换对应不能混用。',validatePoseSequence,['sequencePath']],
 ['spine_refine_reference_pose','依最新静态比较最多 60 次局部修正。隔离 C2 attached 需完整 expectedRevision，仅用当前内存和当前比较；成功时 false 暂存新草稿，另用 Host asset 保存，失败仅诊断。',refineReferencePose,['posePath','outputPosePath']],
 ['spine_retarget_reference_pose','按已审查参考及动作级身份适配。隔离 C2 attached 需完整 expectedRevision；成功时暂存新资产。失败默认报告，显式 diagnosticMode:newStage 可预演/打开独立内存阶段，源绑定不变；未知必要点只保留部分诊断。失败无保存授权，仍需独立视觉审查。',retargetReferencePose,['referencePosePath','visualRigPath','standardPosePath','posePath']],
 ['spine_generate_reference_retarget_target','按 approved reference、动作级 stageId 和目标角色绑定，生成单阶段 expected target manifest；拒绝 rejected reference；只生成 kernel expected target，不读取候选动画，不冒充 runtime actual target。diagnosticPreview:true 且 dryRun:true 时，即使语义或 IK 未通过也生成带 referenceGifHash、失败约束、覆盖阶段和 GIF 路径的只读诊断证据；不产生提交令牌。',generateReferenceRetargetTarget,['referencePosePath','visualRigPath','standardPosePath','sequencePath','stageId','targetTime']],
 ['spine_compare_pose_graphs','比较参考与 runtime 实际视觉节点，各指标独立通过；未知必要点不允许确认。',comparePoseGraphs,['posePath']],
 ['spine_create_reference_pose','先标注参考图像的头身和四肢关节；遮挡点需声明推测，未知点不得伪造。',createReferencePose,['referencePosePath','observation']],
 ['spine_render_reference_pose_sheet','生成上原图下参考节点连线的审查图，每页六列；实线可见、虚线推测。',renderReferencePoseSheet,['referencePosePaths','outputDir']],
 ['spine_review_reference_pose','先审查参考标注与图像证据，再允许适配目标姿态。',reviewReferencePose,['referencePosePath','manifestPath','decision','reviewedBy','reason','checks']],
 ['spine_upgrade_reference_pose','把 v1 参考升级为 v2 骨架并列出待补字段；不自动编造面部朝向、轮廓或前后依据。',upgradeReferencePose,['referencePosePath','outputReferencePosePath']],
 ['spine_get_pose_state','只读勘察：返回当前 frame、求解后的关节/屈曲/头盒，以及各指标状态摘要；不写报告。',getPoseState,['posePath']],
 ['spine_recheck_pose','显式重算当前姿态的数值和关系摘要，不修改资产；附着时使用当前内存快照并发布派生结果。',(a:any,c:any)=>getPoseState({...a,recheck:true},c),['posePath']],
 ['spine_explain_pose','按指标逐项说明未通过原因与可调旋钮；明确标注不可调项。',explainPose,['posePath']],
 ['spine_set_pose_target','只改一个末端目标。detached 需 outputPosePath 新修订；隔离 C2 attached 需 expectedRevision、不得给输出路径，只修改 Host 内存 x/y/angle，不改 contact。',setPoseTarget,['posePath','role']],
 ['spine_set_pose_channel','修改声明通道 rotate/x/y。detached 需 outputPosePath；隔离 C2 attached 需 expectedRevision、不得给输出路径，原子修改内存并清除旧批准。',setPoseChannel,['posePath','name']],
 ['spine_batch_pose_ops','一次应用姿态命令。detached 需 outputPosePath，可用原 target/channel/weapon 和对比图；隔离 C2 attached 需 expectedRevision、不得给输出路径，仅 target/channel 原子批次并返回当前帧。',batchPoseOps,['posePath','ops']],
 ['spine_create_pose_draft','创建标准站姿或动作关键姿态，默认 dryRun；action 需已确认标准站姿。隔离 C2 attached 必须完整 expectedRevision，false 仅暂存候选，保存另用 Host commit 的 asset 意图。',createPoseDraft,['filePath','mappingPath','posePath','kind']],
 ['spine_solve_pose','复用官方 runtime 求解单姿态，检查可达性、关节方向与站姿膝部屈曲；不写角色 JSON。',solvePose,['posePath']],
 ['spine_adjust_pose','批量修改姿态参数。detached 需 outputPosePath 新修订；隔离 C2 attached 需 expectedRevision、不得给输出路径，仅修改当前内存已开放的 frame 参数，保存另用 spine_host_commit。',adjustPose,['posePath','patch']],
 ['spine_render_pose_comparison','按指定关键姿态生成上参考下目标的干净图、诊断图；每页最多六列，固定比例地面线。',renderPoseComparison,['posePaths']],
 ['spine_review_pose','审查具体姿态；附着时必须带 expectedRevision，使用当前官方 player manifest，默认只预演；批准需数值、参考比较与逐项视觉理由。',reviewPose,['posePath','manifestPath','decision','reviewedBy','reason','checks']],
 ['spine_build_motion_from_poses','从已确认站姿与关键姿态生成 v2 motion。隔离 C2 attached 必须完整 expectedRevision，false 仅暂存候选；引用当前姿态前须保存批准，保存 motion 另用 Host commit 的 asset 意图。',buildMotionFromPoses,['standardPosePath','keyPoses','motionPath','name','duration']],
 ['spine_review_animation','审查完整候选动画 GIF，绑定关键姿态和证据。隔离 attached 必须完整 expectedRevision；批准还须当前 playerManifestPath 和五项独立 checkResults。返回视觉批准令牌，源写入另走 Host animation commit。',reviewAnimation,['reviewToken','manifestPath','decision','reviewedBy','reason','checks']],
 ['spine_render_animation_comparison','按严格递增阶段对应生成同步对比 GIF，同时保留目标原速 GIF；沿用姿态图相机。layout 默认 reference-above-target（上参考下目标），可选 overlay 把目标半透明叠在参考之上（opacity 控制不透明度），可选 skeleton 把参考关节点骨架与目标逐帧骨架叠在同一画布（默认 diagnostic，可部分映射并明确标注；formal 需已确认 visualRig、完整映射和可用 metrics）；times 可只输出指定时间点；metrics 输出 compareGraphs 结构指标摘要，只作证据不自动判定。',renderAnimationComparison,['targetManifestPath','referenceManifestPath','poseManifestPath','phaseMap']],
] as const;
const poseProperties:any={projectId:projectIdProperty,dryRun:{type:'boolean',default:true}};
poseProperties.layout={type:'string',enum:[...animationComparisonLayouts],default:'reference-above-target',description:'同步对比布局：reference-above-target 上参考下目标；overlay 把目标半透明叠在参考之上；skeleton 把参考关节点骨架与目标逐帧骨架叠在同一画布（只看关节偏差，不看外观像素）。'};
poseProperties.opacity={type:'number',minimum:0.1,maximum:1,default:0.6,description:'overlay 布局下目标帧的不透明度。'};
poseProperties.times={type:'array',items:{type:'number',minimum:0},description:'只输出指定时间点（秒）的对比帧，按最接近的已渲染采样帧取用；不给则整段输出。skeleton 布局配合 times 可只出单帧做快速迭代。'};
poseProperties.visualRigPath=filePathProperty;
poseProperties.metrics={type:'boolean',default:true,description:'skeleton 布局下输出 compareGraphs 结构指标摘要（逐选中帧）；取不到 correspondence 或语义映射时输出 null 与原因，不编造、不自动判定。'};
poseProperties.correspondence={type:'object',description:'skeleton 布局的显式左右对应声明（left/right/basis/anatomicalIdentity/projectedOrder）；不从 manifest 猜测，缺省时 metrics 输出不可用原因。'};
poseProperties.targetFacing={type:'string',enum:['left','right'],description:'skeleton 布局下目标骨架朝向；必须显式提供，不把 reference.facing 当作目标朝向。'};
poseProperties.acceptanceMode={type:'string',enum:['diagnostic','formal'],default:'diagnostic',description:'skeleton 布局的用途：diagnostic 允许部分映射并只生成诊断图；formal 要求已确认 visualRig、完整语义映射和可用 metrics，供正式审查前置校验。'};
poseProperties.diagnosticMode={type:'string',enum:['report','newStage'],default:'report',description:'newStage 仅限隔离 C2 attached：参考失败时预演或显式打开独立内存阶段，不改变原文档绑定；默认 report 保持原诊断行为。'};
poseProperties.retargetMode={type:'string',enum:['adaptive','strict'],default:'adaptive',description:'重定向策略：adaptive 按目标角色自身比例优先保持语义并记录几何适配；strict 保留完整结构门禁。旧资产缺少此字段时按 strict 复核。'};
poseProperties.workflowProfile={type:'string',enum:['creative','adaptive-preview','production'],default:'creative',description:'工作流用途：creative 快速创作；adaptive-preview 跨体型诊断；production 需要完整覆盖和正式证据。'};
poseProperties.headFromReference={type:'boolean',default:false,description:'仅在已确认面部锚点可用时从参考适配头部方向。'};
poseProperties.weaponFromReference={type:'boolean',default:false,description:'按已确认参考握轴生成假想杆；不替代实际握持审查。'};
poseProperties.expectedRevision=versionSchema;
poseProperties.recheck={type:'boolean',default:false,description:'只读查询默认不求解；true 显式重新求解/比较，不写报告。'};
for(const k of ['filePath','mappingPath','posePath','outputPosePath','outputPath','standardPosePath','manifestPath','playerManifestPath','motionPath','outputDir','targetManifestPath','referenceManifestPath','poseManifestPath','retargetManifestPath','referencePosePath','outputReferencePosePath','visualRigPath','comparisonPath','candidatePath','reportPath','sequencePath','referenceGifPath','diagnosticOutputDir'])poseProperties[k]=filePathProperty;
Object.assign(poseProperties,{anatomicalSides:{type:'object',description:'解剖 left/right 绑定目标 left/right 语义链；basis 必填，纳入 visualRig 确认指纹。'},viewProfiles:{type:'array',items:{type:'object'},description:'身体视角的已校准切片状态配置：bodyView/attachments/bodySlots/basis。未配置视角不能靠标签批准。'},detailed:{type:'boolean',default:false,description:'默认返回节点和切片摘要，完整顶点/权重保存在报告中。'},nodes:{type:'object',description:'视觉锚点：boneLocal 或 meshTriangle，须 calibrated:true 和 basis。'},segments:{type:'object',description:'leftArm.0/1、rightArm.0/1、leftLeg.0/1、rightLeg.0/1：nodes/bones/attachments。'},correspondence:{type:'object',description:'目标 left/right 对应参考 left/right；basis、anatomicalIdentity、projectedOrder 必须明确。'},checkResults:{type:'object',description:'每个检查项独立 status:pass 和具体 reason。'},stageId:{type:'string'},animation:{type:'string'},time:{type:'number',minimum:0}});
Object.assign(poseProperties,{diagnosticPreview:{type:'boolean',default:false,description:'仅 dryRun：失败时生成诊断候选和 GIF，不产生提交令牌或角色写入。'},referenceGifHash:{type:'string',pattern:'^[0-9a-f]{64}$',description:'诊断 GIF 绑定的参考 GIF SHA-256。'},referencePoseHash:{type:'string',pattern:'^[0-9a-f]{64}$',description:'已审查参考姿态指纹，用于诊断输入绑定核对。'},sequenceHash:{type:'string',pattern:'^[0-9a-f]{64}$',description:'动作级 sequence 原始内容指纹，用于诊断输入绑定核对。'},visualRigHash:{type:'string',pattern:'^[0-9a-f]{64}$',description:'目标 visualRig 指纹，用于诊断输入绑定核对。'},mappingHash:{type:'string',pattern:'^[0-9a-f]{64}$',description:'目标 mapping 指纹，用于诊断输入绑定核对。'},targetCharacterHash:{type:'string',pattern:'^[0-9a-f]{64}$',description:'目标 Spine 角色结构指纹，用于诊断输入绑定核对。'}});
for(const k of ['name','id','reviewedBy','reason','thresholdReason','reviewToken'])poseProperties[k]={type:'string'};
Object.assign(poseProperties,{role:{type:'string',enum:['leftHand','rightHand','leftFoot','rightFoot']},x:{type:'number'},y:{type:'number'},angle:{type:'number'},contact:{type:'boolean'},targetTime:{type:'number',minimum:0},ops:{type:'array',items:{type:'object'},description:'[{op:target,role,x,y,angle,contact} | {op:channel,name,rotate} | {op:weapon,weapon}]'},render:{type:'boolean',default:false},observation:{type:'object',description:'参考图像坐标 v2：含 head/face/body 与左右肩肘腕髋膝踝；另需 silhouette（肩线/髋线同高度可见外缘）、orientation（band/amplitude/basis）、depth（前后证据）。visibility/confidence/basis，遮挡坐标 estimated:true。'},face:{type:'object',description:'面部朝向锚点（建议鼻尖）；头身中心连线不能代替头部朝向。'},silhouette:{type:'object',description:'可见轮廓四点：shoulder.left/right、hip.left/right，与肩线/髋线同高度。'},orientation:{type:'object',description:'朝向相对幅度：band(front/threeQuarter/profile/back)、amplitude 0–1、basis；只作同序列相对量。'},depth:{type:'object',description:'前后证据 1–8 条：id/a/b/relation(front|back)/kind(occlusion|overlap|scale)/basis；目标侧用 drawOrder 回读。'},referencePosePaths:{type:'array',items:filePathProperty},region:{type:'array',items:{type:'number'},minItems:4,maxItems:4,description:'局部放大区域 [x,y,width,height]，相对单图像面板。'},targetTimes:{type:'array',items:{type:'number'}},stageIds:{type:'array',items:{type:'string'}},facing:{type:'string',enum:['left','right']},kind:{type:'string',enum:['standing','action']},decision:{type:'string',enum:['approved','rejected']},frame:{type:'object',description:'normalizedSkeleton 语义姿态：time/body/head/channels/targets/bendDirections；不是图像坐标。'},patch:{type:'object',description:'允许 frame/weapon/reference/groundY/policy，深合并。'},reference:{type:'object',description:'imagePath/time/facing/crop[x,y,width,height]/height/groundY/basis/points；points 含 visibility 和可见点 x/y。'},weapon:{type:'object',description:'二维假想杆 x/y/angle/grips.left/right；需 mapping 手部 gripPoint。'},posePaths:{type:'array',items:{type:'string'},minItems:1,maxItems:60},keyPoses:{type:'array',items:{type:'object',properties:{posePath:filePathProperty,time:{type:'number'},stageId:{type:'string'}},required:['posePath','time','stageId']}},phaseMap:{type:'array',items:{type:'object',properties:{targetTime:{type:'number'},referenceTime:{type:'number'}},required:['targetTime','referenceTime']}},checks:{type:'array',items:{type:'string'}},issues:{type:'array',items:{type:'string'}},loop:{type:'boolean'},duration:{type:'number',exclusiveMinimum:0},groundY:{type:'number'},kneeFlexionMax:{type:'number',minimum:0,maximum:180},width:{type:'integer'},height:{type:'integer'}});
poseProperties.observation.description+=' 可选 parts：leftArm.0/1、rightArm.0/1、leftLeg.0/1、rightLeg.0/1，含 source(rigidSlice|clothing|unknown)、有序 outline[{x,y}]、radius 像素误差及 basis；points 可声明 uncertaintyRadius，缺失不按零误差处理。';
tools.push(...poseToolDefinitions.map(([name,description,_fn,required])=>{
  const properties={...poseProperties,...poseOperationProperties[name]},allowed=poseOperationArguments[name];
  Object.assign(properties,{frame:frameInputSchema,patch:posePatchInputSchema,weapon:weaponInputSchema});
  if(name==='spine_review_pose'){
    properties.checks={type:'array',uniqueItems:true,minItems:poseChecks.length,maxItems:poseChecks.length,items:{type:'string',enum:poseChecks}};
    properties.checkResults={type:'object',additionalProperties:false,properties:Object.fromEntries(poseChecks.map(key=>[key,{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['pass','fail','unverifiable']},reason:{type:'string',minLength:1}},required:['status','reason']}]))};
    properties.expectedRevision={...versionSchema,description:'附着会话必填：当前完整版本。缺失或过期拒绝，不能按路径推断版本。'};
  }
  if(name==='spine_review_animation'){
    properties.checks={type:'array',uniqueItems:true,minItems:5,maxItems:5,items:{type:'string',enum:fullAnimationChecks}};
    properties.checkResults={type:'object',additionalProperties:false,properties:Object.fromEntries(fullAnimationChecks.map(key=>[key,{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['pass','fail','unverifiable']},reason:{type:'string',minLength:1}},required:['status','reason']}]))};
  }
  if(isHostPoseCommand(name))properties.expectedRevision={...versionSchema,description:'隔离 C2 attached 必填完整版本，并省略 outputPosePath；detached 则须 outputPosePath，不接受此版本参数。'};
  return{name,description,inputSchema:{type:'object',...(allowed?{additionalProperties:false}:{}),properties:allowed?Object.fromEntries(allowed.map(key=>[key,properties[key]])):properties,required:[...required],...(isHostPoseCommand(name)?{anyOf:[{required:['outputPosePath']},{required:['expectedRevision']}]}:{})}};
}) as any);
tools.push(...auxiliaryTools as any);
tools.push(...hostToolDefinitions as any);
tools.push(...creationToolDefinitions as any);
tools.push(...creationReferenceDefinitions as any);
tools.push(...catalogToolDefinitions as any);
tools.push(...creationControlDefinitions as any);
tools.push(taskToolDefinition as any);
tools.push(...authoringDefinitions as any);
tools.push(...armCalibrationToolDefinitions as any);
tools.push({name:'spine_get_workspace_tree',description:'有界只读工程树，忽略生成/凭据目录和链接；支持稳定分页，不执行求解。',inputSchema:{type:'object',additionalProperties:false,properties:{projectId:projectIdProperty,root:{type:'string'},depth:{type:'integer',minimum:0,maximum:6,default:3},maxEntries:{type:'integer',minimum:1,maximum:2000,default:500},pageSize:{type:'integer',minimum:1,maximum:500,default:500},cursor:{type:'string'},details:{type:'boolean',default:false},kinds:{type:'array',items:{type:'string'}}}}} as any);
for (const tool of tools) {
  const props = tool.inputSchema.properties as Record<string, any>;
  props.responseDetail={type:'string',enum:['summary','full'],default:'summary',description:'Host 常用返回默认摘要；full 读取完整数据，内部核验不受影响。'};
  props.projectId ??= projectIdProperty;
  if (!poseOperationArguments[tool.name]&&(tool.name.startsWith('spine_render_') || tool.name === 'spine_create_preview_manifest')) Object.assign(props, {times:{type:'array',items:{type:'number'},description:'显式关键时间，递增并含需检查的结束姿态；原速 GIF 不接受。'}}, { skin: { type: 'string' }, mappingPath: filePathProperty, motionPath: filePathProperty, scale: { type: 'number', exclusiveMinimum: 0 }, background: { type: 'string' }, premultipliedAlpha: { type: 'boolean' }, mipmaps: { type: 'boolean', default: false }, bounds: { type: 'object', properties: { minX: { type: 'number' }, minY: { type: 'number' }, maxX: { type: 'number' }, maxY: { type: 'number' } }, required: ['minX','minY','maxX','maxY'] } });
  if (tool.name === 'spine_compare_animation_previews') props.pixelComparison = { type: 'boolean', default: false };
  if (tool.name === 'spine_retarget_motion') { props.expectedRevision=versionSchema;props.preview = { type: 'boolean', default: true }; props.diagnosticPreview = { type:'boolean',default:false,description:'仅 dryRun：失败也输出完整诊断候选、逐姿态图和 GIF；不产生提交令牌，不能真实写入。' }; }
  if (tool.name === 'spine_run_validation_pipeline') props.preview = { type: 'boolean', default: true };
  if (tool.name === 'spine_fit_animation_curves') Object.assign(props,{atlasPath:filePathProperty,skin:{type:'string'},vertexTolerance:{type:'number',minimum:0}});
}
const schemaProvider=new AjvJsonSchemaValidator();
const toolValidators=new Map(tools.map(tool=>{
  const schema:any=tool.inputSchema;schema.additionalProperties=false;
  for(const required of schema.required??[])if(!schema.properties?.[required])throw new Error(`工具 schema 缺少必填字段声明：${tool.name}.${required}`);
  return[tool.name,schemaProvider.getValidator(schema)];
}));
const authoringExtras = new Set(['spine_agent_ping', 'spine_get_workspace_tree', 'spine_get_tool_catalog']);
const toolCatalog = authoringProfile
  ? new ToolCatalog(tools.filter(tool => authoringToolNames.has(tool.name) || authoringExtras.has(tool.name)), false)
  : new ToolCatalog(tools);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools:toolCatalog.list() }));
async function syncRoots() {
  if (!server.getClientCapabilities()?.roots) return;
  const result = await server.listRoots();
  const ids:string[]=[];
  for (const root of result.roots) {
    if (root.uri.startsWith('file:')) ids.push((await registerWorkspace({ rootPath: fileURLToPath(root.uri), source: 'root',setActive:false })).projectId);
  }
  await setWorkspaceRoots(ids);
}
let rootsReady: Promise<void> = Promise.resolve();
let connectionMonitor:AgentConnectionMonitor|undefined;
server.oninitialized = () => { rootsReady = syncRoots().catch(e => { process.stderr.write(`Roots 协商失败：${String(e)}\n`); });
  void rootsReady.then(async()=>{const name=server.getClientVersion()?.name??'unknown';const type=/codex/i.test(name)?'codex':/claude/i.test(name)?'claude-code':/opencode/i.test(name)?'opencode':'custom';connectionMonitor=new AgentConnectionMonitor(()=>server.request({method:'ping'},EmptyResultSchema,{timeout:5000}),name,type);await connectionMonitor.start();}).catch(e=>process.stderr.write(`连接检测失败：${String(e)}\n`));
};
server.onclose=()=>{void connectionMonitor?.stop().catch(()=>{});};
server.setNotificationHandler(RootsListChangedNotificationSchema, async () => { await syncRoots(); });
async function protocolRead<T>(fn:()=>Promise<T>|T):Promise<T>{try{await rootsReady;return await fn();}catch(error){const payload=hostFailure(error);throw new McpError(ErrorCode.InvalidParams,payload.message,payload);}}
if (!authoringProfile) {
  server.setRequestHandler(ListResourcesRequestSchema,request=>protocolRead(()=>listResources(request.params?.cursor)));
  server.setRequestHandler(ReadResourceRequestSchema,request=>protocolRead(()=>readResource(request.params.uri)));
  server.setRequestHandler(ListResourceTemplatesRequestSchema,()=>({resourceTemplates}));
  server.setRequestHandler(ListPromptsRequestSchema,()=>({prompts}));
  server.setRequestHandler(GetPromptRequestSchema,request=>protocolRead(()=>getPrompt(request.params.name,request.params.arguments)));
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as ToolArgs;
  const started=performance.now();
  const measured=async(response:any,version?:any,taskProjectId?:string)=>{
    try{if(!name.includes('workspace'))await recordCreationCall(getWorkspaceContext(taskProjectId??args.projectId),{tool:name,durationMs:performance.now()-started,textBytes:Buffer.byteLength(response.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(''),'utf8'),images:response.content.filter((b:any)=>b.type==='image').length,error:response.isError===true,version});}
    catch(error){process.stderr.write(`创作计量记录失败（工具结果保持原样）：${String(error)}\n`);try{const payload=JSON.parse(response.content[0].text);response.content[0].text=JSON.stringify({...payload,telemetry:{recorded:false,message:'本次计量落盘失败；操作回执仍有效，请用客户端日志补核。'}});}catch{}}
    return response;
  };
  try {
    await rootsReady;
    const validator=toolValidators.get(name);if(!validator||!toolCatalog.has(name))throw new ToolError('CAPABILITY_MISSING',`工具未实现或未在本连接启用：${name}；请查询 spine_get_tool_catalog。`);
    const validation=validator(args);if(!validation.valid)throw new ToolError('VALIDATION_FAILED',`参数不符合 ${name} 的已公布 schema。`,'validation',{validation:validation.errorMessage});
    if(connectionMonitor&&!name.includes('workspace'))await runInWorkspace(args.projectId,()=>name==='spine_agent_ping'?connectionMonitor!.identify(args.clientType??'custom',getWorkspaceContext(args.projectId)):connectionMonitor!.bind(getWorkspaceContext(args.projectId)));
    let progressNumber=0;
    const progressToken=request.params._meta?.progressToken;
    const progress=(stage:string)=>{if(progressToken!==undefined)void server.notification({method:'notifications/progress',params:{progressToken,progress:++progressNumber,message:stage}}).catch(()=>{});};
    const invoke=()=>name.includes('workspace') ? callTool(name,args) : runInWorkspace(args.projectId,()=>callTool(name,args,extra.signal,progress));
    const rawResult = await runTask({signal:extra.signal,progress:progressToken===undefined?undefined:(_current,_total,message)=>progress(message??'正在处理')},async()=>{const result=await invoke();checkpoint('工具执行');return result;});
    const result=toolCatalog.projectActions(args.responseDetail==='full'?rawResult:summarizeHostResult(rawResult,name));
    if(progressToken!==undefined){progressNumber++;await server.notification({method:'notifications/progress',params:{progressToken,progress:progressNumber,total:progressNumber,message:authoringToolNames.has(name)?'操作完成。':'本次工具执行结束；执行成功不代表视觉批准。'}}).catch(()=>{});}
    const images = pickImages(result);
    const imageData=(result as any)?.__imageData;
    if (result && typeof result === 'object') delete (result as any).__images;
    if (result && typeof result === 'object') delete (result as any).__imageData;
    const content: any[] = [{ type: "text", text: JSON.stringify(result, null, 2) }];
    if(typeof imageData==='string')content.push({type:'image',data:imageData,mimeType:'image/png'});
    const context = getWorkspaceContext(args.projectId);
    for (const rel of images) {
      try {
        const buf = await readFile(resolveWorkspacePath(rel, context));
        content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
      } catch { /* 图片不存在时只返回文本，不阻断结果 */ }
    }
    return measured({ content },(result as any)?.version??(result as any)?.state?.version,(result as any)?.taskContext?.projectId);
  } catch (error) {
    return measured({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(hostFailure(error,name)) }],
    });
  }
});

// 渲染类工具把页面图直接回给模型，避免「只给路径、还得人去看」。
function pickImages(r: any): string[] {
  if (!r || typeof r !== 'object') return [];
  const list: string[] = [];
  if (Array.isArray(r.__images)) list.push(...r.__images);
  for (const page of r.pages ?? []) { if (typeof page === 'string') list.push(page); else if (page?.clean) list.push(page.clean); }
  return [...new Set(list)].slice(0, 3);
}
async function callTool(name: string, args: ToolArgs, signal?:AbortSignal, progress?:(stage:string)=>void) {
  const {responseDetail:_responseDetail,...input}=args;args=input;
  const context = name.includes('workspace') ? {} : getWorkspaceContext(args.projectId);
  if(authoringToolNames.has(name))return callAuthoringTool(name,args,context);
  if(name==='spine_get_tool_catalog')return toolCatalog.describe(args.group);
  if(name==='spine_set_tool_groups'){const result=toolCatalog.select(args);if(args.dryRun===false)await server.notification({method:'notifications/tools/list_changed'});return result;}
  if(name==='spine_execute_task')return executeTask(args,context);
  if(creationToolDefinitions.some(tool=>tool.name===name))return callCreationTool(name,args,context,signal);
  if(name==='spine_create_pose_sequence')return createPoseSequence(args,context,signal);
  if(armCalibrationToolDefinitions.some(tool=>tool.name===name))return callArmCalibration(name,args,context,signal,progress);
  if(creationControlDefinitions.some(tool=>tool.name===name))return callCreationControl(name,args,context,signal,progress);
  validatePoseOperationArguments(name,args,poseToolDefinitions.find(tool=>tool[0]===name)?.[3]);
  if(hostToolDefinitions.some(tool=>tool.name===name))return callHostTool(name,args,context,signal,progress);
  if(name==='spine_retarget_motion'){
    if((await readWriter(context))?.mode==='attached')return hostClient(context).animationCandidate(args,signal,progress);
    if(args.expectedRevision!==undefined)throw new HostError('WRITE_FORBIDDEN','detached 不接受 Host expectedRevision，不能静默回退旧磁盘动画路径。',409);
  }
  if(name==='spine_generate_reference_retarget_target')return generateReferenceRetargetTarget(args,context);
  if(['spine_review_animation','spine_render_animation_comparison'].includes(name)){
    if((await readWriter(context))?.mode==='attached')return name==='spine_review_animation'?hostClient(context).animationReview(args,signal):hostClient(context).animationComparison(args,signal);
    if(args.expectedRevision!==undefined||args.playerManifestPath!==undefined||args.checkResults!==undefined)throw new HostError('WRITE_FORBIDDEN','Host 动画审查参数仅用于 attached 会话，不得静默忽略后回退旧磁盘路径。',409);
  }
  if(poseToolDefinitions.some(tool=>tool[0]===name)&&(await readWriter(context))?.mode==='attached'){
    const client=hostClient(context),state=await client.state();
    if(!state.available||state.writeMode==='frozen')throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','附着会话失联；不能回读旧磁盘冒充当前姿态。',409);
    if(isHostAssetCommand(name))return client.assetCommand(name,args,signal);
    if(state.activeDoc?.kind!=='pose')throw new HostError('UNSUPPORTED_DOC_KIND','该姿态入口需要当前 pose；motion/skeleton 请使用显式动画观察入口。',409);
    if(args.posePath&&resolveWorkspacePath(args.posePath,context)!==resolveWorkspacePath(state.activeDoc?.path??'',context))throw new HostError('TARGET_DRIFT','请求路径与 Host 当前活动文档不一致。',409);
    if(isHostPoseCommand(name))return client.poseCommand(name,args,signal,progress);
    if(['spine_solve_pose','spine_recheck_pose','spine_get_pose_state','spine_explain_pose'].includes(name)){
      if(['spine_solve_pose','spine_recheck_pose'].includes(name)||args.recheck===true)await client.evaluate(state.version,signal,progress);
      return client.state();
    }
    if(name==='spine_review_pose')return client.review(args,signal,progress);
    throw new HostError('WRITE_FORBIDDEN','该旧姿态工具尚未适配附着会话，请使用 Host 当前明确开放的操作。',409);
  }
  if(args.diagnosticMode==='newStage')throw new HostError('WRITE_FORBIDDEN','newStage 只用于隔离 C2 attached，不回退磁盘诊断资产写入。',409);
  if(isHostAssetCommand(name)&&args.expectedRevision!==undefined)throw new HostError('WRITE_FORBIDDEN','detached 资产工具不接受 Host expectedRevision，不能静默回退磁盘。',409);
  if(isHostPoseCommand(name)){
    if(args.expectedRevision!==undefined)throw new HostError('WRITE_FORBIDDEN','detached 不接受 Host expectedRevision，不能静默改读磁盘；先确认 attached 实例。',409);
    if(!args.outputPosePath)throw new HostError('INVALID_ARGUMENT','detached 姿态修改必须给出新 outputPosePath。');
  }
  const poseTool=poseToolDefinitions.find(t=>t[0]===name);if(poseTool){const result=await poseTool[2](args,context);if(args.dryRun===false||name==='spine_render_pose_comparison')await setPreviewSession({operation:{title:poseTool[1],status:result.ok?'done':'failed',detail:JSON.stringify({posePath:args.posePath,manifestPath:(result as any).manifestPath,issues:(result as any).report?.issues})},log:{level:result.ok?'info':'warning',message:JSON.stringify({tool:name,posePath:args.posePath,manifestPath:(result as any).manifestPath}),toolName:name}},context);return result;}
  if (['spine_set_foot_target','spine_lock_foot_contact','spine_set_hand_target','spine_adjust_body_motion','spine_adjust_step_length','spine_adjust_arm_swing'].includes(name)) return adjustMotion(name, args as any, context);
  switch (name) {
    case 'spine_get_workspace_tree':return getWorkspaceTree(args,context);
    case 'spine_set_curve': return setCurve(args.filePath, args as any, context);
    case 'spine_get_preview_report': return getPreviewReport(args as any, context);
    case 'spine_analyze_reference_parts': {
      const reference=await requireReferencePose(args.referencePosePath as string,context,false),report={...analyzeReferenceParts(reference.observation),referencePosePath:args.referencePosePath,referenceFingerprint:referenceFingerprint(reference),diagnosticOnly:true,readyToCommit:false};
      if(args.dryRun===false){if(!args.reportPath)throw new Error('保存部件诊断需显式 reportPath。');const output=resolveWorkspacePath(args.reportPath as string,context);await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}return {...report,dryRun:args.dryRun??true};
    }
    case 'spine_analyze_reference_gif': return analyzeReferenceGif(args as any, context);
    case 'spine_extract_reference_keyframes': return extractReferenceKeyframes(args as any, context);
    case 'spine_validate_reference_coverage': return validateReferenceCoverage(args as any, context);
    case 'spine_run_reference_retarget_flow': return runReferenceRetargetFlow(args as any, context);
    case "spine_agent_ping": {
      return {...await agentPing({
        agentName: args.agentName,
        clientType: args.clientType,
        clientVersion: args.clientVersion,
        note: args.note,
      }),buildIdentity:await runtimeBuildIdentity};
    }
    case "spine_agent_get_connection_status": {
      return getAgentConnectionStatus({ clientType: args.clientType });
    }
    case "spine_get_document_summary": {
      return getDocumentSummary(await readSpineDocument(args.filePath, context));
    }
    case "spine_check_editor_import": {
      // 显式取值，不把未知参数透传进去；projectId/responseDetail 由外层统一处理。
      return checkEditorImport({ filePath: args.filePath, enabled: args.enabled, timeoutMs: args.timeoutMs, writeReport: args.writeReport }, context);
    }
    case "spine_inspect_character": {
      return inspectCharacter(args.filePath, context);
    }
    case "spine_validate_mapping": {
      const document = await readSpineDocument(args.filePath, context);
      const mapping = await readCharacterMapping(args.mappingPath, context);
      return { ...validateMapping(mapping, document.json), status: mapping.status ?? "legacy", confirmed: mapping.status === "confirmed", sourceHashMatches: !mapping.sourceHash || mapping.sourceHash === document.hash, rigHashPresent: Boolean(mapping.rigHash), reportPath: mapping.reportPath ?? null };
    }
    case "spine_create_mapping_draft": {
      return createMappingDraft({ filePath: args.filePath, mappingPath: args.mappingPath, mapping: args.mapping, dryRun: args.dryRun }, context);
    }
    case "spine_calibrate_mapping": {
      return calibrateMapping({ filePath: args.filePath, mappingPath: args.mappingPath, reportPath: args.reportPath, dryRun: args.dryRun }, context);
    }
    case "spine_confirm_mapping": {
      return confirmMapping({ filePath: args.filePath, mappingPath: args.mappingPath, confirmedBy: args.confirmedBy, semanticChecks: args.semanticChecks, dryRun: args.dryRun }, context);
    }
    case "spine_validate_motion": {
      return validateMotion(await readMotionDefinition(args.motionPath, context));
    }
    case "spine_retarget_motion": {
      return retargetMotion({
        filePath: args.filePath,
        mappingPath: args.mappingPath,
        motionPath: args.motionPath,
        animation: args.animation,
        duration: args.duration,
        atlasPath: args.atlasPath,
        reviewToken: args.reviewToken,
        rotationTolerance: args.rotationTolerance,
        translationTolerance: args.translationTolerance,
        footContactTolerance: args.footContactTolerance,
        handTolerance: args.handTolerance,
        vertexTolerance: args.vertexTolerance,
        preview: args.preview,
        diagnosticPreview: args.diagnosticPreview,
        retargetMode: args.retargetMode,
        workflowProfile: args.workflowProfile,
        overwrite: args.overwrite,
        dryRun: args.dryRun,
        expectedHash: args.expectedHash,
        allowUnsupportedVersion: args.allowUnsupportedVersion,
      }, context);
    }
    case "spine_extract_motion": {
      return extractMotion({ filePath: args.filePath, mappingPath: args.mappingPath, animation: args.animation, motionPath: args.motionPath, reportPath: args.reportPath, samples: args.samples, loop: args.loop, groundY: args.groundY, contactTolerance: args.contactTolerance, dryRun: args.dryRun }, context);
    }
    case "spine_validate_motion_result": {
      return validateMotionResult({ filePath: args.filePath, mappingPath: args.mappingPath, motionPath: args.motionPath, animation: args.animation, duration: args.duration, footContactTolerance: args.footContactTolerance, handTolerance: args.handTolerance, vertexTolerance: args.vertexTolerance }, context);
    }
    case "spine_fit_animation_curves": {
      return fitAnimationCurves(args.filePath, {
        atlasPath: args.atlasPath,
        skin: args.skin,
        vertexTolerance: args.vertexTolerance,
        animation: args.animation,
        rotationTolerance: args.rotationTolerance,
        translationTolerance: args.translationTolerance,
        useCurves: args.useCurves,
        dryRun: args.dryRun,
        expectedHash: args.expectedHash,
        allowUnsupportedVersion: args.allowUnsupportedVersion,
      }, context);
    }
    case "spine_batch_retarget": {
      return batchRetarget(args.jobPath, context);
    }
    case "spine_get_official_spec_summary": {
      return getOfficialSpecSummary();
    }
    case "spine_get_skeleton_hierarchy": {
      return getSkeletonHierarchy(await readSpineDocument(args.filePath, context), args.includeSetupPose ?? false);
    }
    case "spine_get_slots": {
      return getSlots(await readSpineDocument(args.filePath, context));
    }
    case "spine_get_skins": {
      return getSkins(await readSpineDocument(args.filePath, context), args.includeAttachments ?? false);
    }
    case "spine_get_animations": {
      return getAnimations(await readSpineDocument(args.filePath, context));
    }
    case "spine_get_animation_timelines": {
      return getAnimationTimelines(await readSpineDocument(args.filePath, context), args.animation, args.targetType, args.targetName);
    }
    case "spine_get_animation_sheet": {
      return getAnimationSheet(await readSpineDocument(args.filePath, context), args.animation, args.targetType, args.targetName);
    }
    case "spine_create_animation": {
      return createAnimation(args.filePath, args as Parameters<typeof createAnimation>[1]);
    }
    case "spine_clone_animation": {
      return cloneAnimation(args.filePath, args as Parameters<typeof cloneAnimation>[1]);
    }
    case "spine_delete_animation": {
      return deleteAnimation(args.filePath, args as Parameters<typeof deleteAnimation>[1]);
    }
    case "spine_set_bone_keyframe": {
      return setBoneKeyframe(args.filePath, args as Parameters<typeof setBoneKeyframe>[1]);
    }
    case "spine_set_slot_attachment_keyframe": {
      return setSlotAttachmentKeyframe(args.filePath, args as Parameters<typeof setSlotAttachmentKeyframe>[1]);
    }
    case "spine_set_draw_order_keyframe": {
      return setDrawOrderKeyframe(args.filePath, args as Parameters<typeof setDrawOrderKeyframe>[1]);
    }
    case "spine_shift_keyframes": {
      return shiftKeyframes(args.filePath, args as Parameters<typeof shiftKeyframes>[1]);
    }
    case "spine_scale_keyframe_times": {
      return scaleKeyframeTimes(args.filePath, args as Parameters<typeof scaleKeyframeTimes>[1]);
    }
    case "spine_delete_keyframe_range": {
      return deleteKeyframeRange(args.filePath, args as Parameters<typeof deleteKeyframeRange>[1]);
    }
    case "spine_copy_keyframe_range": {
      return copyKeyframeRange(args.filePath, args as Parameters<typeof copyKeyframeRange>[1]);
    }
    case "spine_apply_pose_keyframes": {
      return applyPoseKeyframes(args.filePath, args as Parameters<typeof applyPoseKeyframes>[1]);
    }
    case "spine_apply_pose_sequence": {
      return applyPoseSequence(args.filePath, args as Parameters<typeof applyPoseSequence>[1]);
    }
    case "spine_offset_bone_timeline_values": {
      return offsetBoneTimelineValues(args.filePath, args as Parameters<typeof offsetBoneTimelineValues>[1]);
    }
    case "spine_make_loop": {
      return makeLoop(args.filePath, args as Parameters<typeof makeLoop>[1]);
    }
    case "spine_remove_keyframe": {
      return removeKeyframe(args.filePath, args as Parameters<typeof removeKeyframe>[1]);
    }
    case "spine_validate_json": {
      const document = await readSpineDocument(args.filePath, context);
      return validateSpineJson(document.json);
    }
    case "spine_preview_get_config": {
      return getPreviewConfig(args.baseUrl);
    }
    case "spine_preview_check_assets": {
      return checkPreviewAssets({
        filePath: args.filePath,
        atlasPath: args.atlasPath,
        animation: args.animation,
      }, context);
    }
    case "spine_preview_get_url": {
      return getPreviewUrl({
        filePath: args.filePath,
        atlasPath: args.atlasPath,
        animation: args.animation,
        skin: args.skin,
        speed: args.speed,
        premultipliedAlpha: args.premultipliedAlpha,
        mipmaps: args.mipmaps,
        autoload: args.autoload,
        baseUrl: args.baseUrl,
      });
    }
    case "spine_render_animation_frames": return renderAnimationFrames({ ...args, mappingPath: args.mappingPath, visualRigPath: args.visualRigPath } as any, context);
    case "spine_render_contact_sheet": return renderContactSheet({ ...args, mappingPath: args.mappingPath, visualRigPath: args.visualRigPath } as any, context);
    case "spine_render_animation_gif": return renderAnimationGif({ ...args, mappingPath: args.mappingPath, visualRigPath: args.visualRigPath } as any, context);
    case "spine_create_preview_manifest": return createPreviewManifest({ ...args, mappingPath: args.mappingPath, visualRigPath: args.visualRigPath } as any, context);
    case "spine_compare_animation_previews": return comparePreviewReports(args as any, context);
    case "spine_list_workspaces": return listWorkspaces();
    case "spine_register_workspace": return registerWorkspace(args as any);
    case "spine_get_workspace_info": return getWorkspaceInfo(args.projectId);
    case 'spine_create_project': return createProject(args, context);
    case "spine_select_workspace": return selectWorkspace(args.projectId);
    case "spine_runtime_validate": {
      return validatePreviewRuntime({
        filePath: args.filePath,
        atlasPath: args.atlasPath,
        animation: args.animation,
        skin: args.skin,
        scale: args.scale,
      }, context);
    }
    case "spine_run_validation_pipeline": {
      return runValidationPipeline({
        preview: args.preview,
        filePath: args.filePath,
        atlasPath: args.atlasPath,
        animation: args.animation,
        skin: args.skin,
        scale: args.scale,
        speed: args.speed,
        premultipliedAlpha: args.premultipliedAlpha,
        mipmaps: args.mipmaps,
        autoload: args.autoload,
        baseUrl: args.baseUrl,
      }, context);
    }
    case "spine_list_backups": {
      return listBackups({
        filePath: args.filePath,
        includeValidation: args.includeValidation,
      }, context);
    }
    case "spine_restore_backup": {
      return restoreBackup({
        backupPath: args.backupPath,
        targetFilePath: args.targetFilePath,
        dryRun: args.dryRun,
        expectedHash: args.expectedHash,
        confirm: args.confirm,
      }, context);
    }
    case "spine_preview_set_session": {
      return setPreviewSession({
        filePath: args.filePath,
        atlasPath: args.atlasPath,
        animation: args.animation,
        skin: args.skin,
        speed: args.speed,
        premultipliedAlpha: args.premultipliedAlpha,
        mipmaps: args.mipmaps,
        autoload: args.autoload,
        operation: args.operation,
        log: args.log,
      }, context);
    }
    case "spine_preview_get_session": {
      return getPreviewSession({ baseUrl: args.baseUrl }, context);
    }
    case "spine_preview_clear_session": {
      return clearPreviewSession(context);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
