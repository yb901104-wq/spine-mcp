// 实际 MCP SDK stdio：不带 token 静默、带 token 的进度和取消后的真实停止/锁释放。
// 使用合成渲染夹具；不产生角色批准或更改原角色。
import assert from 'node:assert/strict';
import { readFile, readdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { withFileLock } from '../src/jobTools.js';
import { strictHash } from '../src/hostContracts.js';

const report: any = { startedAt: new Date().toISOString(), scope: '实际 MCP SDK stdio 与合成 region 渲染；不是实际参考修正、美术批准或编辑器导入验收。' };
async function waitFor<T>(run: () => Promise<T | false>, timeout = 10000): Promise<T> {
  const start = performance.now();
  while (performance.now() - start < timeout) { const value = await run(); if (value !== false) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('等待真实任务状态超时。');
}
const output = `docs/plans/task-protocol-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
try {
  await withHostFixture(async ({ root, context }) => {
    const sourceHash = strictHash(await readFile(path.join(root, 'body.json')));
    const client = new Client({ name: 'task-protocol-acceptance', version: '1' }, { capabilities: {} });
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: { ...env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_HOST_AUTOSTART: '0' } });
    const notifications: any[] = [];
    const args = { projectId: context.projectId, filePath: 'body.json', atlasPath: 'body.atlas', animation: 'original' };
    const request = (more: any) => ({ name: 'spine_render_animation_frames', arguments: { ...args, ...more } });
    try {
      await client.connect(transport);
      report.pid = transport.pid;
      const onmessage = transport.onmessage;
      transport.onmessage = message => {
        if ('method' in message && message.method === 'notifications/progress') notifications.push((message as any).params);
        onmessage?.(message);
      };
      const silent = await client.callTool(request({ frames: 3, width: 320, height: 320, outputDir: 'output/silent' }));
      assert.ok(!silent.isError, JSON.stringify(silent));
      assert.equal(notifications.length, 0);
      report.noTokenNotifications = 0;
      const progress: any[] = [], started = performance.now();
      const complete = await client.callTool(request({ frames: 120, width: 480, height: 480, outputDir: 'output/complete' }), undefined, {
        timeout: 60000, onprogress: value => progress.push({ ...value, elapsedMs: performance.now() - started }),
      });
      assert.ok(!complete.isError, JSON.stringify(complete));
      assert.ok(progress.length >= 2);
      assert.equal(progress.at(-1).progress, progress.at(-1).total);
      assert.ok(progress.every((n, i) => i === 0 || n.progress > progress[i - 1].progress));
      report.completed = { elapsedMs: performance.now() - started, progress, count: progress.length, frameCount: JSON.parse((complete.content as any[])[0].text).frames.length };

      const controller = new AbortController(), cancelling = client.callTool(request({ frames: 239, width: 480, height: 480, outputDir: 'output/cancelled' }), undefined, { signal: controller.signal, timeout: 60000, onprogress: () => {} }).then(value => ({ value }), error => ({ error: String(error) }));
      const statusPath = path.join(root, 'output/cancelled/status.json');
      const status: any = await waitFor(async () => {
        try {
          const state = JSON.parse(await readFile(statusPath, 'utf8'));
          if (state.status !== 'rendering') return false;
          await access(path.join(root, 'previews/cache', state.input.cacheKey, 'frame-0002.png'));
          return state;
        } catch { return false; }
      });
      const requestedAt = performance.now(); controller.abort();
      const clientOutcome = await cancelling;
      assert.ok('error' in clientOutcome, '客户端应实际收到取消而不是成功');
      const stopped: any = await waitFor(async () => {
        const state = JSON.parse(await readFile(statusPath, 'utf8'));
        return state.status === 'failed' && /取消/.test(state.error) ? state : false;
      });
      const statusLatencyMs = performance.now() - requestedAt;
      const cacheDir = path.join(root, 'previews/cache', status.input.cacheKey);
      await waitFor(async () => { try { await access(path.join(cacheDir, 'render.lock')); return false; } catch (error: any) { if (error.code !== 'ENOENT') throw error; return true; } });
      await waitFor(async () => { try { await withFileLock('output/cancelled/status.json', context, async () => true); return true; } catch (error: any) { if (!/其他任务/.test(error.message)) throw error; return false; } });
      const locksReleasedAfterMs = performance.now() - requestedAt;
      const before = (await readdir(cacheDir)).filter(f => /^frame-/.test(f)).sort();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual((await readdir(cacheDir)).filter(f => /^frame-/.test(f)).sort(), before);
      assert.ok(before.length < 239 && before.length >= 3);
      await assert.rejects(access(path.join(cacheDir, 'preview-manifest.json')), (error: any) => error.code === 'ENOENT');
      await client.ping();
      const followup = await client.callTool({ name: 'spine_get_pose_state', arguments: { projectId: context.projectId, posePath: 'a.pose.json' } });
      assert.ok(!followup.isError, JSON.stringify(followup));
      assert.equal(JSON.parse((followup.content as any[])[0].text).solveCount, 0);
      assert.equal(strictHash(await readFile(path.join(root, 'body.json'))), sourceHash);
      report.cancelled = { clientOutcome, statusLatencyMs, locksReleasedAfterMs, renderedFrames: before.length, failedStatus: stopped.status, partialCachePublished: false, noFramesAfterStop: true, serverStillResponds: true, sourceUnchanged: true };
      report.passed = statusLatencyMs < 300 && locksReleasedAfterMs < 300;
    } finally { await client.close(); }
  });
} catch (error: any) { report.error = error.message; report.passed = false; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output, ...report, completed: report.completed ? { ...report.completed, progress: undefined } : undefined })); }
