import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHostServer } from '../src/hostServer.js';
import { strictHash } from '../src/hostContracts.js';

test('普通创作真实 stdio：可跳过参考读取，批量补骨与编辑，可回读、撤销、恢复及独立交付', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spine-authoring-test-'));
  await cp('example-json', root, { recursive: true });
  const source = path.join(root, 'xiaoren.json'), bytes = await readFile(source);
  const rig = JSON.parse(bytes.toString()), bone = rig.bones[0].name;
  const client = () => new Client({ name: 'authoring-test', version: '1' });
  const transport = () => new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/server.js')],
    env: { ...process.env, SPINE_MCP_WORKSPACE: root, SPINE_HOST_AUTOSTART: '0', SPINE_MCP_TOOL_PROFILE: 'authoring', SPINE_EDITOR_CLI: '' } });
  let mcp = client();
  const tool = async (name: string, args: Record<string, unknown>, error?: string) => {
    const result = await mcp.callTool({ name, arguments: args });
    const value = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.equal(result.isError === true, !!error, JSON.stringify(value));
    if (error) assert.equal(value.code, error);
    return value;
  };
  try {
    await mcp.connect(transport());
    const listed = await mcp.listTools();
    assert.equal(mcp.getServerCapabilities()?.prompts, undefined);
    assert.ok(!listed.tools.some(tool => tool.name === 'spine_execute_task'));
    assert.ok(listed.tools.some(tool => tool.name === 'spine_inspect_project'));
    const draft = await tool('spine_open_animation_draft', { filePath: 'xiaoren.json', animation: 'authoring_test', mode: 'create' });
    const draftId = draft.draftId;
    const track = { kind: 'bone', name: bone, timeline: 'translate' };
    const ops = [
      { op: 'setFrames', track, frames: [{ time: 0, x: 0, y: 0 }, { time: 0.5, x: 10, y: 0 }, { time: 1, x: 0, y: 0 }] },
      { op: 'addBone', bone: { name: 'extra', parent: bone, x: 12 } },
      { op: 'addSlot', slot: { name: 'extra', bone: 'extra' } },
      { op: 'addAttachment', name: 'piece', slot: 'extra', skin: 'default', region: 'authoring/piece', imagePath: 'xiaoren.png',
        crop: { left: 0, top: 0, width: 8, height: 8 }, attachment: { type: 'region' } },
      { op: 'addAttachment', name: 'mesh', slot: 'extra', skin: 'default', region: 'authoring/mesh', imagePath: 'xiaoren.png',
        crop: { left: 0, top: 0, width: 8, height: 8 }, attachment: { type: 'mesh', uvs: [0, 0, 1, 0, 1, 1, 0, 1],
          hull: 4, triangles: [0, 1, 2, 2, 3, 0], vertices: [[-4, 4], [4, 4], [4, -4], [-4, -4]]
            .flatMap(([x, y]) => [1, rig.bones.length, x, y, 1]) } },
      { op: 'setFrames', track: { kind: 'slot', name: 'extra', timeline: 'attachment' },
        frames: [{ time: 0, name: null }, { time: 0.2, name: 'piece' }, { time: 0.6, name: 'mesh' }, { time: 0.9, name: null }] },
    ];
    const edit = (expectedRevision: number, additional: Record<string, unknown>, error?: string) =>
      tool('spine_edit_animation_draft', { draftId, expectedRevision, dryRun: false, ...additional }, error);
    const dry = await edit(0, { ops, dryRun: true });
    assert.equal(dry.revision, 0);
    assert.equal(dry.proposedRevision, 1);
    const first = await edit(0, { ops });
    assert.equal(first.candidateHash, dry.proposedHash);
    await edit(0, { ops }, 'REVISION_CONFLICT');
    await edit(1, { ops: [{ op: 'retimeFrames', track, start: 0.5, end: 0.5, toStart: 1, toEnd: 1 }] }, 'KEYFRAME_CONFLICT');
    await edit(1, { ops: [ops[0], { op: 'addBone', bone: { name: 'bad', parent: 'missing' } }] }, 'INVALID_ARGUMENT');
    const unchanged = await tool('spine_preview_animation_draft', { draftId });
    assert.equal(unchanged.candidateHash, first.candidateHash);
    const second = await edit(1, { ops: [{ op: 'retimeFrames', track, start: 0.5, end: 0.5, toStart: 0.65, toEnd: 0.65 }] });
    assert.equal(second.revision, 2);
    assert.equal((await edit(2, { history: 'undo' })).candidateHash, first.candidateHash);
    const fourth = await edit(3, { history: 'redo' });
    assert.equal(fourth.candidateHash, second.candidateHash);
    await mcp.close();
    mcp = client();
    await mcp.connect(transport());
    const view = await tool('spine_preview_animation_draft', { draftId, view: 'gif', fps: 8 });
    assert.equal(view.revision, 4);
    assert.equal(view.formalEligible, null);
    assert.equal((await readFile(path.join(root, view.gifPath))).subarray(0, 3).toString(), 'GIF');
    const single = await tool('spine_preview_animation_draft', { draftId, view: 'debug', time: 0.65 });
    assert.deepEqual(single.times, [0.65]);
    assert.ok(single.coordinates.extra);
    const advisory = await tool('spine_preview_animation_draft', { draftId, view: 'measure',
      measurements: [{ bone, start: 0, end: 0.65, tolerance: 0.01 }] });
    assert.equal(advisory.measurements[0].aboveTolerance, true);
    const host = await startHostServer({ workspaceRoot: root }, { persist: false });
    try {
      const headers = { 'X-Spine-Host-Token': host.token };
      const state = await fetch(`${host.endpoint}/api/authoring`, { headers }).then(res => res.json());
      assert.equal(state.state.revision, 4);
      const frame = await fetch(`${host.endpoint}/api/authoring/frame?id=${state.state.preview.id}&index=0`, { headers });
      assert.equal(frame.status, 200);
      assert.equal(frame.headers.get('x-revision'), '4');
    } finally { await host.stop(); }
    const publish = { draftId, expectedRevision: 4, candidateHash: fourth.candidateHash, outputPath: 'delivery', format: 'json', dryRun: false };
    await tool('spine_publish_animation_draft', { ...publish, outputPath: 'missing-cli', format: 'spine' }, 'CLI_UNAVAILABLE');
    const receipt = await tool('spine_publish_animation_draft', publish);
    const result = await readFile(path.join(root, receipt.filePath));
    assert.equal(receipt.sha256, strictHash(result));
    const parsed = JSON.parse(result.toString());
    assert.deepEqual(parsed.animations.authoring_test.bones[bone].translate.map((frame: { time: number }) => frame.time), [0, 0.65, 1]);
    assert.deepEqual(parsed.animations[Object.keys(rig.animations)[0]], rig.animations[Object.keys(rig.animations)[0]]);
    assert.equal(parsed.bones.at(-1).name, 'extra');
    assert.equal(parsed.skins.find((skin: { name: string }) => skin.name === 'default').attachments.extra.mesh.type, 'mesh');
    assert.deepEqual(await readFile(source), bytes);
    await tool('spine_publish_animation_draft', publish, 'OUTPUT_EXISTS');
    await tool('spine_publish_animation_draft', { ...publish, outputPath: '../escape' }, 'PATH_FORBIDDEN');
  } finally {
    await mcp.close();
    await rm(root, { recursive: true, force: true });
  }
});
