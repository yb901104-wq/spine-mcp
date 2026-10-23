// 新 HostClient 编辑/任务登记/求解/出图完整调用链；合成负载不替代真实美术或长期观察。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { HostClient } from '../src/hostClient.js';
import { objectHash, strictHash } from '../src/hostContracts.js';
import { RASTER_RENDERER_VERSION } from '../src/rasterRenderer.js';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = process.argv[2] ?? `docs/plans/host-client-performance-${runId}.json`;
const report: any = { startedAt: new Date().toISOString(), scope: '合成关节与两个 region；实际 HostClient.patch 含独立任务 begin/finish、MCP 领域求解、状态及 PNG 读取；不含 stdio 编解码或浏览器呈现。',
  node: process.version, platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length,
  renderer: RASTER_RENDERER_VERSION, sampleCount: 30, warmups: 2, size: 480, interSampleDelayMs: 120,
  diagnosticTracing: process.execArgv.some(arg => arg.startsWith('--trace-event') || arg.startsWith('--cpu-prof')),
  frameMeasurement: 'firstFrameClientMs 为 patch 内首次新版本 PNG 的 RPC 完整读取；frameHttpMs 为随后相同版本的缓存读取。样本间隔在所有计时之外，保留每秒 20 次截图限流。',
  samples: [], publicWriteEnabled: false };
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try {
  report.codeHashes = {};
  for (const file of ['src/hostClient.ts', 'src/hostServer.ts', 'src/hostDocumentStore.ts', 'src/hostEditorStore.ts', 'src/hostObservation.ts', 'src/hostObservationCatalog.ts', 'src/hostReleaseEvidence.ts', 'src/hostFileProtection.ts', 'src/hostRollout.ts', 'src/hostEvaluationTasks.ts', 'src/hostReadiness.ts', 'src/hostJournal.ts', 'src/spineJson.ts', 'src/strictFileChecks.ts', 'src/hostEvaluator.ts', 'src/rasterRenderer.ts', 'test/helpers/hostFixture.ts', 'package-lock.json'])
    report.codeHashes[file] = strictHash(await readFile(file));
  await withHostFixture(async ({ root, context }) => {
    const host = await startHostServer(context, { writeEnabled: true });
    const client = new HostClient(context);
    let clientRoutes: Array<{ route: string; startedMs: number; durationMs: number }> = [];
    const originalRpc = client.rpc.bind(client);
    client.rpc = async (...args: Parameters<HostClient['rpc']>) => {
      const started = performance.now();
      try { return await originalRpc(...args); }
      finally { clientRoutes.push({ route: args[0].split('?')[0], startedMs: started, durationMs: performance.now() - started }); }
    };
    const source = await readFile(path.join(root, 'body.json')), pose = await readFile(path.join(root, 'a.pose.json'));
    let routes: Array<{ route: string; durationMs: number }> = [];
    host.server.on('request', (request, response) => {
      const route = new URL(request.url!, host.endpoint).pathname, started = performance.now();
      response.once('finish', () => routes.push({ route, durationMs: performance.now() - started }));
    });
    try {
      const cold = performance.now();
      await client.state(); await client.open({ path: 'a.pose.json' }); await client.rpc('/api/pin', { expectedRevision: host.store.active!.version });
      await client.evaluate(host.store.active!.version); await client.frame({ expectedRevision: host.store.active!.version, size: 480 });
      report.coldOpenEvaluateFrameMs = performance.now() - cold;
      const doc = host.store.active!;
      report.workloadFingerprint = objectHash({ skeleton: doc.skeletonJson, atlas: doc.atlasRaw, bones: doc.mapping.bones,
        origin: doc.mapping.calibration.origin, scale: doc.mapping.calibration.scale, camera: doc.camera, size: 480,
        callPath: 'HostClient.patch-with-evaluation-task-v1' });
      report.camera = structuredClone(doc.camera);
      for (let index = -2; index < 30; index++) {
        const version = structuredClone(host.store.active!.version);
        routes = [];
        clientRoutes = [];
        const progress: Array<{ stage: string; elapsedMs: number }> = [];
        const cpuStarted = process.cpuUsage();
        const started = performance.now();
        const edited = await client.patch({ expectedRevision: version, ops: [{ op: 'setPoseTarget', path: 'pose/frame/targets/leftHand', role: 'leftHand', x: 0.01 + (index + 2) * .0001 }], dryRun: false }, undefined, stage => { progress.push({ stage, elapsedMs: performance.now() - started }); });
        const endToEndMs = performance.now() - started;
        const cpu = process.cpuUsage(cpuStarted);
        assert.equal(edited.version.revision, version.revision + 1);
        assert.ok(edited.__imageData, '调用必须已读取当前 PNG，不能只计时 patch');
        assert.deepEqual(edited.version, host.store.active!.version);
        assert.equal(edited.state.evaluationTasks.active.length, 0);
        assert.equal(edited.state.evaluationTasks.recent.at(-1).status, 'succeeded');
        assert.equal(edited.state.targetStale, false);
        const trace = routes.map(item => ({ ...item }));
        const clientTrace = clientRoutes.map(item => ({ ...item }));
        const firstFrameClientMs = clientTrace.find(item => item.route === '/api/frame')!.durationMs;
        assert.equal(trace.filter(item => item.route === '/api/evaluation-task').length, 2, '短任务必须登记并回报终态');
        const measure = async (url: string) => {
          const start = performance.now(); const response = await fetch(host.endpoint + url, { headers: { 'X-Spine-Host-Token': host.token } });
          assert.equal(response.status, 200); await response.arrayBuffer(); return performance.now() - start;
        };
        const stateHttpMs = await measure('/api/state?includeCapabilities=false');
        const stateStarted = performance.now(); await client.state({ includeCapabilities: false }); const stateClientMs = performance.now() - stateStarted;
        const frameHttpMs = await measure('/api/frame?' + new URLSearchParams({ ...edited.version, revision: String(edited.version.revision), size: '480' }));
        if (index >= 0) report.samples.push({ endToEndMs, stateHttpMs, stateClientMs, firstFrameClientMs, frameHttpMs,
          startedMs: started, progress, cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
          clientRoutes: clientTrace,
          routes: trace.map(item => ({ ...item })), taskHttpCount: 2,
          serverRouteMs: Object.fromEntries([...new Set(trace.map(item => item.route))].map(route => [route, trace.filter(item => item.route === route).reduce((sum, item) => sum + item.durationMs, 0)])) });
        await new Promise(resolve => setTimeout(resolve, report.interSampleDelayMs));
      }
      assert.deepEqual(await readFile(path.join(root, 'body.json')), source);
      assert.deepEqual(await readFile(path.join(root, 'a.pose.json')), pose);
      assert.deepEqual(host.store.active!.camera, report.camera);
      report.sourceUnchanged = true;
    } finally { await host.stop(); report.hostStopped = true; }
  });
  report.phases = Object.fromEntries(['endToEndMs', 'stateHttpMs', 'stateClientMs', 'firstFrameClientMs', 'frameHttpMs'].map(key => {
    const values = report.samples.map((sample: any) => sample[key]); return [key, { p50: percentile(values, .5), p95: percentile(values, .95), maximum: Math.max(...values) }];
  }));
  report.budgets = { endToEndMs: 120, stateHttpMs: 20, stateClientMs: 20, firstFrameClientMs: 50, frameHttpMs: 50 };
  report.budgetsPassed = Object.entries(report.budgets).every(([key, limit]) => report.phases[key].p95 < (limit as number));
  report.mechanicsPassed = true;
} catch (error: any) { report.error = error.message; report.mechanicsPassed = false; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, mechanicsPassed: report.mechanicsPassed, budgetsPassed: report.budgetsPassed, phases: report.phases, error: report.error }));
}
