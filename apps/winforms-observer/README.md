# Spine MCP WinForms 观察平台

这是 Spine MCP 的 WinForms 观察壳。它不是动画编辑器，也不是操作主体；它只读取 Agent/MCP 写入的预览会话状态，并展示当前预览画面、操作说明、日志、验证流水线结果和 Agent 连接状态。

## 启动前提

先在项目根目录启动预览服务：

```bash
npm run build
npm run preview
```

默认服务地址：

```text
http://127.0.0.1:5177
```

## 运行

推荐从项目根目录使用一键脚本：

```bash
npm run observer
```

脚本会自动执行构建、寻找空闲端口、启动预览服务并打开 WinForms。它只启动观察平台，不写 Spine JSON。

启动后会写入运行态状态文件：

```text
.spine-mcp/observer-runtime.json
```

该文件记录 preview server 端口、URL、PID、WinForms PID 和日志路径，供后续停止脚本或状态面板读取。

停止由脚本启动的观察平台：

```bash
npm run observer:stop
```

先预览将要停止的进程：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-observer.ps1 -DryRun
```

可选参数示例：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-observer.ps1 -Port 5180
powershell -ExecutionPolicy Bypass -File scripts/start-observer.ps1 -SkipBuild
powershell -ExecutionPolicy Bypass -File scripts/start-observer.ps1 -CheckOnly
```

也可以手动运行：

```bash
dotnet run --project apps/winforms-observer/SpineMcp.WinFormsObserver.csproj
```

如果默认 `5177` 端口被占用，可以指定预览服务地址：

```bash
dotnet run --project apps/winforms-observer/SpineMcp.WinFormsObserver.csproj -- --preview-url http://127.0.0.1:5178
```

也可以使用环境变量 `SPINE_PREVIEW_BASE_URL` 设置默认地址。

## 工作方式

1. Agent 通过 MCP 调用 `spine_preview_set_session` 设置当前 JSON、atlas、动画和操作说明。
2. WinForms 每 1.2 秒读取 `/api/session`。
3. WinForms 读取 `/api/agent-connection` 展示 Agent 连接灯和配置片段。
4. WinForms 读取 `.spine-mcp/observer-runtime.json` 展示 preview server PID、WinForms PID、端口、日志路径和停止命令。
5. 如果 `revision` 或预览 URL 变化，WinForms 自动调用 `/api/validation-pipeline`。
6. WinForms 更新文本信息、验证结果，并让 WebView2 载入新预览。

## 运行状态

WinForms 左侧会显示一键启动脚本写入的运行态状态：

- preview server URL、端口和 PID。
- WinForms PID。
- 启动时间和更新时间。
- stdout/stderr 日志路径。
- 停止命令。

辅助按钮：

- `刷新`：重新读取 `.spine-mcp/observer-runtime.json`。
- `复制停止命令`：复制状态文件中的停止命令。
- `打开日志`：打开 `.spine-mcp` 日志目录。

## Agent 连接向导

WinForms 左侧提供 Agent 类型选择和连接诊断：

- `Codex`
- `Claude Code`
- `opencode`
- 自定义 MCP Client

状态灯含义：

- 红灯：未检测到连接。
- 黄灯：检测到项目规则或配置提示，但 Agent 尚未真实调用 MCP 握手。
- 绿灯：对应 Agent 已调用 `spine_agent_ping`，连接确认可用。

连接向导只生成配置片段和诊断提示，不会静默写入用户全局配置。

## 第一版边界

- 不创建动画。
- 不修改关键帧。
- 不编辑 JSON。
- 不调用 MCP 写入工具。
- 不替代 Agent 决策。
- 只观察、展示和预览。
- 不静默修改 Codex、Claude Code、opencode 的用户级配置。

## 依赖

- .NET 9 WindowsDesktop
- Microsoft Edge WebView2 Runtime
- NuGet 包 `Microsoft.Web.WebView2`
