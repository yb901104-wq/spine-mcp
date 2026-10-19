# Agent 一键配置与实时连接

## 使用

在 WinForms 的 Agent 连接区域选择客户端，点击“一键配置”，核对显示的目标路径后确认。Codex 默认推荐用户级配置，Claude Code/opencode 默认项目级；项目级配置必须对应 Agent 打开的、受信任的项目。Codex 项目配置写入成功不保证已出现在桌面的 MCP 列表中。

| 客户端 | 项目配置 | 用户级 |
| --- | --- | --- |
| Codex | `.codex/config.toml` | 明确选择后写入 `CODEX_HOME/config.toml`，未设置 CODEX_HOME 时用 `~/.codex/config.toml` |
| Claude Code | `.mcp.json` | 本版不自动写入 |
| opencode | `opencode.json` | 本版不自动写入 |
| 自定义 | 复制配置 | 本版不自动写入 |

只替换 `spine-json-mcp` 条目，保留其他设置；已有文件保存旁路 `.spine-mcp-<uuid>.bak` 备份。写入前后 hash 校验、独占锁和原子替换防止覆盖并发修改；重复安装相同条目不产生新备份。Codex TOML 会重新序列化，注释保留于备份。检测到 opencode.jsonc 或无效配置时拒绝自动改写，不创建冲突文件。

写入成功后，在客户端打开对应项目并重新加载 MCP；Codex 桌面请完全退出并重开，再检查 MCP 列表。客户端项目信任、MCP 批准仍由客户端决定；写入成功不等于连接成功。软件不启动 Agent 或提交制作任务。观察平台“预览服务正常”仅表示本机服务可用，Agent 是否连接需另看状态灯。

## 实时连接灯

MCP Server 在协议初始化后每 10 秒向客户端发送 MCP `ping`，等待最多 5 秒。ping 由客户端协议实现处理，不需要模型主动调用工具。最近成功响应有效期 25 秒，并检查服务进程是否仍存活。

- 绿灯：进程存活，最近 ping 成功且未过期。
- 黄灯：已配置待连接，或检测暂未响应。
- 红灯：已知连接退出、进程死亡或心跳过期。
- 观察服务不可达：状态未知，不保留此前的绿灯。

绿灯表示 MCP 通道近期可用，不代表模型有网络、正在工作或已完成任务。WinForms 按现有轮询刷新，状态变化存在数秒延迟。`spine_agent_ping` 记录语义身份，必要时修正自动识别的客户端类型，不能凭历史握手变绿。

连接记录位于 `.spine-mcp/connections/<sessionId>.json`，每个 MCP 进程独立记录；多客户端中的一个退出不会把仍在线的另一个连接标为离线。项目切换/显式 projectId 请求会绑定对应工作区，后续心跳更新该工作区记录。

## 本地 HTTP 接口

- `GET /api/agent-config?clientType=codex&scope=project`：检查并返回目标路径、受控配置条目与 expectedHash，不写入。
- `POST /api/agent-config`：JSON 包含 clientType、scope、expectedHash；必须设置 `X-Spine-Config-Action: install`，只允许本机服务与同源请求，写入自动备份。
- `GET /api/agent-connection`：返回各客户端实时灯、最近响应、会话和历史语义握手。

配置安装只在软件明确点击后触发，不作为普通 MCP 动画工具暴露给模型。接口不返回已有完整配置或 API 密钥。

## 验证

测试涵盖 TOML/JSON 合并、备份、过期 hash 拒绝、幂等、JSONC 冲突拒绝、心跳失败恢复、过期、并行会话隔离、真实 MCP 客户端空闲在线和关闭后离线，以及本地 HTTP 安装路径和跨源拒绝。WinForms 构建后可通过 `npm run observer` 启动新版本。

配置依据：[Codex MCP](https://developers.openai.com/codex/mcp)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)、[opencode MCP](https://opencode.ai/docs/mcp-servers/)。
