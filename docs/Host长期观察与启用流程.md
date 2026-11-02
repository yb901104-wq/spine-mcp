# Host 长期观察与 C1 启用流程

本说明落实 [主工单](plans/host-evolution.md) §5 的观察与启用前置，不新增阶段或放宽退出条件。记录、报告、人工评审和实际启用分别进行。当前生产写入默认关闭，尚无真实两周通过记录或生产启用审批；用户选择先在已验收 npc1 无参考站姿隔离工程试运行。该工程不代表完整攻击、第二角色或 Spine 编辑器导入通过。

2026-10-24 03:26 独立复核：冻结安装及三份会话可核验，当前会话 408 次、累计 445 次真实采样，32 份输入不变、无 Writer、无新增记录错误；两周仍未满足，已知一次未知退出和中断不补计。[本次证据](plans/host-observation-frozen-verification-2026-10-23T19-26-40-979Z.json)。最新 C2 源码即使完成工程链路，也不取得这份冻结 C1 候选的观察或审批资格；不把新源码性能测试覆盖旧候选失败。

## 观察记录

先构建源码，在已登记的受管工程启动编译版 Host，并显式打开 `poses/standing-hand-angle.json`。使用与启动时相同的工作区登记根；命令不会自动登记工程、启动 Host 或接管 Writer。

```powershell
npm run build
$env:SPINE_MCP_REGISTRY_ROOT = '已登记工程所用登记根的绝对路径'
node dist/hostObservationCli.js start --workspace '已登记工作区绝对路径'
node dist/hostObservationCli.js status --workspace '已登记工作区绝对路径'
node dist/hostObservationCli.js stop --workspace '已登记工作区绝对路径'
node dist/hostObservationCli.js report --workspace '已登记工作区绝对路径'
```

`start` 只接受正常 observer 与已打开的 pose，立即采样，此后 Host 存活期间每 60 秒采样。关闭页面不停止采样；关闭 Host、电脑休眠或退出进程则不能持续采集，重新启动后须显式开始新会话。没有计划任务、开机启动或离线补记。页面显示观察是否运行、采样次数及错误，`observation-updated` SSE 只刷新状态，不重复读取相同 frame。

记录位于工作区 `.spine-mcp/observation/`：`runs/*.jsonl` 为签名哈希链，`catalog.jsonl` 登记各会话，`catalog-head.json` 固定索引末端。已结束会话的原始文件哈希与末行签名写入索引，删除整份会话、截断已结束文件或篡改索引会失败；中断会话单列，须人工核查。签名私钥在写入前通过本机 ACL/权限保护，不输出到页面或 CLI。日志只保存白名单路由计数、事件类型、版本、依赖摘要及诊断状态，不保存请求头、token、control、任务租约、查询参数或请求体。

每次采样重新核对真实依赖字节与路径、Host 状态、工程绑定及运行构建。稳定版本且前后独立读取均未变却出现 `TARGET_STALE`，记作误报疑点；读取失败或版本变化记作无法判定。时间同时核对墙钟与进程单调时钟，时差超过 5 秒拒绝计为正常；超过 150 秒的采样间隔单列为间断，不补记在线时长。

汇总要求同一工程/manifest、同一实际构建的有效采样跨度至少 14×24 小时、覆盖至少 14 个 UTC 日期、有实际采样时长且无待处理错误，才允许进入人工评审。报告同时列出实际监测时长、间断、非正常结束、无法判定次数及请求计数，日历跨度本身不代表充分使用。源码 TS 与编译 JS 的构建身份不同，不能混用；Node 版本、运行代码、Host 页面、锁文件或实际 player 脚本变化后重新分组，不自动继承旧候选通过结论。

本地签名用于完整性和绑定，不提供外部可信时间，也不能防御拥有工作区全部文件权限的人重写历史。因此报告永远不自动宣告 `publicEnablementReady:true`，真实使用覆盖和事故处理仍由人工逐项核验。测试生成的两周协议夹具不能进入真实验收。

## 本次实际试运行

2026-10-23 17:58（北京时间）已按用户选择启动 npc1 站姿隔离工程的编译版隐藏 Host，未创建计划任务。32 份已验收输入哈希保持一致、Writer 不存在、启用意图为 false。启动证据见 [试运行记录](plans/host-observation-trial-2026-10-23T09-58-26-407Z.json)。18:22 按用户指示开始 C2 研发前，完整复制 C1 编译代码、页面、包与实际依赖，核对构建哈希仍为 `12f3761db8f07f366adc79f6be49a5d6ca123a319d0eb4b86aa3ea6802d90f97`。旧会话正常结束，同工作区的新固定版会话继续，原始记录和签名索引不重置。见 [固定构建迁移记录](plans/host-observation-frozen-2026-10-23T10-22-21-057Z.json)。

本次工程和登记根相同；汇总必须使用固定构建中的 CLI，以免把 C2 开发代码当作同候选：

```powershell
$trialRoot = 'D:/AI_cc/spine test/host-desktop-acceptance/2026-10-23T09-00-42-744Z/workspace'
$observerInstall = 'D:/AI_cc/spine test/host-observation-builds/c1-2026-10-23T10-22-13-507Z'
$env:SPINE_MCP_REGISTRY_ROOT = $trialRoot
node "$observerInstall/dist/hostObservationCli.js" status --workspace $trialRoot
node "$observerInstall/dist/hostObservationCli.js" report --workspace $trialRoot
# 需要结束这一轮采集时执行；该命令只停止记录，Host 仍可观察。
node "$observerInstall/dist/hostObservationCli.js" stop --workspace $trialRoot
```

这是流程试运行，尚未满足两周或充分真实使用覆盖，不能生成生产启用结论。固定版只为该 C1 候选积累证据，不为 C2 或未来构建背书；不要覆盖固定安装。固定代码/依赖/Node/player/manifest 变化会改变候选分组，重启后须核对并显式开始新会话。采样原始文件位于该工作区，不在仓库内提交。

21:42 的 [固定版复核](plans/host-observation-frozen-verification-2026-10-23T13-42-43-739Z.json)：当前会话仍运行、自动采样 64 次，三个会话合计 101 次、有效监测约 5874.25 秒；错误/排除均为零，32 份输入未变且无 Writer。已知一次未正常结束会话继续保留，不能据累计时长宣称连续稳定或满足两周。C2-3 的新源码、player 合成测试不计入该候选。

22:34 的 [后续复核](plans/host-observation-frozen-verification-2026-10-23T14-34-34-282Z.json)：当前会话继续采样 116 次，三会话合计 153 次、约 8994.65 秒，错误/排除为零、32 份输入未变、无 Writer；已知中断仍保留，两周未满足。C2-4a 的新编译、命令编辑和桌面诊断未改动固定安装或计入该候选。

[18:01 初验](plans/host-observation-trial-verification-2026-10-23T10-01-14-582Z.json) 已确认真实定时器自动完成 3 次采样、约 120 秒无错误，32 份输入未变且无 Writer。18:22 迁移后的当前运行页为 [固定版 npc1 只读 Host](http://127.0.0.1:40590/)，旧 56655 实例已正常退出。C1 回归与性能限制见 [原候选证据索引](plans/host-c1-observation-implementation-20261023.json)，其中编辑首轮 P95 120.50ms 超预算，不能通过启用审查。

20:38 更新：上述 40590 固定实例已在 18:33 最后采样后退出，原因未知，没有正常结束记录。已核对 PID 死亡及无 Writer，仅退役匹配的发现/控制文件，以 `Start-Process -WindowStyle Hidden` 启动同一固定构建并显式开始新会话，原日志和索引保留，中断不补时。当前页面为 [固定版 npc1 只读 Host](http://127.0.0.1:39895/)。3 份会话中一份正常结束、一份异常中断、一份正在运行；汇总中的未结束数同时包含后两者，须结合会话明细与 [中断记录](plans/host-observation-interruption-2026-10-23T12-38-00-945Z.json) 审阅，不能称为连续稳定通过。见 [恢复复核](plans/host-observation-frozen-verification-2026-10-23T12-38-49-036Z.json)。未安装自动重启服务。

[20:45 复核](plans/host-observation-frozen-verification-2026-10-23T12-45-47-818Z.json)：恢复后的定时器已自动采样 7 次，三份会话共 44 次、实际监测约 2453.79 秒，32 份输入哈希不变、无 Writer。构建/工程/签名可核验不等于未知退出原因已解决；两周稳定和人工启用仍未通过。

## 报告与人工评审

先 `stop` 固定本轮日志，再 `report` 生成新的签名报告；已有报告不覆盖。将当前构建对应的完整构建/回归、三轮编辑性能、三轮撤销/提交性能、真实桌面/player 验收 JSON 放在同一工作区内，保留原始来源。报告之后记录再变化，须重新生成报告和评审。

在人工交互终端执行：

```powershell
node dist/hostObservationCli.js review --workspace '工作区绝对路径' --report '.spine-mcp/observation/reports/实际报告.json' --regression '验收/构建回归.json' --client-performance '验收/编辑汇总.json' --transactions '验收/事务汇总.json' --desktop '验收/桌面报告.json'
```

CLI 先显示构建/报告哈希和间断等摘要；审查者分别填写真实使用覆盖、停机重启、误报和异常、回归恢复、性能范围、player 与视觉范围六项具体理由，再输入包含完整报告哈希的确认文本。管道、非交互输入、手填 `approved:true` 均不构成审批。程序检查 JSON 结构和通过标志，人工还须确认它们来自当前候选和适用负载，不能用签名或勾选代替证据审阅。

审批只绑定当前工程、manifest、构建、报告和四份验收文件的精确字节，范围固定 `c1-pose-single-hand-draft-v1`。生成审批文件不会启用写入，不新增 MCP 工具或 HTTP 批准入口。

## 限定启用与关闭

完成上述评审后，由操作人另行在启动当前候选 Host 的进程环境中指定：

```powershell
$env:SPINE_MCP_WORKSPACE = '已审批工作区绝对路径'
$env:SPINE_HOST_WRITE = '1'
$env:SPINE_HOST_ROLLOUT_APPROVAL = '.spine-mcp/observation/reviews/实际审批.json'
npm run host
```

审批签发后 24 小时内才能发起启用；这是启动校验有效期，不是 Writer 自动到期时间。只有意图开关和有效审批同时满足才尝试取得 attached Writer，并记录签名启用审计。缺项、过期、工程/构建不符、日志或验收字节变化、审批已撤销时保持 observer；审计/锁失败不得声称启用成功。每次编辑仍经过完整版本、pin、C1 单手白名单、默认 dryRun、视觉审查、一次性授权、备份与 journal，不开放 C2 或角色动画提交。

关闭当前实例的 C1 写入：

```powershell
node dist/hostObservationCli.js disable --workspace '工作区绝对路径'
```

关闭立即阻止新写操作入队，等待已开始事务及 journal 落盘，写入审批撤销记录后释放 Writer 并进入 observer。未提交编辑保留在内存与 journal，不自动保存或丢弃。撤销审计失败或事务已冻结时，继续保持冻结和写入权，不假称已交接；需按既有恢复流程核对。已撤销审批不能重启复用。正常停用后还应从未来启动的进程环境中移除两个启用变量。

`POST /api/observation` 的 `{action:"start"|"stop"}` 与 `POST /api/rollout-disable` 的空对象是本机私有控制端点，需 token、匹配 control、Origin 与 JSON 校验。没有 `/api/rollout-enable`。WinForms 只显示状态，不读取 control、签发批准或切换写入。默认端口和原一键启动脚本不变，旧便携 exe 未更新。
