import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { checkEditorImport, EDITOR_IMPORT_CLI_ENV, EDITOR_IMPORT_REPORT_ROOT, FORBIDDEN_ADVISORY_FIELDS, type AdvisoryRunner } from '../src/editorImportAdvisory.js';

const runner = (over: Partial<{ exitCode: number | null; stdout: string; stderr: string; spawnError: string; timedOut: boolean }>): AdvisoryRunner => async () => ({
  exitCode: over.exitCode ?? 0, durationMs: 7, stdoutTail: over.stdout ?? '', stderrTail: over.stderr ?? '', ...(over.spawnError ? { spawnError: over.spawnError } : {}), ...(over.timedOut ? { timedOut: true } : {}),
});
let spawned = 0;
const counting: AdvisoryRunner = args => { spawned++; return runner({})(args); };
const previousEnv = process.env[EDITOR_IMPORT_CLI_ENV];

async function fixture(body: { skeleton?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spine-editor-adv-'));
  const context = { workspaceRoot: root, projectId: `advisory-${randomUUID()}` };
  // 刻意不调用 registerWorkspace：它会改写进程级 SPINE_MCP_WORKSPACE，
  // 泄漏到同进程其它测试文件（本次已因此造成 37 项连带失败）。本模块接收显式 context。
  const name = 'body.json';
  await writeFile(path.join(root, name), JSON.stringify(body.skeleton === false ? { observations: [1, 2] } : { skeleton: { spine: '4.1.24', name: 'hero' }, bones: [{ name: 'root' }] }) + '\n');
  return { root, context, name };
}
const reports = async (root: string) => (await readdir(path.join(root, EDITOR_IMPORT_REPORT_ROOT)).catch(() => [] as string[]));

test('§16 默认关闭：不 spawn、不探测，报告为 skipped 且不带任何审查字段', async () => {
  const { root, context, name } = await fixture(); spawned = 0;
  const result = await checkEditorImport({ filePath: name }, context, counting);
  assert.equal(result.verdict, 'skipped'); assert.equal(spawned, 0);
  assert.equal(result.nonAuthoritative, true);
  for (const field of FORBIDDEN_ADVISORY_FIELDS) assert.ok(!(field in result), `报告不应含 ${field}`);
  const files = await reports(root); assert.equal(files.length, 1);
  assert.ok(JSON.parse(await readFile(path.join(root, EDITOR_IMPORT_REPORT_ROOT, files[0]), 'utf8')).nonAuthoritative);
});

test('§16 未配置外部程序 → unavailable，不是失败，也不 spawn', async () => {
  const { root, context, name } = await fixture(); delete process.env[EDITOR_IMPORT_CLI_ENV]; spawned = 0;
  const result = await checkEditorImport({ filePath: name, enabled: true }, context, counting);
  assert.equal(result.verdict, 'unavailable'); assert.equal(spawned, 0);
  assert.equal(await reports(root).then(f => f.length), 1);
  if (previousEnv !== undefined) process.env[EDITOR_IMPORT_CLI_ENV] = previousEnv;
});

test('§16 五个 verdict：退出码 0 记 accepted；非零记 rejected；超时/启动失败记 indeterminate', async () => {
  // 用确实存在的文件作为「已配置路径」以通过存在性检查；runner 为注入实现，不会真正启动它。
  const { context, name } = await fixture(); process.env[EDITOR_IMPORT_CLI_ENV] = process.execPath;
  assert.equal((await checkEditorImport({ filePath: name, enabled: true }, context, runner({ exitCode: 0 }))).verdict, 'accepted');
  const rejected = await checkEditorImport({ filePath: name, enabled: true }, context, runner({ exitCode: 3, stderr: 'import failed' }));
  assert.equal(rejected.verdict, 'rejected'); assert.equal(rejected.evidence.exitCode, 3);
  assert.equal((await checkEditorImport({ filePath: name, enabled: true }, context, runner({ exitCode: null, timedOut: true }))).verdict, 'indeterminate');
  assert.equal((await checkEditorImport({ filePath: name, enabled: true }, context, runner({ spawnError: 'ENOEXEC' }))).verdict, 'indeterminate');
  if (previousEnv === undefined) delete process.env[EDITOR_IMPORT_CLI_ENV]; else process.env[EDITOR_IMPORT_CLI_ENV] = previousEnv;
});

test('§16 非 skeleton 结构与原文件不被改动：不产出结论，源文件哈希不变', async () => {
  const { root, context, name } = await fixture({ skeleton: false }); process.env[EDITOR_IMPORT_CLI_ENV] = process.execPath;
  const before = await readFile(path.join(root, name));
  const result = await checkEditorImport({ filePath: name, enabled: true }, context, counting);
  assert.equal(result.verdict, 'skipped');
  assert.deepEqual(await readFile(path.join(root, name)), before);
  if (previousEnv === undefined) delete process.env[EDITOR_IMPORT_CLI_ENV]; else process.env[EDITOR_IMPORT_CLI_ENV] = previousEnv;
  await rm(path.join(root, '.spine-mcp'), { recursive: true, force: true });
});
