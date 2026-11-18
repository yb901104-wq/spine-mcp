import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createGeometry, meshLookup, parseLandmarks, verifyGeometry, type Slice } from '../src/meshGeometry.js';
import { runMeshPlan } from '../src/meshBatch.js';
import { interpolateWeights, optimizeWeightedMesh, samplePoses, verifyMotion, type WeightedMesh } from '../src/meshMotion.js';
import { checkExportDiff, checkProjectInfo } from '../src/meshSpine43.js';
import { reportProgress, runTask, taskCheckpoint } from '../src/taskControl.js';

function slice(scale: number): Slice {
  const width = 68 * scale, height = 44 * scale;
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = x / scale, b = y / scale;
    if ((a >= 14 && a < 64 && b >= 8 && b < 36 && !(a > 44 && b > 16 && b < 28)) ||
        (a >= 1 && a < 16 && b >= 21 && b < 22)) alpha[y * width + x] = a < 14 ? 9 : 255;
  }
  return { width, height, alpha };
}

async function writeSlice(file: string, value: Slice) {
  const data = Buffer.alloc(value.alpha.length * 4, 255);
  for (let i = 0; i < value.alpha.length; i++) data[i * 4 + 3] = value.alpha[i];
  await sharp(data, { raw: { width: value.width, height: value.height, channels: 4 } }).png().toFile(file);
}

test('凹形切片和细触须在不同像素尺寸下覆盖完整且布点确定', () => {
  const intent = parseLandmarks([{ intent: 'preserve', uv: [.97, .18] }, { intent: 'densify', uv: [.5, .48] }]);
  for (const scale of [1, 2, 4]) {
    const input = slice(scale);
    const mesh = createGeometry(input, intent);
    assert.deepEqual(mesh, createGeometry(input, intent));
    verifyGeometry(mesh, input);
    const hit = meshLookup(mesh.points, mesh.triangles, input.width, input.height);
    assert.ok(hit([scale + .5, 21 * scale + .5]));
    assert.equal(hit([62 * scale, 22 * scale]), undefined);
  }
  assert.throws(() => parseLandmarks([{ intent: 'densify', uv: [-.1, 1] }]), /地标/);
});

test('新点继承重心加权坐标，保持骨骼引用并归一化', () => {
  const at = meshLookup([[0, 0], [8, 0], [0, 8]], [[0, 1, 2]], 8, 8);
  assert.deepEqual(interpolateWeights(at, [[[0, 0, 0, 1]], [[0, 8, 0, 1]], [[1, 2, 8, 1]]], [[2, 2]]),
    [[[0, 2, 0, .75], [1, .5, 2, .25]]]);
});

test('加权布点对有旋转和镜像的普通骨骼保留形变', () => {
  const image = slice(1);
  const size = 11;
  const perimeter = [
    ...Array.from({ length: size }, (_, x) => [x, 0]),
    ...Array.from({ length: size - 1 }, (_, y) => [size - 1, y + 1]),
    ...Array.from({ length: size - 1 }, (_, x) => [size - 2 - x, size - 1]),
    ...Array.from({ length: size - 2 }, (_, y) => [0, size - 2 - y]),
  ];
  const points = [...perimeter];
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) points.push([x, y]);
  const indices = new Map(points.map(([x, y], i) => [x + ',' + y, i]));
  const triangles: number[] = [];
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const [a, b, c, d] = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(p => indices.get(p.join(','))!);
    triangles.push(a, b, d, b, c, d);
  }
  const original: WeightedMesh = { type: 'mesh', width: image.width, height: image.height, hull: perimeter.length,
    uvs: points.flatMap(([x, y]) => [x / (size - 1), y / (size - 1)]), triangles,
    vertices: points.flatMap(([x, y]) => [1, 0, x * image.width / (size - 1), -y * image.height / (size - 1), 1]) };
  const poses = samplePoses({ bones: [{ name: 'part', scaleX: -1 }], animations: {
    idle: { bones: { part: { rotate: [{ value: 0 }, { time: .5, value: 28 }, { time: 1, value: 0 }] } } },
  } });
  const optimized = optimizeWeightedMesh(original, image, poses, []);
  const updated = { ...original, hull: optimized.geometry.hull, triangles: optimized.geometry.triangles.flat(),
    uvs: optimized.geometry.points.flatMap(([x, y]) => [x / image.width, y / image.height]),
    vertices: optimized.weights.flatMap(influences => [influences.length, ...influences.flatMap(([id, x, y, w]) => [id, x / w, y / w, w])]) };
  assert.ok(updated.uvs.length < original.uvs.length);
  const checked = verifyMotion(original, updated, image, poses);
  assert.ok(checked.maximumDeviationPx < .000001);
  assert.equal(checked.flippedTriangles, 0);
});

test('原生预检拒绝错误版本、多个骨架和 deform，回读只允许目标网格差异', () => {
  assert.throws(() => checkProjectInfo('Spine version: 4.1.24\n  Skeleton: rig\n'), /4\.3\.26/);
  assert.throws(() => checkProjectInfo('Spine version: 4.3.26\n  Skeleton: a\n  Skeleton: b\n'), /单骨架/);
  assert.doesNotThrow(() => checkProjectInfo('Spine version: 4.3.26\n  Skeleton: rig\n'));
  assert.throws(() => samplePoses({ bones: [{ name: 'root' }], animations: { idle: { deform: { default: {} } } } }), /deform/);
  const target = { skin: 'default', slot: 'slot', attachment: 'part', png: 'images/part.png', landmarks: [] };
  const original = { skeleton: { spine: '4.3.26', hash: 'prior' }, bones: [{ name: 'root' }],
    skins: [{ name: 'default', attachments: { slot: { part: { type: 'mesh', uvs: [0, 0], triangles: [], vertices: [] } } } }],
    animations: { idle: {} } };
  const next = structuredClone(original);
  next.skeleton.hash = 'new';
  next.skins[0].attachments.slot.part.uvs = [.2, .4];
  assert.doesNotThrow(() => checkExportDiff(original, next, [target]));
  next.bones[0].name = 'other';
  assert.throws(() => checkExportDiff(original, next, [target]), /bones/);
});

const cli = fileURLToPath(new URL('../src/meshCli.ts', import.meta.url));
const server = fileURLToPath(new URL('../src/server.ts', import.meta.url));
function invoke(root: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, '--workspace', root, ...args], { encoding: 'utf8' });
}

test('CLI 按文件名计划、保留已有目录并逐项目报告缺图和路径越界', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mesh-cli-test-'));
  try {
    await mkdir(path.join(root, 'images'));
    await writeSlice(path.join(root, 'images', 'z.png'), slice(1));
    await writeSlice(path.join(root, 'images', 'a.png'), slice(2));
    const first = invoke(root, ['plan', '--input', 'images', '--out', 'plan']);
    assert.equal(first.status, 0, first.stderr);
    const planned = JSON.parse(first.stdout);
    assert.deepEqual(planned.items.map((item: { id: string }) => item.id), ['a', 'z']);
    assert.deepEqual(await readdir(path.join(root, 'plan', 'a')), ['mesh.json', 'overlay.png']);
    assert.equal(invoke(root, ['plan', '--input', 'images', '--out', 'plan']).status, 1);
    const target = { skin: 'default', slot: 'fish', attachment: 'fish', png: 'images/missing.png' };
    await writeFile(path.join(root, 'source.spine'), 'source fixture');
    await writeFile(path.join(root, 'job.json'), JSON.stringify({ projects: [
      { id: 'missing', project: 'source.spine', targets: [target] },
      { id: 'escape', project: '../source.spine', targets: [target] },
      { id: 'manual', skip: '人工网格' },
    ] }));
    const run = invoke(root, ['candidate', '--job', 'job.json', '--spine', process.execPath, '--out', 'out']);
    assert.equal(run.status, 1);
    const result = JSON.parse(await readFile(path.join(root, 'out', 'summary.json'), 'utf8'));
    assert.deepEqual(result.items.map((item: { status: string }) => item.status), ['failed', 'failed', 'skipped']);
    assert.match(result.items[0].reason, /missing\.png/);
    assert.match(result.items[1].reason, /workspace root/);
    assert.deepEqual(await readdir(path.join(root, 'out')), ['summary.json']);
    assert.equal(await readFile(path.join(root, 'source.spine'), 'utf8'), 'source fixture');
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

async function withMeshMcp(root: string, editor: string | undefined, run: (client: Client) => Promise<void>) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.SPINE_MCP_MESH_EDITOR;
  if (editor) env.SPINE_MCP_MESH_EDITOR = editor;
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', server], stderr: 'pipe',
    env: { ...env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root },
  });
  const client = new Client({ name: 'mesh-cli-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
  }
}

function resultText(result: { content?: unknown }) {
  assert.ok(Array.isArray(result.content) && result.content.length === 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

test('真实 MCP Mesh 工具的路径、配置和 CLI 几何结果一致', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mesh-mcp-test-'));
  try {
    await mkdir(path.join(root, 'images'));
    await writeSlice(path.join(root, 'images', 'z.png'), slice(1));
    await writeSlice(path.join(root, 'images', 'a.png'), slice(2));
    await writeFile(path.join(root, 'landmarks.json'), JSON.stringify([{ intent: 'densify', uv: [.5, .48] }]));
    const local = invoke(root, ['plan', '--input', 'images', '--landmarks', 'landmarks.json', '--out', 'cli-out']);
    assert.equal(local.status, 0, local.stderr);
    await withMeshMcp(root, undefined, async client => {
      const available = (await client.listTools()).tools;
      const plan = available.find(tool => tool.name === 'spine_mesh_plan');
      const candidate = available.find(tool => tool.name === 'spine_mesh_build_candidate');
      assert.ok(plan && candidate);
      assert.deepEqual(candidate.inputSchema.required, ['jobPath', 'outputDir']);
      assert.equal(candidate.inputSchema.additionalProperties, false);
      const call = (name: string, args: Record<string, string>) => client.callTool({ name, arguments: args });
      const planArgs = { inputPath: 'images', outputDir: 'mcp-out', landmarksPath: 'landmarks.json' };
      const progress: unknown[] = [];
      const response = await client.callTool({ name: 'spine_mesh_plan', arguments: planArgs }, undefined, {
        onprogress: event => { progress.push(event); },
      });
      assert.equal(response.isError, undefined);
      const summary = resultText(response);
      assert.equal(summary.summaryPath, 'mcp-out/summary.json');
      assert.ok(progress.length >= 2);
      for (const id of ['a', 'z']) {
        const item = summary.items.find((entry: { id: string }) => entry.id === id);
        assert.equal(item.mesh, 'mcp-out/' + id + '/mesh.json');
        assert.equal(item.overlay, 'mcp-out/' + id + '/overlay.png');
        assert.deepEqual(await readFile(path.join(root, item.mesh)), await readFile(path.join(root, 'cli-out', id, 'mesh.json')));
      }
      assert.deepEqual(await readFile(path.join(root, summary.summaryPath)), await readFile(path.join(root, 'cli-out', 'summary.json')));
      assert.equal((await call('spine_mesh_plan', planArgs)).isError, true);
      const escape = await call('spine_mesh_plan', { inputPath: '../escape.png', outputDir: 'escaped' });
      assert.equal(escape.isError, true);
      assert.match(resultText(escape).message, /workspace root/);
      assert.equal((await call('spine_mesh_plan', { inputPath: 'images', outputDir: '../escape-out' })).isError, true);
      await writeFile(path.join(root, 'job.json'), JSON.stringify({ projects: [{ id: 'skip', skip: '人工网格' }] }));
      const job = { jobPath: 'job.json', outputDir: 'no-editor' };
      const injected = await call('spine_mesh_build_candidate', { ...job, editorPath: process.execPath });
      assert.equal(injected.isError, true);
      assert.equal(resultText(injected).code, 'VALIDATION_FAILED');
      const missing = await call('spine_mesh_build_candidate', job);
      assert.equal(missing.isError, true);
      assert.match(resultText(missing).message, /SPINE_MCP_MESH_EDITOR/);
      await assert.rejects(stat(path.join(root, 'no-editor')), { code: 'ENOENT' });
    });
    await withMeshMcp(root, process.execPath, async client => {
      const invalid = await client.callTool({ name: 'spine_mesh_build_candidate', arguments: { jobPath: 'job.json', outputDir: 'bad-editor' } });
      assert.equal(invalid.isError, true);
      assert.match(resultText(invalid).message, /无法运行 Spine 4\.3\.26/);
      await assert.rejects(stat(path.join(root, 'bad-editor')), { code: 'ENOENT' });
    });
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test('Mesh 批次取消后保留已交付项并清理未发布的临时目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mesh-cancel-test-'));
  try {
    await mkdir(path.join(root, 'images'));
    await writeSlice(path.join(root, 'images', 'first.png'), slice(1));
    await writeSlice(path.join(root, 'images', 'second.png'), slice(1));
    const controller = new AbortController();
    await assert.rejects(runTask({ signal: controller.signal }, () => runMeshPlan({
      workspace: root, inputPath: 'images', outputDir: 'out',
    }, {
      checkpoint: async stage => {
        if (stage === '发布布点产物 second') controller.abort();
        await taskCheckpoint(stage);
      },
      progress: reportProgress,
    })), { code: 'CANCELLED' });
    assert.deepEqual(await readdir(path.join(root, 'out')), ['first']);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

const tuna = process.env.SPINE_TEST_MESH_TUNA;
const editor = process.env.SPINE_MCP_MESH_EDITOR;
test('真实 Spine 4.3.26 的 CLI 与 MCP 候选和混合批次一致', {
  skip: !tuna || !editor ? '需要 SPINE_TEST_MESH_TUNA 和 SPINE_MCP_MESH_EDITOR。' : undefined,
}, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mesh-native-test-'));
  try {
    await cp(tuna!, path.join(root, 'Tuna'), { recursive: true });
    const sourceFiles = ['Tuna.spine', 'Tuna.json', 'Tuna.atlas', 'Tuna.png', path.join('images', 'tuna.png')];
    const originals = await Promise.all(sourceFiles.map(file => readFile(path.join(root, 'Tuna', file))));
    const target = { skin: 'default', slot: 'fish', attachment: 'tuna', png: 'Tuna/images/tuna.png' };
    await writeFile(path.join(root, 'job.json'), JSON.stringify({ projects: [
      { id: 'Tuna', project: 'Tuna/Tuna.spine', targets: [target] },
      { id: 'Bream', skip: '沿用人工调整的网格' },
      { id: 'MissingPNG', project: 'Tuna/Tuna.spine', targets: [{ ...target, png: 'missing.png' }] },
    ] }));
    const local = invoke(root, ['candidate', '--job', 'job.json', '--spine', editor!, '--out', 'cli-out']);
    assert.equal(local.status, 1, local.stderr);
    const plan = JSON.parse(local.stdout);
    assert.deepEqual(plan.items.map((item: { status: string }) => item.status), ['built', 'skipped', 'failed']);
    await withMeshMcp(root, editor!, async client => {
      const native = await client.callTool({ name: 'spine_mesh_build_candidate', arguments: { jobPath: 'job.json', outputDir: 'mcp-out' } });
      assert.equal(native.isError, undefined);
      const summary = resultText(native);
      assert.equal(summary.ok, false);
      assert.deepEqual(summary.items.map((item: { status: string }) => item.status), ['built', 'skipped', 'failed']);
      assert.deepEqual(summary.items[0].targets, plan.items[0].targets);
      assert.equal(summary.items[1].explicit, true);
      assert.match(summary.items[2].reason, /missing\.png/);
      assert.equal(summary.items[0].project, 'mcp-out/Tuna/Tuna.spine');
      const localReport = await readFile(path.join(root, 'cli-out', plan.items[0].report));
      const mcpReport = await readFile(path.join(root, summary.items[0].report));
      const report = JSON.parse(mcpReport.toString());
      assert.deepEqual(JSON.parse(localReport.toString()), report);
      assert.deepEqual(report.native, { version: '4.3.26', imported: true, exportVerified: true });
      const { pointsBefore, pointsAfter, numeric } = report.targets[0];
      assert.ok(pointsAfter < pointsBefore);
      assert.equal(numeric.flippedTriangles, 0);
      assert.ok(numeric.maximumDeviationPx <= numeric.tolerancePx);
      context.diagnostic(`Tuna ${pointsBefore} → ${pointsAfter} 点，最大形变偏差 ${numeric.maximumDeviationPx} px，阈值 ${numeric.tolerancePx} px。`);
      for (const dir of ['cli-out', 'mcp-out']) {
        const data = JSON.parse(await readFile(path.join(root, dir, 'Tuna', 'Tuna.json'), 'utf8'));
        assert.deepEqual(data.animations.idle, JSON.parse(originals[1].toString()).animations.idle);
      }
    });
    assert.deepEqual(await Promise.all(sourceFiles.map(file => readFile(path.join(root, 'Tuna', file)))), originals);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});
