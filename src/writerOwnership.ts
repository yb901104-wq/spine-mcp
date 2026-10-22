import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { HostError } from './hostContracts.js';
export interface WriterLease {
  ownerId: string; pid: number; processStartedAt: string; generation: number;
  mode: 'attached' | 'detached'; lockPath: string;
}
const scope = new AsyncLocalStorage<WriterLease>();
const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
export async function readWriter(context: ToolContext) {
  try { return JSON.parse(await readFile(resolveWorkspacePath('.spine-mcp/writer.lock', context), 'utf8')) as WriterLease; }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '写入锁无法验证，请核对原写入进程。', 409); }
}
export async function acquireWriter(context: ToolContext, mode: WriterLease['mode']): Promise<WriterLease> {
  const lockPath = resolveWorkspacePath('.spine-mcp/writer.lock', context);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '已有写入者或锁状态不明；不得因超时、TTL 或端口离线接管。', 409); }
  try {
    const generationPath = resolveWorkspacePath('.spine-mcp/writer-generation.json', context);
    let previous = 0;
    try {
      previous = JSON.parse(await readFile(generationPath, 'utf8')).generation;
      if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('代数损坏');
    } catch (error: any) { if (error.code !== 'ENOENT') throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '写入权 generation 损坏，禁止归零。', 409); }
    const lease: WriterLease = { ownerId: randomUUID(), pid: process.pid, processStartedAt: startedAt, generation: previous + 1, mode, lockPath };
    const temp = `${generationPath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ generation: lease.generation })); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, generationPath);
    } finally { await unlink(temp).catch(() => {}); }
    await lock.writeFile(JSON.stringify(lease)); await lock.sync();
    return lease;
  } catch (error) { await unlink(lockPath).catch(() => {}); throw error; }
  finally { await lock.close(); }
}
export async function verifyWriter(lease: WriterLease, context: ToolContext) {
  const current = await readWriter(context);
  if (!current || current.ownerId !== lease.ownerId || current.generation !== lease.generation || current.pid !== lease.pid || current.processStartedAt !== lease.processStartedAt) throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '写入权已失效，冻结写入。', 409);
}
export async function releaseWriter(lease: WriterLease, context: ToolContext) {
  await verifyWriter(lease, context);
  await unlink(lease.lockPath);
}
export const runWithWriter = <T>(lease: WriterLease, fn: () => T) => scope.run(lease, fn);
export async function withWorkspaceWrite<T>(context: ToolContext, fn: () => Promise<T>): Promise<T> {
  const held = scope.getStore();
  if (held) { await verifyWriter(held, context); return fn(); }
  const lease = await acquireWriter(context, 'detached');
  try { return await runWithWriter(lease, fn); }
  finally { await releaseWriter(lease, context); }
}
/** 仅在明确证明旧 PID 不存在时清理；活进程、权限不足、PID 复用不自动放行。 */
export async function recoverDeadWriter(context: ToolContext, expected: Pick<WriterLease, 'ownerId' | 'generation' | 'pid' | 'processStartedAt'>) {
  const current = await readWriter(context);
  if (!current || current.ownerId !== expected.ownerId || current.generation !== expected.generation || current.pid !== expected.pid || current.processStartedAt !== expected.processStartedAt) throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '残留锁与预期不符。', 409);
  try { process.kill(current.pid, 0); }
  catch (error: any) {
    if (error.code === 'ESRCH') {
      await verifyWriter(current, context); await unlink(current.lockPath);
      return { recovered: true, previous: current, message: '已确认原 PID 不存在；下一写入者仍须排他申请新的 generation。' };
    }
  }
  throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '原 PID 仍存在或无法确认，保持冻结。', 409);
}
