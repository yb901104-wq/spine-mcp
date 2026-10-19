# Spine JSON MCP

最新实际 MCP 验证：[npc1 姿态实例复验](docs/npc1姿态实例复验.md)。`attack_pose_reviewed` 已写入，但用户指出初始帧明显不匹配；此前 Agent 视觉批准已撤销，当前验收不通过。已有数值/runtime 通过与 GIF 产物不代表参考姿态匹配。

新增参考先行的 Pose to Pose 流程：参考关节标注和连线审查 → 标准站姿 → 目标关键姿态上下对比 → 补间候选/GIF 审查 → 安全提交。详见 [姿态校准与视觉审查](docs/姿态校准与视觉审查.md)。静态图片和动画 WebP 可通过现有参考拆帧接口处理。新增源码已构建，已启动的旧 MCP 服务需重新加载；旧便携包不会自动更新。

浏览器 PMA 选项会按 atlas 页面 Alpha 格式生成配套预览纹理，不只切换混合公式；原图不修改。直通 Alpha 的 NPC1 贴图可直接勾选 PMA，状态栏会显示实际转换页数。

本轮细节工具实测与 idle runtime 优化见 [细节工具实测验收](docs/细节工具实测验收.md)。曲线拟合可传 `atlasPath` 回读验证实际误差；`useCurves:true` 输出三次贝塞尔，默认 false 使用线性简化。

这是一个 TypeScript MCP 服务器，用于受控地读取、校验和修改 Spine `4.1.24` 导出的 JSON 文件。第一版聚焦动画时间线，不直接修改 setup pose、骨骼结构、插槽结构或皮肤资源结构。

## 安装与构建

Windows 便携 exe 发布：`powershell -ExecutionPolicy Bypass -File scripts/publish-observer.ps1`。输出在 `releases/SpineMCP-win-x64-时间戳/`，包含自带 .NET 的 exe、Node 与生产依赖；运行仍需 WebView2。双击 exe 选择项目，自动启动本机预览服务，关闭窗口停止它启动的服务。保留整个发布目录，移动目录后重新配置 Agent。

```bash
npm install
npm run build
npm test
```

## 运行

```bash
npm run build
node dist/server.js
```

服务器使用 MCP stdio 传输。默认情况下，所有文件工具只能访问当前工作目录内的文件。可以通过 `SPINE_MCP_WORKSPACE` 指定工作区根目录。

## 浏览器预览

项目提供一个独立浏览器预览层，用本地安装的官方 Spine Web runtime 加载工作区内的 JSON、atlas 和贴图资源。预览层只负责显示动画，不负责写入 JSON。

```bash
npm run build
npm run preview
```

默认访问：

```text
http://127.0.0.1:5177
```

当前预览默认使用 `example-json/skeleton-4.1.json`、`preview/xiaoren.atlas` 和 `preview/xiaoren.png`。预览系统说明见 [docs/浏览器预览系统.md](D:/AI_cc/spine-mcp/docs/浏览器预览系统.md)。

## WinForms 观察平台

项目提供一个最小 WinForms 观察壳，路径为 [apps/winforms-observer](D:/AI_cc/spine-mcp/apps/winforms-observer)。它读取 `/api/session`，展示 Agent 设置的当前上下文和操作日志，会话变化时调用 `/api/validation-pipeline` 展示验证结果，通过 `/api/agent-connection` 展示 Codex、Claude Code、opencode 等 Agent 的连接状态，并用 WebView2 嵌入预览 URL。

推荐用一键脚本启动，它会自动构建、选择空闲端口、启动预览服务并打开 WinForms：

```bash
npm run observer
```

脚本会写入运行态状态文件 `.spine-mcp/observer-runtime.json`，记录本次启动的 preview server 端口、URL、PID、WinForms PID 和日志路径。该文件只用于观察平台运行管理，不写 Spine JSON。

WinForms 会读取这个运行态状态文件，在左侧显示 preview server URL/PID、WinForms PID、启动时间、日志路径和停止命令，并提供“复制停止命令”“打开日志”两个辅助按钮。

停止由脚本启动的观察平台：

```bash
npm run observer:stop
```

停止前预览将要停止的进程：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-observer.ps1 -DryRun
```

也可以直接运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-observer.ps1
```

如果只想检查端口和路径，不启动进程：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-observer.ps1 -CheckOnly
```

```bash
dotnet run --project apps/winforms-observer/SpineMcp.WinFormsObserver.csproj
```

WinForms 只观察和预览，不直接编辑 JSON。设计说明见 [docs/WinForms观察平台设计.md](D:/AI_cc/spine-mcp/docs/WinForms观察平台设计.md)。

## 在 Codex 中使用

本项目可作为 Codex MCP server 使用。配置示例：

```toml
[mcp_servers.spine_json_mcp]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\AI_cc\spine-mcp\dist\server.js']
startup_timeout_sec = 30

[mcp_servers.spine_json_mcp.env]
SPINE_MCP_WORKSPACE = 'D:\AI_cc\spine-mcp'
```

修改 Codex 配置后，需要重启 Codex 或开启新会话，让 MCP 工具列表重新加载。加载成功后，可以让 Codex 调用 `spine_get_document_summary`、`spine_get_animations`、`spine_validate_json` 等工具。

连接成功后，建议让 Agent 调用一次握手工具：

```json
{
  "tool": "spine_agent_ping",
  "arguments": {
    "clientType": "codex",
    "agentName": "Codex"
  }
}
```

WinForms 的“一键配置”支持 Codex、Claude Code、opencode；Codex 默认推荐用户级，其他客户端默认项目级。确认路径后自动备份与写入。Codex 桌面需完全退出并重开；项目配置还需项目信任/批准。绿灯由定期 MCP 协议 ping 判定，黄灯表示等待连接/响应，红灯表示离线/过期；历史握手不会维持绿灯。详见 [Agent 一键配置与实时连接](docs/Agent一键配置与实时连接.md)。

完整 MCP 操作列表见 [docs/MCP操作清单.md](D:/AI_cc/spine-mcp/docs/MCP操作清单.md)。

官方 JSON 规范审查说明见 [docs/官方JSON规范审查.md](D:/AI_cc/spine-mcp/docs/官方JSON规范审查.md)。自然语言验证用例见 [docs/自然语言验证用例.md](D:/AI_cc/spine-mcp/docs/自然语言验证用例.md)。标准演示用例见 [docs/标准演示用例.md](D:/AI_cc/spine-mcp/docs/标准演示用例.md)。安全提交流程见 [docs/安全提交流程.md](D:/AI_cc/spine-mcp/docs/安全提交流程.md)。浏览器预览说明见 [docs/浏览器预览系统.md](D:/AI_cc/spine-mcp/docs/浏览器预览系统.md)。WinForms 观察平台设计见 [docs/WinForms观察平台设计.md](D:/AI_cc/spine-mcp/docs/WinForms观察平台设计.md)。

如果要从 Agent 接入开始走一遍最短闭环，优先参考 [docs/最小使用流程.md](D:/AI_cc/spine-mcp/docs/最小使用流程.md)。该文档按顺序记录了 Codex 连接、Agent 握手、启动 WinForms、dryRun、真实写入和验证流水线。

## V1 范围

- 读取 Spine JSON 摘要、骨骼层级、插槽、皮肤、动画列表、动画时间线和关键帧表格。
- 校验 Spine JSON 结构、引用关系、附件时间线、绘制顺序偏移和关键帧排序。
- 按 Spine 官方 JSON 导出格式和 `4.1.24` 样本适配规则审查当前可写 timeline 子集。
- 管理动画：创建、复制、删除动画。
- 批量编辑动画：平移关键帧、缩放时间、删除范围、复制片段、批量写入姿态、一次性写入多姿态动画序列、偏移骨骼数值、闭合循环。
- 从自然语言制作新动画时，优先使用 `spine_apply_pose_sequence` 把多个姿态时间点放进一次事务，减少多次写入、多次备份和多次审查调用。
- 只写入动画时间线数据：
  - 骨骼 `rotate`、`translate`、`scale`、`shear`
  - 插槽 `attachment`
  - 动画 `drawOrder` / `draworder`
- 写入工具默认 `dryRun: true`，只返回差异，不修改文件。
- 写入工具返回去重后的 `affectedPaths`、完整 `diff`、中文 `summary`、diff 白名单结果和官方规范审查结果，便于 Agent 判断修改范围和下一步操作。
- 提交写入时会在 `backups/` 中生成备份。
- 可通过 `spine_list_backups` 查看备份，通过 `spine_restore_backup` 执行带 dryRun、confirm、expectedHash 和二次备份保护的恢复流程。
- 浏览器预览层通过官方 Spine Web runtime 动态加载修改后的 JSON；runtime 的 `major.minor` 必须匹配 `skeleton.spine`。
- 预览辅助工具可以检查资源并生成带参数的浏览器预览 URL，但不写入 JSON。
- `spine_runtime_validate` 可以用本地官方 `spine-core@4.1.56` 读取 JSON、atlas 和附件数据，确认文件不只是结构校验通过，也能被当前 4.1 runtime 加载。
- `spine_run_validation_pipeline` 可以在真实写入后一次性执行结构校验、官方 runtime 加载验证和预览 URL 生成，作为推荐复查入口。
- `spine_preview_set_session` / `spine_preview_get_session` / `spine_preview_clear_session` 提供 Agent 驱动的预览会话状态，供浏览器预览层和未来 WinForms 观察平台同步当前 JSON、atlas、动画和操作说明。
- `spine_agent_ping` / `spine_agent_get_connection_status` 提供 Agent 连接握手和配置片段查询，供 WinForms 连接向导显示红/黄/绿状态。
- V1 有意不修改 setup pose、bones、slots、skins、mesh/deform、constraints 和 events。

## 版本策略

写入操作锁定 `skeleton.spine === "4.1.24"`。如果文件版本不是 `4.1.24`，默认只允许读取和校验；除非工具调用显式传入 `allowUnsupportedVersion: true`，否则拒绝写入。

## 项目规则

项目规则记录在 [AGENTS.md](D:/AI_cc/spine-mcp/AGENTS.md)。后续所有新增文档、注释性说明、工具说明和面向 Agent 的描述都应优先使用中文。

## 动画生成工作流

项目现在提供角色 mapping、角色无关动作文件、动作重定向、曲线压缩和批处理工具。示例文件位于 `mappings/`、`motions/`、`jobs/`，详细流程见 [docs/动画生成工作流.md](D:/AI_cc/spine-mcp/docs/动画生成工作流.md)。

新增 MCP 工具：`spine_inspect_character`、`spine_create_mapping_draft`、`spine_calibrate_mapping`、`spine_confirm_mapping`、`spine_validate_mapping`、`spine_extract_motion`、`spine_validate_motion`、`spine_retarget_motion`、`spine_validate_motion_result`、`spine_fit_animation_curves`、`spine_batch_retarget`。生成、校准和曲线工具默认 `dryRun: true`；v2 真实写入还必须经过 mapping 确认、校准报告、reviewToken、hash、备份、diff 白名单、JSON 规范和官方 runtime 门禁。

当前升级已通过 `npm run build` 和 `npm test`。示例 walk、idle 和 run 可经过 mapping、IK、脚底/手腕约束、曲线压缩、JSON 规范校验和 `@esotericsoftware/spine-core` runtime 验证。新增离线预览工具会生成固定相机 PNG 贴图帧、contact sheet 和 preview manifest；GIF 使用本地编码器生成，参考 GIF 可拆帧、分析时间与重复帧。工作区支持 projectId 登记，同时兼容 `SPINE_MCP_WORKSPACE`。


## 离线视觉验证与项目工作区升级
新增离线 PNG 帧、联系图、GIF、参考 GIF 分析、对比报告及 projectId/MCP Roots 支持。默认重定向生成数值报告和联系图；Agent 查看后提交。详细工具、参数、局部调整、缓存/锁和已知验证边界见 [离线视觉验证与工作区](D:/AI_cc/spine-mcp/docs/离线视觉验证与工作区.md)。


## 关节与切片驱动姿态

新增 visualRig 校准/确认、参考单姿态适配及实际骨架比较四个 MCP 工具。参考任务缺少有效绑定、比较报告或逐阶段依据时不能确认；候选动画关键时间再次通过官方 runtime 回读复核。详见 [关节切片驱动姿态流程](docs/关节切片驱动姿态流程.md)。NPC1 旧准备姿态已被程序判错，新准备候选仍有冲突，尚未完成整段攻击和编辑器验收。

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

## 准备姿态适配与有界修正（2026-10-10）

新增动作级身份校验、肩髋躯干轴和最多60次的确定性局部修正。见 [准备姿态适配与修正闭环](docs/准备姿态适配与修正闭环.md)。本轮 npc1 必要关系和数值通过，视觉审查退回；未批准完整攻击。
