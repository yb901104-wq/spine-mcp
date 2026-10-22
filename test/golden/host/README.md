# Host 官方 player 三张回归基线

2026-10-22 在可见的内嵌浏览器中，通过临时独立 Host 和 `spine-player@4.1.56` 新采集：原姿态、附件替换/隐藏/层序、躯干旋转/层序三个合成场景。`capture.json` 保留实际 runtime、资源、脚本、相机、视口和 PNG 的核验记录。`manifest.json` 绑定夹具、snapshot、skin/presentation、PMA 及编译后的 renderer/replay 字节哈希。

运行 `npm run build` 后用 `npx tsx scripts/verify-host-golden.ts` 复验；自动测试只重渲 Canvas，无须打开浏览器。`scripts/capture-host-golden.ts` 需可见页面，只能创建不存在的基线，不覆盖已有清单；版本或资源变化后先人工核对并保留旧基线，再重新采集，不能直接改哈希使失败变绿。

范围仅为三个不透明、普通混合、无 tint 的 region 夹具。不覆盖透明纹理、mesh、clipping、tint、其它混合或真实美术角色。数值失败的合成姿态可以用于渲染比较，不产生动作批准；这些基线不能登记为新 Host 会话的当前视觉证据。三张通过只表示登记范围的 rendererParity 通过。

## Git 字节保留

本目录由 `.gitattributes` 禁用换行归一化，确保 Windows 的 `core.autocrlf` 不改变已登记文件的 SHA-256。更新基线仍须真实采集和正式核验，不能通过改哈希放行。
