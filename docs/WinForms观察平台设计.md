# WinForms 观察平台设计

本文档记录未来 WinForms 壳的定位和第一版边界。WinForms 不是动画编辑器，也不是操作主体；它是 Agent/MCP 驱动的验证、观察、日志和预览平台。

## 定位

- Agent 负责理解自然语言、制定操作计划和调用 MCP。
- MCP 负责受控读取、写入、校验、runtime 验证和备份恢复。
- WinForms 负责观察当前上下文、展示操作过程、嵌入预览画面和呈现验证结果。

WinForms 不直接自由编辑 Spine JSON，也不内置动画制作逻辑。

## 正常流程

1. 用户在 Codex/Agent 侧输入自然语言需求。
2. Agent 根据项目规则和 MCP 工具形成操作计划。
3. Agent 调用 MCP 写工具执行 `dryRun` 或真实写入。
4. Agent 调用 `spine_preview_set_session` 设置当前观察上下文：
   - JSON 文件
   - atlas 文件
   - 动画名
   - skin
   - PMA、Mipmaps、播放速度
   - 当前操作说明和日志
5. WinForms 读取 `/api/session` 或 MCP 会话工具，自动更新 UI。
6. WinForms 的 WebView2 区域加载当前预览 URL。
7. Agent 写入后调用 `spine_run_validation_pipeline`，WinForms 展示验证结果。
8. 如果失败，Agent 通过 `spine_list_backups` 和 `spine_restore_backup` 执行恢复；WinForms 只展示过程和结果。

## 第一版界面区域

| 区域 | 内容 | 备注 |
|---|---|---|
| 连接状态 | MCP server、preview server、workspace、当前会话文件 | 用于判断 Agent 和观察平台是否连通。 |
| 运行状态 | preview server 端口、URL、PID、WinForms PID、启动时间、日志路径、停止命令 | 读取 `.spine-mcp/observer-runtime.json`，只观察，不直接杀进程。 |
| 当前上下文 | JSON、atlas、动画、skin、hash、预览参数 | 由 Agent/MCP 设置，不要求用户手动选择。 |
| 预览画面 | WebView2 嵌入浏览器预览页 | 复用现有 `preview/index.html`。 |
| 操作控制台 | 当前自然语言请求、MCP 工具名、dryRun/写入/验证状态、日志 | 读取会话状态和后续日志接口。 |
| 验证结果 | 结构校验、runtime 加载、资源检查、预览 URL | 来源于 `spine_run_validation_pipeline`。 |
| Agent 连接 | Codex、Claude Code、opencode、自定义 MCP Client 的连接灯、配置片段和握手状态 | 读取 `GET /api/agent-connection`，绿灯必须来自真实 MCP 握手。 |
| 备份观察 | 备份列表、备份 hash、备份校验状态、恢复 dryRun 结果 | 恢复动作仍由 Agent/MCP 发起。 |
| 连接文档 | Codex MCP 配置片段、AGENTS.md、MCP 操作清单、安全流程入口 | 方便复制和排查连接问题。 |

## 第一版能力

- 自动展示 Agent 设置的当前预览会话。
- 自动刷新预览画面。
- 展示一键启动脚本写入的运行态状态，并提供复制停止命令和打开日志目录。
- 展示 Agent 操作说明和日志。
- 展示验证流水线结果。
- 展示 Agent 连接向导，可选择 `Codex`、`Claude Code`、`opencode` 或自定义 MCP Client，复制对应配置片段，并通过握手状态显示红/黄/绿灯。
- 展示备份列表和恢复预检结果。
- 提供复制预览 URL、复制文件 hash、打开工作区目录等辅助动作。

## 当前实现

当前最小实现位于：

```text
apps/winforms-observer/
```

第一版已实现：

- 轮询 `GET /api/session`。
- 展示连接状态、当前上下文、Agent 操作说明和日志。
- 读取 `.spine-mcp/observer-runtime.json`，展示 preview server PID/URL、WinForms PID、启动时间、日志路径和停止命令。
- 展示 Agent 连接状态、配置片段和握手提示。
- 会话变化时调用 `GET /api/validation-pipeline`，展示结构校验、官方 runtime 读取和预览 URL 生成结果。
- 使用 WebView2 自动载入 `previewUrl.url`。
- 支持复制当前预览 URL 和外部浏览器打开。

启动方式：

```bash
npm run observer
```

该命令会调用 `scripts/start-observer.ps1`，自动构建项目、选择空闲端口、启动浏览器预览服务并打开 WinForms。脚本只启动观察和验证链路，不写 Spine JSON。

启动脚本会写入运行态状态文件：

```text
.spine-mcp/observer-runtime.json
```

该文件记录当前观察平台的 preview server 端口、URL、PID、WinForms PID、启动时间和日志路径。它属于运行态文件，不应提交。

停止由脚本启动的观察平台：

```bash
npm run observer:stop
```

停止脚本 `scripts/stop-observer.ps1` 只读取运行态状态文件中记录的 PID，并校验进程名后停止；可用 `-DryRun` 预览将要停止的进程。

也可以手动启动：

```bash
dotnet run --project apps/winforms-observer/SpineMcp.WinFormsObserver.csproj
```

如果预览服务不在默认 `http://127.0.0.1:5177`，可通过启动参数指定：

```bash
dotnet run --project apps/winforms-observer/SpineMcp.WinFormsObserver.csproj -- --preview-url http://127.0.0.1:5178
```

也可以通过环境变量 `SPINE_PREVIEW_BASE_URL` 设置默认地址。

脚本参数：

- `-Port 5180`：指定预览服务端口；不传时自动从 `5177-5199` 中选择空闲端口。
- `-SkipBuild`：跳过 `npm run build` 和 `dotnet build`。
- `-CheckOnly`：只检查路径和端口，不启动进程。
- `-NoPreview`：不启动浏览器预览服务。
- `-NoWinForms`：不启动 WinForms。
- `-StopExistingObserver`：启动前关闭已有 `SpineMcp.WinFormsObserver` 进程。

停止脚本参数：

- `-DryRun`：只显示将要停止的进程，不真正停止。
- `-PreviewOnly`：只停止记录的 preview server。
- `-WinFormsOnly`：只停止记录的 WinForms。
- `-StatePath <path>`：指定运行态状态文件路径。

## 第一版不做

- 不创建动画。
- 不修改关键帧。
- 不编辑 JSON。
- 不修改骨骼、插槽、皮肤、mesh/deform、constraints、events。
- 不实现自然语言理解。
- 不绕过 MCP 调用 TypeScript 写入逻辑。

## 会话状态接口

当前会话状态由 MCP 写入工作区运行态文件：

```text
.spine-mcp/preview-session.json
```

相关 MCP 工具：

- `spine_preview_set_session`
- `spine_preview_get_session`
- `spine_preview_clear_session`

相关 HTTP API：

- `GET /api/session`
- `GET /api/agent-connection?clientType=codex`

WinForms 应优先读取 `/api/session`，并把其中的 `previewUrl.url` 载入 WebView2。

## Agent 连接向导

连接向导不负责直接编辑 JSON，也不静默写入用户全局 Agent 配置。它只做三件事：

1. 根据 Agent 类型生成 MCP 配置片段。
2. 检测项目内规则文件和构建产物是否存在。
3. 读取 `.spine-mcp/agent-handshake.json`，判断对应 Agent 是否真实调用过 `spine_agent_ping`。

状态灯含义：

- 红灯：未检测到项目规则或 Agent 握手。
- 黄灯：检测到项目规则或配置提示，但 Agent 尚未握手。
- 绿灯：对应 Agent 已经通过 MCP 调用 `spine_agent_ping`。

第一版支持的 Agent 类型：

- `Codex`
- `Claude Code`
- `opencode`
- 自定义 MCP Client
