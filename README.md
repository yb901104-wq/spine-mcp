# Spine JSON MCP


校准工具现默认生成 33 帧、2 秒的批准前诊断扫掠 GIF 与联系图（sweepFrames/sweepDuration 可显式选择），固定分支逐帧回读；它不创建正式 motion。正式校准还须当前连续性诊断数值通过、产物哈希一致及独立视觉审查。手部补偿局部倍率可大于 1，但只能在 Host 从实际校准样本生成的三段臂链回放范围内；世界段长比仍不大于 1，旧诊断范围不扩大。
## 2026-10-26 区间编辑与投影校准续建

当前 **115 个 MCP 工具**。新增 `spine_edit_motion_interval`、`spine_calibrate_arm_perspective`、`spine_review_arm_perspective`。隔离 C2 可对 v2 motion 的明确区间编辑、撤销和备份另存；边界与区间外保持，已审查关键姿态须用批准修订替换。Host 提供只读本地播放、暂停、时间拖动与关键姿态定位，播放不产生批准。

单臂新增独立 `calibration` 样本诊断及 `calibrated` 正式校准模式。`upper/lower` 是相对基准的实际世界段长比，由 runtime 求解局部 scale；校准绑定角色、切片、基准、分支、样本和精确哈希。宽度未校准保持 1，旧 `diagnostic` 批准不迁移。npc1 新建的固定身体/视向/分支、0.85–1 范围已通过 4 张真实 player 和 33 帧连续性独立审查，受限试用 motion 已播放并经官方 4.1.24 导入保存；此前 0.55–1 范围退回，原 GIF 未批准。最终构建 233/233 回归通过，性能与隔离包见[本轮汇总](docs/plans/creation-completion-implementation-20261027.json)。

自动端口遇占用或 Windows 保留端口（EACCES）会有界重选，显式 `--port` 失败仍报错。隔离试用包可通过 `node scripts/package-creation-trial.mjs <新输出目录>` 生成；包内 `node scripts/run-creation-trial.mjs --verify-only` 验字节，依赖需手动 `npm ci --omit=dev`，启动参数和恢复选择仍走正式隔离入口。源码/包与真实验收分开记录，见[专项工单](docs/plans/creation-usability.md)。

## 2026-10-26 创作工作流专项

新阶段参考适配失败时，可显式使用 `spine_retarget_reference_pose{diagnosticMode:"newStage",expectedRevision,…}`：默认预演，`dryRun:false` 打开独立内存草稿，不改原文档绑定、不创建拟保存的姿态文件。新草稿需重新 pin，再通过原编辑/看图/撤销工具继续；失败不能批准或提交。`spine_get_creation_task.diagnosticContexts` 可找回上下文，重启隔离 Host 后先 `spine_resume_diagnostic_pose{diagnosticId}` 查看来源/差异，再显式 false 恢复。逻辑路径不是磁盘资产；已保存后应打开真实输出，不恢复旧草稿。

[专项工单](docs/plans/creation-usability.md) 已施工：受管任务冻结/隔离副本、阶段选择、调用计量、默认摘要与按需完整返回、任务工具目录、角色准备/一次求解预检、受控身体意图，以及同绑定失败候选的内存修正。此前本批工具总数 **112**；最新为上述 **115**。生产默认 C1 不变，npc1 仅上述窄范围取得独立校准批准，完整原 GIF 动作尚未交付。

新参考入口：`spine_start_creation_task` 可省略 `stages`，先冻结角色和原图/GIF；正式拆帧、标注、参考审查及视觉绑定审查完成后，`spine_create_pose_sequence` 以显式左右对应创建新动作记录（默认 dryRun）。新序列可由 `spine_start_creation_task{isolatedDirectory,sequencePath,stages:[]}` 在**全新隔离副本**登记，拒绝在原清单原地换绑。该记录不批准目标动作，已有阶段也不会自动改用它。

已有任务保存新修订后，`spine_get_creation_task.stageContexts` 列出经 journal 核验的候选；`spine_select_creation_stage{taskId,stageId,documentPath,expectedRevision}` 可继续该修订。跨姿态来源族、改绑定或哈希不符均拒绝；原冻结记录不覆盖。新修订再隔离时显式写入新清单，不复制旧 journal。动态目录隐藏的工具不会直接出现在下一步建议中。

常用入口：`spine_start_creation_task` → `spine_select_creation_stage` → 按 readiness 调用原有 pin/重算/编辑/查看/撤销/commit；`spine_get_creation_task` 读取任务及成本。新参考仍需正式标注与逐项审查，不自动生成批准。Host 面板分别展示参考失败及编辑/审查/组装/提交资格，`responseDetail:"full"` 可取得完整 Host 数据。

任务可用 `isolatedDirectory` 在当前工作区内创建新的受管副本，只复制声明资源和证据，不复制旧 Writer/journal/连接配置。随后启动：

```powershell
npm run build
npm run host:creation -- --workspace "任务返回的隔离 workspaceRoot" --isolated
```

存在旧 journal 时拒绝冒充新会话；先查看来源/差异，再显式加 `--resume`，或创建另一个隔离副本。该入口只授予隔离 C2 试用，不满足生产启用审批；连接向导仍不写全局配置。默认随机本机端口，可用 `--port` 明确指定。

默认静态工具表兼容既有客户端。`spine_get_tool_catalog` 按任务查询目录；只有显式 `SPINE_MCP_TOOL_DISCOVERY=dynamic` 才可用 `spine_set_tool_groups` 改连接可见组，需另验目标客户端的列表更新。比较策略升级为 v4：腕位、站距、握距等统一按躯干长归一；旧比较/批准须重验，v3 历史不改写。

同日后续：按用户要求将部件观测改为“可靠轮廓与误差圆优先，遮挡时回退两点连线并输出近似方向”，不因缺轮廓而无结果；不编造未知坐标或半径。当前构建及 **213/213** 完整回归通过；[真实参考回退复测](docs/plans/reference-fallback-20261025.json)。与成熟类似 MCP 的差距已按当前源码重新分类，见 [逐项复查与收尾方向](docs/MCP差距逐项复查与收尾方向-20261025.md)。下文 212 项是首轮缩放诊断批次。

2026-10-25：新增身体部件观测与单臂透视缩放诊断，工具共 **102** 个，最终构建及 **212/212** 回归通过。`spine_analyze_reference_parts` 分析关节误差圆与轮廓主轴；`spine_adjust_pose` 的 `frame.perspective` 和隔离 C2 `setPosePerspective` 接通实际 runtime、Host 回放及撤销。真实 npc1 温和缩短数值通过，强缩短失败保留；三张官方 player 均完成截图核验，源输入未变。能力仅诊断，不能批准为正式姿态或提交源动画，完整参考动作仍未交付。[实现、用法与边界](docs/身体部件观测与透视缩放-20261025.md)。下文 101 个工具及性能均为对应旧批次。

2026-10-24 state 性能已在实际部署范围内收敛：测试驱动、Host、MCP 独立进程，实际 npc1 固定站姿候选三轮 90 样本全部通过原预算，严格 HostClient state P95 **12.39ms**、frame P95 **25.51ms**。构建及 **203/203** 回归通过，真实 npc1 和合成源事务的 WebView2 各 29 项通过，优化前后 player 像素一致。发现文件并发读取、请求内真实身份去重、固定请求根及已核验 runtime 复用均保留原门禁。[本批证据](docs/plans/host-state-performance-closeout-20261024.json)。

此前 28.52ms 及中间混进程第三轮 24.31ms 的失败记录保留；新结果不覆盖旧构建或其它测量拓扑。第二完整真实角色、Spine 编辑器导入、完整真实动作及实际两周观察/人工启用仍未齐，整工单尚未验收，生产保持观察。

2026-10-24 C2-4c 工程链路已隔离接通：`spine_retarget_motion` 用当前完整版本制作精确 4.1.24 拟合候选、原速 GIF 和姿态联系图；准备令牌不代表批准。`spine_review_animation` 还须当前 player manifest 与五项独立理由。显式 `spine_host_pin{intent:"animation"}` 后，`spine_host_commit{intent:"animation",animationCandidateHash,expectedHash,reviewToken,outputPath,requestId,dryRun:false}` 才经 MCP 复验及 Host 备份/原子替换单个动画。motion、mapping 和校准报告原字节不改，后续只认可已确认 journal/备份的动画来源链。构建及 **198/198 回归通过**，实际 WebView2 **29 项**合成链路通过；[桌面证据](docs/plans/host-winforms-2026-10-23T19-45-46-267Z.json)。真实美术、第二完整角色、Spine 编辑器导入、真实负载性能及两周观察仍待验；生产继续 C1 观察，D 按原条件评估。下文均按各自日期追溯。

2026-10-24 C2-4b 资产流程已隔离接通：创建姿态、参考适配、参考局部修正和 motion 生成在 attached 模式必须完整 `expectedRevision`；默认预演，`dryRun:false` 仅暂存候选，再用 `spine_host_commit{intent:"asset",assetCandidateHash,outputPath,requestId,dryRun:false}` 独立保存。Host 备份后原子创建、记录角色/阶段来源，保存不切换当前文档，须显式打开新资产。初始 skeleton 可用 `spine_host_pin{intent:"asset"}` 绑定为新站姿来源，源骨架仍只读。参考失败仅诊断，不暂存或授权；新姿态不继承批准。构建及 **189/189 回归通过**。[本批证据](docs/plans/host-c2-assets-20261024.json)。C2-4c 动画审查/提交、真实角色视觉及编辑器导入仍待完成，生产继续 C1 观察；下列 184 项等记录均为此前批次。

2026-10-23 C2-4b 计算基础续接：姿态创建、参考适配与 motion 生成新增明确内存输入入口，调用方提供原始姿态值后仍须通过数值、参考及证据审查；计算入口不保存文件。motion 生成和复核共用阶段、标准站姿、角色、地面与参考绑定门禁。构建及 **184/184 回归通过**。这是 C2-4b 的内部基础；跨类型资产登记、Host 原子保存及这些高级工具的 attached 调用尚未接通。工具仍 101 个，生产写入继续关闭。[本批证据](docs/plans/host-c2-asset-data-20261023.json)。下列 180/175 项为此前各批历史记录。

2026-10-23 C2-4a 续接：`spine_set_pose_target`、`spine_set_pose_channel`、`spine_batch_pose_ops`、`spine_adjust_pose` 已支持隔离 C2 attached 内存命令，必须完整 expectedRevision、不得给 outputPosePath；保存另用 Host commit。detached 保留新路径语义，不吞 Host 版本。构建及 **180/180 回归通过**；真实桌面仅验证合成诊断姿态，不批准真实美术。C2-4b/c 的参考/资产创建与动画提交仍未完成，生产不开启 C2。[本批证据](docs/plans/host-c2-pose-commands-20261023.json)。下文 C2-3 的 175 项是上一批历史记录。

2026-10-23 C2-1～3 已实现：pose 参数/呈现原子批次，以及 motion/skeleton 显式动画、时间与 setup 观察、MCP 只读候选、frame/player 截图和跨文档草稿恢复。构建及 **175/175 回归通过**；实际能力由 `capabilities.editing/viewing` 声明，`c2-pose` 仍仅隔离研发，生产 C1、公开写入关闭。真实 WebView2 合成夹具不代表真实美术或完整动画批准，动画提交及 C2-4 尚未交付。C1 固定候选继续独立采样，已保留一次未知退出，中断不补时。[C2-3 证据](docs/plans/host-c2-playback-20261023.json)、[前两批证据](docs/plans/host-c2-pose-20261023.json)、[主工单](docs/plans/host-evolution.md#571-c2-研发增量2026-10-23用户指示开始)。

2026-10-23 观察与启停补充：已增加 `node dist/hostObservationCli.js start|status|stop|report|review|disable --workspace "工作区绝对路径"`，用于真实 60 秒采样、签名报告、人工评审和安全关闭。生产默认 observer，只有 `SPINE_HOST_WRITE=1` 与有效 `SPINE_HOST_ROLLOUT_APPROVAL` 同时满足才能限定启用 C1，不能手填通过标志；当前未审批或启用。用户选择先在已验收 npc1 站姿隔离工程试运行，两周与充分使用仍须实测。完整步骤见 [Host 长期观察与启用流程](docs/Host长期观察与启用流程.md)；工具仍为 101 个，端口及一键启动脚本不变。下列 154 项及性能数据是该新增功能之前的技术基线，最新补验另记。

项目进展（2026-10-23）：[当前主线与阻塞](docs/项目进展.md)。合计 101 个工具，源码 0.2.0。C1 单手闭环已在真实 npc1 无参考站姿完成编辑、撤销、官方 player 截图、逐项视觉审查、授权保存和重开复验，原资源未变。固定 C1 候选的 160 项回归及真实桌面 28 项通过；编辑三轮总体 P95 114.20ms，但首轮 120.50ms 超预算，不能标逐轮全通过。事务三轮通过，两周观察与人工启用评审仍未完成；[C1 候选索引](docs/plans/host-c1-observation-implementation-20261023.json)。该数据不为新增 C2 构建背书。攻击准备姿态仍有 7 项必要失败，旧 exe 未更新。

源码构建后可用 `npm run host` 启动独立观察页。MCP 可调用 `spine_create_project` 显式预演工程初始化，再用 `spine_host_open` 打开已绑定文档；未启动 Host 时可使用镜像。初始化不覆盖现有 manifest，不修改角色资源。默认查询不隐式求解，需重算时显式调用 `spine_solve_pose` 或设置 `recheck:true`。

显式选定文件后省略 `animation`，资源/runtime 校验不继承示例动画；`animation:null` 表示只检查资源和适用皮肤，流水线不生成动画联系图。MCP 与预览 HTTP 语义一致，明确错误动画或皮肤仍拒绝。`exp/xiaoren` 的拆分皮肤案例已按用户要求排除，不计入第二真实角色验收。

Host readiness 另区分未打开、缺 pin、stale、Host 串行事务 busy 与写入冻结，逐操作返回原因；截图就绪不覆盖其它阻塞。`npx tsx scripts/audit-host-observation.ts` 可复跑真实站姿的短时只读 MCP/HTTP 审计，生成新隔离目录和独立报告后关闭临时服务；最新 30 次约 8.22 秒零误报，不能替代两周观察。

更新后 MCP evaluate 链路登记完整版本的外部求解任务，页面显示计算中、完成、失败、取消或心跳失联。取消/异常独立清理，15 秒失联不自动恢复 ready；任务租约不授权写入。旧 Host 缺端点或快照 reviewHash 时明确拒绝，需重启匹配源码。新增观察前的三轮数据见 [历史编辑汇总](docs/plans/host-client-performance-summary-2026-10-23T08-57-02-812Z.json) 和 [历史事务汇总](docs/plans/host-transaction-performance-summary-2026-10-23T08-59-26-222Z.json)，当前复测见上方最新证据索引，不沿用旧代码的通过结论。

C1 附着审查已接通：spine_review_pose 使用当前完整版本和 player manifest，默认只预演；批准需数值、适用参考/阶段/关系及七项独立理由。保存保留批准或退回记录，新修订可独立复验；证据事后变化阻止提交。该闭环已在真实角色的隔离站姿修订中验证，生产公开写入仍关闭。

长任务遵循 200ms 通知节流、末条必发、无 token 静默。按用户确认的 L1/L2 v1.4，短任务验首末，至少 1 秒的 60 次迭代验至少六条。局部修正已取消时零评估，进度回调取消后不继续下一轮；实际 MCP 渲染取消后约 31ms 停止、34ms 释放锁，服务继续响应。已完成事务不会因取消伪装成回滚。

WinForms 源码已加入“动画预览 / Host 工作台”页签。Host 页从同一工作区发现并核对已有服务，不读取控制凭据或接管写入；切走/最小化卸载页面，恢复后读取当前状态。最新真实站姿 28 项桌面检查通过，30 次重载 P95 105.65ms、30 次真实 MCP stdio/player 960 截图完整回传 383.35ms 均达预算，截图期间零重复 frame。重连像素一致，原资源和文档版本未变，观察状态可见，不新增姿态批准。旧便携发布包尚未更新，见 [桌面说明](apps/winforms-observer/README.md)。

架构研究：[成熟 MCP 对标与 Host 架构评估](docs/成熟MCP对标与Host架构评估.md)，对照 3D 编辑器 MCP 与文件/运行时工作流，评估 AI Spine 工作台的工程模型、操作能力和持续反馈闭环。

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

MCP 协议补充：现已提供只读 resources 与三个流程 prompts；spine_get_workspace_tree 可有界勘察目录，spine_recheck_pose 显式重算。roots 不覆盖用户选择，摘要默认零求解；长任务有进度和取消，缓存仅复用不可变模板，批准门禁始终严格复核。需重启 MCP 进程加载新构建。

源码版本为 0.2.0：`spine_get_pose_state` 默认返回零求解摘要，详细关节需显式 `spine_recheck_pose`；未知工具参数及未知语义 frame/patch 字段会被拒绝。旧客户端应先刷新 tools/list。工程切换会等待旧 Host 关闭、发现文件退役及写入锁释放；未确认交接时保持冻结。新构建不自动重启用户正在使用的 MCP，也不改全局配置。
