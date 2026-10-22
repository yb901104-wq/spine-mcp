# WinForms 观察平台设计

## 独立 Host 相机续验（2026-10-22）

独立浏览器 Host 的相机在首次可信回放时容纳完整可见角色并留 5% 边距，之后同一 openEpoch 的编辑/撤销固定；新打开或显式重载才初始化新相机。新 WinForms 源码的 Host 页消费同一相机和版本状态，不自行逐帧缩放或沿用旧截图批准。真实 npc1 单手闭环在独立浏览器验收；桌面集成另用合成夹具实测，便携包尚未重新发布，公开写入仍关闭。见 [实施验收](Host实施与验收-20261021.md)。

## 双页签观察连接已实现（2026-10-22）

右侧新增“动画预览 / Host 工作台”，后者复用当前 Host 页面，显示当前工程、文档、修订、写入模式、资源/数值及截图/视觉/导入状态。Host 页选中时，左侧上下文明确指向 Host，旧日志注明预览服务会话；复制/外部打开使用对应页签的无凭据 URL。旧预览上下文不冒充 Host 真相。

连接从本机 `127.0.0.1` 预览服务 `/api/config` 取得工作区，仅读取该根内非链接的观察发现文件，核对实际 API/session/instance/startedAt/project 身份与进程存活。原生 HTTP 不跟随重定向；没有服务时不自动启动，不取得写入权，不读取控制文件或改全局配置。WebView2 无原生对象或 WebMessage 桥，限制导航和 HTTP 资源来源。

实测控件隐藏并不总让 `document.visibilityState` 变 hidden，因此离开 Host 页或最小化时导航到空白页，卸载 player/SSE；页面 pagehide 停止心跳、上报 hidden，并阻止卸载后继续采集。还原或切回时重新核对身份、加载当前状态。浏览器 DOM 会更新，Host 文档 epoch/revision、历史与相机不因此变化。失联或发现文件错误时清除旧页面，不保留成功连接外观。

真实 WinForms/WebView2 23 项自检通过，包括 11 个发现负例、后台卸载/服务实际收到 hidden、最小化恢复、外部导航拒绝及正确重连；等待测试浏览器进程退出后才清理 profile。报告见 [桌面自检](plans/host-winforms-2026-10-22T09-52-01-207Z.json)。诊断图没有 MCP 证据准入资格，不替代真实美术角色或编辑器导入。开发构建已可用，旧便携包未升级。

## Host 会话演进与当前边界（v1.8）

当前独立 Host 的实现和阻塞见 [实施与验收](Host实施与验收-20261021.md)。基本连接/页面嵌入以上述源码实现为准；下列完整创作能力面板与 C2 约束仍按阶段扩展，旧便携包不自动升级。

当前核心计划见 [动画工作区 Host 主工单](plans/host-evolution.md)。工作区宿主承担应用内核，WinForms 继续作为观察与预览壳；B 阶段不迁移资产写入，C1 先做单 pose 闭环，C2 再扩大创作面。Host 在线与 attached 写入模式分别展示，不能由绿灯推断可写或审查通过。

- 会话展示使用 Host 完整文档版本区分切换、重载、恢复与重启；同路径幂等 open 不清栈，磁盘漂移不能被“刷新”消除。
- 展示当前求解/比较/证据的新鲜度与完整显示状态；MCP 快照求解结果未回传时明确缺失/过期，不继续把旧画面标为当前画面。
- 页面凭据仅用于允许的交互；求解结果发布和候选授权使用 MCP 独立控制凭据，不注入 WebView2 页面。平台不能自填通过状态来授权提交。
- 失联显示 frozen/degraded 并停止写操作。只有排他写入权交接确认后才恢复 detached；停止或切换工程不能仅凭 shutdown 的 202 响应宣称已完成。
- 后续信息区显示受管/legacy 工程、当前角色与文档、能力来源、逐操作 readiness、实际节点及分层审查状态；无 activeDoc 时也能展示工程概览，不默选 defaults 或自动 pin。
- 受 weapon 控制、缺切片/校准、计算忙碌和结果 stale 分别展示原因与有效下一步；下一步工具尚未实现时显示文字说明，不提供无效执行按钮。界面不直接写 manifest 或角色 JSON。
- 截图分层已于 2026-10-21 确认：后续分别显示 rendererParity、captureValidity、evidenceEligible，不能把截图准入、预览完成或绿色指标自动升级为批准；数据结构以主工单 §3.7–§3.9 为准。

上述事务与审查规则不因页面嵌入而改变；连接向导、启动脚本和旧便携包没有随本次页签实现修改。

## 参考与姿态审查

新增姿态工具复用现有 session 操作日志与产物路径，报告处理成功/失败；离线参考节点图、关键姿态上下对比和 GIF 通过产物入口查看。第一版不增加骨骼拖拽编辑器，日志“完成”只代表工具执行完成，不能代替 Agent 视觉批准。新工具已在源码 MCP server 注册，旧启动进程及旧便携发布包需更新后才可调用。

WebView2 预览的 PMA 勾选通过预览服务生成对应的内存纹理，并使用官方 Player rawDataURIs；保留源 atlas/PNG。切换选项会重建播放器，销毁旧实例，避免残留 WebGL 上下文。

便携发布由 `scripts/publish-observer.ps1` 构建自包含 Windows x64 exe，并打包 Node、dist、preview 与生产依赖。exe 启动时选择项目或读取 --workspace，按可用端口自动启动本实例预览服务、检查工作区匹配后进入主窗口。关闭窗口停止自身预览子进程；开发目录无 runtime 时沿用外部服务方式。运行仍需 WebView2，支持 --self-test 输出 headless 启动检测报告。

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
| Agent 连接 | 客户端连接灯、一键配置、历史语义握手 | 读取 `GET /api/agent-connection`，绿灯必须来自近期 MCP 协议 ping。 |
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

Codex 桌面入口默认推荐用户级并提示完全退出重开，其他客户端默认项目级。预览服务状态与 Agent 状态分别显示。无会话时从当前项目内根目录、目标或 characters 中查找配套 JSON/atlas；空项目显示路径选择提示，不带入不存在的开发示例文件。

连接向导支持配置安装和实时协议检测，不修改角色 JSON：

1. 根据 Agent 类型生成 MCP 配置片段。
2. 检测项目内规则文件和构建产物是否存在。
3. 用户明确点击“一键配置”并核对路径后，备份、合并并写入当前项目配置；另可明确选择 Codex 用户级配置。
4. 读取历史语义握手与实时 MCP 协议心跳记录，分别显示身份与在线状态。

状态灯含义：

- 红灯：连接离线、进程死亡或心跳过期。
- 黄灯：待连接或暂未响应。
- 绿灯：进程存活，近期 MCP 协议 ping 成功；不是模型工作状态。

检测每 10 秒执行，超时 5 秒，有效期 25 秒；多进程会话隔离。接口、备份与配置范围见 [Agent一键配置与实时连接](Agent一键配置与实时连接.md)。

第一版支持的 Agent 类型：

- `Codex`
- `Claude Code`
- `opencode`
- 自定义 MCP Client

## 离线视觉验证与项目工作区升级
新增离线 PNG 帧、联系图、GIF、参考 GIF 分析、对比报告及 projectId/MCP Roots 支持。默认重定向生成数值报告和联系图；Agent 查看后提交。详细工具、参数、局部调整、缓存/锁和已知验证边界见 [离线视觉验证与工作区](D:/AI_cc/spine-mcp/docs/离线视觉验证与工作区.md)。


## 视觉绑定与关系审查状态

本轮继续复用观察平台的 MCP 会话日志与产物路径：校准返回 visual-rig-calibration.json、角色图、切片图、节点图；参考比较返回逐项错误报告。没有新增拖拽编辑器，也未重新发布便携 exe。日志中的操作完成只表示产物生成，不能表示动作参考关系通过；必须分别读取绑定、关系、视觉与 runtime 状态。

## 动作身份与转身诊断

观察平台继续使用现有预览和日志展示姿态产物。报告新增持杖解剖手、身体切片视角及实际遮挡层序的独立状态。附件显隐和drawOrder仅经动画核心/MCP时间线计算，不由WinForms重绑定切片；背发显隐候选不自动标记为转身验收通过。当前npc1三姿态实例仍为退回诊断。

## C1 审查桥接实施补充（2026-10-21）

独立 Host 已接入 spine_review_pose 的完整版本/当前 player 证据及 review-updated 状态。默认审查预演不改变批准，正式记录才更新；截图或报告变化显示 stale，不能保留绿色批准。新 WinForms Host 页只消费这些状态，不持有控制凭据或自行填写通过字段；旧便携 exe 仍未更新。

0.2.0 的独立 Host 在 shutdown 受理后拒绝新修改，等待已排队事务与写入锁释放，再关闭服务、删除本实例发现文件。MCP 工程切换还会确认上述结果，超时保持冻结；202 不作交接完成回执。现有 WinForms 连接绿灯不代替这项确认，旧 exe 尚未增加新 Host 的切换界面。
