import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withPreviewValidationFixture } from './helpers/previewValidationFixture.js';

test('实际预览 HTTP 与 MCP 领域语义一致：显式文件不继承演示动画，明确错误仍拒绝', async () => {
  await withPreviewValidationFixture(async (context, args) => {
  const root = context.workspaceRoot;
  const before = await readFile(path.join(root, args.filePath), 'utf8');
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as any).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.execPath, ['dist/previewServer.js'], { env: { ...process.env,
    SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_PREVIEW_HOST: '127.0.0.1', SPINE_PREVIEW_PORT: String(port),
  }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('预览服务启动超时')), 5000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`预览服务退出 ${code}`)); });
    });
    const query = new URLSearchParams({ file: args.filePath, atlas: args.atlasPath });
    for (const route of ['check-assets', 'runtime-validate', 'validation-pipeline']) {
      const url = `http://127.0.0.1:${port}/api/${route}?${query}`;
      const response = await fetch(url), result = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.animation, null);
      assert.equal(result.ok, true);
      if (route === 'validation-pipeline') {
        assert.equal(result.visualPreview, null);
        assert.equal(new URL(result.previewUrl.url).searchParams.has('animation'), false);
      }
      for (const animation of ['missing-animation', '']) {
        const missing = await fetch(url + '&animation=' + encodeURIComponent(animation));
        assert.equal(missing.status, 400);
        assert.equal((await missing.json() as any).ok, false);
      }
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/runtime-validate?${query}&skin=missing-skin`)).status, 400);
    assert.equal(await readFile(path.join(root, args.filePath), 'utf8'), before);
  } finally {
    child.kill();
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
  }
  }, {});
});
