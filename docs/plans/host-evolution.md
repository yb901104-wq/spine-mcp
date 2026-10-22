# 动画工作区宿主（Host）演进工单 v1.8

> 定位：基于既有 Spine JSON、官方 runtime 和预览系统建立可持续编辑、保存与重开的 **AI Spine 动画工作台**。本文件定义其动画工作区宿主、工程模型、能力与领域服务，以及 H0（工程与契约）→ B（观察）→ C1（最小编辑闭环）→ C2（创作面扩展）→ D（计算搬迁评估）的实施顺序。
> 与 [L1/L2 工单](mcp-l1-l2.md) 的分工：L1/L2 只管「MCP 侧协议与只读勘察」；凡是需要「宿主在/不在」两种环境才能验收的内容，全部在本文件。
> 契约表（§3）是全项目唯一一份；L1/L2 只引用，不复制字段。
> 现状事实以当前工作树为准：新增入口后共 101 个工具；既有 previewServer 与新 hostServer 独立；rasterFrame 仍消费已摆好的 skeleton，Host 不执行求解。
> 状态（更新至 2026-10-22）：工程模型、领域边界、协议勘察、观察与 C1 机械流程已有实现；三张真实 player 合成 region 基线通过，最大通道差均为 1，回归结论仅覆盖登记范围。真实 npc1 无参考站姿已在隔离工程完成单手编辑、撤销、当前 player 截图、独立视觉审查、授权保存与重开复验；不代表攻击动作通过。长期观察未完成，生产 Host 保持观察模式，C2 尚未实施。详见 [实施与验收](../Host实施与验收-20261021.md)。v1.7 吸收 [成熟 MCP 对标评估](../成熟MCP对标与Host架构评估.md)，保留 v1.6 的一致性、授权、备份与冻结规则；首个交付收敛到单角色、单姿态、单手目标的闭环。历史记录仅供追溯。
> 术语：本文 Host 指动画工作区宿主；MCP 协议中的 host 指 AI 应用，两者不是同一组件。本项目已有 MCP 协议接入，本轮完善的是持续创作能力。
> 2026-10-21 已确认：Canvas 回归与官方 player 截图可信度独立判断，见 §4.5/§4.8。截图准入不代表动作批准；旧截图不得自动升级。
> 2026-10-22 桌面续验：WinForms 源码已以双页签嵌入现有 Host 观察页，23 项真实 WebView2 检查通过；页面离开/最小化时卸载，恢复后重新核对当前 Host，后端文档版本不变。旧便携包未重打包，不据基本嵌入开放 C1 生产写入或 C2。详细实现和失败记录仍见实施与验收。

### 修订记录

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
| POST | `/api/open` | `{manifestPath?, path?, reload?, expectedRevision?}` → `{project, activeDoc, deps, readiness, warnings, reopened}`；至少提供一个路径，规则见 §3.7 | B |
| GET | `/api/state?projectId=` | 工程/文档版本、新鲜度、pin/呈现/审查状态、readiness、运行时版本与安全信息 | B |
| GET | `/api/capabilities` | `{context, operations, character, readiness}`；§3.8 的同一数据源，不求解 | B |
| POST | `/api/state` | 页面上报状态（token + 本机 Origin + JSON + 体限） | B |
| GET | `/api/frame?sessionId=&documentId=&openEpoch=&revision=&time=&size=` | 完整版本必填；canvas 回放完整渲染状态；`no-store` | B |
| GET | `/api/events` | SSE：`doc-opened / doc-changed / frame-updated / capture-done / preview-closed`；C1 增加 `review-updated` | B |
| GET | `/api/doc?view=bones\|slots\|attachments\|timelines` | 结构查询（作用于 activeDoc） | B |
| POST | `/api/snapshot` | `{expectedRevision}` → 不可变文档/依赖快照及哈希；供 MCP 内部使用 | B |
| POST | `/api/derived` | `{expectedRevision, snapshotHash, dependencyFingerprint, result}` → `derivedHash`；MCP 控制通道 | B2 |
| POST | `/api/review` | `{expectedRevision, snapshotHash, derivedHash, reviewRecord, dryRun?}` → `reviewHash`；默认只验证，false 才登记 MCP 审查记录 | C1 |
| POST | `/api/capture` | `{expectedRevision, time?, viewport?, size?}` → `{pngBase64, manifest}` | B2 |
| POST | `/api/pin` | `{expectedRevision}` → `{pinned:true, version, fileHashAtPin}`；不提供 force 绕过漂移 | C1 |
| POST | `/api/patch` | `{expectedRevision, ops[], dryRun?}` → `{version, diff, changedPaths}`；默认 dryRun；C1 只接受一个手目标 op | C1 / C2 |
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

1. `/api/snapshot{expectedRevision}` 在文档互斥区取得不可变副本，返回 `{version, project, document, contentHash, dependencies, dependencyFingerprint, snapshotHash, derived}`。`snapshotHash` 绑定完整 version、contentHash 与 dependencyFingerprint；依赖包括 manifestHash、角色 JSON、mapping、visualRig、atlas/页面纹理、skin 和适用的 reference/sequence/policy，按固定顺序规范化。依赖角色若就是当前 activeDoc，使用当前内存模型，磁盘 hash 仅作提交基线，不能把自身旧磁盘副本当作求解输入。
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
| C 写入迁移 | 目标开关为 `SPINE_HOST_WRITE=1`，默认关；当前生产启动仅记录开启意图，仍保持观察，未接通公开写入启用 |
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
| undo | <50ms |
| 页面重载 | <800ms |

### 12.1 预算与验收的关系

正文引用上述延迟的地方均按本节记录实测，不把“未达到预算”伪装成达标。完整版本、路径限制、default dryRun、备份、结构与审查门禁、回放坐标 ≤1e-4 等正确性要求照常硬性验收。是否搬迁求解计算仍按 §6 的端到端分项数据决定。

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

L1/L2 的资源/prompts、工程树、roots、任务反馈按配套工单交付；schema 覆盖、输入指纹、廉价查询与结构化错误属于本闭环前置，不能以“工具发现以后再做”为由延后。C1 的求解/渲染可能成为长任务时，必须接入进度/取消或 job 状态；取消不得破坏已完成的 patch 或绕过恢复记录。

阶段报告同时给出：完成入口、实际能力白名单、工程与依赖指纹、数值/runtime、参考关系、Agent 视觉、编辑器导入、性能实测及未完成项。源码、便携包、正在运行的服务版本分别标识，文档新增能力不能计作已发布。

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
