import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HostEvaluationTasks, withHostEvaluationTask, EVALUATION_TASK_TTL_MS } from '../src/hostEvaluationTasks.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { HostClient } from '../src/hostClient.js';
import { objectHash, type VersionRef } from '../src/hostContracts.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';

const version: VersionRef = { sessionId: 'session', documentId: 'document', openEpoch: 'epoch', revision: 1 };
const key = 'a'.repeat(64);

test('求解任务租约：心跳续期、失联保留未知、终态幂等、错误租约及旧版本隔离', () => {
  let now = 0;
  const tasks = new HostEvaluationTasks(() => now);
  tasks.begin('task', key, version);
  assert.equal(tasks.state(version).active[0].status, 'running');
  now += 10000; tasks.heartbeat('task', key, 'solve');
  now += EVALUATION_TASK_TTL_MS;
  assert.equal(tasks.state(version).active[0].status, 'unresponsive');
  assert.throws(() => tasks.heartbeat('task', key, 'publish'), { code: 'TASK_LEASE_EXPIRED' });
  assert.throws(() => tasks.finish('task', 'b'.repeat(64), 'succeeded'), { code: 'TASK_NOT_FOUND' });
  assert.equal(tasks.state({ ...version, openEpoch: 'new' }).active.length, 0);
  tasks.finish('task', key, 'failed'); tasks.finish('task', key, 'failed');
  assert.equal(tasks.state(version).active.length, 0);
  assert.equal(tasks.state(version).recent[0].status, 'failed');
  assert.throws(() => tasks.finish('task', key, 'succeeded'), { code: 'TASK_CONFLICT' });
  assert.equal(JSON.stringify(tasks.state(version)).includes(key), false);
  for (let index = 0; index < 16; index++) tasks.begin('active-' + index, key, version);
  assert.throws(() => tasks.begin('overflow', key, version), { code: 'HOST_BUSY' });
  tasks.begin('new-version', key, { ...version, revision: 2 });
  assert.equal(tasks.state({ ...version, revision: 2 }).active.length, 1);
});

test('求解任务清理：正常/异常/取消/已取消请求及 begin 回执丢失均不遗留正常 busy', async () => {
  for (const kind of ['succeeded', 'failed', 'cancelled', 'lost-begin']) {
    const tasks = new HostEvaluationTasks(), controller = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
    const rpc = async (args: any, signal?: AbortSignal) => {
      if (args.action === 'begin') {
        const result = tasks.begin(args.taskId, args.leaseKey, args.expectedRevision);
        if (kind === 'lost-begin') throw Error('登记回执丢失');
        return result;
      }
      if (args.action === 'finish') { cleanupSignal = signal; return tasks.finish(args.taskId, args.leaseKey, args.outcome); }
      return tasks.heartbeat(args.taskId, args.leaseKey, args.stage);
    };
    const work = async (task: { check: () => void }) => {
      if (kind === 'cancelled') { controller.abort(); task.check(); }
      if (kind === 'failed') throw Error('计算失败');
      return 42;
    };
    if (kind === 'succeeded') assert.equal(await withHostEvaluationTask(rpc, version, controller.signal, work), 42);
    else await assert.rejects(withHostEvaluationTask(rpc, version, controller.signal, work));
    assert.equal(tasks.state(version).active.length, 0);
    assert.equal(tasks.state(version).recent[0].status, kind === 'lost-begin' ? 'failed' : kind);
    assert.equal(cleanupSignal, undefined);
  }
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(withHostEvaluationTask(async () => { calls++; }, version, controller.signal, async () => 0), { code: 'TASK_CANCELLED' });
  assert.equal(calls, 0);
});

test('求解完成但清理回执失败时明确报告状态不明，不声称已发布结果被回滚', async () => {
  const rpc = async (args: any) => { if (args.action === 'finish') throw Error('网络失联'); return { terminal: false }; };
  await assert.rejects(withHostEvaluationTask(rpc, version, undefined, async () => 42), (error: any) =>
    error.code === 'TASK_STATUS_UNCERTAIN' && error.detail.published === true);
});

test('实际 Host 控制通道：页面不可登记任务，版本/租约隔离且任务只改变观察状态', async () => withHostFixture(async ({ context }) => {
  const host = await startHostServer(context, { persist: false });
  const headers = { 'X-Spine-Host-Token': host.token }, control = { 'X-Spine-Host-Control': host.control };
  const post = (args: any, extra = {}) => fetch(host.endpoint + '/api/evaluation-task', { method: 'POST',
    headers: { ...headers, ...extra, Origin: host.endpoint, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const state = async () => (await fetch(host.endpoint + '/api/state', { headers })).json() as any;
  try {
    await host.store.open({ path: 'a.pose.json' });
    const baseline = await state(), args = { action: 'begin', taskId: 'external', leaseKey: key, expectedRevision: baseline.version };
    assert.equal((await post(args)).status, 403);
    assert.equal((await post({ ...args, expectedRevision: { ...baseline.version, revision: 999 } }, control)).status, 409);
    assert.equal((await post({ ...args, approved: true }, control)).status, 400);
    assert.equal((await post(args, control)).status, 200);
    let current = await state();
    assert.equal(current.capabilities.operations.find((item: any) => item.operation === 'evaluate').reasons[0].code, 'EVALUATION_BUSY');
    assert.equal(current.capabilities.operations.find((item: any) => item.operation === 'inspect').canRun, true);
    assert.equal(JSON.stringify(current).includes(key), false);
    assert.equal((await post({ action: 'heartbeat', taskId: 'external', leaseKey: key, stage: 'solve' }, control)).status, 200);
    assert.equal((await post({ action: 'finish', taskId: 'external', leaseKey: 'b'.repeat(64), outcome: 'succeeded' }, control)).status, 409);
    assert.equal((await post({ action: 'finish', taskId: 'external', leaseKey: key, outcome: 'failed' }, control)).status, 200);
    current = await state(); assert.equal(current.evaluationTasks.active.length, 0);
    for (const field of ['version', 'fileHash', 'contentHash', 'derivedHash', 'reviewHash', 'undoDepth', 'redoDepth', 'uncommitted']) assert.equal(objectHash(current[field]), objectHash(baseline[field]), field);
  } finally { await host.stop(); }
}));

test('实际 MCP 求解桥：成功、进度回调取消与异常均回报终态，不改源姿态', async () => withHostFixture(async ({ root, context }) => {
  const host = await startHostServer(context), client = new HostClient(context);
  try {
    await client.state(); const opened = await client.open({ path: 'a.pose.json' });
    const source = await readFile(path.join(root, 'a.pose.json'));
    await client.evaluate(opened.version);
    let state = await client.state(); assert.equal(state.evaluationTasks.active.length, 0);
    assert.equal(state.evaluationTasks.recent.at(-1).status, 'succeeded');
    const controller = new AbortController();
    await assert.rejects(client.evaluate(opened.version, controller.signal, () => controller.abort()), { code: 'TASK_CANCELLED' });
    state = await client.state(); assert.equal(state.evaluationTasks.active.length, 0);
    assert.equal(state.evaluationTasks.recent.at(-1).status, 'cancelled');
    await assert.rejects(client.evaluate(opened.version, undefined, () => { throw Error('进度回调异常'); }), /进度回调异常/);
    state = await client.state(); assert.equal(state.evaluationTasks.active.length, 0);
    assert.equal(state.evaluationTasks.recent.at(-1).status, 'failed');
    assert.deepEqual(await readFile(path.join(root, 'a.pose.json')), source);
  } finally { await host.stop(); }
}));

test('长于心跳间隔的求解会续期，结束后定时器与异步心跳已收束', async () => {
  const tasks = new HostEvaluationTasks(); let beats = 0;
  const rpc = async (args: any) => {
    if (args.action === 'begin') return tasks.begin(args.taskId, args.leaseKey, args.expectedRevision);
    if (args.action === 'finish') return tasks.finish(args.taskId, args.leaseKey, args.outcome);
    beats++; return tasks.heartbeat(args.taskId, args.leaseKey, args.stage);
  };
  await withHostEvaluationTask(rpc, version, undefined, async task => {
    task.stage('solve'); await new Promise(resolve => setTimeout(resolve, 5200)); task.check();
    assert.equal(tasks.state(version).active[0].stage, 'solve');
  });
  assert.equal(beats, 1); assert.equal(tasks.state(version).active.length, 0);
});

test('真实 stdio：显式重算过程中 Host 可观察 busy，返回前登记完成终态', async () => withHostFixture(async ({ root, context }) => {
  const host = await startHostServer(context, { writeEnabled: true });
  const client = new Client({ name: 'evaluation-task-protocol', version: '1' }, { capabilities: {} });
  const observed: any[] = [], originalEvent = host.store.onEvent;
  host.store.onEvent = event => {
    originalEvent?.(event);
    if (event.type === 'evaluation-task-updated') observed.push({ tasks: host.store.evaluationTasks.state(host.store.active?.version ?? null),
      evaluate: host.store.capabilities().operations.find(item => item.operation === 'evaluate') });
  };
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: {
      ...env, SPINE_MCP_WORKSPACE: root, SPINE_HOST_AUTOSTART: '0', SPINE_HOST_ENDPOINT: host.endpoint, SPINE_HOST_TOKEN: host.token,
    } }));
    const call = async (name: string, args: any) => {
      const response = await client.callTool({ name, arguments: { projectId: context.projectId, ...args } });
      assert.ok(!response.isError, JSON.stringify(response));
      return JSON.parse((response.content as any[]).filter(item => item.type === 'text').map(item => item.text).join('\n'));
    };
    await call('spine_host_open', { path: 'a.pose.json' });
    const before = await readFile(path.join(root, 'a.pose.json'));
    const result = await call('spine_recheck_pose', { posePath: 'a.pose.json' });
    assert.ok(observed.some(item => item.tasks.active.length === 1 && item.evaluate.state === 'busy'));
    assert.equal(result.evaluationTasks.active.length, 0);
    assert.equal(result.evaluationTasks.recent.at(-1).status, 'succeeded');
    assert.equal(result.evaluationTasks.recent.at(-1).stage, 'publish');
    assert.equal(observed.at(-1).tasks.recent.at(-1).status, 'succeeded');
    assert.deepEqual(await readFile(path.join(root, 'a.pose.json')), before);
  } finally { await client.close(); await host.stop(); }
}));

test('真实进程终止：失去求解心跳后保持 unresponsive，显式新 epoch 不继承旧 busy', { timeout: 30000 }, async () => withHostFixture(async ({ root, context }) => {
  const host = await startHostServer(context);
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    await host.store.open({ path: 'a.pose.json' });
    const version = structuredClone(host.store.active!.version), source = await readFile(path.join(root, 'a.pose.json'));
    worker = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/evaluationCrashWorker.ts'], { env: { ...process.env,
      SPINE_EVALUATION_TEST_ROOT: root, SPINE_EVALUATION_TEST_PROJECT: context.projectId, SPINE_HOST_AUTOSTART: '0',
      SPINE_HOST_ENDPOINT: host.endpoint, SPINE_HOST_TOKEN: host.token,
    }, stdio: 'ignore', windowsHide: true });
    const exited = new Promise<void>((resolve, reject) => { worker!.once('exit', () => resolve()); worker!.once('error', reject); });
    const deadline = Date.now() + 6000;
    for (;;) {
      try { await readFile(path.join(root, 'evaluation-worker-ready')); break; }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() > deadline || worker.exitCode !== null || worker.signalCode !== null) throw Error('外部求解进程未到达故障注入点');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await host.store.state()).evaluationTasks.active[0].status, 'running');
    worker.kill(); await exited;
    const last = host.store.evaluationTasks.state(version).active[0].lastHeartbeatAt;
    const waitMs = Date.parse(last) + EVALUATION_TASK_TTL_MS - Date.now() + 50;
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    const lost = await host.store.state();
    assert.equal(lost.evaluationTasks.active[0].status, 'unresponsive');
    assert.equal(lost.capabilities.operations.find((op: any) => op.operation === 'evaluate').reasons[0].code, 'EVALUATION_UNRESPONSIVE');
    assert.equal(lost.capabilities.operations.find((op: any) => op.operation === 'inspect').canRun, true);
    await host.store.open({ path: 'a.pose.json', reload: true, expectedRevision: version });
    const reloaded = await host.store.state();
    assert.notEqual(reloaded.version.openEpoch, version.openEpoch);
    assert.equal(reloaded.evaluationTasks.active.length, 0);
    assert.deepEqual(await readFile(path.join(root, 'a.pose.json')), source);
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise<void>(resolve => worker!.once('exit', () => resolve()));
      worker.kill(); await exited;
    }
    await host.stop();
  }
}));
