# npc1 姿态实例复验（2026-10-09）

## 更正：此前视觉批准错误，已撤销

用户指出初始帧：参考分腿、身前握持，目标窄站、手部下垂。核查发现 `ready` 被排除在脚部适配之外，继承了普通站姿；手部仅按肩腕向量适配，未保持身前握持关系。程序只校验自设目标的 IK 误差，没有对参考/目标骨架的站距和握持布局计算误差。Agent 虽查看图像，却用统一理由批量批准，漏掉此差异。不是连线不清楚，而是参考匹配审查未落实。

已通过 MCP 将初始姿态和完整动画审查改为 rejected，`acceptance-report.json` 改为 `ok:false`。旧已写入动画保留作负例；下文“视觉通过”是历史错误记录，不是当前验收结论。脚本的模板式批量批准、提交及交付模式已停用。修正初始姿态草稿在 `ready-correction/`，尚未批准或重写整段动画。

## 实际执行

通过 MCP SDK stdio client 启动本次构建的 `dist/server.js`，调用参考、姿态、motion、渲染、审查、重定向和写入后验证工具。不是直接脚本编辑目标角色 JSON。

实例入口：`scripts/acceptance-pose-retest.mjs`。分阶段运行，必须先查看图像，再执行相应 review 模式；不能把脚本中的审查模式当作自动视觉模型。复验文件保存在工作区 `previews/npc1-attack-retest-20261009/`，每次 MCP 请求及响应保存在 `calls/`。

参考先检查原图和节点连线，并补上横扫保持、低位转杆、突刺保持和回收的观察记录。遮挡点为低置信推测。目标从已确认站姿重新创建，按前后投影肢体对应和目标臂长适配肩腕方向；侧别不确定性记录在 `adaptations.json`。

## 实测发现与修正

1. 第一版横扫遮脸过多：目标大头短臂，将该阶段手位降低到胸前，并记录与参考的适配差异。
2. 收步时两脚同时抬起：改为后脚先收、前脚再收，增加明确离地/落地姿态。
3. 各姿态肘部弯曲方向不同：单姿态可达，补间手腕误差却达 11.68；固定弯曲分支后降为 2.29。
4. 快速关键姿态间隔短于固定 120Hz 求解步长：对最多64个语义关键姿态的 motion，每个区间增加32份内部采样；较密的 motion 沿用固定采样，避免成本膨胀。最终仍曲线压缩，不写出全部内部样本。
5. 压缩旋转段超过180°引发跳变检测：限制单段跨度，并在语义姿态中整理手掌角度连续性。
6. 同步 GIF 的 runtime 时长是 float32，参考时间有累计浮点误差：参考帧选择增加1微秒边界容差，避免0.90s突刺错取前一帧。

## 结果

| 项目 | 实测 |
|---|---:|
| 时长 | 3.6秒，单次攻击，loop:false |
| 语义关键姿态 | 19，含支撑切换姿态 |
| 数值验证采样 | 865 |
| 最大脚底误差 | 0.0720104，阈值0.15 |
| 最大手腕误差 | 0.1005813，阈值0.35 |
| 最大压缩旋转误差 | 0.1566654°，阈值0.3° |
| 最大压缩位移误差 | 0.00000734，阈值0.07 |
| 最大压缩网格顶点误差 | 0.1611802，阈值1.2 |
| 内部通道样本合计 | 66,368 |
| 输出通道关键帧合计 | 957，68条通道，不是957个完整姿态 |
| 同步 GIF | 108帧，3600毫秒 |

以 `attack_pose_reviewed` 新增到 `目标/npc1.json`。事务 diff 只有 `/animations/attack_pose_reviewed`，保留 `act,idle,attack_reference`，逐字段比对非动画数据以及逐字节 hash 比对 atlas/PNG 均未改变。备份路径记录在 `commit.json` 和 `acceptance-report.json`。

主要产物：

- `reference-sheet/reference-page-1.png` 和第二页：参考原图/连线。
- `final-keyposes/page-1-clean.png`：六个主要阶段，上参考下目标。
- `final-keyposes/page-1-diagnostic.png`：节点和实际目标。
- `reference-vs-npc1.gif`：同时间上下对比。
- `npc1-attack.gif`：目标原速。
- `gif-review-sheet.png`：从实际同步 GIF 解码的阶段采样。
- `acceptance-report.json`、`final-validation.json`：审查与写入后验证。

## 分项验收

- 数值与结构/Spine 4.1.24 规范：通过。
- 官方 spine-core 4.1.56 加载及写入后验证：通过。
- Agent 视觉审查：作为无武器、按比例适配的动作实例通过；横扫高度、侧面朝向和部分手部轮廓与参考有差异，没有声明严格视觉复刻。
- Spine 编辑器导入：未验证。

本轮增加快速稀疏姿态和参考帧浮点边界回归。旧已启动 MCP 进程/便携包不会自动获得源码修正，需重新加载或更新发布包。

## 2026-10-20 v3 复测（同一份数据，未修改目标 JSON）

v2 策略下 27 项全 pass 却被真人退回，说明指标维度不足。v3 结构指标在同一份 `ready-v4.pose.json` 与 `ready.reference.json` 上给出 6 项失败：

| 指标 | 误差 | 门限 | 含义 |
|---|---:|---:|---|
| `body.shoulderLine` | 14.50° | 12° | 参考肩线更斜，目标肩线接近水平 |
| `body.twist` | 25.38° | 12° | 参考肩髋同向，目标出现拧腰 |
| `arm.left.wristReach` | 0.210 | 0.15 | 目标手臂比参考收得更近，外伸不足 |
| `arm.left.wristTorsoHeight` | 0.279 | 0.12 | 目标腕位明显低于参考 |
| `arm.left.wristHeadGap` | 0.379 | 0.20 | 目标手离头部过远（参考是跨身握持） |
| `arm.right.wristHeadGap` | 0.330 | 0.20 | 后侧手同样偏离 |

`leftArm.wrist` 旧方向指标仍为 0.138（门限 0.15）通过，印证「方向对、画面错」：只看方向角无法区分外伸与贴身。

`body.shoulderSilhouette`、`head.orientation`、`head.turnBand`、`depth.*` 目前为 `unverifiable`，因为参考仍是 v1，没有轮廓点、面部锚点和前后证据。**这是预期状态，不是通过**；完成 v2 重标注后才具备判定力。

结论：v3 能把原来的「说不出哪里不对」变成可量化的失败项，但 npc1 的正式验收仍需按 [准备姿态适配与修正闭环](准备姿态适配与修正闭环.md) 重标注四个阶段参考后重跑。


## 2026-10-20 晚：参考 v2 重标注后的实测

四个阶段已升级为参考 v2（面部锚点、可见轮廓、朝向档位、前后证据），visualRig 升 v2 并新增 face 锚点，参考与绑定均重新审查确认。同一份未修改的 `ready-v4.pose.json` 重跑比较，`ok:false`，7 项必要指标失败：

`body.shoulderLine` 14.50°、`body.twist` 25.38°、`arm.left.wristReach` 0.210、`arm.left.wristTorsoHeight` 0.279、`arm.left.wristOutsideTorso`（参考在外、目标在内）、`arm.left.wristHeadGap` 0.379、`arm.right.wristHeadGap` 0.330。

其中 `wristOutsideTorso` 直接对应原视觉判断「拳头收进躯干轮廓」，`leftArm.wrist` 旧方向指标仍以 0.138 通过。轮廓绝对宽度与头部朝向因体型差异与锚点语义不等价，降为诊断项。thrust 阶段另有 `resourceCapability`：参考声明侧背视角，当前资源没有已校准的侧背躯干切片。
