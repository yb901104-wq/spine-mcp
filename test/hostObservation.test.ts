import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { HostObservation, saveObservationReport, summarizeObservation } from '../src/hostObservation.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { hostBuildFingerprint, OBSERVATION_ROOT, ObservationAuthority, releaseBinding, REVIEW_CHECKS, TWO_WEEKS_MS, writeEvidenceFile } from '../src/hostReleaseEvidence.js';
import { createRolloutReview, HostRollout, validateRolloutApproval } from '../src/hostRollout.js';
import { protectHostFile } from '../src/hostFileProtection.js';
import { readWriter } from '../src/writerOwnership.js';
import { HostClient } from '../src/hostClient.js';
import { objectHash, strictHash } from '../src/hostContracts.js';
import { appendObservationCatalog } from '../src/hostObservationCatalog.js';

const safeProtect = async () => true; // 仅临时测试工作区；不用于实际部署记录。
const checks = () => Object.fromEntries(REVIEW_CHECKS.map(key => [key, `隔离协议夹具：逐项核对 ${key}，不代表真实两周或真实发布批准。`]));
const files = { regression: 'acceptance/regression.json', clientPerformance: 'acceptance/client.json', transactions: 'acceptance/transactions.json', desktop: 'acceptance/desktop.json' };
async function acceptanceFixture(root: string) {
  await mkdir(path.join(root, 'acceptance'));
  await writeFile(path.join(root, files.regression), JSON.stringify({ build: { exitCode: 0 }, regression: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0 } }));
  for (const name of [files.clientPerformance, files.transactions]) await writeFile(path.join(root, name), JSON.stringify({ allRoundsPassed: true, aggregatePassed: true, sampleCount: 90 }));
  await writeFile(path.join(root, files.desktop), JSON.stringify({ passed: true, native: { ok: true, performance: { budgetPassed: true } }, sourceUnchanged: true, allInputsUnchanged: true, savedPoseReverified: true, reconnectPixelsIdentical: true, capturePerformance: { budgetPassed: true } }));
}
/** 签名/时间协议的纯测试数据；临时根在测试结束删除，不能拿作真实观察或生产审批。 */
async function signedWindow(context: any, days = 14) {
  const authority = await ObservationAuthority.load(context, safeProtect, true), candidate = await hostBuildFingerprint(), binding = await releaseBinding(context);
  const runId = randomUUID(), started = Date.now() - days * 86400000 - 600000;
  await appendObservationCatalog(context, authority, { type: 'start', runId, candidateHash: candidate.hash, bindingHash: objectHash(binding) });
  let previous = ''; const records: any[] = [];
  const append = (record: any, elapsedMs: number) => { const sealed = authority.seal({ ...record, runId, sequence: records.length, previous, wallMs: started + elapsedMs, elapsedMs }); previous = sealed.hash; records.push(sealed); };
  append({ type: 'start', schema: 1, intervalMs: 60000, candidateHash: candidate.hash, binding, testClock: false }, 0);
  for (let day = 0; day <= days; day++) for (const offset of [1000, 61000]) append({ type: 'sample', writeMode: 'observer', targetStale: false, suspectedFalsePositive: false, frozen: false,
    candidateMatches: true, bindingMatches: true, clockConsistent: true, inconclusive: false, gapMs: 0, requests: { 'GET /api/frame 2xx': day + 1 } }, day * 86400000 + offset);
  append({ type: 'stop' }, days * 86400000 + 62000);
  const directory = path.join(context.workspaceRoot, OBSERVATION_ROOT, 'runs'); await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${runId}.jsonl`); await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  await appendObservationCatalog(context, authority, { type: 'stop', runId, fileHash: strictHash(await readFile(file)), finalHash: records.at(-1).hash });
  return { authority, candidate, binding, file, records };
}

test('真实 HTTP/CLI 观察：控制隔离、拒绝假时间、日志脱敏、短窗口拒批及只读输入不变', async () => withHostFixture(async ({ root, context }) => {
  const host = await startHostServer(context);
  const source = await readFile(path.join(root, 'body.json')), pose = await readFile(path.join(root, 'a.pose.json'));
  const post = (route: string, body: any, control = true) => fetch(host.endpoint + route, { method: 'POST', headers: { Origin: host.endpoint, 'Content-Type': 'application/json', 'X-Spine-Host-Token': host.token, ...(control ? { 'X-Spine-Host-Control': host.control } : {}) }, body: JSON.stringify(body) });
  try {
    await host.store.open({ path: 'a.pose.json' });
    assert.equal((await post('/api/observation', { action: 'start' }, false)).status, 403);
    assert.equal((await post('/api/rollout-disable', {}, false)).status, 403);
    assert.equal((await post('/api/observation', { action: 'start', now: Date.now() + TWO_WEEKS_MS })).status, 400);
    assert.equal((await post('/api/rollout-enable', { approved: true })).status, 404);
    const run = promisify(execFile), env = { ...process.env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_HOST_AUTOSTART: '0' };
    const cli = async (command: string) => JSON.parse((await run(process.execPath, ['--import', 'tsx', 'src/hostObservationCli.ts', command, '--workspace', root], { env, windowsHide: true, timeout: 15000 })).stdout);
    assert.equal((await cli('start')).running, true);
    await fetch(host.endpoint + '/api/state?secret=' + host.token, { headers: { 'X-Spine-Host-Token': host.token } });
    await host.observation.sample();
    const status = await cli('status'); assert.equal(status.observation.running, true); assert.equal(status.writeMode, 'observer');
    assert.equal((await cli('stop')).running, false);
    const result = await cli('report'); assert.equal(result.report.windowSpanSatisfied, false); assert.equal(result.report.readyForHumanReview, false);
    const directory = path.join(root, OBSERVATION_ROOT, 'runs'), logs = (await Promise.all((await readdir(directory)).map(file => readFile(path.join(directory, file), 'utf8')))).join('\n');
    for (const secret of [host.token, host.control, 'PRIVATE KEY', 'secret=']) assert.equal(logs.includes(secret), false, secret);
    await assert.rejects(createRolloutReview({ report: result.file, reviewedBy: '隔离测试', checks: checks(), evidence: files }, context, safeProtect), { code: 'ROLLOUT_OBSERVATION_INCOMPLETE' });
    assert.equal(await readWriter(context), null);
    const nonInteractive = await run(process.execPath, ['dist/hostObservationCli.js', 'review', '--workspace', root], { env, windowsHide: true }).then(() => null, error => error);
    assert.ok(nonInteractive.stderr.includes('OPERATOR_APPROVAL_REQUIRED'));
    assert.deepEqual(await readFile(path.join(root, 'body.json')), source); assert.deepEqual(await readFile(path.join(root, 'a.pose.json')), pose);
  } finally { await host.stop(); }
}));

test('实际编译版生产入口：手填通过标志不能启用，编译版 CLI 记录同构建且未满两周', async () => withHostFixture(async ({ root, context }) => {
  await writeFile(path.join(root, 'forged.json'), JSON.stringify({ approved: true, twoWeekWindowSatisfied: true }));
  const env = { ...process.env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_HOST_PROJECT_ID: context.projectId, SPINE_HOST_AUTOSTART: '0', SPINE_HOST_WRITE: '1', SPINE_HOST_ROLLOUT_APPROVAL: 'forged.json' };
  const child = spawn(process.execPath, ['dist/hostServer.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error('编译版 Host 未启动')), 15000);
      child.stdout!.on('data', data => { output += data; if (output.includes('动画工作区宿主已启动')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', () => { if (!output.includes('动画工作区宿主已启动')) { clearTimeout(timer); reject(Error('编译版 Host 提前退出')); } });
    });
    const client = new HostClient(context); await client.open({ path: 'a.pose.json' });
    const state = await client.state({ autostart: false }); assert.equal(state.writeMode, 'observer'); assert.equal(state.rollout.writeEnabled, false); assert.equal(state.rollout.writeRequested, true); assert.equal(await readWriter(context), null);
    const cli = async (command: string) => JSON.parse((await promisify(execFile)(process.execPath, ['dist/hostObservationCli.js', command, '--workspace', root], { env, windowsHide: true, timeout: 15000 })).stdout);
    await cli('start'); await cli('stop'); const result = await cli('report');
    assert.equal(result.report.sessions.length, 1); assert.equal(result.report.excluded.length, 0); assert.equal(result.report.readyForHumanReview, false);
    const exited = once(child, 'exit'); await client.shutdownForSwitch(); await exited;
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
}));

test('观察证据：签名与链篡改、未来/倒退时钟、测试时钟和空日历跨度不能取得准入', async () => withHostFixture(async ({ context }) => {
  const fixture = await signedWindow(context), valid = await summarizeObservation(context, fixture.candidate.hash);
  assert.equal(valid.windowSpanSatisfied, true); assert.equal(valid.readyForHumanReview, true); assert.equal(valid.coverageDays.length, 15);
  assert.ok(valid.gapCount >= 14); assert.ok(valid.monitoredMs < TWO_WEEKS_MS, '日期间断不能补记为在线观察时长');
  const original = await readFile(fixture.file, 'utf8');
  await unlink(fixture.file);
  assert.equal((await summarizeObservation(context, fixture.candidate.hash)).readyForHumanReview, false);
  await writeFile(fixture.file, fixture.records.slice(0, -2).map(record => JSON.stringify(record)).join('\n') + '\n');
  assert.equal((await summarizeObservation(context, fixture.candidate.hash)).readyForHumanReview, false);
  await writeFile(fixture.file, original);
  const catalogPath = path.join(context.workspaceRoot, OBSERVATION_ROOT, 'catalog.jsonl'), catalog = await readFile(catalogPath, 'utf8');
  await writeFile(catalogPath, catalog.split('\n')[0] + '\n');
  await assert.rejects(summarizeObservation(context, fixture.candidate.hash), { code: 'EVIDENCE_INVALID' });
  await writeFile(catalogPath, catalog);
  const tampered = JSON.parse(JSON.stringify(fixture.records)); tampered[1].payload.targetStale = true;
  await writeFile(fixture.file, tampered.map((record: any) => JSON.stringify(record)).join('\n') + '\n');
  assert.equal((await summarizeObservation(context, fixture.candidate.hash)).readyForHumanReview, false);
  await writeFile(fixture.file, original.slice(0, -1));
  assert.equal((await summarizeObservation(context, fixture.candidate.hash)).readyForHumanReview, false);
  await writeFile(fixture.file, original);
  assert.equal((await summarizeObservation(context, fixture.candidate.hash, Date.now() - TWO_WEEKS_MS)).readyForHumanReview, false);
  const store = new HostEditorStore(context); await store.open({ path: 'a.pose.json' }); let time = Date.now(), mono = 0;
  const observation = new HostObservation(store, context, safeProtect, { wall: () => time, monotonic: () => mono });
  await observation.start(); time += TWO_WEEKS_MS; mono += TWO_WEEKS_MS; await observation.stop();
  const testClock = await summarizeObservation(context, fixture.candidate.hash, time);
  assert.equal(testClock.readyForHumanReview, false); assert.ok(testClock.errors.some(error => error.includes('测试时钟')));
}));

test('限定 C1 的审批绑定当前构建/工程/证据，篡改拒绝，关闭撤销后不能再启用', async () => withHostFixture(async ({ root, context }) => {
  await signedWindow(context); await acceptanceFixture(root);
  const report = await saveObservationReport(context, safeProtect);
  const approval = await createRolloutReview({ report: report.file, reviewedBy: '协议单元夹具（非真实发布批准）', checks: checks(), evidence: files }, context, safeProtect);
  assert.equal((await validateRolloutApproval(approval.file, context)).scope, 'c1-pose-single-hand-draft-v1');
  const approvalPath = path.join(root, approval.file), approved = JSON.parse(await readFile(approvalPath, 'utf8')), authority = await ObservationAuthority.load(context, safeProtect);
  for (const mutation of [{ scope: 'c2' }, { candidateHash: 'other-build' }, { binding: { ...approved.payload.binding, projectId: 'other-project' } }, { approvedAt: Date.now() - 2 * 86400000 }]) {
    await writeFile(approvalPath, JSON.stringify(authority.seal({ ...approved.payload, ...mutation })));
    await assert.rejects(validateRolloutApproval(approval.file, context), { code: 'ROLLOUT_APPROVAL_INVALID' });
  }
  await writeFile(approvalPath, JSON.stringify(approved));
  const original = await readFile(path.join(root, files.clientPerformance));
  await writeFile(path.join(root, files.clientPerformance), '{}');
  await assert.rejects(validateRolloutApproval(approval.file, context)); await writeFile(path.join(root, files.clientPerformance), original);
  const store = new HostEditorStore(context), rollout = new HostRollout(store, context, safeProtect);
  try {
    assert.equal((await rollout.enableFromApproval(approval.file)).ok, true); assert.equal((await readWriter(context))?.mode, 'attached');
    await store.open({ path: 'a.pose.json' }); await store.pin(store.active!.version);
    await store.patch({ expectedRevision: store.active!.version, dryRun: false, ops: [{ op: 'setPoseTarget', path: 'pose/frame/targets/leftHand', role: 'leftHand', x: .01 }] });
    const disabling = rollout.disable();
    await assert.rejects(store.patch({ expectedRevision: store.active!.version, dryRun: false, ops: [{ op: 'setPoseTarget', path: 'pose/frame/targets/leftHand', role: 'leftHand', x: .02 }] }), { code: 'WRITE_FORBIDDEN' });
    assert.equal((await disabling).writeEnabled, false); assert.equal(await readWriter(context), null);
    assert.equal(store.active!.uncommitted, true, '关闭不丢弃已落 journal 的未提交编辑');
    await assert.rejects(validateRolloutApproval(approval.file, context), { code: 'ROLLOUT_APPROVAL_REVOKED' });
    assert.equal((await rollout.enableFromApproval(approval.file)).ok, false); assert.equal(await readWriter(context), null);
  } finally { await store.shutdown(); }
}));

test('私钥保护失败不写入密钥；损坏密钥错误不泄露内容', async () => withHostFixture(async ({ context, root }) => {
  await assert.rejects(ObservationAuthority.load(context, async () => false, true), { code: 'CONTROL_REQUIRED' });
  const privatePath = path.join(root, OBSERVATION_ROOT, 'authority.private.json');
  assert.equal(await readFile(privatePath, 'utf8'), '');
  await writeFile(privatePath, JSON.stringify({ format: 1, privatePem: 'PRIVATE KEY sensitive-test-marker', publicPem: 'invalid' }));
  await assert.rejects(ObservationAuthority.load(context, safeProtect), (error: any) => error.code === 'EVIDENCE_INVALID' && !error.message.includes('sensitive-test-marker'));
}));

test('关闭等待真实在途事务；撤销记录失败保持冻结及 Writer，不谎称释放', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context); await store.enableWriting(); await store.open({ path: 'a.pose.json' }); await store.pin(store.active!.version);
  let release!: () => void, entered!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const original = store.assertFresh.bind(store); let first = true;
  store.assertFresh = async doc => { if (first) { first = false; entered(); await hold; } return original(doc); };
  const patch = store.patch({ expectedRevision: store.active!.version, dryRun: false, ops: [{ op: 'setPoseTarget', path: 'pose/frame/targets/leftHand', role: 'leftHand', x: .02 }] });
  await ready; const disabling = store.disableWriting(); assert.ok(await readWriter(context)); release(); await patch; await disabling;
  assert.equal(store.active!.value.frame.targets.leftHand.x, .02); assert.equal(await readWriter(context), null);
  await store.enableWriting();
  await assert.rejects(store.disableWriting(async () => { throw Error('模拟审计磁盘失败'); }), /模拟审计磁盘失败/);
  assert.equal(store.frozen, true); assert.equal(store.writeMode, 'frozen'); assert.ok(await readWriter(context));
  // 只为清理本测试明确持有的租约，生产没有清冻结入口。
  store.frozen = false; await store.shutdown();
}));
