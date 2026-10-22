# region 的真实 player 回归样本

`player-region.png` 与 `player-region.json` 原始采集于 2026-10-21 的真实官方 `spine-player@4.1.56` 浏览器联调，复制保留原字节。角色为两个不透明 region 的合成夹具，来源与核验经过见 `docs/plans/host-capture-evidence-20261021.json`；PNG 哈希、固定相机和 runtime 实际顶点保存在 JSON 中。`test/regionParity.test.ts` 重建夹具并先核对顶点，再逐像素对照。

此样本只用于渲染器的单样本回归，不是正式三张黄金帧集合，不代表真实美术验收。该旧截图不会登记为新 Host 的当前审查证据，也不因渲染器修复而获得新的批准或截图准入。
