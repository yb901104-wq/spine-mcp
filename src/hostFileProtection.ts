import { chmod, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * 与既有 Host 控制文件相同的本地保护，不输出凭据内容。
 *
 * 2026-10-30 修复：Windows 分支原先按进程名调用 `whoami` / `icacls`，实际解析结果取决于
 * PATH 顺序；当 POSIX 工具链（Git Bash / MSYS usr/bin）排在 System32 之前时，会命中
 * GNU coreutils 的 `whoami`（不接受 `/user`），命令非零退出，本函数返回 false，
 * 导致受控通道整体判为未保护并拒绝全部受控端点（controlProtected:false）。
 * 改为按 SystemRoot 定位 System32 原生可执行文件，不再依赖 PATH 解析顺序。
 * 安全语义不变：仍要求 icacls 实际执行成功才算启用保护，任一环节失败依旧失败即关闭。
 */
function system(name: string): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return `${root}\\System32\\${name}.exe`;
}

export async function protectHostFile(file: string) {
  try {
    if (process.platform === 'win32') {
      const run = promisify(execFile), whoami = system('whoami'), icacls = system('icacls');
      await access(whoami); await access(icacls);
      const who = await run(whoami, ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
      const sid = who.stdout.match(/S-1-[0-9-]+/)?.[0]; if (!sid) return false;
      await run(icacls, [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true });
    } else await chmod(file, 0o600);
    return true;
  } catch { return false; }
}
