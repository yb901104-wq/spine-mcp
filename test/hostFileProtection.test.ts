import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { protectHostFile } from '../src/hostFileProtection.js';

// 2026-10-30 回归锁：Windows 分支曾按进程名调用 whoami/icacls，PATH 中若 POSIX 工具链
// 排在 System32 之前就会命中 GNU coreutils 的 whoami 并返回 false，导致受控通道整体不可用。
// 本用例要求保护实际生效（而不是被跳过），并对不存在的文件验证失败即关闭。
test('控制文件本地保护：实际生效；文件不存在时失败即关闭，不静默放行', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spine-protect-')), file = path.join(root, 'host-control.json');
  await writeFile(file, JSON.stringify({ control: 'credential-not-printed' }) + '\n');
  assert.equal(await protectHostFile(file), true, 'Windows 下须按 SystemRoot 定位 System32 原生工具并实际收紧 ACL；返回 false 会使受控通道整体拒绝。');
  await stat(file);
  assert.equal(await protectHostFile(path.join(root, 'missing.json')), false, '文件不存在必须返回 false，不能因异常被当作已保护。');
});
