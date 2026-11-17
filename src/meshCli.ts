#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createGeometry, parseLandmarks, readSlice, writeOverlay, type Landmark } from './meshGeometry.js';
import { UnsupportedMeshError } from './meshMotion.js';
import { buildCandidate, type MeshTarget, type ProjectJob } from './meshSpine43.js';
import { resolveWorkspacePath } from './spineJson.js';

const help = [
  '用法',
  '  mesh plan --input <PNG 或目录> --out <新目录> [--landmarks <JSON>] [--workspace <根目录>]',
  '  mesh candidate --job <清单 JSON> --spine <Spine.com 路径> --out <新目录> [--landmarks <JSON>] [--workspace <根目录>]',
  '工作区默认为当前目录。每项结果写入新目录，批次摘要输出为 JSON。',
].join('\n');

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

async function stageItem(out: string, id: string, process: (scratch: string) => Promise<Item>): Promise<Item> {
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(path.join(out, '.mesh-'));
    return await process(scratch);
  } catch (error) {
    return failure(id, error);
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

async function plan(files: string[], workspace: string, out: string, landmarks: Landmark[]): Promise<Item[]> {
  const items: Item[] = [];
  for (const file of files) {
    const id = path.basename(file, path.extname(file));
    items.push(await stageItem(out, id, async scratch => {
      const source = resolveWorkspacePath(file, { workspaceRoot: workspace });
      const slice = await readSlice(source), geometry = createGeometry(slice, landmarks);
      await save(path.join(scratch, 'mesh.json'), {
        width: slice.width, height: slice.height, hull: geometry.hull,
        uv: geometry.points.map(([x, y]) => [x / slice.width, y / slice.height]), triangles: geometry.triangles,
      });
      await writeOverlay(source, geometry, slice, path.join(scratch, 'overlay.png'));
      await rename(scratch, path.join(out, id));
      return { id, status: 'planned', points: geometry.points.length, overlay: id + '/overlay.png', mesh: id + '/mesh.json' };
    }));
  }
  return items;
}

async function candidate(jobs: Job[], workspace: string, out: string, editor: string): Promise<Item[]> {
  const items: Item[] = [];
  for (const job of jobs) {
    if ('skip' in job) {
      items.push({ id: job.id, status: 'skipped', explicit: true, reason: job.skip });
      continue;
    }
    items.push(await stageItem(out, job.id, async scratch => {
      const report = await buildCandidate(workspace, editor, job, scratch);
      const bundle = path.join(scratch, 'project');
      await save(path.join(bundle, 'mesh-report.json'), { ...report, visual: 'overlay-generated' });
      await rename(bundle, path.join(out, job.id));
      return { id: job.id, status: 'built', report: job.id + '/mesh-report.json',
        project: job.id + '/' + report.artifacts.project,
        targets: report.targets.map(({ pointsBefore, pointsAfter }) => ({ pointsBefore, pointsAfter })) };
    }));
  }
  return items;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    input: { type: 'string' }, out: { type: 'string' }, job: { type: 'string' }, spine: { type: 'string' },
    workspace: { type: 'string' }, landmarks: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    process.stdout.write(help + '\n');
    return 0;
  }
  const mode = positionals[0];
  if (positionals.length !== 1 || (mode !== 'plan' && mode !== 'candidate')) throw new Error(help);
  const workspace = await realpath(path.resolve(values.workspace ?? '.'));
  const context = { workspaceRoot: workspace };
  const out = resolveWorkspacePath(string(values.out, '--out'), context);
  const landmarks = values.landmarks ? parseLandmarks(await fromJson(resolveWorkspacePath(values.landmarks, context))) : [];
  let run: () => Promise<Item[]>;
  if (mode === 'plan') {
    if (values.job || values.spine) throw new Error('plan 使用 --input。');
    const requested = path.resolve(workspace, string(values.input, '--input'));
    const input = requested === workspace ? workspace : resolveWorkspacePath(requested, context);
    const stat = await lstat(input);
    const files = stat.isDirectory() ? (await readdir(input, { withFileTypes: true }))
      .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && /\.png$/i.test(entry.name))
      .map(entry => path.join(input, entry.name)).sort() : [input];
    if (!files.length || files.some(file => path.extname(file).toLowerCase() !== '.png')) throw new Error('找不到可用的 PNG。');
    if (new Set(files.map(file => path.basename(file).slice(0, -4).toLowerCase())).size !== files.length) {
      throw new Error('切片文件名冲突。');
    }
    run = () => plan(files, workspace, out, landmarks);
  } else {
    if (values.input) throw new Error('candidate 使用 --job。');
    const editor = path.resolve(string(values.spine, '--spine'));
    if (!(await lstat(editor)).isFile()) throw new Error('--spine 必须指向本地编辑器可执行文件。');
    const jobFile = resolveWorkspacePath(string(values.job, '--job'), context);
    const jobs = parseJobs(await fromJson(jobFile), landmarks);
    run = () => candidate(jobs, workspace, out, editor);
  }
  // mkdir without recursive/existing flags reserves a clean, separate output root.
  await mkdir(out);
  const items = await run();
  const report = { mode, items };
  await save(path.join(out, 'summary.json'), report);
  process.stdout.write(JSON.stringify(report) + '\n');
  return Number(items.some(item => item.status === 'failed' || (item.status === 'skipped' && !item.explicit)));
}

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
