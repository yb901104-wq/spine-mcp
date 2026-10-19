import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
const held = new AsyncLocalStorage<Set<string>>();
export async function withFileLock<T>(filePath: string, context: ToolContext, fn: () => Promise<T>): Promise<T> {
  const absolute = resolveWorkspacePath(filePath, context), key = absolute.toLowerCase();
  if (held.getStore()?.has(key)) return fn();
  const lockPath = resolveWorkspacePath(`.spine-mcp/locks/${createHash('sha256').update(key).digest('hex')}.lock`, context);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx'); } catch { throw new Error(`角色文件正在被其他任务修改：${filePath}。请稍后重试。`); }
  await lock.writeFile(JSON.stringify({ pid: process.pid, filePath, startedAt: new Date().toISOString() }));
  try { return await held.run(new Set([...(held.getStore() ?? []), key]), fn); }
  finally { await lock.close(); await unlink(lockPath); }
}
