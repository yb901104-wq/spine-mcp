// 标准高维 Rosenbrock 数值负载；只验证任务控制，不冒充真实参考动作修正或美术验收。
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { boundedLeastSquares } from '../src/poseRefinementMath.js';
import { boundedLeastSquaresTask } from '../src/poseRefinementTasks.js';
import { runTask } from '../src/taskControl.js';

const dimension = Number(process.argv[2] ?? 96), pairCount = Number(process.argv[3] ?? 10);
assert.ok(Number.isInteger(dimension) && dimension >= 2 && dimension <= 160);
assert.ok(Number.isInteger(pairCount) && pairCount >= 1 && pairCount <= 30);
const initial = Array.from({ length: dimension }, (_, i) => i % 2 ? 1 : -1.2);
const options = { bounds: initial.map(() => [-2, 2] as [number, number]), steps: initial.map(() => .0001), iterations: 60 };
const evaluate = (x: number[]) => x.slice(0, -1).flatMap((v, i) => [10 * (x[i + 1] - v * v), 1 - v]);
const expected = boundedLeastSquares(initial, evaluate, options);
assert.equal(expected.iterations, 60, '该负载未走满 60 次，不能用于 60 次迭代验收。');
const warm = await runTask({}, () => boundedLeastSquaresTask(initial, evaluate, options));
assert.deepEqual(warm, expected);
const pairs = [];
for (let pair = 0; pair < pairCount; pair++) {
  let syncMs = 0, taskMs = 0;
  const notifications: Array<{ current: number; total: number; elapsedMs: number }> = [];
  const sync = () => { const start = performance.now(); const result = boundedLeastSquares(initial, evaluate, options); syncMs = performance.now() - start; assert.deepEqual(result, expected); };
  const task = async () => {
    const start = performance.now();
    const result = await runTask({ progress: (current, total) => notifications.push({ current, total, elapsedMs: performance.now() - start }) }, () => boundedLeastSquaresTask(initial, evaluate, options));
    taskMs = performance.now() - start;
    assert.deepEqual(result, expected);
  };
  if (pair % 2) { await task(); sync(); } else { sync(); await task(); }
  pairs.push({ syncMs, taskMs, overheadPercent: (taskMs / syncMs - 1) * 100, notifications });
  console.log(JSON.stringify({ pair: pair + 1, syncMs, taskMs, notifications: notifications.length }));
}
const controller = new AbortController();
let requestedAt = 0, evaluations = 0;
const cancelStarted = performance.now();
const timer = setTimeout(() => { requestedAt = performance.now(); controller.abort(); }, 50);
let cancellationCode: string | undefined;
try {
  await runTask({ signal: controller.signal }, () => boundedLeastSquaresTask(initial, x => { evaluations++; return evaluate(x); }, options));
} catch (error: any) { cancellationCode = error.code; }
finally { clearTimeout(timer); }
assert.equal(cancellationCode, 'CANCELLED');
const stoppedAt = performance.now(), evaluatedAtStop = evaluations;
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(evaluations, evaluatedAtStop, '取消后仍有后台求解。');
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const median = (values: number[]) => { const a = sorted(values), m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const syncMedianMs = median(pairs.map(p => p.syncMs)), taskMedianMs = median(pairs.map(p => p.taskMs));
const overheadPercent = (taskMedianMs / syncMedianMs - 1) * 100;
const cancellation = { requestedAfterMs: requestedAt - cancelStarted, stoppedAfterRequestMs: stoppedAt - requestedAt, evaluations, noBackgroundWork: true, code: cancellationCode };
const report = {
  measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
  scope: '标准高维 Rosenbrock、共享 60 次数值迭代器；当前进程任务控制回调，不含 MCP 通知传输，不是实际美术角色/参考修正。',
  notificationPolicy: '200ms 节流；60 次迭代持续不足 1000ms 时至少首末 2 条，持续至少 1000ms 时至少 6 条；最后 current=total。2026-10-22 用户确认。',
  dimension, iterations: expected.iterations, pairCount, alternatingOrder: true, pairs,
  syncMedianMs, taskMedianMs, overheadPercent, cancellation,
  notificationDensityPassed: pairs.every(p => p.notifications.length >= (p.taskMs >= 1000 ? 6 : 2) && p.notifications[0]?.current === 0 && p.notifications.at(-1)?.current === p.notifications.at(-1)?.total),
  overheadPassed: overheadPercent < 5,
  cancellationPassed: cancellation.stoppedAfterRequestMs < 300,
};
const output = `docs/plans/task-control-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, ...report, pairs: undefined }));
