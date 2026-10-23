// 真实 npc1 已保存站姿的短时只读现场审计；不启动长期自动化、不累计或伪造两周观察结论。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerWorkspace } from '../src/workspaceTools.js';
import { createProject } from '../src/projectModel.js';
import { startHostServer } from '../src/hostServer.js';
import { resolveWorkspacePath } from '../src/spineJson.js';
import { strictHash, objectHash } from '../src/hostContracts.js';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const sourceReportPath = 'docs/plans/host-real-c1-20261022.json';
const previous = JSON.parse(await readFile(sourceReportPath, 'utf8'));
const source = previous.workspace, posePath = previous.saved.outputPath;
const root = path.resolve('D:/AI_cc/spine test/host-observation', runId);
const context = { workspaceRoot: root, projectId: 'npc1-host-b-observation' };
const reportPath = `docs/plans/host-observation-${runId}.json`;
const report: any = { startedAt: new Date().toISOString(), workspace: root, sourceWorkspace: source,
  sourceReportPath, posePath, scope: '真实 npc1 无参考站姿的短时只读 MCP/HTTP 观察；不执行编辑、求解、截图批准或写入权交接。',
  window: 'single-session', twoWeekWindowSatisfied: false, rolloutEligible: false, inputHashes: {}, samples: [], toolsInvoked: [],
  supersedes: { filePath: 'docs/plans/host-observation-2026-10-23T06-45-59-361Z.json',
    reason: '首轮错误读取不存在的缓存求解计数器，差值序列化为 null；不采用该计数或该报告作最终观察证据，原始记录保留。' } };
const client = new Client({ name: 'host-observation-audit', version: '1' }, { capabilities: {} });
let host: Awaited<ReturnType<typeof startHostServer>> | undefined;
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; });
process.once('SIGTERM', () => { interrupted = true; });
async function tool(name: string, args: any = {}) {
  assert.ok(['spine_preview_state', 'spine_host_open'].includes(name), '本审计只允许显式打开与只读状态入口');
  report.toolsInvoked.push(name);
  const response = await client.callTool({ name, arguments: { projectId: context.projectId, ...args } });
  const result = JSON.parse((response.content as any[]).filter(item => item.type === 'text').map(item => item.text).join('\n'));
  assert.ok(!response.isError, JSON.stringify(result)); return result;
}
const compact = (operations: any[]) => operations.map(({ observedAt, ...item }) => item);
try {
  await mkdir(root, { recursive: true });
  const pose = JSON.parse(await readFile(resolveWorkspacePath(posePath, { workspaceRoot: source }), 'utf8'));
  const files = new Set<string>([...Object.keys(previous.inputHashes), posePath, ...pose.review.evidence.map((item: any) => item.filePath)]);
  for (const file of files) {
    const from = resolveWorkspacePath(file, { workspaceRoot: source }), to = resolveWorkspacePath(file, context);
    const raw = await readFile(from);
    const expected = file === posePath ? previous.saved.hashAfter : previous.inputHashes[file];
    if (expected) assert.equal(strictHash(raw), expected, `既有验收输入已变化：${file}`);
    await mkdir(path.dirname(to), { recursive: true }); await copyFile(from, to);
    report.inputHashes[file] = strictHash(raw);
    assert.equal(strictHash(await readFile(to)), report.inputHashes[file]);
  }
  process.env.SPINE_MCP_WORKSPACE = root; process.env.SPINE_MCP_REGISTRY_ROOT = root;
  await registerWorkspace({ rootPath: root, projectId: context.projectId });
  const manifest = JSON.parse(await readFile(path.join(source, '.spine-workflow.json'), 'utf8'));
  manifest.projectId = context.projectId;
  manifest.name = 'NPC1 短时只读 Host 观察';
  manifest.documents.push({ path: posePath, kind: 'pose', characterId: 'npc1' });
  await createProject({ manifest, expectedAbsent: true, dryRun: false }, context);
  const manifestHash = strictHash(await readFile(path.join(root, '.spine-workflow.json')));
  host = await startHostServer(context);
  const headers = { 'X-Spine-Host-Token': host.token };
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: {
    ...env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_HOST_AUTOSTART: '0', SPINE_HOST_ENDPOINT: host.endpoint, SPINE_HOST_TOKEN: host.token,
  } }));
  const initial = await tool('spine_preview_state');
  assert.equal(initial.activeDoc, null);
  assert.equal(initial.capabilities.operations.find((op: any) => op.operation === 'inspect').reasons[0].code, 'DOC_NOT_LOADED');
  await tool('spine_host_open', { manifestPath: '.spine-workflow.json' });
  const projectOnly = await tool('spine_preview_state');
  assert.equal(projectOnly.project.mode, 'managed'); assert.equal(projectOnly.activeDoc, null);
  await tool('spine_host_open', { path: posePath });
  const baseline = await tool('spine_preview_state');
  assert.equal(baseline.writeMode, 'observer'); assert.equal(baseline.targetStale, false);
  assert.ok(baseline.derivedHash, '既有可信持久结果未能回放；本审计不隐式求解');
  const protectedFiles = new Map([[posePath, host.store.active!.fileHash], ...host.store.active!.dependencies.map(dep => [dep.filePath, dep.hash] as [string, string])]);
  let firstFrameHash: string | undefined;
  const started = performance.now();
  for (let index = 0; index < 30; index++) {
    if (interrupted) throw Error('观察已取消；本报告不作完成证据。');
    let inputsUnchanged = true;
    for (const [file, hash] of protectedFiles) if (strictHash(await readFile(resolveWorkspacePath(file, context))) !== hash) inputsUnchanged = false;
    const state = await tool('spine_preview_state');
    const response = await fetch(host.endpoint + '/api/capabilities', { headers });
    assert.equal(response.status, 200);
    const capabilities = await response.json() as any;
    assert.deepEqual(compact(state.capabilities.operations), compact(capabilities.operations));
    assert.equal(state.writeMode, 'observer'); assert.equal(state.pinned, false);
    assert.deepEqual(state.version, baseline.version);
    for (const key of ['fileHash', 'contentHash', 'snapshotHash', 'dependencyFingerprint', 'derivedHash', 'undoDepth', 'redoDepth', 'uncommitted']) assert.equal(state[key], baseline[key], key);
    const sample: any = { index, observedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
      inputsUnchanged, targetStale: state.targetStale, falsePositive: inputsUnchanged && state.targetStale,
      version: state.version, capabilitiesMatch: true, readiness: compact(state.capabilities.operations) };
    report.samples.push(sample);
    assert.equal(inputsUnchanged, true); assert.equal(state.targetStale, false);
    assert.ok(state.capabilities.operations.every((op: any) => op.checked === 'strict'));
    if (index % 5 === 0) {
      const query = new URLSearchParams({ ...state.version, revision: String(state.version.revision), size: '480' });
      const frame = await fetch(host.endpoint + '/api/frame?' + query, { headers });
      assert.equal(frame.status, 200);
      assert.equal(frame.headers.get('x-open-epoch'), state.version.openEpoch);
      assert.equal(frame.headers.get('x-derived-hash'), state.derivedHash);
      sample.frameHash = strictHash(Buffer.from(await frame.arrayBuffer()));
      firstFrameHash ??= sample.frameHash; assert.equal(sample.frameHash, firstFrameHash);
    }
    if (index < 29) await new Promise(resolve => setTimeout(resolve, 250));
  }
  report.observedDurationMs = performance.now() - started;
  report.falsePositiveCount = report.samples.filter((sample: any) => sample.falsePositive).length;
  report.solveAudit = { method: '入口调用记录与只读 HTTP 路由核对', solverCounterAvailable: false,
    calledSolveOrEvaluateTool: report.toolsInvoked.some((name: string) => /solve|recheck|patch/.test(name)),
    httpRoutes: ['/api/capabilities', '/api/frame'], note: '没有调用求解入口；未添加底层求解计数器，不把缺失计数写为零。' };
  assert.equal(report.solveAudit.calledSolveOrEvaluateTool, false);
  for (const [file, hash] of Object.entries(report.inputHashes)) {
    assert.equal(strictHash(await readFile(resolveWorkspacePath(file, { workspaceRoot: source }))), hash);
    assert.equal(strictHash(await readFile(resolveWorkspacePath(file, context))), hash);
  }
  assert.equal(strictHash(await readFile(path.join(root, '.spine-workflow.json'))), manifestHash);
  report.sourceUnchanged = true; report.manifestUnchanged = true; report.writeEnabled = false; report.passed = true;
} catch (error: any) { report.error = error.message; report.passed = false; process.exitCode = 1; }
finally {
  await client.close().catch(() => {});
  try { await host?.stop(); report.hostStopped = !!host; }
  catch (error: any) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ reportPath, passed: report.passed, samples: report.samples.length, observedDurationMs: report.observedDurationMs,
    falsePositiveCount: report.falsePositiveCount, twoWeekWindowSatisfied: false, error: report.error }));
}
