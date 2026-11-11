# production 现状与遗留问题

## 文档用途

本文只记录当前 production 行为、真实案例状态和后续遗留工作。本轮统一任务入口改造不放宽 production 门禁，也不自动补齐未标注参考帧。

## 当前行为

production 只有在参考 GIF 阶段覆盖完整、阶段求解成功、目标 runtime 回读成功、动态证据完整并完成正式人工视觉审查后，才进入候选提交链路。

统一入口完成到候选准备后，仍然必须单独调用 Host 提交。production 不允许因几何适配残差而绕过语义硬约束、握持、接地、runtime 或人工审查。

## body.gif → npc1 当前记录

当前资料：

- `body.gif`
- `body.sequence.json`
- `ready-v1.reference.json`
- `neutral-stand-v2.pose.json`
- `npc1.visual-rig.json`
- `目标/npc1.json`

当前 sequence 只有 `ready` 阶段：

- 参考 GIF 总帧数：171；
- 已审查阶段：`ready`；
- 未审查帧：170；
- production 阻断码：`REFERENCE_COVERAGE_INCOMPLETE`；
- 结果：不生成正式 motion，不写入 npc1。

`adaptive-preview` 可以生成已审查 `ready` 阶段的目标、参考、对比和动态诊断 GIF，但这些文件必须标记 `diagnosticOnly:true`、`formalEligible:false`、`readyToCommit:false`，不能代表完整 5.88 秒动作已经通过。

本轮真实 MCP stdio 连续预览复验已记录在 `diagnostic-fixture/previews/jobs/real-mcp-e2e/validation-report.json`：使用本轮绑定的六阶段 `clipboard-reference/reference.gif` 与 `clipboard-action.v2.sequence.json`，由新编译构建、真实 `spine_execute_task` 和 MCP 对比预览生成了 73 帧、2.42 秒的 `keypose-interpolated` NPC1 诊断 GIF。报告仍停在 `solve`，因为阶段存在躯干方向/扭转和左手不可达失败；`formalEligible:false`。原 `reference/body.gif` 仍只有 `ready` 阶段，单阶段只能使用 `stage-hold` 降级，不能宣称完整动作通过。这证明真实预览链可运行，不代表 production 已通过。

## 遗留问题分类

### 参考覆盖

需要为 body.gif 其余动作阶段建立 reference pose，补充阶段 ID、时间、左右身份、支撑、朝向、轮廓、前后层序和遮挡依据，并逐项审查。

### 目标适配

需要继续观察短手臂、不同髋宽、不同腿长和双脚高度冲突时的 adaptive 求解结果。几何残差可以报告，但语义失败、握持断裂、接地失败和目标不可达仍必须阻断正式结果。

### runtime 与动态证据

完整 coverage 后仍需生成目标 runtime actual、原速目标 GIF、同步比较 GIF、visualPoints 和采样指纹，并确认候选与目标角色绑定没有漂移。

### 正式审查与提交

正式候选必须经过人工视觉审查，取得有效 `reviewToken`，再由 Host 使用当前版本、`expectedHash`、备份和原子替换提交单个动画。

## 本轮不处理

- 不修改 `production` 的 coverage 门禁；
- 不把未审查帧插值成正式参考动作；
- 不自动批准诊断 GIF；
- 不修改源项目 `目标/npc1.json`；
- 不删除现有 Host、Writer、备份和提交凭据规则。

