import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
const held = new AsyncLocalStorage<Set<string>>();
async function describeLockHolder(lockPath: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(lockPath, 'utf8'));
    return `锁记录：pid=${raw.pid}，filePath=${raw.filePath}，startedAt=${raw.startedAt}。确认该进程已不存在后，可人工删除 ${lockPath} 再重试。`;
  } catch { return `未能读取锁记录，请人工核对 ${lockPath} 后再重试。`; }
}
export async function withFileLock<T>(filePath: string, context: ToolContext, fn: () => Promise<T>): Promise<T> {
  const absolute = resolveWorkspacePath(filePath, context), key = absolute.toLowerCase();
  if (held.getStore()?.has(key)) return fn();
  const lockPath = resolveWorkspacePath(`.spine-mcp/locks/${createHash('sha256').update(key).digest('hex')}.lock`, context);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx'); } catch { throw new Error(`角色文件正在被其他任务修改：${filePath}。${await describeLockHolder(lockPath)}`); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, filePath, startedAt: new Date().toISOString() }));
    return await held.run(new Set([...(held.getStore() ?? []), key]), fn);
  }
  finally {
    // 清理失败不能覆盖业务结果，也不能让锁残留后永久拦住后续任务；残留锁按记录中的 pid 人工核对后再删除。
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
