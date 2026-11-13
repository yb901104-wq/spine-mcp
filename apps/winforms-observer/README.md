# Spine MCP WinForms 观察平台


本轮新增校准连续性诊断 GIF/联系图，不需要先批准正式 motion。实际浏览器已验证播放/暂停/拖动/阶段定位，仍不等于本轮 WinForms/WebView2 发行包验收。
## 2026-10-26 创作工具续建

当前 115 个 MCP 工具。区间编辑和单臂独立校准/审查已接通，Host 网页增加只读播放、暂停、拖动与关键姿态定位；本轮实际浏览器已验证播放、暂停、时间控件及阶段定位，新 WinForms/WebView2 包仍未验收。新增 Node 隔离试用包不是 WinForms 便携发行包。

包内运行 `node scripts/run-creation-trial.mjs --verify-only` 核对构建；手动准备依赖后，用 --workspace 指向正式 MCP 生成的隔离副本，恢复须 --resume。原观察平台启动参数不变。自动端口遇 Windows 保留范围或占用会有界重选，显式 --port 不改，默认本机监听及生产审批不变。

2026-10-26 独立诊断续建：网页显示内存草稿、来源和拟保存路径，Agent 通过 newStage 显式开启新上下文、通过 spine_resume_diagnostic_pose 恢复；页面不写姿态或清单。恢复使用原隔离 --resume 启动后再由 MCP 预演/执行。当前 112 工具，不因本批源码与浏览器验证宣称便携包已发布。

2026-10-26 续建：当前 MCP 112 工具；参考准备可不启动观察页面，正式动作级记录与新参考登记由 MCP 完成。任务可按完整版本继续已保存修订，Host 页面沿用原三图/失联规则；本批未生成新的 WinForms 发行包或改变启动参数。

2026-10-26：Host 网页增加任务创作检查、参考/当前/前次诊断图与构建/profile 显示；操作继续经过 MCP。源码更新未打包为新的 WinForms 便携版本，本批浏览器验收不能替代新的 WebView2/桌面包验收。

隔离试用先通过 `spine_start_creation_task` 的 `isolatedDirectory` 创建副本，再从项目目录执行 `npm run host:creation -- --workspace "返回的 workspaceRoot" --isolated`。默认本机随机端口，可加 `--port`；遇到旧 journal 先查看来源/差异，显式 `--resume` 才恢复。该入口不改变原观察平台启动参数或生产 C1/长期观察审批，连接向导不写用户全局配置。详见 [专项工单](../../docs/plans/creation-usability.md)。

2026-10-24 性能复验使用 `npx tsx scripts/benchmark-host-real-animation.ts <真实桌面报告路径> --stdio --isolated-host`，连续三轮后用 `scripts/summarize-host-real-animation-performance.ts` 传入三份报告汇总。测试驱动、编译版 Host 与 MCP 独立进程，记录两端构建指纹和 worker 退出；内部 worker 必须由 IPC 启动且核验隔离报告，不是生产 C2 入口。90 样本逐轮通过，state/frame P95 12.39/25.51ms；203 项回归、实际 npc1 与合成源事务各 29 项桌面检查通过，优化前后像素一致。[本批证据](../../docs/plans/host-state-performance-closeout-20261024.json)。生产默认观察，旧便携包不变。

实际资源候选自检可用 `--real-animation-candidate`，复制已批准 npc1 站姿到独立工程，仅生成固定站姿候选及当前 player，不新增动作批准或写入真实角色源。最新 [29 项报告](../../docs/plans/host-winforms-2026-10-23T19-46-36-278Z.json) 输入未变；这不替代完整新动作或第二角色。资源性能复跑：`npx tsx scripts/benchmark-host-real-animation.ts <该真实桌面报告路径> --stdio`，候选在独立编译版 MCP 子进程计算，state/frame 仍测 HostClient；源码与 dist 应匹配。当前真实 state 超预算，生产仍观察。

2026-10-24 C2-4c 开发自检：先运行 `npm run build` 和本应用 `dotnet build`，再运行 `npx tsx scripts/acceptance-winforms-host.ts --animation-candidate`。它只在独立合成工程制作精确拟合动画、通过实际 WebView2 当前 player 截图和重连，再验证完整审查及备份/原子源提交，结束释放测试 Writer；不能开启生产 C2。29 项通过不代表真实美术或 Spine 导入，[报告](../../docs/plans/host-winforms-2026-10-23T19-45-46-267Z.json)。源码及默认 C1 观察边界保持，旧便携包未更新。

2026-10-24 C2-4b 已接通，构建及 189/189 回归通过。高级 MCP 工具暂存候选后独立 Host asset commit 保存，观察文档不自动切换；Agent 显式打开新 pose/motion 后按原页面回放。未新增 WinForms 写入按钮、生产开关或本批真实桌面验收，C2-4c、真实美术和编辑器导入仍待完成。见 [主工单](../../docs/plans/host-evolution.md)。

C2-4a 追加：四个既有姿态命令已在隔离 C2 attached 中适配内存，完整版本必填，保存独立。最新 TypeScript 回归 180/180，真实桌面组合姿态仅作诊断验证，数值失败保持失败；27 项桌面检查不代表真实美术通过。开发自检可运行 `npx tsx scripts/acceptance-winforms-host.ts --pose-commands`，它只在合成夹具取得测试 Writer、编辑后释放并回到观察模式，保留 player 截图与失败诊断；不能开启生产写入。旧便携包不变。[本批证据](../../docs/plans/host-c2-pose-commands-20261023.json)。

2026-10-23 C2-1～3 已在隔离服务实现，实际能力由 Host `capabilities.editing/viewing` 声明；WinForms 观察页显示 Agent 显式选择的 motion/skeleton 动画/时间或 setup 及采样状态，不提供 C2 切换、批准或新编辑面板。175 项 TypeScript 回归通过，真实 WebView2 合成场景不代替真实美术、第二角色或编辑器导入验收。C1 固定候选独立采样，已保留一次未知退出，中断不补时。启动脚本、默认端口及旧便携包不变。[C2-3 记录](../../docs/plans/host-c2-playback-20261023.json)、[前两批](../../docs/plans/host-c2-pose-20261023.json)、[观察操作](../../docs/Host长期观察与启用流程.md)。

动画观察开发自检：`npx tsx scripts/acceptance-winforms-host.ts --playback=skeleton`，另可指定 `motion` 或 `setup`。只在合成隔离工程构造 C2 profile，真实桌面核对所选标签、采样状态和当前 player 截图/恢复；不能用于开启生产写入。先运行 TypeScript 构建与本应用的 dotnet build。

2026-10-23 新增长期观察状态：Host 页显示采集中次数、未启动或记录错误，通过 `observation-updated` 仅刷新状态。采样由独立 Host 持续执行，切走或卸载 WebView 不停止；退出 Host/休眠不补时。平台不读取 control 或生成审批。CLI、限定启用变量 `SPINE_HOST_WRITE`/`SPINE_HOST_ROLLOUT_APPROVAL` 与安全关闭见 [操作流程](../../docs/Host长期观察与启用流程.md)，原启动脚本、默认端口不变，生产写入仍关闭，旧便携包未更新。

新增后的 [真实桌面 28 项](../../docs/plans/host-winforms-2026-10-23T09-53-17-726Z.json) 通过，重载 P95 105.65ms、实际 MCP/player 截图完整回传 383.35ms，观察状态已查看，输入/版本及重连像素一致。完整回归 160/160；编辑首轮轻微超预算仍待收敛，长期试运行已启动，无生产启用，见 [最新索引](../../docs/plans/host-c1-observation-implementation-20261023.json)。

2026-10-23 前一轮技术基线：底层异步严格路径调度后，[真实站姿 28 项报告](../../docs/plans/host-winforms-2026-10-23T09-00-42-744Z.json) 再次通过，30 次热重载 P95 95.42ms、30 次实际 stdio/player 960 截图完整回传 344.60ms，状态事件零重复 frame。该轮完整 TypeScript 回归 154/154 通过。

2026-10-23 性能续验：构建后运行 `npx tsx scripts/acceptance-winforms-host.ts --real-c1 --benchmark-host`，使用已验收 npc1 站姿的新隔离副本。30 次实际重载 P95 108.20ms、30 次 MCP stdio 到当前 WebView2 player 的 960 截图完整回传 P95 364.90ms；28 项检查通过，截图状态事件零重复取帧，重连界面无截图限流错误。页面已合并同版本重复刷新；手动刷新仍重新读取，服务端 20/s 限流及视觉门禁不变。[正式报告](../../docs/plans/host-winforms-2026-10-23T07-51-03-249Z.json)。这是源码自检能力，旧便携包未升级。

2026-10-23：底层 Host 逐操作 readiness 已细分未打开、缺 pin、stale、串行事务 busy 与写入冻结；截图就绪不覆盖其它阻塞。平台观察权限及启动参数不变，旧便携包未升级。短时现场审计可运行 `npx tsx scripts/audit-host-observation.ts`，使用已验收 npc1 站姿的新隔离副本，生成独立报告并结束临时服务；该命令不是长期自动化，也不满足两周观察条件。

同日进一步接通更新后 MCP evaluate 的外部任务状态：页面显示计算中、完成、失败、取消或心跳失联，每 5 秒由 MCP 续期，15 秒失联保持状态待核对。活动期间页面每秒仅更新状态，切走/最小化不取消 MCP；页面不能登记任务或操作租约。旧 Host 缺少内部端点会明确提示版本不匹配，需要重启匹配源码。实际桌面 23 项自检与全量 147 项回归通过，便携包尚未重打包。

底层预览资源校验支持显式文件省略动画，此时只检查资源/runtime/适用皮肤，不继承示例动画、不生成动画联系图，也不表示动作通过。该规则同步覆盖 MCP 与预览 HTTP，不改变桌面启动参数或连接流程。当前不采用 `exp/xiaoren` 的身体部件拆分皮肤案例作为第二角色验收。

这是 Spine MCP 的 WinForms 观察壳。它不是动画编辑器，也不是操作主体；它只读取 Agent/MCP 写入的预览会话状态，并展示当前预览画面、操作说明、日志、验证流水线结果和 Agent 连接状态。

## Host v1.8 源码进展与 WinForms 边界

2026-10-22 已在源码加入“动画预览 / Host 工作台”双页签，合成夹具自检通过 23 项，真实 npc1 无参考站姿隔离联调通过 25 项。便携发布包仍未重新打包，旧 exe 不自动升级。完整状态见 [实施与验收](../../docs/Host实施与验收-20261021.md)。

[动画工作区主工单](../../docs/plans/host-evolution.md) 定义独立工程/会话内核，WinForms 继续负责观察。Host 页复用既有页面和版本/审查状态，左侧明确区分旧预览会话日志与当前 Host 状态；C2 的完整能力面板仍待后续扩展。截图分层已确认并实现，连接成功不代表可写、动作通过或编辑器导入通过。

选择“Host 工作台”时，从当前本机预览服务的 `/api/config` 确定工作区，再核对 `.spine-mcp/host-port.json` 与实际 Host 的 API/session/instance/startedAt/project 身份。只读取观察发现文件，不读取 `host-control.json`；URL 不含 token，不启动、停止或接管 Host。没有服务时提示由 Agent 打开。原启动脚本、预览端口策略和 Agent 配置流程未改；Host 仍为本机独立高端口服务，公开写入保持关闭。

切到旧预览或最小化时卸载 Host 页面，`pagehide` 上报 hidden；切回或还原后重新核对并加载当前状态，不复用旧 DOM。文档、revision、历史和相机仍由 Host 保留。不能只依赖 WebView2 控件 Visible 或 DOM visibilityState，实测它们不总随页签同步。外部导航、新窗口及根外 HTTP 资源被阻止；未启用原生对象/WebMessage 桥。

构建与隔离自检：

```powershell
dotnet build apps/winforms-observer/SpineMcp.WinFormsObserver.csproj --no-restore
npx tsx scripts/acceptance-winforms-host.ts
npx tsx scripts/acceptance-winforms-host.ts --real-c1
```

自检会启动真实旧预览服务、观察 Host 和 WebView2，在合成夹具中验证身份负例、后台卸载、最小化恢复、来源限制、重连及浏览器退出，生成独立时间戳报告和诊断图；不自动批准姿态。需要正常桌面进程权限；受限进程的 WebView2 导航失败不能当成功。自检内部使用显式 `--host-self-test --workspace ... --preview-url ... --report ... --screenshot ...`，输出必须在该隔离工作区内且不得覆盖已有文件。原 `--self-test` 便携启动检测保持独立。

`--real-c1` 另复制已验收站姿工程 `D:/AI_cc/spine test/host-acceptance/2026-10-22T02-18-08-219Z` 中的资源与证据到新目录；缺少该工程时明确失败。先复验已保存姿态，观察模式显式发布快照求解，再用真实 MCP stdio 请求桌面页面两次采集。内部 `--capture-checkpoints` 只在自检模式等候固定检查点文件，不向页面开放原生桥。两张 960² 官方 player 图分别核验资源/runtime/完整版本/相机，解码像素必须完全一致；原工程与隔离输入逐文件核对 SHA-256，既有审查再次独立复验。新图只取得证据准入，不自动新增批准。`CapturePreview` 的界面诊断图仍为 `evidenceEligible:false`。

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
2. WinForms 每 1.2 秒读取 `/api/session`，在「会话」页显示当前工作区、动画和操作信息。
3. WinForms 读取 `/api/agent-connection` 展示 Agent 连接灯和配置片段。
4. WinForms 读取 `.spine-mcp/observer-runtime.json` 展示 preview server PID、WinForms PID、端口、日志路径和停止命令。
5. 会话修订或预览 URL 变化后，WinForms 自动验证。WebView2 自行同步播放上下文和资源哈希，按动画范围和窗口大小等比取景。日志更新可以保持当前播放进度。
6. 左侧「会话」「连接」「日志」可分别查看。内容较长时可在对应页面纵向滚动。

MCP 程序可以安装在独立目录。让 Agent 的 MCP 工作区与「会话」页显示的工作区一致，角色文件可以放在这个根目录的子目录中。正常调用后会自动更新，「刷新会话」用于手动重连。

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
