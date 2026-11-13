import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { TextureAtlas } from '@esotericsoftware/spine-core';
import { HostError, objectHash, strictHash } from './hostContracts.js';
import { authoringName, invalid, type DraftAsset } from './authoringEdits.js';
import { resolveWorkspacePath, SUPPORTED_SPINE_VERSION, type ToolContext } from './spineJson.js';
import { createMotionRuntime, worldVertices } from './motionRuntime.js';
import { checkpoint, taskSignal } from './taskControl.js';
import { getWorkspaceRoot } from './workspaceTools.js';

export type Json = Record<string, any>;
export type FileHash = { file: string; hash: string };
export type ProjectSkeleton = { name: string; jsonFile: string; imageDir?: string; audioDir?: string; atlasPath?: string; files: FileHash[] };
export type ProjectSource = { source: FileHash; skeletons: ProjectSkeleton[]; native: boolean };
type Image = { name: string; bytes: Buffer; width: number; height: number };

const exec = promisify(execFile);
const io = (file: string, context: ToolContext) => resolveWorkspacePath(file, context);
export const readBytes = (file: string, context: ToolContext) => readFile(io(file, context));
export const readJson = async (file: string, context: ToolContext): Promise<Json> => JSON.parse((await readBytes(file, context)).toString('utf8'));
export const posix = (value: string) => value.replaceAll('\\', '/');
export const within = (...parts: string[]) => path.posix.join(...parts.map(posix));
export const fileHash = async (file: string, context: ToolContext) => ({ file, hash: strictHash(await readBytes(file, context)) });

export async function writeBytes(file: string, bytes: Buffer | string, context: ToolContext) {
  const target = io(file, context);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export async function available(file: string, context: ToolContext) {
  const target = io(file, context);
  try { await access(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function assetName(value: string) {
  const name = posix(value);
  if (!name || name.length > 240 || name.split('/').some(part => !part || part === '..' || part === '.' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    invalid(`资源名称必须是安全的相对路径：${value}。`);
  }
  return name;
}

async function cli(args: string[]) {
  const executable = process.env.SPINE_EDITOR_CLI;
  if (!executable || !path.isAbsolute(executable)) throw new HostError('CLI_UNAVAILABLE', '请将 SPINE_EDITOR_CLI 设为已安装 Spine 命令行的绝对路径。', 503);
  checkpoint('Spine CLI');
  try {
    const result = await exec(executable, ['--hide-license', '-u', SUPPORTED_SPINE_VERSION, ...args], {
      timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal: taskSignal(),
    });
    const log = (result.stdout + '\n' + result.stderr).replace(/^Licensed to:.*$/gim, 'Licensed to: <hidden>');
    if (/\b(?:ERROR|FATAL)\b/i.test(log) || !/Spine 4\.1\.24\b/.test(log)) throw new Error(log.trim() || 'CLI 没有返回匹配的版本。');
  } catch (error) {
    checkpoint('Spine CLI');
    const failure = error as Error & { code?: string; stdout?: string; stderr?: string };
    const detail = (failure.stdout || failure.stderr || failure.message).replace(/^Licensed to:.*$/gim, 'Licensed to: <hidden>').slice(-2400);
    throw new HostError(failure.code === 'ENOENT' ? 'CLI_UNAVAILABLE' : 'CLI_FAILED', `Spine 4.1.24 命令失败：${detail}`, 422);
  }
}

export async function exportNative(source: string, dir: string, context: ToolContext) {
  const config = within(dir, 'export-settings.json'), result = within(dir, 'skeletons');
  await writeBytes(config, JSON.stringify({ class: 'export-json', name: 'JSON', extension: '.json', format: 'JSON',
    nonessential: true, exportAll: true, prettyPrint: true }), context);
  await cli(['-i', io(source, context), '-o', io(result, context), '-e', io(config, context)]);
  const files = (await readdir(io(result, context), { withFileTypes: true })).filter(entry => entry.isFile() && /\.json$/i.test(entry.name));
  if (!files.length) throw new HostError('CLI_FAILED', 'Spine 导出未生成骨架 JSON。', 422);
  return files.map(entry => ({ name: path.basename(entry.name, '.json'), jsonFile: within(result, entry.name) }));
}

function relativeDirectory(source: string, value: unknown, context: ToolContext): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const root = context.workspaceRoot ?? getWorkspaceRoot(context.projectId);
  const directory = path.resolve(path.dirname(io(source, context)), value);
  const relative = posix(path.relative(root, directory));
  // Spine 导出的原始图片目录可能属于另一台机器。仅使用工作区内可解析的路径，atlas 可独立提供资源。
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined;
  if (relative) io(relative, context);
  return relative || '.';
}

export function imageRegions(json: Json): string[] {
  const names = new Set<string>();
  for (const skin of json.skins ?? []) {
    for (const slots of Object.values(skin.attachments ?? {}) as Json[]) {
      for (const [key, value] of Object.entries(slots)) {
        if (!['region', 'mesh', 'linkedmesh'].includes(value.type ?? 'region')) continue;
        const name = assetName(value.path ?? value.name ?? key);
        if (!value.sequence) { names.add(name); continue; }
        const { start = 1, count, digits = 0 } = value.sequence;
        if (!Number.isInteger(count) || count < 1 || count > 4096 || !Number.isInteger(start) || !Number.isInteger(digits) || digits < 0 || digits > 16) invalid(`无效的附件序列：${name}。`);
        for (let i = 0; i < count; i++) names.add(name + String(start + i).padStart(digits, '0'));
      }
    }
  }
  return [...names];
}

function audioNames(json: Json): string[] {
  return [...new Set(Object.values(json.events ?? {}).flatMap(event => {
    const value = event as Json;
    return value.audio ? [assetName(value.audio)] : [];
  }))];
}

async function looseImages(json: Json, dir: string | undefined, context: ToolContext) {
  const found: Record<string, string> = Object.create(null);
  for (const name of imageRegions(json)) {
    if (!dir) continue;
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const file = within(dir, name + ext);
      if (await available(file, context)) { found[name] = file; break; }
    }
  }
  return found;
}

export async function atlasFiles(atlas: string, context: ToolContext) {
  const raw = await readBytes(atlas, context);
  const data = new TextureAtlas(raw.toString('utf8'));
  return [atlas, ...new Set(data.pages.map(page => within(path.posix.dirname(atlas), assetName(page.name))))];
}

export async function readProject(sourceFile: string, cache: string, context: ToolContext, atlasOverride?: string, includeAssets = true): Promise<ProjectSource> {
  const source = await fileHash(sourceFile, context);
  const native = /\.spine$/i.test(sourceFile);
  if (!native && !/\.json$/i.test(sourceFile)) invalid('工程路径必须是 .spine 或 Spine JSON。');
  const list = native ? await exportNative(sourceFile, cache, context) : [{ name: path.basename(sourceFile, path.extname(sourceFile)), jsonFile: sourceFile }];
  const skeletons: ProjectSkeleton[] = [];
  for (const item of list) {
    const json = await readJson(item.jsonFile, context);
    if (!json.skeleton?.spine || !Array.isArray(json.bones)) invalid(`文件缺少 Spine 骨架：${item.jsonFile}。`);
    const imageDir = relativeDirectory(sourceFile, json.skeleton.images, context);
    const audioDir = relativeDirectory(sourceFile, json.skeleton.audio, context) ?? path.posix.dirname(posix(sourceFile));
    const guessed = within(path.posix.dirname(posix(sourceFile)), item.name + '.atlas');
    const atlasPath = atlasOverride ?? (await available(guessed, context) ? guessed : undefined);
    const dependencies = [item.jsonFile];
    if (includeAssets) {
      if (atlasPath) dependencies.push(...await atlasFiles(atlasPath, context));
      dependencies.push(...Object.values(await looseImages(json, imageDir, context)));
      for (const audio of audioNames(json)) {
        const file = within(audioDir, audio);
        if (await available(file, context)) dependencies.push(file);
      }
    }
    skeletons.push({ ...item, imageDir, audioDir, atlasPath, files: await Promise.all([...new Set(dependencies)].map(file => fileHash(file, context))) });
  }
  await verifyFiles([source], context);
  return { source, skeletons, native };
}

export async function verifyFiles(files: FileHash[], context: ToolContext) {
  for (const entry of files) {
    const current = await fileHash(entry.file, context).catch(() => null);
    if (current?.hash !== entry.hash) throw new HostError('TARGET_STALE', `文件已变化或丢失：${entry.file}。`, 409);
  }
}

export function selectSkeleton(project: ProjectSource, name?: string) {
  const selected = name ? project.skeletons.find(skeleton => skeleton.name === name) :
    project.skeletons.length === 1 ? project.skeletons[0] : undefined;
  if (!selected) throw new HostError('SKELETON_SELECTION_REQUIRED', '请明确选择骨架名称。', 409, { skeletons: project.skeletons.map(skeleton => skeleton.name) });
  return selected;
}

async function image(name: string, bytes: Buffer, crop?: { left: number; top: number; width: number; height: number }): Promise<Image> {
  const source = sharp(bytes, { limitInputPixels: 16_777_216 });
  const metadata = await source.metadata();
  if (crop && (crop.left + crop.width > (metadata.width ?? 0) || crop.top + crop.height > (metadata.height ?? 0))) invalid(`裁切超出图片尺寸：${name}。`);
  const { data, info } = await (crop ? source.extract(crop) : source).png().toBuffer({ resolveWithObject: true });
  return { name, bytes: data, width: info.width, height: info.height };
}

export async function prepareAsset(op: Json, dir: string, context: ToolContext, persist: boolean) {
  const name = assetName(op.region);
  const source = await readBytes(op.imagePath, context);
  if (op.crop && !source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid('裁切输入必须是 PNG。');
  const value = await image(name, source, op.crop);
  const asset: DraftAsset = { region: name, source: op.imagePath, sourceHash: strictHash(source), hash: strictHash(value.bytes), width: value.width, height: value.height };
  if (persist) await writeBytes(within(dir, 'assets', asset.hash + '.png'), value.bytes, context);
  return { asset, image: value };
}

async function assetImage(asset: DraftAsset, dir: string, context: ToolContext): Promise<Image> {
  const bytes = await readBytes(within(dir, 'assets', asset.hash + '.png'), context);
  if (strictHash(bytes) !== asset.hash) throw new HostError('TARGET_STALE', `草稿贴图已变化：${asset.region}。`, 409);
  return { name: asset.region, bytes, width: asset.width, height: asset.height };
}

/** 已有 atlas 页保持原样；新切片按行打包，可脱离编辑器预览。 */
async function packImages(images: Image[], output: string, context: ToolContext) {
  const pages: Array<{ width: number; height: number; entries: Array<Image & { x: number; y: number }> }> = [];
  let x = 0, y = 0, row = 0;
  const addPage = () => { x = 0; y = 0; row = 0; const page = { width: 0, height: 0, entries: [] as typeof pages[number]['entries'] }; pages.push(page); return page; };
  let page = addPage();
  for (const entry of images) {
    const width = entry.width + 2, height = entry.height + 2;
    if (width > 4096 || height > 4096) invalid(`贴图超过 4094 像素：${entry.name}。`);
    if (x + width > 4096) { x = 0; y += row; row = 0; }
    if (y + height > 4096) page = addPage();
    page.entries.push({ ...entry, x: x + 1, y: y + 1 });
    page.width = Math.max(page.width, x + width);
    page.height = Math.max(page.height, y + height);
    x += width;
    row = Math.max(row, height);
  }
  const atlas: string[] = [];
  for (const [index, packed] of pages.entries()) {
    if (!packed.entries.length) continue;
    checkpoint('打包贴图');
    const file = `authoring-${objectHash(packed.entries.map(entry => [entry.name, strictHash(entry.bytes)])).slice(0, 20)}-${index}.png`;
    const bytes = await sharp({ create: { width: packed.width, height: packed.height, channels: 4, background: '#00000000' } })
      .composite(packed.entries.map(entry => ({ input: entry.bytes, left: entry.x, top: entry.y }))).png().toBuffer();
    await writeBytes(within(output, file), bytes, context);
    atlas.push([file, `size: ${packed.width},${packed.height}`, 'filter: Linear,Linear', 'repeat: none',
      ...packed.entries.flatMap(entry => [entry.name, `bounds: ${entry.x},${entry.y},${entry.width},${entry.height}`])].join('\n'));
  }
  return atlas.join('\n\n');
}

export async function materializeRuntime(json: Json, source: ProjectSkeleton, assets: DraftAsset[], dir: string, output: string, context: ToolContext, prepared: Image[] = []) {
  const generated = new Map(prepared.map(entry => [entry.name, entry]));
  for (const entry of assets) if (!generated.has(entry.region)) generated.set(entry.region, await assetImage(entry, dir, context));
  let oldAtlas = '';
  const regions = new Set<string>();
  if (source.atlasPath) {
    oldAtlas = (await readBytes(source.atlasPath, context)).toString('utf8').trim();
    const parsed = new TextureAtlas(oldAtlas);
    for (const region of parsed.regions) regions.add(region.name);
    for (const page of parsed.pages) {
      const filename = assetName(page.name);
      await writeBytes(within(output, filename), await readBytes(within(path.posix.dirname(source.atlasPath), filename), context), context);
    }
  }
  const loose = await looseImages(json, source.imageDir, context);
  const missing: string[] = [];
  for (const name of imageRegions(json)) {
    if (regions.has(name)) {
      if (generated.has(name)) invalid(`新贴图与现有 atlas 区域重名：${name}。`);
      continue;
    }
    if (generated.has(name)) continue;
    if (!loose[name]) { missing.push(name); continue; }
    generated.set(name, await image(name, await readBytes(loose[name], context)));
  }
  if (missing.length) throw new HostError('MISSING_ASSET', '以下附件缺少 atlas 区域或原始切片。', 422, { regions: missing });
  const atlas = [oldAtlas, await packImages([...generated.values()], output, context)].filter(Boolean).join('\n\n') + '\n';
  const filePath = within(output, 'skeleton.json'), atlasPath = within(output, 'skeleton.atlas');
  let runtime;
  try { runtime = createMotionRuntime(json, atlas); }
  catch (error) { throw new HostError('RUNTIME_LOAD_FAILED', `Spine runtime 无法加载候选：${(error as Error).message}`, 422); }
  await writeBytes(filePath, JSON.stringify(json), context);
  await writeBytes(atlasPath, atlas, context);
  return { filePath, atlasPath, runtime };
}

async function copyLoose(json: Json, source: ProjectSkeleton, assets: DraftAsset[], dir: string, output: string, context: ToolContext) {
  const generated = new Map(assets.map(asset => [asset.region, asset]));
  const loose = await looseImages(json, source.imageDir, context);
  const missing = imageRegions(json).filter(name => !generated.has(name) && !loose[name]);
  if (missing.length && source.atlasPath) {
    await mkdir(io(output, context), { recursive: true });
    await cli(['-i', path.dirname(io(source.atlasPath, context)), '-o', io(output, context), '-c', io(source.atlasPath, context)]);
  }
  const unresolved: string[] = [];
  for (const name of imageRegions(json)) {
    const entry = generated.get(name);
    const original = loose[name];
    const target = within(output, name + '.png');
    if (entry) await writeBytes(target, (await assetImage(entry, dir, context)).bytes, context);
    else if (original) await writeBytes(target, (await image(name, await readBytes(original, context))).bytes, context);
    else if (!await available(target, context)) unresolved.push(name);
  }
  if (unresolved.length) throw new HostError('MISSING_ASSET', '原生工程缺少可编辑切片。', 422, { regions: unresolved });
}

const defaults: Record<string, Record<string, unknown>> = {
  bones: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, length: 0, transform: 'normal', skin: false },
  slots: { color: 'ffffffff', blend: 'normal' },
  rotate: { time: 0, value: 0 }, translate: { time: 0, x: 0, y: 0 }, scale: { time: 0, x: 1, y: 1 }, shear: { time: 0, x: 0, y: 0 },
  attachment: { time: 0, name: null }, drawOrder: { time: 0, offsets: [] }, draworder: { time: 0, offsets: [] },
  region: { type: 'region', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, color: 'ffffffff' },
  mesh: { color: 'ffffffff' },
};

function orderedTriangleKeys(indices: number[]) {
  const keys = [];
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = indices.slice(i, i + 3);
    const start = triangle.indexOf(Math.min(...triangle));
    keys.push([...triangle.slice(start), ...triangle.slice(0, start)].join(','));
  }
  return keys.sort();
}

function weightedVerticesByBone(mesh: Json) {
  const { vertices, uvs } = mesh;
  if (!Array.isArray(vertices) || !Array.isArray(uvs) || vertices.length === uvs.length) return undefined;
  const points: number[][] = [];
  let offset = 0;
  for (let i = 0; i < uvs.length / 2; i++) {
    const count = vertices[offset++];
    if (!Number.isInteger(count) || count < 1 || offset + count * 4 > vertices.length) return undefined;
    const influences = Array.from({ length: count }, () => {
      const values = vertices.slice(offset, offset + 4) as number[];
      offset += 4;
      return values;
    });
    if (new Set(influences.map(([bone]) => bone)).size !== count) return undefined;
    points.push(influences.sort(([left], [right]) => left - right).flat());
  }
  return offset === vertices.length ? points : undefined;
}

function normalizeIndependentMeshWeights(json: Json) {
  const result = structuredClone(json);
  for (const skin of result.skins ?? []) {
    for (const [slot, entries] of Object.entries(skin.attachments ?? {}) as Array<[string, Json]>) {
      for (const [name, mesh] of Object.entries(entries)) {
        if (mesh.type !== 'mesh') continue;
        const hasDeform = (Object.values(result.animations ?? {}) as Json[]).some(animation =>
          animation.attachments?.[skin.name]?.[slot]?.[name]?.deform !== undefined ||
          animation.deform?.[skin.name]?.[slot]?.[name] !== undefined);
        const hasLinkedMesh = (result.skins ?? []).some((other: Json) =>
          (Object.values(other.attachments?.[slot] ?? {}) as Json[]).some(entry =>
            entry.type === 'linkedmesh' && entry.parent === name && (entry.skin ?? other.name) === skin.name));
        if (hasDeform || hasLinkedMesh) continue;
        const points = weightedVerticesByBone(mesh);
        if (points) mesh.vertices = points.flatMap(point => [point.length / 4, ...point]);
      }
    }
  }
  return result;
}

function sameMeshVertices(expected: Json, actual: Json) {
  if (!Array.isArray(expected.vertices) || !Array.isArray(actual.vertices) ||
      !Array.isArray(expected.uvs) || !Array.isArray(actual.uvs) ||
      expected.uvs.length !== actual.uvs.length || expected.vertices.length !== actual.vertices.length) return false;
  const sameCoordinates = (left: number, right: number) => Math.abs(left - right) <= 0.00501;
  if (expected.vertices.length === expected.uvs.length) {
    return expected.vertices.every((value: number, i: number) => sameCoordinates(value, actual.vertices[i]));
  }
  let offset = 0;
  for (let i = 0; i < expected.uvs.length / 2; i++) {
    const count = expected.vertices[offset];
    if (!Number.isInteger(count) || count < 1 || count !== actual.vertices[offset++]) return false;
    for (let n = 0; n < count; n++, offset += 4) {
      if (expected.vertices[offset] !== actual.vertices[offset] ||
          !sameCoordinates(expected.vertices[offset + 1], actual.vertices[offset + 1]) ||
          !sameCoordinates(expected.vertices[offset + 2], actual.vertices[offset + 2]) ||
          !(Math.abs(expected.vertices[offset + 3] - actual.vertices[offset + 3]) <= 0.00051)) return false;
    }
  }
  return offset === expected.vertices.length;
}

function isGeneratedHullEdges(hull: number, edges: unknown) {
  if (!Number.isInteger(hull) || hull < 3 || !Array.isArray(edges) || edges.length !== hull * 2) return false;
  const expected = [0, 2 * (hull - 1)];
  for (let i = 0; i < hull - 1; i++) expected.push(2 * i, 2 * (i + 1));
  return edges.every((value, i) => value === expected[i]);
}

function roundtripDifferences(expected: any, actual: any, key = '', location = '', differences: string[] = []) {
  if (differences.length >= 20 || Object.is(expected, actual)) return differences;
  if (typeof expected === 'number' && typeof actual === 'number' && Math.abs(expected - actual) <= 0.00051) return differences;
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
    // The editor can reorder mesh triangles while preserving their indices and winding.
    if (key === 'triangles' && location.startsWith('/skins/') && location.includes('/attachments/') &&
        expected.length % 3 === 0 && expected.every(Number.isInteger) && actual.every(Number.isInteger) &&
        JSON.stringify(orderedTriangleKeys(expected)) === JSON.stringify(orderedTriangleKeys(actual))) return differences;
    expected.forEach((value, i) => {
      const candidate = actual[i], next = expected[i + 1];
      const channels = key === 'rotate' ? ['value'] : ['translate', 'scale', 'shear'].includes(key) ? ['x', 'y'] : [];
      const fallback = key === 'scale' ? 1 : 0;
      if (channels.length && next && candidate && value.curve === undefined && candidate.curve === 'stepped' &&
          channels.every(channel => (value[channel] ?? fallback) === (next[channel] ?? fallback))) {
        const { curve: _curve, ...rest } = candidate;
        roundtripDifferences(value, rest, key, `${location}/${i}`, differences);
      } else roundtripDifferences(value, candidate, key, `${location}/${i}`, differences);
    });
  } else if (expected && actual && !Array.isArray(expected) && !Array.isArray(actual) && typeof expected === 'object' && typeof actual === 'object') {
    const scope = location.includes('/attachments/') && (expected.type || actual.type || expected.width) ? (expected.type ?? actual.type ?? 'region') : key;
    const empty = (v: any) => Array.isArray(v) ? !v.length : v && typeof v === 'object' && !Object.keys(v).length;
    for (const field of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (location === '/skeleton' && field === 'hash') continue;
      if ((expected[field] === undefined && empty(actual[field])) || (actual[field] === undefined && empty(expected[field]))) continue;
      if (location.includes('/attachments/') && field === 'path' && (expected[field] ?? key) === (actual[field] ?? key)) continue;
      // The editor exports mesh coordinates at two decimal places. Bone indices and weights are checked separately.
      if (location.startsWith('/skins/') && scope === 'mesh' && field === 'vertices' && sameMeshVertices(expected, actual)) continue;
      if (location.startsWith('/skins/') && scope === 'mesh' && field === 'edges' &&
          !expected.edges?.length && isGeneratedHullEdges(expected.hull, actual.edges)) continue;
      const fallback = defaults[scope]?.[field];
      roundtripDifferences(expected[field] === undefined ? fallback : expected[field], actual[field] === undefined ? fallback : actual[field], field, `${location}/${field}`, differences);
    }
  } else differences.push(location || '/');
  return differences;
}

export async function buildNativeProject(project: ProjectSource, selected: string, animation: string, candidate: Json, assets: DraftAsset[], dir: string,
  output: string, work: string, context: ToolContext) {
  const input = within(work, 'input');
  const expected: Array<{ name: string; json: Json; source: ProjectSkeleton }> = [];
  for (const [index, source] of project.skeletons.entries()) {
    const name = assetName(authoringName(source.name, '骨架'));
    if (name.includes('/')) invalid('原生工程骨架名称不能包含路径分隔符。');
    const json = source.name === selected ? structuredClone(candidate) : await readJson(source.jsonFile, context);
    const images = `assets/${index}/images/`, audio = `assets/${index}/audio/`;
    const added = source.name === selected ? assets : [];
    await copyLoose(json, source, added, dir, within(output, images), context);
    for (const file of audioNames(json)) {
      const original = source.audioDir ? within(source.audioDir, file) : undefined;
      if (!original || !await available(original, context)) throw new HostError('MISSING_ASSET', `音频资源缺失：${file}。`, 422);
      await writeBytes(within(output, audio, file), await readBytes(original, context), context);
    }
    json.skeleton.images = './' + images;
    json.skeleton.audio = audioNames(json).length ? './' + audio : '';
    await writeBytes(within(input, name + '.json'), JSON.stringify(json), context);
    expected.push({ name, json, source });
  }
  await mkdir(io(output, context), { recursive: true });
  const spine = within(output, 'animation.spine');
  await cli(['-i', io(input, context), '-o', io(spine, context), '-r']);
  const readback = await exportNative(spine, within(work, 'readback'), context);
  if (expected.length !== readback.length) throw new HostError('CLI_READBACK_MISMATCH', '复开后骨架数量不一致。', 422);
  const checked = [];
  for (const item of expected) {
    const entry = readback.find(value => value.name === item.name);
    if (!entry) throw new HostError('CLI_READBACK_MISMATCH', `复开缺少骨架 ${item.name}。`, 422);
    const actual = await readJson(entry.jsonFile, context);
    const differences = roundtripDifferences(normalizeIndependentMeshWeights(item.json), normalizeIndependentMeshWeights(actual));
    if (differences.length) throw new HostError('CLI_READBACK_MISMATCH', `复开后骨架 ${item.name} 数据与候选不一致。`, 422, { differences });
    const material = await materializeRuntime(actual, { ...item.source, atlasPath: undefined, imageDir: within(output, actual.skeleton.images) },
      [], dir, within(work, 'runtime', item.name), context);
    const original = await readJson(item.source.jsonFile, context);
    const baseline = item.name === selected && assets.length ? await materializeRuntime(original, item.source, [], dir,
      within(work, 'baseline', item.name), context) : null;
    const replaced = new Map<string, Set<string>>();
    if (baseline) {
      const generatedRegions = new Set(assets.map(asset => asset.region));
      for (const oldSkin of original.skins ?? []) {
        const nextSkin = item.json.skins?.find((skin: Json) => skin.name === oldSkin.name);
        const keys = new Set<string>();
        for (const [slot, entries] of Object.entries(oldSkin.attachments ?? {}) as Array<[string, Json]>) {
          for (const [name, old] of Object.entries(entries)) {
            const next = nextSkin?.attachments?.[slot]?.[name];
            if (next && next.path !== old.path && generatedRegions.has(next.path)) keys.add(slot + ':' + (old.name ?? name));
          }
        }
        replaced.set(oldSkin.name, keys);
      }
    }
    let preservedAnimationSamples = 0;
    for (const name of Object.keys(actual.animations ?? {})) {
      const duration = material.runtime.data.findAnimation(name)?.duration ?? 0;
      for (const skin of material.runtime.data.skins) {
        const runtime = material.runtime;
        if (!baseline || name === animation || !baseline.runtime.data.findSkin(skin.name) || !Object.hasOwn(original.animations ?? {}, name)) {
          worldVertices(runtime.sample(name, duration / 2, skin.name));
          continue;
        }
        for (const time of new Set([0, duration / 2, duration])) {
          const before = worldVertices(baseline.runtime.sample(name, time, skin.name));
          const after = worldVertices(runtime.sample(name, time, skin.name));
          const keys = Object.keys(before);
          const selectedReplacements = replaced.get(skin.name), defaultReplacements = replaced.get('default');
          const affected = (key: string) => selectedReplacements?.has(key) || defaultReplacements?.has(key);
          if (JSON.stringify(keys) !== JSON.stringify(Object.keys(after)) ||
              keys.some(key => !affected(key) && (before[key].length !== after[key].length || before[key].some((value, i) => Math.abs(value - after[key][i]) > 0.15)))) {
            throw new HostError('CLI_READBACK_MISMATCH', `旧动画 ${name} 的 ${skin.name} 皮肤在 ${time}s 的切片回读发生变化。`, 422);
          }
          preservedAnimationSamples++;
        }
      }
    }
    checked.push({ skeleton: item.name, animations: Object.keys(actual.animations ?? {}), skins: material.runtime.data.skins.map(skin => skin.name),
      preservedAnimationSamples, hash: await fileHash(entry.jsonFile, context).then(value => value.hash) });
  }
  return { filename: 'animation.spine', sha256: (await fileHash(spine, context)).hash, editorImport: { version: SUPPORTED_SPINE_VERSION, skeletons: checked,
    scope: '已核验可导出骨架、动画、皮肤、贴图与 runtime 采样。编辑器视图及导出格式未包含的内部状态不在此报告覆盖范围。' } };
}
