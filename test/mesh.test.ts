import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createGeometry, meshLookup, parseLandmarks, verifyGeometry, type Slice } from '../src/meshGeometry.js';
import { interpolateWeights, optimizeWeightedMesh, samplePoses, verifyMotion, type WeightedMesh } from '../src/meshMotion.js';
import { checkExportDiff, checkProjectInfo } from '../src/meshSpine43.js';

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
