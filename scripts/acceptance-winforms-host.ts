// 真实 .NET / WebView2 集成自检；只读 Host，合成角色，不产生视觉批准。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { strictHash } from '../src/hostContracts.js';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = path.join(process.argv[2] ?? 'D:/AI_cc/spine test/host-desktop-acceptance', runId);
await mkdir(artifactDir, { recursive: true });
const output = `docs/plans/host-winforms-${runId}.json`;
const report: any = { startedAt: new Date().toISOString(), artifactDir, scope: '实际 WinForms/WebView2、只读 Host、合成 region 夹具；不是真实美术动作或 MCP 审查截图验收。' };
async function availablePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
try {
  await withHostFixture(async ({ root, context }) => {
    const original = await readFile(path.join(root, 'body.json'));
    const host = await startHostServer(context);
    let preview: ReturnType<typeof spawn> | undefined, desktop: ReturnType<typeof spawn> | undefined;
    try {
      await host.store.open({ path: 'a.pose.json' });
      const originalVersion = structuredClone(host.store.active!.version);
      const discovery = JSON.parse(await readFile(path.join(root, '.spine-mcp/host-port.json'), 'utf8'));
      const cases: Record<string, any> = {
        'wrong-workspace': { workspaceRoot: path.dirname(root) }, 'unknown-api': { apiVersion: '999' },
        'wrong-session': { sessionId: 'incorrect' }, 'wrong-instance': { instanceId: 'incorrect' },
        'wrong-started-at': { startedAt: 'incorrect' }, 'wrong-project': { projectId: 'another-project' },
        'invalid-port': { port: 70000 }, 'invalid-token': { token: 'invalid' }, 'dead-pid': { pid: 2147483647 },
      };
      for (const [name, changes] of Object.entries(cases)) {
        const directory = path.join(root, 'negative-cases', name); await mkdir(path.join(directory, '.spine-mcp'), { recursive: true });
        await writeFile(path.join(directory, '.spine-mcp/host-port.json'), JSON.stringify({ ...discovery, workspaceRoot: directory, ...changes }));
      }
      const missing = path.join(root, 'negative-cases/missing'); await mkdir(missing, { recursive: true });
      const linked = path.join(root, 'negative-cases/linked'); await mkdir(linked, { recursive: true });
      await symlink(path.join(root, '.spine-mcp'), path.join(linked, '.spine-mcp'), process.platform === 'win32' ? 'junction' : 'dir');
      const port = await availablePort(), previewUrl = `http://127.0.0.1:${port}/`;
      preview = spawn(process.execPath, ['dist/previewServer.js'], { env: { ...process.env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_PREVIEW_HOST: '127.0.0.1', SPINE_PREVIEW_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
      let ready = false;
      for (let i = 0; i < 100; i++) { try { const config = await (await fetch(previewUrl + 'api/config')).json(); if (config.workspaceRoot === root) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.ok(ready, '实际旧预览服务未启动');
      const nativeReport = path.join(root, 'native-report.json'), image = path.join(root, 'native-host.png');
      desktop = spawn('dotnet', [path.resolve('apps/winforms-observer/bin/Debug/net9.0-windows/SpineMcp.WinFormsObserver.dll'), '--host-self-test', '--workspace', root, '--preview-url', previewUrl, '--report', nativeReport, '--screenshot', image], { stdio: 'ignore', windowsHide: true });
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { desktop?.kill(); reject(Error('WinForms 自检超时')); }, 90000);
        desktop!.once('exit', code => { clearTimeout(timer); resolve(code); }); desktop!.once('error', error => { clearTimeout(timer); reject(error); });
      });
      const result = JSON.parse(await readFile(nativeReport, 'utf8')); report.native = result;
      if (result.screenshot) { const target = path.join(artifactDir, 'host-workspace.png'); await copyFile(image, target); report.screenshot = target; }
      await copyFile(nativeReport, path.join(artifactDir, 'native-report.json'));
      assert.equal(exit, 0, JSON.stringify(result)); assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(strictHash(await readFile(path.join(root, 'body.json'))), strictHash(original));
      assert.equal(host.store.writeMode, 'observer');
      assert.deepEqual(host.store.active!.version, originalVersion);
      report.sourceUnchanged = true; report.documentVersionUnchanged = true; report.publicWriteEnabled = false; report.passed = true;
    } finally {
      if (desktop && desktop.exitCode === null) desktop.kill();
      if (preview && preview.exitCode === null) { preview.kill(); await new Promise<void>(resolve => preview!.once('exit', () => resolve())); }
      await host.stop();
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  });
} catch (error: any) { report.error = error.message; report.passed = false; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output, ...report })); }
