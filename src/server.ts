#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  agentPing,
  getAgentConnectionStatus,
} from "./agentTools.js";
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
  setDrawOrderKeyframe,
  setSlotAttachmentKeyframe,
  shiftKeyframes,
  validateSpineJson,
} from "./spineJson.js";

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
    description: "Agent 连接握手工具。Agent 成功连接 MCP 后调用它，WinForms 连接向导会据此显示绿色连接状态。只写运行态握手文件，不写 Spine JSON。",
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
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as ToolArgs;
  try {
    const result = await callTool(name, args);
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
  switch (name) {
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
      return getDocumentSummary(await readSpineDocument(args.filePath));
    }
    case "spine_get_official_spec_summary": {
      return getOfficialSpecSummary();
    }
    case "spine_get_skeleton_hierarchy": {
      return getSkeletonHierarchy(await readSpineDocument(args.filePath), args.includeSetupPose ?? false);
    }
    case "spine_get_slots": {
      return getSlots(await readSpineDocument(args.filePath));
    }
    case "spine_get_skins": {
      return getSkins(await readSpineDocument(args.filePath), args.includeAttachments ?? false);
    }
    case "spine_get_animations": {
      return getAnimations(await readSpineDocument(args.filePath));
    }
    case "spine_get_animation_timelines": {
      return getAnimationTimelines(await readSpineDocument(args.filePath), args.animation, args.targetType, args.targetName);
    }
    case "spine_get_animation_sheet": {
      return getAnimationSheet(await readSpineDocument(args.filePath), args.animation, args.targetType, args.targetName);
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
      });
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
    case "spine_runtime_validate": {
      return validatePreviewRuntime({
        filePath: args.filePath,
        atlasPath: args.atlasPath,
        animation: args.animation,
        skin: args.skin,
        scale: args.scale,
      });
    }
    case "spine_run_validation_pipeline": {
      return runValidationPipeline({
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
      });
    }
    case "spine_list_backups": {
      return listBackups({
        filePath: args.filePath,
        includeValidation: args.includeValidation,
      });
    }
    case "spine_restore_backup": {
      return restoreBackup({
        backupPath: args.backupPath,
        targetFilePath: args.targetFilePath,
        dryRun: args.dryRun,
        expectedHash: args.expectedHash,
        confirm: args.confirm,
      });
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
      });
    }
    case "spine_preview_get_session": {
      return getPreviewSession({ baseUrl: args.baseUrl });
    }
    case "spine_preview_clear_session": {
      return clearPreviewSession();
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
