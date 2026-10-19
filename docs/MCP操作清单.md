# MCP 操作清单

## 参考先行与关键姿态工具

`spine_retarget_motion` 对稀疏语义关键姿态（最多64个）增加区间内部求解采样，随后压缩输出；旋转拟合限制单段跨度，报告包含最大误差发生的时间/手部。接口参数不变。实际实例见 [npc1姿态实例复验](npc1姿态实例复验.md)。

所有工具使用已登记工作区的 `projectId + 相对路径`；保存工作流产物的工具默认 `dryRun:true`，渲染工具生成独立产物，不编辑角色 JSON。

| 工具 | 功能 |
|---|---|
| spine_create_reference_pose | 记录参考头身及四肢节点、可见性、置信度和依据 |
| spine_render_reference_pose_sheet | 上原图下参考节点连线；可见实线、遮挡虚线、未知不连线 |
| spine_review_reference_pose | 绑定参考标注及图像证据的独立审查 |
| spine_create_pose_draft | 建立标准站姿/动作姿态，referencePosePath 关联已审查参考 |
| spine_solve_pose | 单姿态 IK、膝部阈值、实际关节与握持误差 |
| spine_adjust_pose | 批量调整并输出新修订，清除原审查 |
| spine_render_pose_comparison | 上参考下目标，干净/诊断图，显式阶段时间、分页与局部放大 |
| spine_review_pose | 记录单姿态数值和视觉审查 |
| spine_build_motion_from_poses | 已确认姿态构建 v2 motion |
| spine_render_animation_comparison | 单调阶段对应的上下同步 GIF，保留目标原速 GIF |
| spine_review_animation | 审查完整候选并返回最终写入 token |

`spine_analyze_reference_gif` 兼容静态图片、GIF 和动画 WebP；名称为兼容旧客户端保留。渲染帧接口支持显式 `times`，原速 GIF 不接受非均匀指定时间。

参数、检查项和 token 顺序见 [姿态校准与视觉审查](姿态校准与视觉审查.md)。

## 曲线拟合的 runtime 验收参数

`spine_fit_animation_curves` 支持 `atlasPath`、`skin`、`vertexTolerance`。`useCurves:true` 拟合三次贝塞尔；默认 false 使用线性简化。提供 atlas 后返回 `curveFitReport`：`runtimeVerified`、`attempts`、`samples`、关键帧数量和最大旋转/位移/顶点误差。超标会收紧拟合，最终不通过则拒绝写入。未提供 atlas 的数学拟合不能视作 runtime 验收。具体调用与结果见 [细节工具实测验收](细节工具实测验收.md)。

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

Codex 桌面一键配置默认推荐用户级，写入后完全退出重开客户端；项目级必须受信任且对应当前项目。安装成功和预览服务正常不等于 MCP 已连接。

这些工具读取实时 MCP 协议检测与历史语义握手，运行态文件为 `.spine-mcp/agent-handshake.json` 和 `.spine-mcp/connections/*.json`，不写 Spine JSON。

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_agent_ping` | 记录 Agent 身份与语义握手。 | 可修正客户端类型，历史记录不能让连接灯变绿。 |
| `spine_agent_get_connection_status` | 查看 Agent 连接状态和配置片段。 | 返回最近握手、项目规则检测、Codex/Claude Code/opencode/自定义客户端的 MCP 配置片段和握手说明。 |

连接状态约定：

- 绿灯：进程存活，近期 MCP 协议 ping 成功且未过期。
- 黄灯：已配置待连接或协议暂未响应。
- 红灯：离线、进程死亡或心跳过期。
- WinForms 可以通过预览服务 `GET /api/agent-connection?clientType=codex` 读取同一状态。
- WinForms 支持明确点击后的一键配置，HTTP GET `/api/agent-config` 审查，POST 配合专用请求头和 expectedHash 写入并备份；不作为模型可调用的 MCP 安装工具。完整说明见 [Agent一键配置与实时连接](Agent一键配置与实时连接.md)。

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

## 当前限制

- 预览渲染当前输出固定相机 PNG 帧、联系图和 GIF；支持 region、mesh、普通 clipping 和常见混合模式。复杂嵌套 clipping 会明确报错。
- 不创建、删除或重命名骨骼、插槽、皮肤、附件。
- 不修改 mesh、deform、constraints、events。
- 不自动判断动作是否“好看”，只能做结构化数据编辑。
- 不绕过官方规范审查层直接写入未纳入当前可写子集的 timeline。

## 动画生成能力

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_inspect_character` | 返回骨骼、插槽、动画和版本摘要。 | 只读；用于建立 mapping。 |
| `spine_validate_mapping` | 校验角色 mapping 并检查骨骼引用。 | 只读。 |
| `spine_validate_motion` | 校验角色无关的动作中间格式。 | 只读。 |
| `spine_retarget_motion` | 使用 mapping 将 walk、run、idle 等动作适配到目标 JSON。 | 默认 dryRun；沿用现有安全写入流程。 |
| `spine_fit_animation_curves` | 按误差阈值删除冗余关键帧，可写入线性贝塞尔曲线。 | 默认 dryRun。 |
| `spine_batch_retarget` | 逐个执行 jobs JSON 中的多个重定向任务。 | 单个失败不阻止其他任务。 |

## 离线视觉验证和工作区

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_create_preview_manifest` | 记录 JSON/atlas hash、runtime、FPS、画布和固定相机参数。 | 只读；用于审计和缓存。 |
| `spine_render_animation_frames` | 使用官方 runtime 采样并输出固定相机 PNG 贴图帧。 | 不修改 Spine JSON。 |
| `spine_render_contact_sheet` | 生成 contact sheet 和逐姿态诊断帧。 | 默认视觉检查产物，低 token。 |
| `spine_render_animation_gif` | 请求 GIF 诊断输出。 | 本地编码，默认按请求生成。 |
| `spine_compare_animation_previews` | 比较两个 manifest 的时长、帧数和相机范围。 | 不同角色默认不做像素差异。 |
| `spine_list_workspaces` | 列出已登记项目工作区。 | 只读。 |
| `spine_register_workspace` | 登记 Agent 项目目录并生成 projectId。 | 后续工具可显式使用 projectId。 |
| `spine_get_workspace_info` | 查询当前或指定工作区。 | 只读。 |
| `spine_select_workspace` | 选择活动 projectId。 | 不修改 Spine JSON。 |

## 语义确认、校准和 v2 重定向

| 工具 | 能做什么 | 备注 |
|---|---|---|
| `spine_create_mapping_draft` | 根据 Agent 的语义选择创建 draft mapping。 | 默认 dryRun；不覆盖已有 mapping。 |
| `spine_calibrate_mapping` | 使用官方 runtime 计算骨骼长度、根坐标、rig 指纹并生成校准报告。 | mapping 必须提供 atlasPath；默认 dryRun。 |
| `spine_confirm_mapping` | 保存 Agent 对身体、左右侧、锚点、弯曲方向和跟随骨骼的确认。 | 必须先校准；确认状态是真实动画写入门禁。 |
| `spine_extract_motion` | 从已确认的参考动画提取角色无关的 v2 motion。 | 输出语义身体、手脚目标、接触事件和跟随通道；默认 dryRun。 |
| `spine_validate_motion_result` | 检查 IK 可达性、脚底/手腕锚点、首尾闭合、旋转跳变和 mesh 顶点采样。 | 只读。 |

v2 重定向的真实写入约定：

- mapping 必须为 `status: "confirmed"`，且校准报告与当前角色 hash、rigHash 和 mapping fingerprint 一致。
- 必须先以 `dryRun: true` 取得 `reviewToken`，真实写入时同时传入同一 `expectedHash` 和 `reviewToken`。
- v2 motion 必须声明 `coordinateSystem: "normalizedSkeleton"`，frames 覆盖完整周期；循环动作首尾必须一致。
- `spine_retarget_motion` 会调用两段式 IK、脚底锚点、单臂目标 IK、规则化跟随和三次曲线压缩；门禁未通过时不写文件。
- 写入成功后会刷新 mapping/report 的 sourceHash，同时保留 rigHash，避免新增 animation 后 mapping 失效。

动画生成支持语义骨骼链、身体起伏、侧摆、摆臂、交替腿部角度、两段式腿部 IK、脚底接触、单臂手腕目标 IK 和规则化跟随。复杂碰撞、布料物理和双手协同 IK 不在当前版本范围内。


## 离线视觉验证与项目工作区升级
新增离线 PNG 帧、联系图、GIF、参考 GIF 分析、对比报告及 projectId/MCP Roots 支持。默认重定向生成数值报告和联系图；Agent 查看后提交。详细工具、参数、局部调整、缓存/锁和已知验证边界见 [离线视觉验证与工作区](D:/AI_cc/spine-mcp/docs/离线视觉验证与工作区.md)。

## 新增工具补充清单

| 工具 | 用途 |
|---|---|
| spine_get_preview_report | 摘要读取；detailed:true 返回完整轨迹 |
| spine_analyze_reference_gif | 拆帧、帧延迟、重复帧与参考 manifest |
| spine_extract_reference_keyframes | 选取无重复参考姿态 |
| spine_set_foot_target | 修改 v2 motion 脚目标，重定向时重算 IK |
| spine_lock_foot_contact | 标记主要姿态接触地面 |
| spine_set_hand_target | 修改手腕目标，重定向时重算单臂 IK |
| spine_adjust_body_motion | 调整归一化身体起伏和侧摆 |
| spine_adjust_step_length | 按 factor 调整脚目标水平范围 |
| spine_adjust_arm_swing | 按 factor 调整手目标水平范围 |
| spine_set_curve | 修改现有关键帧曲线，禁止最后一帧 curve |

普通完整动作仍优先使用高层重定向。局部目标工具写入新 motion，不直接修改角色 JSON；底层 curve 工具只用于明确微调。


## 关节、骨骼和切片对应工具

| 工具 | 功能 |
|---|---|
| spine_calibrate_visual_rig | 校准视觉节点、骨骼链和真实附件影响；输出全图、分解图、节点图 |
| spine_review_visual_rig | 绑定确认与证据校验；原点候选不得自动确认 |
| spine_retarget_reference_pose | 按参考两段方向和目标链长生成诊断草稿；脚参与，冲突停止 |
| spine_compare_pose_graphs | 比较实际视觉节点；可传 candidatePath/animation/time 复核真正动画 |

均支持 projectId，默认 dryRun:true；detailed:true 可读取完整附件数据，默认摘要。spine_create_pose_draft/adjust_pose 支持 visualRigPath/correspondence；spine_review_pose 新增 comparisonPath、stageId、逐项 checkResults。真实写入再次核验实际动画关键时间。参数与实例见 [关节切片驱动姿态流程](关节切片驱动姿态流程.md)。

## 完整动画诊断实例（不批准、不提交）

`spine_retarget_motion` 新增 `diagnosticPreview:true`，仅支持 `dryRun`。用户要求观察整段失败候选时，可在保留未确认姿态和失败报告的前提下生成完整诊断动画：候选 JSON、实际关键时间关系比较、固定相机上下姿态图和目标原速 GIF。通过 `spine_render_animation_comparison` 生成上下同步 GIF。

诊断结果始终为 `ok:false`、`diagnosticOnly:true`、`readyToCommit:false`，分别返回 `numericOk`、`poseGate`、`keyGraphs` 和 `previewIssues`，不产生 `reviewToken`，不修改原角色。它是观察失败的独立出口，不能替代正式姿态/动画审查或用于提交。`diagnosticPreview:true,dryRun:false` 必须拒绝；渲染失败仍保留候选与错误。

实际验证脚本：`scripts/acceptance-animation-diagnostic.mjs`。先执行 `references`，Agent 查看参考连线图并填写逐阶段参考判断后执行 `animate`。脚本通过实际 MCP stdio 求解和渲染，仅创建工作流草稿，不自动批准任何目标姿态或完整动画。环境变量 `ANIMATION_DIAGNOSTIC_DIR` 可指定已有实例相对目录。

中文负例：把手目标设到骨骼不可达范围，再请求完整动画诊断。预期得到失败报告及 GIF、原 JSON 哈希未变、无提交令牌；请求真实写入仍应拒绝。不要把 GIF 生成成功描述为动画匹配通过。

## 解剖持杖手、身体视角及切片遮挡检查

参考 observation.actionSemantics 支持 `version:1 / weaponHand:left|right / identityStatus:confirmed / anatomicalBasis / bodyView / bodyViewBasis / occlusion`。身体视角可为 `frontThreeQuarter`、`side`、`backThreeQuarter`，参考有不确定性时可用 `sideOrBackThreeQuarter`。遮挡项保存 `{front,back,basis}`，语义部位可为 `body` 或已有肢体线段编号（如 `rightArm.1`）。缺少必要遮挡关系返回无法验证，不默认为通过。

`spine_calibrate_visual_rig` 增加 `anatomicalSides` 与 `viewProfiles`，均绑定确认指纹。解剖左右映射保持跨阶段稳定；视角配置保存实际附件状态、躯干插槽和看图校准依据。姿态 `frame.action.driver` 明确实际目标驱动手（如 `rightHand`），骨架比较独立输出 `action.weaponHand`、`action.bodyView`、`action.occlusion.*`。身体视角从 runtime 实际附件配置匹配已确认 profile；未经校准不能只传一个“背面”标签通过。遮挡用 runtime 绘制顺序回读。Agent 判断仍参与视角配置校准，这不是自动像素识别或数学上的视觉保证。

`frame.presentation` 支持受控 `attachments` 和完整 `drawOrder` 插槽排列，沿用 `spine_adjust_pose`、`spine_solve_pose` 和 v2 motion。显示状态在阶段边界离散切换，导出为已有 attachment/drawOrder 时间线；不改 setup、绑定、mesh、atlas 或 PNG。现有后发、面部显隐及背包层序可构造转身诊断候选，但不代表有完整三维转身模型。需要逐姿态查看轮廓并重新校准，不能自动批准隐藏五官后的身体视角。

中文验证：右手参考对应左手驱动必须失败；正面配置不能覆盖侧背参考；缺失视角/遮挡信息必须无法验证；同一附件状态不能标记成两种不同视角；遮挡层序反转必须失败。切片状态修改使配置匹配和旧审查失效。官方 runtime 回读 attachment/drawOrder 的阶段切换必须与单姿态一致。

## 准备姿态闭环新增工具

| 工具 | 必需参数 | 说明 |
|---|---|---|
| spine_validate_pose_sequence | sequencePath | 校验动作级解剖身份、阶段、参考指纹和角色视角能力；可传 posePaths 检查旧对应冲突 |
| spine_refine_reference_pose | posePath、outputPosePath | 根据最新静态 comparisonPath 做有界阻尼最小二乘，新修订不继承审查；默认 dryRun |

spine_retarget_reference_pose 增加 sequencePath、stageId，默认在内存中联合修正；持久化时保存方向初值和新修订。spine_compare_pose_graphs 增加肩髋躯干轴、关节弯曲侧、前后站位；头中心连线仅为诊断。spine_review_pose 必须身份、实际比较、数值及图像证据均有效。具体格式、错误分类及实际失败证据见 [闭环说明](准备姿态适配与修正闭环.md)。
