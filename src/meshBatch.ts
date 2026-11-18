import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGeometry, parseLandmarks, readSlice, writeOverlay, type Landmark } from './meshGeometry.js';
import { UnsupportedMeshError } from './meshMotion.js';
import { buildCandidate, type MeshTarget, type ProjectJob } from './meshSpine43.js';
import { resolveWorkspacePath } from './spineJson.js';

type Job = ProjectJob | { id: string; skip: string };
type Item = { id: string; status: 'planned' | 'built' | 'skipped' | 'failed'; reason?: string; explicit?: boolean;
  report?: string; overlay?: string; mesh?: string; project?: string; points?: number; targets?: { pointsBefore: number; pointsAfter: number }[] };

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\x00')) throw new Error(label + ' 必须是非空字符串。');
  return value;
}

async function fromJson(file: string): Promise<unknown> {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
}

function member(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('批处理清单项必须是对象。');
  return value as Record<string, unknown>;
}

function parseJobs(input: unknown, defaults: Landmark[]): Job[] {
  const list = member(input).projects;
  if (!Array.isArray(list) || !list.length) throw new Error('批处理清单需提供非空 projects 数组。');
  const ids = new Set<string>();
  return list.map(entry => {
    const object = member(entry);
    const id = string(object.id, '项目 id');
    if (!/^[\p{L}\p{N}_-]+$/u.test(id) || ids.has(id.toLowerCase())) throw new Error('项目 id 无效或重复。' + id);
    ids.add(id.toLowerCase());
    if (object.skip !== undefined) return { id, skip: string(object.skip, '跳过原因') };
    const project = string(object.project, '源工程路径');
    if (!Array.isArray(object.targets) || !object.targets.length) throw new Error('需为项目指定至少一个目标 Mesh。' + id);
    const members = new Set<string>();
    const targets: MeshTarget[] = object.targets.map(target => {
      const t = member(target);
      const skin = string(t.skin, 'skin'), slot = string(t.slot, 'slot'), attachment = string(t.attachment, 'attachment');
      const key = JSON.stringify([skin, slot, attachment]);
      if (members.has(key)) throw new Error('同一工程存在重复的 Mesh 选择。' + key);
      members.add(key);
      const landmarks = t.landmarks === undefined ? defaults : [...defaults, ...parseLandmarks(t.landmarks)];
      if (landmarks.length > 64) throw new Error('同一附件最多 64 个地标。');
      return { skin, slot, attachment, png: string(t.png, 'PNG 路径'), landmarks };
    });
    return { id, project, targets };
  });
}

async function save(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function failure(id: string, error: unknown): Item {
  return { id, status: error instanceof UnsupportedMeshError ? 'skipped' : 'failed',
    reason: error instanceof Error ? error.message : String(error) };
}

export type MeshBatchReport = { mode: 'plan' | 'candidate'; items: Item[] };
type BatchOptions = { workspace: string; outputDir: string; landmarksPath?: string };
type BatchResult = { outputDir: string; report: MeshBatchReport };
export type MeshBatchHooks = {
  checkpoint?: (stage: string) => Promise<void>;
  progress?: (current: number, total: number, stage: string) => void;
};

export function meshBatchExitCode(report: MeshBatchReport): number {
  return Number(report.items.some(item => item.status === 'failed' || (item.status === 'skipped' && !item.explicit)));
}

async function stageItem(
  out: string, id: string, process: (scratch: string) => Promise<Item>, hooks: MeshBatchHooks,
): Promise<Item> {
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(path.join(out, '.mesh-'));
    return await process(scratch);
  } catch (error) {
    await hooks.checkpoint?.('Mesh 批次');
    return failure(id, error);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

async function prepare({ workspace: requested, outputDir, landmarksPath }: BatchOptions) {
  const workspace = await realpath(path.resolve(requested));
  const context = { workspaceRoot: workspace };
  const out = resolveWorkspacePath(string(outputDir, '--out'), context);
  const landmarks = landmarksPath ? parseLandmarks(await fromJson(resolveWorkspacePath(landmarksPath, context))) : [];
  return { workspace, context, out, landmarks };
}

async function runBatch<T extends { id: string }>(
  workspace: string, out: string, mode: MeshBatchReport['mode'], entries: T[],
  process: (entry: T) => Promise<Item>, hooks: MeshBatchHooks,
): Promise<BatchResult> {
  // 独占创建新目录，当前批次的产物不覆盖已有目录。
  await hooks.checkpoint?.('创建 Mesh 输出目录');
  await mkdir(out);
  const items: Item[] = [];
  hooks.progress?.(0, entries.length, '开始 Mesh 批次');
  for (const entry of entries) {
    await hooks.checkpoint?.('处理 Mesh ' + entry.id);
    items.push(await process(entry));
    hooks.progress?.(items.length, entries.length, '已处理 Mesh ' + entry.id);
  }
  await hooks.checkpoint?.('保存 Mesh 批次摘要');
  const report = { mode, items };
  await save(path.join(out, 'summary.json'), report);
  return { outputDir: path.relative(workspace, out).split(path.sep).join('/'), report };
}

export async function runMeshPlan(options: BatchOptions & { inputPath: string }, hooks: MeshBatchHooks = {}) {
  const { workspace, context, out, landmarks } = await prepare(options);
  const { inputPath } = options;
  const requested = path.resolve(workspace, string(inputPath, '--input'));
  const input = requested === workspace ? workspace : resolveWorkspacePath(requested, context);
  const stat = await lstat(input);
  const files = stat.isDirectory() ? (await readdir(input, { withFileTypes: true }))
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && /\.png$/i.test(entry.name))
    .map(entry => path.join(input, entry.name)).sort() : [input];
  if (!files.length || files.some(file => path.extname(file).toLowerCase() !== '.png')) throw new Error('找不到可用的 PNG。');
  if (new Set(files.map(file => path.basename(file).slice(0, -4).toLowerCase())).size !== files.length) {
    throw new Error('切片文件名冲突。');
  }
  const entries = files.map(file => ({ file, id: path.basename(file, path.extname(file)) }));
  return runBatch(workspace, out, 'plan', entries, entry => stageItem(out, entry.id, async scratch => {
    const { file, id } = entry;
    const source = resolveWorkspacePath(file, context);
    const slice = await readSlice(source), geometry = createGeometry(slice, landmarks);
    await save(path.join(scratch, 'mesh.json'), {
      width: slice.width, height: slice.height, hull: geometry.hull,
      uv: geometry.points.map(([x, y]) => [x / slice.width, y / slice.height]), triangles: geometry.triangles,
    });
    await writeOverlay(source, geometry, slice, path.join(scratch, 'overlay.png'));
    await hooks.checkpoint?.('发布布点产物 ' + id);
    await rename(scratch, path.join(out, id));
    return { id, status: 'planned', points: geometry.points.length, overlay: id + '/overlay.png', mesh: id + '/mesh.json' };
  }, hooks), hooks);
}

export async function runMeshCandidate(options: BatchOptions & { jobPath: string; editor: string }, hooks: MeshBatchHooks = {}) {
  const { workspace, context, out, landmarks } = await prepare(options);
  const editor = path.resolve(string(options.editor, '--spine'));
  if (!(await lstat(editor)).isFile()) throw new Error('--spine 必须指向本地编辑器可执行文件。');
  const jobFile = resolveWorkspacePath(string(options.jobPath, '--job'), context);
  const jobs = parseJobs(await fromJson(jobFile), landmarks);
  return runBatch(workspace, out, 'candidate', jobs, async job => {
    if ('skip' in job) return { id: job.id, status: 'skipped', explicit: true, reason: job.skip };
    return stageItem(out, job.id, async scratch => {
      const report = await buildCandidate(workspace, editor, job, scratch, hooks.checkpoint);
      const bundle = path.join(scratch, 'project');
      await save(path.join(bundle, 'mesh-report.json'), { ...report, visual: 'overlay-generated' });
      await hooks.checkpoint?.('发布 Mesh 候选 ' + job.id);
      await rename(bundle, path.join(out, job.id));
      return { id: job.id, status: 'built', report: job.id + '/mesh-report.json',
        project: job.id + '/' + report.artifacts.project,
        targets: report.targets.map(({ pointsBefore, pointsAfter }) => ({ pointsBefore, pointsAfter })) };
    }, hooks);
  }, hooks);
}
