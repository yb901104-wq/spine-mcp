# 动画工作区宿主（Host）演进工单 v1.8

> 定位：基于既有 Spine JSON、官方 runtime 和预览系统建立可持续编辑、保存与重开的 **AI Spine 动画工作台**。本文件定义其动画工作区宿主、工程模型、能力与领域服务，以及 H0（工程与契约）→ B（观察）→ C1（最小编辑闭环）→ C2（创作面扩展）→ D（计算搬迁评估）的实施顺序。
> 与 [L1/L2 工单](mcp-l1-l2.md) 的分工：L1/L2 只管「MCP 侧协议与只读勘察」；凡是需要「宿主在/不在」两种环境才能验收的内容，全部在本文件。
> 契约表（§3）是全项目唯一一份；L1/L2 只引用，不复制字段。
> 现状事实以当前工作树为准（**2026-11-02 实测核对**）：**116 个工具**（真实 stdio：`initialize` → `notifications/initialized` → `tools/list` 取得）；既有 previewServer 与新 hostServer 独立；rasterFrame 仍消费已摆好的 skeleton，Host 不执行求解。
> 当前状态（2026-10-24）：H0/B/C1 及 C2-1～4c 工程链路已实现并隔离验证；精确拟合、完整动画审查与源备份/原子提交保持。最新回归 203/203，实际部署 npc1 三进程 90 样本 state/frame P95 12.39/25.51ms、逐轮通过，实际桌面两组各 29 项且优化前后像素一致。真实完整动画、第二角色、Spine 编辑器、其它负载、两周观察及公开启用仍待验，生产保持 C1 观察。D 按 §6 原条件评估。详见 [实施与验收](../Host实施与验收-20261021.md) 和 [本批索引](host-state-performance-closeout-20261024.json)。v1.8 的一致性、授权、备份、冻结及截图分层规则不变；下列历史按日期追溯。
> 术语：本文 Host 指动画工作区宿主；MCP 协议中的 host 指 AI 应用，两者不是同一组件。
> **2026-11-02 载体定位与回补锚点（已确认口径）**：**载体机制层已建成并通过隔离验证**——工程模型与契约（H0）、观察与预览（B1/B2）、会话与事务（C1）、扩展面（C2-1～4c）与诊断终验（§16）均已在源码与隔离测试中落地。**「机制具备」不等于「载体验收或生产启用」**：C1 生产仍为观察态，C2 生产写入仍关闭，D 未开工。未闭合项按性质分为三类，见 **§17**，回补时按 §17.4 锚点表定位。本项目已有 MCP 协议接入，本轮完善的是持续创作能力。
> 2026-10-21 已确认：Canvas 回归与官方 player 截图可信度独立判断，见 §4.5/§4.8。截图准入不代表动作批准；旧截图不得自动升级。
> 2026-10-22 桌面续验：WinForms 源码已以双页签嵌入现有 Host 观察页，23 项真实 WebView2 检查通过；页面离开/最小化时卸载，恢复后重新核对当前 Host，后端文档版本不变。旧便携包未重打包，不据基本嵌入开放 C1 生产写入或 C2。详细实现和失败记录仍见实施与验收。

> 同日真实桌面补验：已保存 npc1 无参考站姿在新隔离工程完成 25 项自检，MCP 经实际 WebView2 的官方 player 首次连接/负例后重连各采一张图，独立核验通过且解码像素完全一致；原工程、隔离输入与文档完整版本未变。未新增动作批准、Canvas mesh 等价、编辑器导入或发布结论；证据见 [桌面真实角色报告](host-winforms-2026-10-22T14-01-53-402Z.json)。

> 2026-10-23 最新续验：长期观察与限定启停已实现，构建及 160/160 回归通过；用户选择的 npc1 站姿隔离工程已启动只读试运行。新代码三轮编辑总体 P95 114.20ms，但首轮 120.50ms 超预算，逐轮条件仍待收敛；事务三轮及真实桌面 28 项通过。B 两周与人工启用评审未满足，生产保持观察。[前一轮技术基线](host-c1-technical-closeout-20261023.json) 与下文失败历史保留，当前性能见 §12.1 末段，操作见 [长期观察与启用流程](../Host长期观察与启用流程.md)。

> 2026-10-23 用户指示进入 C2：据此先行开展隔离研发，不把 C1 未完成的性能/两周/启用评审改为通过。首批 C2 pose 参数和批次实现见 §5.7.1；生产入口仍为 C1，C1 审批不能授予 C2。原 C1 采集已迁到同指纹固定安装，后续源码编译不改变该观察候选。

> C2 同日进度：C2-1 参数、C2-2 附件/完整层序和 C2-3 motion/skeleton 动画/时间/setup 观察已实现，构建及 175/175 回归通过，实际 MCP/runtime 与真实 WebView2 合成场景分别验证。未批准真实美术或动画提交；[C2-3 证据](host-c2-playback-20261023.json)、[前两批](host-c2-pose-20261023.json)。C1 固定候选独立采样，保留一次原因未知的无结束退出，中断不补时，不能称为连续稳定通过。

### 修订记录

> **2026-10-30 受控通道根因修复**：`src/hostFileProtection.ts` 原按进程名调用 `whoami` / `icacls`；当 PATH 中 POSIX 工具链（Git Bash / MSYS `usr/bin`）排在 `System32` 之前时，会命中 GNU coreutils 的 `whoami`（不接受 `/user` 参数）并非零退出，使保护函数返回 false、Host 判 `controlProtected:false`，从而**拒绝全部受控端点**（求解发布、审查、资产候选、诊断阶段等一并不可用）。已改为按 `SystemRoot` 定位 System32 原生可执行文件，并补回归锁测试 `test/hostFileProtection.test.ts`。**语义未放宽**：仍要求 `icacls` 实际执行成功才算启用保护，任一环节失败依旧失败即关闭。本次修复在本机把受控通道由整体不可用恢复为 `mode:"acl"`。

> **2026-10-30 §16 新增（用户确认）**：把「Spine 编辑器能否打开当前文件」做成**默认关闭的 advisory 终验**，写为 §16 + ADR-23，并同步补 §8 测试矩阵、§9 风险登记、§10 不做清单与 §13 工单行。决策边界：**不进主链路、不放宽任何现有门禁、不得作为审查/验收/发布依据**，也不引入对 Spine Pro 授权或固定版本的必需依赖。来源见 [三层对比（§1.6）](../三层对比-工作逻辑与工具包装-20261030.md)。**2026-10-30 晚：§16 已施工并写入 §16.4a，隔离测试与真实 stdio 实测通过；真实 Spine CLI、资源依赖与真实超时三项仍待验。**

> 2026-10-23 C2-4a：四个既有姿态命令已适配隔离 attached 内存，构建及 180/180 回归通过，实际 WebView2 诊断场景 27 项通过；数值失败没有转为动作批准。已修复 poseGate 失败返回未检查的观察入口遗漏，原门限不变。一次恢复检查点失败原因未取得，后续通过与失败记录均保留。[本批证据](host-c2-pose-commands-20261023.json)。C2-4b/c 与完整 C2 验收仍未完成，生产写入关闭。

> 2026-10-23 C2-4b 计算基础：明确内存姿态输入已接入创建、参考适配和 motion 生成/复核；完整构建及 184/184 回归通过。Host 跨类型登记/原子保存及高级工具 attached 调用尚未接通，不标记整个 C2-4b 完成。[本批证据](host-c2-asset-data-20261023.json)。

> 2026-10-24 C2-4b 资产流程：四个高级入口 attached 暂存、精确候选授权、备份/原子保存、跨类型来源登记、幂等及故障恢复已隔离实现，构建及 189/189 回归通过。参考适配/局部修正保存后重开及重新比较通过合成夹具验证；不替代真实美术、player 逐项视觉或编辑器导入。C2-4b 的工程接入完成，完整 C2 仍待 C2-4c 和原退出条件。[本批证据](host-c2-assets-20261024.json)。

> **2026-11-02 载体重测与定位**：按当前工作树实跑复测（构建通过；239 项 / 213 通过 / 25 失败全为运行环境保护 / 1 跳过；工具实测 **116**，修正原文 101），并把定位写为 **§17**：载体机制层已建成并通过隔离验证，但不等于载体验收或生产启用；未闭合项分为「客观未闭合 / 真实环境依赖 / 人工评审」三类并给出回补锚点与下一大块顺序。**未放宽任何门禁，未修改任何退出条件。**

**v1.8（2026-10-21，用户确认）**：拆分 `rendererParity`、`captureValidity` 与 `evidenceEligible`。保留 Canvas 像素门限；最终视觉审查使用本次 Host 独立核验通过的官方 player 截图。旧证据重新采集，数值、视觉与编辑器导入分别验收。

**v1.1**：状态同步决策（C 实时 + A 验收，否决 WS）、认证与端口发现、op 语法、journal 裁决、undo 语义、D 判据、预算。
**v1.2**：强制 pin、capture 版本绑定、路径与 token 安全、doc kind 与 per-doc revision、spawn 规则、平台差异、SSE 重连、live 文件治理。
**v1.3**：补 `open`、工具表补齐、frame 渲染源、drift 两级、journal 按 doc、**寻址统一到 activeDoc**。

**v1.4**：

| # | 修订 | 章节 |
|---|---|---|
| 1 | **B1 增交付：`applySolution`**（把 `solution.bones` 回放到 skeleton）——这是 B 阶段“只渲染不求解”的**实现前提**，此前是假设 | §4.1、§4.2 |
| 2 | **detached 也维护 activeDoc**：`spine_host_open` 在无宿主时由 MCP 侧记录镜像，寻址规则不变 | §2.1、§3.2 |
| 3 | `capture` 对 pose/motion **必然**需要 live 导出（pose JSON 不是 spine JSON） | §4.4、§3.1 |
| 4 | `target.posePath` → **`target.docPath`**（skeleton/motion 也可编辑） | §3.3、§5.0 |
| 5 | `open` 的依赖解析规则 + 新码 `DOC_INCOMPLETE` | §3.1、§3.4 |
| 6 | 乐观锁加 session epoch：`expectedRevision: {sessionId, revision}` | §3.3、§5.1 |
| 7 | `capture{viewport}` 只接受与记录一致者，否则 `advisory` | §3.1、§4.4 |
| 8 | **黄金帧默认 D（一次性人工基线 + 版本绑定），A（playwright）作可选脚本** | §4.5 |
| 9 | commit 到新路径时初始化新 journal header | §5.2 |
| 10 | `security.mode` 只描述文件保护；**token 永远必填** | §4.6 |
| 11 | `/api/frame` 限流（20 req/s per token，超限 429） | §4.3 |
| 12 | 验收清单按阶段标注工具数量 | §4.7、§5.6 |

**v1.5（第五轮审查的边界补丁）**：

| # | 修订 | 章节 |
|---|---|---|
| 1 | 补 `/api/shutdown` 端点（工程切换用），并定义其幂等与超时 | §3.1、§4.6 |
| 2 | **B1 的 frame 只支持 `pose`**；skeleton/motion → 新码 `UNSUPPORTED_DOC_KIND` | §4.1、§3.4 |
| 3 | `SPINE_HOST_ENDPOINT` 模式必须同时提供 `SPINE_HOST_TOKEN` | §4.6 |
| 4 | `/api/open` 幂等语义：同路径重复 open 保留 revision/target，返回 `reopened:true` | §3.1 |
| 5 | journal header 的 `sessionId` **仅审计，不参与校验** | §5.2 |
| 6 | `REVISION_CONFLICT` 增 `detail.reason`（`stale` / `epoch`） | §3.4 |
| 7 | `goldenPassed` 三态边界写死（未跑/失败/版本变） | §4.5 |
| 8 | frame 的 `size` 上限 480；960 只允许 capture | §3.1 |
| 9 | `applySolution` 初版容差 ≤1e-4，稳定后再收紧 | §4.1 |
| 10 | detached 的 `preview_state` 返回形状改为 `available:false, mode:'mirror', activeDoc` | §3.2 |

**v1.6（2026-10-21，五项契约修正）**：

| 问题 | 修正 | 章节 |
|---|---|---|
| Host 内存与 MCP 求解脱节 | 原子读取快照、内存输入适配器、发布派生结果；结果必须绑定完整版本和依赖指纹 | §3.1、§3.5、§5.5 |
| 文档切换后 revision 重复 | 统一 `VersionRef={sessionId,documentId,openEpoch,revision}`；打开、重载及提交换路径有明确身份变化 | §3.1、§3.3、§5.1 |
| commit 未连接既有门禁 | 默认 dryRun、精确候选哈希、MCP 控制通道授权、备份及原子事务；禁止 setup 修改 | §3.6、§5.1、§5.3 |
| 掉线自动直写导致双写 | 先冻结，再凭排他写入权交接；超时不作为接管依据 | §2.2、§4.6、§5.5 |
| 回放格式和完整视觉状态不一致 | 使用 setup 相对增量与完整显示状态；统一回放误差 ≤1e-4 | §3.5、§4.1–§4.5、§8 |

**v1.7（2026-10-21，工程模型与最小创作闭环）**：

| 修订 | 结果 | 章节 |
|---|---|---|
| 明确工作台定位 | V1 面向既有角色的动画创作；工程宿主与 MCP 协议 host 分开命名 | §0、§1 |
| 工程持久模型 | 确定 manifest、绑定优先级、旧项目兼容与可重建产物索引 | §3.7 |
| 能力与 readiness | 区分协议、操作、角色能力及逐操作就绪状态；查询不隐式求解或批准 | §3.8 |
| 领域服务与接口完备性 | 同一套内存计算、受控命令与提交策略，独立 schema 检查提前 | §1.6、§3.9、H0 |
| C 分批 | C1 只做 pose 单手目标；C2 再接通通道、层序、motion 与时间线 | §5.7、§13 |
| 验收与预算 | 增加端到端创作演示；性能数值先测量，质量与吞吐分别报告 | §8、§11–§13 |
| 截图证据分层（v1.8） | Canvas 回归独立记录；官方 player 当前截图按完整核验准入，动作仍独立审查 | §4.5、§4.8 |

---

## 0. 为什么先定义主体

本项目已有实际 MCP 工具、动画领域算法、审查与离线产物。当前工作方式主要从 `args.projectId`、路径和磁盘重建上下文；预览服务读取共享会话与文件，尚无完整的内存文档、工程能力与闭环回执。

四个可观测后果：

1. 工程可以登记，但角色资源、映射、参考、姿态和输出之间缺少统一持久模型；
2. 大量调用仍靠路径和报告串联；Agent 难以一次知道当前角色支持什么操作；
3. 缺少可持续编辑的内存历史，调整常用新路径保存修订；
4. 计算、落盘和呈现缺少共同的版本回执，无法稳定组织“改一点、看一次、再调整”。

本工单把工程、对象、命令、实际回读和历史接成应用能力；MCP 的 resources/prompts 是访问和引导这些能力的方式，不作为“真假 MCP”的划分标准。外部对标依据保存在评估报告，契约以本文为准。

---

## 1. 主体定义

### 1.1 一句话

> 动画工作区宿主持有工程与编辑会话，呈现明确版本的实际结果，并在 attached 模式担任受管资产的唯一写入者；最终批准与提交门禁继续由既有 MCP 流程控制。

V1 仅使用现有角色资源，编辑当前支持的动画时间线与工作流姿态，不新增自动切图、绑定、setup pose、skins、mesh/deform、constraints 或 events 编辑能力。存量资源可读取、诊断，不因能加载就声明可写。

### 1.2 工程上下文与四个宿主组件

| 组件 | 职责 | 明确不做 |
|---|---|---|
| **Document Store** | 在工程绑定下持有已打开文档与派生结果，按 doc 维护 revision；三 kind 为完整目标，C1 首先支持 pose 编辑 | 不自行批准；不因模型字段存在就开放修改 |
| **Session** | clientId、projectId、`activeDoc`、`target`、`pinned`、完整版本、undo 栈、未提交改动 | 不做跨工程合并 |
| **Writer** | patch 的 journal 持久化成功后发布内存 revision；仅 commit 备份并原子替换资产文件 | 不接受无完整版本或无提交授权的盲写 |
| **Presenter** | 两条渲染通道：`canvas`（node 实时）+ `player`（浏览器验收）；完整渲染状态回放；固定相机证据截图 | 不做黄金帧判定（属测试） |

工程 manifest 提供持久绑定，领域服务提供可复用计算；它们的契约分别见 §3.7 与 §1.6。四个组件不能各自复制一套加载、求解或审查算法。

**文档模型与寻址**

- `docKind ∈ {skeleton, pose, motion}`；同一路径只能属于一种 kind。
- `revision` 在一次打开周期内单调递增，undo/redo 也产生新 revision；`session.revision` 是 `activeDoc.version.revision` 的别名。不能单独用数字定位文档版本。
- 一个 session 同时只打开一个 `activeDoc`；切换必须显式 `open`，并清空 `target/pinned`。文档身份与重载规则见 §3.3。
- **所有读写都以 `activeDoc` 为目标**：`frame`、`capture`、`patch`、`commit`、`undo/redo` 一律不接受路径参数；`activeDoc` 为 null → `DOC_NOT_LOADED`。

### 1.3 能力清单（面向 MCP）

| 能力 | 用途 | 阶段 |
|---|---|---|
| `createProject` | 显式初始化工程 manifest，默认 dryRun，不改角色资源 | H0 |
| `open` | 打开工程及可选文档，解析依赖，返回工程/文档身份与新鲜度 | B |
| `state` / `capabilities` | 工程、文档、实际角色能力、逐操作 readiness 与呈现/审查状态 | B |
| `frame` | 实时帧：canvas 渲染 `solution` 快照 | B |
| `capture` | 验收图：真 player + 固定相机，PNG + manifest | B |
| `events` | 变更/加载/播放事件流（SSE，可重连） | B |
| `read` | bones/slots/attachments/timelines 结构查询 | B |
| `snapshot` | 原子读取当前文档、依赖及完整版本；供 MCP 内存求解与审查 | B（C 前置） |
| `derived` | 接收 MCP 的新求解/比较及渲染产物，不修改编辑参数或批准状态 | B2（C 前置） |
| `pin` | 把 target 钉在 activeDoc 上；未 pin 拒绝写 | C1 |
| `authorize` | MCP 对精确提交候选登记一次性授权 | C1 |
| `patch` / `commit` / `undo` / `redo` | C1 单手 pose 草稿闭环；C2 扩展受支持资产 | C1 / C2 |
| `solve` | 评估数值计算在宿主内执行，批准及授权策略仍由 MCP 持有 | D |

### 1.4 只给这些，不给那些

**Host 提供给 MCP**：会话身份、完整版本、结构查询、不可变快照、diff、事件、两种图、undo，以及求解结果回传接口。

**保留在 MCP**：判定权、语义指纹策略、写入策略（白名单/失效规则/审查清除）。Host 验证身份、事务和授权绑定，不自行批准姿态或动画。

### 1.5 判定分层与受控提交

```
Host   ：身份/事务/结构机械检查 + 呈现 + 写入 → 不自行批准姿态或动画
MCP    ：既有审查流程 + 证据验证 + 提交编排  → attached 不直接写受管资产
资产磁盘：交付物                    → 只有 commit 才变更
内部磁盘：journal / live / 报告      → 可写运行态，不构成资产提交
```

分别返回结构/版本、数值与 runtime、参考关系、Agent 视觉、编辑器导入的结论，不用一个总 ok 代替。比较与求解可以来自共享库；计算在哪个进程不是独立审查的证明。B/C 仍由 MCP 调用现有求解及审查流程，Host 验证绑定和事务，批准不能由页面、普通 op 或派生结果注入。

### 1.6 共享动画领域服务（H0 前置）

| 逻辑模块（计划位置） | 输入与输出 | 边界 |
|---|---|---|
| `projectModel.ts` | manifest/文档索引 → 已解析且有严格哈希的依赖快照 | 统一绑定与路径校验；不决定批准 |
| `animationCommands.ts` | 不可变编辑输入 + 有类型 op → 新输入与 diff | 白名单、单位、修订与失效规则同源；dryRun 不落盘 |
| `animationKernel.ts` | pose + 已加载角色/mapping/visualRig/策略 → 骨骼、实际节点、数值和关系报告 | 拆出 solvePoseData 的纯计算；不读写磁盘、不分配提交令牌 |
| `motionRuntime.ts` / `runtimeCache.ts` | 已校验资产 → 官方 runtime 加载与采样 | 复用现有实现和 L1.2 缓存；不缓存可变 Skeleton 供并发共享 |
| `poseDigest.ts` | 当前快照与已有结果 → 新鲜度/摘要 | 只读，不隐式求解；见 L2.1 |
| 回放、导出与提交策略适配器 | 精确结果 → 图像/live 候选；精确候选 → 既有门禁记录 | 复用 rasterRenderer、retargetEngine、spineJson 与审查链，不另建绕过路径 |

以上先作为同一包内接口，不增加第三个服务进程。MCP stdio、Host HTTP 和离线任务调用同一领域实现；Host 数据读取止于 snapshot/依赖准备层，不把 mode 判断散布到所有 readFile。现有 detached 工具在适配期保留算法与拒绝行为，逐条验证结果等价后再切换。

应用流程为：**打开工程 → 查询对象/能力/readiness → 修改明确参数 → 官方 runtime 实际回读 → 查看干净图 → 再修改或撤销 → 审查保存 → 重开恢复**。首个可发布闭环的范围与验收见 §5.7。

---

## 2. 两种运行模式

| | detached（默认，现状） | attached（目标） |
|---|---|---|
| 写入者 | MCP 直写磁盘 | **Host** |
| 真相 | 磁盘 | Host 内存（commit 后同步） |
| activeDoc | **MCP 侧镜像**（见 §2.1） | Host 持有 |
| undo | 只能“新路径” | 内存栈（仅未提交） |
| 实时画面 | 仅 `offline-canvas`（磁盘版本） | `canvas` 即时 + `player` 验收 |
| 降级 | — | 掉线先进入 `frozen`，`degraded:true`；写入权交接完成后才可 detached |
| 开启 | 获得排他写入权的 MCP；B 阶段 Host 可在线观察 | C 开关开启、Host 兼容且已完成写入权交接；仅心跳正常不够 |

### 2.1 detached 下的 activeDoc 镜像（v1.4）

统一寻址不能只在 attached 成立。规则：

- `spine_host_open` 在正常 detached 时**不报错**，由 MCP 记录 `{path, docKind, fileHash, version}`，其中镜像使用 MCP 进程的 `sessionId`，身份规则与 §3.3 相同；返回 `degraded:true, mode:'mirror'`；
- 后续 `frame`/`capture` 在该镜像上工作，走 `offline-canvas`；
- 镜像不跨进程持久化，MCP 重启即失效（下次调用需重新 open）；
- 镜像的 `fileHash` 每次读取前比对，变了就 `TARGET_STALE`（与 attached 同语义）。

**规则**：同一工程同一时刻只允许一个写入者。attached 时 MCP 拒绝直写；detached 时 Host 只观察。

### 2.2 写入权交接与冻结（v1.6）

- B 阶段 Host 为观察者，现有 MCP 继续持有写入权；启用 C 才迁移写入权。Host 在线与 attached 写入模式分开报告。
- C 的所有参与者共用工作区排他写入锁 `.spine-mcp/writer.lock`，记录 `ownerId/pid/processStartedAt/generation`；generation 是排他锁内更新的工作区持久计数，不随端口文件轮换归零。资产事务仍使用逐文件锁。取得工作区写入权后才能开启资产写事务。
- MCP → Host：停止接收新写入 → 等待在途事务结束 → 释放 MCP 写入锁 → Host 排他取得锁并返回确认。反向交接同理；交接期间拒绝写入。
- 心跳丢失、HTTP 超时或提交结果不明 → `frozen`。可以返回明确标注为旧版本的诊断信息，禁止自动直写、自动删除锁或自动重放写请求。
- 恢复 detached 的条件：原 owner 已确认退出写入模式并释放锁，或核对 PID 与进程启动时间确认原进程已死亡，再按残留锁恢复流程清理；新 owner 排他取得锁并更新 generation。无法确认则保持冻结，返回 `WRITE_OWNERSHIP_UNCERTAIN`。
- 超时、TTL 和端口不可达均不能单独证明旧 owner 已失去写入能力。旧 owner 恢复响应后必须重新核对锁记录和 generation；不匹配即拒绝提交。提交在同一排他所有权内完成。
- 冻结期间未提交内容以 Host 已确认持久化的 journal 为恢复依据；MCP 无法读取失联内存时不得宣称已保存 recovery。离线后需先恢复会话，再显式决定写入模式。
- 此协议约束参与 Host 演进的兼容进程。旧版直写客户端不得与 C 并行使用，须停止或升级；外部编辑仍按 `TARGET_STALE` 处理。

---

## 3. 契约表（唯一一份）

### 3.1 HTTP 端点

| 方法 | 路径 | 作用 | 阶段 |
|---|---|---|---|
| POST | `/api/open` | `{manifestPath?, path?, reload?, expectedRevision?, animation?, time?}` → `{project, activeDoc, deps, readiness, warnings, reopened}`；C2 显式选择规则见 §5.7.1；`recheck` 仅由 MCP 适配器处理，不传此端点 | B / C2 |
| GET | `/api/state?projectId=` | 工程/文档版本、新鲜度、pin/呈现/审查状态、readiness、运行时版本与安全信息；另附 observation/rollout 摘要，不返回控制凭据 | B |
| GET | `/api/capabilities` | `{context, operations, character, readiness}`；§3.8 的同一数据源，不求解 | B |
| POST | `/api/state` | 页面上报状态（token + 本机 Origin + JSON + 体限） | B |
| GET | `/api/frame?sessionId=&documentId=&openEpoch=&revision=&animation=&time=&size=` | 完整版本必填；可选 animation/time 须与活动选择完全一致，animation 空值表示 setup；只回放已发布候选，`no-store` | B / C2 |
| GET | `/api/events` | SSE：`doc-opened / doc-changed / frame-updated / capture-done / preview-closed`；B2 增加 `evaluation-task-updated`，C1 增加 `review-updated / write-mode-changed`；观察采样使用 `observation-updated` | B |
| GET | `/api/doc?view=bones\|slots\|attachments\|timelines` | 结构查询（作用于 activeDoc） | B |
| POST | `/api/snapshot` | `{expectedRevision}` → 不可变文档/依赖快照、派生与当前审查哈希；供 MCP 内部使用 | B |
| POST | `/api/evaluation-task` | MCP 控制通道登记/续期/结束外部求解任务；绑定完整版本及独立任务租约，不授予写入权，见 §3.8.1 | B2 |
| POST | `/api/observation` | 私有控制通道；仅 `{action:"start"}` 或 `{action:"stop"}`；正常 observer/已打开 pose 才能开始，不接收时间、间隔或通过标志 | B |
| POST | `/api/rollout-disable` | 私有控制通道；只接受空对象，阻止新写、等待在途事务、落盘撤销后释放 Writer，失败冻结；无 HTTP enable | C1 |
| POST | `/api/derived` | `{expectedRevision, snapshotHash, dependencyFingerprint, result}` → `derivedHash`；MCP 控制通道 | B2 |
| POST | `/api/review` | `{expectedRevision, snapshotHash, derivedHash, reviewRecord, dryRun?}` → `reviewHash`；默认只验证，false 才登记 MCP 审查记录 | C1 |
| POST | `/api/capture` | `{expectedRevision, animation?, time?, viewport?, size?}` → `{pngBase64, manifest}`；C2 manifest 另记 kind/view | B2 / C2 |
| POST | `/api/pin` | `{expectedRevision}` → `{pinned:true, version, fileHashAtPin}`；不提供 force 绕过漂移 | C1 |
| POST | `/api/patch` | `{expectedRevision, ops[], dryRun?}` → `{version, diff, changedPaths}`；默认 dryRun；生产 C1 一个手目标，隔离 c2-pose 按 editing.patchOps 接受已交付参数/呈现批次；不接受 profile 切换字段 | C1 / C2 |
| POST | `/api/authorize` | `{expectedRevision, candidateHash, outputPath, intent, gateRecord}` → 一次性 `authorizationId`；MCP 控制通道 | C1 |
| POST | `/api/commit` | `{outputPath?, expectedRevision, dryRun?, authorizationId?, requestId?}` → 候选摘要或备份后的写盘结果；C1 仅 pose 新修订 | C1 / C2 |
| POST | `/api/undo` / `/api/redo` | `{expectedRevision, dryRun?}`；栈操作，默认 dryRun | C1 |
| POST | `/api/shutdown` | `{reason?}` → `202`；停止接收写入、结束在途事务、flush journal、释放写入权后退出；重复调用幂等 | B（C 增加交接） |

**`/api/open` 的依赖解析（v1.4）**

| kind | 解析来源 | 缺失时 |
|---|---|---|
| skeleton | 文件自身；渲染时还需工作区绑定提供 atlas/skin | 缺渲染依赖可打开，frame/capture 返回 `DOC_INCOMPLETE` |
| pose | `pose.filePath`、`pose.mappingPath`；映射中的 atlas/skin；`visualRigPath` 在引用时必须存在 | `DOC_INCOMPLETE`，`missing:[...]` |
| motion | §3.7 manifest 文档绑定中的角色 JSON、mapping、atlas/skin；当前 `MotionDefinition` 不自带 mappingPath，不假设它一定存在 | 同上 |

`deps` 返回角色、mapping、visualRig、atlas、页面纹理、skin 及审查需要的 reference/sequence/policy 的实际绑定与指纹；缺必需绑定须列明，不能用默认工程代替。`warnings` 收非致命项，指纹不匹配的历史资料只允许诊断，不能作为新证据。

**`open` 的幂等与重载语义（v1.6）**

| 情况 | 行为 |
|---|---|
| 同一规范路径、磁盘及依赖未变、`reload` 未开启 | 幂等：保留完整版本、内存内容、target 和栈，返回 `reopened:true` |
| 同路径但磁盘或依赖已变 | `TARGET_STALE`；保留原基线与未提交内容，不能仅刷新 fileHash 来消除漂移 |
| 显式 `reload:true` | 必须带当前完整版本，且无未提交改动；读取最新文件，生成新 openEpoch、revision=0，清除 pin/派生结果/授权/栈 |
| 不同路径或当前无文档 | 切换须带当前完整版本（无文档时除外）；先确保持久化旧 doc journal，再打开新 doc；新 openEpoch、revision=0，清除 target/pinned；旧未提交内容保留在旧 doc journal |

存在未提交改动时禁止 `reload`，返回 `UNCOMMITTED_CHANGES`；先提交，或按完整版本明确 undo 到提交基线。路径相同不代表可以覆盖内存；切换回旧路径后按 §5.2 恢复其 journal，并使用新的 openEpoch。

**鉴权与来源**

- 所有 POST：`X-Spine-Host-Token` 必填（**两种 security.mode 都必填**）；JSON；体 ≤256KB（capture dataURL ≤8MB）；`Origin` 非本机或缺失 → 403。
- 合法 Origin 必须精确匹配 Host 服务的 scheme/host/port；MCP 和 WinForms 的原生请求也显式发送该 Origin。页面 POST state 只能报告加载、播放和心跳，不能改 activeDoc/version、写入权、derived/review 或授权。
- `/api/snapshot`、`/api/derived`、`/api/review`、`/api/authorize` 另需仅下发给 MCP 进程的 `X-Spine-Host-Control`；不得注入页面或记入日志。页面 token 不能发布求解结论、登记批准或签发提交授权。快照大数据走响应；派生产物以内联摘要和工作区内不可变产物引用传输，Host 重新校验引用内容哈希，不能突破请求体上限。
- frame、doc、state、events 等读取也要求会话 token；页面使用同源请求，SSE 使用可带 header 的流式请求，不把 token 放入 URL。
- `/api/open`、`/api/doc` 路径一律 `resolveWorkspacePath` + realpath 祖先校验；`..`/绝对/软链 → `PATH_FORBIDDEN`；`projectId` 必须已登记。

**截图页面回传实现**：`/api/capture` 还接受 Host 生成的单次 `captureId` 与页面 PNG/实际骨骼与顶点/skin/附件/层序/相机/视口回读及资源与 player 脚本哈希，使用同一 token、Origin 和体限。任务在开始时绑定完整版本与 derivedHash，过期回传拒绝；页面不能携带 golden、review 或授权结论。

**版本绑定与限流**

- frame/snapshot/capture/derived/review/pin/patch/authorize/commit/undo/redo 均比对完整 `VersionRef`，缺字段直接拒绝；不一致返回 409 + 当前 version。唯一例外是已完成 requestId 的只读结果重取（§3.6），不重新执行事务。frame 回传完整版本头，不能只返回 `X-Revision`。
- `/api/capture`：`viewport` **只接受与记录一致的取值**，否则标 `advisory:true` 并回 `viewportMatches:false`；manifest 必含 `version + contentHash + dependencyFingerprint + derivedHash + fileHash + source + exported`，其中 fileHash 只表示磁盘基线。异步渲染结束时再次比对完整版本和派生哈希；失配则 409，不登记证据。
- `/api/frame` 限流 20 req/s per token，超限 429 + `Retry-After`；**`size` 上限 480**（320/480 可选），960 只允许 `/api/capture`（v1.5）。
- `/api/commit{outputPath}`：先完成 §3.6 的授权及写盘事务。路径不同且成功后才切换 activeDoc：新 documentId/openEpoch、revision=0、lastCommittedRevision=0，清空 pin/派生结果/授权/栈并返回 `switched:true`；失败时保持原会话。

**SSE**：15s 心跳；事件附完整 version；`Last-Event-ID` 续传（保留 200 条，超出 `resync`）。重启或切换身份后不得以旧事件覆盖新文档。

### 3.2 MCP 工具（薄封装）

| 工具 | 阶段 | detached 行为 |
|---|---|---|
| `spine_create_project` | H0 | 显式初始化工作区 manifest；默认 dryRun，拒绝覆盖；不创建或修改角色资源 |
| `spine_host_open` | B | **记录镜像**，`degraded:true, mode:'mirror'`（v1.4） |
| `spine_preview_state` | B | 返回镜像工程/文档、readiness；`includeCapabilities:true` 读取 §3.8，同一能力数据不另增工具 |
| `spine_preview_frame` | B | `offline-canvas`（磁盘/镜像版本），`source:'disk'` |
| `spine_preview_capture` | B | `available:false`，可回退 `offline-canvas` 标 `advisory` |
| `spine_host_pin` | C1 | `degraded:true`（无意义，直接拒绝写） |
| `spine_host_patch` / `commit` / `undo` / `redo` | C1 / C2 | `degraded:true`，不落盘；未交付的 op/kind 明确拒绝 |

写工具 = `patch / commit / undo / redo`（4 个），全部要求 `pinned===true`、当前写入权及完整版本，默认 `dryRun:true`；`open`/`pin` 是绑定操作。snapshot/derived/review/authorize 为 MCP 内部桥接端点，不新增给 Agent 自由发布结论的工具；现有求解和审查工具通过适配器使用它们。

附着会话失联时，上述 Host 写工具返回冻结状态，不自动调用现有 detached 写工具；只有 §2.2 的交接完成后，原有工具才可按其原门禁直写。

### 3.3 Session 字段

```ts
interface VersionRef {
  sessionId: string;                 // Host 启动身份；镜像模式为 MCP 启动身份
  documentId: string;                // 工作区身份 + 规范 realpath + kind 派生；Windows 统一大小写
  openEpoch: string;                 // 每次切换/重载/恢复打开生成新 UUID；同路径幂等 open 保留
  revision: number;                 // 当前打开周期内单调递增；undo 不回退此数字
}
interface HostSession {
  sessionId: string;
  clientId: string; projectId: string; workspaceRoot: string;
  project: { manifestPath: string | null; manifestHash: string | null;
             schemaVersion: number | null; mode: 'managed' | 'legacy' | 'unsupported';
             characterId: string | null };
  activeDoc: { path: string; kind: 'skeleton'|'pose'|'motion'; version: VersionRef } | null;
  target: { documentId: string; openEpoch: string; docPath: string; pinnedAt: string; fileHashAtPin: string } | null;
  pinned: boolean;
  targetStale: boolean;              // Host 判：fileHash ≠ fileHashAtPin
  revision: number;                  // = activeDoc.version.revision
  lastCommittedRevision: number;
  fileHash: string;
  contentHash: string;               // 当前可编辑模型的规范哈希；不含派生结果/审查记录
  dependencyFingerprint: string;     // 当前完整依赖集合指纹
  derivedHash: string | null;        // 与当前输入精确匹配的派生结果
  reviewHash: string | null;         // 与当前快照、派生结果和证据精确匹配的审查记录
  capabilitiesFingerprint: string;   // §3.8：实现/角色能力的指纹，不表示当前操作已就绪
  readiness: OperationReadiness[];   // §3.8：逐操作状态；包含观察时间与原因
  writeMode: 'observer' | 'detached' | 'attached' | 'frozen';
  writer: { ownerId: string; generation: number; verified: boolean } | null;
  renderer: 'canvas' | 'player';
  security: { mode: 'acl' | 'token-only' };   // 只描述文件保护；token 恒必填
  preview: { available: boolean; filePath: string|null; fileHash: string|null;
             playerVersion: string; coreVersion: string; pma: boolean; lastSeenAt: string|null };
  undoDepth: number; redoDepth: number; uncommitted: boolean;
}
```

所有 `expectedRevision` 字段均使用 `VersionRef` 对象；`version` 是响应字段。`documentId` 标识资产，`openEpoch` 区分同一资产的不同打开周期；A→B→A、重载及重启均不能复用旧请求。`revision` 数字和 `lastCommittedRevision` 只在当前 openEpoch 内比较。

`apiVersion` 在 `/api/state` 顶层返回（`"1"`）；不匹配即 `HOST_VERSION_MISMATCH`。

### 3.4 错误码

| code | 场景 |
|---|---|
| `HOST_UNAVAILABLE` | attached 下宿主掉线 |
| `HOST_VERSION_MISMATCH` | apiVersion 不兼容 |
| `REVISION_CONFLICT` | 完整 VersionRef 不匹配；`detail.reason` 为 `session` / `document` / `openEpoch` / `stale` |
| `WRITE_FORBIDDEN` | detached 调写工具 / attached 下 MCP 直写 |
| `WRITE_OWNERSHIP_UNCERTAIN` | 无法证明原 owner 已释放写入权，保持 frozen |
| `TARGET_DRIFT` | **MCP** 判：语义指纹与当前文档不一致 |
| `TARGET_STALE` | **Host** 判：fileHash ≠ fileHashAtPin |
| `TARGET_NOT_PINNED` | 未 pin 发起写操作 |
| `PATH_FORBIDDEN` | 路径越权/未登记工程 |
| `DOC_NOT_LOADED` | 未 open 就读写 |
| `DOC_INCOMPLETE` | open 时依赖缺失（v1.4） |
| `PROJECT_MANIFEST_INVALID` | manifest 结构、路径、重复文档或引用不合法 |
| `PROJECT_BINDING_CONFLICT` | manifest、已登记 projectId 与文档自身绑定冲突 |
| `PROJECT_SCHEMA_UNSUPPORTED` | 未支持的工程 schema；只允许受限诊断，不自动迁移 |
| `PROJECT_MANIFEST_REQUIRED` | legacy 工程请求 C 编辑，需要先显式初始化 |
| `CAPABILITY_MISSING` | 当前阶段、操作或角色能力不支持请求，附具体 reason 与下一步 |
| `OPERATION_NOT_READY` | 能力已实现，但当前输入/任务/证据状态尚不能运行 |
| `UNSUPPORTED_DOC_KIND` | 该阶段不支持此 doc kind（B1 的 frame 仅支持 pose）（v1.5） |
| `NO_SOLUTION` | frame/capture 需要 solution 而文档没有 |
| `SOLUTION_STALE` | 求解结果、依赖或显示状态与当前快照不匹配 |
| `UNCOMMITTED_CHANGES` | 未提交内容阻止 reload |
| `COMMIT_NOT_AUTHORIZED` | 真实提交缺授权、授权过期/已消费或绑定不符 |
| `REQUEST_CONFLICT` | 同 requestId 被用于不同提交内容 |
| `REVIEW_STALE` | 已登记审查的证据或候选变化；重新采集并审查，不自动降级为已批准草稿 |
| `CAPTURE_UNVERIFIED` | 截图核验不通过、证据未在当前 Host 登记或当前版本绑定失配 |
| `CAPTURE_TIMEOUT` | 摆帧超时 |
| `JOURNAL_CORRUPT` | journal 半行/校验失败 |

### 3.5 内存快照、求解与完整渲染状态（v1.6）

**权威输入与派生结果分离**：编辑输入是当前文档的 frame/weapon/groundY、动画时间线等；solution/comparison/review 不得被当作新的编辑输入。旧批准不随 patch、undo/redo 或打开周期自动继承。

1. `/api/snapshot{expectedRevision}` 在文档互斥区取得不可变副本，返回 `{version, project, document, contentHash, dependencies, dependencyFingerprint, snapshotHash, derived, derivedHash, reviewHash}`。`reviewHash` 可为 null，独立绑定授权，不参与求解输入哈希；旧 Host 缺字段须重启匹配源码，不能用缺项替代 null。`snapshotHash` 绑定完整 version、contentHash 与 dependencyFingerprint；依赖包括 manifestHash、角色 JSON、mapping、visualRig、atlas/页面纹理、skin 和适用的 reference/sequence/policy，按固定顺序规范化。依赖角色若就是当前 activeDoc，使用当前内存模型，磁盘 hash 仅作提交基线，不能把自身旧磁盘副本当作求解输入。
2. MCP 的 attached 读适配器将这份快照传入内存求解入口；需把当前 `solvePoseData` 的读盘准备与纯计算拆开，复用原算法。不能再用 activeDoc.path 重新读旧姿态 JSON，也不能生成可被误提交的临时资产来冒充内存输入。依赖若从磁盘读取，必须匹配快照的严格内容哈希；完成前再次核对，变更即停止。
3. MCP 求解、runtime 节点回读及比较后，经控制通道发布 `/api/derived{expectedRevision,snapshotHash,dependencyFingerprint,result}`。Host 核对当前输入未变、结果形状与引用产物哈希后原子替换派生缓存，返回 `derivedHash` 并发 `frame-updated`。该入口不接收批准字段，Host 不把 `ok:true` 当作批准；失败候选可显示，但保留 `diagnosticOnly`，没有提交授权。
4. 发布派生结果不增加编辑 revision、不写资产文件；结果存储绑定 snapshotHash 的完整指纹，不能沿用仅 hash(frame) 的新鲜度判断。重复发布同一结果幂等；同版本的新派生结果更换 derivedHash，并使旧截图/提交授权失效。
5. patch、undo/redo、重载或任何求解依赖变化，都清除当前派生缓存、比较/视觉批准和提交授权。旧图可作为明确标记的历史诊断展示；frame/capture 不得把旧图标成当前结果，缺结果返回 `NO_SOLUTION`，已知过期返回 `SOLUTION_STALE`。
6. B1 只消费磁盘中可证明新鲜的完整姿态快照；旧文件缺少覆盖完整求解输入的指纹时返回无法验证，并提示用 MCP 重算。B2 必须完成上述桥接，才能从新求解结果生成 player 产物；进入 C 前，读取内存、求解、发布、出图必须端到端通过。

**审查记录回传（C）**：现有 `spine_review_pose` / 动画审查等入口继续执行各自的必要检查、证据校验与逐阶段理由要求；成功后经控制通道 `/api/review` 登记不可变 reviewRecord。Host 验证完整版本、snapshotHash、derivedHash 与证据引用绑定，独立保存 reviewHash，不增加编辑 revision；记录变更使旧提交授权失效。普通 op 或 derived 不能写 review；新 patch、结果替换、依赖变化及打开周期变化使旧审查失效。commit 候选只序列化当前有效审查记录，读接口返回其真实新鲜度；批准本身不代替最终提交授权。

**C1 已实现的适配（2026-10-21）**：`spine_review_pose` 在 attached 下必须给 `expectedRevision` 与当前 `spine_preview_capture` 返回的 schema 2 `manifestPath`。MCP 读取内存 snapshot，以同一候选构造完整 solution/指纹，重验数值、参考标注、动作级 sequence/stage、实际关系与逐项视觉理由。`dryRun` 默认 true，仅预演且不写报告/审查/历史/资产；false 经私有控制通道登记 approved 或 rejected。所有批准须七项各自 status:pass 和不同具体理由；参考任务还须 stageId 精确一致。

参考关系报告在显式求解时生成 `.spine-mcp/live/<documentId>/<openEpoch>/<derivedHash>/comparison.json`，内容属于当前 derivedHash。审查不接受旧 comparisonPath，不按旧报告的 posePath 重读旧源姿态。正式保存使用同一候选指纹，保留 approved/rejected 审查与报告路径；新修订可独立复验，不依赖旧源姿态路径存在。后续读取已保存批准资产仍重验内容/参考/证据；这不等于把旧图重新登记为新会话的截图或批准。

Host 同时核对运行态严格字节哈希与持久审查证据哈希，禁止缺项、未解决问题或不同候选混入。已登记后 PNG/manifest/比较报告发生变化，state 将视觉状态标为 stale，候选预演、授权及发布前均以 `REVIEW_STALE` 拒绝，不能继续保存 confirmed。取消在登记前生效；登记开始后等待明确回执，不用网络取消声称登记未发生。review readiness 只表示可调用审查，数值失败时可退回，不能据 canRun 推断可批准；控制文件未受保护时禁止登记。


**渲染输入**：`RenderSnapshot={version,snapshotHash,dependencyFingerprint,bones,skin,slotAttachments,presentation,atlasPageHashes,camera,pma}`。

- `bones` 沿用当前源码：`{boneName:{rotate,translate:{x,y}}}`，是相对 setup pose 的增量。回放使用 `rotation=data.rotation+rotate`、`x=data.x+translate.x`、`y=data.y+translate.y`；不是直接覆盖骨骼绝对值，也不是 `{rotate,x,y}`。
- 每次先 `setToSetupPose`，选择 mapping.skin 并重置到该 skin 的 setup 插槽状态，应用 mapping.slotAttachments，再应用 `frame.presentation.attachments/drawOrder`，回放骨骼增量，最后 `updateWorldTransform`。未列出的骨骼、scale/shear 保持 setup 值。
- 当前求解结果没有 scale/shear 增量，不能凭空补值或静默忽略新字段；未来出现这类增量须先升级版本化回放 schema、测试和导出逻辑，否则拒绝该结果。
- `presentation`、skin、atlas 页面、相机和 PMA 都参与派生/渲染指纹。不能仅比较骨骼坐标就断言显示一致；必须比较 runtime 实际附件、完整 drawOrder 和可见顶点。
- C2 扩展 motion 时仍不在 Host 内求解：MCP 发布带时间/动画标识和严格依赖绑定的预计算动画候选；缺少候选时返回 `NO_SOLUTION`。B1/B2/C1 的 frame/capture 只支持 pose，其余 kind 返回 `UNSUPPORTED_DOC_KIND`；不能直接把语义 frame 当骨骼快照。

### 3.6 提交候选与授权（v1.6）

**默认 dryRun**：patch/undo/redo 的 dryRun 只计算候选与 diff，不改内存、栈或 journal；commit dryRun 不写资产、备份或授权，返回 `{version,candidateHash,outputPath,intent,diff,changedPaths,gateRequirements,readyToCommit}`。MCP 内部控制请求还取得完整 `candidateBytes`，用实际待提交字节执行规范/runtime 等审查；公开工具只返回摘要，不把整份候选注入 Agent 上下文。`candidateHash` 是确定性序列化后待落盘完整字节的 SHA-256，包含实际输出的有效派生/审查字段；不能用 contentHash 或磁盘基线 fileHash 替代。

`intent` 区分 `draft`（pose/motion 工作流草稿）与 `animation`（Spine 角色动画写入）。失败姿态可保存新路径草稿，但明确为未批准，不能借 draft 修改角色 JSON；写入 Spine JSON 一律走 animation 门禁。pose/motion 中由工具产生的审查记录只能来自既有审查流程，不能通过普通 patch 构造。

**真实提交顺序**：

入口先校验调用凭据，再查询工作区持久化的 requestId：同一请求的终态结果直接返回其原 committed version，不重新检查旧授权或重做写入；请求内容不同则 `REQUEST_CONFLICT`。没有终态的 prepare 先按 §5.2 恢复裁决，不能当作新事务重试。

1. MCP 读取精确快照和 commit dryRun 候选，执行适用门禁：Spine `4.1.24`、官方 JSON 规范、diff 白名单、结构引用、官方 runtime，以及参考任务要求的参考/绑定/阶段关系/视觉/完整动画审查。沿用既有 expectedHash/reviewToken 语义；draft 走其工作流校验和新修订规则，不伪造动画通过记录。
2. MCP 经控制通道调用 `/api/authorize`，携带完整版本、snapshot/依赖/derived/review 指纹、candidateHash、规范 outputPath、intent、基线/输出文件预期哈希、gateRecord 和适用 reviewToken。Host 仅登记可信控制通道的门禁结果，并核对它们属于同一候选；返回短期、单次使用的 opaque `authorizationId`。页面 token 或 Agent 自填 `approved:true` 不能签发授权。
3. 新的 `commit{dryRun:false,expectedRevision,authorizationId,requestId}` 在互斥区重新验证完整版本、精确候选字节、依赖/派生/审查指纹、target/pin、写入权 generation 及所有相关文件的预期哈希。任一变化返回冲突，原文件不变，必须重新 dryRun 和审查；force/pin/reopen 不能续用旧授权。
4. 事务写入持久 journal prepare 记录后，先为将被覆盖的文件生成备份；新增输出也记录源基线备份。临时文件与目标同卷，flush 后 rename 原子替换；备份或临时文件失败则不替换目标。不存在的输出按“预期不存在”保护，已存在输出必须显式绑定其哈希，不能无条件覆盖。
5. rename 成功后持久化 committed 记录、刷新基线哈希和 pin 基线、更新提交下界、清空栈及旧授权，再返回结果。**同路径提交也产生新 revision**，其新下界与当前 revision 相同；新路径按 §3.1 切换身份。返回 backupPath、hashBefore/hashAfter、candidateHash 与 committed version。响应丢失时按 requestId 查询/重试同一结果，不能再次执行事务；不同内容复用 requestId 返回 `REQUEST_CONFLICT`。

授权有效性不靠 token 名称推断；Host 保存不可变授权绑定，资产替换前逐项比对。门禁判定在 MCP，Host 负责身份/授权验证、备份和事务执行。journal 故障恢复见 §5.2；失败诊断、过期审查和 `advisory` 证据不能产生 animation 授权。

### 3.7 工程 manifest 与重开恢复（v1.7，H0）

**唯一工程描述文件**：工作区根目录 `.spine-workflow.json`。V1 一个工作区只管理一个工程；工程可登记多角色，首个闭环只选其中一个。manifest 负责索引和显式绑定，不保存在线 token、内存 revision、批准结论或每次渲染的瞬态状态。

```ts
interface ProjectManifest {
  format: 'spine-ai-workspace';
  schemaVersion: 1;
  projectId: string;                 // 与工作区登记一致；目录移动不自动重绑登记或复用会话
  name: string;
  characters: Record<string, {
    skeletonPath: string; atlasPath: string; mappingPath: string;
    visualRigPath?: string; skin?: string; spineVersion: string;
  }>;
  documents: Array<{
    path: string; kind: 'skeleton' | 'pose' | 'motion'; characterId: string;
    referencePosePath?: string; sequencePath?: string; stageId?: string;
    standardPosePath?: string;
  }>;
  references: { posePaths: string[]; sequencePaths: string[] };
  artifactRoots: { previews: string; reports: string };
  defaults?: { characterId?: string; documentPath?: string };
}
```

**初始化契约**：`spine_create_project{manifest, dryRun?:boolean, expectedAbsent:true}`，dryRun 默认 true。manifest.projectId 使用已登记的稳定 ID；工作区尚未登记时先显式登记，不静默改全局配置。dryRun 完整校验路径、角色和文档绑定，返回候选 manifest 与 hash，不写任何文件。真实初始化在项目元数据锁内原子创建并再次核对预期不存在；已有文件一律拒绝覆盖。角色 JSON、atlas、纹理、mapping 与 visualRig 均只读，不凭空生成已确认绑定。该工具在 C 前用于初始化元数据，不能被用于重写当前工程配置。

**绑定与迁移规则**：

- 所有路径相对当前工作区，经过 resolveWorkspacePath 与 realpath 祖先校验；manifest 不允许携带另一个 workspaceRoot。characters 至少一项，documents/references 可为空；文档 path 规范化后唯一，characterId、defaults 及参考引用必须有效。先检查结构与路径再读取依赖；省略 optional 不表示对应能力通过。
- 角色资源来自 characters；pose 自带的 filePath/mappingPath/visualRigPath、reference/sequence 等若存在，必须与工程声明相符；冲突返回 `PROJECT_BINDING_CONFLICT`，不自行选择一边。motion 按 documents.characterId 绑定角色与 mapping，不向旧 motion 强加一个不存在的字段。
- `spineVersion` 是声明，打开时仍读取 skeleton.spine 比对。版本不同或未支持版本可诊断，动画写入能力只能按 V1 的 4.1.24 审查返回。
- `spine_host_open{manifestPath}` 只打开工程并返回能力概览，activeDoc 为 null；再用 path 显式打开文档。两者一起提供可一步完成；只给 path 时读取工作区根 manifest。defaults 只用于建议，不默选、自动 pin 或批准文档。所有文档回执通过 activeDoc 返回，未打开文档的版本为 null。
- 已打开文档时调用 project-only open 视为关闭活动文档，须带完整 expectedRevision，并先持久化旧 journal；创建新的打开周期，不复用旧 pin。manifest 或其绑定在磁盘改变后返回 stale，清除派生/批准/授权；无未提交内容时才允许显式 reload，不在每次 state 中悄悄接纳新配置。
- 缺 manifest 的旧项目按 `mode:'legacy'` 返回可验证的显式路径信息，现有 detached 工具保持原有行为；不全盘猜测角色，也不自动生成文件。C 写入前必须初始化并重新打开受管工程。
- 未知 schemaVersion 返回 `PROJECT_SCHEMA_UNSUPPORTED` 与只读诊断；不自动降级重写。未来迁移必须独立 dryRun、备份并显式确认候选，本版不交付迁移器。

**新修订和产物索引**：manifest.documents 是初始登记，不随每次出图自动改写。C 新修订及其源文档、候选、报告、证据和输出关系写入既有事务/产物 manifest，派生索引保存在 `.spine-mcp/project-index.json`。索引可从已确认的 committed journal 与受管产物记录重建，不保存可自行批准的真相；提交不变成“资产 + 根 manifest”的隐式双文件事务。B 阶段初始化登记的文档已经可读；动态修订索引在 C1 交付。

managed open 的路径必须在根 manifest 或已核实的受管索引中，且索引沿 sourceDocument 关系解析到已登记角色；未知路径返回明确缺少绑定，不靠同目录文件名猜测。索引重建不恢复批准有效性；超出工作区或来源不明的记录不得作为新资产入口。

重开工程先校验根 manifest，再恢复已确认 journal/索引；更新 sessionId/openEpoch，核对所有依赖，旧 pin、旧授权及旧视觉批准不恢复为当前有效。缺资源、损坏索引或记录冲突须可见并有恢复建议，不用默认示例替换。

### 3.8 角色能力与逐操作 readiness（v1.7）

MCP initialize 的协议 capabilities 继续只声明实际实现的原语；下列 **applicationCapabilities** 来自工程、实现注册表与已校准角色。它们不等于批准状态。

```ts
interface OperationReadiness {
  operation: string;
  supported: true | false | 'unknown';
  state: 'ready' | 'busy' | 'blocked' | 'stale' | 'frozen' | 'unsupported';
  canRun: boolean;
  reasons: Array<{ code: string; message: string; path?: string }>;
  nextAction: { tool: string | null; arguments?: object; instruction: string } | null;
  retryAfterMs?: number;             // 仅暂时忙碌且有依据时提供
  checked: 'fast' | 'strict' | 'unknown';
  observedAt: string;
}
```

`/api/capabilities` 与 `spine_preview_state{includeCapabilities:true}` 返回同一套摘要：

- `context`：projectId、manifestHash、characterId、当前完整 version（未打开时 null）；
- `operations`：已实现且对当前 mode/kind 开放的操作、schemaId/schemaVersion、读写性质与 dryRun 支持，以及当前可写 timeline 白名单；C1 不声明动画写入能力，未交付 C2/D 的操作标 unsupported，不因工单出现过就列为可调用；
- `character`：实际 mapping 通道及对应骨骼、四肢链、anchor/gripPoint、稳定解剖对应、已确认 viewProfiles 与允许的 attachment/drawOrder 表达；每项含来源指纹与 confirmed/unknown 状态，不用标签宣称资源能力；
- `readiness`：open/inspect/evaluate/frame/capture/patch/review/commit 等逐操作状态。numeric fail 可以阻止批准，但已生成的诊断图仍可按现有规则观察；`commit` 的 canRun 还必须验证适用门禁与授权，不能仅看连接状态。

状态查询不求解、不生成报告、不自动校准，也不产生批准或提交授权。缓存的 fast 检查须声明新鲜度；批准、写入及新证据仍走 strict。canRun 是观察建议，执行前重新检查，不能作为授权令牌。`nextAction.tool` 必须是当前实际注册工具；需人工校准或能力尚不存在时置 null 并给出具体说明，不编造工具。

绑定缺失返回 unknown/blocked；明确没有侧背切片返回 unsupported；已有结果过期返回 stale；任务执行中返回 busy；写入权不明返回 frozen。一个操作受阻不把所有观察操作统一关掉；同样，preview 可用不能让 commit 显示已通过。

2026-10-23 实施补充：未打开、缺 pin、缺结果、持杖 gripPoint、依赖漂移、Host 串行队列、写入冻结及 undo/redo readiness 已补回归；显式 open 与独立观察分别判断，player 就绪不覆盖其它阻塞。busy 目前只观测 Host 串行事务，不宣称 MCP 外部求解任务全生命周期已接通。真实 npc1 隔离站姿 [30 次短时现场报告](host-observation-2026-10-23T06-47-10-591Z.json) 约 8.35 秒零 stale 误报，不替代 §5 的两周观察或公开启用评审。

### 3.8.1 MCP 外部求解观察租约（2026-10-23 续验）

上述“仅 Host 队列”的实现限制现由更新后的 `HostClient.evaluate` 补齐：在 snapshot 前登记任务，执行原求解/比较并发布 derived 后回报终态；取消或异常在 finally 中使用独立清理请求。任务记录不控制 Writer、授权、文档锁或算法位置，不改变 C1/C2 白名单。

- `/api/evaluation-task` 仅接受受保护的 MCP control、精确 Origin 和 JSON；页面 token 不能登记、续期或结束。`begin` 使用 `{action,taskId,leaseKey,expectedRevision}`，完整版本必须匹配当前 pose；`heartbeat` 使用 `{action,taskId,leaseKey,stage}`；`finish` 使用 `{action,taskId,leaseKey,outcome,stage?}`。阶段为 snapshot/solve/publish，终态为 succeeded/failed/cancelled。
- MCP 每 5 秒续期，15 秒无有效心跳标为 unresponsive，readiness 仍为 busy/EVALUATION_UNRESPONSIVE，不推断进程已退出或批准有效。没有直接清空任务的页面入口；租约持有者可回报明确终态，显式重载仍须经过原完整版本/未提交内容检查。
- 任务绑定 session/document/openEpoch/revision，旧版本任务不占用新版本的就绪状态，旧结果仍受 derived 完整版本与指纹检查。当前版本最多 16 个活动任务，内部保留最多 32 条终态，公开仅显示最近 4 条；state 和 SSE 不返回 leaseKey。
- `evaluation-task-updated` SSE 驱动页面刷新。页面显示计算中、完成、失败、取消或心跳失联；活动期间每秒只更新状态，不重复请求 frame，卸载页面不取消独立 MCP 计算。
- begin 回执丢失仍可用预先生成的 ID/租约清理；成功发布后终态回执丢失返回 TASK_STATUS_UNCERTAIN，并明确 published:true，不声称发布被回滚。已取消请求不登记新任务。
- 仅更新后客户端的 evaluate 链路提供此遥测。旧 Host 缺少端点时明确 HOST_VERSION_MISMATCH，需重启加载匹配源码；旧 MCP 或控制方直接调用 snapshot/derived 不会因此自动获得任务记录，空列表不能证明不存在未登记计算。

真实 stdio、心跳续期、实际独立进程终止、取消/异常及回执丢失已回归；[147 项记录](host-evaluation-regression-20261023.json)。带任务登记的新 HostClient 路径另完成三轮 90 个合成样本：端到端 P95 87.95ms、首次新版本 PNG 读取 25.39ms、state 11.93ms，三轮分别通过原预算；[独立汇总](host-client-performance-summary-2026-10-23T07-33-25-240Z.json)。该测量不含 stdio 或浏览器呈现，也不满足长期观察、第二角色、编辑器导入或公开启用条件。

本日事务编排后续又有修改，上段为历史。最终源码 [151 项回归](host-transaction-regression-20261023.json) 通过；最终性能以 §12.1 为准，patch P95 122.81ms 未达预算，撤销有一轮超过出图预算，不宣称当前全部性能已通过。

本日最后续验已解决上述性能遗留，最新 154 项回归及三轮通过结果见 §12.1 末段和 [C1 技术收口记录](host-c1-technical-closeout-20261023.json)；两周观察与公开启用条件不变。

### 3.9 命令 schema 与交互回执（v1.7）

- 每个命令有独立 schema 或判别联合；注册时由同一命令定义生成 MCP schema、Host 输入校验和能力描述。禁止仅向所有工具挂一个宽泛 poseProperties 后宣称参数已完备。
- H0 核对读写字段覆盖：明确 body/head/channels/targets/bendDirections/weapon/presentation 的现有入口、只读项与阶段限制；`spine_set_pose_channel.rotate` 必须在 schema 显式声明；depth 的提示路径统一为 `frame.presentation.drawOrder`。新增字段只写在 handler 而未公布 schema 时检查失败。
- 为坐标、单位和语义写入说明：手目标 x/y 使用 normalizedSkeleton，angle 为期望世界方向的度数；图片坐标不能传入 IK；旋转与平移是 setup 增量还是世界目标必须分别标明。批量 op 展开后的实际 diff 仍经过白名单。
- C1 的高层 edit→evaluate→publish→frame 编排返回 `{version, changedPaths, actualNodes, numeric, comparison, review, editorImport, freshness, image, nextAction}` 的摘要；actualNodes 来自 runtime，图像沿用 MCP image 内容块，不能回填自设目标冒充回读。每个状态允许 unknown/notRun，不合并为一个成功布尔值。
- patch 的事务提交与长任务计算分开：patch 已确认后求解可取消或失败，编辑版本不伪装成回滚，frame 明确无结果/过期；用户可 undo。长任务采用 L1.4 的进度/取消或既有 job 结果，不隐式多次应用 patch。
- `spine_get_pose_state` 的廉价查询与显式重算分级由 L2.1 实施；动态工具组发现放在后续，不阻塞初次闭环，也不引入自由执行代码的逃生入口。

---

## 4. 阶段 B：观察宿主（不改写入）

### 4.1 交付（B1 + B2）

**B1（无浏览器依赖，可先做）**

前置为 H0 工程/命令契约与完整求解输入指纹；现有 legacy 项目保持可诊断，C1 前须显式初始化受管工程。工程与能力查询支持无 activeDoc，不强制先求解才能勘察。

1. **`applyRenderSnapshot(skeleton, snapshot)`**：按 §3.5 回放 skin、mapping 附件、presentation 和 setup 相对骨骼增量；内部 `applySolution` 仅负责骨骼部分。
   - 同一 pose 用 `solvePoseData` 与完整回放所得关节及可见顶点坐标，最大绝对误差统一 **≤1e-4**；附件名称和 drawOrder 必须完全一致。
   - 保留 setup scale/shear；未知增量字段拒绝回放。测试涵盖非零 setup 旋转/位移、未列出骨骼、切皮肤、附件隐藏/替换和层序变化。
   - **这是 B“只渲染不求解”的前提**；不把关节一致替代完整显示状态一致。
2. `/api/open`（含依赖解析）+ activeDoc 内存态、完整版本及 `/api/snapshot`；B1 仍是观察者。
3. `/api/state` + `/api/capabilities` + 页面上报 + 1s 心跳 + `sessionId`；区分角色能力、逐操作 readiness 与审批状态。
4. `/api/frame`：`applyRenderSnapshot` → `rasterFrame`；同角色固定相机；无结果/过期分别为 `NO_SOLUTION` / `SOLUTION_STALE`；限流 20/s；**B1 仅支持 `pose`**，skeleton/motion → `UNSUPPORTED_DOC_KIND`。
5. `/api/events`（SSE 心跳 + `Last-Event-ID`）+ `/api/doc`。
6. MCP：`spine_host_open`（含 detached 镜像）、`spine_preview_state/frame`。

**B2（需要浏览器能力，见 §4.5）**

7. 完成 §3.5 的 MCP 内存输入适配器与 `/api/derived`：读快照 → 原算法求解 → runtime/比较 → 带完整版本发布结果。覆盖迟到结果与依赖变更拒绝。
8. `/api/capture`：首批仅 pose，**必须**由 MCP 从当前快照生成不可变 live 候选（§4.4）；固定 viewport/canvas/DPR；摆帧 `pause → clearTracks → setAnimation → apply → 2×rAF`，1.2s 为待测超时预算，另检查 visibilityState；开始与完成两次核对版本及 derivedHash。
9. `spine_preview_capture` + `ensurePreview()`；motion/skeleton 扩展移至 C2，不作为首批 B2 的阻塞范围。

### 4.2 B1 验收

- 完整回放与重新求解的关节/可见顶点最大绝对误差 ≤1e-4；skin、实际附件和 drawOrder 完全一致；
- 未 open 调 frame → `DOC_NOT_LOADED`；无 solution → `NO_SOLUTION`；pose 缺 mapping → `DOC_INCOMPLETE`；
- `/api/frame` P95 <50ms（480²）；完整版本、derivedHash、时间、相机等渲染输入相同的两次 PNG `sha256` 相同；完整版本不符 → 409；超 20/s → 429；
- 磁盘被改 → `targetStale:true`；
- detached 下 `open` 返回 `mode:'mirror'`，`frame` 仍可用（`source:'disk'`）；
- 同路径未漂移的第二次 `open` 幂等；外部改文件后 reopen 返回 `TARGET_STALE`，不刷新 pin 基线；显式 reload 创建新 openEpoch；
- A→B、A→B→A 后发送旧 frame/snapshot 请求均返回 `REVISION_CONFLICT`，即使数字 revision 相同；
- 对 skeleton/motion 调 frame → `UNSUPPORTED_DOC_KIND`。
- 无 activeDoc 可读工程能力；未校准 viewProfile/anchor 返回 unknown，明确缺失的视角返回 unsupported；这些结果不能被在线绿灯覆盖；
- state/capabilities/digest 查询的 solve 次数为 0；实际计算仅由明确 evaluate/recheck 发起。

### 4.3 渲染与相机

- bounds 初值：`mapping.calibration.origin/scale` + 角色高度；首次可信的持久结果回放，或首次显式 MCP 求解结果通过发布校验时，取初值与实际可见顶点包围盒的并集，后者按最大边长留 5% 边距，防止头顶或脚部被裁切。Host 只读取回放顶点，不求解；无可信结果不自行猜测角色边界。
- frame 尺寸默认 480，只允许 320/480；capture 可用 960，背景固定 `#20242b`；
- `X-Source: solution`、完整版本头（sessionId/documentId/openEpoch/revision）、derivedHash、`Cache-Control: no-store`；
- 首次初始化后，同一 openEpoch 的 patch、undo、redo 与重复发布保持同 bounds，不随单帧自动缩放；新打开/显式重载建立新 openEpoch 后重新初始化。相机配置参与渲染指纹，旧版本证据不得沿用。数值通过但画面裁切时仍应退回视觉审查，不能自动放大后沿用旧批准。

### 4.4 capture 的前置（v1.4）

player 只认 **spine JSON**，pose JSON 不是：

| activeDoc.kind | capture 行为 |
|---|---|
| pose（B2/C1） | MCP 从当前快照生成带动画与时间的 Spine JSON，经既有官方规范和 runtime 检查后，以派生产物发布；Host 只加载并摆帧，不重新求解 |
| skeleton（C2） | 扩展能力验收后加载当前精确快照；与磁盘一致可直接加载，否则先输出不可变 live 副本，明确 exported；此前拒绝该 kind |
| motion（C2） | 扩展能力验收后加载 MCP 已发布候选；此前拒绝该 kind，不在 Host 临时求解 |
| 其它 | `DOC_INCOMPLETE` |

`viewport` 只接受与记录一致者；不一致时返回图但标 `advisory:true`（不得作证据）。

live 目录使用 `.spine-mcp/live/<documentId>/<openEpoch>/<derivedHash>/`，产物携带 `generated:true` 和输入指纹；不复用一个可覆盖的 `<project>.json`，防止并发截图取到另一版本。生成文件不可作为 commit 的源资产或目标；TTL 只回收已无引用的派生产物，不清理 journal/recovery。截图记录实际 skin、附件、drawOrder、候选字节哈希、相机、PMA 和 runtime 版本，浏览器预览不自由编辑角色 JSON。

### 4.5 Canvas 渲染器回归：默认 D，可选 A（v1.8 分层）

| 方案 | 说明 |
|---|---|
| **D（默认）** | 一次性人工产出 3 张 player 基线 PNG 提交到 `test/golden/`，manifest 绑定 player/core/回放 schema/渲染器版本、夹具与资源哈希、skin/presentation、PMA、相机、canvas/viewport/DPR。CI 重渲 canvas 侧与之比对（diff ≤0.5%、单像素 ≤8）。**不需要浏览器** |
| **A（可选）** | `scripts/golden-preview.mjs` 用 playwright 重生基线（本地装，CI 不装） |

- 版本守卫：player/core/回放或渲染器版本、夹具资源及渲染配置任一不符 → 测试 fail，重新核对并生成基线，**不静默通过**；
- `rendererParity.status` 为 `unverified / failed / passed`，附真实报告哈希和原因。缺基线为 unverified；运行失败或版本/输入失配为 failed；只有三张基线全部通过才为 passed。保留 `goldenPassed` 三态作为兼容诊断字段，不再用它替代 player 截图核验。
- 门限保持差异像素比例 ≤0.5%、最大通道差 ≤8；旧 region-v3 单样本最大差 40 失败。2026-10-22 的受限 region-msaa4-v4 与三张新 player 基线最大差均为 1，不能据此推断其它渲染配置一致。
- 回归只覆盖登记的资源、姿态和渲染配置，不能证明任意角色一致。本批 Canvas 图只作诊断，不作为最终视觉审查证据；即使回归通过，也不自动批准动作。

### 4.6 认证、端口与生命周期

```
.spine-mcp/host-port.json  { pid, port, token, apiVersion, sessionId, startedAt, instanceId }
```

- 端点优先级：`SPINE_HOST_ENDPOINT` > 端口文件 > 不可用。**使用 env 模式时必须同时提供 `SPINE_HOST_TOKEN`**（v1.5）；缺 token 直接判不可用，不回落端口文件（避免连到另一实例）。
- 页面 token 下发：注入 `<meta name="x-spine-host-token">`，`index.html` 强制 `Cache-Control: no-store`。独立 control 凭据存于工作区受保护的 `.spine-mcp/host-control.json`，绑定 sessionId/instanceId，仅由 MCP 本地适配器读取，不放入页面、URL、日志或 host-port 的公开响应；Host 重启即轮换。控制文件保护失败时只允许观察，禁止发布派生结果或授权提交。env 连接也须核对该工作区实例与控制凭据，不能凭页面 token 获得控制权限。
- 文件保护：POSIX `0600`；Windows `icacls`；失败降级 `security.mode:'token-only'`。**token 在两种模式下都必填。**
- 单实例锁：`pid` 存活 + `startedAt` 匹配 + 端口探活，三者同时通过才复用。
- `ensurePreview()`：`SPINE_HOST_AUTOSTART=0` 只探测；启动时注入 `SPINE_MCP_WORKSPACE=<activeWorkspaceRoot>`，`cwd=installRoot`，日志 → `.spine-mcp/host.log`，退避 100/300/900ms。
- 工程切换：不复用旧 Host，先 shutdown 并确认在途事务结束、journal flush、写入权释放，再按新 workspace 重启。B 阶段同样实现 shutdown；仅收到 202 或等待超时不算交接成功。
- 端口文件、心跳与排他写入锁用途不同：前两者用于发现与在线状态，写入权只能按 §2.2 验证。Host 无响应先冻结；不得因自动重启或关开 flag 绕过所有权交接。

### 4.7 验收（Host 组 B1：3 工具；B2 后：4 工具）

B1：`spine_host_open` / `spine_preview_state` / `spine_preview_frame` 三件，合法输入在未启动 Host 时报告 `ok:true, available:false`、<900ms；frame 可另带 offline-canvas 结果，available 只表示 Host 可用性。缺文档/错误路径等按错误码返回，不把它们伪装成 Host 缺失。
B2：追加 `spine_preview_capture`，并满足：后台标签 → `CAPTURE_TIMEOUT`；错误 token/缺 Origin → 403；`../` → `PATH_FORBIDDEN`；三元组缺失 → `advisory` 且 review 拒收。

B2 还须通过快照求解闭环：显式重算后的快照得到新结果及新画面；旧版本结果、改动依赖后的结果和截图过程中发生的版本变化均被拒绝；不支持的 kind 不得静默求解。内存 patch 的完整演示在 C1 验收，内部桥接端点不增加公开 MCP 工具数量。

初始化工具 spine_create_project 属 H0 工程组，单独计数，不混入 Host 组；至 B1 合计 4 个新增公开入口，至 B2 合计 5 个。B2 首批 motion/skeleton 均拒绝，后续行为以 C2 能力表为准。

**2026-10-21 实施注记**：region 修正后的单样本最大通道差仍为 40，未达到 §4.5 的 8；正式三张基线尚未建立，`rendererParity:unverified`。按 v1.8，新采集的真实 player 合成夹具截图已通过独立核验并具备证据准入资格；这不是美术验收，B2 不据单次联调整体通过，C/C2 不自动启用。

**2026-10-22 更新**：已实现无 tint、不透明、普通混合 region 的有界 4x MSAA，三张新采集的官方 player 基线全部通过：差异比例 0.152%、0.081%、0.146%，最大通道差均为 1；资源、脚本、runtime 实际回读、skin/presentation 与编译版本一起核验。其余配置仍走原渲染器，未计入该范围。见 [正式复验记录](host-golden-20261022.json)；不据此开放公开写入或批准真实角色。

### 4.8 已确认：渲染器回归与截图证据分层

2026-10-21 用户确认本节。分四层报告，任何一层都不代替下一层：

| 层次 | 通过要求 | 影响 |
|---|---|---|
| 结构与数值 | 官方规范、引用、完整 runtime 回放 ≤1e-4、附件/层序完全一致 | 继续作为硬门禁；失败候选只能诊断 |
| Canvas 回归 | §4.5 三张基线、原像素门限与版本/输入绑定 | 独立记录 rendererParity；未通过的 Canvas 不能作验收证据 |
| Player 截图可信 | 当前版本/快照/依赖/候选、实际 runtime 与资源、固定相机、可见页面及截图配置均核验 | 只授予进入视觉审查的资格，不授予动作批准或写入令牌 |
| 动作与交付 | 当前参考关系、支撑、轮廓、握持、逐项 Agent 视觉与独立编辑器导入 | 各自报告；不得由截图、绿色指标或合成夹具替代 |

新 capture manifest 使用 `evidenceSchema:2`：

- `rendererParity:{status,reportHash,reasons}`：仅表示 Canvas 与登记 player 基线的回归结论。
- `captureValidity:{status,checks,reasons}`：由 Host 核验当前单次 captureId、完整 VersionRef、snapshotHash、contentHash、dependencyFingerprint、derivedHash、candidateHash，以及实际 skin、骨骼世界变换、可见顶点、附件/drawOrder、相机、PMA、viewport、canvas、DPR、页面可见性、资源字节及官方 player 脚本哈希；任何缺项不默认通过。
- `evidenceEligible:true`：仅限本批官方 player 来源、核验通过、在当前 Host 内登记且 PNG/manifest 严格哈希未变化的截图。`advisory` 表示本截图不具备准入资格，不再因 Canvas 回归失败而单独设置。

审查时再次验证完整版本与依赖、派生/候选及文件哈希。MCP 提交 `{source:'player',filePath,hash,manifestPath}` 引用；不能通过传入 `evidenceEligible` 或 `goldenPassed` 获得资格。缺 schema 2、旧截图、重启后遗留图均须重新采集，不从旧字段或外观推断通过。版本切换、编辑/undo/redo、重载或依赖漂移后必须使用新证据。拒绝记录可保留诊断图；批准至少需要一张当前合格的 player 图及原有全部内容门禁。

核验范围是受控本机页面与 Host 的协议、资源及 runtime 回读，不是针对恶意本机进程的图像来源密码学证明；不把这些字段描述成独立的浏览器安全证明。

正例：Canvas 回归 unverified/failed，但官方 player 当前截图完整核验通过，可进入人工/Agent 视觉审查。反例：Canvas 回归 passed 但 player 截图过期、后台、错误资源、视口/DPR不符或 manifest 被改，均不准入；截图准入通过但数值/参考/视觉失败，仍不得批准。没有浏览器时只给 Canvas 诊断，不将它升级为 player。

---

## 5. 阶段 C：会话宿主（C1 最小闭环，C2 扩展）

**公开启用前置**：B 稳定 ≥2 周；`TARGET_STALE` 零误报；按 §4.8 完成当前官方 player 截图准入及独立视觉验收；Canvas 回归缺口仍单列，不用其通过状态替代截图与动作验收；§3.5 的内存读取/求解/发布/出图已通过。观察窗口用于启用评审，研发可提前在隔离夹具和关闭写入开关下验证，不以日历代替通过证据。C1 不等待三 kind 全量迁移或 D 搬迁求解器。

2026-10-23 实施补充：长期观察 CLI 在正常 observer 上每 60 秒真实采样，以本机签名链、会话索引和末端哈希保护完整性，逐次验证依赖、版本、构建、工程与双时钟。超过 150 秒的采样间断不补在线时长；同候选需跨度至少 14×24 小时、覆盖至少 14 个 UTC 日期且无待处理错误，才进入人工覆盖评审，不能据此自动启用。测试时钟和合成两周夹具明确排除。人工审批另绑定四份验收文件、六项具体理由与限定 C1 范围；24 小时内可发起启动校验，非自动到期 Writer。`SPINE_HOST_WRITE=1` 必须同时提供 `SPINE_HOST_ROLLOUT_APPROVAL`，旧意图标志不独立授予权限。关闭等待在途事务、落盘撤销后释放 Writer，失败冻结。操作与信任边界见 [长期观察与启用流程](../Host长期观察与启用流程.md)。当前只获授权在已验收 npc1 站姿隔离工程试运行，无真实两周通过记录或生产启用审批。

§5.0–§5.6 是 C1/C2 共用的安全与事务约束，不能因分批而删除备份、授权、完整版本、失效或冻结规则；具体交付白名单以 §5.7 为准。

### 5.0 打开与绑定

1. 按 §3.1 open：新打开周期建立完整版本并清除 target；同路径幂等 open 保留当前绑定；
2. `spine_host_pin{expectedRevision}` → 记录 documentId/openEpoch/docPath、pinnedAt、fileHashAtPin 与依赖基线；存在漂移直接拒绝，没有 force 绕过；
3. 四个写工具要求 pin 匹配当前打开身份、完整版本和排他写入权。pin 只绑定目标，不批准内容。

### 5.1 op 语法

```jsonc
{ "op": "<kind>", "path": "<稳定定位串>", ...字段 }

{ "op": "setPoseParameters", "path": "pose/frame/channels/torso", "patch": { "rotate": 12.5 } }
{ "op": "setSlotAttachment", "path": "pose/frame/presentation/attachments/st", "slot": "st", "attachment": "st2" }
{ "op": "setDrawOrder", "path": "pose/frame/presentation/drawOrder", "order": ["zs1","zs2","st"] }
{ "op": "setKeyframe", "path": "animations/idle/rotate/bone3@0.4", "animation": "idle",
  "timeline": "rotate", "bone": "bone3", "time": 0.4, "field": "value", "value": 8 }
{ "op": "setPoseTarget", "path": "pose/frame/targets/leftHand", "role": "leftHand",
  "x": 0.12, "y": -0.4, "angle": 15, "contact": false }
```

**乐观锁**：所有修改使用完整 `expectedRevision: VersionRef`。不仅防 Host 重启，还防文档切换及 A→B→A 的版本数字重复；缺少任一字段拒绝请求。

约束（整批校验，不半应用）：规范化后的实际修改路径不能重复/重叠；drawOrder 为现有插槽全集置换；数值有限、angle ∈[-180,180)；op 与 kind 不匹配 → `UNSUPPORTED_DOC_KIND`；每批 ≤200；值深度 ≤8。例中的插槽名为占位，实际必须提交全集。

| op | 允许范围与落盘含义 |
|---|---|
| `setPoseParameters` | pose 的 body/head/channels、bendDirections、weapon、groundY 等显式白名单参数；不接受 source/reference/审查/solution 或任意 JSON 路径 |
| `setPoseTarget` | pose 的既有手脚语义目标；坐标仍为 normalizedSkeleton |
| `setSlotAttachment` / `setDrawOrder` | pose 中修改 frame.presentation；用于 skeleton 时必须显式 animation/time，且只生成已有 attachment/drawOrder 时间线 |
| `setKeyframe` | skeleton 的指定动画及已支持 timeline；保留 4.1.24 的官方字段与 curve 规则 |

上述为 C2 的完整 op 目标，C1 只开放 §5.7 的单手 setPoseTarget。删除旧 setBone 示例，禁止提交 `/bones/*`、setup slots/skins/mesh/constraints/events 等结构修改。瞬时摆姿必须由 pose 参数产生，不能借骨骼直写落到 setup。motion 修改继续复用现有受控 motion 工具的校验并生成新候选；没有完成适配的操作不能自动退回直写。

**diff**：`[{path, before, after}]`，按 `path` 字典序。

真实 patch 在私有副本完成校验，先持久化 journal 操作，再原子发布新内存及 revision，清除派生/比较/批准/授权并发事件；journal 写入失败不得改变可见状态。批准记录不允许通过 op 注入。

### 5.2 冲突裁决（journal 按 doc）

```
.spine-mcp/journals/<documentId>.jsonl
header: { documentId, docPath, sessionId, lastCommittedHash, lastCommittedRevision, apiVersion }
// sessionId 仅用于审计与排查，**不参与校验**：重启换 sessionId 不得导致 journal 被判无效（v1.5）
```

| 磁盘 hash | journal | 处理 |
|---|---|---|
| == lastCommittedHash | 有未提交 op | 重放，`uncommitted:true`，`doc-opened{recovered:true}` |
| != lastCommittedHash | 有未提交 op | **磁盘赢**：归档 `<hash>.rejected-<ts>.jsonl`，告警 |
| 任意 | header 缺失/损坏 | `JOURNAL_CORRUPT`，归档并告警 |

恢复时生成新 openEpoch，将已确认操作重放为该周期的新版本；不恢复 pin、提交授权或旧视觉批准。旧 revision 只用于审计，不充当新会话凭据。

**提交恢复**：prepare 记录必须含 requestId、authorizationId、源与输出路径/预期哈希、candidateHash、备份位置和写入权 generation。若进程在 rename 后、committed 记录前崩溃，恢复时先按目标字节哈希裁决：等于 candidateHash 则补记提交完成并消费授权；等于预期旧值则记录未完成，不自动重试写入；两者都不等则隔离并报告冲突。不得直接套用普通未提交 op 的“磁盘赢”规则。

**commit 到新 outputPath**：成功事务后创建新 documentId 的 journal header，基线为新文件 hash、下界 0；旧 journal 追加“该批改动已提交到新路径”的完成记录并保留审计，不能再次恢复为待提交 op。禁止直接提交 `.spine-mcp/live/`、recovery 或其它生成文件为交付资产。

### 5.3 写入前置：强制 pin + 两级 drift

- 未 pin → `TARGET_NOT_PINNED`，`remediation:'先调用 spine_host_pin'`；
- Host 级：`fileHash ≠ fileHashAtPin` → `targetStale:true`，写操作 `TARGET_STALE`；
- MCP 级：语义指纹不一致 → `TARGET_DRIFT`；
- Host 重启后 `pinned` 不恢复；`commit{outputPath}` 切换时自动解除。
- commit 必须经过 §3.6：dryRun 精确候选 → MCP 门禁与控制通道授权 → 事务内重验 → 备份 → 原子替换。pin、页面 token、有效 revision 或 `force` 均不替代提交授权。
- 同路径成功 commit 更新 fileHashAtPin 与新提交下界；未来外部改文件仍立即 stale。依赖变化即使角色字节未变，也使派生结果、审查和授权失效。

### 5.4 undo / redo

- 只作用于未提交 op；不能越过提交基线；触底 `no-op`；
- `commit` 清空两栈；**切到新 doc 时 revision 与下界一起归零**；
- 每次成功 undo/redo 产生新 revision，恢复的是编辑内容而不是旧版本数字；清除派生/审查/授权，新 patch 清空 redo。
- 栈归当前 doc 的共享顺序历史，记录操作 clientId 用于审计；不按客户端分桶后跳过他人操作取逆补丁。客户端必须携带最新完整版本，才能撤销当前栈顶；切换后旧栈不直接复用，依据 journal 重建。

### 5.5 交付

1. C1 的 pose Document Store、完整版本、单手 setPoseTarget 与 open/pin；C2 再扩到三 kind 与完整 op 目标；
2. `patch/commit/undo/redo`；按 doc journal、默认 dryRun、候选授权、备份及崩溃恢复；
3. attached 的资产读取经 snapshot，修改在 Host 内存，求解/比较在 MCP，结果经 derived 回传；编辑与出图闭环须先于写入迁移完成；
4. 受管的 skeleton/pose/motion 资产保存经 Host RPC，拒绝直写；报告、缓存、live 副本和 MCP 门禁记录使用独立产物目录，不将全部 `saveJson` 无差别重定向。对未完成 attached 适配的资产工具返回 `WRITE_FORBIDDEN`，不能静默降级；
5. 写入权遵循 §2.2；掉线 → frozen + degraded，恢复依赖持久 journal；确认交接后才回 detached。禁止承诺失联后仍能读取内存写 recovery。

### 5.6 共用验收（C1 后 Host 组 9 个公开工具）

`spine_host_open/pin/patch/commit/undo/redo` 六个与 `spine_preview_state/frame/capture` 三个协同时（snapshot/derived/review/authorize 是内部端点）：

加 H0 的 spine_create_project 后为 10 个新增公开入口。L1/L2 的独立工具另算；C2 扩展现有入口支持的操作，不靠工具数量宣称完成。

- 100 次真实 patch + 20 次 undo 后 revision 单调增加，内存内容符合历史；commit 前资产文件 hash 不变，commit 后字节精确匹配授权 candidateHash；所有 dryRun 不改内存/栈/journal/资产；
- 强杀重放 `recovered:true`；手改磁盘后重启 `rejected`；
- 两个 doc 交替打开，journal 互不串；A→B→A、reload、提交新路径及 Host 重启后，旧完整版本在所有相关接口均被拒绝；
- 两个客户端同时提交相同版本的不同 patch，仅一个成功；另一个 `REVISION_CONFLICT`；undo 产生新 revision，不能让旧请求重新有效；
- 未 pin 四写工具全 `TARGET_NOT_PINNED`；外部改文件 → `TARGET_STALE`。
- 修改内存目标后，MCP 求解确实使用新目标；发布期间再改输入或依赖，旧结果不能生成当前画面、批准或提交授权；
- 缺授权/页面伪造授权/候选或输出路径不符/过期或消费过的授权均拒绝；失败诊断不能获得 animation 授权；setup 修改被白名单拒绝；
- 合法审查经 MCP review 桥接进入提交候选；普通 patch/derived 注入 review 被拒绝；更换结果或审查后旧授权失效；
- 备份失败/rename 失败时不报告提交成功；注入 rename 后断电点可恢复正确事务状态；响应丢失按同 requestId 返回同一结果，不重复应用；
- 模拟仅网络失联、Host 仍存活：MCP 保持冻结且无法直写；确认释放或死亡并排他接管后才可 detached；旧 Host 恢复不能再提交。

### 5.7 C1 / C2 交付范围与首次闭环（v1.7）

| 范围 | C1：首次可发布闭环 | C2：通过 C1 后扩展 |
|---|---|---|
| 工程/活动资产 | 一个受管工程、一个已绑定真实角色、一个 pose；其依赖只读 | 在同一模型下接通其他 pose、motion 与 skeleton 动画 |
| op | 每次真实 patch 仅一个 setPoseTarget，role 为 leftHand 或 rightHand，仅修改 x/y/angle；默认 dryRun | setPoseParameters、其他目标、受控附件/层序及时间线命令，逐项独立 schema |
| 固定条件 | 解剖身份、支撑脚、弯曲分支、mapping、visualRig、参考与相机不随局部修改改变 | 需要改这些条件时走各自已有校准/审查流程，不作为普通姿态补丁 |
| 保存 | 仅 intent:draft 的 pose 新路径/新修订；源角色、atlas/PNG、mapping、rig 不变 | 受支持 motion 草稿及 4.1.24 动画写入，沿用所有适用门禁 |
| 呈现 | 当前 pose 的实际 runtime 节点、干净/诊断图及 player 候选，完整版本绑定 | 多关键姿态、时间采样、完整动画对比；增加 animation/time 选择契约后才开放 |
| 历史/恢复 | 当前 pose undo/redo、合法审查桥接、授权、备份、崩溃/响应丢失恢复、工程重开 | 多文档切换恢复、跨 kind 及较大批次的扩展覆盖；共用安全约束不后移 |

手目标被 weapon/grip 或其它已确认约束接管时，能力查询必须说明受控字段，C1 不得声称修改 x/y 会生效；返回具体阻塞，选择可独立调节的已校准姿态做成功验收。不得临时移除持杖约束或解剖身份来通过闭环。

**首个端到端演示**：

1. 打开 manifest，再显式打开已校准姿态；返回角色/依赖、可操作手目标、逐操作 readiness 及证据新鲜度。成功样本应预先具备适用的标准姿态/参考审查，npc1 当前失败准备帧继续用作负例，不能冒充成功基线。
2. 对一只手执行 dryRun，确认资产、内存、栈和 journal 均未变；真实 patch 后分配新修订元数据、递增版本并清除旧批准，读取 snapshot → 原算法求解 → runtime 比较 → 发布 → 返回新图和实际节点。
3. 再修改一次并 undo；输入内容恢复到前一姿态，revision 继续递增，不恢复旧批准。发送旧请求、旧求解结果及旧截图，均不能覆盖当前文档。
4. 按适用流程审查；经 draft 授权和备份保存新 pose 路径，重开工程后从 manifest + 受管索引恢复其来源和依赖。失败候选只能保存为明确未批准的诊断草稿，不产生 animation reviewToken，不修改角色 JSON。
5. 注入 Host 失联、备份失败和提交响应丢失；分别验证冻结、不替换资产和 requestId 幂等。保持 C1 白名单，未适配工具调用直接拒绝。

C1 通过只说明持续 pose 编辑、回读、撤销和重开可用。C2 的动画提交须另外完成多阶段数值/runtime、关系、Agent 视觉与独立 Spine 编辑器导入；真实导入失败时先恢复最近确认可用的备份再重新制作，不在错误文件上追加修补。最终推广还须第二个真实美术角色验证，合成夹具不替代真实验收。

### 5.7.1 C2 研发增量（2026-10-23，用户指示开始）

研发先后顺序如下，属于本工单内的实施拆分。提前研发不等于公开启用或阶段验收；C1 未完成事项继续保留。

| 增量 | 具体范围 | 当前状态 |
|---|---|---|
| C2-1 pose 参数与原子批次 | body、head、已声明通道、既有手脚目标，schema/能力/历史/恢复/草稿/实际 MCP 出图 | 已实现，隔离验证；无真实美术批准 |
| C2-2 pose 呈现参数 | setSlotAttachment/setDrawOrder，已有附件与插槽全集置换，独立恢复和 runtime/live 回读 | 已实现，隔离验证；真实美术/player 审查另验 |
| C2-3 motion/skeleton 呈现 | 显式 animation/time、当前版本派生及 player/frame/capture、多文档切换 | 已实现，机械及真实 WebView2 合成夹具验证；真实美术验收保留 |
| C2-4 高层创作与动画提交 | 原高级工具附着适配、4.1.24 timeline、完整动画审查、第二真实角色与编辑器导入 | a～c 工程链路已隔离实现；真实完整动画、第二角色、实际负载及编辑器导入仍待验 |

C2-1 使用 `c2-pose` 研发 profile，仅程序内隔离 Host 构造参数可选；没有页面、HTTP 或生产命令行切换入口。生产默认为 `c1`，仅接受单个手目标，C1 人工审批在任何 C2 profile 上均拒绝启用。`capabilities.editing` 声明实际 profile、experimental、schemaVersion、patchOps、可用目标和参数；能力指纹包含 profile。公共 MCP 工具仍为 101 个，spine_host_patch 的发现 schema 覆盖已实现的 C2 输入，执行时仍按连接实例的实际 profile 拒绝超范围请求，不能据 schema 声称生产已经支持。

| C2-1 操作 | 精确参数 |
|---|---|
| setPoseParameters，path=pose/frame/body | patch 中 x/y/rotate 的非空子集，保留其它 body 参数 |
| setPoseParameters，path=pose/frame/head | patch={rotate:角度}，写入 frame.head 的 setup 旋转增量 |
| setPoseParameters，path=pose/frame/channels/通道名 | patch 中 x/y/rotate 的非空子集；只接受 mapping 声明且真实存在、未由 IK/follow 接管的骨骼；新增通道值缺项以零补齐 |
| setPoseTarget，path=pose/frame/targets/role | role 为既有 leftHand/rightHand/leftFoot/rightFoot；x/y/angle 非空子集，要求有效三段链和末端锚点 |

坐标仍为 normalizedSkeleton，角度为度且在 [-180,180)。body 与映射到同骨骼的通道按既有 runtime 增量累加，不把通道当成独立骨骼。weapon 接管的手 x/y、接地脚的 y 明确拒绝；本批次不修改 contact、weapon、groundY、bendDirections、参考、左右身份或校准绑定。无法表达的通道名（路径分隔/转义/控制字符、原型保留名）明确拒绝，不猜对应。

每批 1–200 项，完整预校验后才制作候选，重复/重叠路径、未知字段、空补丁、非有限数、角色/路径错配及任一后项失败均整批拒绝；默认 dryRun 不改内存、revision、历史、journal 或资产。真实批次只发布一个新 revision 和一条编辑事务，清除旧结果/批准，经 MCP 求解和实际回放返回 PNG；一次 undo/redo 对应完整批次。恢复重验当前 profile 的固定绑定与参数白名单，C1 不重放 C2 扩展历史，拒绝不完整通道或无效参数，不恢复旧批准。pose 新路径草稿沿用精确授权、备份、幂等和重开；未开放动画提交。

首两批回归使用合成机械夹具，仅验证协议和事务，不冒充真实美术验收。C2-4、真实 C2 工作负载性能、当前 player 逐项美术视觉与适用编辑器导入均单独保留。

C2-2 沿用同一隔离 profile 和原子批次。`setSlotAttachment` 使用 `{path:"pose/frame/presentation/attachments/转义后的插槽名",slot,attachment}`，attachment 为当前皮肤或 default 回退中既有名称，null 表示隐藏；path 与 slot 必须严格对应，名称中的 `/`、`~` 分别转义为 `~1`、`~0`。`setDrawOrder` 使用 `{path:"pose/frame/presentation/drawOrder",order:[...]}`，必须给出现有插槽全集的唯一置换，不接受部分列表或重复项。

修改仅进入 pose.frame.presentation；实际官方 runtime 验证当前皮肤、附件与 drawOrder 引用，MCP 沿用现有 presentationTimelines 生成不可变 live，结构/官方规范审查及 runtime 骨骼、顶点、附件、完整层序 ≤1e-4 对照保持不变。角色 setup slots/skins/atlas/PNG 不改，尚无角色动画提交。`capabilities.editing.presentation` 提供所选皮肤/default 的声明名称、规范 path 和可隐藏状态，不冒充 runtime 实际回读；实际结果仍由 derived.renderState 与 player 证据独立确认。undo/redo、journal、草稿保存和跨 profile 拒绝覆盖呈现批次；真实美术视觉批准、第二角色、编辑器导入与 C2-4 未完成。

C2-3 沿用同一研发 profile，只为已绑定受管角色且 skeleton.spine 为 4.1.x 的 motion/skeleton 开放观察。`capabilities.viewing` 列出 supportedKinds、animations 的名称/时长、selection 和 setupPose；其它版本只读结构，不用 4.1 runtime 强行解析。不新增 MCP 工具或生产开关。

- `spine_host_open{path,animation,time,recheck?}` 必须显式成对给出动画名称和有限非负时间；时间不得超过该动画时长，不自动选首动画或循环取模。仅 skeleton 可用 `animation:null,time:0` 观察 setup。首次不带选择只看结构；已有同路径不带选择保留当前选择，同选择幂等。
- 改变选择携带旧完整 expectedRevision，产生新 openEpoch，清除派生、pin、截图和审查；其它文档切换先持久化 pose journal。重启后重开 pose 可恢复草稿，motion/skeleton 不继承旧选择或候选，须重新指定。
- `recheck:true` 是 MCP 的显式计算：skeleton 输出当前精确只读快照，v2 motion 复用既有迭代求解器预计算完整 dense 线性候选；已有 poseWorkflow 仍须通过原姿态门禁。候选发布前后严格核验全部依赖，Host 不求解。只写 `.spine-mcp/live/`，不写源动画，不发动画提交令牌。
- snapshot/derivedHash 绑定 view。frame/capture 可省略选择以读取当前活动选择；提供时必须完全匹配，否则 VIEW_SELECTION_MISMATCH。缓存命中、截图资源包、回传和登记均重新校验 live 字节，篡改拒收；选择变化后旧帧、派生和在途截图均失效。
- 数值仅标 `previewOnly`、`diagnosticOnly:true`，记录当前采样有限性和预计算不可达数量，不标整段动画通过。player manifest 另记 kind/view，实际骨骼、顶点、附件、层序、资源、相机与可见性仍独立核验；截图准入不代表动作批准。non-pose 的 pin、patch、审查、commit 仍拒绝。

本轮证据见 [C2-3 索引](host-c2-playback-20261023.json)。真实 WebView2 合成夹具验证 skeleton、motion、setup 的首图/恢复截图，不替代真实角色美术、参考关系、完整动画或独立 Spine 编辑器导入验收；C1 固定候选的观察仍单独计时。

C2-4 按现有退出条件继续分步，不新增计划或放宽验收：

| 子项 | 实施边界 | 状态 |
|---|---|---|
| C2-4a 既有姿态命令附着 | target/channel/batch/adjust 四入口读取完整版本并转换为现有 Host 原子补丁，返回当前帧；不借旧工具直接保存 | 已实现及隔离验证，见 [证据](host-c2-pose-commands-20261023.json) |
| C2-4b 参考与高层资产流程 | 标准/关键姿态创建、参考适配与修正、motion 生成的内存输入、Host 资产保存及原审查衔接 | 工程接入及隔离机械验证完成，189/189；真实美术、完整 C2 和公开启用另验 |
| C2-4c 动画审查及提交 | 精确 4.1.24 timeline 候选、完整动画门禁/授权/备份/恢复，以及第二真实角色和独立编辑器导入 | 工程接入及隔离验证完成；仅研发 profile 可提交，真实交付与原退出条件未完成 |

C2-4a 对 `spine_set_pose_target`、`spine_set_pose_channel`、`spine_batch_pose_ops`、`spine_adjust_pose` 公布两种明确输入：detached 必须 `outputPosePath`、不接受 `expectedRevision`；隔离 C2 attached 必须完整 `expectedRevision` 和当前 `posePath`，不得提供 `outputPosePath`，只改内存，保存另用 `spine_host_commit`。schema 以 anyOf 声明输出路径或版本至少一项，具体 mode 再拒绝混用；不忽略旧输出路径或擅自猜版本。

C2-4b 的计算基础将 `createPoseDraftData`、`requireReviewedPoseData`、`buildMotionFromPosesData`、`poseGateData` 和 `retargetReferencePoseData` 作为内部入口；调用方读取器仅提供原始姿态值，不得直接返回“审查通过”来绕过内容门禁。姿态输入先复制，标准/关键姿态在一次 motion 操作内按规范绝对路径固定首次值，缺失或失效时不回退同名磁盘旧修订；依赖、参考、比较报告与证据仍严格校验。计算入口不写候选、seed 或报告，也不生成授权。参考局部修正复制姿态和旧比较输入，原 60 次上限、必要节点、身份/支撑/弯曲分支及逐项视觉条件保持。

motion 生成与复核现在共用前置规则：2–2000 个递增关键阶段，起止覆盖 0/duration、非空且唯一阶段 ID、已确认标准站姿、同角色/地面及 action 的标准绑定；参考阶段仍核对当前比较、左右身份/视觉绑定及独立理由。复核还校验 motion 结构、地面与已批准关键帧内容，失败不返回门禁指纹。新增能力只在 MCP 计算层；现有 Host commit 的同类型 pose 新修订事务尚不能登记 pose→motion，后续须完成跨类型来源绑定、精确授权、备份/幂等/故障恢复和重开，再开放高级工具 attached 调用。既有生产入口和 C2 退出条件不变。

2026-10-24 上述“后续登记/保存”已接通，原段落保留为 10-23 计算基础范围。`spine_create_pose_draft`、`spine_retarget_reference_pose`、`spine_refine_reference_pose`、`spine_build_motion_from_poses` 的隔离 C2 attached 调用均要求完整版本。默认预演不改内存或资产；`dryRun:false` 只在 Host 暂存一个候选，返回 candidateHash/outputPath/kind，来源文档和历史不切换。参考适配/修正未通过时只返回 diagnosticOnly，不暂存、批准或授权；refine 只用当前内存和当前静态派生比较，拒绝旧 comparisonPath 和旧 reportPath 写入。成功新姿态仍为未批准 draft，最多 60 次局部修正及原视觉审查保持。

保存另用 `spine_host_commit{intent:"asset",assetCandidateHash,outputPath,requestId,dryRun:false}`。必须当前完整版本、pin、排他 Writer、精确暂存哈希、新 JSON 路径和未变依赖；MCP 再验领域门禁，Host 一次性授权绑定 snapshot/derived/review 与 Writer 代次，备份来源基线后原子创建。已存在/内部目录/产物目录拒绝，prepare/committed/aborted 与全局 requestId 幂等沿用原事务；发布后回执未知保持冻结，取得写入权并打开来源后按候选字节裁决。新资产提交的 switched:false 不能作为来源编辑已提交，重启仍恢复其原未提交历史。暂存候选不恢复，需重新计算；已发布资产可按日志恢复及重开。

提交日志记录 assetBinding 的路径、kind、characterId 和标准/参考/sequence/stage 来源，来源链最终必须到根 manifest 的同角色文档；普通修订不能改变类型。重开逐项核对来源链、已提交字节、当前根清单中的参考/阶段和同角色关键姿态，重建缓存索引不代替 journal。初始 skeleton 可显式 `spine_host_pin{intent:"asset"}` 绑定为独立资产来源；普通 non-pose pin、源骨架/动画 patch 与动画提交仍拒绝。`editing.assetDrafts` 声明工具、pinIntent 和保存参数，公共工具数仍 101，生产 C1 和其审批不扩权。

资产 readiness 独立列在 editing.assetDrafts.readiness.stage/commit，按实际 profile、排他权/冻结/收束、受管工程、pin、严格依赖、串行队列和当前候选判断。普通 operations.commit 继续描述 pose draft，不能用它对 non-pose/无派生的限制推断 asset 意图不可用；实际提交仍须完整参数、精确候选复核和一次性授权。

若新资产引用当前 pose，须先保存其修订及批准；未提交内存不能冒充旧磁盘路径供 motion/标准依赖使用。读取器使用快照基线值，不从同名旧文件掩盖当前改动。资产自身计算可从当前内存制作新修订，保存后显式打开，再按原数值、参考和独立 player 视觉流程重新审查。真实美术、第二角色、工作负载性能、完整动画和独立编辑器导入仍属于原退出条件，本批合成夹具不给出这些结论。

#### C2-4c 当前工程链路（2026-10-24）

`spine_retarget_motion` 的 attached 调用要求当前受管 v2 motion、同名显式选择、完整版本和 4.1.24 源，拒绝 false/旧提交令牌、改名/缩放及门限放宽。MCP 共用原完整拟合与 runtime 验证入口，均匀样本之外增加所有显式关键时刻；极短不可达帧不能漏测。候选经过单动画 diff、官方规范及结构引用审查，不修改其它动画、setup 或 V1 未开放 timeline；覆盖也不能删除既有 events/deform/约束。当前帧、live、不可变数值报告、原速 GIF 和姿态联系图绑定同一精确拟合候选。

成功准备返回 base reviewToken，尚无批准或写入授权。`spine_review_animation` 必须完整版本和当前准备令牌，批准还需当前已登记 playerManifestPath、五项各自 pass 与不同具体理由，适用参考需 `spine_render_animation_comparison` 上下同步 GIF。准备令牌、完整视觉批准令牌和一次性事务授权分别绑定。所有必要标准/关键姿态及实际关键时间参考关系、完整数值报告、候选/源/证据字节均保持原门禁；任何陈旧或失败候选无提交资格。

显式 `spine_host_pin{intent:"animation"}` 后，`spine_host_commit{intent:"animation",animationCandidateHash,expectedHash,reviewToken,outputPath,requestId}` 默认预演。MCP 授权前重验精确输入、全部证据、姿态/参考及完整报告；Host 持源锁再次核验，fsync 来源备份/临时文件后原子替换。备份失败和提交前漂移不替换，发布后回执未知冻结；重开来源 motion 以 journal/目标字节恢复，稳定 requestId 幂等。提交只改角色源的一个动画，motion revision 加一且 switched:false，旧派生/截图/审查清空。mapping 和校准报告原字节保留，后续计算只认可唯一已 committed、备份和 mapping/报告哈希均有效的动画来源链，不接受普通外部变更冒充校准来源。

`editing.animationCandidates` 的实际支持及独立 commit readiness 不复用 pose 草稿 readiness。控制端点不开放给页面，C1/mirror 不扩权。单次严格核验可合并相同路径、相同预期哈希的重叠证据；不跨调用缓存，哈希冲突直接拒绝，事务发布前仍重新核验。无一次性授权的首次真实请求先拒绝授权，不重复执行完整候选审查；全局 requestId 的终态查询始终在前。

工程验证、完整 C2 和公开启用分开：[当前实现与证据索引](host-c2-animation-transaction-final-20261024.json)。真实 npc1 已批准站姿另验证了精确固定站姿动画及实际 player，源输入保持不变；固定站姿候选不代表新完整动作交付。第二完整角色、独立 Spine 编辑器导入、完整动作视觉、真实创作负载以及 C1 原观察/人工评审仍须完成，D 保持 §6 原条件。

target 只支持 x/y/angle，channel 只支持既有声明通道的 x/y/rotate，batch 只接 target/channel；adjust 只接 patch.frame 下的 body/head/channels/targets/presentation，沿用 C2-1/2 全批校验。contact、weapon、地面/参考/绑定、frame.time/action/bendDirections 未开放，后项失败整批拒绝；render:false 可表示不生成旧对比图，render:true/region 拒绝。默认 dryRun，不自动 pin、保存、批准或放宽固定条件。真实修改仍是一条 journal 和一个 revision，经 MCP 重算/回放返回 PNG；同批一次撤销，草稿恢复不继承批准。`editing.commandAdapters` 列实际能力并指向 patch readiness，C1/mirror 不扩权，工具仍 101 个。

发送修改前与连接探测后均检查取消；修改已经确认后若取消计算，保留新版本及可恢复草稿，不能宣称编辑回滚。对 motion 的既有 poseWorkflow，MCP 必须检查 `poseGate` 的返回 ok，而不是只 await；失败阻止发布、不签发令牌。本批发现并修复该遗漏，保留原数值/视觉门限。真实 WebView2 合成组合姿态数值未通过时，只作为诊断显示和截图，不据此批准真实美术或完整动画。

2026-10-22 样本范围确认：用户明确排除 `exp/xiaoren`，其皮肤按身体部件拆分，不适合作为当前检测案例。该角色试跑不计入第二角色验收，不以默认皮肤、单个部件或自选换装组合补足；另选符合当前完整角色加载方式的真实美术样本。通用可选参数回归使用独立最小合成夹具，仍不能替代第二真实角色。

---

## 6. 阶段 D：求解宿主（先 spike）

**判据**

1. 受测工作负载中的 C 稳定 4 周无数据损坏，并已完成 C1 闭环及计划采用的 C2 能力；
2. “改一处 → 看一次”往返 >50 次/日；
3. 端到端 `patch → frame 可见` P95 >200ms（约 §12 预算 120ms 的 1.6 倍），且 solve 占比 >50%。

**度量口径**：C 的一次真实 patch 完成后，MCP 用新 version 读取 snapshot、执行原求解/比较、发布 derived，直到新版本 frame 首次可见；分别记录 patch、snapshot、solve/compare、publish、render 耗时。Host B/C 不自行求解，但该闭环已是 C 的验收前置，因此不再把合并调用留到 D 才定义。

**spike 范围**：评估内存求解核心、runtimeGraph、数值优化及依赖的计算搬迁；Host 即使计算指标，也不持有最终批准或授权策略。比较门禁策略、参考/视觉审查与授权签发仍留 MCP。
**退路**：保持 §3.5 的快照 → MCP 求解 → 发布结果；不改变资产写入权。

---

## 7. 兼容与回滚

| 变更 | 策略 |
|---|---|
| 新增端点/工具 | 新 Host 入口和工程初始化工具为增量；L1/L2 已有查询的结构变化按其版本迁移说明发布 |
| C 写入迁移 | `SPINE_HOST_WRITE=1` 默认关；还须 `SPINE_HOST_ROLLOUT_APPROVAL` 指向当前工程/构建/证据的有效人工审批。实际未审批，保持观察；启停流程见 §5 实施补充 |
| C1 / C2 能力 | 按已交付 op/kind 白名单开放；开启 C1 不会同时开放 C2 |
| 工程 schema | schemaVersion:1；旧项目 legacy 诊断，未知版本只读；初始化不覆盖、迁移不静默执行 |
| `0.1.x` 直写 | detached 保留一个大版本并标 deprecated；不允许旧直写进程与 C 同时操作同一工程 |
| 回滚 | 关 flag 后先冻结并交接排他写入权，再转 detached；先恢复/处理 journal，不能仅靠开关跳过交接 |
| apiVersion | 只接受 `"1"` |

---

## 8. 测试矩阵

| 场景 | 期望 |
|---|---|
| 工程初始化 | dryRun 无写入；真实初始化只创建 manifest；已有文件、越权及绑定冲突被拒绝 |
| 工程重开 | manifest + committed journal/产物索引重建新修订关系；缺资源显式报告；不恢复 pin/批准/授权 |
| legacy / 未知 schema | 不猜绑定、不自动写文件；C1 请求需受管工程；未知 schema 不自动降级 |
| schema 与 handler | rotate 等实际字段均可发现，未知字段受控拒绝，提示路径匹配真实 frame；MCP schema/Host 校验同源 |
| 能力与 readiness | 缺 gripPoint、未校准视角、受 weapon 控制目标、忙碌与 stale 分别报告；观察不求解、不批准 |
| 无宿主 | 工具可用；`available:false`；镜像模式 open 成功 |
| 完整回放 | 非零 setup、skin、附件及层序夹具；关节/顶点误差 ≤1e-4，附件/drawOrder 完全一致 |
| 未 open / 无 solution / 依赖缺失 | `DOC_NOT_LOADED` / `NO_SOLUTION` / `DOC_INCOMPLETE` |
| open 幂等与重载 | 同路径未漂移不清栈；漂移不刷新基线；reload 拒绝未提交内容并更换 openEpoch |
| 阶段白名单 | B1/B2/C1 的 skeleton/motion frame 拒绝；C1 非单手目标 op 及动画 commit 拒绝；C2 扩展需独立验收 |
| 宿主失联与崩溃 | 5s 判离线并冻结；只按已持久 journal 恢复；端口超时不能接管写入权 |
| 双客户端 / 重启 / A→B→A | 完整版本分别覆盖 session/document/openEpoch/revision 冲突；旧写入、求解与截图均不串文档 |
| 跨工程 | Host 重启；不一致 → `different-project` |
| 版本漂移 | 三元组 → `advisory`；apiVersion → 降级；基线版本 → 测试 fail |
| 故障注入 | 备份/磁盘满/rename/journal 失败、rename 后崩溃、响应丢失、SSE 断线、错误 token、后台节流 |
| 路径越权 | `..`/绝对/软链 → `PATH_FORBIDDEN` |
| token 与控制凭据 | 页面 token 可观察，不可发布 derived 或 authorize；无有效凭据 → 403；页面不含 control 凭据 |
| 内存求解与迟到结果 | 使用 snapshot 的新目标而非磁盘旧目标；输入/依赖变化后 publish 拒绝，旧帧不得冒充当前帧 |
| capture 竞态 | 开始及完成核对完整版本、依赖与 derivedHash；任一变化 → 409，不登记证据 |
| 提交授权 | 候选/路径/基线/依赖/derivedHash 全绑定；失败诊断、过期或伪造批准无法授权 |
| 默认 dryRun | patch/undo/redo/commit 不改内存、栈、journal 或资产；commit 不生成备份和授权 |
| 单次提交 | requestId 幂等；相同键不同请求拒绝；恢复不重复应用已 rename 的事务 |
| 写入权交接 | 旧 Host 存活失联时冻结；新 owner 无排他锁不可写；旧 generation 无法提交 |
| C1 闭环 | 两次修改、实际回读、干净图、undo、新修订保存与重开；状态分层，不把成功执行当作参考匹配 |
| 两级 drift | 外部改文件 → `TARGET_STALE`；语义变字节同 → `TARGET_DRIFT` |
| 黄金帧 | 3 夹具 ≤0.5%；runtime/回放/渲染器及输入绑定变化 → fail，重新核对基线 |
| 编辑器兼容性 advisory（§16） | 未开启 → `skipped`；未配置/不可执行 → `unavailable` 且**不报错、不改状态**；`accepted` 不改变 dryRun、审查、截图准入、drift 或提交授权任一结果；报告不含 `reviewToken`/`evidenceEligible`/`goldenPassed`/`readyToCommit` 等字段；fileHash 变化后旧报告不可引用；超时 → `indeterminate` |

---

## 9. 风险登记

| 风险 | 影响 | 对策 |
|---|---|---|
| 工程模型与文件绑定分叉 | 重开后改错角色 | manifest 与文档引用一致性校验、严格依赖指纹、可重建索引 |
| schema 未描述实际能力 | Agent 不能正确操作 | H0 契约覆盖检查，独立 schema 与共享注册表；角色能力附来源 |
| C 首次范围过大 | 迁移与回归失控 | C1 单 pose/单手 op，C2 逐项扩大；安全约束不后移 |
| 回放与求解不一致 | 实时图失真 | 完整渲染状态、关节/顶点 ≤1e-4、附件/层序严格一致；黄金帧兜底 |
| 双写 | 数据损坏 | 排他写入权与 generation；失联冻结，确认交接后恢复 |
| 真相漂移 | 提交错版本 | 完整 VersionRef、快照/依赖指纹与精确候选授权；两级 drift |
| MCP 继续读盘 | 内存修改未参与求解 | 资产读适配 snapshot，derived 精确绑定输入；未适配工具拒绝 attached 写入 |
| 双渲染器分歧 | Canvas 可能失真 | 黄金帧 D 默认 + A 可选；最终视觉采用独立核验的 player，回归缺口仍报告 |
| live 误提交 | 混入交付 | `generated:true` + commit 拒绝前缀 + TTL |
| 生命周期 | 工具超时 | env→端口文件→三合一锁→退避 |
| 页面凭据越权 | 绕过审查提交 | 独立 MCP 控制凭据、授权候选绑定与事务内重验 |
| 路径越权 | 任意文件读 | `resolveWorkspacePath` + realpath |
| 多工程 | 服务错工程 | spawn 注入 workspace + 切换重启 |
| CI 变重 | 测试慢 | B 可 skip；C 用 in-process 替身 |
| advisory 被当门禁 | 外部 CLI 结果被上层引用，抬高为验收/发布依据 | 报告恒带 `nonAuthoritative:true`；禁用审查类字段名；默认关闭；不被 §13 任何工单依赖 |
| 外部程序不可靠 | 版本/输出格式变化导致解析漂移 | 版本只记录不判定；无法解析 → `indeterminate`；不影响主链路 |
| 隐式商业许可依赖 | 主链路意外依赖付费授权或固定版本 | §16.5 明令禁止；advisory 只允许从环境变量读取路径 |

---

## 10. 不做清单

- 不做 Spine 编辑器复刻；
- 不发 MCP `logging`；
- 不做多窗口/多工程并存；
- B 不引入写入与求解；
- 不承诺 D；
- 不 WS 推骨架（ADR-6）；
- 不自动跟随 target（ADR-9）；
- 不双寻址（ADR-10）；
- **本批最终视觉审查只采用独立核验通过的官方 player 截图**，Canvas 图只作诊断；
- **B1/B2/C1 不做 motion/skeleton 的 frame/capture**（扩展留给 C2）；
- 不做 /api/frame 的 960 尺寸（只给 capture）。
- 不自动切图、绑骨或编辑 V1 禁止的 setup/mesh/deform/constraints/events；
- 不把 §4.8 的 player 截图准入误写成 Canvas 回归或动作已通过；
- 不以 manifest 标签、readiness 为 ready 或合成夹具通过代替真实美术角色验收。
- **不把 Spine 编辑器 CLI round-trip 做成主链路门禁、验收条件或任何现有门禁的替代品**；只允许 §16 定义的默认关闭 advisory 形态。
- 不把 advisory 的 `accepted` 当作审查批准、截图准入、动作批准、数值通过或发布依据。
- 不因任何与外部程序相关的能力引入必需的安装、付费授权、固定版本或 README 前置要求。

其中 B“不引入写入”指不修改受管资产；运行态 journal/live/派生报告允许受控生成。B“不引入求解”指 Host 不执行求解器，B2 的 MCP 快照求解与结果回传属于本期必要桥接。

---

## 11. 响应与 token 预算（待测）

下表是默认摘要粒度的估计，不承诺特定模型、客户端的实际 token 数，也不作为功能正确性的门禁。记录实际响应字节、schema 大小、图像数量和任务调用次数；据真实客户端测量调整摘要，保留按需获取细节的入口。

| 形态 | 估算 | 用法 |
|---|---|---|
| digest | 200–400 | 默认 |
| frame 480² | 350–500 | 看姿态 |
| capture 960² | 1.2–1.5k | 验收 |
| 整份 pose JSON | 2k+ | 禁止 |

## 12. 性能预算与测量

数值为待验证的初始预算，不是从外部 MCP 性能推导的结论。首次实施记录运行环境、角色资源规模、固定相机/尺寸、冷/热缓存，分开统计 load、solve、compare、publish、render、序列化与 RPC；预热后至少 30 个有效样本给出 P50/P95，冷启动另报。超预算先定位瓶颈，不放宽正确性或视觉门禁；证据充分时另行修订性能预算。

| 操作 | P95 |
|---|---|
| state | <20ms |
| frame 480 | <50ms |
| patch → frame | <120ms |
| capture | <1.5s |
| commit | <200ms |
| undo 事务（HTTP 回执，不含求解/出图） | <50ms |
| undo → 新图完整读取 | <120ms |
| 页面重载 | <800ms |

### 12.1 预算与验收的关系

**2026-10-24 state 性能收敛（实际部署范围）**：[三轮 90 样本汇总](host-real-animation-performance-summary-2026-10-24T15-06-26-244Z.json) 逐轮及总体均通过，HostClient state P95 **12.39ms**、frame P95 **25.51ms**；各轮 state 10.53/11.71/13.35ms。测试驱动、编译版 Host 和 MCP 为独立进程，Host/MCP 构建一致、全部原输入未变、worker 已退出。候选经实际 stdio；state/frame 仍测 HostClient，不包含其 stdio 编解码或屏幕呈现。候选全流程含拟合、337 样本、GIF/联系图及 PNG 的 P95 938.98ms，不把它当作 patch 或 commit 耗时。

本轮按真实文件身份在一次只读请求内去重，固定请求真实根但逐目标重新 realpath；新请求及授权/提交仍重新核验。发现文件并发读取；独立 owner/依赖/证据核验并发收束；PNG/已核验 runtime 只缓存计算，依赖/live 及选择仍前后验证。构建、203 项回归及两个实际桌面 29 项复验通过，优化前后 player 像素完全一致。[默认 C1 一轮 30 样本](host-client-performance-2026-10-24T15-06-31-512Z.json) patch 至图/state/首次图 P95 92.66/4.88/29.62ms，作为当前源码防回退，不覆盖旧冻结候选。

此前 [混进程三轮](host-real-animation-performance-summary-2026-10-24T14-56-36-447Z.json) 总体 state 19.20ms 但第三轮 24.31ms，allRoundsPassed:false；驱动和 Host 共进程会计入图像响应分配/GC 干扰，原记录保留，不以总体通过覆盖单轮失败。更早 28.52ms 及中间优化失败也保留于 [完整索引](host-state-performance-closeout-20261024.json)。最终三进程是实际部署的测量范围，不放宽 20/50ms 预算，不删样本，不将旧构建或其它拓扑追改为通过。其它角色、长动画和真实动画源提交仍须分项实测，C1 观察资格及 §6 条件不自动满足。

**2026-10-24 前一 C2-4c 构建的保留结果**（[当时证据索引](host-c2-animation-transaction-final-20261024.json)）：该构建 [三轮 90 个合成编辑样本](host-client-performance-summary-2026-10-23T19-50-09-329Z.json) 每轮通过，patch 至 PNG 总体 P95 82.49ms、严格 state 10.52ms、首次图 32.72ms；[原 C1 事务 30 样本](host-transaction-performance-2026-10-23T19-52-23-249Z.json) 撤销 HTTP 6.51ms、撤销至图 57.27ms、草稿提交 119.21ms。该数据不覆盖当前源码或冻结 C1 候选首轮 120.50ms 的失败，也不取得观察资格。

| 新增动画负载 | 样本与边界 | state P95 | frame P95 | 源动画 commit P95 | 结论 |
|---|---|---|---|---|---|
| [合成完整动画](host-animation-performance-2026-10-23T19-43-37-884Z.json) | 预热 2 次后 30 样本，HostClient 含全部门禁/备份/原子替换；模拟 player 只作协议 | 13.16ms | 21.65ms | 198.21ms | 本轮原预算通过，最大提交 215.22ms；不外推真实源提交 |
| [真实 npc1 同进程](host-real-animation-performance-2026-10-23T19-47-18-538Z.json) | 固定已批准站姿候选，30 样本，无新增动作批准/源写入 | 20.15ms | 32.84ms | 未测 | state 未通过 <20ms |
| [真实 npc1 分进程](host-real-animation-performance-2026-10-23T19-53-48-556Z.json) | 候选经独立实际 MCP stdio；state/frame 仍测 HostClient，30 样本 | 28.52ms | 45.68ms | 未测 | state 未通过 <20ms |

实际 npc1 候选生成含全部拟合、337 个 runtime 样本、原速 GIF/联系图及 PNG：分进程该完整调用 P95 908.90ms，目前没有将该制作耗时冒充 patch→图或源提交耗时。独立 [GC 诊断轮](host-real-animation-performance-2026-10-23T19-50-52-323Z.json) 的 3 个慢 state 样本均有 GC 重叠，最大 GC 21.34ms；诊断不混入正式验收，且分进程仍失败，不能认定 GC 为唯一根因。原始失败/早期通过轮次、计时范围勘误均保留，不挑较小 P95、不放宽预算。当前性能退出项仍待收敛。

2026-10-23 用户确认：undo 分成事务 <50ms 与完整工具重新求解、发布、读取新图 <120ms，后者与 patch → frame 对齐；不能只用事务耗时宣称完整工具 <50ms。commit 保留 <200ms，正确性及视觉门禁均不改变。此前按完整 undo <50ms 的失败数据保留，不追改历史报告。

正文引用上述延迟的地方均按本节记录实测，不把“未达到预算”伪装成达标。完整版本、路径限制、default dryRun、备份、结构与审查门禁、回放坐标 ≤1e-4 等正确性要求照常硬性验收。是否搬迁求解计算仍按 §6 的端到端分项数据决定。

2026-10-23 任务通道续验：新增 `scripts/benchmark-host-client.ts`，测量实际 HostClient.patch → begin → snapshot → MCP 求解 → derived → finish → state → frame，480 PNG 完整读取后停止计时。三轮同代码、同负载与环境共 90 个样本通过当前 state/frame/patch 预算；首次出图与缓存读取分别统计。初轮因压测过密触发生产 20/s 限流而失败，原记录保留；修正为样本间 120ms 计时外间隔，没有修改限流或预算。汇总入口 `scripts/summarize-host-client-performance.ts` 校验三轮代码指纹、环境、完整样本及源文件不变，拒绝混用或覆盖。结果不覆盖 stdio 编解码、浏览器呈现、其它资源规模或其它操作的性能验收。

本日后续源码又调整事务编排，上段通过结论仅对应早期代码。最终 [同代码三轮 90 样本](host-client-performance-summary-2026-10-23T08-16-08-112Z.json) 中，state P95 10.09ms、首次新版本 PNG 41.22ms 达预算，patch 至 PNG **122.81ms 未通过 <120ms**，不沿用早期 87.95ms 作为当前结论。所有失败轮次和慢样本保留，不调整 patch 预算。实际 [WebView2 28 项报告](host-winforms-2026-10-23T07-51-03-249Z.json) 另测 30 次热重载 P95 108.20ms、30 次真实 MCP stdio/player 960 截图回传 364.90ms，达各自预算；输入字节与文档版本不变，截图状态事件零重复 frame，未新增视觉批准。事务最终三轮及单轮波动见实施记录，不把总体 P95 当作每次或每轮保证。

**2026-10-23 异步路径续验（观察功能之前的基线）**：原生异步 lstat/realpath 用于逐次依赖与 journal 读取，每个文件仍重新核验真实根/现存祖先并读取真实字节哈希；没有路径或安全结果缓存。与前版相同负载、相机、480 尺寸、两次预热、120ms 计时外间隔；诊断跟踪不混入正式采样，代码指纹覆盖核验/求解桥/renderer/夹具。[编辑三轮 90 样本](host-client-performance-summary-2026-10-23T08-57-02-812Z.json)：patch 至 PNG P95 113.47ms、首次出图 36.89ms、state 10.49ms，各轮全部达预算。[事务三轮 90 样本](host-transaction-performance-summary-2026-10-23T08-59-26-222Z.json)：undo 事务 7.79ms、undo 至图 63.06ms、commit 108.99ms，各轮也全部达预算。最大 patch 120.76ms、commit 214.88ms，不声称每次低于预算。

该轮 [真实桌面再验](host-winforms-2026-10-23T09-00-42-744Z.json) 28 项，30 次页面热重载 P95 95.42ms、30 次真实 stdio/player 960 截图完整回传 344.60ms，均达预算；状态事件零重复 frame，原输入和完整版本不变，重连像素一致，不新增视觉批准。该轮完整 154/154 回归通过，作为后续观察功能的技术基线保留。

**2026-10-23 观察/启停新增后的当前结论**：[最新证据索引](host-c1-observation-implementation-20261023.json)。构建和 160/160 完整回归通过；[编辑三轮 90 样本](host-client-performance-summary-2026-10-23T09-55-52-179Z.json) 总体 P95 114.20ms，首轮/次轮/三轮分别 120.50/114.20/92.56ms，首轮超出 120ms，因此 aggregatePassed 为 true 而 allRoundsPassed 为 false，不把总体通过当成逐轮通过。慢样本涉及 patch 和候选制作，根因未确认，原记录和预算保留。[事务三轮 90 样本](host-transaction-performance-summary-2026-10-23T09-58-20-924Z.json) 各轮通过，undo HTTP P95 7.51ms、undo 至图 74.14ms、commit 105.25ms。

[真实桌面新验](host-winforms-2026-10-23T09-53-17-726Z.json) 28 项通过，重载 P95 105.65ms、实际 stdio/player 截图 383.35ms，零重复 frame、重连像素一致、输入/版本不变，新增观察状态已查看。用户选定的 npc1 隔离站姿已于北京时间 17:58 开始真实定时采样，初验 3 次约 120 秒无错误、32 份输入未变、Writer 不存在；[初验记录](host-observation-trial-verification-2026-10-23T10-01-14-582Z.json)。当前仍需收敛逐轮编辑性能、实际两周稳定/使用覆盖和人工启用评审。Canvas mesh、完整攻击、C2、第二角色及编辑器导入继续分别保留，生产写入关闭。

---

## 13. 实施工单顺序与退出条件（v1.7）

本节是主计划内的实施分解；后续施工单引用本文契约，不另写一份竞争性总计划。实现与未满足的退出条件以 [本次实施记录](../Host实施与验收-20261021.md) 的逐项表为准；下表仍保留目标与完整退出条件。

| 工单 | 主要改动位置（计划） | 依赖 | 可审查的退出条件 |
|---|---|---|---|
| H0-1 工程模型 | 新 projectModel/projectSchema 与工程初始化入口；workspaceTools 仅适配稳定 ID | 现有路径与工作区边界 | §3.7 schema、显式初始化、绑定冲突、legacy/未知版本负例通过；只写元数据 |
| H0-2 操作契约 | 新命令 schema/注册表；server、poseOps、L1.6 | H0-1 的上下文定义 | rotate/单位/提示路径等缺口有真实 schema 测试；声明、handler、readback 逐项对应 |
| H0-3 领域边界 | animationKernel、animationCommands；poseWorkflow、referenceRetarget、retargetEngine 的输入准备适配 | H0-2 | 纯计算不读写盘；原数值/runtime 与错误拒绝回归不变；完整输入指纹可查 |
| HOST-B1 | project/state/capabilities、snapshot、完整回放、frame/doc/events；L2.1 廉价 digest | H0-1–3、L1.2/L1.5 必需部分 | §4.2 通过；Agent 不猜目录即可勘察；无活动姿态可查工程能力；不执行 Host 求解或资产写入 |
| HOST-B2 | MCP 内存输入适配、derived、player capture、不可变 live、版本证据 | B1、§4.5/§4.8 分层规则 | §4.7 通过；pose 迟到结果/截图竞态拒绝；独立核验与旧证据拒收；Canvas 回归缺口单列 |
| HOST-C1 | pose Store、单手目标命令、review/authorize、排他 Writer/journal/undo、受管索引 | B2、共用写入安全验收 | §5.6 与 §5.7 首次闭环、恢复负例全部通过；旧角色源文件不变；可重新打开新修订 |
| HOST-C2 | 增量接入其余命令、motion/skeleton、动画/时间选择与现有高级工具 | C1、每项明确能力和 schema | 每扩一项先补能力/正反例；动画交付增加完整动画、第二真实角色及编辑器导入验收 |
| HOST-D spike | 求解与数值计算位置的评估 | §6 实测条件 | 有分项性能证据及退路；不改变最终批准与资产写入权 |
| HOST-EI 编辑器兼容性 advisory（可选） | §16：只读工具的默认关闭形态与 `.spine-mcp/diagnostics/editor-import-advisory/` 报告 | 无；不依赖上表任何工单，也不被任何工单依赖 | 默认关闭时不执行、不探测、不报错；五个 verdict 取值均可正确处理；报告不含任何审查类字段；未用它放宽或替代任何门禁；既有全部退出条件的通过与否与之无关。**2026-10-30 已施工**：条目 1–5 均已通过隔离测试与真实 stdio 实测；§16.4a 末段三项（真实 CLI、资源依赖、真实超时）仍待验，不得据此宣布编辑器导入通过 |

L1/L2 的资源/prompts、工程树、roots、任务反馈按配套工单交付；schema 覆盖、输入指纹、廉价查询与结构化错误属于本闭环前置，不能以“工具发现以后再做”为由延后。C1 的求解/渲染可能成为长任务时，必须接入进度/取消或 job 状态；取消不得破坏已完成的 patch 或绕过恢复记录。

阶段报告同时给出：完成入口、实际能力白名单、工程与依赖指纹、数值/runtime、参考关系、Agent 视觉、编辑器导入、性能实测及未完成项。源码、便携包、正在运行的服务版本分别标识，文档新增能力不能计作已发布。

---

## 14. 身体部件观测与受控透视试验（2026-10-25）

用户已同意将参考关节点误差与透视缩放纳入计划并执行。本节承接 [身体参考试用复盘](../Host身体参考试用复盘-20261025.md)，属于 C2 的专项验证，不重写旧失败记录，也不宣布完整参考动画已交付。

### 14.1 本次交付范围

本次完整执行三个步骤：部件观测分析、单臂缩放诊断链路、真实 npc1 单臂对照。固定躯干、身份、支撑与弯曲分支；不继续制作未通过准备姿态的整段参考动作。正式透视创作的角色范围校准、连续动作与编辑器导入列为后续退出项，不能用本次试验代替。

1. **部件观测**：参考 v2 增加可选 `parts`，逐部件记录关节误差圆、可见刚性切片的轮廓采样及采样误差、具体依据。**按用户同日后续要求，优先可靠刚性轮廓与误差圆；被遮挡或增强观测不足时，退回两个既有节点连线，给出 `twoPoint/estimated` 数值方向与依据，不因缺轮廓卡住。** 只有两个节点也未知/重合，或可靠证据相互冲突时标为不可用/冲突，同时保留能提供的诊断结果，不编造坐标。轮廓方向是无向轴，解剖身份仍由既有节点决定。既有单点指标不删除、不放宽；置信度不擅自换算像素半径。策略版本 2 纳入比较指纹、参考图和审查记录，旧批准不继承。
2. **透视诊断**：语义 frame 增加显式 `perspective`（实验、单臂、上/下段纵向缩短比例及依据）；比例有限且 `0 < ratio <= 1`，不开放翻转、放大、腿部、全身缩放或任意骨骼写入。缩放参与实际官方 runtime 的关节求解，末端方向、弯曲分支和误差按实际矩阵回读；最多 60 次迭代，不以固定长度解完后压图片代替。非支持骨架/约束明确拒绝。输出包含实际骨骼 scale/rotate，Host 完整回放重新核验，不自动生成前后结论。
3. **真实对照**：只用已选 npc1 隔离资源，不用多拆分皮肤案例。经正式 MCP 生成新诊断修订及对照图，比较无缩放/缩短的关节、切片、实际顶点和回放。输入哈希、耗时与调用记录保留。缺乏可靠参考部件证据时先报告未知，不编造轮廓或宣称匹配。

### 14.2 安全与验收

- 本次 `perspective` 是诊断能力：数值结果与 `experimental/diagnosticOnly/readyToCommit:false` 分开；即使数值通过也不可批准为标准姿态、不可组装正式 motion、不可取得源动画提交令牌。可保存新的诊断姿态及只读 live 候选，沿用路径、所有权、版本和备份要求。生产 C1 白名单不扩张。
- 角色特定缩放范围尚未经视觉校准，不能把数学合法区间当作美术可接受区间。后续开放正式创作前必须另补角色范围、宽度与切片连接、握持、连续性、完整动画和独立编辑器导入证据；不会靠放宽原比较阈值来完成。
- 缺轮廓、缺误差圆、近圆或服装外缘时优先给出两点近似，不额外制造一个必需的轮廓门禁；原 segment 方向/支撑/身份及独立视觉审查继续执行。报告明确 `uncertaintyKnown:false`，不把近似结果包装成精确测量。两个必要节点未知/重合、可靠证据冲突仍需补充。尺度证据仍只交视觉审查。
- 验证：TypeScript 构建、完整回归；新增正反例覆盖不确定性放大、退化轮廓、冲突、实际缩放 IK、不可达、分支固定、Host 完整回放/撤销、诊断禁止批准及源文件不变。合成夹具只证明算法与协议。
- 结果分别报告工程实现、真实数值/runtime、Agent 视觉、参考匹配、编辑器导入；未验证项保持未验证。

### 14.3 执行记录

同日后续按用户要求改为观测策略 v2：可靠轮廓优先，增强观测不足时回退两点连线并产出估计方向，不因缺轮廓单独阻断。真实旧参考复测为 45° / -18.43495°，未知半径保持 null；[当前索引](reference-fallback-implementation-20261025.json)。构建及 **213/213** 完整回归通过。后续创作收尾方向见 [逐项复查](../MCP差距逐项复查与收尾方向-20261025.md)，以下 212 项保留为首轮缩放批次。

最终构建与 **212/212** 完整回归通过；[当前实现证据索引](host-perspective-implementation-20261025.json)。第一轮部件分析、缩放诊断和真实对照完成；§14.4 正式创作退出项保持待验，不将首轮工程完成写成整份演进工单完成。

2026-10-25：本轮三步试验已执行，[实现与实测](../身体部件观测与透视缩放-20261025.md) / [三张实际 player 记录](host-perspective-trial-2026-10-25T07-44-44-456Z.json) / [独立视觉复核及历史勘误](host-perspective-assessment-20261025.json)。工具增至 102；温和 0.9/0.85 组合 17 次迭代、手目标误差 0.0001556 世界单位；强 0.8/0.7 组合 33 次后仍误差 4.3909，失败保留。三个状态完整回放误差约 3.22e-6，三张 player 均核验，源输入不变。截图核验与数值不替代参考匹配/美术批准；新负载调整调用超原 120ms 预算，未作 P95 验收。未获得 Spine 编辑器导入或生产资格。

### 14.4 正式创作的后续退出项

首轮试验不自动开放正式透视创作。后续采用分级观测持续产出粗略候选，逐步补相邻 GIF 帧、部件相对躯干方向和可取得的轮廓/误差信息，不等待所有遮挡轮廓补齐才开始有结果。随后建立角色特定的纵向缩短、宽度及末端继承范围和实际切片校准，再接通语义透视动作、连续插值及完整 motion。当前单臂 local X 倍率不直接等于世界投影比例，不从缩短推断 front/back。正式交付仍须干净轮廓、接缝、握持、支撑、drawOrder/视角依据、连续动作、新负载性能与独立编辑器导入，新增角色另验。不放宽原门禁，不继承诊断批准。

同日后续复查：[成熟 MCP 差距逐项复查与收尾方向](../MCP差距逐项复查与收尾方向-20261025.md)。基础会话施工与创作可用性分别列状态；本轮已执行观测降级，其余改进按该文优先级评估，不把建议写成已经施工。

---

## 15. 创作可用性与 MCP 工作流补齐（2026-10-26）

独立失败新阶段已接入 Host 内存与 journal，显式 newStage 不改原绑定；任务可追踪恢复及正式输出，恢复清除旧批准/准入并重算。当前 112 工具；[本批证据](new-diagnostic-stage-implementation-20261026.json)。参考失败仍阻止保存授权与完整作品交付，CU-1 尚待新标注全链及完整故障矩阵，后续 CU-2–CU-7 继续按专项退出条件。

实施分解见 [专项工单](creation-usability.md)，承接 G01–G14 复查，不另立竞争性架构。CU-0/CU-1 首批已施工，并增量接入 CU-2 目录和 CU-3/4 的准备/语义入口；各项工程与真实验收分开登记，不能据新增工具或测试通过宣布原 GIF 动作完成。

CU-1 后续新增正式动作级记录创建、无目标姿态的参考准备，以及经 journal 验证的后续修订选择；新参考只能在全新隔离副本初始化登记，不制造原清单与 Host 双写事务。当前共 111 工具，原 GIF 参考准备与 npc1 持续会话真实验证已执行；不同绑定的失败新阶段仍只报告，CU-1 未关闭。

任务冻结资源、比较策略及实际进程构建，沿用唯一 Writer、完整 VersionRef 和原提交契约；合法同绑定失败候选允许在内存诊断修正，不签发失败结果保存令牌。默认摘要与 full 分层只在 MCP 出口投影，内部完整核验不减少。v4 比较把遗留腕位/站距/握距统一改为躯干归一，数值阈值不放宽，旧策略和批准不迁移。

真实 npc1 基础闭环、截图与独立编辑器解析/保存按精确候选分别记证据；正式单臂透视、完整原参考动作、第二角色、连续区间编辑及新负载/发布条件仍待验。隔离 `host:creation` 不开放生产 C2，旧两周观察及人工评审责任保留。

## 16. 编辑器兼容性 advisory 终验（2026-10-30 决策）

本节记录一次**范围受限**的决策：把「Spine 编辑器能不能打开当前这份文件」做成**默认关闭的 advisory 终验**。

依据是外部同类项目的调研结论（见 [三层对比 §1.6](../三层对比-工作逻辑与工具包装-20261030.md)）：Spine 官方公开提供命令行接口（`-i` / `-o` / `-r` / `-e` / `-l` / `-m`），可用于把 JSON 重新导入 `.spine`；但**官方 CLI 不存在任何动画编辑命令**（没有「设置骨骼旋转」这类子命令），所以它并不能替我们"用官方通道执行动画命令"——它唯一真正外包出去的，是**"改完的 JSON 格式合不合规"这个裁判**。

我们目前缺的正是这一格（自己实现了规范审查层来人工复刻这个裁判）。本节的结论是：**补，但只补到 advisory。**

### 16.1 唯一问题域

本终验只回答一个问题：

> **当前这串字节，Spine 编辑器能否成功导入打开？**

它**不**回答：数值是否正确、参考关系是否匹配、画面是否美观、动作是否批准、能否提交、能否发布。这些始终由既有门禁独立判定，本节不改其中任何一条。

### 16.2 三条硬约束

| 约束 | 含义 |
|---|---|
| **默认关闭** | 未显式开启时不执行、不探测、不 spawn 外部进程；工具（或参数）缺省返回 `verdict:'skipped'`，不计 `unavailable`、不进运行记录以外的任何状态 |
| **不进主链路** | 不出现在 open / patch / review / authorize / commit / undo / 备份事务的任何前置或后置；不被任何既有退出条件引用；也没有任何工单以它为完成条件 |
| **不放宽任何现有门禁** | 结果 `accepted` **不得**改变 dryRun 行为、审查判定、截图准入、目标适合性、两级 drift 判定、提交授权与备份原子事务的任何结果；也不冲抵任何「未解决」缺口的登记状态 |

第三条要写死：advisory 的 `accepted` 结果只能写进诊断报告，**不得**回流成以下任一字段或等价语义：`reviewToken`、`evidenceEligible`、`goldenPassed`、`readyToCommit`、`approved`、`numericOk`、`keyGraphs.ok`、`exported`。报告本身也不得包含这些字段名，避免上层误读。

### 16.3 为什么不做成必需门禁

把外部 CLI 拉进主链路，需要同时背下这些代价（均为调研中核到的事实，不是估计）：

- 需要 **Spine Pro 授权**（Essential 明确不支持导入 mesh 与约束、不能保存含 IK 的项目）；
- **版本强绑定**：下游实践通常锁死单一版本号，且可执行路径依赖本机安装位置；
- **许可限制并发**：单一具名用户的激活规则下，并行跑两个任务会互相撞；
- **headless 出图不完整**：官方文档说明导出图片或视频需要 OS 窗口系统与 OpenGL，无图形环境不成立；
- **批处理语义**：官方命令行 "starts, does one or more exports, then **exits**"——每次是一条完整进程启停，**秒级**，且天然没有会话；
- **取结构化数据只能刮文本**：版本、错误都来自 stdout/stderr 文本，上游改格式即断。

也就是说，一旦进主链路，我们就要交出"免费、可离线、无许可限制、有会话、毫秒级"这五样里的全部或部分，换回的只是一格额外的覆盖。因此本节选 advisory。

### 16.4 候选形态（计划，未命名定稿）

| 项 | 计划值 |
|---|---|
| 入口 | MCP 只读工具（名称待定，登记前不占用现有工具组语义） |
| 默认 | `enabled:false` |
| 输入 | 磁盘上**已存在**的文件；`fileHash` 必须与调用时磁盘字节一致，之后任何改动使本报告失效 |
| 外部程序路径 | 仅从外部配置（环境变量）读取；未配置 → `unavailable`，**不报错** |
| 执行 | spawn 一次，串行，不允许并发；超时（计划 60s）判 `indeterminate` |
| 产物 | `.spine-mcp/diagnostics/editor-import-advisory/<uuid>.json`（与既有 diagnostics 目录同构） |
| 写受管资产 | **禁止**；只允许写上述诊断报告 |

报告结构（计划）：

```jsonc
{
  "advisorySchema": "editor-import-advisory/1",
  "checkedAt": "ISO8601",
  "nonAuthoritative": true,
  "scope": "仅回答 Spine 编辑器能否打开当前字节；不评价数值、参考关系、视觉或动作",
  "subject": { "filePath": "...", "fileHash": "sha256", "kind": "pose|motion|skeleton" },
  "cli": { "available": true, "versionText": "...", "versionParsed": null, "edition": null },
  "verdict": "skipped | unavailable | accepted | rejected | indeterminate",
  "evidence": { "argv": ["脱敏"], "exitCode": 0, "durationMs": 0, "stdoutTail": "...", "stderrTail": "..." },
  "notes": []
}
```

`verdict` 的五个取值必须都能被上层无歧义处理：`skipped`（未开启）、`unavailable`（未配置/不可执行，**不是失败**）、`accepted`、`rejected`、`indeterminate`（超时/输出无法解析）。`unavailable` 与 `skipped` 均**不得**被计为失败或降低任何状态。

### 16.4a 实施记录（2026-10-30 已施工）

| 项 | 实际落地 |
|---|---|
| 实现 | `src/editorImportAdvisory.ts`（新，纯逻辑 + 注入式 runner） |
| 工具 | `spine_check_editor_import`，归入 `review` 组（`src/toolCatalog.ts`），不占核心组可见性 |
| 外部程序 | 环境变量 **`SPINE_EDITOR_CLI`**；未配置 → `unavailable`，不抛错 |
| 报告 | `.spine-mcp/diagnostics/editor-import-advisory/<uuid>.json`，恒带 `nonAuthoritative:true` |
| 并发 | 模块内串行队列，同一时刻只允许一个外部进程（许可限制下的并发失败无法与文件问题区分） |
| 测试 | `test/editorImportAdvisory.test.ts` 4 例：默认关闭不 spawn、未配置即 unavailable、五 verdict 分类、非 skeleton 结构与源文件不变 |
| 端到端 | 真实 MCP stdio 握手实测：默认 → `skipped`；`enabled:true` 但未配置 → `unavailable` 且 `nonAuthoritative:true`、报告已落盘 |

执行方式：把输入文件复制到**临时工作目录**再交给外部程序（`-i <副本> -o <临时工程> -r <骨骼名>`），原名文件只读；结束后清理临时目录。报告通过模块常量 `FORBIDDEN_ADVISORY_FIELDS` 声明禁用字段，用例断言报告不含 `reviewToken`/`evidenceEligible`/`goldenPassed`/`readyToCommit`/`approved`/`numericOk`/`keyGraphs`/`exported`。**未触碰 `store.state().editorImport`**——该字段仍为真实 Spine 编辑器导入验收保留。

**尚未验证（不因本条目宣布完成）**：

1. **没有真实 Spine CLI 运行记录**。`accepted` / `rejected` 两个分支目前只用注入式 runner 覆盖分类逻辑，未对真实 Spine 程序验证过 argv 有效性与输出解析；
2. 资源依赖（atlas / PNG）是否随导入生效未验证，真实失败会以 `rejected` + `stderrTail` 呈现并可另行核对；
3. `indeterminate` 的真实超时行为只由模拟超时覆盖。

因此本能力当前只能作**诊断参考**：不能用它宣布「编辑器导入通过」，也不参与任何既有退出条件——与 §16.2 第三条一致。

### 16.5 明确不做

- 不用它替代官方 runtime 回读、官方 JSON 规范审查、数值比较或 player 截图准入；
- 不把 `accepted` 写成「已通过」「已验证」「编辑器导入通过」等可被引用的验收措辞，措辞保持为 advisory 描述；
- 不因本项引入必需的安装、授权、版本依赖或 README 前置要求；
- 不在 CI 中作为 gate；需要时用独立可选任务，失败不影响主回归结论；
- 不把外部程序 stdout/stderr 原文作为故障判定依据直接透出给门禁；只进报告尾随片段。

---

## 17. 载体定位与回补锚点（2026-11-02 确认）

本节**不新增能力、不放宽任何门禁、不改变任何既有退出条件**，只把当前定位写成可回补的锚点，便于条件成熟时按图索骥补缺口，也避免把「机制已建成」误读成「载体已验收」。

### 17.1 对外唯一口径

| 说法 | 是否可用 |
|---|---|
| 载体机制层已建成并通过隔离验证 | ✅ 唯一推荐表述 |
| 载体已实现 / 已跑通 | ✅ 限定在隔离环境内 |
| 载体已完成 | ❌ 会被理解为退出条件已满足 |
| 载体已验收、载体生产可用 | ❌ C1 仍观察态、C2 写入仍关闭，不成立 |

本节「载体」特指**承载动画工作流的机制集合**，不含动画内容成果（真实完整动作、第二角色动作、透视正式创作）——后者属内容层，与载体状态互不替代。

### 17.2 已建成（机制层，隔离验证）

| 模块 | 依据 |
|---|---|
| 工程模型与契约 H0-1～3 | §3.7 manifest、§3.9 命令 schema、输入指纹 |
| 观察与预览 B1/B2 | §4.7 工具集、§4.5/§4.8 截图分层与版本证据 |
| 会话与事务 C1 | §5.6/§5.7 首次闭环、排他 Writer、journal、undo、备份原子提交 |
| 扩展面 C2-1～4c | §5.7.1 四个增量与子项边界 |
| 诊断终验 §16 | §16.4a 实施记录（默认关闭、非权威） |
| 受控通道 | 2026-10-30 根因修复后本机恢复 `mode:"acl"` |

实测（2026-11-02）：`npm run build` 通过；`npm test` **239 项 / 213 通过 / 25 失败 / 1 跳过**，25 项失败全部为运行环境保护 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，**非环境类失败 0**；工具总数 **116**。

### 17.3 未闭合的三类（性质不同，不得合并成「等真人验证」）

| 类别 | 项目 | 性质 | 能否自主推进 |
|---|---|---|---|
| **① 客观未闭合** | 性能首轮 P95 120.50ms 超 120ms 预算；一次恢复检查点失败原因未取得；Canvas 渲染器回归缺口（§4.5/§4.8 单列） | 未达标 / 未查清，不是主观评审 | ✅ 能 |
| **② 真实环境依赖** | Spine Pro 授权与安装路径；第二真实角色资源；atlas/PNG 资源依赖；§16 的真实 CLI 实跑 | **缺件**，不是缺人 | ❌ 需外部条件 |
| **③ 人工评审** | 美术视觉批准；两周稳定观察（可自动采样，评审要人）；人工启用评审 | 需要人或时间窗口 | ⚠️ 部分 |

把 ①② 也归为「等真人验证」会低估工作量：尤其 Spine Pro 授权与第二角色资源，属**采购/准备事项**。

### 17.4 回补锚点（条件成熟时按此表定位）

| 缺口 | 回补触发条件 | 落地位置 | 补完前禁止宣称 |
|---|---|---|---|
| §16 真实 CLI 实跑 | 取得 Spine Pro 授权与本机可执行路径 | 配 `SPINE_EDITOR_CLI`，实跑 `accepted`/`rejected`/`indeterminate`，回填 §16.4a | 「编辑器导入通过」 |
| 资源依赖（atlas/PNG） | 真实角色资源随导入可用 | §16.4a 末段第 2 项 | 资源侧已覆盖 |
| 第二真实角色 | 选定完整真实角色样本 | [创作可用性工单](creation-usability.md)、§13 `HOST-C2` | 第二角色已验收 |
| 性能预算收敛 | 优化后重跑三轮，逐轮都过 | §12.1、[长期观察与启用流程](../Host长期观察与启用流程.md) | 性能已达标 |
| 恢复检查点失败原因 | 复现并取证 | §5.2 恢复规则 | 恢复链路无未知失败 |
| Canvas 渲染器回归 | 按 §4.5/§4.8 分层规则补齐 | §4.5/§4.8 | rendererParity 全场景通过 |
| 两周稳定观察 | 连续运行 14 天、零误报 | [长期观察与启用流程](../Host长期观察与启用流程.md) | 稳定性已验证 |
| L1/L2 批 1–3 | 无外部依赖，随时可开工 | [L1/L2 工单](mcp-l1-l2.md) | 协议侧已完工 |

### 17.5 下一大块的判断（2026-11-02）

| 顺序 | 大块 | 理由 | 阻塞 |
|---|---|---|---|
| 1 | **C1 收口**：性能收敛 → 两周观察 → 人工启用评审 | 唯一**无外部阻塞**且能把「机制已建成」升级为「载体已验收」的路径；也是 C2 生产启用与 D spike 的共同前置 | 时间窗口 |
| 2 | **L1/L2 批 1–3 收尾** | 协议侧，无外部依赖，成本最低，可并行 | 无 |
| 3 | **真实环境依赖**（授权 / 第二角色 / 资源） | 条件一到按 §17.4 直接补，不占当前排期 | 外部条件 |
| 4 | 暂缓：C2 生产启用、D spike | 均以 1 为前置，提前做不改变可启用状态 | 依赖 1 |
| 5 | 暂缓：内容层（准备姿态 7 项必要失败、完整攻击） | 锚点语义与突刺视角能力未解决前继续推进会反复退回 | 依赖 3 + 语义修订 |

本节登记不改变 §13 任何一行的退出条件；回补只做「补缺口」，不在回补过程中放宽门禁或用新能力冲抵既有「未解决」登记状态。

---

## 附录 A：ADR 摘要

| ADR | 决策 | 理由 |
|---|---|---|
| ADR-1 唯一写入者 | attached=Host，detached=MCP；排他交接，失联冻结 | 超时不能作为旧 owner 已停写的证据 |
| ADR-2 真相归属 | attached=内存，detached=磁盘；§5.2 裁决 | 与 Blender 一致 |
| ADR-3 部署 | 双模式，默认 detached | 不破坏 npx/CI |
| ADR-4 判定权 | 永久留 MCP | 防止自证 |
| ADR-5 求解 | 暂留 MCP，D 按 spike | 成本高，看数据 |
| ADR-6 状态同步 | 实时 canvas，验收 player，否决 WS | 避免第三真相 |
| ADR-7 undo | 仅未提交，commit 清栈 | 不绕过审查 |
| ADR-8 认证 | 会话 token（两种 mode 都必填） | 本机不等于安全 |
| ADR-9 target 绑定 | 强制 pin | 路径笔误代价更高 |
| ADR-10 寻址 | activeDoc + 完整 VersionRef | 防文档切换、重载及版本数字重复导致串写 |
| ADR-11 journal | 按 doc 分文件 | 防跨 doc 重放 |
| ADR-12 drift | Host 判字节，MCP 判语义 | Host 拿不到语义指纹 |
| **ADR-13 detached 镜像** | MCP 侧持有 activeDoc 镜像 | 统一寻址不能只在有宿主时成立 |
| **ADR-14 黄金帧** | 默认 D（人工基线+版本绑定），A 可选 | 不强加浏览器依赖，又能防漂移 |
| ADR-15 求解桥接 | snapshot → MCP 内存求解 → derived → frame | C 前闭合编辑与画面，不依赖 D |
| ADR-16 提交授权 | dryRun 精确字节候选、控制通道授权、备份及原子事务 | 保留原有审查门禁与诊断限制 |
| ADR-17 完整回放 | setup 相对骨骼增量 + skin/附件/层序/资源与相机 | 数值节点一致不替代切片显示一致 |
| ADR-18 工程模型 | 根 manifest + 严格依赖绑定 + 可重建产物索引 | 保存、重开和来源关系可追溯，不制造根 manifest 双写事务 |
| ADR-19 能力与状态 | 实现/角色能力、逐操作 readiness、批准分开 | 在线、可预览与可提交各有依据 |
| ADR-20 领域服务 | 计算、命令和策略同源，适配器边界明确 | detached/attached 复用算法，不重复实现动画核心 |
| ADR-22 截图分层 | 用户确认 rendererParity/captureValidity/evidenceEligible 分离 | 保留像素回归门限，player 截图独立准入，动作与导入分别验收 |
| ADR-21 首次交付 | H0 → B1 → B2 → C1 单 pose/单手闭环 → C2 | 先证明持续创作流程，再扩大范围，保持全部安全要求 |
| **ADR-23 编辑器兼容性** | 只做默认关闭的 advisory，回答「编辑器能否打开」；不进主链路、不放宽门禁 | 保留独立性（免费/可离线/无许可/有会话/毫秒级），只补缺的那一格 |


2026-10-26 专项续建：当前 115 工具，区间编辑/只读播放与独立单臂投影校准已接通；npc1 新建 0.85–1 窄范围取得当前真实 player/连续性独立批准，受限试用 motion 数值、页面及官方导入通过；宽范围退回，目标客户端、第二角色、性能预算及原 GIF 正式作品未完成。工程和真实退出项继续见 [创作可用性工单](creation-usability.md)，不扩张生产 C1。
