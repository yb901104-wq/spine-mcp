# 项目规则

## 语言与文档

- 本项目的所有项目级文档必须使用中文，包括 `README.md`、设计说明、计划文档、使用说明、测试说明和面向 Agent 的规则文档。
- MCP 工具的 `description`、参数说明、错误说明和返回给 Agent 的人类可读说明应优先使用中文。
- 所有已经实现的 MCP 操作必须记录在 `docs/MCP操作清单.md`，并配中文备注。
- 新增、修改、重命名或删除 MCP 工具时，必须同步更新 `docs/MCP操作清单.md` 和相关 README 说明。
- 修改自然语言交互能力、写入流程或安全门禁时，必须同步更新 `docs/自然语言验证用例.md` 或 `docs/安全提交流程.md`。
- 修改官方 JSON 规范审查逻辑、可写 timeline schema、版本适配规则或官方文档依据时，必须同步更新 `docs/官方JSON规范审查.md`。
- 修改浏览器预览、runtime 加载、预览资源目录、hash 热重载或未来 WinForms/WebView2 嵌入流程时，必须同步更新 `docs/浏览器预览系统.md`。
- 修改 WinForms 观察平台定位、界面区域、连接流程或 Agent 驱动会话状态时，必须同步更新 `docs/WinForms观察平台设计.md`。
- 修改 Agent 连接握手、Codex/Claude Code/opencode 配置片段、连接向导或相关 HTTP API 时，必须同步更新 `docs/MCP操作清单.md`、`docs/WinForms观察平台设计.md` 和相关 README。
- 修改 WinForms 或预览服务的一键启动脚本、启动参数或默认端口策略时，必须同步更新 `README.md`、`apps/winforms-observer/README.md` 和 `docs/WinForms观察平台设计.md`。
- 代码标识符、第三方包名、Spine 官方字段名、JSON 字段名和命令行参数保持原文，例如 `dryRun`、`drawOrder`、`skeleton.spine`。
- 如果引用官方英文文档，正文用中文解释，必要时保留英文术语原文。

## 实现边界

- V1 只支持 Spine `4.1.24` JSON 的写入；其他版本默认只读或校验。
- 写入工具默认 `dryRun: true`，提交写入必须生成备份。
- 写入工具必须经过官方 JSON 规范审查层、diff 白名单和结构引用校验；Agent 和未来 Skill 不允许绕过 MCP 直接自由编辑 Spine JSON。
- 官方 JSON 规范审查必须覆盖 Spine 导入器敏感规则，例如 `curve` 只描述当前关键帧到下一关键帧的插值，timeline 最后一帧不能包含 `curve`。
- Agent 凭空生成新动画时默认不要写入 `curve` 数组；除非复制已有 Spine 导出曲线或已能按当前版本真实导出坐标精确生成控制点。
- 如果真实 Spine 导入失败或发现写入 JSON 有规范问题，不要在错误 JSON 上继续修修补补；必须先恢复到最近一次确认可用的备份，再在恢复后的 JSON 上重新制作目标修改。
- V1 只修改动画时间线，不修改 setup pose、bones、slots、skins、mesh/deform、constraints 和 events。
- 需要从自然语言生成一整段多姿态动画时，优先使用 `spine_apply_pose_sequence` 一次事务写入，不要拆成大量连续的单点写入调用。
- 所有文件路径必须限制在工作区根目录内。
- 浏览器预览层只负责读取和显示工作区内资源，不允许绕过 MCP 写入 Spine JSON。
- 官方 Web runtime 的 `major.minor` 必须匹配 JSON 的 `skeleton.spine`，当前 `4.1.24` 样本应使用 `4.1.x` runtime。
- WinForms Agent 连接向导只能生成配置片段、检测项目文件和读取握手状态；不得静默写入用户全局 Agent 配置。

## 验证要求

- 修改 TypeScript 代码后运行 `npm run build`。
- 修改核心 JSON 操作逻辑后运行 `npm test`。
- 不要提交或保留 `node_modules/`、`dist/`、`test-output/`、`backups/` 等生成目录。
