import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withHostFixture } from './helpers/hostFixture.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { handTargetCapabilities, hostOperationReadiness } from '../src/hostReadiness.js';

const operation = (state: any, name: string) => state.capabilities.operations.find((item: any) => item.operation === name);

test('readiness：未打开/仅工程/观察/未 pin 分别给出真实原因，查询不求解或批准', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context);
  try {
    let state = await store.state();
    assert.equal(operation(state, 'open').canRun, true);
    assert.equal(operation(state, 'inspect').canRun, false);
    assert.equal(operation(state, 'inspect').reasons[0].code, 'DOC_NOT_LOADED');
    await assert.rejects(store.inspect('bones'), { code: 'DOC_NOT_LOADED' });
    await store.open({ manifestPath: '.spine-workflow.json' });
    state = await store.state();
    assert.equal(state.activeDoc, null);
    assert.equal(operation(state, 'evaluate').state, 'blocked');
    await store.open({ path: 'a.pose.json' });
    state = await store.state();
    assert.equal(operation(state, 'inspect').canRun, true);
    assert.equal(operation(state, 'patch').reasons[0].code, 'WRITE_FORBIDDEN');
    assert.equal(operation(state, 'inspect').checked, 'strict');
    assert.equal(state.agentVisual.status, 'notRun');
    await store.enableWriting();
    state = await store.state();
    assert.equal(operation(state, 'patch').reasons[0].code, 'TARGET_NOT_PINNED');
    assert.equal(operation(state, 'patch').nextAction.tool, 'spine_host_pin');
    await store.pin(store.active!.version);
    state = await store.state();
    assert.equal(operation(state, 'patch').canRun, true);
    assert.equal(operation(state, 'commit').canRun, false);
    assert.equal(operation(state, 'undo').canRun, true);
    assert.equal(operation(state, 'redo').canRun, true);
  } finally { await store.shutdown(); }
}));

test('readiness：真实依赖漂移不禁用显式 open，恢复字节不恢复失效结果', async () => withHostFixture(async ({ root, context }) => {
  const store = new HostEditorStore(context), source = path.join(root, 'body.json'), original = await readFile(source);
  try {
    await store.open({ path: 'a.pose.json' });
    const version = structuredClone(store.active!.version);
    await writeFile(source, Buffer.concat([original, Buffer.from(' ')]));
    let state = await store.state();
    assert.equal(state.targetStale, true);
    assert.equal(operation(state, 'open').state, 'ready');
    assert.equal(operation(state, 'inspect').state, 'stale');
    assert.equal(operation(state, 'frame').canRun, false);
    await assert.rejects(store.inspect('bones'), { code: 'TARGET_STALE' });
    await writeFile(source, original);
    state = await store.state();
    assert.equal(state.targetStale, false);
    assert.deepEqual(state.version, version);
    assert.equal(state.derivedHash, null);
    assert.equal(operation(state, 'frame').reasons[0].code, 'NO_SOLUTION');
    assert.equal(operation(state, 'inspect').state, 'ready');
  } finally { await writeFile(source, original); await store.shutdown(); }
}));

test('readiness：写入冻结与观察分开，review 不显示 ready', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context);
  try {
    await store.enableWriting(); await store.open({ path: 'a.pose.json' }); await store.pin(store.active!.version);
    store.frozen = true;
    const state = await store.state();
    for (const name of ['patch', 'commit', 'review', 'undo', 'redo']) {
      assert.equal(operation(state, name).state, 'frozen');
      assert.equal(operation(state, name).reasons[0].code, 'WRITE_OWNERSHIP_UNCERTAIN');
    }
    assert.equal(operation(state, 'inspect').canRun, true);
    await store.inspect('bones');
    await assert.rejects(store.history('undo', { expectedRevision: store.active!.version }), { code: 'WRITE_OWNERSHIP_UNCERTAIN' });
  } finally { store.frozen = false; await store.shutdown(); }
}));

test('readiness：串行队列真实忙碌，成功和失败都释放 busy，观察不被统一关闭', async () => withHostFixture(async ({ context }) => {
  class HeldStore extends HostEditorStore { hold(gate: Promise<void>) { return this.serial(() => gate); } }
  const store = new HeldStore(context);
  try {
    await store.enableWriting(); await store.open({ path: 'a.pose.json' }); await store.pin(store.active!.version);
    for (const fail of [false, true]) {
      let release!: () => void;
      const gate = new Promise<void>((resolve, reject) => { release = () => fail ? reject(Error('注入事务失败')) : resolve(); });
      const pending = store.hold(gate);
      const settled = pending.catch(error => { assert.equal(error.message, '注入事务失败'); });
      try {
        const state = await store.state();
        for (const name of ['open', 'evaluate', 'patch', 'review', 'commit']) assert.equal(operation(state, name).state, 'busy');
        assert.equal(operation(state, 'inspect').canRun, true);
      } finally { release(); await settled; }
      assert.equal(operation(await store.state(), 'patch').state, 'ready');
    }
  } finally { await store.shutdown(); }
}));

test('readiness：持杖手只开放 angle，缺 gripPoint、目标或锚点有独立字段诊断', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context);
  try {
    await store.open({ path: 'a.pose.json' });
    const doc = structuredClone(store.active!);
    doc.value.weapon = { x: 0, y: 1, angle: 0, grips: { left: -0.1, right: 0.1 } };
    let targets = handTargetCapabilities(doc);
    assert.deepEqual(targets[0].controlledFields, ['x', 'y']);
    assert.deepEqual(targets[0].availableFields, ['angle']);
    delete doc.mapping.bones.anchors.leftHand.gripPoint;
    const operations = hostOperationReadiness({ doc, mode: 'host', writeMode: 'attached', managed: true, pinned: true,
      stale: false, frozen: false, pendingOperations: 0, checked: 'strict' });
    const patch = operations.find(item => item.operation === 'patch')!;
    assert.equal(patch.canRun, false);
    assert.match(patch.reasons[0].path!, /leftHand\/gripPoint$/);
    targets = handTargetCapabilities(doc);
    assert.equal(targets[0].gripPoint.status, 'missing');
    delete doc.value.frame.targets.rightHand;
    assert.equal(handTargetCapabilities(doc)[1].supported, false);
    delete doc.value.weapon;
    const noWeapon = handTargetCapabilities(doc);
    assert.equal(noWeapon[0].gripPoint.required, false);
    assert.deepEqual(noWeapon[0].availableFields, ['x', 'y', 'angle']);
  } finally { await store.shutdown(); }
}));
