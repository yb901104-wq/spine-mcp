import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { readSlice, writeOverlay, type Landmark, type MeshGeometry, type Slice } from './meshGeometry.js';
import {
  decodeWeights, geometryFromAttachment, optimizeWeightedMesh, samplePoses, UnsupportedMeshError, verifyMotion,
  type MotionReport, type WeightedMesh, type Weights,
} from './meshMotion.js';
import { resolveWorkspacePath } from './spineJson.js';

export const EDITOR_VERSION = '4.3.26';
type Document = Record<string, any>;
export type MeshTarget = { skin: string; slot: string; attachment: string; png: string; landmarks: Landmark[] };
export type ProjectJob = { id: string; project: string; targets: MeshTarget[] };
type Replacement = { mesh: WeightedMesh; geometry: MeshGeometry; weights: Weights; slice: Slice };
type TargetReport = {
  skin: string; slot: string; attachment: string; pointsBefore: number; pointsAfter: number; overlay: string; numeric: MotionReport;
};

const runFile = promisify(execFile);
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function spine(editor: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await runFile(editor, ['-u', EDITOR_VERSION, ...args], {
      cwd, windowsHide: true, timeout: 120_000, maxBuffer: 2_000_000, encoding: 'utf8',
    });
    const output = (stdout + '\n' + stderr).replace(/^Licensed to:.*$/gm, '');
    if (/^ERROR:/mi.test(output) || !output.includes('Spine ' + EDITOR_VERSION)) throw new Error(output.trim());
    return output;
  } catch (failure) {
    const details = failure as Error & { stdout?: string; stderr?: string };
    const message = [details.stdout, details.stderr].filter(Boolean).join('\n') || details.message;
    throw new Error('Spine ' + EDITOR_VERSION + ' 操作失败。' + message.replace(/^Licensed to:.*$/gm, '').trim());
  }
}

export async function validateMeshEditor(editor: string, workspace: string): Promise<void> {
  if (!path.isAbsolute(editor) || !(await lstat(editor)).isFile()) throw new Error('编辑器路径必须指向本地可执行文件。');
  await spine(editor, ['--version'], workspace);
}

function ints(values: readonly number[]): Buffer {
  const bytes: number[] = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new Error('二进制 Mesh 整数超出范围。');
    let n = value;
    while (n >= 128) {
      bytes.push((n & 127) | 128);
      n >>>= 7;
    }
    bytes.push(n);
  }
  return Buffer.from(bytes);
}

function floats(values: readonly number[]): Buffer {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => result.writeFloatBE(value, index * 4));
  return result;
}

function matchesFloats(buffer: Buffer, start: number, values: readonly number[], epsilon: number): boolean {
  return start >= 0 && start + values.length * 4 <= buffer.length &&
    values.every((value, i) => Math.abs(buffer.readFloatBE(start + i * 4) - value) <= epsilon);
}

function locate(buffer: Buffer, mesh: WeightedMesh): { start: number; end: number } {
  const triangles = ints(mesh.triangles), edges = mesh.edges ?? [];
  const tail = Buffer.concat([ints([0, edges.length, ...edges]), floats([mesh.width, mesh.height])]);
  const records: { integers: Buffer; floats?: number[]; tolerance?: number }[] = [];
  let indexCount = 0, payloadBytes = 0;
  for (let i = 0; i < mesh.vertices.length;) {
    const count = mesh.vertices[i++];
    indexCount += count + 1;
    const countBytes = ints([count]);
    records.push({ integers: countBytes });
    payloadBytes += countBytes.length;
    for (let j = 0; j < count; j++) {
      const bone = ints([mesh.vertices[i]]);
      records.push({ integers: bone, floats: mesh.vertices.slice(i + 1, i + 3), tolerance: .0051 });
      records.push({ integers: Buffer.alloc(0), floats: [mesh.vertices[i + 3]], tolerance: .000051 });
      payloadBytes += bone.length + 12;
      i += 4;
    }
  }
  const header = ints([mesh.hull, mesh.uvs.length / 2, indexCount]);
  const candidates = [];
  for (let at = buffer.indexOf(triangles); at >= 0; at = buffer.indexOf(triangles, at + 1)) {
    const end = at + triangles.length + tail.length;
    if (!buffer.subarray(at + triangles.length, end).equals(tail)) continue;
    const uvStart = at - mesh.uvs.length * 4;
    if (!matchesFloats(buffer, uvStart, mesh.uvs, .0000006)) continue;
    const start = uvStart - payloadBytes - header.length;
    if (start < 36 || !buffer.subarray(start, start + header.length).equals(header)) continue;
    let cursor = start + header.length;
    const valid = records.every(record => {
      if (!buffer.subarray(cursor, cursor + record.integers.length).equals(record.integers)) return false;
      cursor += record.integers.length;
      if (!record.floats) return true;
      if (!matchesFloats(buffer, cursor, record.floats, record.tolerance!)) return false;
      cursor += record.floats.length * 4;
      return true;
    });
    if (valid && cursor === uvStart) candidates.push({ start, end });
  }
  if (candidates.length !== 1) throw new Error('二进制 Mesh 记录缺失或有多个相同记录，无法唯一定位目标。');
  return candidates[0];
}

function encode({ mesh, geometry, weights, slice }: Replacement): Buffer {
  const { points, triangles, hull } = geometry;
  const count = weights.reduce((n, vertex) => n + vertex.length + 1, 0);
  const parts = [ints([hull, points.length, count])];
  for (const influences of weights) {
    parts.push(ints([influences.length]));
    for (const [bone, x, y, weight] of influences) parts.push(ints([bone]), floats([x / weight, y / weight, weight]));
  }
  const uv = points.flatMap(([x, y]) => [x / slice.width, y / slice.height]);
  const edges = Array.from({ length: hull }, (_, i) => [i * 2, ((i + 1) % hull) * 2]).flat();
  parts.push(floats(uv), ints(triangles.flat()), ints([0, edges.length, ...edges]), floats([mesh.width, mesh.height]));
  return Buffer.concat(parts);
}

export function replaceMeshRecords(buffer: Buffer, replacements: Replacement[]): Buffer {
  // 4.3.26 的头部含 64 位 hash、版本字符串、五个 float 和 nonessential 标记。
  if (!buffer.subarray(8, 15).equals(Buffer.from('\x074.3.26')) || buffer[35] !== 1) {
    throw new Error('需要 Spine 4.3.26 含 Nonessential 数据的二进制导出。');
  }
  const ranges = replacements.map(item => ({ ...locate(buffer, item.mesh), value: encode(item) })).sort((a, b) => a.start - b.start);
  let cursor = 0;
  const chunks: Buffer[] = [];
  for (const { start, end, value } of ranges) {
    if (start < cursor) throw new Error('多个目标指向同一二进制 Mesh 记录。');
    chunks.push(buffer.subarray(cursor, start), value);
    cursor = end;
  }
  chunks.push(buffer.subarray(cursor));
  return Buffer.concat(chunks);
}

function select(document: Document, target: MeshTarget): WeightedMesh {
  const skin = document.skins?.find((item: Document) => item.name === target.skin);
  const mesh = skin?.attachments?.[target.slot]?.[target.attachment];
  if (!mesh || mesh.type !== 'mesh') throw new Error('目标不是独立 Mesh。' + [target.skin, target.slot, target.attachment].join('/'));
  if (mesh.sequence || !Array.isArray(mesh.uvs) || !Array.isArray(mesh.triangles) || !Array.isArray(mesh.vertices)) {
    throw new Error('不支持带序列或缺失几何数据的 Mesh。');
  }
  return mesh;
}

function sharedMeshes(document: Document): boolean {
  return (document.skins ?? []).some((skin: Document) => Object.values(skin.attachments ?? {}).some(slots =>
    Object.values(slots as Document).some(attachment => ['linkedmesh', 'linkedMesh'].includes(attachment.type))));
}

export function checkExportDiff(before: Document, after: Document, targets: MeshTarget[]): void {
  const removeMeshFields = (input: Document) => {
    const copy = structuredClone(input);
    for (const field of ['hash', 'x', 'y', 'width', 'height']) delete copy.skeleton[field];
    for (const target of targets) {
      const mesh: Document = select(copy, target);
      for (const field of ['uvs', 'triangles', 'vertices', 'hull', 'edges']) delete mesh[field];
    }
    return copy;
  };
  const left = removeMeshFields(before), right = removeMeshFields(after);
  if (!isDeepStrictEqual(left, right)) {
    const changed = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => !isDeepStrictEqual(left[key], right[key]));
    throw new Error('编辑器回读出现目标 Mesh 之外的变化。' + changed.join(', '));
  }
}

export function checkProjectInfo(info: string): void {
  if (!/^\s*Spine version:\s*4\.3\.26\s*$/m.test(info)) throw new UnsupportedMeshError('原生候选仅支持保存版本为 Spine 4.3.26 的工程。');
  if ([...info.matchAll(/^\s*Skeleton:/gm)].length !== 1) throw new UnsupportedMeshError('原生候选仅支持单骨架工程。');
}

async function assertTree(root: string, dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const item = path.join(dir, entry.name);
    resolveWorkspacePath(item, { workspaceRoot: root });
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('源贴图目录包含链接或特殊文件。');
    if (entry.isDirectory()) await assertTree(root, item);
  }
}

async function json(file: string): Promise<Document> {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as Document;
}

type Candidate = { targets: TargetReport[]; artifacts: { project: string; json: string; atlas: string }; native: { version: string; imported: boolean; exportVerified: boolean } };

export async function buildCandidate(
  workspace: string, editor: string, job: ProjectJob, temporary: string,
  checkpoint?: (stage: string) => Promise<void>,
): Promise<Candidate> {
  async function runEditor(stage: string, args: string[]) {
    await checkpoint?.(stage);
    const output = await spine(editor, args, temporary);
    await checkpoint?.(stage);
    return output;
  }

  const source = resolveWorkspacePath(job.project, { workspaceRoot: workspace });
  if (path.extname(source).toLowerCase() !== '.spine' || !(await lstat(source)).isFile()) throw new Error('源工程必须是 .spine 文件。');
  const images = await Promise.all(job.targets.map(async target => {
    const png = resolveWorkspacePath(target.png, { workspaceRoot: workspace });
    return { png, slice: await readSlice(png) };
  }));
  const sourceHash = hash(await readFile(source));
  const beforeDir = path.join(temporary, 'before'), bundle = path.join(temporary, 'project'), unpacked = path.join(temporary, 'unpacked');
  for (const dir of [beforeDir, bundle, unpacked]) await mkdir(dir);
  checkProjectInfo(await runEditor('检查 Spine 工程', ['-i', source]));

  const settings = path.join(temporary, 'binary-settings.json');
  await writeFile(settings, JSON.stringify({ class: 'export-binary', nonessential: true, extension: '.skel', pack: false }));
  await runEditor('导出源 Spine 工程', ['-i', source, '-o', beforeDir, '-e', 'json', '-i', source, '-o', beforeDir, '-e', settings]);
  const names = (await readdir(beforeDir)).filter(name => name.endsWith('.json'));
  if (names.length !== 1 || !/^[^./\\:][^/\\:]*[.]json$/.test(names[0])) throw new Error('无法确定导出的单骨架名称。');
  const stem = names[0].slice(0, -5);
  const original = await json(path.join(beforeDir, names[0]));
  if (original.skeleton?.spine !== EDITOR_VERSION) throw new Error('工程信息和导出的 Spine 版本不一致。');
  if (sharedMeshes(original)) throw new UnsupportedMeshError('工程含关联 Mesh，首版无法保证其顶点共享关系。');
  const poses = samplePoses(original);
  const imagePath = original.skeleton.images;
  if (typeof imagePath !== 'string' || path.isAbsolute(imagePath) || /^[a-z]:/i.test(imagePath) ||
      imagePath.split(/[\\/]/).includes('..') || path.normalize(imagePath) === '.' || path.normalize(imagePath) === '.\\') {
    throw new Error('工程需使用位于工程目录内的独立相对贴图目录。');
  }
  const sourceImages = resolveWorkspacePath(path.join(path.dirname(source), imagePath), { workspaceRoot: workspace });
  if (!(await lstat(sourceImages)).isDirectory()) throw new Error('找不到工程的原始贴图目录。');
  const relativeToImages = path.relative(await realpath(sourceImages), await realpath(temporary));
  if (!relativeToImages || (!relativeToImages.startsWith('..' + path.sep) && !path.isAbsolute(relativeToImages))) {
    throw new Error('候选输出目录不能位于原贴图目录中。');
  }
  await assertTree(workspace, sourceImages);
  const replacements = await Promise.all(job.targets.map(async (target, index) => {
    const mesh = select(original, target);
    decodeWeights(mesh, original.bones.length);
    const assetName = mesh.path || target.attachment;
    const expected = resolveWorkspacePath(path.join(sourceImages, assetName + '.png'), { workspaceRoot: sourceImages });
    const { png, slice } = images[index];
    if (await realpath(expected) !== await realpath(png)) throw new Error('指定 PNG 与目标附件的原始贴图路径不一致。');
    return { mesh, slice, ...optimizeWeightedMesh(mesh, slice, poses, target.landmarks) };
  }));
  const binary = path.join(temporary, stem + '.skel');
  await writeFile(binary, replaceMeshRecords(await readFile(path.join(beforeDir, stem + '.skel')), replacements));
  await cp(sourceImages, path.join(bundle, imagePath), { recursive: true, errorOnExist: true, force: false });
  const project = stem + '.spine', atlas = stem + '.atlas';
  const targetProject = path.join(bundle, project);
  await runEditor('导入并重新导出 Mesh 候选', ['-i', binary, '-o', targetProject, '-r', stem, '-i', targetProject, '-o', bundle, '-e', 'json+pack']);
  await runEditor('解包候选图集', ['-i', bundle, '-o', unpacked, '-c', path.join(bundle, atlas)]);
  const actual = await json(path.join(bundle, names[0]));
  checkExportDiff(original, actual, job.targets);
  const reports: TargetReport[] = [];
  for (const [index, target] of job.targets.entries()) {
    await checkpoint?.('验证 Mesh ' + target.attachment);
    const mesh = select(actual, target);
    const { slice, png } = images[index];
    const old = replacements[index].mesh;
    if (mesh.uvs.length >= old.uvs.length || mesh.uvs.length / 2 !== replacements[index].geometry.points.length) {
      throw new Error('编辑器回读的点数与优化结果不一致。');
    }
    const restored = await readSlice(resolveWorkspacePath((mesh.path || target.attachment) + '.png', { workspaceRoot: unpacked }));
    if (restored.width !== slice.width || restored.height !== slice.height || !Buffer.from(restored.alpha).equals(Buffer.from(slice.alpha))) {
      throw new Error('重新打包后目标贴图的可见像素或尺寸有变化。');
    }
    const numeric = verifyMotion(old, mesh, slice, poses);
    const overlay = 'mesh-overlay-' + (index + 1) + '.png';
    await writeOverlay(png, geometryFromAttachment(mesh, slice), slice, path.join(bundle, overlay));
    reports.push({ skin: target.skin, slot: target.slot, attachment: target.attachment,
      pointsBefore: old.uvs.length / 2, pointsAfter: mesh.uvs.length / 2, overlay, numeric });
  }
  if (hash(await readFile(source)) !== sourceHash) throw new Error('源工程在处理期间有变化。');
  return { targets: reports, artifacts: { project, json: names[0], atlas },
    native: { version: EDITOR_VERSION, imported: true, exportVerified: true } };
}
