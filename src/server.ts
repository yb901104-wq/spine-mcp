#!/usr/bin/env node
import { createPoseDraft, solvePose, adjustPose, renderPoseComparison, reviewPose, buildMotionFromPoses } from './poseWorkflow.js';
import { createReferencePose, renderReferencePoseSheet, reviewReferencePose } from './referencePose.js';
import { reviewAnimation, renderAnimationComparison } from './animationReview.js';
import { calibrateVisualRig, reviewVisualRig } from './visualRig.js';
import { retargetReferencePose, comparePoseGraphs } from './referenceRetarget.js';
import {validatePoseSequence} from './poseSequence.js';
import {refineReferencePose} from './referencePoseRefinement.js';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from 'node:url';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
  EmptyResultSchema,
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
} from "./spineJson.js";
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
import { adjustMotion } from './motionAdjustmentTools.js';
import { getWorkspaceInfo, listWorkspaces, registerWorkspace, selectWorkspace, getWorkspaceContext, runInWorkspace } from "./workspaceTools.js";

type ToolArgs = Record<string, any>;

const server = new Server(
  {
    name: "spine-json-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const filePathProperty = {
  type: "string",
  description: "工作区根目录内的 Spine JSON 文件路径。",
};
const projectIdProperty = {
  type: "string",
  description: "可选已登记工作区 projectId；未提供时兼容 SPINE_MCP_WORKSPACE。",
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
    description: "使用角色 mapping 将标准动作适配到目标 Spine JSON。默认 dryRun=true；会沿用现有备份、hash、diff 白名单和官方规范审查。",
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
    description: "检查预览所需的 JSON、atlas 和 atlas 引用贴图是否存在，并确认目标动画是否存在。只读，不写入 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: filePathProperty,
        atlasPath: { type: "string", description: "工作区根目录内的 Spine atlas 文件路径。" },
        animation: { type: "string", description: "可选目标动画名。" },
      },
    },
  },
  {
    name: "spine_preview_get_url",
    description: "生成可直接打开的浏览器预览 URL，支持指定 JSON、atlas、动画、皮肤、PMA、Mipmaps 和自动载入。只读，不写入 JSON。",
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
        animation: { type: "string", description: "可选目标动画名；会检查 runtime 是否能找到该动画。" },
        skin: { type: "string", description: "可选目标皮肤名；会检查 runtime 是否能找到该皮肤。" },
        scale: { type: "number", exclusiveMinimum: 0, description: "可选读取缩放，默认使用 runtime 的 1。" },
      },
    },
  },
  {
    name: "spine_run_validation_pipeline",
    description: "执行写入后的推荐只读验证流程：结构校验、官方 runtime 加载验证和预览 URL 生成。不写入 JSON。",
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
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: filePathProperty, atlasPath: { type: "string" }, animation: { type: "string" }, skin: { type: "string" }, fps: { type: "integer", minimum: 1 }, frames: { type: "integer", minimum: 2 }, width: { type: "integer", minimum: 32 }, height: { type: "integer", minimum: 32 }, background: { type: "string" }, outputDir: { type: "string" }, jobId: { type: "string" } }, required: ["filePath", "atlasPath", "animation"] },
  },
  {
    name: "spine_render_contact_sheet",
    description: "生成固定相机的 contact sheet 和逐姿态 PNG 贴图帧，适合 Agent 低 token 视觉检查。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: filePathProperty, atlasPath: { type: "string" }, animation: { type: "string" }, fps: { type: "integer", minimum: 1 }, frames: { type: "integer", minimum: 2 }, width: { type: "integer", minimum: 32 }, height: { type: "integer", minimum: 32 }, columns: { type: "integer", minimum: 1 }, outputDir: { type: "string" }, jobId: { type: "string" } }, required: ["filePath", "atlasPath", "animation"] },
  },
  {
    name: "spine_render_animation_gif",
    description: "离线生成动画 GIF，固定相机、官方 runtime 姿态和 PNG 帧复用缓存。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: filePathProperty, atlasPath: { type: "string" }, animation: { type: "string" }, fps: { type: "integer", minimum: 1 }, frames: { type: "integer", minimum: 2 }, outputDir: { type: "string" }, jobId: { type: "string" } }, required: ["filePath", "atlasPath", "animation"] },
  },
  {
    name: "spine_create_preview_manifest",
    description: "记录 JSON/atlas hash、runtime、采样、画布和固定相机参数，供缓存和审计使用。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, filePath: filePathProperty, atlasPath: { type: "string" }, animation: { type: "string" }, fps: { type: "integer", minimum: 1 }, frames: { type: "integer", minimum: 2 }, width: { type: "integer", minimum: 32 }, height: { type: "integer", minimum: 32 } }, required: ["filePath", "atlasPath", "animation"] },
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
    description: "返回当前或指定 projectId 的工作区信息。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
  },
  {
    name: "spine_select_workspace",
    description: "选择已登记的 projectId 作为当前活动工作区。",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
  },
];

const auxiliaryTools = [
  { name: 'spine_set_curve', description: '仅调整已有骨骼关键帧曲线；最后一帧禁止 curve；null 表示移除曲线。默认 dryRun，沿用备份和 diff 门禁。', inputSchema: { type: 'object', properties: { filePath: filePathProperty, animation: { type: 'string' }, bone: { type: 'string' }, timeline: { type: 'string', enum: ['rotate','translate','scale','shear'] }, time: { type: 'number', minimum: 0 }, curve: { anyOf: [{ type: 'string', enum: ['stepped'] }, { type: 'array', items: { type: 'number' } }, { type: 'null' }] }, ...writeProperties }, required: ['filePath','animation','bone','timeline','time','curve'] } },
  { name: 'spine_get_preview_report', description: '读取预览报告；默认返回摘要，需要轨迹时设置 detailed:true。', inputSchema: { type: 'object', properties: { manifestPath: filePathProperty, detailed: { type: 'boolean' } }, required: ['manifestPath'] } },
  { name: 'spine_analyze_reference_gif', description: '离线拆分参考 GIF，读取帧延迟、重复帧、循环扩展和统一画布；阶段由 Agent 显式标注。', inputSchema: { type: 'object', properties: { filePath: filePathProperty, outputDir: filePathProperty, fallbackDelay: { type: 'number', minimum: 10 }, loop: { type: 'boolean' }, phases: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, phase: { type: 'string' } }, required: ['time','phase'] } } }, required: ['filePath'] } },
  { name: 'spine_extract_reference_keyframes', description: '从参考 manifest 中去除重复帧并均匀选取主要姿态；不凭空生成 IK 数据。', inputSchema: { type: 'object', properties: { manifestPath: filePathProperty, count: { type: 'integer', minimum: 2, maximum: 32 } }, required: ['manifestPath'] } },
  ...['spine_set_foot_target','spine_lock_foot_contact','spine_set_hand_target','spine_adjust_body_motion','spine_adjust_step_length','spine_adjust_arm_swing'].map(name => ({ name, description: '修改角色无关 v2 motion 的目标或幅度，默认 dryRun；下一步重定向自动重算相关 IK、约束和曲线。', inputSchema: { type: 'object', properties: { motionPath: filePathProperty, outputMotionPath: filePathProperty, side: { type: 'string', enum: ['left','right'] }, time: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, angle: { type: 'number' }, contact: { type: 'boolean' }, factor: { type: 'number', exclusiveMinimum: 0 }, bodyBob: { type: 'number' }, sway: { type: 'number' }, dryRun: { type: 'boolean', default: true } }, required: ['motionPath','outputMotionPath'] } }))
];
const poseToolDefinitions = [
 ['spine_calibrate_visual_rig','校准视觉关节与实际骨骼、切片绑定，输出角色、切片分解和节点图；原点候选不能自动确认。',calibrateVisualRig,['filePath','mappingPath','visualRigPath']],
 ['spine_review_visual_rig','确认校准后的视觉绑定及图像证据；角色资源变化后失效。',reviewVisualRig,['visualRigPath','decision','reviewedBy','reason']],
 ['spine_validate_pose_sequence','校验动作级左右身份、阶段、参考指纹与视角能力；旧交换对应不能混用。',validatePoseSequence,['sequencePath']],
 ['spine_refine_reference_pose','依最新静态比较做最多 60 次确定性局部修正，固定身份、支撑与弯曲侧；新修订仍需视觉审查。',refineReferencePose,['posePath','outputPosePath']],
 ['spine_retarget_reference_pose','按参考方向、躯干轴及双脚残差生成草稿，引用动作级身份；不平均接地冲突。',retargetReferencePose,['referencePosePath','visualRigPath','standardPosePath','posePath']],
 ['spine_compare_pose_graphs','比较参考与 runtime 实际视觉节点，各指标独立通过；未知必要点不允许确认。',comparePoseGraphs,['posePath']],
 ['spine_create_reference_pose','先标注参考图像的头身和四肢关节；遮挡点需声明推测，未知点不得伪造。',createReferencePose,['referencePosePath','observation']],
 ['spine_render_reference_pose_sheet','生成上原图下参考节点连线的审查图，每页六列；实线可见、虚线推测。',renderReferencePoseSheet,['referencePosePaths','outputDir']],
 ['spine_review_reference_pose','先审查参考标注与图像证据，再允许适配目标姿态。',reviewReferencePose,['referencePosePath','manifestPath','decision','reviewedBy','reason','checks']],
 ['spine_create_pose_draft','创建标准站姿或动作关键姿态，默认 dryRun；action 需已确认标准站姿。',createPoseDraft,['filePath','mappingPath','posePath','kind']],
 ['spine_solve_pose','复用官方 runtime 求解单姿态，检查可达性、关节方向与站姿膝部屈曲；不写角色 JSON。',solvePose,['posePath']],
 ['spine_adjust_pose','批量修改姿态参数，输出新修订并清除求解与审查结果。',adjustPose,['posePath','outputPosePath','patch']],
 ['spine_render_pose_comparison','按指定关键姿态生成上参考下目标的干净图、诊断图；每页最多六列，固定比例地面线。',renderPoseComparison,['posePaths']],
 ['spine_review_pose','记录 Agent 对具体姿态和图像证据的审查；通过需数值有效、理由和全部检查项。',reviewPose,['posePath','manifestPath','decision','reviewedBy','reason','checks']],
 ['spine_build_motion_from_poses','从已确认站姿与关键姿态生成 v2 motion，包含开始结束和阶段 ID。',buildMotionFromPoses,['standardPosePath','keyPoses','motionPath','name','duration']],
 ['spine_review_animation','审查完整候选动画 GIF，绑定关键姿态和证据指纹，返回真实写入所需 reviewToken。',reviewAnimation,['reviewToken','manifestPath','decision','reviewedBy','reason','checks']],
 ['spine_render_animation_comparison','按严格递增阶段对应生成上下同步 GIF，同时保留目标原速 GIF；沿用姿态图相机。',renderAnimationComparison,['targetManifestPath','referenceManifestPath','poseManifestPath','phaseMap']],
] as const;
const poseProperties:any={projectId:projectIdProperty,dryRun:{type:'boolean',default:true}};
for(const k of ['filePath','mappingPath','posePath','outputPosePath','standardPosePath','manifestPath','motionPath','outputDir','targetManifestPath','referenceManifestPath','poseManifestPath','referencePosePath','visualRigPath','comparisonPath','candidatePath','reportPath','sequencePath'])poseProperties[k]=filePathProperty;
Object.assign(poseProperties,{anatomicalSides:{type:'object',description:'解剖 left/right 绑定目标 left/right 语义链；basis 必填，纳入 visualRig 确认指纹。'},viewProfiles:{type:'array',items:{type:'object'},description:'身体视角的已校准切片状态配置：bodyView/attachments/bodySlots/basis。未配置视角不能靠标签批准。'},detailed:{type:'boolean',default:false,description:'默认返回节点和切片摘要，完整顶点/权重保存在报告中。'},nodes:{type:'object',description:'视觉锚点：boneLocal 或 meshTriangle，须 calibrated:true 和 basis。'},segments:{type:'object',description:'leftArm.0/1、rightArm.0/1、leftLeg.0/1、rightLeg.0/1：nodes/bones/attachments。'},correspondence:{type:'object',description:'目标 left/right 对应参考 left/right；basis、anatomicalIdentity、projectedOrder 必须明确。'},checkResults:{type:'object',description:'每个检查项独立 status:pass 和具体 reason。'},stageId:{type:'string'},animation:{type:'string'},time:{type:'number',minimum:0}});
for(const k of ['name','id','reviewedBy','reason','thresholdReason','reviewToken'])poseProperties[k]={type:'string'};
Object.assign(poseProperties,{observation:{type:'object',description:'参考图像坐标，含 head/body 与左右肩肘腕髋膝踝；visibility/confidence/basis，遮挡坐标 estimated:true。'},referencePosePaths:{type:'array',items:filePathProperty},region:{type:'array',items:{type:'number'},minItems:4,maxItems:4,description:'局部放大区域 [x,y,width,height]，相对单图像面板。'},targetTimes:{type:'array',items:{type:'number'}},stageIds:{type:'array',items:{type:'string'}},facing:{type:'string',enum:['left','right']},kind:{type:'string',enum:['standing','action']},decision:{type:'string',enum:['approved','rejected']},frame:{type:'object',description:'normalizedSkeleton 语义姿态：time/body/head/channels/targets/bendDirections；不是图像坐标。'},patch:{type:'object',description:'允许 frame/weapon/reference/groundY/policy，深合并。'},reference:{type:'object',description:'imagePath/time/facing/crop[x,y,width,height]/height/groundY/basis/points；points 含 visibility 和可见点 x/y。'},weapon:{type:'object',description:'二维假想杆 x/y/angle/grips.left/right；需 mapping 手部 gripPoint。'},posePaths:{type:'array',items:{type:'string'},minItems:1,maxItems:60},keyPoses:{type:'array',items:{type:'object',properties:{posePath:filePathProperty,time:{type:'number'},stageId:{type:'string'}},required:['posePath','time','stageId']}},phaseMap:{type:'array',items:{type:'object',properties:{targetTime:{type:'number'},referenceTime:{type:'number'}},required:['targetTime','referenceTime']}},checks:{type:'array',items:{type:'string'}},issues:{type:'array',items:{type:'string'}},loop:{type:'boolean'},duration:{type:'number',exclusiveMinimum:0},groundY:{type:'number'},kneeFlexionMax:{type:'number',minimum:0,maximum:180},width:{type:'integer'},height:{type:'integer'}});
tools.push(...poseToolDefinitions.map(([name,description,_fn,required])=>({name,description,inputSchema:{type:'object',properties:poseProperties,required:[...required]}})) as any);
tools.push(...auxiliaryTools as any);
for (const tool of tools) {
  const props = tool.inputSchema.properties as Record<string, any>;
  props.projectId ??= projectIdProperty;
  if (tool.name.startsWith('spine_render_') || tool.name === 'spine_create_preview_manifest') Object.assign(props, {times:{type:'array',items:{type:'number'},description:'显式关键时间，递增并含需检查的结束姿态；原速 GIF 不接受。'}}, { skin: { type: 'string' }, mappingPath: filePathProperty, motionPath: filePathProperty, scale: { type: 'number', exclusiveMinimum: 0 }, background: { type: 'string' }, premultipliedAlpha: { type: 'boolean' }, mipmaps: { type: 'boolean', default: false }, bounds: { type: 'object', properties: { minX: { type: 'number' }, minY: { type: 'number' }, maxX: { type: 'number' }, maxY: { type: 'number' } }, required: ['minX','minY','maxX','maxY'] } });
  if (tool.name === 'spine_compare_animation_previews') props.pixelComparison = { type: 'boolean', default: false };
  if (tool.name === 'spine_retarget_motion') { props.preview = { type: 'boolean', default: true }; props.diagnosticPreview = { type:'boolean',default:false,description:'仅 dryRun：失败也输出完整诊断候选、逐姿态图和 GIF；不产生提交令牌，不能真实写入。' }; }
  if (tool.name === 'spine_run_validation_pipeline') props.preview = { type: 'boolean', default: true };
  if (tool.name === 'spine_fit_animation_curves') Object.assign(props,{atlasPath:filePathProperty,skin:{type:'string'},vertexTolerance:{type:'number',minimum:0}});
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
async function syncRoots() {
  if (!server.getClientCapabilities()?.roots) return;
  const result = await server.listRoots();
  for (const root of [...result.roots].reverse()) {
    if (root.uri.startsWith('file:')) await registerWorkspace({ rootPath: fileURLToPath(root.uri), source: 'root' });
  }
}
let rootsReady: Promise<void> = Promise.resolve();
let connectionMonitor:AgentConnectionMonitor|undefined;
server.oninitialized = () => { rootsReady = syncRoots().catch(e => { process.stderr.write(`Roots 协商失败：${String(e)}\n`); });
  void rootsReady.then(async()=>{const name=server.getClientVersion()?.name??'unknown';const type=/codex/i.test(name)?'codex':/claude/i.test(name)?'claude-code':/opencode/i.test(name)?'opencode':'custom';connectionMonitor=new AgentConnectionMonitor(()=>server.request({method:'ping'},EmptyResultSchema,{timeout:5000}),name,type);await connectionMonitor.start();}).catch(e=>process.stderr.write(`连接检测失败：${String(e)}\n`));
};
server.onclose=()=>{void connectionMonitor?.stop().catch(()=>{});};
server.setNotificationHandler(RootsListChangedNotificationSchema, async () => { await syncRoots(); });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as ToolArgs;
  try {
    await rootsReady;
    if(connectionMonitor&&!name.includes('workspace'))await runInWorkspace(args.projectId,()=>name==='spine_agent_ping'?connectionMonitor!.identify(args.clientType??'custom',getWorkspaceContext(args.projectId)):connectionMonitor!.bind(getWorkspaceContext(args.projectId)));
    const result = name.includes('workspace') ? await callTool(name, args) : await runInWorkspace(args.projectId, () => callTool(name, args));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
});

async function callTool(name: string, args: ToolArgs) {
  const context = name.includes('workspace') ? {} : getWorkspaceContext(args.projectId);
  const poseTool=poseToolDefinitions.find(t=>t[0]===name);if(poseTool){const result=await poseTool[2](args,context);if(args.dryRun===false||name==='spine_render_pose_comparison')await setPreviewSession({operation:{title:poseTool[1],status:result.ok?'done':'failed',detail:JSON.stringify({posePath:args.posePath,manifestPath:(result as any).manifestPath,issues:(result as any).report?.issues})},log:{level:result.ok?'info':'warning',message:JSON.stringify({tool:name,posePath:args.posePath,manifestPath:(result as any).manifestPath}),toolName:name}},context);return result;}
  if (['spine_set_foot_target','spine_lock_foot_contact','spine_set_hand_target','spine_adjust_body_motion','spine_adjust_step_length','spine_adjust_arm_swing'].includes(name)) return adjustMotion(name, args as any, context);
  switch (name) {
    case 'spine_set_curve': return setCurve(args.filePath, args as any, context);
    case 'spine_get_preview_report': return getPreviewReport(args as any, context);
    case 'spine_analyze_reference_gif': return analyzeReferenceGif(args as any, context);
    case 'spine_extract_reference_keyframes': return extractReferenceKeyframes(args as any, context);
    case "spine_agent_ping": {
      return agentPing({
        agentName: args.agentName,
        clientType: args.clientType,
        clientVersion: args.clientVersion,
        note: args.note,
      });
    }
    case "spine_agent_get_connection_status": {
      return getAgentConnectionStatus({ clientType: args.clientType });
    }
    case "spine_get_document_summary": {
      return getDocumentSummary(await readSpineDocument(args.filePath, context));
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
      const document = await readSpineDocument(args.filePath);
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
    case "spine_render_animation_frames": return renderAnimationFrames(args as any, context);
    case "spine_render_contact_sheet": return renderContactSheet(args as any, context);
    case "spine_render_animation_gif": return renderAnimationGif(args as any, context);
    case "spine_create_preview_manifest": return createPreviewManifest(args as any, context);
    case "spine_compare_animation_previews": return comparePreviewReports(args as any, context);
    case "spine_list_workspaces": return listWorkspaces();
    case "spine_register_workspace": return registerWorkspace(args as any);
    case "spine_get_workspace_info": return getWorkspaceInfo(args.projectId);
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
