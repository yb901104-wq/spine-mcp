import { mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { authoringName, animationDuration, editCandidate, invalid, type DraftAsset, type Track } from './authoringEdits.js';
import { available, buildNativeProject, fileHash, imageRegions, materializeRuntime, posix, prepareAsset, readJson, readProject, selectSkeleton, verifyFiles,
  within, writeBytes, type Json, type ProjectSource } from './authoringProject.js';
import { comparisonReference, measureDraft, renderDraftComparison, renderDraftView } from './authoringPreview.js';
import { atomicRecord, currentHash, draftDir, draftState, draftSummary, loadCandidate, loadDraft, observeDraft, saveCandidate,
  type Candidate, type Draft } from './authoringStore.js';
import { HostError, objectHash } from './hostContracts.js';
import { withFileLock } from './jobTools.js';
import { readReferenceFrames } from './referenceTools.js';
import { resolveWorkspacePath, SUPPORTED_SPINE_VERSION, type ToolContext } from './spineJson.js';
import { checkpoint } from './taskControl.js';

const scratch = () => `previews/authoring/${randomUUID()}`;

async function cleanDirectory(relative: string, context: ToolContext) {
  const file = resolveWorkspacePath(relative, context);
  if (!/^\.(?:candidate|authoring)-[0-9a-f-]{36}$/.test(path.basename(file))) throw new Error('拒绝清理非本次任务目录。');
  await rm(file, { recursive: true, force: true }).catch(error => process.stderr.write(`临时目录待清理：${relative}（${String(error)}）\n`));
}

function sourceDependencies(project: ProjectSource, assets: DraftAsset[] = []) {
  return [project.source, ...project.skeletons.flatMap(skeleton => skeleton.files),
    ...assets.map(asset => ({ file: asset.source, hash: asset.sourceHash }))];
}

function assertWritable(json: Json) {
  if (json.skeleton.spine !== SUPPORTED_SPINE_VERSION) {
    throw new HostError('UNSUPPORTED_VERSION', `动画草稿写入仅支持 Spine ${SUPPORTED_SPINE_VERSION}，输入为 ${json.skeleton.spine}。`, 422);
  }
}

function page(items: unknown[], args: Json) {
  const offset = args.offset ?? 0, limit = args.limit ?? 16;
  return { items: items.slice(offset, offset + limit), count: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
}

function readTrack(animation: Json, track: Track) {
  if (track.kind === 'drawOrder') return animation.drawOrder ?? animation.draworder ?? [];
  const parent = track.kind === 'bone' ? animation.bones : animation.slots;
  const name = authoringName(track.name, '轨道对象'), timeline = authoringName(track.timeline, 'timeline');
  return parent && Object.hasOwn(parent, name) && Object.hasOwn(parent[name], timeline) ? parent[name][timeline] : [];
}

async function inspect(args: Json, context: ToolContext) {
  const view = args.view ?? 'summary';
  const output = scratch(), project = await readProject(args.filePath, within(output, 'source'), context, args.atlasPath, view === 'frame' || view === 'gif');
  if (view === 'summary' && !args.skeleton) {
    const catalog = await Promise.all(project.skeletons.map(async entry => {
      const json = await readJson(entry.jsonFile, context);
      return { name: entry.name, version: json.skeleton.spine, bones: json.bones.length, slots: json.slots?.length ?? 0,
        skins: json.skins?.map((skin: Json) => skin.name) ?? [], animations: Object.entries(json.animations ?? {})
          .map(([name, value]) => ({ name, duration: animationDuration(value) })), atlasPath: entry.atlasPath ?? null };
    }));
    return { source: project.source, skeletons: catalog };
  }
  const selected = selectSkeleton(project, args.skeleton), json = await readJson(selected.jsonFile, context);
  const result = { source: project.source, skeleton: selected.name, version: json.skeleton.spine, view };
  if (view === 'timeline' || view === 'frame' || view === 'gif') {
    const name = authoringName(args.animation, '动画');
    const animation = Object.hasOwn(json.animations ?? {}, name) ? json.animations[name] : undefined;
    if (!animation) invalid(`动画不存在：${name}。`);
    if (view === 'timeline') {
      if (!args.track) {
        const tracks = [
          ...Object.entries(animation.bones ?? {}).flatMap(([name, timelines]) => Object.keys(timelines as Json).map(timeline => ({ kind: 'bone', name, timeline }))),
          ...Object.entries(animation.slots ?? {}).flatMap(([name, timelines]) => Object.keys(timelines as Json).map(timeline => ({ kind: 'slot', name, timeline }))),
          ...(animation.drawOrder || animation.draworder ? [{ kind: 'drawOrder' }] : []),
        ];
        return { ...result, animation: name, duration: animationDuration(animation), ...page(tracks, args) };
      }
      if (args.end !== undefined && args.start !== undefined && args.end < args.start) invalid('查询区间结束时间早于起始时间。');
      const frames = readTrack(animation, args.track).filter((frame: Json) => (frame.time ?? 0) >= (args.start ?? 0) && (frame.time ?? 0) <= (args.end ?? Infinity));
      return { ...result, animation: name, track: args.track, duration: animationDuration(animation), ...page(frames, args) };
    }
    const material = await materializeRuntime(json, selected, [], output, within(output, 'runtime'), context);
    return { ...result, animation: name, ...await renderDraftView({ ...args, view }, material, name, within(output, 'render'), context) };
  }
  if (view === 'summary') return { ...result, bones: json.bones.length, slots: json.slots?.length ?? 0, skins: json.skins?.map((skin: Json) => skin.name) ?? [],
    animations: Object.entries(json.animations ?? {}).map(([name, value]) => ({ name, duration: animationDuration(value) })) };
  const entries: Json[] = view === 'constraints' ? ['ik', 'transform', 'path', 'physics'].flatMap(kind => (json[kind] ?? []).map((item: Json) => ({ ...item, kind }))) :
    view === 'attachments' ? (json.skins ?? []).flatMap((skin: Json) => Object.entries(skin.attachments ?? {}).flatMap(([slot, attachments]) =>
      Object.entries(attachments as Json).map(([name, value]) => ({ name, slot, skin: skin.name, ...value })))) :
      view === 'skins' ? (json.skins ?? []).map((skin: Json) => ({ name: skin.name, slots: Object.keys(skin.attachments ?? {}) })) : json[view] ?? [];
  return { ...result, ...page(entries.filter(item => (!args.name || item.name === args.name) && (!args.skin || view !== 'attachments' || item.skin === args.skin)), args) };
}

async function openDraft(args: Json, context: ToolContext) {
  const draftId = randomUUID(), dir = draftDir(draftId);
  const project = await readProject(args.filePath, within(dir, 'source'), context, args.atlasPath);
  const source = selectSkeleton(project, args.skeleton), json = await readJson(source.jsonFile, context);
  assertWritable(json);
  const name = authoringName(args.animation, '动画');
  json.animations ??= {};
  const exists = Object.hasOwn(json.animations, name);
  if (args.mode === 'edit' && !exists) invalid(`找不到动画 ${name}。`);
  if (args.mode === 'create' && exists) invalid(`动画 ${name} 已存在，请使用 edit 或指定新名称。`);
  if (!exists) json.animations[name] = {};
  const hash = await saveCandidate(draftId, { json, assets: [] }, context);
  const draft: Draft = { version: 1, draftId, project, skeleton: source.name, animation: name, revision: 0, revisions: [hash], past: [], future: [] };
  checkpoint('创建动画草稿');
  await atomicRecord(draftState(draftId), draft, context);
  await observeDraft({ draftId, animation: name, revision: 0, status: 'edited' }, context, { opened: true });
  return { ...draftSummary(draft), resources: { atlasPath: source.atlasPath ?? null, imagesDirectory: source.imageDir ?? null, files: source.files.length } };
}

function checkRevision(draft: Draft, expected: number) {
  if (draft.revision !== expected) throw new HostError('REVISION_CONFLICT', `草稿当前修订是 ${draft.revision}，请求为 ${expected}。`, 409, draftSummary(draft));
}

async function editDraft(args: Json, context: ToolContext) {
  const id = args.draftId, state = draftState(id);
  if (Boolean(args.ops) === Boolean(args.history)) invalid('请提供 ops 或 history 中的一项。');
  return withFileLock(state, context, async () => {
    const draft = await loadDraft(id, context), before = currentHash(draft), dir = draftDir(id);
    checkRevision(draft, args.expectedRevision);
    const persist = args.dryRun === false;
    let next: string, past: string[], future: string[];
    if (args.history) {
      const source = args.history === 'undo' ? draft.past : draft.future;
      const hash = source.at(-1);
      if (!hash) invalid(args.history === 'undo' ? '没有可撤销的修订。' : '没有可重做的修订。');
      next = hash;
      past = args.history === 'undo' ? draft.past.slice(0, -1) : [...draft.past, before];
      future = args.history === 'undo' ? [...draft.future, before] : draft.future.slice(0, -1);
      const candidate = await loadCandidate(id, next, context);
      await verifyFiles(sourceDependencies(draft.project, candidate.assets), context);
    } else {
      const base = await loadCandidate(id, before, context);
      await verifyFiles(sourceDependencies(draft.project, base.assets), context);
      const prepared: Array<Awaited<ReturnType<typeof prepareAsset>>> = [];
      const protectedRegions = new Set(imageRegions(base.json));
      for (const asset of base.assets) protectedRegions.delete(asset.region);
      const edit = await editCandidate(base.json, draft.animation, args.ops, async op => {
        const asset = await prepareAsset(op, dir, context, false);
        if (protectedRegions.has(asset.asset.region)) invalid(`新贴图区与既有角色贴图重名：${asset.asset.region}。`);
        prepared.push(asset);
        return asset.asset;
      });
      const assets = new Map(base.assets.map(asset => [asset.region, asset]));
      for (const asset of edit.assets) {
        const existing = assets.get(asset.region);
        if (existing && existing.hash !== asset.hash) invalid(`贴图区 ${asset.region} 对应不同图片，请为新贴图指定不同区域名称。`);
        assets.set(asset.region, existing ?? asset);
      }
      const candidate: Candidate = { json: edit.json, assets: [...assets.values()] };
      next = objectHash(candidate);
      if (next === before) return { ...draftSummary(draft), changed: false, dryRun: !persist };
      const validateDir = within(dir, '.candidate-' + randomUUID());
      try {
        await materializeRuntime(candidate.json, selectSkeleton(draft.project, draft.skeleton), candidate.assets, dir,
          validateDir, context, prepared.map(entry => entry.image));
        await verifyFiles(sourceDependencies(draft.project, candidate.assets), context);
        checkpoint('动画草稿校验');
        if (persist) {
          for (const { asset, image } of prepared) await writeBytes(within(dir, 'assets', asset.hash + '.png'), image.bytes, context);
          await saveCandidate(id, candidate, context);
        }
      } finally { await cleanDirectory(validateDir, context); }
      past = [...draft.past, before];
      future = [];
    }
    if (!persist) return { ...draftSummary(draft), dryRun: true, changed: true, proposedRevision: draft.revision + 1, proposedHash: next };
    checkpoint('更新动画草稿');
    const revised = { ...draft, revision: draft.revision + 1, revisions: [...draft.revisions, next], past, future };
    await atomicRecord(state, revised, context);
    await observeDraft({ draftId: id, animation: draft.animation, revision: revised.revision, status: 'edited' }, context);
    return { ...draftSummary(revised), dryRun: false, changed: true };
  });
}

async function previewDraft(args: Json, context: ToolContext) {
  const draft = await loadDraft(args.draftId, context), revision = args.revision ?? draft.revision;
  const hash = draft.revisions[revision];
  if (!hash) invalid(`草稿不存在修订 ${revision}。`);
  const candidate = await loadCandidate(draft.draftId, hash, context);
  const result = { ...draftSummary(draft), revision, candidateHash: hash, duration: animationDuration(candidate.json.animations[draft.animation]),
    resources: candidate.assets.map(({ region, hash }) => ({ region, hash })) };
  if (!args.view || args.view === 'state') return result;
  const dir = draftDir(draft.draftId), output = scratch(), jobId = path.posix.basename(output);
  const selected = selectSkeleton(draft.project, draft.skeleton);
  if (args.view === 'measure') {
    if (!args.measurements?.length) invalid('测量需明确提供骨骼和时间范围。');
    await verifyFiles(sourceDependencies(draft.project, candidate.assets), context);
    const material = await materializeRuntime(candidate.json, selected, candidate.assets, dir, within(output, 'runtime'), context);
    return { ...result, measurements: measureDraft(material.runtime, draft.animation, args.skin, args.measurements), formalEligible: null };
  }
  const observe = (state: Parameters<typeof observeDraft>[0], options?: Parameters<typeof observeDraft>[2]) =>
    revision === draft.revision ? observeDraft(state, context, options) : Promise.resolve();
  const identity = { draftId: draft.draftId, revision, animation: draft.animation, jobId };
  await observe({ ...identity, status: 'rendering' });
  try {
    await verifyFiles(sourceDependencies(draft.project, candidate.assets), context);
    const material = await materializeRuntime(candidate.json, selected, candidate.assets, dir, within(output, 'runtime'), context);
    let preview = await renderDraftView(args, material, draft.animation, within(output, 'render'), context);
    if (args.view === 'comparison') {
      const sources = [args.compareRevision, args.referencePath, args.referenceManifestPath].filter(value => value !== undefined);
      if (sources.length !== 1) invalid('比较需要恰好一个 compareRevision、referencePath 或 referenceManifestPath。');
      const reference = args.compareRevision === undefined ? await comparisonReference(args, context) : await (async () => {
        const oldHash = draft.revisions[args.compareRevision];
        if (!oldHash) invalid(`不存在参考修订 ${args.compareRevision}。`);
        const old = await loadCandidate(draft.draftId, oldHash, context);
        await verifyFiles(sourceDependencies(draft.project, old.assets), context);
        const data = await materializeRuntime(old.json, selected, old.assets, dir, within(output, 'comparison-runtime'), context);
        const view = await renderDraftView({ view: 'gif', fps: args.fps, skin: args.skin }, data, draft.animation, within(output, 'comparison-render'), context);
        return { duration: view.duration, frames: view.frames.map((filePath, i) => ({ filePath, time: view.times[i] })) };
      })();
      preview = await renderDraftComparison(preview, reference, args.phaseMap, within(output, 'comparison'), context);
    }
    await verifyFiles(sourceDependencies(draft.project, candidate.assets), context);
    await observe({ ...identity, status: 'ready', preview: { id: jobId, revision, frames: 'overlay' in preview ? [preview.overlay] : preview.frames,
      times: preview.times, duration: preview.duration, gifPath: preview.gifPath } }, {
      playback: { filePath: material.filePath, atlasPath: material.atlasPath, skin: preview.skin ?? '',
        premultipliedAlpha: material.runtime.atlas.pages.some(page => page.pma) },
    });
    return { ...result, ...preview, formalEligible: null };
  } catch (error) {
    await observe({ ...identity, status: 'error', error: (error as Error).message });
    throw error;
  }
}

async function publishDraft(args: Json, context: ToolContext) {
  const state = draftState(args.draftId), format = args.format ?? 'spine';
  const output = path.posix.normalize(posix(args.outputPath));
  if (output === '..' || output.startsWith('../') || path.isAbsolute(output)) throw new HostError('PATH_FORBIDDEN', '交付目录必须在工作区内。', 403);
  if (output === '..' || output.startsWith('../') || path.isAbsolute(output)) throw new HostError('PATH_FORBIDDEN', '交付目录必须在工作区内。', 403);
  if (output === '.' || output.split('/').some(part => part.startsWith('.'))) invalid('交付目录必须是工作区内的新普通目录。');
  const absolute = resolveWorkspacePath(output, context);
  return withFileLock(state, context, () => withFileLock(output, context, async () => {
    const draft = await loadDraft(args.draftId, context);
    checkRevision(draft, args.expectedRevision);
    const hash = currentHash(draft);
    if (args.candidateHash !== hash) throw new HostError('TARGET_STALE', '候选哈希与当前修订不符。', 409);
    const candidate = await loadCandidate(draft.draftId, hash, context), dir = draftDir(draft.draftId);
    const dependencies = sourceDependencies(draft.project, candidate.assets);
    await verifyFiles(dependencies, context);
    if (await available(output, context)) throw new HostError('OUTPUT_EXISTS', `交付目录已存在：${output}。`, 409);
    const info = { draftId: draft.draftId, revision: draft.revision, candidateHash: hash, outputPath: output, format, formalEligible: null };
    if (args.dryRun !== false) return { ...info, dryRun: true };
    const observation = { draftId: draft.draftId, revision: draft.revision, animation: draft.animation, jobId: randomUUID() };
    const pending = within(path.posix.dirname(output), '.authoring-' + randomUUID());
    const work = within(dir, '.authoring-' + randomUUID());
    await mkdir(path.dirname(absolute), { recursive: true });
    await mkdir(resolveWorkspacePath(pending, context));
    await observeDraft({ ...observation, status: 'publishing' }, context, { detail: output });
    try {
      const selected = selectSkeleton(draft.project, draft.skeleton);
      const delivery = format === 'spine' ? await buildNativeProject(draft.project, draft.skeleton, draft.animation, candidate.json, candidate.assets, dir, pending, work, context) :
        await (async () => {
          const runtime = await materializeRuntime(candidate.json, selected, candidate.assets, dir, pending, context);
          return { filename: 'skeleton.json', atlasFilename: 'skeleton.atlas', sha256: (await fileHash(runtime.filePath, context)).hash, editorImport: null };
        })();
      await verifyFiles(dependencies, context);
      const receipt = { ...info, ...delivery, filePath: within(output, delivery.filename), dryRun: false,
        sources: dependencies, animation: draft.animation, skeleton: draft.skeleton, runtimeValidated: true };
      await writeBytes(within(pending, 'delivery.json'), JSON.stringify(receipt, null, 2) + '\n', context);
      checkpoint('交付动画工程');
      if (await available(output, context)) throw new HostError('OUTPUT_EXISTS', `交付目录已存在：${output}。`, 409);
      await rename(resolveWorkspacePath(pending, context), absolute);
      await observeDraft({ ...observation, status: 'published' }, context, { detail: receipt.filePath });
      return receipt;
    } catch (error) {
      await observeDraft({ ...observation, status: 'publishError', error: (error as Error).message }, context);
      throw error;
    } finally {
      await cleanDirectory(pending, context);
      await cleanDirectory(work, context);
    }
  }));
}

export async function callAuthoringTool(name: string, args: Json, context: ToolContext) {
  switch (name) {
    case 'spine_read_reference_frames': return readReferenceFrames(args as Parameters<typeof readReferenceFrames>[0], context);
    case 'spine_inspect_project': return inspect(args, context);
    case 'spine_open_animation_draft': return openDraft(args, context);
    case 'spine_edit_animation_draft': return editDraft(args, context);
    case 'spine_preview_animation_draft': return previewDraft(args, context);
    case 'spine_publish_animation_draft': return publishDraft(args, context);
    default: throw new HostError('CAPABILITY_MISSING', `未知创作工具：${name}。`);
  }
}
