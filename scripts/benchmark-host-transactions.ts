// 隔离合成工程的撤销与草稿提交性能；保留实际求解、journal、授权、备份及重开。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { HostClient } from '../src/hostClient.js';
import { objectHash, strictHash } from '../src/hostContracts.js';

const output = `docs/plans/host-transaction-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const report: any = { startedAt: new Date().toISOString(), node: process.version, platform: os.platform(), release: os.release(),
  cpu: os.cpus()[0]?.model, sampleCount: 30, warmups: 2, interSampleDelayMs: 120, samples: [], publicWriteEnabled: false,
  scope: '合成关节和两个 region；真实 HostClient undo 包含重新求解、任务状态与 PNG；commit 包含候选、快照、授权、备份、journal 和新文件发布。独立统计 undo HTTP，不用它替代客户端完整耗时。不含 stdio 或浏览器呈现。' };
try {
  report.codeHashes = {};
  for (const file of ['src/hostClient.ts', 'src/hostEditorStore.ts', 'src/hostServer.ts', 'src/hostDocumentStore.ts', 'src/hostObservation.ts', 'src/hostObservationCatalog.ts', 'src/hostReleaseEvidence.ts', 'src/hostFileProtection.ts', 'src/hostRollout.ts', 'src/hostEvaluationTasks.ts', 'src/hostJournal.ts', 'src/spineJson.ts', 'src/strictFileChecks.ts', 'src/hostEvaluator.ts', 'src/rasterRenderer.ts', 'test/helpers/hostFixture.ts', 'package-lock.json'])
    report.codeHashes[file] = strictHash(await readFile(file));
  await withHostFixture(async ({ root, context }) => {
    const host = await startHostServer(context, { writeEnabled: true }), client = new HostClient(context);
    const source = await readFile(path.join(root, 'body.json')), pose = await readFile(path.join(root, 'a.pose.json'));
    let trace: Array<{ route: string; durationMs: number }> = [];
    const originalRpc = client.rpc.bind(client);
    client.rpc = async (...args: Parameters<HostClient['rpc']>) => {
      const started = performance.now();
      try { return await originalRpc(...args); }
      finally { trace.push({ route: args[0].split('?')[0], durationMs: performance.now() - started }); }
    };
    try {
      await client.open({ path: 'a.pose.json' });
      const doc = host.store.active!;
      report.workloadFingerprint = objectHash({ skeleton: doc.skeletonJson, atlas: doc.atlasRaw, bones: doc.mapping.bones,
        origin: doc.mapping.calibration.origin, scale: doc.mapping.calibration.scale, callPath: 'HostClient.undo-and-draft-commit-v1' });
      for (let index = -2; index < 30; index++) {
        await client.open({ path: 'a.pose.json', expectedRevision: host.store.active!.version });
        await client.rpc('/api/pin', { expectedRevision: host.store.active!.version });
        const edited = await client.patch({ expectedRevision: host.store.active!.version, dryRun: false,
          ops: [{ op: 'setPoseTarget', path: 'pose/frame/targets/leftHand', role: 'leftHand', x: .01 + (index + 2) * .0001 }] });
        trace = [];
        const undoStarted = performance.now();
        const undone = await client.history('undo', { expectedRevision: edited.version, dryRun: false });
        const undoClientMs = performance.now() - undoStarted;
        const undoTrace = trace.map(item => ({ ...item }));
        assert.equal(undone.version.revision, edited.version.revision + 1);
        assert.ok(undone.__imageData);
        assert.equal(undone.state.evaluationTasks.active.length, 0);
        assert.equal(undone.state.evaluationTasks.recent.at(-1).status, 'succeeded');
        assert.equal(host.store.active!.value.frame.targets.leftHand.x, JSON.parse(pose.toString()).frame.targets.leftHand.x);
        const redone = await client.history('redo', { expectedRevision: undone.version, dryRun: false });
        const expectedX = host.store.active!.value.frame.targets.leftHand.x;
        const args = { expectedRevision: redone.version, outputPath: `poses/transaction-${index + 2}.pose.json`, requestId: `transaction-${index + 2}`, dryRun: false };
        trace = [];
        const commitStarted = performance.now();
        const saved = await client.commit(args);
        const commitClientMs = performance.now() - commitStarted;
        const commitTrace = trace.map(item => ({ ...item }));
        assert.equal(saved.committed, true);
        const bytes = await readFile(path.join(root, args.outputPath));
        assert.equal(strictHash(bytes), saved.candidateHash);
        assert.deepEqual(await readFile(path.join(root, saved.backupPath)), pose);
        assert.equal(JSON.parse(bytes.toString()).frame.targets.leftHand.x, expectedX);
        assert.notEqual(JSON.parse(bytes.toString()).review?.decision, 'approved');
        const retry = await client.commit(args);
        assert.equal(retry.replayed, true);
        assert.deepEqual(retry.version, saved.version);
        await client.open({ path: args.outputPath, expectedRevision: saved.version });
        assert.equal(host.store.active!.value.frame.targets.leftHand.x, expectedX);
        assert.equal(host.store.active!.undo.length, 0);
        if (index >= 0) report.samples.push({ undoClientMs, undoHttpMs: undoTrace.find(item => item.route === '/api/undo')!.durationMs,
          commitClientMs, undoTrace, commitTrace, backupVerified: true, replayVerified: true, reopenVerified: true });
        await new Promise(resolve => setTimeout(resolve, report.interSampleDelayMs));
      }
      assert.deepEqual(await readFile(path.join(root, 'body.json')), source);
      assert.deepEqual(await readFile(path.join(root, 'a.pose.json')), pose);
      report.sourceUnchanged = true;
    } finally { await host.stop(); report.hostStopped = true; }
  });
  report.phases = Object.fromEntries(['undoClientMs', 'undoHttpMs', 'commitClientMs'].map(key => {
    const values = report.samples.map((sample: any) => sample[key]).sort((a: number, b: number) => a - b);
    return [key, { p50: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1], maximum: values.at(-1) }];
  }));
  report.budgets = { undoHttpMs: 50, undoClientMs: 120, commitClientMs: 200 };
  report.budgetBasis = '2026-10-23 用户确认拆分撤销事务 <50ms 与撤销至新图 <120ms；commit 保持 <200ms。';
  report.budgetsPassed = Object.entries(report.budgets).every(([key, limit]) => report.phases[key].p95 < Number(limit));
  report.mechanicsPassed = true;
} catch (error: any) { report.error = error.message; report.mechanicsPassed = false; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, mechanicsPassed: report.mechanicsPassed, budgetsPassed: report.budgetsPassed, phases: report.phases, error: report.error }));
}
