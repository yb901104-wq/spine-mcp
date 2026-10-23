// 真实 .NET / WebView2 集成自检；默认合成夹具，--real-c1 使用已验收站姿的隔离副本。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { strictHash } from '../src/hostContracts.js';
import { HostClient } from '../src/hostClient.js';
import { registerWorkspace } from '../src/workspaceTools.js';
import { createProject } from '../src/projectModel.js';
import { requireReviewedPose } from '../src/poseWorkflow.js';
import { resolveWorkspacePath } from '../src/spineJson.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const real = process.argv.includes('--real-c1');
const benchmark = process.argv.includes('--benchmark-host');
const artifactDir = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'D:/AI_cc/spine test/host-desktop-acceptance', runId);
await mkdir(artifactDir, { recursive: true });
const output = `docs/plans/host-winforms-${runId}.json`;
const report: any = { startedAt: new Date().toISOString(), artifactDir, scope: real ? '实际 WinForms/WebView2、只读 Host、已验收 npc1 无参考站姿隔离副本；通过 MCP 采集当前 player，未新增动作批准或编辑器导入。' : '实际 WinForms/WebView2、只读 Host、合成 region 夹具；不是真实美术动作或 MCP 审查截图验收。' };
const posePath = real ? 'poses/standing-hand-angle.json' : 'a.pose.json';
async function withRealFixture(fn: (fixture: { root: string; context: { workspaceRoot: string; projectId: string } }) => Promise<void>) {
  const source = path.resolve('D:/AI_cc/spine test/host-acceptance/2026-10-22T02-18-08-219Z');
  const root = path.join(artifactDir, 'workspace'), context = { workspaceRoot: root, projectId: 'npc1-host-c1-acceptance' };
  await mkdir(root, { recursive: true });
  const hashes: Record<string, string> = {};
  async function copyInputs(directory: string) {
    for (const entry of await readdir(resolveWorkspacePath(directory, { workspaceRoot: source }), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `输入不得经过链接：${relative}`);
      const from = resolveWorkspacePath(relative, { workspaceRoot: source }), to = resolveWorkspacePath(relative, context);
      if (entry.isDirectory()) { await mkdir(to, { recursive: true }); await copyInputs(relative); }
      else if (entry.isFile()) { await mkdir(path.dirname(to), { recursive: true }); await copyFile(from, to); hashes[relative] = strictHash(await readFile(from)); }
    }
  }
  for (const directory of ['目标', 'poses', 'previews', 'output']) await copyInputs(directory);
  process.env.SPINE_MCP_WORKSPACE = root; process.env.SPINE_MCP_REGISTRY_ROOT = root;
  await registerWorkspace({ rootPath: root, projectId: context.projectId });
  const manifest = JSON.parse(await readFile(path.join(source, '.spine-workflow.json'), 'utf8'));
  manifest.documents.push({ path: posePath, kind: 'pose', characterId: 'npc1' });
  await createProject({ manifest, expectedAbsent: true, dryRun: false }, context);
  await requireReviewedPose(posePath, context);
  report.sourceWorkspace = source; report.inputHashes = hashes;
  await fn({ root, context });
  for (const [relative, hash] of Object.entries(hashes)) {
    assert.equal(strictHash(await readFile(resolveWorkspacePath(relative, { workspaceRoot: source }))), hash, `原输入变化：${relative}`);
    assert.equal(strictHash(await readFile(resolveWorkspacePath(relative, context))), hash, `副本变化：${relative}`);
  }
  await requireReviewedPose(posePath, context);
  report.allInputsUnchanged = true; report.savedPoseReverified = true;
}
async function availablePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
try {
  await (real ? withRealFixture : withHostFixture)(async ({ root, context }) => {
    const sourcePath = path.join(root, real ? '目标/npc1.json' : 'body.json');
    const original = await readFile(sourcePath);
    const host = await startHostServer(context, { captureTimeoutMs: 12000 });
    let frameRequests = 0;
    host.server.on('request', request => { if (new URL(request.url!, host.endpoint).pathname === '/api/frame') frameRequests++; });
    let mcp: Client | undefined;
    let preview: ReturnType<typeof spawn> | undefined, desktop: ReturnType<typeof spawn> | undefined;
    try {
      await host.store.open({ path: posePath });
      if (real) {
        // 观察模式显式发布快照求解结果，不取得写入权、不改姿态文件。
        const evaluator = new HostClient(context); await evaluator.state(); await evaluator.evaluate(host.store.active!.version);
        assert.equal(host.store.active!.derived?.numeric.ok, true);
        mcp = new Client({ name: 'real-desktop-capture', version: '1' }, { capabilities: {} });
        const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
        await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: { ...env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_HOST_AUTOSTART: '0', SPINE_HOST_ENDPOINT: host.endpoint, SPINE_HOST_TOKEN: host.token } }));
      }
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
      desktop = spawn('dotnet', [path.resolve('apps/winforms-observer/bin/Debug/net9.0-windows/SpineMcp.WinFormsObserver.dll'), '--host-self-test', ...real ? ['--capture-checkpoints'] : [], ...benchmark ? ['--benchmark-host'] : [], '--workspace', root, '--preview-url', previewUrl, '--report', nativeReport, '--screenshot', image], { stdio: 'ignore', windowsHide: true });
      const exited = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { desktop?.kill(); reject(Error('WinForms 自检超时')); }, benchmark ? 240000 : 90000);
        desktop!.once('exit', code => { clearTimeout(timer); resolve(code); }); desktop!.once('error', error => { clearTimeout(timer); reject(error); });
      });
      if (real) {
        // 若桌面提前失败，不把检查点轮询留成孤立任务。
        const captures = async () => {
          report.captures = {};
          for (const stage of ['initial', 'restored']) {
            const marker = nativeReport + '.' + stage;
            const until = Date.now() + (benchmark ? 120000 : 40000);
            for (;;) {
              try { assert.equal(await readFile(marker + '.ready', 'utf8'), stage); break; }
              catch (error: any) { if (error.code !== 'ENOENT') throw error; }
              if (Date.now() > until || desktop!.exitCode !== null) throw Error(`桌面未到达截图检查点 ${stage}`);
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            const captureSamples: any[] = [];
            const frameRequestsBeforeCaptures = frameRequests;
            const captureCount = benchmark && stage === 'initial' ? 32 : 1;
            for (let index = 0; index < captureCount; index++) {
            const started = performance.now();
            const response = await mcp!.callTool({ name: 'spine_preview_capture', arguments: { projectId: context.projectId, expectedRevision: originalVersion, size: 960 } });
            const durationMs = performance.now() - started;
            assert.ok(!response.isError, JSON.stringify(response));
            const result = JSON.parse((response.content as any[]).filter(item => item.type === 'text').map(item => item.text).join('\n'));
            assert.equal(result.manifest.captureValidity.status, 'verified');
            assert.equal(result.manifest.evidenceEligible, true);
            assert.deepEqual(result.manifest.version, originalVersion);
            assert.equal(result.manifest.source, 'player');
            const png = await readFile(resolveWorkspacePath(result.filePath, context));
            assert.equal(strictHash(png), result.manifest.evidence[0].hash);
            report.captures[stage] = { filePath: result.filePath, manifestPath: result.manifestPath, manifest: result.manifest };
            if (captureCount > 1 && index >= 2) captureSamples.push({ durationMs, filePath: result.filePath, manifestPath: result.manifestPath, pngHash: strictHash(png) });
            }
            if (captureCount > 1) {
              await new Promise(resolve => setTimeout(resolve, 200));
              assert.equal(frameRequests, frameRequestsBeforeCaptures, '同版本的 capture 状态事件不应重复获取 frame');
              const values = captureSamples.map(sample => sample.durationMs).sort((a, b) => a - b);
              report.capturePerformance = { scope: '真实 npc1 已验收站姿隔离副本；实际 MCP stdio 到当前 WebView2 官方 player 截图，含独立核验、文件发布和 MCP image 回传；960 像素，不新增视觉批准。',
                warmups: 2, sampleCount: captureSamples.length, size: 960, samples: captureSamples, redundantFrameRequests: frameRequests - frameRequestsBeforeCaptures, p50: values[14], p95: values[28], maximum: values.at(-1), budgetMs: 1500, budgetPassed: values[28] < 1500 };
            }
            await writeFile(marker + '.release', stage, { flag: 'wx' });
          }
          // libvips 的 Windows 文件名接口不支持本项目的长证据路径；由 Node 严格读取字节。
          const first = await sharp(await readFile(resolveWorkspacePath(report.captures.initial.filePath, context))).ensureAlpha().raw().toBuffer();
          const second = await sharp(await readFile(resolveWorkspacePath(report.captures.restored.filePath, context))).ensureAlpha().raw().toBuffer();
          assert.deepEqual(first, second, '重连前后相同姿态、相机的 player 像素变化');
          report.reconnectPixelsIdentical = true;
        };
        const pendingCaptures = captures();
        // 同时挂接拒绝处理，避免原生启动失败时出现未处理的 Promise。
        await Promise.all([pendingCaptures, exited]);
      }
      const exit = await exited;
      const result = JSON.parse(await readFile(nativeReport, 'utf8')); report.native = result;
      if (result.screenshot) { const target = path.join(artifactDir, 'host-workspace.png'); await copyFile(image, target); report.screenshot = target; }
      await copyFile(nativeReport, path.join(artifactDir, 'native-report.json'));
      assert.equal(exit, 0, JSON.stringify(result)); assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(strictHash(await readFile(sourcePath)), strictHash(original));
      assert.equal(host.store.writeMode, 'observer');
      assert.deepEqual(host.store.active!.version, originalVersion);
      report.sourceUnchanged = true; report.documentVersionUnchanged = true; report.publicWriteEnabled = false; report.passed = true;
    } finally {
      await mcp?.close();
      if (desktop && desktop.exitCode === null) desktop.kill();
      if (preview && preview.exitCode === null) { preview.kill(); await new Promise<void>(resolve => preview!.once('exit', () => resolve())); }
      await host.stop();
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  });
} catch (error: any) { report.error = error.message; report.passed = false; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output, passed: report.passed, checks: report.native?.checks?.length, screenshot: report.screenshot, error: report.error })); }
