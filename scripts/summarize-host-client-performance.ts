// 仅汇总同代码、同环境及同负载的三轮完整 HostClient 样本，拒绝覆盖历史证据。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { objectHash } from '../src/hostContracts.js';

const files = process.argv.slice(2);
assert.equal(files.length, 3, '需要三轮独立的 30 样本报告。');
assert.equal(new Set(files).size, 3, '不能重复使用同一份报告。');
const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
const first = reports[0];
const phases = ['endToEndMs', 'stateHttpMs', 'stateClientMs', 'firstFrameClientMs', 'frameHttpMs'];
for (const report of reports) {
  assert.equal(report.mechanicsPassed, true, '不能汇总机械流程失败的报告。');
  assert.equal(report.sampleCount, 30);
  assert.equal(report.samples.length, 30);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.hostStopped, true);
  assert.ok(report.workloadFingerprint);
  assert.equal(report.diagnosticTracing, false, '诊断跟踪报告不能混入正式性能汇总。');
  for (const key of ['renderer', 'workloadFingerprint', 'codeHashes', 'node', 'platform', 'release', 'cpu', 'logicalCores', 'size', 'warmups', 'interSampleDelayMs', 'budgets'])
    assert.equal(objectHash(report[key]), objectHash(first[key]), `三轮 ${key} 必须一致。`);
  for (const sample of report.samples) {
    assert.equal(sample.taskHttpCount, 2);
    for (const key of phases) assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0, `无效耗时 ${key}`);
  }
}
const samples = reports.flatMap(report => report.samples);
const summaryPhases = Object.fromEntries(phases.map(key => {
  const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
  return [key, { p50: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1], maximum: values.at(-1) }];
}));
const budgetsPassed = (report: any) => Object.entries(first.budgets).every(([key, limit]) => report.phases[key].p95 < Number(limit));
const summary = { summarizedAt: new Date().toISOString(), files, scope: first.scope, frameMeasurement: first.frameMeasurement,
  environment: { node: first.node, platform: first.platform, release: first.release, cpu: first.cpu, logicalCores: first.logicalCores },
  renderer: first.renderer, codeHashes: first.codeHashes, workloadFingerprint: first.workloadFingerprint,
  sampleCount: samples.length, warmupsPerRound: first.warmups, interSampleDelayMs: first.interSampleDelayMs,
  coldOpenEvaluateFrameMs: reports.map(report => report.coldOpenEvaluateFrameMs), phases: summaryPhases, budgets: first.budgets,
  roundP95: reports.map(report => Object.fromEntries(phases.map(key => [key, report.phases[key].p95]))),
  allRoundsPassed: reports.every(budgetsPassed), aggregatePassed: budgetsPassed({ phases: summaryPhases }),
  sourceUnchanged: true, hostsStopped: true, publicWriteEnabled: false,
  limitations: '合成 region 的 HostClient 路径，不含 MCP stdio 编解码、浏览器呈现或真实美术角色负载，不替代两周观察和公开启用评审。' };
const output = `docs/plans/host-client-performance-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(output, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sampleCount: summary.sampleCount, allRoundsPassed: summary.allRoundsPassed, aggregatePassed: summary.aggregatePassed, phases: summary.phases }));
