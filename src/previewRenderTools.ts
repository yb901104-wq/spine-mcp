import {taskCheckpoint,reportProgress} from './taskControl.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { loadMotionRuntime, worldVertices } from './motionRuntime.js';
import { readSpineDocument, resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { getWorkspaceRoot } from './workspaceTools.js';
import { loadAtlasImages, rasterFrame, RASTER_RENDERER_VERSION } from './rasterRenderer.js';
import { readCharacterMapping } from './motionEngine.js';
import { withFileLock } from './jobTools.js';

export interface RenderOptions {
  filePath: string; atlasPath: string; animation: string; skin?: string;
  times?: number[]; fps?: number; frames?: number; width?: number; height?: number; scale?: number;
  background?: string; outputDir?: string; jobId?: string; mappingPath?: string; motionPath?: string;
  premultipliedAlpha?: boolean; mipmaps?: boolean; bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  jsonOverride?: any;
}
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const rootOf = (c: ToolContext) => path.resolve(c.workspaceRoot ?? getWorkspaceRoot(c.projectId));
const relative = (c: ToolContext, p: string) => path.relative(rootOf(c), p).replaceAll('\\', '/');
const jsonWrite = (p: string, v: any) => writeFile(p, JSON.stringify(v, null, 2) + '\n');
const safeId = (id: string) => { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('jobId 格式无效。'); return id; };

export async function createPreviewManifest(args: RenderOptions, context: ToolContext = {}) {
  const doc = await readSpineDocument(args.filePath, context), json = args.jsonOverride ?? doc.json;
  const raw = await readFile(resolveWorkspacePath(args.atlasPath, context), 'utf8');
  const runtime = await loadMotionRuntime(json, args.atlasPath, context), animation = runtime.data.findAnimation(args.animation);
  if (!animation) throw new Error(`runtime 找不到动画：${args.animation}`);
  if (!String(json.skeleton?.spine).startsWith('4.1.')) throw new Error('离线预览仅支持 Spine 4.1 runtime。');
  if (args.skin && !runtime.data.findSkin(args.skin)) throw new Error(`皮肤不存在：${args.skin}`);
  const effectiveSkin = args.skin ?? (Object.keys(worldVertices(runtime.sample(args.animation, 0))).length ? runtime.data.defaultSkin?.name : runtime.data.skins.find(s => s.getAttachments().length > 1)?.name);
  const fps = args.fps ?? 12, frameCount = args.times?.length ?? args.frames ?? Math.max(2, Math.ceil(animation.duration * fps));
  const width = args.width ?? 384, height = args.height ?? 384;
  if (args.mipmaps) throw new Error('离线 Canvas 预览不使用 mipmaps；请设置 false。');
  if (args.scale !== undefined && (!Number.isFinite(args.scale) || args.scale <= 0 || args.scale > 10)) throw new Error('scale 必须大于0且不超过10。');
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 240 || !Number.isFinite(fps) || fps <= 0 || fps > 120 || !Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 || width > 2048 || height > 2048) throw new Error('采样上限：2–240 帧，画布32–2048，FPS 1–120。');
  if(args.times && (args.times.length<2 || args.times.some((t,i)=>!Number.isFinite(t)||t<0||t>animation.duration+1e-6||i>0&&t<=args.times![i-1])))throw new Error('显式时间需递增、有限且在动画范围内。');
  const images = [];
  for (const page of runtime.atlas.pages) { const p = path.join(path.dirname(args.atlasPath), page.name); images.push({ path: p, hash: sha(await readFile(resolveWorkspacePath(p, context))) }); }
  const mappingHash = args.mappingPath ? sha(await readFile(resolveWorkspacePath(args.mappingPath, context))) : null;
  const motionHash = args.motionPath ? sha(await readFile(resolveWorkspacePath(args.motionPath, context))) : null;
  const manifest = { version: 2, filePath: args.filePath, atlasPath: args.atlasPath, animation: args.animation, skin: effectiveSkin ?? null, jsonHash: args.jsonOverride ? sha(JSON.stringify(json)) : doc.hash, atlasHash: sha(raw), images, mappingHash, motionHash, runtime: '@esotericsoftware/spine-core@4.1.56', renderer: RASTER_RENDERER_VERSION, fps, frameCount, sampleTimes: args.times ?? null, duration: animation.duration, canvas: { width, height, background: args.background ?? '#20242b', scale: args.scale ?? 1 }, premultipliedAlpha: args.premultipliedAlpha ?? runtime.atlas.pages.some(p => p.pma), mipmaps: false, requestedBounds: args.bounds ?? null };
  return { ...manifest, cacheKey: sha(JSON.stringify(manifest)), createdAt: new Date().toISOString() };
}

export async function renderAnimationFrames(args: RenderOptions, context: ToolContext = {}): Promise<any> {
  const jobId = safeId(args.jobId ?? `preview-${randomUUID()}`);
  const outputDir = args.outputDir ?? `previews/jobs/${jobId}`;
  return withFileLock(`${outputDir}/status.json`, context, () => renderAnimationFramesLocked({ ...args, jobId, outputDir }, context));
}
async function renderAnimationFramesLocked(args: RenderOptions, context: ToolContext = {}): Promise<any> {
  const manifest = await createPreviewManifest(args, context);
  const jobId = safeId(args.jobId ?? `preview-${randomUUID()}`), jobDir = resolveWorkspacePath(args.outputDir ?? `previews/jobs/${jobId}`, context);
  const cacheDir = resolveWorkspacePath(`previews/cache/${manifest.cacheKey}`, context);
  await mkdir(jobDir, { recursive: true }); await mkdir(cacheDir, { recursive: true });
  const lockPath = path.join(cacheDir, 'render.lock'); let lock;
  try { lock = await open(lockPath, 'wx'); } catch { throw new Error('相同预览任务正在渲染，请稍后重试。'); }
  try {
    await jsonWrite(path.join(jobDir, 'status.json'), { jobId, status: 'rendering', input: manifest });
    const cached = await readFile(path.join(cacheDir, 'preview-manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
    let result: any;
    if (cached) {
      for (const frame of cached.frames) await access(resolveWorkspacePath(frame, context));
      result = { ...cached, cached: true, jobId };
    } else {
      const doc = await readSpineDocument(args.filePath, context), rt = await loadMotionRuntime(args.jsonOverride ?? doc.json, args.atlasPath, context);
      const images = await loadAtlasImages(rt.atlas, args.atlasPath, context, manifest.premultipliedAlpha);
      const mapping = args.mappingPath ? await readCharacterMapping(args.mappingPath, context) : null;
      const tracks: any[] = []; let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < manifest.frameCount; i++) {
        await taskCheckpoint('动画预览');reportProgress(i,manifest.frameCount,'逐帧生成预览');
        const time = manifest.sampleTimes?.[i] ?? manifest.duration * i / manifest.frameCount, s = rt.sample(args.animation, time, manifest.skin ?? undefined);
        const vertices = Object.values(worldVertices(s)).flat();
        for (let j = 0; j < vertices.length; j += 2) { minX = Math.min(minX, vertices[j]); minY = Math.min(minY, vertices[j + 1]); maxX = Math.max(maxX, vertices[j]); maxY = Math.max(maxY, vertices[j + 1]); }
        const semantic: Record<string, { x: number; y: number }> = {};
        const scale = mapping?.calibration?.scale ?? 1, origin = mapping?.calibration?.origin ?? [0, 0];
        if (mapping) {
          for (const role of ['body', 'head'] as const) { const b = s.findBone(mapping.bones[role] ?? ''); if (b) semantic[role] = { x: (b.worldX - origin[0]) / scale, y: (b.worldY - origin[1]) / scale }; }
          for (const [role, anchor] of Object.entries(mapping.bones.anchors ?? {})) { const b = s.findBone(anchor.bone); if (b) semantic[role] = { x: (b.worldX + b.a * anchor.point[0] + b.b * anchor.point[1] - origin[0]) / scale, y: (b.worldY + b.c * anchor.point[0] + b.d * anchor.point[1] - origin[1]) / scale }; }
        }
        tracks.push({ time, semantic, bones: Object.fromEntries(s.bones.map(b => [b.data.name, { x: b.worldX, y: b.worldY }])) });
      }
      if (!Number.isFinite(minX)) { minX = -1; minY = -1; maxX = 1; maxY = 1; }
      const pad = Math.max(maxX - minX, maxY - minY) * .08 + 1;
      const zoom = manifest.canvas.scale, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const bounds = args.bounds ?? { minX: cx - ((maxX-minX)/2+pad)/zoom, minY: cy-((maxY-minY)/2+pad)/zoom, maxX: cx+((maxX-minX)/2+pad)/zoom, maxY: cy+((maxY-minY)/2+pad)/zoom };
      if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) throw new Error('固定相机 bounds 无效。');
      const frames = [];
      for (let i = 0; i < manifest.frameCount; i++) {
        await taskCheckpoint('动画预览');reportProgress(i,manifest.frameCount,'逐帧生成预览');
        const canvas = rasterFrame(rt.sample(args.animation, tracks[i].time, manifest.skin ?? undefined), images, bounds, manifest.canvas.width, manifest.canvas.height, manifest.canvas.background);
        const p = path.join(cacheDir, `frame-${String(i).padStart(4, '0')}.png`); await writeFile(p, canvas.toBuffer('image/png')); frames.push(relative(context, p));
      }
      result = { ...manifest, ok: true, jobId, bounds, frames, trajectories: tracks, outputDir: relative(context, cacheDir), cached: false };
      await jsonWrite(path.join(cacheDir, 'preview-manifest.json'), result);
    }
    await jsonWrite(path.join(jobDir, 'preview-manifest.json'), result);
    await jsonWrite(path.join(jobDir, 'status.json'), { jobId, status: 'done', cacheKey: manifest.cacheKey });
    reportProgress(manifest.frameCount,manifest.frameCount,'动画预览已完成');const { trajectories, ...summary } = result;
    return { ...summary, trajectorySamples: trajectories?.length ?? 0, manifestPath: relative(context, path.join(jobDir, 'preview-manifest.json')), message: '已生成固定相机 PNG 帧与轨迹报告；轨迹保存在 manifest 中。' };
  } catch (e) { await jsonWrite(path.join(jobDir, 'status.json'), { jobId, status: 'failed', input: manifest, error: String(e) }); throw e; }
  finally { await lock.close(); await unlink(lockPath); }
}

export async function renderContactSheet(args: RenderOptions & { columns?: number }, context: ToolContext = {}): Promise<any> {
  const r = await renderAnimationFrames(args, context), columns = args.columns ?? 4;
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw new Error('columns 必须为1–12。');
  const ids = Array.from({ length: (args.times ? r.frames.length : Math.min(12, r.frames.length)) }, (_, i) => Math.floor(i * (r.frames.length - 1) / Math.max(1, (args.times ? r.frames.length : Math.min(12, r.frames.length)) - 1)));
  const w = 256, h = 280, canvas = createCanvas(columns * w, Math.ceil(ids.length / columns) * h), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#20242b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let n = 0; n < ids.length; n++) { const i = ids[n], x = n % columns * w, y = Math.floor(n / columns) * h; ctx.drawImage(await loadImage(await readFile(resolveWorkspacePath(r.frames[i], context))), x, y, w, w); ctx.fillStyle = 'white'; ctx.font = '14px sans-serif'; ctx.fillText(`${i} / ${(r.sampleTimes?.[i] ?? r.duration * i / r.frameCount).toFixed(3)}s`, x + 8, y + 274); }
  const p = resolveWorkspacePath(`${r.outputDir}/contact-sheet-${columns}.png`, context); await writeFile(p, canvas.toBuffer('image/png'));
  const report = { ...r, contactSheet: relative(context, p) }; const stored = JSON.parse(await readFile(resolveWorkspacePath(r.manifestPath, context), 'utf8')); await jsonWrite(resolveWorkspacePath(r.manifestPath, context), { ...stored, ...report }); return report;
}

export async function renderAnimationGif(args: RenderOptions, context: ToolContext = {}): Promise<any> {
  if(args.times)throw new Error('原速 GIF 采用均匀采样，请勿传 times。');
  const r = await renderAnimationFrames(args, context), gif = GIFEncoder(); let gifIndex = 0, encodedDurationMs = 0;
  for (const frame of r.frames) { await taskCheckpoint('GIF 编码');reportProgress(gifIndex,r.frames.length,'编码动画 GIF'); const image = await loadImage(await readFile(resolveWorkspacePath(frame, context))), c = createCanvas(image.width, image.height), ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); const pixels = ctx.getImageData(0, 0, c.width, c.height).data, palette = quantize(pixels, 256); gif.writeFrame(applyPalette(pixels, palette), c.width, c.height, { palette, delay: (() => { const delay = Math.max(10, (Math.round((gifIndex + 1) * r.duration * 100 / r.frameCount) - Math.round(gifIndex * r.duration * 100 / r.frameCount)) * 10); gifIndex++; encodedDurationMs += delay; return delay; })(), repeat: 0 }); }
  gif.finish();reportProgress(r.frames.length,r.frames.length,'动画 GIF 已编码'); const p = resolveWorkspacePath(`${r.outputDir}/animation.gif`, context); await writeFile(p, gif.bytes());
  const stored=await readFile(resolveWorkspacePath(r.manifestPath,context),'utf8').then(JSON.parse);await jsonWrite(resolveWorkspacePath(r.manifestPath,context),{...stored,gifPath:relative(context,p),encodedDurationMs});
  return { ...r, gifPath: relative(context, p), encodedDurationMs, message: '已离线生成动画 GIF（按10ms量化并分配帧延迟）。' };
}

export async function getPreviewReport(args: { manifestPath: string; detailed?: boolean }, context: ToolContext = {}) { const r = JSON.parse(await readFile(resolveWorkspacePath(args.manifestPath, context), 'utf8')); if (args.detailed) return r; const { trajectories, ...summary } = r; return { ...summary, trajectorySamples: trajectories?.length ?? 0 }; }

export async function comparePreviewReports(args: { firstManifestPath: string; secondManifestPath: string; pixelComparison?: boolean }, context: ToolContext = {}) {
  const a = await getPreviewReport({ manifestPath: args.firstManifestPath, detailed: true }, context), b = await getPreviewReport({ manifestPath: args.secondManifestPath, detailed: true }, context);
  const sameAssets = Boolean(a.images && b.images) && JSON.stringify(a.images) === JSON.stringify(b.images);
  const framePath = (r: any, i: number): string => typeof r.frames[i] === 'string' ? r.frames[i] : r.frames[i].filePath;
  if (args.pixelComparison && !sameAssets) throw new Error('像素对比要求相同贴图。');
  const n = Math.min(a.frames.length, b.frames.length, 8), canvas = createCanvas(512, n * 256), ctx = canvas.getContext('2d');
  for (let i = 0; i < n; i++) for (const [r, col] of [[a, 0], [b, 1]] as const) { const index = Math.floor(i * (r.frames.length - 1) / Math.max(1, n - 1)); ctx.drawImage(await loadImage(await readFile(resolveWorkspacePath(framePath(r, index), context))), col * 256, i * 256, 256, 256); }
  const out = resolveWorkspacePath(`previews/reports/compare-${randomUUID()}.png`, context); await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, canvas.toBuffer('image/png'));
  const roles = Object.keys(a.trajectories?.[0]?.semantic ?? {}).filter(k => b.trajectories?.[0]?.semantic?.[k]);
  const semanticErrors: Record<string, number> = {};
  for (const role of roles) { let max = 0; for (let i = 0; i < a.trajectories.length; i++) { const p = a.trajectories[i].semantic[role], q = b.trajectories[Math.min(b.trajectories.length - 1, Math.floor(i * b.trajectories.length / a.trajectories.length))].semantic[role]; max = Math.max(max, Math.hypot(p.x - q.x, p.y - q.y)); } semanticErrors[role] = max; }
  let pixelMeanAbsoluteError: number | null = null;
  const overlay = createCanvas(256, 256), oc = overlay.getContext('2d');
  const ia = await loadImage(await readFile(resolveWorkspacePath(framePath(a, 0), context))), ib = await loadImage(await readFile(resolveWorkspacePath(framePath(b, 0), context)));
  oc.drawImage(ia, 0, 0, 256, 256); oc.globalAlpha = .5; oc.drawImage(ib, 0, 0, 256, 256);
  const overlayPath = out.replace('.png', '-overlay.png'); await writeFile(overlayPath, overlay.toBuffer('image/png'));
  let differencePath: string | null = null;
  if (args.pixelComparison) {
    if (JSON.stringify(a.bounds) !== JSON.stringify(b.bounds)) throw new Error('像素比较还要求相同固定相机 bounds。');
    const ca = createCanvas(256, 256), cb = createCanvas(256, 256), xa = ca.getContext('2d'), xb = cb.getContext('2d'); xa.drawImage(ia, 0, 0, 256, 256); xb.drawImage(ib, 0, 0, 256, 256);
    const pa = xa.getImageData(0, 0, 256, 256), pb = xb.getImageData(0, 0, 256, 256); let sum = 0;
    for (let i = 0; i < pa.data.length; i += 4) { for (let j = 0; j < 3; j++) { const d = Math.abs(pa.data[i+j] - pb.data[i+j]); sum += d; pa.data[i+j] = d; } pa.data[i+3] = 255; } xa.putImageData(pa, 0, 0); pixelMeanAbsoluteError = sum / (256*256*3); differencePath = relative(context, out.replace('.png', '-difference.png')); await writeFile(resolveWorkspacePath(differencePath, context), ca.toBuffer('image/png'));
  }
  const rangeStats = (r: any) => Object.fromEntries(roles.map(role => { const points = r.trajectories.map((t: any) => t.semantic[role]); return [role, { horizontalRange: Math.max(...points.map((p:any) => p.x)) - Math.min(...points.map((p:any) => p.x)), verticalRange: Math.max(...points.map((p:any) => p.y)) - Math.min(...points.map((p:any) => p.y)), minimumY: Math.min(...points.map((p:any)=>p.y)) }]; }));
  const report = { ok: true, durationDelta: Math.abs(a.duration - b.duration), sameAssets, comparisonSheet: relative(context, out), overlayPath: relative(context, overlayPath), differencePath, pixelMeanAbsoluteError, pixelScope: args.pixelComparison ? '首帧' : null, pixelComparison: args.pixelComparison ?? false, semanticErrors, motionRanges: [rangeStats(a), rangeStats(b)], phaseAlignment: '按归一化周期，起点相位由 Agent 确认', warnings: roles.length ? [] : ['未提供两个角色的 mapping，或参考为 GIF，语义轨迹比较未执行。'] };
  await jsonWrite(out.replace('.png', '.json'), report); return report;
}



