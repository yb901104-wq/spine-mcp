// 真实角色默认摘要的只读采样；不求解、不批准、不修改角色或姿态。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { getPoseState } from '../src/poseOps.js';
import { poseDependencies, bytesHash } from '../src/poseDigest.js';
import { resolveWorkspacePath } from '../src/spineJson.js';

const workspace = path.resolve(process.argv[2] ?? 'D:/AI_cc/spine test');
const posePath = process.argv[3] ?? 'previews/pose-workflow-20261009/standing.pose.json';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = process.argv[4] ?? `docs/plans/real-pose-performance-${runId}.json`;
const context = { workspaceRoot: workspace };
const raw = await readFile(resolveWorkspacePath(posePath, context));
const pose = JSON.parse(raw.toString('utf8'));
const dependencies = await poseDependencies(pose, context);
const protectedFiles = new Map([[posePath, bytesHash(raw)], ...dependencies.dependencies.map(f => [f.filePath, f.hash] as [string, string])]);
for (const item of pose.review?.evidence ?? []) {
  protectedFiles.set(item.filePath, bytesHash(await readFile(resolveWorkspacePath(item.filePath, context))));
}
const rounds = [];
let last: any;
const initialState = await getPoseState({ posePath }, context);
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < 2; i++) await getPoseState({ posePath }, context);
  const samplesMs = [], responseBytes = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    last = await getPoseState({ posePath }, context);
    samplesMs.push(performance.now() - start);
    responseBytes.push(Buffer.byteLength(JSON.stringify(last)));
    assert.equal(last.solveCount, 0);
    assert.equal(last.checked, 'strictDependencies');
    assert.equal(last.freshness, initialState.freshness);
    assert.equal(last.dependencyFingerprint, dependencies.dependencyFingerprint);
    assert.equal(last.solved?.joints, undefined);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  rounds.push({ samplesMs, p50Ms: sorted[14], p95Ms: sorted[28], maximumMs: sorted.at(-1), maxResponseBytes: Math.max(...responseBytes) });
}
for (const [file, hash] of protectedFiles) assert.equal(bytesHash(await readFile(resolveWorkspacePath(file, context))), hash, `只读采样期间文件变化：${file}`);
const all = rounds.flatMap(r => r.samplesMs).sort((a, b) => a - b);
const report = {
  measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, workspace, posePath,
  loadNote: process.env.BENCHMARK_LOAD_NOTE ?? '未声明额外受控负载；不保证操作系统无其它后台任务。',
  scope: '真实 npc1 无参考站姿；当前进程只读领域入口，不含 MCP stdio 或 HTTP 传输；不测求解和图像性能。',
  sampleCount: all.length, rounds, p50Ms: all[44], p95Ms: all[85], maximumMs: all.at(-1),
  maxResponseBytes: Math.max(...rounds.map(r => r.maxResponseBytes)),
  freshness: last.freshness, officialOk: last.officialOk, checked: last.checked, solveCount: last.solveCount,
  dependencyFingerprint: dependencies.dependencyFingerprint, dependencyFiles: last.read.dependencyFiles,
  sourceUnchanged: true, budgetP95Ms: 20, passed: rounds.every(r => r.p95Ms < 20),
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, passed: report.passed, p95Ms: report.p95Ms, roundP95Ms: rounds.map(r => r.p95Ms), maxResponseBytes: report.maxResponseBytes, solveCount: report.solveCount }));
