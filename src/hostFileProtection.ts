import { chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 与既有 Host 控制文件相同的本地保护，不输出凭据内容。 */
export async function protectHostFile(file: string) {
  try {
    if (process.platform === 'win32') {
      const run = promisify(execFile), who = await run('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
      const sid = who.stdout.match(/S-1-[0-9-]+/)?.[0]; if (!sid) return false;
      await run('icacls', [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true });
    } else await chmod(file, 0o600);
    return true;
  } catch { return false; }
}
