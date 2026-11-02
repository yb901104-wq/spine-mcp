import {poseInputHash} from '../src/animationKernel.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHostFixture } from './helpers/hostFixture.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { HostClient } from '../src/hostClient.js';
import { startHostServer } from '../src/hostServer.js';
import { applyHostPosePatch, assertPoseRecovery } from '../src/hostPosePatch.js';
import { HostRollout } from '../src/hostRollout.js';
import { objectHash, strictHash } from '../src/hostContracts.js';

const body = { op: 'setPoseParameters', path: 'pose/frame/body', patch: { rotate: 2 } };
const head = { op: 'setPoseParameters', path: 'pose/frame/head', patch: { rotate: 5 } };
const channel = { op: 'setPoseParameters', path: 'pose/frame/channels/torso', patch: { rotate: 3 } };
const foot = { op: 'setPoseTarget', path: 'pose/frame/targets/leftFoot', role: 'leftFoot', x: -.14 };
const hand = { op: 'setPoseTarget', path: 'pose/frame/targets/rightHand', role: 'rightHand', angle: -85 };
const ops = [body, head, channel, foot, hand];
const decode = (result: any) => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };

test('C2 原子批次：dryRun 无副作用，真实求解回读/PNG、完整版本、撤销重做及源输入不变', async () => withHostFixture(async ({ root, context }) => {
  const host = await startHostServer(context, { writeEnabled: true, developmentProfile: 'c2-pose' }), client = new HostClient(context);
  const originals = await Promise.all(['body.json','mapping.json','body.atlas','body.png','a.pose.json'].map(async file => [file, strictHash(await readFile(path.join(root, file)))]));
  try {
    const opened = await client.open({ path: 'a.pose.json' }); await client.rpc('/api/pin', { expectedRevision: opened.version });
    const fullSnapshot=await host.store.snapshot(opened.version),solveSnapshot=await host.store.snapshot(opened.version,'evaluate');assert.equal(solveSnapshot.snapshotHash,fullSnapshot.snapshotHash);assert.equal(poseInputHash(solveSnapshot.document),poseInputHash(fullSnapshot.document));assert.equal(solveSnapshot.baselineDocument,undefined);assert.equal(solveSnapshot.derived,undefined);assert.ok(fullSnapshot.baselineDocument);
    assert.equal(opened.capabilities.editing.profile, 'c2-pose'); assert.equal(opened.capabilities.editing.experimental, true);
    assert.equal(opened.capabilities.editing.patchOps.maxItems, 200);
    assert.equal(opened.capabilities.operations.find((item: any) => item.operation === 'patch').schemaVersion, 2);
    assert.deepEqual(opened.capabilities.editing.targets.find((item: any) => item.role === 'leftFoot').controlledFields, ['y']);
    const frame = structuredClone(host.store.active!.value.frame), before = objectHash(host.store.active), files = await readdir(root, { recursive: true });
    const dry = await client.patch({ expectedRevision: opened.version, ops }); assert.equal(dry.dryRun, true);
    assert.equal(objectHash(host.store.active), before); assert.deepEqual(await readdir(root, { recursive: true }), files);
    const edited = await client.patch({ expectedRevision: opened.version, ops, dryRun: false });
    assert.equal(edited.version.revision, 1); assert.ok(edited.__imageData); assert.deepEqual(edited.state.version, edited.version);
    assert.deepEqual(host.store.active!.value.frame.channels.torso, { x: 0, y: 0, rotate: 3 });
    assert.ok(Math.abs(host.store.active!.derived.bones.body.rotate - 5) < 1e-4, 'body 与声明通道的增量按既有 runtime 累加');
    assert.ok(Math.abs(host.store.active!.derived.bones.head.rotate - 5) < 1e-4);
    assert.equal(host.store.active!.value.frame.targets.leftFoot.contact, true); assert.equal(host.store.active!.review, null);
    await assert.rejects(client.patch({ expectedRevision: opened.version, ops, dryRun: false }), { code: 'REVISION_CONFLICT' });
    const undone = await client.history('undo', { expectedRevision: edited.version, dryRun: false });
    assert.deepEqual(host.store.active!.value.frame, frame); assert.equal(undone.version.revision, 2); assert.ok(undone.__imageData);
    const redone = await client.history('redo', { expectedRevision: undone.version, dryRun: false }); assert.equal(redone.version.revision, 3);
    const saved = await client.commit({ expectedRevision: redone.version, outputPath: 'c2-draft.pose.json', requestId: 'c2-draft', dryRun: false });
    assert.equal(saved.committed, true); assert.ok(saved.backupPath); assert.equal((await client.commit({ expectedRevision: redone.version, outputPath: 'c2-draft.pose.json', requestId: 'c2-draft', dryRun: false })).replayed, true);
    await client.open({ path: 'c2-draft.pose.json', expectedRevision: saved.version }); assert.equal(host.store.active!.value.frame.head, 5);
    for (const [file, hash] of originals) assert.equal(strictHash(await readFile(path.join(root, String(file)))), hash);
  } finally { await host.stop(); }
}, { neutralSetup: true }));

test('C2 整批拒绝：后项失败不半应用，重复/重叠、路径错配、未知字段、绑定/支撑改变及非有限数', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context, 'host', 'c2-pose'); await store.enableWriting();
  try {
    await store.open({ path: 'a.pose.json' }); await store.pin(store.active!.version);
    const before = objectHash(store.active);
    const invalid = [
      [body, body], [body, { ...body, path: 'pose/frame/body/x' }], [body, { ...foot, path: 'pose/frame/targets/rightFoot' }],
      [body, { ...channel, path: 'pose/frame/channels/notDeclared' }], [body, { ...foot, contact: false }],
      [body, { ...foot, y: .1 }], [body, { ...head, patch: { rotate: 180 } }], [body, { ...head, patch: { rotate: NaN } }],
      [body, { ...head, patch: { rotate: Infinity } }], [body, { ...body, patch: { sourceFingerprint: 'forged' } }],
      [body, { op: 'setPoseParameters', path: 'pose/groundY', patch: { value: .1 } }],
      [body, { op: 'setPoseParameters', path: 'pose/frame/bendDirections', patch: { leftArm: -1 } }],
      [body, { ...channel, path: 'pose/frame/channels/__proto__' }], new Array(201).fill(body),
      [JSON.parse('{"op":"setPoseParameters","path":"pose/frame/body","patch":{"__proto__":{}}}')],
    ];
    for (const batch of invalid) {
      await assert.rejects(store.patch({ expectedRevision: store.active!.version, ops: batch, dryRun: false }));
      assert.equal(objectHash(store.active), before);
    }
    store.active!.value.weapon = { x: 0, y: .5, angle: 0, grips: { left: -.1, right: .1 } };
    await assert.rejects(store.patch({ expectedRevision: store.active!.version, ops: [body, { ...hand, x: 0 }], dryRun: false }), { code: 'OPERATION_NOT_READY' });
  } finally { await store.shutdown(); }
}));

test('C2 journal 恢复保留整批历史，C1 拒绝恢复扩展内容，固定绑定和恶意恢复参数拒绝', async () => withHostFixture(async ({ context }) => {
  const store = new HostEditorStore(context, 'host', 'c2-pose'); await store.enableWriting(); await store.open({ path: 'a.pose.json' }); await store.pin(store.active!.version);
  await store.patch({ expectedRevision: store.active!.version, ops, dryRun: false }); const expected = structuredClone(store.active!.value.frame); await store.shutdown();
  const c1 = new HostEditorStore(context); await c1.enableWriting();
  try { await assert.rejects(c1.open({ path: 'a.pose.json' }), { code: 'JOURNAL_CORRUPT' }); } finally { await c1.shutdown(); }
  const recovered = new HostEditorStore(context, 'host', 'c2-pose'); await recovered.enableWriting();
  try {
    await recovered.open({ path: 'a.pose.json' }); assert.deepEqual(recovered.active!.value.frame, expected); assert.equal(recovered.active!.undo.length, 1);
    assert.equal(recovered.active!.derived, null); await recovered.pin(recovered.active!.version);
    await recovered.history('undo', { expectedRevision: recovered.active!.version, dryRun: false }); assert.equal(recovered.active!.value.frame.head, 0);
    const baseline = recovered.active!;
    baseline.mapping.bones.channels.head = 'head'; baseline.mapping.bones.channels.body = 'body';
    for (const mutate of [(value: any) => { value.mappingPath = 'other.json'; }, (value: any) => { value.frame.targets.leftFoot.contact = false; },
      (value: any) => { value.frame.head = false; }, (value: any) => { value.frame.channels.torso = { rotate: 'bad' }; },
      (value: any) => { value.frame.channels.head = {}; }, (value: any) => { value.frame.channels.body = { rotate: 'bad' }; }]) {
      const value = structuredClone(baseline.value); mutate(value); assert.throws(() => assertPoseRecovery(baseline, value, 'c2-pose'));
    }
  } finally { await recovered.shutdown(); }
}));

test('实际 MCP stdio 发现 C2 schema 并批量求解出图，私有请求不能切换 profile', async () => withHostFixture(async ({ root, context }) => {
  const host = await startHostServer(context, { writeEnabled: true, developmentProfile: 'c2-pose' });
  const client = new Client({ name: 'c2-protocol-test', version: '1' }, { capabilities: {} });
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: { ...env, SPINE_MCP_WORKSPACE: root, SPINE_HOST_AUTOSTART: '0' } }));
    const listed = await client.listTools(); assert.ok(listed.tools.length>=102);
    const patchSchema=listed.tools.find(item => item.name === 'spine_host_patch')!.inputSchema.properties!.ops as any;
    assert.equal(patchSchema.oneOf[0].maxItems,200);assert.equal(patchSchema.oneOf[1].maxItems,1);assert.equal(patchSchema.oneOf[1].items.properties.op.const,'editMotionInterval');
    const call = (name: string, args: any) => client.callTool({ name, arguments: { projectId: context.projectId, ...args } });
    const opened = decode(await call('spine_host_open', { path: 'a.pose.json' })); decode(await call('spine_host_pin', { expectedRevision: opened.version }));
    const presentedOps = [...ops, { op: 'setSlotAttachment', path: 'pose/frame/presentation/attachments/bodySlot', slot: 'bodySlot', attachment: 'alternate' },
      { op: 'setDrawOrder', path: 'pose/frame/presentation/drawOrder', order: ['accentSlot','bodySlot'] }];
    const edited = await call('spine_host_patch', { expectedRevision: opened.version, ops: presentedOps, dryRun: false });
    assert.ok((edited.content as any[]).some(item => item.type === 'image')); assert.equal(decode(edited).version.revision, 1);
    assert.deepEqual(host.store.active!.derived.renderState.drawOrder, ['accentSlot','bodySlot']);
    assert.equal(host.store.active!.derived.renderState.attachments[0][1], 'alternate');
    const injected = await fetch(host.endpoint + '/api/patch', { method: 'POST', headers: { Origin: host.endpoint, 'Content-Type': 'application/json', 'X-Spine-Host-Token': host.token }, body: JSON.stringify({ expectedRevision: host.store.active!.version, ops: [body], developmentProfile: 'c2-pose' }) });
    assert.equal(injected.status, 400);
  } finally { await client.close(); await host.stop(); }
}, { neutralSetup: true }));

test('生产 C1 白名单与审批不扩权；能力正确排除被 IK/follow 接管的通道', async () => withHostFixture(async ({ context }) => {
  const c1 = new HostEditorStore(context); await c1.enableWriting();
  try {
    await c1.open({ path: 'a.pose.json' }); await c1.pin(c1.active!.version);
    for (const batch of [[body], [foot], [hand, { ...hand, role: 'leftHand', path: 'pose/frame/targets/leftHand' }]]) await assert.rejects(c1.patch({ expectedRevision: c1.active!.version, ops: batch, dryRun: false }), { code: 'CAPABILITY_MISSING' });
    assert.equal(c1.capabilities().editing.profile, 'c1'); assert.equal(c1.capabilities().editing.patchOps.maxItems, 1);
  } finally { await c1.shutdown(); }
  const c2 = new HostEditorStore(context, 'host', 'c2-pose'); await c2.open({ path: 'a.pose.json' });
  const rollout = new HostRollout(c2, context, async () => true);
  assert.equal((await rollout.enableFromApproval('anything.json')).code, 'ROLLOUT_SCOPE_MISMATCH'); assert.equal(c2.writer, null);
  c2.active!.mapping.bones.channels.arm = 'leftArm1';
  assert.equal(c2.capabilities().editing.parameters!.channels.find(item => item.name === 'arm')!.supported, false);
  assert.throws(() => applyHostPosePatch(c2.active!, [{ ...channel, path: 'pose/frame/channels/arm' }], 'c2-pose'));
}));
