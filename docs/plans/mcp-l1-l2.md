# 执行文档 · 第一层（架构）与第二层（只读勘察）

> 版本：v1.4（2026-10-22 用户确认按任务时长细化通知密度；对齐 Host v1.8、源码 0.2.0）。范围：MCP 侧协议、工具契约与只读勘察；L3–L11 的完整能力不在本文。
> 相关工作单：[宿主演进工单](host-evolution.md)（preview 端点、证据截图、黄金帧、session、写入权、undo、求解器搬迁）。契约只以 HOST §3 为准。
> 颗粒度：每项按「现状事实（文件:行号）→ 目标 → 接口 → 改动点 → 验收」写，可直接当施工单。
> 前置共识（来自讨论，两章都受其约束）：
> 1. **画面判“对不对”，数字判“差多少”**：画面是验收权威，指标是导航，不是唯一真相。
> 2. **声明能力必须同批配 handler**，否则客户端初始化即报 `-32601`。
> 3. **任何写入都必须让指纹/审查失效**，不允许“JSON 改了但审查还绿”。
> 4. **先公布真实能力，再增加入口数量**：schema、handler、回读与角色能力必须对应；resources/prompts 为可选协议原语，缺少它们不表示现有服务不是 MCP。
> 与 Host 的顺序：本工单的 schema 完备性、输入指纹、廉价状态与错误属于 H0/B1 前置；resources/prompts/工程树按批交付，动态工具组发现仍后置。工程模型、readiness 与文档版本只引用 HOST §3.7–§3.9。

## 2026-10-21 实施注记

现有 101 个工具。新增 spine_get_workspace_tree 和 spine_recheck_pose；六个 resource templates、resources/list/read 与三个只读 prompts 已和声明一起接入，logging/setLevel 由 SDK 兑现。资源只读不会自动启动 Host；attached 的姿态资源从当前快照读取，失联冻结，不读取旧磁盘姿态冒充当前。

L1.2 已实现 128MB LRU 记账、SkeletonData/图像/文档复用；每次创建独立 Skeleton，严格读取默认真哈希，七个审查门禁强制 withStrict。fast 模式仅用于明确的只读场景；同 size/mtime 改动只有 strict 可作依据。Roots 只登记与更新回退列表，不覆盖显式选择；返回 resolvedFrom。

L1.4 已将 ALS 控制上下文接入求解、逐页/逐帧渲染及异步逐次修正；通知节流、无 token 静默、最终通知 progress=total，取消在检查点停止。原同步数学入口与异步任务入口共享同一迭代器，数值结果不变。错误保留 Host 顶层 code/detail，并提供嵌套 error 分类、issues 与可执行修复提示。

H0 的姿态工具已各自限定顶层参数，遗漏的 headFromReference/weaponFromReference 等实际参数已公布；全部工具使用同一份公开 schema 做运行时校验。L2 摘要分列 fingerprints、artifacts、stale、digestOk、officialOk，默认零求解，不把 unknown 作为通过。参考适配与整段动画计算有已加载输入入口；IO 准备和批准仍在适配层。

当前性能和实际退出条件见 [Host 实施记录](../Host实施与验收-20261021.md)。真实角色验收、正式三张 player 基线及长期观察仍独立记录；协议与夹具通过不自动开放公开写入。

2026-10-22 补充：frame/weapon/patch 已有同源嵌套 schema；完整动画采样和 runtime 验证补入取消检查点，同步纯计算和异步任务共用迭代器。实际工程切换等旧 Host 退役及写入锁释放，失败不连接新工程。只读 resources 不参与切换。资源列表采用工作区根的有界深度 2 快照（不再依赖未定义的“固定 7 根”），每批最多处理 25 条目录记录、响应预算 4500 字节，沿同一快照继续翻页；已登记普通文件名的姿态可发现，忽略表和边界不变。60 条长中文参考路径分页并集无遗漏或重复，实际每页小于 5KB。

30 次当前进程实测：[原始样本](protocol-performance-20261021.json)。本仓库工程树 P95 6.81ms、资源列表 P95 6.71ms；临时合成姿态零求解摘要 P95 13.03ms。都在本批初始预算内；不含 stdio 传输，也不能外推真实美术角色。2026-10-22 另测标准数值负载和实际 MCP stdio：取消后约 31ms 写出失败状态、34ms 释放锁，服务继续响应；详见下方续验。实际带参考角色的复杂修正与生产长跑仍独立验收。

**v1.4 修订依据**：约 350ms 的 60 次计算在 200ms 节流下不能保证六条通知。用户于 2026-10-22 确认保留节流，短任务验首末；至少 1 秒的 60 次迭代验至少六条。旧规则下的失败报告保留，不更改原样本或倒填通过。

## 自审结论（覆盖度）

| # | 讨论过的问题 | 本文位置 | 设计覆盖（非实现） |
| --- | --- | --- | --- |
| 1 | 缺少面向工程上下文的 resources/prompts | L1.1 | 已规划能力与 handler 同批交付；现有 tools 服务仍是真实 MCP |
| 2 | 无宿主，每次重建 runtime | L1.2（成本）+ HOST §5（会话） | ⚠️ 部分：缓存只解决成本，宿主语义见 HOST |
| 3 | projectId vs roots | L1.3 | ✅ 覆盖（最小侵入） |
| 4 | 长任务无进度、不可取消 | L1.4 | ✅ 覆盖（需实现时确认 SDK 1.13 的 extra.signal） |
| 5 | 错误只有中文、无 code | L1.5 | ✅ 覆盖 |
| 6 | 勘察昂贵、无指纹、`ok` 同名不同义 | L2.1 | ⚠️ 覆盖了结构，**漏了“盘上 solution 是否对应当前 frame”**，已补 |
| 7 | 无 resources / 无工程树 | L2.2、L2.3 | ✅ 覆盖，已补 `spine://session`（对标 Unity 的 editor state） |
| 8 | 当前画面及证据如何证明同版本 | HOST §3.5、§4 | 按 HOST v1.8 §4.8 已确认分层，保留 Canvas 回归门限；官方 player 当前截图独立核验，准入不代表批准 |
| 9 | 双运行时版本漂移 | HOST §3.1 | ✅ 覆盖（state 必回 runtime 三元组 + versionDrift） |
| 10 | 状态所有权（MCP 改 A、画面是 B） | HOST §3.3 + ADR-1/2 | ✅ 覆盖（pin + TARGET_DRIFT + 单写入者） |
| 11 | 受控写入需要完整且可发现的操作 | L1.6 / HOST H0-2 | schema 覆盖提前，未交付操作明确 unsupported |
| 12 | lineage / operationId / undo | — | ⏭ 明确划出本文（见“不做”） |
| 13 | token 成本（89 工具 schema、全量返回） | — | ⏭ 工具发现属 L10；L2.1 已限制返回体积 |
| 14 | 多工程与单 preview 页冲突 | HOST §4/§10 | ⚠️ 约束为单页单工程 + 显式切换 |


本表表示工单已覆盖相应议题，不表示能力已经实现或通过验收。lineage 的宿主事务部分以 Host 为准；动态工具发现不作为 H0/B1 的前置。

---

## L1 架构层

### L1.0 现状

| 事实 | 证据 |
| --- | --- |
| 只声明 `tools`，无 resources/prompts/logging | `src/server.ts:94-98` |
| 只有 2 个请求处理器、1 个通知处理器（roots） | `:870`、`:886`、`:884` |
| 89 个工具（56 基础 + 10 辅助 + 23 姿态），全部注入可选 `projectId` | `:137-820`、`:822-827`、`:829-852`、`:861-864` |
| 无运行时缓存，每次 solve 重读 JSON/mapping/atlas 并重算页面 hash | `motionRuntime.ts:9-12`、`poseWorkflow.ts:19-24,56` |
| 三条长任务（refine 60 次、多页渲染、GIF）无进度、无取消 | `referencePoseRefinement.ts:58`、`poseWorkflow.ts:118`、`animationReview.ts:17` |
| 错误只有中文 message，无 code/category | `server.ts:904-909` |


### L1.1 能力声明（capabilities）

**目标**：tools/resources/prompts/logging 四项只在实际实现并配齐 handler 时声明，不声明无法兑现的能力；不得因追求“协议完整”提前开空能力。

```ts
capabilities: {
  tools: {},
  resources: { subscribe: false, listChanged: false }, // 不订阅：没有 fs.watch
  logging: {},                                          // SDK 自动挂 setLevel
  prompts: {},                                          // 与 prompts/list + prompts/get 同批
}
```

**必须同时注册**：`ListResources`、`ReadResource`、`ListResourceTemplates`（独立方法，无独立开关）、`ListPrompts`、`GetPrompt`。
**不声明**：`experimental`（声明即背负 `experimental.*` 方法）、`completions`、`tasks`、`tools.listChanged`（工具表是编译期常量）。

**prompts 必须有内容**（声明空能力等于骗客户端）。本期随能力同批交付 3 条只读模板，只能描述当前已实现的工具及能力；Host 未实现的截图接口应返回可用性说明，不引导调用不存在的工具：

| name | 参数 | 内容要点 |
| --- | --- | --- |
| `pose-prepare` | `{posePath}` | 参考 v2 → 绑定 v2 → 序列 → retarget → solve → compare → review 的 8 步顺序，与“缺一步就 unverifiable”的说明 |
| `pose-diagnose` | `{posePath}` | 先 `spine_get_pose_state` 判 stale，再 `spine_explain_pose` 取旋钮，按“画面判对错、数字判差多少”给调整顺序 |
| `preview-verify` | `{posePath}` | 当前可用证据入口 → 固定相机与参考图并排；Host 接入后要求完整文档版本、依赖/派生指纹及渲染版本绑定；缺能力或过期即列明，不宣称已验收 |


**改动点**：`server.ts:13-18` 补 import；`:94-98` 替换 capabilities；`:870` 之后插 5 个 `setRequestHandler`。

**验收**：`initialize` 的 capabilities 精确匹配；7 个方法冒烟零 `-32601`；`logging/setLevel` 返回 `{}`。

---

### L1.2 会话级运行时缓存

**目标**：进程内 LRU；键永不含可变状态；读/算走 `fast`（mtime+size），**批准门禁强制 `strict`**（真哈希）。

| 缓存 | 键 | 值 |
| --- | --- | --- |
| doc | 绝对路径 | `{mtimeMs,size,hash,json}`（`SpineDocument` 形状不变） |
| skeletonData | 路径+rigHash+atlasTextHash+skin | `SkeletonData` |
| atlas | atlas 绝对路径 | `{textHash,pageHashes,atlas}` |
| pageImages | atlas+pageHashes+pma | `Map<page,Image>` |
| character | docHash+mappingHash | `characterFingerprint` 结果 |


**不缓存 `Skeleton`**（有可变状态，`sample()` 复用会串）。

**接口**：`cachedDocument / cachedRuntime / cachedAtlasImages / invalidate / stats / withStrict`（`src/runtimeCache.ts`）。

**改动点**：`motionRuntime.ts:8-27` 改走 `cachedRuntime`；`spineJson.ts:224-239` 改走 `cachedDocument`；`poseWorkflow.ts:22-24` 不再逐页 `fileHash`，改用缓存的 `pageHashes`；`rasterRenderer.ts:7-15` 先查 `pageImages`；`mappingTools.saveJson` 写后 `invalidate`。

**strict 门禁用点**（7 处）：`requireReviewedPose`、`reviewPose`、`reviewAnimation`、`confirmMapping`、`reviewVisualRig`、`requirePoseComparison`、`refinePoseData` 的旧报告门禁。

**验收**：20 次同输入 solve 只构造 1 次 SkeletonData；改 atlas 页面 → fingerprint 变；同 size+回写 mtime 只有 strict 能抓；`stats().bytes <= 128MB`；`npm test` 全绿。solve <3ms 为初始性能预算，按 HOST §12 分项实测，不将文档估计写成既有结果。

---

### L1.3 projectId → roots（最小侵入，不删参数）

**现状**：`projectId` 已是可选覆盖（`workspaceTools.ts:39-49`），但 `registerWorkspace` 无条件改 active（`:73`），导致 `syncRoots` 会**静默覆盖用户 `select_workspace`**。

**目标**：不动 89 个工具的 schema，只做三件事——解析来源可观测、roots 不覆盖显式选择、文档降级说明。

```ts
export type WorkspaceSource = 'explicit'|'active'|'roots'|'env'|'cwd';
export function resolveWorkspace(projectId?: string): { root: string; projectId: string|null; resolvedFrom: WorkspaceSource };
// registerWorkspace 增加 setActive?: boolean（默认 true）
```

**改动点**：`workspaceTools.ts:39-49` 新增 `resolveWorkspace`；`:59-76` 仅 `setActive!==false` 才写 active；`server.ts:871-877` 传 `setActive:false` + active 失效时回落 `roots[0]`；`projectIdProperty.description` 说明解析顺序。

**验收**：`select_workspace(A)` 后触发 `roots/list_changed`，active 仍为 A；roots 子任务自身仅改 schema 说明，不删除已有参数；H0 的 schema 修正单独记录。未登记工作区时返回 `resolvedFrom:env|cwd` 不抛错；manifest.projectId 与登记冲突须停止，不能让 roots 自动修复。

---

### L1.4 进度与取消

**现状**：`CallTool` 处理器没有第二参数（`server.ts:886`），拿不到 `signal/_meta`；SDK 已提供并会在 `notifications/cancelled` 时 abort。

**目标**：ALS 承载控制上下文，深层函数零签名改动；通知 200ms 节流 + 末条必发；无 token 时完全静默。

```ts
// src/taskControl.ts
export function runTask<T>(ctl:{signal?:AbortSignal;progress:(c:number,t:number,m?:string)=>void}, fn:()=>Promise<T>):Promise<T>;
export function checkpoint(label?:string):void;   // abort → CancelledError
export function reportProgress(c:number,t:number,m?:string):void;
// 唯一签名变化（向后兼容）
boundedLeastSquares(..., {signal?, onIteration?})
```

**埋点（不改签名）**：`solvePoseData` 入口/出口、`renderPoseComparison` 每姿态与每页、`renderAnimationFramesLocked` 帧循环、`renderAnimationGif` 帧循环、`renderAnimationComparison` 帧循环、`refinePoseData` 传 `onIteration`。

**改动点**：`server.ts:886` 加 `extra`；`:888` 构造 control；`:892` 包 `runTask`；`:904-909` 识别 `CancelledError`。**不自己注册 cancelled handler**（SDK 已注册）。

**验收（v1.4，用户确认）**：保留 200ms 节流，任务末条必发；60 次迭代耗时不足 1000ms 时至少首末两条，耗时至少 1000ms 时 ≥6 条通知；末条 `progress===total`。无 token 时 0 条；取消后 300ms 内停止且进程存活；耗时增幅 <5%；`poseRefinementMath` 旧单测逐位一致。不得人为等待来凑通知数量。计时比较使用相同输入与迭代器，交替执行顺序并分别列明计算回调和实际协议传输范围；不能把客户端立即抛出 AbortError 当成后台已停止。

---

### L1.5 结构化错误

**目标**：`isError` 仍为 true，但文本是 JSON；中文 message 原样保留；`PoseIssue.category` 透传不丢。

```ts
type ToolErrorCode = 'VALIDATION_FAILED'|'MISSING_INPUT'|'STALE_REPORT'|'UNREACHABLE'|'CAPABILITY_MISSING'|'CONFLICT'|'IO'|'CANCELLED';
interface ToolErrorPayload { ok:false; error:{code;category;message;detail?;remediation?;tool?;issues?} }
```

**映射**：`inputMissing→MISSING_INPUT`、`identityConflict→CONFLICT`、`calibrationMissing/resourceCapability→CAPABILITY_MISSING`、`unreachable→UNREACHABLE`、`relationMismatch→VALIDATION_FAILED`、IO 类→`IO`。

Host 错误保留其规范 code/detail（以 HOST §3.4 为准），不能全部压成 IO 或中文关键词；readiness 的阻塞原因与执行拒绝用同一来源。协议传输成功、领域计算失败和未批准提交分别返回，不用一个 ok 掩盖差异。

**两级判定（不改写 300 处 throw）**：① `instanceof ToolError`；② `PoseSequenceError` 取首 issue；③ 关键词兜底表（过期/未确认/不可达/必须/ENOENT）。

**改动点**：新增 `src/toolError.ts`；`server.ts:904-909` 换实现；`poseSequence.ts:9-10` 让 `PoseSequenceError extends ToolError`；5 个门禁点改显式 `ToolError` 保证 code 准确。

**验收**：7 类错误各 1 例可 `JSON.parse` 且 code 正确；3 个 issue 的序列错误 `code` 取首项、`issues.length===3`；现有断言中文子串仍通过。

---

### L1.6 H0 前置：操作 schema、实现与回读完备性

**现状**：当前 setPoseChannel 读取 rotate/x/y，但 server 的公共 poseProperties 没有显式顶层 rotate；metricAdvice 对 depth 的提示写为 pose.presentation.drawOrder，实际路径为 frame.presentation.drawOrder。宽泛的 object/any 和共享参数表使实际字段、说明和回读之间存在缺口。外部对标见评估报告；本项目继续禁止通过自由代码编辑角色 JSON。

**改动点**：建立有版本的操作注册表和独立 schema/判别联合，MCP schema、Host 校验、能力说明同源；接入 server、poseOps 与现有 handler。H0-2 实施位置以 Host 工单为准。

1. 对 body/head/channels/targets/bendDirections/weapon/presentation 列出已有读写入口、单位、坐标系及 mode/阶段限制；只有实际 handler 与回读可用时才标为支持。
2. 已实现参数必须显式出现在 schema，不接受“说明里提到即可”；命令实例通过 schema 后，应能由对应 handler 执行，拒绝未知字段及无效 op。
3. 每个必要指标登记有效旋钮或明确的不可调/能力缺失依据。depth 等计算结果只读，其对应呈现命令另列，不能允许直接写计算结论。
4. C1 只开放 HOST §5.7 白名单；现有 detached 工具不因此删除能力，未适配 attached 的操作明确 unsupported/WRITE_FORBIDDEN，不暗中退回磁盘写入。
5. head/weapon 等字段是否开放依据实际入口与校准状态，不把“默认开关关闭”当作已经验证的可调能力；不存在的下一步工具不能写入 remediation。

**验收**：真实 MCP tools/list 可见 rotate、单位及明确参数；已知字段正例、未知字段/未实现 op 负例通过；每个已公布可写字段至少一个 handler→实际回读用例；必要指标都有已知旋钮或具体不可调依据。测试证明只读与 unsupported 项被正确标识，不能把未实现字段计作完备交付。

---

## L2 只读勘察层

### L2.0 现状

| 事实 | 证据 |
| --- | --- |
| `getPoseState` 每次完整 solve + runtimeGraph + compare | `poseOps.ts:51-63`、`:39-49` |
| 返回体**无任何指纹**；`ok` 三处同名不同义 | `poseOps.ts:53-62`、`referenceRetarget.ts:31` |
| 无 resources、无工程树，模型靠 `ls` 猜路径 | 全仓 grep 为空 |
| preview 独立进程，靠共享 JSON + 1200/1500ms 轮询，无推送 | `sessionTools.ts:145-149`、`preview/index.html:404-419` |


### L2.1 勘察分级：廉价读数 + 显式重算

**目标**：spine_get_pose_state 只读当前输入和既有结果（0 次 solve，P95 <20ms 为初始预算）；detached 读盘，attached 读 Host 快照/摘要；新增 spine_recheck_pose 承接显式重算。digestOk 与 officialOk 分开，Host 失联冻结时不冒充已读取最新磁盘版本。

```ts
interface PoseDigest {
  read:{posePath;mtimeMs;sizeBytes;readMs};
  pose:{id;stageId;kind;status;frame;weapon};
  fingerprints:{pose;reference;visualRig;policy;sequence:{stored;reportPath;freshness}};
  artifacts:{solution{ok,matchesCurrentSolve};comparison{path,ok,digest,source};review{decision,evidenceCount,evidenceVerified:false}};
  stale:{solution;comparison;review;reference;rig;sequence;policy}; // 每项 {stale:boolean|null,reason,checked}
  digestOk:boolean;                              // 只表示“证据没过期”
  officialOk:{solved;comparison;review};         // 三个独立语义
  cache:{hit;mode};
}
```

digestOk 仅在所有适用证据的 checked 为 true 且 stale 为 false 时成立；缺失/未验证为 null，不对一个状态对象直接取反。officialOk.solved/comparison/review 分别来自新鲜的结果；未知或过期返回 null，失败返回 false。approved 还必须满足既有 confirmed、证据和指纹门禁；digestOk 不等于 readyToCommit。

**必须先补一个字段，否则廉价读会撒谎**：`pose.solution` 现在只有 `{bones,...report}`（`poseWorkflow.ts:77`），**没有记录它是针对哪个 frame 求解的**。frame 改动后 `status` 仍是 `solved`，磁盘上的 solution 已是陈旧值，而廉价读无法察觉。现有唯一可靠做法是重算（`poseWorkflow.ts:108` 就是这么做的：重新 solve 后比 `hashObject(solution.bones)`）。

因此 L2.1 依赖一项**前置改动**：`solvePose` 与 retarget 落盘时写入版本化 `solution.inputFingerprint`，覆盖实际 frame、weapon、groundY、policy、角色/mapping/visualRig、skin、atlas/纹理及 presentation 等完整求解输入（`poseWorkflow.ts:77`、`referenceRetarget.ts:132`）。可以额外保留 frameFingerprint 用于诊断，但它单独不能证明新鲜。廉价读改为：

```
solutionFresh = pose.solution?.inputFingerprint === currentSolveInputFingerprint
// 依赖哈希未核实、指纹字段缺失或 schema 不支持时为 unknown，不能默认 true。
```

旧文件无该字段 → `solutionFresh:'unknown'`，此时 `officialOk.solved` 返回 `null` 而不是 `true`，并把 `remediation` 指向 `spine_solve_pose`。**不允许把 unknown 当成 fresh。** 只读勘察可使用 fast 缓存并明确 checked/mode；批准、提交和 Host 新证据生成必须严格复核依赖，不能把 P95 勘察预算变成免哈希的门禁理由。

attached 适配以 [HOST §3.5](host-evolution.md) 为准：当前文档从 snapshot 读取，求解结果绑定完整版本、snapshotHash 和依赖指纹后发布；`get_pose_state` 仍不执行求解。帧指纹不是替代 Host 的 documentId/openEpoch/revision；快照读与结果发布是 B2/C 前置，不延后到 D。

**改动点**：新增 src/poseDigest.ts（只读，不 import 求解器）；getPoseState 与 explainPose 读取同一 digest；缺失/过期时建议显式 spine_recheck_pose，不在解释中隐式求解。recheckPose 经共享领域服务重算，attached 时通过 snapshot/derived；server 同步注册和说明。角色能力/readiness 的结构不在本文复制，引用 HOST §3.8。

**验收**：getPoseState/explainPose 的 solve 次数为 0；frame/weapon/groundY/presentation、参考/rig/策略/sequence 及依赖变化点亮相应 stale 项；unknown 不通过。recheck 的 metric digest 与原算法逐项一致，officialOk 三种语义可分别复现；实际延迟按 HOST §12 记录。

---

### L2.2 resources

**URI 家族**（全部只读、全部经 `resolveWorkspacePath`）：

| URI | 内容 |
| --- | --- |
| `spine://pose/{path}` / `reference/` / `rig/` | 文件原文（便于 diff） |
| `spine://metrics/{path}` | 由 `comparisonPath` 派生的指标摘要 + stale；无报告时 `available:false` + remediation |
| `spine://doc/{path}/bones` / `/slots` | `getSkeletonHierarchy` / `getSlots` 输出 |
| `spine://session` | 统一只读上下文入口：工程/活动角色、文档版本、呈现与新鲜度，以及 applicationCapabilities/readiness；结构引用 HOST §3.7–§3.8。与 state 工具同源，不再维护另一套会话真相 |


**list 预算**：工作区根的有界快照、`maxDepth<=2`、`maxDirsVisited=40`、`maxEntries=500`；每批处理最多 25 条目录记录，按 4500 字节资源体预算分页；忽略表与工程树共用（`node_modules/.git/.spine-mcp/dist/previews/backups/releases/test-output/coverage`）；响应 <5KB。
**templates**：固定 6 条，不扫描。

**改动点**：新增 `src/resources.ts`；`server.ts:870` 后 3 个 handler；capabilities 同批声明。

**验收**：本仓库内 `resources/list` <5KB / <200ms / readdir<=40 / entries<=500；翻页并集无重复遗漏；4 例越权（`..`、绝对路径、软链逃逸、未知 kind）全部 `IO` 且不读盘；`doc/bones` 与 `spine_get_skeleton_hierarchy` 深等。

---

### L2.3 工程树

```ts
getWorkspaceTree({root?,depth?,maxEntries?,cursor?,details?,kinds?}) → {
  entries:[{path,type,kind?,size?,mtime?,status?,fingerprint?}], counts, truncated, nextCursor, ignored, note
}
```

上限：`depth` 默认 3 / 上限 6；`maxEntries` 默认 500 / 上限 2000；`details:true` 时 stat 上限 1000，超出置 `truncated`；`status/fingerprint` 只算 50 个。

**改动点**：新增 `src/workspaceTree.ts`（导出 `WORKSPACE_IGNORES`）；`server.ts:819` 前加定义、`:1168` 前加 case。

**验收**：本仓库 `depth:3` P95 <300ms、<60KB、忽略目录零命中；`root:'../..'` → `IO`；50 个 pose 的 fingerprint 与 `get_pose_state` 一致。

---

### L2.4 preview 观察通道（已移出）

本节的端点、证据截图、心跳、多工程约束与黄金帧验证，全部并入 **[宿主演进工单](../plans/host-evolution.md)**：

- 阶段 B：状态/frame/capture/events/doc、snapshot/derived 桥接、ensurePreview、完整渲染状态与 advisory 规则（HOST §3.5、§4）；相机、skin、附件与 drawOrder 参与证据绑定
- 阶段 C：写入迁移、revision 乐观锁、undo（HOST §5）
- 契约字段与错误码：只以 HOST §3 为准，本文不复述

L1/L2 只保留两条约束（实现方式见 HOST）：

1. 观察接口的宿主不可用状态可返回 `available:false`；已附着写会话失联须冻结，不能以薄封装或自动降级为由直写磁盘，恢复条件只以 HOST §2.2 为准；
2. 任何来自宿主的图像证据，缺完整文档版本、输入/派生指纹、有效渲染版本绑定或 `advisory:true` 时，`spine_review_pose` 必须拒收。

## 前置批与三批交付顺序

| 批次 | 内容 | 是否改变现有行为 |
| --- | --- | --- |
| **批 0 契约先行** | L1.6 的命令/schema/回读覆盖与 HOST H0-2 对接；领域输入接口采用 HOST H0-3 | 是：修复缺失字段、提示路径与未知参数校验；兼容有效的现有调用，未适配 mode 明确拒绝 |
| **批 1 读得准** | L1.2 缓存 → L1.5 结构化错误 → `solution.inputFingerprint`（L2.1 前置）→ L2.1 勘察分级 | 是：`get_pose_state` 返回结构破坏性变化（0.1.0→0.2.0）；错误文本变 JSON；solution 增加完整求解输入指纹 |
| **批 2 说得清** | L1.1 capabilities + 3 条 prompts → L2.2 resources → L2.3 工程树 | 是：协议能力和只读入口增加；新增工具按实际注册表核对，不承诺旧共享 schema 不变 |
| **批 3 可长跑** | L1.4 进度取消 → L1.3 roots 折中；配套规则文档同步 | 是：长任务反馈和取消；syncRoots 不再覆盖显式选择；C1 前满足其长任务观察条件 |

> 宿主端点、工程 manifest/readiness 的规范、捕获、黄金帧、写入与 undo 见 [主工单](host-evolution.md) 的 H0 / HOST-B1 / HOST-B2 / HOST-C1 / HOST-C2 / HOST-D。本表可用 detached 输入与内存夹具独立验收；attached 集成还必须通过 Host 的快照/失效测试，不能用无宿主测试替代。


依赖顺序：批 0 先固定命令 schema 与领域输入边界；批 1 `runtimeCache → toolError → solution.inputFingerprint → poseDigest → poseOps → server`；批 2 `resources.templates → list → read → workspaceTree → server 能力与 handler（同一 commit）`；批 3 `taskControl → 埋点 → roots → 配套规则文档`。长任务反馈可在领域边界固定后提前接入，不必等待工程树完成；C1 使用长任务时不能省略取消/状态观察。

## 验收汇总（按批）

2026-10-22 续验：真实 npc1 本次保存的无参考站姿默认摘要分三轮共 90 次，P95 13.14ms、最大响应 2846 字节，freshness=current、solveCount=0；旧源姿态另组如实为 unknown。两组同机两个只读进程并行采样，均不含 MCP 传输，源字节未变。[真实摘要原始报告](real-pose-performance-20261022.json)；完整范围见 [实施验收](../Host实施与验收-20261021.md)。

任务控制续验：标准 Rosenbrock 96/160 维各 10 组同步/任务配对，共享 60 次迭代器且逐项结果相同。短负载每次 3–4 条，长负载 9–11 条，符合 v1.4；中位耗时未显示超过 5% 的增幅，但不能解释负值为加速保证。[短负载](task-control-performance-2026-10-22T09-28-43-842Z.json)、[长负载](task-control-performance-2026-10-22T09-26-01-932Z.json)。实际 MCP stdio 的 120 帧收到 19 条通知，无 token 零条；239 帧任务在实际生成 4 帧后取消，停止/锁释放均在 300ms 内，缓存未发布且产帧停止，进程继续响应。[协议报告](task-protocol-2026-10-22T09-24-52-307Z.json)。这些是数值内核和合成渲染协议验收，不声称已对真实带参考角色的 60 次修正量测开销。

- 批 0：真实 tools/list 公布实际字段，schema/handler/回读覆盖检查通过；坐标系/单位及 mode/阶段限制明确；C1 白名单与 detached 既有行为分别验证。
- 批 1：get_pose_state/explain_pose 的 solve 次数为 0；solutionFresh 三态；完整求解输入与参考/策略/sequence 变化使相应结果过期；20 次同输入 solve 构造 1 次 SkeletonData；各适用指纹及 stale/unknown 负例齐全；错误 code 含 Host 原码透传；npm test 全绿。性能按 HOST §12 记录。
- 批 2：capabilities 精确匹配、7 方法零 `-32601`；3 条 prompts 可 `prompts/get`；`resources/list` <5KB/<200ms/readdir<=40；4 例越权 `IO`；工程树 P95<300ms。
- 批 3：按 L1.4 的时长分层验通知密度、末条等于 total；取消生效与耗时实测；roots 不覆盖 active；已完成 patch 不被取消伪装成回滚，结果缺失/过期状态可观察。300ms 与 <5% 为初始性能预算。

## 风险与硬约束

| 风险 | 对策 |
| --- | --- |
| 声明能力未配 handler | 能力与 handler 同一 commit；`test/capabilities.test.ts` 逐方法断言 |
| 缓存陈旧（时间戳回写） | fast 仅用于读/算，7 个批准门禁强制 strict；`SPINE_MCP_CACHE_VERIFY=strict` 供 CI |
| 缓存内存膨胀 | 五级 LRU + 128MB 上限 + `stats()` 可观测 |
| resources 全盘扫描 / 越权 | 工作区内有界快照 + 深度/目录/条目三重预算；一律 `resolveWorkspacePath`（含 realpath 祖先校验） |
| 双运行时版本漂移 | `/api/state` 返回 runtime 版本；capture 按 HOST §3.5/§4.5 绑定完整版本、资源/渲染指纹及验证报告，缺项拒收 |
| 进度通知兼容性 | 仅在客户端给 token 时发；200ms 节流；循环内禁止 `await sendNotification` |
| 取消产生半写文件或虚假回滚 | 写入前 checkpoint；已确认的 patch 保留版本，计算取消只使结果缺失；资产事务的原子提交与恢复以 HOST §3.6/§5.2 为准 |


## 本文不做（避免误以为遗漏）

resources/subscribe 与更新推送、动态 tools/list_changed、删除已有 projectId 参数、缓存可变 Skeleton、L3–L11 的完整能力。H0 的字段/schema 完备性属于本期，不因 L3/L5 尚未完整实现而后移。

**宿主相关全部移出**（preview 端点、证据截图、黄金帧、session、写入权、undo、求解器搬迁）：见 [宿主演进工单](host-evolution.md)。

另外两项虽在讨论中提出，但**明确归属后续章节**，本文不兜底：

- **lineage / operationId / undo**：Host 事务、requestId 幂等和未提交撤销已由 HOST-C1 管理；跨交付物的完整 lineage/审计查询留给后续 L9，不重复定义另一套 journal；
- **token 成本 / 工具发现**（89 个工具 schema 全量、`search_tools`）：属 L10；本文只约束 L2 的返回体积（`resources/list`<5KB、工程树<60KB、`get_pose_state` 默认不返回全量 joints）。
