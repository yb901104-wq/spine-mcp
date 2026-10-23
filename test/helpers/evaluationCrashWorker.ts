// 故障夹具：在真实求解桥的首个进度点挂起，供父测试终止该独立进程；不改角色资产。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { HostClient } from '../../src/hostClient.js';
const workspaceRoot = process.env.SPINE_EVALUATION_TEST_ROOT!;
const client = new HostClient({ workspaceRoot, projectId: process.env.SPINE_EVALUATION_TEST_PROJECT });
const state = await client.state({ autostart: false });
await client.evaluate(state.version, undefined, () => {
  writeFileSync(path.join(workspaceRoot, 'evaluation-worker-ready'), 'paused', { flag: 'wx' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
});
