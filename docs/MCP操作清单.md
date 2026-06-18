# MCP 操作清单

本文档记录当前 Spine JSON MCP 已支持的所有操作。后续新增、修改或删除 MCP 工具时，必须同步更新本文档。

## 通用约定

- 所有文件路径都通过 `filePath` 传入，且必须位于工作区根目录内。
- 写入工具默认 `dryRun: true`，只返回差异，不修改文件。
- 真正写入时传 `dryRun: false`，工具会先在 `backups/` 生成备份。
- 写入操作默认只支持 `skeleton.spine === "4.1.24"`。
- `expectedHash` 用于防止基于旧文件覆盖新文件。
- V1/V1.5 不修改 setup pose、bones、slots、skins、mesh/deform、constraints 和 events。
- 写入后会对真实 diff 做白名单检查。当前写工具只允许修改 `/animations/{animation}` 子树。
- 写入后会对当前支持的 timeline 子集做官方规范审查和字段级 schema 校验。
- 写工具返回 `affectedPaths`、`diff`、`summary` 和 `operationValidation`，用于让 Agent 判断“改了什么、是否越权、下一步做什么”。
- `affectedPaths` 是去重后的受影响 JSON path；`diff` 保留完整差异条目；`summary.changedPathCount` 等于去重后的 path 数量，`summary.diffEntryCount` 等于原始 diff 条目数量。
- 写工具返回 `officialSpecValidation`，用于说明本次写入按哪些 Spine JSON 规范规则检查过。

## 读取与分析

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_get_document_summary` | 查看 Spine JSON 文档摘要。 | 返回版本、hash、顶层字段、骨骼/插槽/皮肤/动画数量，以及当前版本是否允许写入。 |
| `spine_get_official_spec_summary` | 查看 MCP 内置的官方 JSON 规范审查规则。 | 返回官方文档来源、当前支持版本、可写 timeline 字段表和 `4.1.24` 字段适配说明。 |
| `spine_get_skeleton_hierarchy` | 查看骨骼树。 | `includeSetupPose: true` 时返回 setup pose 局部变换；只读，不修改骨架。 |
| `spine_get_slots` | 查看插槽列表。 | 按绘制顺序返回 slot、绑定 bone、默认 attachment，适合判断层级遮挡关系。 |
| `spine_get_skins` | 查看皮肤和附件摘要。 | `includeAttachments: true` 时列出每个 slot 下的 attachment 名称和类型。 |
| `spine_get_animations` | 查看动画列表。 | 返回动画名、估算时长、bone/slot/top-level timeline 类型统计。 |
| `spine_get_animation_timelines` | 查看某个动画的原始时间线。 | 可按 `targetType` 和 `targetName` 过滤；适合精确查看原始 JSON 结构。 |
| `spine_get_animation_sheet` | 查看适合 Agent 编辑的关键帧表格。 | 返回 target、timeline、time、value、curve、path，比原始 JSON 更适合做批量编辑前分析。 |
| `spine_validate_json` | 校验 JSON 结构和引用关系。 | 检查版本、bone/slot 引用、attachment 引用、draw order slot 引用、关键帧时间排序。 |

## Agent 连接与握手

这些工具用于确认 Codex、Claude Code、opencode 或自定义 MCP Client 是否真的连上了本项目 MCP。它们只写入或读取 `.spine-mcp/agent-handshake.json` 运行态文件，不写 Spine JSON。

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_agent_ping` | 记录 Agent 连接握手。 | Agent 成功接入 MCP 后调用；WinForms 连接向导看到对应 `clientType` 的最近握手后显示绿灯。 |
| `spine_agent_get_connection_status` | 查看 Agent 连接状态和配置片段。 | 返回最近握手、项目规则检测、Codex/Claude Code/opencode/自定义客户端的 MCP 配置片段和握手说明。 |

连接状态约定：

- 绿灯：对应 Agent 已成功调用 `spine_agent_ping`。
- 黄灯：检测到项目规则或配置提示，但尚未完成握手。
- 红灯：未检测到可用配置或握手。
- WinForms 可以通过预览服务 `GET /api/agent-connection?clientType=codex` 读取同一状态。
- 第一版只生成配置片段和诊断信息，不静默写入用户全局 Agent 配置。

## 备份与恢复

这些工具用于执行“导入失败后先恢复备份，再重新制作”的安全流程。恢复工具属于高风险写操作，不编辑动画内容，只做文件级恢复。

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_list_backups` | 列出 `backups/` 中的 JSON 备份。 | 可按 `filePath` 过滤目标文件对应备份；默认校验每个备份 JSON 是否可解析、结构是否通过。 |
| `spine_restore_backup` | 将指定备份恢复到目标 JSON 文件。 | 必须显式传 `confirm:true`；默认 `dryRun:true`；真实恢复前会先把当前目标文件再次备份为 `*.before-restore.*.json`。 |

恢复约定：

- `backupPath` 必须位于工作区 `backups/` 目录内。
- `targetFilePath` 必须位于工作区内。
- 建议传 `expectedHash`，防止恢复时覆盖一个已经被其他操作改变的目标文件。
- 备份 JSON 不能解析或校验不通过时，真实恢复会被拒绝。
- 恢复后应调用 `spine_run_validation_pipeline`，再用 Spine 软件确认导入。

## 浏览器预览辅助

这些工具都是只读工具，不写入 JSON，也不替代 MCP 写入流程。它们用于帮助 Agent 或未来 WinForms 生成浏览器预览入口。

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_preview_get_config` | 查看浏览器预览层默认配置。 | 返回默认 JSON、atlas、动画名、官方 runtime 版本、PMA/Mipmaps 建议和 URL 参数说明。 |
| `spine_preview_check_assets` | 检查预览资源是否齐全。 | 检查 JSON 可读、目标动画存在、atlas 可读、atlas 引用的 png 是否存在。 |
| `spine_preview_get_url` | 生成可直接打开的预览 URL。 | 支持指定 JSON、atlas、动画、皮肤、播放速度、`premultipliedAlpha`、`mipmaps` 和 `autoload`。 |
| `spine_runtime_validate` | 使用官方 runtime 做加载验证。 | 通过本地 `@esotericsoftware/spine-core@4.1.56` 读取 JSON、atlas 和附件数据；可检查目标动画/皮肤是否能被 runtime 找到。 |
| `spine_run_validation_pipeline` | 执行写入后的推荐验证流水线。 | 一次性运行 `spine_validate_json`、`spine_runtime_validate` 和 `spine_preview_get_url`；只读，不写入 JSON。 |
| `spine_preview_set_session` | 设置 Agent 驱动的当前预览会话。 | 写入 `.spine-mcp/preview-session.json`，记录当前 JSON、atlas、动画、预览参数和 Agent 操作说明；不写 Spine JSON。 |
| `spine_preview_get_session` | 读取当前预览会话。 | 返回当前上下文、操作说明、日志和预览 URL；供 Agent、浏览器预览层或未来 WinForms 读取。 |
| `spine_preview_clear_session` | 清空当前预览会话。 | 删除运行态会话文件，恢复默认 JSON、atlas 和动画；不写 Spine JSON。 |

预览会话约定：

- 会话状态文件位于 `.spine-mcp/preview-session.json`，属于运行态文件，不应提交。
- Agent 在执行 dryRun、写入、验证或恢复时，可调用 `spine_preview_set_session` 更新当前观察上下文。
- 浏览器预览页和未来 WinForms 应读取会话状态自动切换资源，不要求用户手动选择操作目标。
- 会话工具只服务观察和展示，不参与动画制作决策，也不绕过 MCP 写入规则。

预览 URL 参数：

- `json`：工作区内 Spine JSON 路径。
- `atlas`：工作区内 Spine atlas 路径。
- `animation`：要预览的动画名。
- `skin`：可选皮肤名。
- `speed`：播放速度。
- `pma`：是否使用预乘 Alpha。
- `mipmaps`：是否启用 Mipmaps。
- `autoload`：页面打开后是否自动载入预览。

## 单点关键帧写入

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_set_bone_keyframe` | 插入或更新骨骼关键帧。 | 支持 `rotate`、`translate`、`scale`、`shear`；同一时间点会更新，不会重复插入。 |
| `spine_set_slot_attachment_keyframe` | 插入或更新插槽附件关键帧。 | `attachmentName` 为字符串表示显示附件；为 `null` 表示隐藏附件。 |
| `spine_set_draw_order_keyframe` | 插入或更新绘制顺序关键帧。 | 使用 Spine 官方 draw order offsets 结构。 |
| `spine_remove_keyframe` | 按时间删除关键帧。 | 可删除 bone、slot 或 draw order timeline 的指定时间点关键帧。 |

允许修改路径：

- `spine_set_bone_keyframe`：`/animations/*/bones/*/{rotate,translate,scale,shear}`
- `spine_set_slot_attachment_keyframe`：`/animations/*/slots/*/attachment`
- `spine_set_draw_order_keyframe`：`/animations/*/{drawOrder,draworder}`
- `spine_remove_keyframe`：`/animations/*/...` 中的指定 timeline

## 动画管理

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_create_animation` | 新建空动画。 | 默认不覆盖已有动画；需要覆盖时传 `overwrite: true`。 |
| `spine_clone_animation` | 复制已有动画。 | 适合先复制模板动画，再在副本上批量调整。默认不覆盖目标动画。 |
| `spine_delete_animation` | 删除动画。 | 高风险操作，必须显式传 `confirm: true`；建议先 dry run。 |

允许修改路径：

- `/animations/{animation}`

## 批量时间编辑

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_shift_keyframes` | 将关键帧整体前后平移。 | 支持按时间范围、骨骼/插槽/draw order 目标过滤。平移后时间不能为负数。 |
| `spine_scale_keyframe_times` | 压缩或拉伸关键帧时间。 | 以 `originTime` 为原点按 `scale` 缩放；适合调整动作节奏快慢。 |
| `spine_delete_keyframe_range` | 删除某段时间内的关键帧。 | 用于清空局部动作片段；必须传 `range`。 |
| `spine_copy_keyframe_range` | 复制一段关键帧到指定动画和时间。 | 可复制到同一动画或另一个动画；目标动画不存在时会自动创建空动画结构。 |

允许修改路径：

- `/animations/{animation}/bones/...`
- `/animations/{animation}/slots/...`
- `/animations/{animation}/{drawOrder,draworder}`

## 批量姿态与数值编辑

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_apply_pose_keyframes` | 在同一时间批量写入多个骨骼和插槽姿态。 | 适合描述“第 0 秒站姿、第 0.5 秒迈步姿态”这类关键姿态。 |
| `spine_apply_pose_sequence` | 一次性创建或覆盖动画，并批量写入多个姿态时间点。 | 适合从自然语言生成一段新动画，例如走路循环；相比多次调用 `spine_apply_pose_keyframes`，它只走一次事务、一次规范审查和一次备份。支持 `duration` 与 `closeLoop` 自动首尾闭合。 |
| `spine_offset_bone_timeline_values` | 批量调整骨骼 timeline 数值。 | 支持对 `rotate/translate/scale/shear` 增加偏移或按比例缩放，例如增大摆臂幅度。 |
| `spine_make_loop` | 将某个时间点的已有关键帧复制到另一个时间点。 | 用于让循环动画首尾闭合；只复制 sourceTime 上已存在的关键帧，不做插值采样。 |

允许修改路径：

- `/animations/{animation}/bones/...`
- `/animations/{animation}/slots/...`
- `/animations/{animation}/{drawOrder,draworder}`

`spine_apply_pose_sequence` 的补充约定：

- `poses` 是非空数组，每个元素代表一个姿态时间点。
- 每个姿态时间点可同时包含多个 `bones` 和 `slots`。
- `closeLoop: true` 时必须传 `duration`，并且必须包含 `time: 0` 的首帧；工具会把首帧姿态复制到 `duration`。
- 默认不覆盖已有动画；覆盖时必须显式传 `overwrite: true`。
- 该工具仍只写入 animation timeline，不新增骨骼、插槽、皮肤或附件。

## 支持的 timeline schema

详细规范说明见 `docs/官方JSON规范审查.md`。

| timeline | 允许字段 | 备注 |
|---|---|---|
| bone `rotate` | `time`, `value`, `curve` | `value` 必须是数字。官方在线文档可能以 `angle` 描述旋转角度；当前 `4.1.24` 写入使用样本导出的 `value` 字段。 |
| bone `translate` | `time`, `x`, `y`, `curve` | `x/y` 必须是数字。 |
| bone `scale` | `time`, `x`, `y`, `curve` | `x/y` 必须是数字。 |
| bone `shear` | `time`, `x`, `y`, `curve` | `x/y` 必须是数字。 |
| slot `attachment` | `time`, `name` | 缺少 `name` 表示隐藏附件或沿用空附件状态。 |
| `drawOrder` / `draworder` | `time`, `offsets` | `offsets` 内元素必须是 `{ slot, offset }`。 |
| `curve` | `"stepped"` 或偶数长度数字数组 | 当前样本中存在 4 数字和 8 数字曲线数组。`curve` 表示到下一关键帧的插值，因此最后一帧不能包含 `curve`；写工具会自动整理，审查层会拒绝最终 JSON 中的尾帧 `curve`。 |

备注：Agent 凭空生成新动画时，默认不应写入 `curve` 数组；优先使用默认线性插值。只有复制已有 Spine 导出曲线，或已经能按当前版本导出坐标精确生成曲线时，才应保留 `curve`。

## 当前不能做的事

- 不计算世界坐标和运行时采样。
- 不通过 MCP 直接渲染截图或返回帧图；当前只提供浏览器预览页、预览 URL、官方 runtime 读取验证和推荐验证流水线。
- 不创建、删除或重命名骨骼、插槽、皮肤、附件。
- 不修改 mesh、deform、constraints、events。
- 不自动判断动作是否“好看”，只能做结构化数据编辑。
- 不绕过官方规范审查层直接写入未纳入当前可写子集的 timeline。
