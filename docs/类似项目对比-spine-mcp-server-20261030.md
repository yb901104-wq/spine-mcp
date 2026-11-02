# 类似项目对比：zhoushengmin/spine-mcp-server

调研日期：2026-10-30
调研方式：本地 `git clone --depth 1` 后直接读源码（`src/` 约 9,849 行 TS、71 个 `*.tool.ts`、70 个注册工具），并交叉核对 README（中英双语）与 package.json 脚本。
本文件为**外部观察**，不作为本项目验收结论；任何借鉴落地都须按本项目既有门禁重新立项。

## 1. 它是什么

- 定位：**AI 驱动的 Spine 3.8.75 动画工作流服务器**，把 **Spine 编辑器 CLI（Spine.com 3.8.75 Professional）** 包成 70 个 MCP 工具，给 Trae / Cursor / Claude Desktop / Codex / Windsurf / Cline 等客户端调用。
- 强绑定 Cocos Creator 3.8+（带扩展面板与 `.ccx` 打包），面向游戏开发场景。
- 依赖：**必须本机安装 Spine Pro 3.8.75 并授权**（`SPINE_EXE` 指向 `Spine.com`），Node ≥ 20，渲染用 `sharp` + `node-canvas` + vendored `spine-ts 3.8`。

## 2. 它的核心思路

**思路一句话：把官方编辑器当“后端与真值”，JSON 只是中间载体；一切修改走“导出 → 改 → 导入”的 Round-Trip。**

```
.spine 项目 --(CLI 导出)--> 临时 JSON --(JS 改 JSON)--> 修改后 JSON
        --(CLI -i/-o/-r 导入到临时新文件)--> 新 .spine
        --(自动 .bak 备份 + 覆盖替换)--> 原 .spine
```

关键实现（`src/spine/modify-service.ts`、`import-service.ts`）：

1. **不把 `-o` 直接指向已存在的原项目**（会丢修改），而是先导入临时新文件再替换——这条是他们实测出来的经验。
2. 修改后**自动跑引用完整性校验**（悬空骨骼/插槽、约束 target、未定义事件 → `warnings`）。
3. 写入前自动 `.bak` 备份，另有 `spine_rollback` 工具可回滚。
4. **回读验证**：`cmdRoundtrip` 在导入后**重新导出**并比对关键帧值（第 0 帧 rotation 期望值误差 < 1e-6），把“写进去没有”验证成闭环。

工具层（70 个，按 8 类组织）：信息/读取 9、骨骼结构 10、附件与皮肤 7、约束 9（ik/transform/path 各增删改）、动画 19、工作流 2（`check_project`、`pipeline`）、图集与项目 9、Cocos 工具链 5。

工程侧的几个讲究：

- **统一工具契约**：`BaseTool` + `zod` schema，所有异常统一转成 `ToolResult {success, message, data, errorCode}`；`src/utils/error-codes.ts` 定义了 19 个错误码，每条错误带**中文 message + suggestion（下一步怎么做）**，例如“创建新项目时必须传入 skeletonName 参数”。
- **面向 Agent 的入口**：`spine_check_project`（版本兼容 + 引用完整性 + atlas 存在性 + 统计 + **骨骼角色覆盖率** + 可用模板）与 `spine_describe`（骨骼层级树 + 每根骨骼的**角色建议** roleSuggestion，可直接喂给 `generate_animation` 的 roleMap）——先给 Agent 一张“地图”再动手。
- **AI 驱动的整条流水线**：`cut_parts`（按 alpha 连通域切部件）→ `assemble`（读 **AI 产出的 parts 索引**确定性绑骨）→ 镜像补全 → `generate_animation`（sine/bob 相位模板：idle/breath/walk/run/wave/attack/jump）→ 引用校验 → 导入 → 导出 GIF/精灵表/预览；`list_effects`/`apply_effect` 把“效果”抽象成**配方**（动画类/皮肤类/组合类，组合类还能埋事件，如攻击 45% 时刻埋 impact）。
- **渲染双轨**：优先 vendored 官方 `spine-ts 3.8` canvas bundle（IK/权重/曲线/FFD 与游戏一致），不可用时回退自研软件光栅化；导出支持线框叠加、序列帧、精灵表、video。
- **安装与配置**：`npm run installer` 自动探测 Spine/Cocos/Node 路径并写 `.env`；`config-manager` 集中管理路径/超时/日志级别；Cocos 面板一键启停服务、扫描项目、生成 AI 客户端配置。
- **测试**：20 个 node:test 单测 + 十余个按阶段的自制 CJS 自测脚本（约 137 项断言），含 MCP 协议侧对 70 个工具的枚举校验。

## 3. 与我们项目的差异

| 维度 | 它（spine-mcp-server） | 我们（spine-mcp） |
|---|---|---|
| 真值来源 | **官方编辑器 CLI**：`.spine` 项目是真值，JSON 只是中间产物 | **JSON + 官方 runtime 回读**：4.1.24 JSON 是真值，编辑器导入是独立验收项 |
| 环境依赖 | 强依赖 Spine Pro 3.8.75 授权 + Windows `Spine.com` | 不依赖商业编辑器；`@esotericsoftware/spine-core 4.1.56` + `spine-player` 即可工作 |
| 支持版本 | 锁 3.8.75（其他版本 warning） | V1 只写 4.1.24，其他版本默认只读/校验 |
| 可写范围 | **宽**：骨骼/插槽/附件/皮肤/约束/网格/图集/项目都改 | **窄而深**：V1 只改动画时间线，明确不改 setup pose、bones、slots、skins、mesh/deform、constraints |
| 写入安全 | `.bak` 备份 + rollback；**未见 dryRun / expectedHash / 审查令牌 / 写者锁 / journal / undo**（全仓 grep 命中 0） | dryRun 默认、expectedHash、diff 白名单、官方规范审查、reviewToken、写者锁（generation + 排他创建）、journal/undo、冻结与恢复 |
| 修改后验证 | 重新导出比对关键帧数值 + 引用完整性 | 官方 runtime 回读数值 + 参考关系比较（策略 v4）+ 视觉分层（Canvas 回归 / player 截图 / 动作批准三者互不顶替） |
| 视觉与姿态智能 | 动画模板/效果配方（按名字启发式匹配角色与左右） | 求解 + IK + visualRig 切片校准 + 参考姿态比较 + 局部修正（禁按名字推断左右/前后） |
| 渲染 | 官方 runtime 优先 + 自研回退；线框/序列/精灵表/视频 | node canvas 与官方 player 双轨 + 像素一致性/黄金帧分层 + contact sheet/GIF |
| 宿主与客户端 | Cocos Creator 面板 + 通用 MCP 客户端 | stdio MCP + Node preview/Host + WinForms 观察平台（双 host） |
| 规模 | 70 工具、src 约 9.8k 行 | 115 工具、src 101 文件、44 个测试文件 234 项（今日实跑 169 通过/64 失败） |

一句话概括：**它是“编辑器在环、覆盖面优先、工程体验优先”；我们是“编辑器不在环、可证据化优先、门禁优先”。** 目标不同，不能简单说谁更强——它们的短处（无 dryRun/无审查/无写者锁）正是我们投入最多的地方；它们的长处（Round-Trip 回读验证、地图式入口、流水线编排、安装体验）是我们尚未产品化的部分。

## 4. 值得借鉴的点（按性价比排序）

1. **Round-Trip 回读验证成闭环**（改完重新导出比对，误差 < 1e-6）
 我们的 runtime 回读是“内存里重放”，他们多一层“编辑器真的吃进去没有”。可考虑在我们已有的「本机 4.1.24 导入保存」一次性验证之上，做成一个**显式、advisory、默认关闭**的可选终验工具，记录证据（输入/输出哈希、spine 版本、耗时、原始输出），**不替代也不放宽**现有审查。
2. **面向 Agent 的地图式入口**（`check_project` / `describe`）
 我们写入前的可行性判断是分散的（mapping 校准、pose 流程、准备姿态门禁、C2 assets 各自前置）。可以做一个只读的 `spine_project_brief`：一次给出工程/角色/文档状态、**已批准能力覆盖率、当前阻塞原因列表、建议下一步工具**。要求：只读、advisory、摘要优先，不授予任何权限。
3. **错误契约里的 suggestion**
 我们的 `HostError` 有 code/message/状态码/detail，但**不是每条都给可执行修正建议**。建议给错误码表增列 `suggestion`，优先补 `TARGET_NOT_PINNED`、`REVIEW_REQUIRED`、`TARGET_STALE`、`NO_SOLUTION`、`CONTROL_REQUIRED`、`DOC_INCOMPLETE`，并让 `spine_explain_pose` 复用同一份映射。
4. **“AI 先产出显式索引 → 程序确定性装配”的两阶段切分**
 `cut_parts`（启发式候选）与 `assemble`（按 AI 给的 parts 索引确定性绑骨）分开。这个切分与我们的原则一致：**启发式只出候选，装配/批准必须有显式依据**。将来做图集/部件工作时可照此形态。
5. **配方化（recipe）抽象**：`list_effects` / `apply_effect` 把高层意图映射成参数化操作并**自带目录工具**。可借鉴“目录 + 参数化配方 + 事件埋点”的形式，但内容必须由已审查证据驱动，不能凭空生成整段。
6. **导出形态补齐**：精灵表（sprite sheet）、线框叠加、video。我们目前只有 contact sheet 与 GIF。
7. **安装与自检体验**：一键探测路径 + 集中 config（超时/日志级别）+ `npm run check` 式前置自检。我们的连接向导刻意不写用户全局配置（这条保留），但“集中配置 + 一条命令自检”可以吸收。
8. **测试可定位性**：按能力域分组的自测脚本（便于分批跑）。我们保留统一 `node:test` 的前提下，可给测试文件加能力域标签。

## 5. 不建议借鉴的部分

1. **按名字/序号推断解剖身份**：`sideOf()` 用「末位数字奇偶」判左右。与本项目“左右解剖身份必须由切片与依据确认、禁止自动交换”直接冲突。
2. **默认给所有非末帧写 ease curve**：与本项目“凭空生成新动画默认不写 curve”冲突（且 3.8 对象型 curve 与 4.1 数组语义不同）。若要做平滑，必须显式 opt-in 且只作用于已有真实曲线。
3. **无 dryRun / 无批准 / 无写者锁的直接覆盖写入**：不降低本项目写入门禁。
4. **`copyFileSync` 当原子替换**：严格说不是 rename 原子，中断可能半写。我们已有 generation + 排他创建 + 回收先证明 PID 不存在，不应反向退化。
5. **把商业编辑器与单一版本作为链路必需**：我们是「无编辑器可工作 + 编辑器仅作可选证据」。

## 6. 证伪清单与风险

- 以上判断基于今日 clone 的 master（最后提交为 2026-08 的“55→70 工具”），对方项目仍在迭代；若其后续引入 dryRun/审批/写者锁，本文件结论需重评估。
- 我读的是关键文件（README、package.json、server.ts、base.tool、error-codes、config-manager、constants、cli-executor、import/modify/validate/check/describe/pipeline/animation-generate/effect/render-runtime、index.ts），未逐行读完 71 个工具文件；「未见 X」的表述均基于全仓 grep，不等于对方完全没有。
- 本项目侧数字（115 工具、234 项测试、169/64）以今日实跑与 `docs/项目进展.md` 为准。
