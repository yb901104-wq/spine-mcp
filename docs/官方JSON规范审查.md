# 官方 JSON 规范审查

本文档记录当前 MCP 如何把 Spine 官方 JSON 导出格式转成可执行的写入审查规则。后续新增、修改或删除写入能力时，必须同步更新本文档和 `docs/MCP操作清单.md`。

## 规范来源

- 官方文档：[Spine JSON export format](https://esotericsoftware.com/spine-json-format#JSON-export-format)
- 当前写入版本：`skeleton.spine === "4.1.24"`
- 当前真实样本：`example-json/skeleton-Empty-4.1.json` 和 `example-json/skeleton-4.1.json`

官方在线文档可能随 Spine 当前版本更新，因此本项目采用“官方文档字段含义 + 4.1.24 样本字段形态”的双重规则。若两者存在差异，必须在版本适配说明中记录，不盲目套用最新网页字段。

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
| bone `shear` | `time`、`x`、`y`、`curve` | 同官方字段 | `/animations/*/bones/*/shear` | 不计算世界坐标。 |
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
