# MCP 统一任务入口与运行结构

## 目标

常见任务优先通过 `spine_execute_task` 发起。入口负责识别任务类型、核对输入、选择工作流、调用已有专业工具、生成可观看证据，并在需要人工判断或显式提交时停止。

统一入口不会替代专业工具。`spine_start_creation_task`、`spine_run_reference_retarget_flow`、姿态工具、动画工具和 Host 工具仍保留，用于高级控制、调试和兼容旧调用。

## 常用任务

`taskType` 支持：

- `inspect`：检查角色 JSON、骨骼、动画和 mapping 候选。
- `create_pose`：创建标准姿态或局部动作姿态候选。
- `create_motion`：从已审查姿态生成 motion 候选。
- `retarget_reference`：把参考 GIF/参考姿态适配到目标角色。
- `prepare_review`：按正式候选流程准备 runtime、GIF 和审查证据。

默认 `dryRun:true`。参考重定向还会先执行输入视觉审查：可见 keypose 点必须落在参考角色前景附近，四肢 visualRig 不能仍是骨骼原点候选，face 必须有前脸/鼻尖依据。审查失败时停止在 `binding`，只返回报告和下一步，不进入 IK。统一入口最多自动完成到“可提交”，真实写入必须继续使用 Host 提交工具，并提供当前版本、`expectedHash`、`reviewToken`、备份和原子替换条件。

## 工作流选择

`workflowProfile` 默认是 `auto`：

- 普通角色检查、姿态和 motion 创作进入 `creative`。
- 参考重定向默认进入 `adaptive-preview`，只处理已经标注和审查的阶段，并保留失败候选和诊断 GIF。
- `prepare_review` 或显式指定 `production` 才进入正式候选流程。production 的覆盖、runtime 和人工审查门禁保持现有规则。

`retargetMode` 默认 `adaptive`。它根据目标角色自身骨长和局部坐标适配动作意图；`strict` 保留精确结构复现行为。`retargetMode` 不会绕过参考覆盖、语义硬约束或正式审查。

## 停止层和返回结果

统一结果包含 `status`、`workflowProfile`、`retargetMode`、`stopLayer`、`completedSteps`、`blockingReasons`、`nextAction`、`nextActions`、`artifacts`、`inputHashes`、`diagnosticOnly`、`formalEligible` 和 `readyToCommit`。

停止层含义：

- `binding`：输入文件、角色、mapping、visualRig 或哈希不一致。
- `coverage`：参考 GIF 的阶段或帧尚未完成 reference pose 覆盖。
- `solve`：目标角色不可达、语义硬约束、握持或接地失败。
- `runtime`：目标 runtime 无法加载或回读。
- `evidence`：GIF、visualPoints、player manifest 或采样指纹缺失。
- `review`：需要人工视觉审查。
- `commit`：候选已具备提交条件，但等待显式 Host 提交。

每次停止都必须返回可直接调用的 `nextAction`。工具没有在当前连接启用时，目录层会把它投影为 `spine_get_tool_catalog`，工具可见性不等于写入授权。

## 视觉产物

视觉任务默认使用 `previewPolicy:"auto"`。输入和 runtime 可用时生成目标 GIF、参考 GIF、参考/目标对比 GIF、动态同步对比 GIF、skeleton/visualPoints 诊断图和统一 manifest。求解失败时仍保留失败候选和残差，但必须标记 `diagnosticOnly:true`，不得生成 `reviewToken`。

未出现在 `body.sequence.json` 或其它动作级 sequence 中的参考帧不能被自动插值成正式动作。诊断 GIF 可以显示已审查阶段的结果，但不能宣称整段动作已经通过。

阶段诊断产物按 `stages/<stageId>/` 分目录保存；每个阶段保留自己的 `diagnostic-manifest.json`、目标姿态图和对比 GIF，后续阶段不会覆盖前一阶段的证据。若需要观察多阶段动作候选，应额外读取统一任务 manifest 和 runtime 动态 GIF，并同时检查 `coverage`、`semanticFailures` 与 runtime residuals。

## 真实验证链

修改代码后必须先执行 `npm run build` 并重启 MCP/Host。案例验证必须由实际 MCP 会话接收提示词，例如“使用 body.gif 将动作适配到 npc1，并生成动态对比 GIF”，再由 Agent 调用 `spine_execute_task`，由 MCP 内部完成 runtime 加载、目标 GIF 和 `spine_render_animation_comparison`。验证记录需保存 `prompt`、`toolTracePath`、`buildIdentity`、`hostSessionId`、输入哈希和产物哈希。旧 `dist`、旧 Host、直接调用内部函数或手工生成的 GIF 都不能作为案例验收依据。

`adaptive-preview` 的 `keypose-interpolated` 只在已审查阶段之间生成连续诊断运动；未审查帧仍计入 `unreviewedFrameCount`，不能变成正式 coverage。连续预览无法构造时才使用 `stage-hold`，并明确目标侧可能静止。无论哪种诊断预览，`diagnosticOnly` 必须为 `true`，不能生成 `reviewToken` 或提交角色。

## 常用调用示例

```json
{
  "taskType": "retarget_reference",
  "inputs": {
    "referenceGifPath": "diagnostic-fixture/reference/body.gif",
    "sequencePath": "diagnostic-fixture/reference/body.sequence.json",
    "standardPosePath": "diagnostic-fixture/trial/neutral-stand-v2.pose.json",
    "visualRigPath": "diagnostic-fixture/trial/npc1.visual-rig.json",
    "targetCharacterPath": "diagnostic-fixture/目标/npc1.json"
  },
  "options": { "workflowProfile": "auto", "retargetMode": "adaptive", "dryRun": true }
}
```

该调用会自动进入 `adaptive-preview` 或显式请求的工作流；现在会先经过 keypose/visualRig 输入审查，可能在 `binding` 停止，然后才进入 `coverage`、`solve`、`runtime` 或 `review`。结果中的 `artifacts.inputAudit`、产物路径和 `nextAction` 是后续调用的唯一依据。

