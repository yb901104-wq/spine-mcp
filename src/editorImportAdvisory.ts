import { readFile, writeFile, mkdir, mkdtemp, copyFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { strictHash } from './hostContracts.js';

/**
 * §16 编辑器兼容性 advisory 终验。
 *
 * 边界（与工单 §16.2/§16.5 一致，实现不得放宽）：
 * - 默认关闭；未显式开启 → skipped，不 spawn、不探测外部程序。
 * - 外部程序路径只从环境变量 SPINE_EDITOR_CLI 读取；未配置 → unavailable，不抛错。
 * - 只回答「当前字节能否被 Spine 编辑器导入打开」，不评价数值、参考关系、画面或动作。
 * - 结果恒带 nonAuthoritative:true；不得写入审查/准入/批准类字段，不得回流到任何门禁。
 * - 不写受管资产；唯一产物是本目录下的 diagnostics 报告。
 * - 不写入 host 文档状态（state.editorImport 仍为真实编辑器导入验收保留）。
 */
export const EDITOR_IMPORT_ADVISORY_SCHEMA = 'editor-import-advisory/1';
export const EDITOR_IMPORT_CLI_ENV = 'SPINE_EDITOR_CLI';
export const EDITOR_IMPORT_REPORT_ROOT = '.spine-mcp/diagnostics/editor-import-advisory';
const DEFAULT_TIMEOUT_MS = 60_000;
const TAIL_LIMIT = 500;

export type AdvisoryVerdict = 'skipped' | 'unavailable' | 'accepted' | 'rejected' | 'indeterminate';

export interface AdvisoryRunResult { exitCode: number | null; durationMs: number; stdoutTail: string; stderrTail: string; spawnError?: string; timedOut?: boolean; }
export type AdvisoryRunner = (request: { exe: string; args: string[]; timeoutMs: number }) => Promise<AdvisoryRunResult>;

/** 串行执行：外部商业许可证限制并发，且许可限制下的并发失败无法与文件问题区分。 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => undefined);
  return result;
}

const tail = (value: unknown) => String(value ?? '').slice(-TAIL_LIMIT);
const parseJson = (raw: string) => JSON.parse(raw.replace(/^\uFEFF/, ''));

function classify(run: AdvisoryRunResult): { verdict: AdvisoryVerdict; notes: string[] } {
  if (run.spawnError) return { verdict: 'indeterminate', notes: [`外部程序启动失败，不能据此判定文件好坏：${run.spawnError}`] };
  if (run.timedOut || run.exitCode === null) return { verdict: 'indeterminate', notes: [`外部程序未在 ${DEFAULT_TIMEOUT_MS}ms 内给出可判定退出码；超时不是文件结论。`] };
  if (run.exitCode === 0) return { verdict: 'accepted', notes: ['外部导入命令以退出码 0 结束；仅表示编辑器接受了当前字节，不代表数值、参考关系、视觉或动作已通过任何审查。'] };
  return { verdict: 'rejected', notes: [`外部导入命令退出码 ${run.exitCode}；详见报告 evidence.stderrTail，原因须另行核对，不得推断为某项现有门禁的结论。`] };
}

const defaultRunner: AdvisoryRunner = async ({ exe, args, timeoutMs }) => {
  const startedAt = Date.now();
  try {
    const run = promisify(execFile);
    const { stdout, stderr } = await run(exe, args, { timeout: timeoutMs, windowsHide: true });
    return { exitCode: 0, durationMs: Date.now() - startedAt, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
  } catch (error: any) {
    if (error?.killed === true || error?.signal === 'SIGTERM') return { exitCode: null, durationMs: Date.now() - startedAt, stdoutTail: tail(error.stdout), stderrTail: tail(error.stderr), timedOut: true };
    if (typeof error?.code === 'number') return { exitCode: error.code, durationMs: Date.now() - startedAt, stdoutTail: tail(error.stdout), stderrTail: tail(error.stderr) };
    return { exitCode: null, durationMs: Date.now() - startedAt, stdoutTail: tail(error?.stdout), stderrTail: tail(error?.stderr), spawnError: String(error?.message ?? error) };
  }
};

export interface EditorImportAdvisoryArgs { filePath: string; enabled?: boolean; timeoutMs?: number; writeReport?: boolean; }

export async function checkEditorImport(args: EditorImportAdvisoryArgs, context: ToolContext, runner: AdvisoryRunner = defaultRunner) {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const relativeFile = String(args.filePath ?? '');
  const absolute = resolveWorkspacePath(relativeFile, context as any);
  const bytes = await readFile(absolute);
  const fileHash = strictHash(bytes);
  const checkedAt = new Date().toISOString();
  const base = { advisorySchema: EDITOR_IMPORT_ADVISORY_SCHEMA, checkedAt, nonAuthoritative: true, scope: '仅回答 Spine 编辑器能否打开当前字节；不评价数值、参考关系、视觉或动作', subject: { filePath: relativeFile, fileHash } } as const;

  const finish = async (report: Record<string, any>) => {
    if (args.writeReport === false) return { ...report, reportPath: null as string | null };
    const reportPath = `${EDITOR_IMPORT_REPORT_ROOT}/${randomUUID()}.json`;
    const target = resolveWorkspacePath(reportPath, context as any);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + '\n');
    return { ...report, reportPath };
  };

  if (args.enabled !== true) return finish({ ...base, verdict: 'skipped' as const, cli: { configured: false }, evidence: null, notes: ['默认关闭：未显式传入 enabled:true，不执行也不探测外部程序。'] });

  let json: any;
  try { json = parseJson(bytes.toString('utf8')); }
  catch { return finish({ ...base, verdict: 'skipped' as const, cli: { configured: false }, evidence: null, notes: ['文件不是可解析的 JSON，本次 advisory 不产出编辑器兼容性结论。'] }); }
  if (!json || typeof json !== 'object' || !json.skeleton) return finish({ ...base, verdict: 'skipped' as const, cli: { configured: false }, evidence: null, notes: ['该文件不含 skeleton 结构；Spine 编辑器导入面向 skeleton JSON，本次不产出结论，也不把它记成拒绝。'] });

  const exe = process.env[EDITOR_IMPORT_CLI_ENV];
  if (!exe) return finish({ ...base, verdict: 'unavailable' as const, cli: { configured: false }, evidence: null, notes: [`未配置环境变量 ${EDITOR_IMPORT_CLI_ENV}；advisory 不可用，这不构成失败，也不影响任何既有门禁。`] });
  try { await stat(exe); } catch { return finish({ ...base, verdict: 'unavailable' as const, cli: { configured: true }, evidence: null, notes: [`环境变量已配置但该路径不可访问：${path.basename(exe)}；advisory 不可用，不计为失败。`] }); }

  const work = await mkdtemp(path.join(os.tmpdir(), 'spine-editor-advisory-'));
  try {
    const inputCopy = path.join(work, 'input.json'), outputProject = path.join(work, `probe-${randomUUID()}.spine`);
    await copyFile(absolute, inputCopy);
    const skeletonName = String(json.skeleton?.name ?? 'spine-import-probe');
    const argv = ['-i', inputCopy, '-o', outputProject, '-r', skeletonName];
    const run = await serialize(() => runner({ exe, args: argv, timeoutMs }));
    const { verdict, notes } = classify(run);
    return finish({
      ...base,
      verdict,
      cli: { configured: true, executable: path.basename(exe), version: null, edition: null },
      evidence: { argv: [path.basename(exe), '-i', '<workspace-copy>', '-o', '<temp-project>', '-r', skeletonName], exitCode: run.exitCode, durationMs: run.durationMs, stdoutTail: run.stdoutTail, stderrTail: run.stderrTail, ...(run.spawnError ? { spawnError: run.spawnError } : {}) },
      notes,
    });
  } finally { await rm(work, { recursive: true, force: true }); }
}

/** 供调用方核对：报告不得携带任何会被误读为审查结论的字段。 */
export const FORBIDDEN_ADVISORY_FIELDS = ['reviewToken', 'evidenceEligible', 'goldenPassed', 'readyToCommit', 'approved', 'numericOk', 'keyGraphs', 'exported'] as const;
