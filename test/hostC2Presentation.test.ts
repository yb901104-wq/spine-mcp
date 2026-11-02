import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withHostFixture } from './helpers/hostFixture.js';
import { HostClient } from '../src/hostClient.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { startHostServer } from '../src/hostServer.js';
import { applyHostPosePatch, assertPoseRecovery, slotAttachmentPath } from '../src/hostPosePatch.js';
import { objectHash, strictHash } from '../src/hostContracts.js';
import { validateOfficialAnimationSpec } from '../src/spineJson.js';
import { createMotionRuntime } from '../src/motionRuntime.js';

const attachment = { op: 'setSlotAttachment', path: slotAttachmentPath('bodySlot'), slot: 'bodySlot', attachment: 'alternate' };
const hide = { op: 'setSlotAttachment', path: slotAttachmentPath('accentSlot'), slot: 'accentSlot', attachment: null };
const order = { op: 'setDrawOrder', path: 'pose/frame/presentation/drawOrder', order: ['accentSlot','bodySlot'] };

test('C2 呈现批次：切换/隐藏附件与层序经实际 runtime/live 回读，撤销重做及草稿不改 setup', async () => withHostFixture(async ({ root, context }) => {
  const host = await startHostServer(context, { writeEnabled: true, developmentProfile: 'c2-pose' }), client = new HostClient(context);
  const source = await readFile(path.join(root, 'body.json')), atlas = await readFile(path.join(root, 'body.atlas')), texture = await readFile(path.join(root, 'body.png'));
  try {
    const opened = await client.open({ path: 'a.pose.json' }); await client.rpc('/api/pin', { expectedRevision: opened.version });
    assert.ok(opened.capabilities.editing.presentation.slots.find((item: any) => item.slot === 'bodySlot').attachments.includes('alternate'));
    const prior = objectHash(host.store.active), batch = [attachment, hide, order];
    const dry = await client.patch({ expectedRevision: opened.version, ops: batch }); assert.equal(dry.dryRun, true); assert.equal(objectHash(host.store.active), prior);
    const edited = await client.patch({ expectedRevision: opened.version, ops: batch, dryRun: false }); assert.ok(edited.__imageData);
    const actual = host.store.active!.derived.renderState;
    assert.deepEqual(actual.drawOrder, order.order); assert.deepEqual(actual.attachments, [['bodySlot','alternate'],['accentSlot',null]]); assert.ok(actual.maximumError <= 1e-4);
    const live = host.store.active!.derived.live, exported = JSON.parse(await readFile(path.join(root, live.path), 'utf8'));
    assert.equal(validateOfficialAnimationSpec(exported).ok, true); assert.deepEqual(exported.slots, JSON.parse(source.toString()).slots);
    assert.deepEqual(exported.skins, JSON.parse(source.toString()).skins); assert.equal(strictHash(await readFile(path.join(root, live.path))), live.hash);
    const runtime = createMotionRuntime(exported, atlas.toString()), sampled = runtime.sample(live.animation, live.time, 'default');
    assert.deepEqual(sampled.drawOrder.map(slot => slot.data.name), order.order); assert.equal(sampled.findSlot('bodySlot')!.getAttachment()!.name, 'alternate'); assert.equal(sampled.findSlot('accentSlot')!.getAttachment(), null);
    const undone = await client.history('undo', { expectedRevision: edited.version, dryRun: false });
    assert.deepEqual(host.store.active!.derived.renderState.drawOrder, ['bodySlot','accentSlot']); assert.equal(host.store.active!.value.frame.presentation, undefined);
    const redone = await client.history('redo', { expectedRevision: undone.version, dryRun: false });
    const saved = await client.commit({ expectedRevision: redone.version, outputPath: 'presentation-draft.pose.json', requestId: 'presentation-draft', dryRun: false });
    assert.equal(saved.committed, true); await client.open({ path: 'presentation-draft.pose.json', expectedRevision: saved.version });
    assert.deepEqual(host.store.active!.value.frame.presentation.drawOrder, order.order);
    assert.deepEqual(await readFile(path.join(root, 'body.json')), source); assert.deepEqual(await readFile(path.join(root, 'body.atlas')), atlas); assert.deepEqual(await readFile(path.join(root, 'body.png')), texture);
  } finally { await host.stop(); }
}, { neutralSetup: true }));

test('C2 呈现引用/置换全批验证：不存在附件、非全集/重复层序、path 错配及原型名拒绝', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context, 'host', 'c2-pose'); await store.enableWriting();
  try {
    await store.open({ path: 'a.pose.json' }); await store.pin(store.active!.version); const before = objectHash(store.active);
    for (const invalid of [{ ...attachment, attachment: 'missing' }, { ...attachment, slot: 'missing' }, { ...attachment, path: slotAttachmentPath('accentSlot') },
      { ...order, order: ['bodySlot'] }, { ...order, order: ['bodySlot','bodySlot'] }, { ...order, order: ['bodySlot','missing'] },
      { ...attachment, setup: true }, { ...attachment, attachment: {} }, { ...attachment, slot: '__proto__', path: slotAttachmentPath('__proto__') }]) {
      await assert.rejects(store.patch({ expectedRevision: store.active!.version, ops: [hide, invalid], dryRun: false }));
      assert.equal(objectHash(store.active), before);
    }
    const value = structuredClone(store.active!.value); value.frame.presentation = { drawOrder: ['missing'] }; assert.throws(() => assertPoseRecovery(store.active!, value, 'c2-pose'));
    value.frame.presentation = { attachments: { bodySlot: 'missing' } }; assert.throws(() => assertPoseRecovery(store.active!, value, 'c2-pose'));
    value.frame.presentation = { slots: { bodySlot: 'alternate' } }; assert.throws(() => assertPoseRecovery(store.active!, value, 'c2-pose'));
  } finally { await store.shutdown(); }
}));

test('C2 呈现 journal 恢复；C1 拒绝呈现操作及跨 profile 恢复', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context, 'host', 'c2-pose'); await store.enableWriting(); await store.open({ path: 'a.pose.json' }); await store.pin(store.active!.version);
  await store.patch({ expectedRevision: store.active!.version, ops: [attachment, order], dryRun: false }); await store.shutdown();
  const c1 = new HostEditorStore(context); await c1.enableWriting();
  try { await assert.rejects(c1.open({ path: 'a.pose.json' }), { code: 'JOURNAL_CORRUPT' }); } finally { await c1.shutdown(); }
  const recovered = new HostEditorStore(context, 'host', 'c2-pose'); await recovered.enableWriting();
  try {
    await recovered.open({ path: 'a.pose.json' }); assert.deepEqual(recovered.active!.value.frame.presentation, { attachments: { bodySlot: 'alternate' }, drawOrder: order.order });
    await recovered.pin(recovered.active!.version); await recovered.history('undo', { expectedRevision: recovered.active!.version, dryRun: false });
    assert.equal(recovered.active!.value.frame.presentation, undefined);
    assert.throws(() => applyHostPosePatch(recovered.active!, [attachment], 'c1'), { code: 'CAPABILITY_MISSING' });
  } finally { await recovered.shutdown(); }
}));

test('附件依据当前皮肤及 default 回退校验，含斜杠/波浪号的插槽 path 使用规范转义', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context, 'host', 'c2-pose'); await store.open({ path: 'a.pose.json' }); const doc = store.active!;
  doc.skeletonJson.skins.find((skin: any) => skin.name === 'alternate').attachments.bodySlot.privateOnly = { type: 'region', path: 'body', width: 8, height: 8 };
  assert.throws(() => applyHostPosePatch(doc, [{ ...attachment, attachment: 'privateOnly' }], 'c2-pose'));
  doc.mapping.skin = 'alternate'; assert.equal(applyHostPosePatch(doc, [attachment], 'c2-pose').frame.presentation.attachments.bodySlot, 'alternate', 'default 回退附件可用');
  assert.equal(applyHostPosePatch(doc, [{ ...attachment, attachment: 'privateOnly' }], 'c2-pose').frame.presentation.attachments.bodySlot, 'privateOnly');
  const renamed = 'body/part~front'; doc.skeletonJson.slots[0].name = renamed;
  for (const skin of doc.skeletonJson.skins) { skin.attachments[renamed] = skin.attachments.bodySlot; delete skin.attachments.bodySlot; }
  const encoded = { ...attachment, slot: renamed, path: slotAttachmentPath(renamed) };
  assert.equal(encoded.path, 'pose/frame/presentation/attachments/body~1part~0front');
  const candidate = applyHostPosePatch(doc, [encoded], 'c2-pose'); assert.equal(candidate.frame.presentation.attachments[renamed], 'alternate');
  assert.doesNotThrow(() => assertPoseRecovery(doc, candidate, 'c2-pose'));
  assert.throws(() => applyHostPosePatch(doc, [{ ...encoded, path: 'pose/frame/presentation/attachments/' + renamed }], 'c2-pose'));
}));
