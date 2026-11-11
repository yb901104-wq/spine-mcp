# Keypose 与 npc1 骨骼映射修复记录

## 本轮已完成

- 参考 pose 增加语义审查：解剖左右、支撑脚、朝向、前后证据和必要节点未知状态会单独阻断。
- 参考图前景命中项返回 `KEYPOSE_FOREGROUND_MISMATCH`，不再只返回没有类别的坐标错误。
- visualRig 对四肢骨骼原点候选改为直接阻断；髋膝低置信度和缺少鼻尖/前脸依据继续阻断。
- 增加 visualRig 与 mapping 的段节点、三段骨骼链、重复 attachment 和解剖左右检查。
- 增加 runtime visualPoints 回读检查；不能采样时返回 `MAPPING_RUNTIME_MISMATCH`。
- `spine_execute_task` 会根据阻断码指向参考联系表、visualRig 校准或 mapping 校验工具。

## 真实 fixture 验证

本轮使用附加 GIF 对应 fixture 执行 `adaptive-preview` dry run，输入为：

- `clipboard-reference/reference.gif`
- `clipboard-reference/clipboard-action.sequence.json`
- `trial/neutral-stand-v2.pose.json`
- `trial/npc1.visual-rig.json`
- `previews/pose-workflow-20261009/npc1.mapping.json`

结果仍停在 `binding`，这是预期的安全结果。当前发现：

- 12 个四肢 visualRig 节点仍是骨骼原点候选；
- 髋膝四个节点置信度为 `0.55`；
- `face` 仍使用嘴部支点，不是鼻尖或前脸锚点；
- 左右腿第二段复用了上一段的 attachment 绑定；
- 多个参考阶段的腕部或踝部可见点落在角色前景之外。

报告位于：

- `diagnostic-fixture/clipboard-reference/input-audit-v2/task-manifest.json`

## 尚未完成

本轮没有伪造新的 keypose、visualRig 或 mapping，也没有修改 `目标/npc1.json`。下一步必须人工依据联系表和切片图完成：

1. 重新标注被背景命中的参考节点，并确认遮挡点、左右身份、支撑和朝向。
2. 依据切片接缝或 mesh triangle 重做 npc1 的肩肘腕、髋膝踝节点。
3. 补齐鼻尖/前脸锚点，修正左右腿第二段 attachment 绑定。
4. 重新确认 mapping 与 visualRig 后，再执行 adaptive 重定向和动态 GIF 验证。

在这些输入通过前，adaptive 不能被用来绕过绑定错误，系统也不会生成正式 expected target 或提交令牌。

## 2026-11-09 重跑结果

已使用修订后的输入重新执行 `body.gif → npc1`：

- `trial/npc1.visual-rig.v3.json`；
- `clipboard-reference/clipboard-action.v2.sequence.json`；
- `clipboard-reference/poses3/*.reference.json`；
- `目标/npc1.json`（只读）。

本次修正了两个实现问题：

1. 明确标记 `supportMode:"airborne"` 的阶段不再被错误要求至少一只支撑脚；接地阶段仍保留支撑门禁。
2. adaptive 末端投影在接近最大可达长度时保留可见弯曲余量，避免把完全伸直的目标误报为正确弯曲分支。

最新诊断结果位于 `diagnostic-fixture/clipboard-reference/full-v7/`。六个阶段中，`stage-flight` 已达到 `geometric-adapted`；其余阶段仍因参考弯曲侧、躯干方向/扭转或短手臂可达性停在 `solve`，因此没有生成正式验收资格。

动态 GIF 的右栏现在是对应阶段的目标姿态保持（`dynamicTargetMode:"stage-hold"`），不再误标为 `ready-hold`。拼接 GIF 只覆盖六个已审查阶段，未标注的 53 帧没有被插值为正式动作。
