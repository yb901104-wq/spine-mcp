# 官方 JSON 规范审查

## 普通创作候选

草稿仅支持 4.1.24 写入。结构操作包括追加骨骼、插槽、region 或 mesh 附件，以及按皮肤、插槽和名称替换指定附件。校验父链、权重、资源和操作差异范围。动画 timeline 复用官方规范检查。工具中的附件 name:null 写为缺省 name，表示隐藏。

原生交付逐项比较 Spine 4.1.24 官方编辑器重新导出的骨架。网格三角形允许重排及保留绕序的循环移位。独立且没有 deform 的网格可按骨骼索引比较同顶点的权重记录。局部顶点坐标按编辑器两位小数的精度比较，骨骼索引必须相同。候选没有 `edges` 时，仅接受由 `hull` 推导出的边界边。其他网格与动画差异仍拒绝交付。

## 2026-11-07：透视点映射与原始字节恢复边界

`depthPoints`/`perspectiveChains` 属于 mapping 元数据，不是 Spine 导出字段。审查时必须确认点骨骼存在、唯一、是对应实体段的直接子级，且实体链允许经过已声明点骨骼继续连接；仅凭 `-toushipoint` 命名不得授予写入权限。透视长度公式只用于诊断和已批准校准：`L' = L·cos(theta)`、`Delta = L·(1-cos(theta))`，不从二维缩短推断前后深度。

备份恢复同时保留 JSON 语义校验和备份原始字节 hash。恢复不会为了补换行而改写来源；`hashAfter` 指向实际写入字节，格式化差异不能再被误报成内容修改。

## 2026-11-03：curve 控制点数组必须匹配 timeline 维度

4.1 runtime 的 `readCurve()` 使用 `let i = value << 2` 按维度索引取控制点，即数组不是"总共 4 个控制点"，而是**每个维度 4 个控制点、按维度顺序排列**：一维 timeline 只读 `curve[0..3]`，二维 timeline 还要读 `curve[4..7]`。因此审查层新增维度规则：

- `rotate`（一维）→ curve 必须恰好 **4** 个数字。
- `translate` / `scale` / `shear`（二维）→ curve 必须恰好 **8** 个数字，前 4 个属 x、后 4 个属 y。

该约束官方在线文档未写明（其骨骼 curve 小节只描述"4 元数组"，实际只适用于一维 timeline）。实测后果：把真实样本 `example-json/xiaoren.json` 中 `bone2.translate` 的 6 个 8 元 curve 截成 4 元后，用官方 4.1 runtime 采样 41 帧，**40 帧的 y 分量为 NaN 而 x 分量完全正常、且不报任何错误**——属静默污染，视觉上表现为单方向抽动或不动，难以回溯。故长度不符一律报 error，不放行、不自动补全控制点。

`stepped` 与维度无关，任何 timeline 均放行。pose 级 `curve` 会同时写入该 pose 的多个骨骼 timeline，若这些 timeline 的维度需求不一致（例如同时含 rotate 与 translate），一个数组无法同时满足，直接拒绝并提示改用 `stepped` 或对每个 timeline 单独调用 `spine_set_curve`；不为此新增任何"按维度自动复制/补全控制点"的逻辑。

同轮核对确认：官方在线文档（中文版）为 **3.8 口径**，与 4.1.24 至少两处硬冲突——`rotate` 字段文档写 `angle`、runtime 实际只读 `value`；绘制顺序 timeline 名文档写全小写 `draworder`、runtime 实际读 `map.drawOrder`；curve 的 X 轴文档写"单位是帧"、runtime 实际为 0..1 归一化（cx 不乘 scale，cy 才乘）。本项目在这三处均以 4.1 runtime 与当前样本为准。据此重申：官方文档只作**字段语义参考**，不作**写入校验依据**；一切冲突以 4.1 runtime 源码与当前版本真实样本为准，并按本文件既有策略在版本适配说明中记录。

末端补偿可能需要局部 scale 大于 1，以维持同一世界手部尺寸；仅当前校准的三段臂链内部回放范围可接受，数值仍核验世界段长比、末端方向及投影误差，不能当成世界放大或新视角。未校准诊断和其它骨骼不扩权。motion 根清单校验与资产登记统一：已声明 stageId 必须精确匹配；未绑定参考阶段的普通站姿可作为多个 motion 位置，不能虚构参考阶段绑定。
## 2026-10-26：投影校准与 motion 修订

校准和审查记录是独立元数据，不是 Spine 导出；MCP 仍只允许 4.1.24 动画时间线写入。正式单臂求解的纵向/横向及末端补偿只导出受控 bones.scale 时间线，不修改 setup、mapping、skins、mesh/deform 或 constraints。upper/lower 是 runtime 实际世界投影，不能把局部 scale 当作世界比例。姿态 player 回放必须回读同一骨骼矩阵及切片顶点。

motion 区间修订保留标准与关键姿态来源，重新执行共享 poseGate；正式生成仍复用现有官方规范、白名单、结构引用、完整 runtime 拟合和视觉/导入流程。新增 scale 采样同样经过原曲线生成/规范审查，末帧不能带 curve，不能凭自然语言添加任意控制点。尚未通过真实校准审查或初始准备姿态的候选不能据此制作正式原参考完整动画。

2026-10-27：受限 `arm_projection_trial` 精确候选 `cca0418d67a6e93cec604af68714233186cc19bc37adabb3f7fc26c0d5c622e4` 经本机官方 4.1.24 导入并保存为非空 `.spine`，输入哈希未变；证据见专项汇总。它使用新批准的固定范围，不代表原 GIF 或编辑器画面/贴图通过。黄金帧重新登记只绑定当前回放代码，原 PNG、捕获及资源不改，不改变官方导出规则。

2026-10-26 独立诊断续建：内存姿态及恢复 journal 均不是 Spine 导出资产；原 setup/骨架/皮肤/约束和源 JSON 不改。通过门禁另存姿态时，提交索引记录精确新绑定与受管来源、保留诊断基线备份；正式 Spine 动画仍走原单动画规范审查。参考弯曲分支计算抽为同源函数供初始化校验复用，公式/阈值不变；局部修正及恢复不修改该分支。

2026-10-26 参考准备续建：`spine_create_pose_sequence` 写的是动作级参考元数据，不是 Spine 导出 JSON；不修改 timeline schema、curve 规则或官方版本边界。校验与原 `spine_validate_pose_sequence` 共享同一入口，引用节点/身份/支撑/视角必须通过。新序列仅在全新隔离清单登记，不允许借此修改角色 setup、约束、皮肤或源动画；正式动画写入继续走原规范、diff、备份和唯一 Writer 门禁。

## 2026-10-26 独立编辑器验证与比较策略

本轮新增创作任务/元数据和受控姿态入口，没有扩大 Spine 4.1.24 的可写时间线、setup/constraints/events 边界或 curve 规则。比较策略 v4 属于参考观测语义：腕位、站距、握距统一躯干归一，阈值数值不放宽；旧策略文件/证据保留，旧比较批准须重验，不称作官方 JSON 格式变更。

`scripts/verify-spine-editor-import.mjs` 独立读取 MCP 生成的候选，先核对 SHA-256、4.1.24 版本及原结构/官方 JSON 审查，再调用本机已缓存的官方 4.1.24，将其导入新产物目录的 `.spine`。已有输出拒绝覆盖，输入 JSON 不改，许可身份不进入报告。依据 [官方 CLI Import](https://esotericsoftware.com/spine-command-line-interface#Import)，导入创建编辑器工程；成功只证明本次精确候选的解析/保存，不代替贴图显示、动作视觉或原 GIF 完整动画。失败仍先恢复最近确认可用输入再重新制作，不在错误 JSON 上修补。

2026-10-25 透视诊断沿用已有 Spine 4.1.24 `animations/*/bones/*/scale` 白名单，没有新增 setup/网格/约束写入。高层单臂输入输出 setup 相对的 x/y 倍率，Host 静态 live 写入两帧相同 scale，不生成 curve 数组，仍经官方 schema、结构引用及完整 runtime 回读；诊断结果不能提交源动画。4.1 官方 runtime 的 [ScaleTimeline](https://github.com/EsotericSoftware/spine-runtimes/blob/4.1/spine-ts/spine-core/src/Animation.ts) 按 setup scale 相乘，与回放保持同义。非等比父缩放的 IK 限制参见 [官方 IK 说明](https://en.esotericsoftware.com/spine-ik-constraints)，当前是自有 runtime 拟合，不修改官方 IK constraints。[范围与实测](身体部件观测与透视缩放-20261025.md)。

2026-10-24 state/取帧性能优化仅改变严格只读 I/O 编排和已核验 runtime 的计算复用，不新增可写 timeline、版本适配或 curve 规则。一次查询固定真实根、逐目标核验身份，提交仍逐阶段重新核验，不能使用 state 批次充当写入门禁。完整 203 项回归保留官方 JSON、单动画白名单、末帧 curve 与只读结构反例；实际 player 优化前后像素一致不代表 Spine 编辑器导入。

2026-10-24 C2-4c：完整拟合抽为共用 `prepareSemanticAnimationData`，detached 与隔离 Host 的 MCP 计算同源。候选审查 `auditGeneratedAnimationCandidate` 严格要求源 4.1.24、显式覆盖、仅目标动画变更，复用原 diff 白名单、官方规范及结构引用校验；setup、其它动画、末帧 curve 和原型保留名称等反例拒绝。未新增可写 schema、版本绕过或宽松误差门限。runtime 除原至少 337 个均匀样本外还检查每个显式关键时刻，极短帧不能逃过手/脚/顶点误差检查；继续复核实际关键时间参考关系。现有拟合器的精确导出曲线沿用原算法，不允许 Agent 自由写 curve 数组。

整动画覆盖也必须保留 V1 只读的 events/deform/约束及未开放 timeline，不能借整动画替换顺带删除；单动画只读残留不一致直接拒绝。源提交只发布上述精确候选，当前 player、完整动画视觉、数值/runtime 及 Spine 编辑器导入分别报告。mapping 校准原字节不修改；Host 后续认可带已确认 journal、严格来源备份及固定 mapping/报告哈希的单动画来源链，普通校准规则仍严格。构建与 198 项回归通过不代表编辑器导入；尚无本批真实 Spine 导入结论。下列旧批次范围按日期保留。

2026-10-24 C2-4b 保存独立 pose/motion 领域资产并登记跨类型来源，不增加 Spine 源 JSON、timeline 或 curve 可写范围。skeleton asset pin 只允许创建另一文件，源 patch/动画提交仍拒绝；motion 资产不代表 Spine 动画写入。参考候选重验数值及实际视觉节点关系，失败不授权，成功 draft 仍需独立视觉审查。motion 观察和未来 C2-4c 导出继续执行原结构/官方规范/runtime 门禁，4.1.24 边界及最后一帧 curve 规则保持。

C2-4b 计算基础（2026-10-23）未增加 timeline/curve 可写 schema、版本适配或官方依据。变化在姿态/motion 领域前置审查：生成与复核共用完整阶段、standing 标准、角色/地面与 action 标准绑定，防止只修改动作级记录便绕过原姿态批准；内存输入同样重新验证。既有 Host motion 观察仍检查 poseGate.ok 后才生成候选，并保留结构、官方规范及 runtime 门禁。内部 Data 入口无资产写入和授权能力，4.1.24 写入边界保持。

C2-4a 的 target/channel/batch/adjust 仅映射到原 Host pose 参数/呈现补丁，候选仍由 MCP 按原结构、官方规范与 runtime 回读门禁生成。没有新增可写 timeline、curve 或源 setup/skins 修改，也不签发动画提交令牌。detached 的原输出路径/版本写入规则保留；motion poseWorkflow 的失败返回现显式拒绝，防止未通过姿态审查被当作候选生成前置条件已满足。规范门限和 4.1.24 写入边界不变。

## 2026-10-23 C2 隔离 pose 呈现入口

C2-3 新增只读 motion/skeleton 观察候选：MCP 将当前 skeleton 快照或 v2 motion 的既有 dense 线性导出写入 live，不改源文件；不凭空生成 curve 数组，不扩大 4.1.24 动画时间线写入范围。生成后完整经过结构/官方规范检查，再由匹配 4.1 runtime 采样；Host 发布及 player 截图分别核对骨骼、顶点、附件与层序。非 4.1 只读结构，不加载不匹配 runtime。当前 previewOnly 是采样观察，不能代替完整动画审查、编辑器导入或动画提交授权；poseWorkflow 的原门禁保留。

新增的 `setSlotAttachment`/`setDrawOrder` 只写 pose 参数，不修改 skeleton setup、skins、atlas 或纹理，也未开放角色动画提交。呈现候选复用现有 `presentationTimelines` 生成 `.spine-mcp/live/` 动画，仍经过完整结构/官方规范审查和官方 4.1 runtime 回读，对照骨骼、可见顶点、实际附件及完整 drawOrder。当前皮肤/default 回退引用、null 隐藏、插槽全集唯一排列在内存批次阶段先验证；不扩展可写 timeline 或改变 curve、最后一帧等敏感规则。合成机械通过不代表真实美术或编辑器导入验收。入口 schema 与阶段范围见 [主工单 §5.7.1](plans/host-evolution.md#571-c2-研发增量2026-10-23用户指示开始)。

## 2026-10-21 Host 只读导出适配

Host 不自行生成或写入角色动画。MCP 从当前内存快照求解后，只在 `.spine-mcp/live/` 生成不可变 player 候选；发布前复用现有结构与官方规范审查，并用官方 runtime 比较骨骼世界变换、附件、完整 drawOrder 与可见顶点，最大误差上限仍为 1e-4。live 文件不是可提交源资产，也不能借此修改 setup。规范字段、曲线敏感规则和 4.1.24 写入边界未放宽。C2 动画提交尚未接入。


本文档记录当前 MCP 如何把 Spine 官方 JSON 导出格式转成可执行的写入审查规则。后续新增、修改或删除写入能力时，必须同步更新本文档和 `docs/MCP操作清单.md`。

## 规范来源

- 官方文档：[Spine JSON export format](https://esotericsoftware.com/spine-json-format#JSON-export-format)
- 官方中文文档：[Spine: JSON导出文件格式](https://zh.esotericsoftware.com/spine-json-format)（**实测为 3.8 口径**，与 4.1.24 存在字段差异，见 2026-11-03 节）
- 当前写入版本：`skeleton.spine === "4.1.24"`
- 当前真实样本：`example-json/skeleton-Empty-4.1.json` 和 `example-json/skeleton-4.1.json`
- 运行时依据：`node_modules/@esotericsoftware/spine-core` 的 `SkeletonJson.js`（字段名读取）与 `readCurve()`（维度索引）

官方在线文档可能随 Spine 当前版本更新，因此本项目采用"官方文档字段含义 + 4.1.24 样本字段形态"的双重规则。若两者存在差异，必须在版本适配说明中记录，不盲目套用最新网页字段。字段的最终判定依据是 4.1 runtime 源码实际读取的键名与读取方式，而非网页描述。

## 审查边界

当前官方规范审查层只覆盖 MCP 允许写入的 animation 子集：

- bone timeline：`rotate`、`translate`、`scale`、`shear`
- slot timeline：`attachment`
- draw order timeline：`drawOrder` / `draworder`
- 通用关键帧字段：`time`、`curve`

未纳入写入子集的结构，例如 `deform`、`events`、constraints、mesh attachment 数据，会被只读保留。MCP 不应通过批量工具间接修改这些结构。

`spine_apply_pose_sequence` 属于批量写入入口，但不扩大写入边界。它只是把多个 `spine_apply_pose_keyframes` 风格的姿态时间点合并到一次事务中，仍然只能写入 bone `rotate/translate/scale/shear`、slot `attachment` 和当前允许的 animation 子树，并且同样经过官方规范审查、diff 白名单、引用校验和备份流程。

`curve` 的审查必须同时检查字段形态和语义位置。按照官方文档，`curve` 描述当前关键帧到下一关键帧之间的插值，因此 timeline 的最后一帧不能包含 `curve`。写入工具会在排序和去重后移除最后一帧的 `curve`；若审查层发现最终 JSON 中仍存在这种形态，必须拒绝写入。

自然语言生成新动画时，默认不要主动写入 `curve` 数组，除非已经能按 Spine 当前版本的真实导出坐标形态生成控制点。MCP 可以保留和复制样本中已有的合法曲线，但凭空生成动作时优先使用默认线性插值，降低 Spine 导入失败风险。

## 当前可写 timeline 规则

| timeline | 官方字段含义 | 4.1.24 写入字段 | 允许 JSON path | 备注 |
|---|---|---|---|---|
| bone `rotate` | `time`、旋转角度、`curve` | `time`、`value`、`curve` | `/animations/*/bones/*/rotate` | 官方在线文档中旋转角度字段可能写作 `angle`；当前 4.1.24 样本导出使用 `value`，因此 V1 写入 `value`。 |
| bone `translate` | `time`、`x`、`y`、`curve` | 同官方字段 | `/animations/*/bones/*/translate` | `x/y` 至少写入一个。 |
| bone `scale` | `time`、`x`、`y`、`curve` | 同官方字段 | `/animations/*/bones/*/scale` | 不修改 setup pose 中的 `scaleX/scaleY`。 |
| bone `shear` | `time`、`x`、`y`、`curve` | 同官方字段 | `/animations/*/bones/*/shear` | 底层只写局部值；世界坐标由 runtime 层计算。 |
| slot `attachment` | `time`、`name` | 同官方字段 | `/animations/*/slots/*/attachment` | 缺少 `name` 表示隐藏附件；有 `name` 时必须能在 skins 中找到。 |
| `drawOrder` / `draworder` | `time`、`offsets` | 同官方字段 | `/animations/*/{drawOrder,draworder}` | `offsets` 元素必须是 `{ slot, offset }`，slot 必须存在。 |
| 通用 `curve` | 当前关键帧到下一关键帧的插值 | `"stepped"` 或数字数组 | 各可写 timeline 关键帧 | 最后一帧不能包含 `curve`，因为最后一帧没有下一关键帧。 |

## 审查流程

每个写入工具都必须经过以下流程：

1. 读取 JSON 文件并确认路径在工作区内。
2. 校验 `skeleton.spine`，默认只允许 `4.1.24` 写入。
3. 校验 `expectedHash`，防止覆盖基于旧文件的修改。
4. 在 clone 后的 JSON 上应用操作。
5. 生成真实 diff，并检查 diff 是否只落在允许 path。
6. 执行官方规范审查，检查当前可写 timeline 的字段、类型、`curve` 和 `offsets`。
7. 执行结构和引用校验，检查 bone、slot、attachment、draw order 引用和关键帧排序。
8. `dryRun:true` 返回 diff；`dryRun:false` 先备份再写入。

对多姿态序列写入，审查层按最终 JSON 结果检查，而不是只相信输入参数。即使 `poses` 中包含多个时间点或自动闭合尾帧，最终 diff 仍必须全部落在允许 path 内。

## Agent 使用要求

- Agent 和未来 Skill 不允许绕过 MCP 自由编辑 Spine JSON。
- Agent 在解释写入结果时，应优先引用 `officialSpecValidation`、`operationValidation` 和 `summary`。
- 对复杂自然语言请求，Agent 应先形成 MCP 调用计划，说明目标动画、目标 timeline、预期 JSON path 和是否需要查询关键帧表。
- 当前不支持的结构编辑必须明确拒绝，不应通过直接改 JSON 规避。

spine_set_curve 只修改已有骨骼关键帧曲线，复用既有官方规范、结构审查、hash、备份和 diff 白名单；最后一帧非空曲线会被拒绝。

## 解剖持杖手、身体视角及切片遮挡检查

参考 observation.actionSemantics 支持 `version:1 / weaponHand:left|right / identityStatus:confirmed / anatomicalBasis / bodyView / bodyViewBasis / occlusion`。身体视角可为 `frontThreeQuarter`、`side`、`backThreeQuarter`，参考有不确定性时可用 `sideOrBackThreeQuarter`。遮挡项保存 `{front,back,basis}`，语义部位可为 `body` 或已有肢体线段编号（如 `rightArm.1`）。缺少必要遮挡关系返回无法验证，不默认为通过。

参考 v2 的 `depth.evidence` 与 actionSemantics.occlusion 不同：前者按语义部位（`leftArm/rightArm/leftLeg/rightLeg/torso/head`）成对声明前后，只读目标 `drawOrder` 与 `slot.attachment` 判定，不写任何 JSON；`kind:scale`（靠投影缩短推断前后）不做自动判定。这些判定都不修改角色文件，属于只读校验。

`spine_calibrate_visual_rig` 增加 `anatomicalSides` 与 `viewProfiles`，均绑定确认指纹。解剖左右映射保持跨阶段稳定；视角配置保存实际附件状态、躯干插槽和看图校准依据。姿态 `frame.action.driver` 明确实际目标驱动手（如 `rightHand`），骨架比较独立输出 `action.weaponHand`、`action.bodyView`、`action.occlusion.*`。身体视角从 runtime 实际附件配置匹配已确认 profile；未经校准不能只传一个“背面”标签通过。遮挡用 runtime 绘制顺序回读。Agent 判断仍参与视角配置校准，这不是自动像素识别或数学上的视觉保证。

`frame.presentation` 支持受控 `attachments` 和完整 `drawOrder` 插槽排列，沿用 `spine_adjust_pose`、`spine_solve_pose` 和 v2 motion。显示状态在阶段边界离散切换，导出为已有 attachment/drawOrder 时间线；不改 setup、绑定、mesh、atlas 或 PNG。现有后发、面部显隐及背包层序可构造转身诊断候选，但不代表有完整三维转身模型。需要逐姿态查看轮廓并重新校准，不能自动批准隐藏五官后的身体视角。

中文验证：右手参考对应左手驱动必须失败；正面配置不能覆盖侧背参考；缺失视角/遮挡信息必须无法验证；同一附件状态不能标记成两种不同视角；遮挡层序反转必须失败。切片状态修改使配置匹配和旧审查失效。官方 runtime 回读 attachment/drawOrder 的阶段切换必须与单姿态一致。
