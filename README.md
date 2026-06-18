# Spine JSON MCP

这是一个 TypeScript MCP 服务器，用于受控地读取、校验和修改 Spine `4.1.24` 导出的 JSON 文件。第一版聚焦动画时间线，不直接修改 setup pose、骨骼结构、插槽结构或皮肤资源结构。

## 安装与构建

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

WinForms 观察平台会根据握手状态显示 Agent 连接绿灯。未握手但检测到项目规则时显示黄灯；未检测到连接时显示红灯。

完整 MCP 操作列表见 [docs/MCP操作清单.md](D:/AI_cc/spine-mcp/docs/MCP操作清单.md)。

官方 JSON 规范审查说明见 [docs/官方JSON规范审查.md](D:/AI_cc/spine-mcp/docs/官方JSON规范审查.md)。自然语言验证用例见 [docs/自然语言验证用例.md](D:/AI_cc/spine-mcp/docs/自然语言验证用例.md)。安全提交流程见 [docs/安全提交流程.md](D:/AI_cc/spine-mcp/docs/安全提交流程.md)。浏览器预览说明见 [docs/浏览器预览系统.md](D:/AI_cc/spine-mcp/docs/浏览器预览系统.md)。WinForms 观察平台设计见 [docs/WinForms观察平台设计.md](D:/AI_cc/spine-mcp/docs/WinForms观察平台设计.md)。

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
