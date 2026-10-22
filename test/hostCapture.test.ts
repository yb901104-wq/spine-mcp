import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withHostFixture } from './helpers/hostFixture.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { HostCapture } from '../src/hostCapture.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
import { createMotionRuntime } from '../src/motionRuntime.js';
import { captureRuntimeState, assertCaptureReadback } from '../src/captureEvidence.js';
import { strictHash } from '../src/hostContracts.js';
import { validateHostGolden } from '../src/goldenValidation.js';

// 模拟页面回传仅验证协议与门禁，不能作为真实 player 或美术验收。
async function prepare(context: any) {
  const store = new HostEditorStore(context); await store.open({ path: 'a.pose.json' });
  const snapshot = await store.snapshot(store.active!.version), result = await evaluateHostSnapshot(snapshot, context);
  await store.publishDerived({ expectedRevision: snapshot.version, snapshotHash: snapshot.snapshotHash, dependencyFingerprint: snapshot.dependencyFingerprint, result });
  const capture = new HostCapture(store, 2000);
  capture.onRequest = task => { void (async () => {
    const b = await capture.bundle(task.id);
    const raw = (name: string) => Buffer.from(b.rawDataURIs[name].split(',')[1], 'base64');
    const rt = createMotionRuntime(JSON.parse(raw('pose.json').toString()), raw('atlas.atlas').toString());
    const c = b.camera, png = await store.frame({ expectedRevision: b.version, size: 320 });
    const reply: any = { captureId: b.id, visibilityState: 'visible', pngBase64: png.png.toString('base64'), viewport: b.viewport, dpr: 1, pma: b.pma,
      actual: captureRuntimeState(rt.sample(b.animation, b.time, b.skin ?? rt.data.skins[0]?.name)),
      resourceHashes: Object.fromEntries(Object.keys(b.rawDataURIs).map(k => [k, strictHash(raw(k))])),
      playerScriptHash: strictHash(await readFile('node_modules/@esotericsoftware/spine-player/dist/iife/spine-player.min.js')),
      actualCamera: { x: (c.minX+c.maxX)/2, y: (c.minY+c.maxY)/2, zoom: Math.max(c.maxX-c.minX,c.maxY-c.minY)/320, viewportWidth: 320, viewportHeight: 320 } };
    mutate(reply);
    await capture.complete(reply);
  })().catch(() => {}); };
  let mutate = (_reply: any) => {};
  return { store, capture, mutate: (fn: typeof mutate) => { mutate = fn; }, request: (extra = {}) => capture.request({ expectedRevision: store.active!.version, size: 320, ...extra }) };
}
function review(store: HostEditorStore, result: any, overrides = {}) {
  return store.registerReview({ expectedRevision: store.active!.version, snapshotHash: store.active!.snapshotHash, derivedHash: store.active!.derivedHash,
    reviewRecord: { decision: 'approved', record: { decision: 'approved', reason: '仅供协议测试' }, evidence: [{ source: 'player', filePath: result.filePath, hash: result.manifest.evidence[0].hash, manifestPath: result.manifestPath, ...overrides }] } });
}

test('截图分层：无黄金帧不伪报 parity，回归通过也须独立核验；旧字段不能升级、证据篡改拒收', async () => withHostFixture(async ({ context, root }) => {
  const h = await prepare(context);
  try {
    const result = await h.request();
    assert.equal((await validateHostGolden(root)).goldenPassed,'unverified');
    assert.equal(result.manifest.rendererParity.status, 'passed');assert.match(result.manifest.rendererParity.scope,/合成/);
    assert.equal(result.manifest.captureValidity.status, 'verified'); assert.equal(result.manifest.evidenceEligible, true); assert.equal(result.manifest.advisory, false);
    assert.ok(h.store.eventHistory(0).some(e => e.type === 'capture-done'));
    // 合成姿态的数值不通过：截图具备准入资格也不能批准失败姿态。
    await assert.rejects(review(h.store, result), /失败诊断不能批准/);
    await assert.rejects(review(h.store, result, { source: 'canvas', goldenPassed: true, evidenceEligible: true }), /官方 player/);
    const old = new HostEditorStore(context); await old.open({ path: 'a.pose.json' });
    await assert.rejects(review(old, result, { goldenPassed: true, evidenceEligible: true }), /当前 Host 登记/);
    await writeFile(path.join(root, result.manifestPath), JSON.stringify({ ...result.manifest, goldenPassed: true }));
    await assert.rejects(review(h.store, result), /manifest 已变化/);
  } finally { h.capture.close(); }
}));

test('截图分层反例：viewport/DPR 失配仅诊断；runtime/资源/相机/版本不能由 parity 替代', async () => withHostFixture(async ({ context }) => {
  const h = await prepare(context);
  try {
    const mismatch = await h.request({ viewport: { width: 480, height: 480 } });
    assert.equal(mismatch.manifest.evidenceEligible, false); assert.equal(mismatch.manifest.advisory, true);
    await assert.rejects(review(h.store, mismatch), /截图准入/);
    for (const change of [
      (r: any) => { r.actual.bones[0][1] += .1; },
      (r: any) => { delete r.resourceHashes['pose.json']; },
      (r: any) => { r.actualCamera.x += 1; },
      (r: any) => { r.playerScriptHash = 'unknown'; },
      (r: any) => { r.visibilityState = 'hidden'; },
    ]) { h.mutate(change); await assert.rejects(h.request(), /回读|字段|后台/); }
    h.mutate(() => {}); const before = await h.request();
    await h.store.open({ path: 'b.pose.json', expectedRevision: h.store.active!.version });
    await assert.rejects(review(h.store, before), /完整版本/);
    assert.throws(() => assertCaptureReadback(NaN, 0), /回读/); assert.throws(() => assertCaptureReadback(Infinity, 0), /回读/);
  } finally { h.capture.close(); }
}));
