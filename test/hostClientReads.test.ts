import test from 'node:test';
import assert from 'node:assert/strict';
import { HostClient } from '../src/hostClient.js';
import { HostError } from '../src/hostContracts.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const version = { sessionId: 'session', documentId: 'document', openEpoch: 'epoch', revision: 2 };
test('state 每次实际探测一次，复用本次响应仍识别下一次依赖漂移，不返回旧缓存', async () => withHostFixture(async ({ root, context }) => {
  const host = await startHostServer(context), client = new HostClient(context);
  try {
    await host.store.open({ path: 'a.pose.json' });
    let requests = 0;
    host.server.on('request', request => { if (request.method === 'GET' && request.url?.startsWith('/api/state')) requests++; });
    const first = await client.state({ autostart: false });
    assert.equal(requests, 1); assert.equal(first.targetStale, false); assert.ok(first.capabilities);
    const file = path.join(root, 'body.json'), bytes = await readFile(file);
    await writeFile(file, Buffer.concat([bytes, Buffer.from(' ')]));
    const second = await client.state({ autostart: false, includeCapabilities: false });
    assert.equal(requests, 2); assert.equal(second.targetStale, true); assert.equal(second.capabilities, undefined);
    assert.equal(first.targetStale, false, '调用者的旧响应保持独立');
  } finally { await host.stop(); }
}));
test('编辑响应的状态/图像必须同版本，读取失败不能返回混合版本', async () => {
  for (const failure of ['state-version', 'frame-version', 'frame-error']) {
    const client = new HostClient({});
    client.ensurePreview = async () => true;
    client.evaluate = async () => ({ ok: true });
    client.rpc = async route => route === '/api/patch' ? { version } : route === '/api/state'
      ? { version: failure === 'state-version' ? { ...version, revision: 3 } : version }
      : failure === 'frame-error' ? Promise.reject(new HostError('TARGET_STALE', '依赖已变化。'))
      : { version: failure === 'frame-version' ? { ...version, openEpoch: 'other' } : version, __imageData: 'png' };
    await assert.rejects(client.patch({ dryRun: false }), { code: failure === 'frame-error' ? 'TARGET_STALE' : 'REVISION_CONFLICT' });
  }
});

test('提交只读准备失败后等待其余读取结束，不发出授权或发布请求', async () => {
  const client = new HostClient({});
  client.ensurePreview = async () => true;
  let release!: () => void, candidateRejected!: () => void, settled = false;
  const snapshotWait = new Promise<void>(resolve => { release = resolve; });
  const rejected = new Promise<void>(resolve => { candidateRejected = resolve; });
  const calls: string[] = [];
  client.rpc = async (route, args) => {
    calls.push(route);
    if (route === '/api/commit' && args.dryRun === false) throw new HostError('COMMIT_NOT_AUTHORIZED', '尚未授权。');
    if (route === '/api/snapshot') { await snapshotWait; return { version }; }
    if (route === '/api/commit') { candidateRejected(); throw new HostError('TARGET_STALE', '依赖已变化。'); }
    throw Error('失败后不应授权或提交');
  };
  const pending = client.commit({ expectedRevision: version, requestId: 'prepare-failure', dryRun: false });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await rejected; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '仍有读取时不得提前结束调用');
  release();
  await assert.rejects(pending, { code: 'TARGET_STALE' });
  assert.equal(calls.includes('/api/authorize'), false);
  assert.equal(calls.filter(route => route === '/api/commit').length, 2, '只有初次幂等探测及只读候选，无后续发布');
});
