# Spine MCP WinForms 观察平台

这是 Spine MCP 的 WinForms 观察壳。它不是动画编辑器，也不是操作主体；它只读取 Agent/MCP 写入的预览会话状态，并展示当前预览画面、操作说明、日志、验证流水线结果和 Agent 连接状态。

## 启动前提

便携版使用 `scripts/publish-observer.ps1` 发布 Windows x64 自包含 exe。双击发布目录的 `SpineMcp.WinFormsObserver.exe` 后选择项目，自动启动随附 runtime 中的预览服务；包内自带 .NET 和 Node，只需安装 WebView2。不能只复制 exe，必须保留 runtime 目录。可传 `--workspace "项目路径"` 跳过目录选择；`--self-test --workspace "测试目录"` 检查随附预览服务与 WebView2，结果写入发布目录 `self-test.json`。退出时仅停止本实例启动的服务。

以下手动启动方式适用于开发版本：

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
- 黄灯：已配置待连接或协议暂未响应。
- 绿灯：进程存活，近期 MCP 协议 ping 成功；历史握手不能保持在线状态。

连接向导支持“一键配置”：默认当前项目，可明确选择 Codex 用户级配置；显示目标路径，确认后备份并合并写入。客户端需要重新加载。完整说明见 [Agent一键配置与实时连接](../../docs/Agent一键配置与实时连接.md)。

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
