import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { objectHash } from '../src/hostContracts.js';

const files = process.argv.slice(2);
assert.equal(files.length, 3, '需要三轮独立的 30 样本事务报告。');
assert.equal(new Set(files).size, 3, '不能重复使用同一报告。');
const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
assert.equal(new Set(reports.map(report => report.startedAt)).size, 3, '不能重复使用同一轮数据。');
const first = reports[0], keys = ['undoClientMs', 'undoHttpMs', 'commitClientMs'];
for (const report of reports) {
  assert.equal(report.mechanicsPassed, true);
  assert.equal(report.samples.length, 30);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.hostStopped, true);
  for (const key of ['node', 'platform', 'release', 'cpu', 'sampleCount', 'warmups', 'interSampleDelayMs', 'codeHashes', 'workloadFingerprint', 'budgets', 'budgetBasis'])
    assert.equal(objectHash(report[key]), objectHash(first[key]), `${key} 不一致，不能汇总。`);
  for (const sample of report.samples) {
    for (const key of keys) assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0, `无效耗时 ${key}`);
    for (const key of ['backupVerified', 'replayVerified', 'reopenVerified']) assert.equal(sample[key], true);
  }
}
const samples = reports.flatMap(report => report.samples);
const phases = Object.fromEntries(keys.map(key => {
  const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
  return [key, { p50: values[44], p95: values[85], maximum: values.at(-1) }];
}));
const passed = (phases: any) => Object.entries(first.budgets).every(([key, limit]) => phases[key].p95 < Number(limit));
const output = `docs/plans/host-transaction-performance-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const report = { summarizedAt: new Date().toISOString(), files, scope: first.scope, codeHashes: first.codeHashes, workloadFingerprint: first.workloadFingerprint,
  environment: { node: first.node, platform: first.platform, release: first.release, cpu: first.cpu }, sampleCount: samples.length,
  warmupsPerRound: first.warmups, interSampleDelayMs: first.interSampleDelayMs, phases, budgets: first.budgets, budgetBasis: first.budgetBasis,
  roundP95: reports.map(report => Object.fromEntries(keys.map(key => [key, report.phases[key].p95]))),
  allRoundsPassed: reports.every(report => passed(report.phases)), aggregatePassed: passed(phases), sourceUnchanged: true, hostsStopped: true, publicWriteEnabled: false };
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sampleCount: report.sampleCount, allRoundsPassed: report.allRoundsPassed, aggregatePassed: report.aggregatePassed, phases }));
