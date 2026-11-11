import sharp from 'sharp';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';

const CONTACT_CELL_W = 256, CONTACT_CELL_H = 280;

function assertContactSheetOptions(columns: number, maxTiles: number) {
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw new Error('联系表 columns 必须为1–12。');
  if (!Number.isInteger(maxTiles) || maxTiles < 1 || maxTiles > 32) throw new Error('联系表 maxTiles 必须为1–32。');
}

/** 把若干参考帧合成一张联系表（网格 + 帧序号与时间标签），供模型直接查看。
 * 只合成一张图是刻意的：pickImages 上限 3 张，且单张图的 token 成本远低于 N 张独立图。 */
async function buildReferenceContactSheet(args: {
  frames: Array<{ index: number; time: number; filePath: string }>; dir: string; name: string; columns: number; maxTiles: number; context: ToolContext;
}): Promise<string> {
  const { frames, dir, name, columns, maxTiles, context } = args;
  const tiles = frames.slice(0, maxTiles);
  const canvas = createCanvas(columns * CONTACT_CELL_W, Math.ceil(tiles.length / columns) * CONTACT_CELL_H), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#20242b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let n = 0; n < tiles.length; n++) {
    const f = tiles[n], x = n % columns * CONTACT_CELL_W, y = Math.floor(n / columns) * CONTACT_CELL_H;
    ctx.drawImage(await loadImage(await readFile(resolveWorkspacePath(f.filePath, context))), x, y, CONTACT_CELL_W, CONTACT_CELL_W);
    ctx.fillStyle = 'white'; ctx.font = '14px sans-serif';
    ctx.fillText(`${f.index} / ${f.time.toFixed(3)}s`, x + 8, y + CONTACT_CELL_H - 6);
  }
  const filePath = `${dir}/${name}`;
  await writeFile(resolveWorkspacePath(filePath, context), canvas.toBuffer('image/png'));
  return filePath;
}

function manifestDir(manifestPath: string): string {
  const i = manifestPath.lastIndexOf('/');
  return i > 0 ? manifestPath.slice(0, i) : 'previews/jobs';
}

type ReferenceFrameEntry = {
  index: number; time: number; delay: number; originalDelay?: number | null;
  delayCorrected?: boolean; hash: string; duplicateOf: number | null; filePath: string;
  frameBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null;
  appearanceDelta?: number; bboxMotion?: number; velocity?: number;
};

function boundsFromPixels(pixels: ArrayLike<number>, width: number, height: number) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let p = 3; p < pixels.length; p += 4) {
    if (!pixels[p]) continue;
    const x = ((p - 3) / 4) % width, y = Math.floor((p - 3) / 4 / width);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function bboxMotion(a: any, b: any, width: number, height: number) {
  if (!a || !b) return 0;
  const acx = (a.minX + a.maxX) / 2, acy = (a.minY + a.maxY) / 2;
  const bcx = (b.minX + b.maxX) / 2, bcy = (b.minY + b.maxY) / 2;
  const diagonal = Math.max(1, Math.hypot(width, height));
  return Math.min(1, Math.hypot(acx - bcx, acy - bcy) / diagonal);
}

function calculateAppearanceDelta(previous: ArrayLike<number> | undefined, current: ArrayLike<number>, width: number, height: number) {
  if (!previous || previous.length !== current.length) return 0;
  // 每 4 个像素取样一次，保留离线分析速度；该值只作候选证据，不作视觉批准。
  let sum = 0, samples = 0;
  for (let p = 0; p < current.length; p += 16) {
    sum += Math.abs(current[p] - previous[p]) + Math.abs(current[p + 1] - previous[p + 1]) + Math.abs(current[p + 2] - previous[p + 2]) + Math.abs(current[p + 3] - previous[p + 3]);
    samples++;
  }
  return samples ? sum / (samples * 1020) : 0;
}

function smooth(values: number[]) {
  return values.map((v, i) => {
    const a = values[Math.max(0, i - 1)], b = values[i], c = values[Math.min(values.length - 1, i + 1)];
    return (a + 2 * b + c) / 4;
  });
}

function buildKeyposeCandidates(entries: ReferenceFrameEntry[], width: number, height: number, count = 8, minGap?: number) {
  const unique = entries.filter(e => e.duplicateOf === null);
  const limit = Math.min(count, Math.max(2, unique.length));
  const velocities = smooth(entries.map(e => 0.7 * (e.appearanceDelta ?? 0) + 0.3 * (e.bboxMotion ?? 0)));
  entries.forEach((e, i) => e.velocity = velocities[i]);
  const gap = Math.max(1, minGap ?? Math.floor(Math.max(1, entries.length - 1) / Math.max(2, limit * 2)));
  const selected = new Map<number, { source: 'uniform' | 'salient'; kind: string; score: number; reason: string }>();
  const add = (e: ReferenceFrameEntry, meta: { source: 'uniform' | 'salient'; kind: string; score?: number; reason: string }) => {
    if (!e || e.duplicateOf !== null) return;
    const nearby = [...selected.keys()].find(i => Math.abs(i - e.index) < gap);
    if (nearby !== undefined) {
      const old = selected.get(nearby)!;
      if ((meta.score ?? 0) > old.score) { selected.delete(nearby); selected.set(e.index, { ...meta, score: meta.score ?? 0 }); }
      return;
    }
    selected.set(e.index, { ...meta, score: meta.score ?? 0 });
  };
  const uniformCount = Math.min(limit, Math.max(2, Math.ceil(limit * 0.5)));
  for (let i = 0; i < uniformCount; i++) {
    const e = unique[Math.floor(i * (unique.length - 1) / Math.max(1, uniformCount - 1))];
    add(e, { source: 'uniform', kind: 'coverage', score: 0.2, reason: '时间覆盖保底帧' });
  }
  const salient: Array<{ e: ReferenceFrameEntry; kind: string; score: number; reason: string }> = [];
  const sortedVelocity = [...velocities].sort((a, b) => a - b), quietThreshold = sortedVelocity[Math.floor(sortedVelocity.length * 0.22)] ?? 0;
  let quietStart = -1;
  const flushQuiet = (end: number) => {
    if (quietStart < 0) return;
    const span = end - quietStart + 1;
    if (span >= 3) {
      const first = entries[quietStart], last = entries[end];
      if (first) salient.push({ e: first, kind: 'holdEndpoint', score: 0.5, reason: '连续低速保持段起点，疑似姿态保持或接触' });
      if (last && last.index !== first?.index) salient.push({ e: last, kind: 'holdEndpoint', score: 0.48, reason: '连续低速保持段终点，疑似姿态保持或接触' });
    }
    quietStart = -1;
  };
  for (let i = 0; i < velocities.length; i++) {
    if (velocities[i] <= quietThreshold) { if (quietStart < 0) quietStart = i; }
    else flushQuiet(i - 1);
  }
  flushQuiet(velocities.length - 1);
  for (let i = 1; i < entries.length - 1; i++) {
    const e = entries[i]; if (e.duplicateOf !== null) continue;
    const left = velocities[i - 1], v = velocities[i], right = velocities[i + 1];
    const valley = Math.max(0, (left + right) / 2 - v);
    const turn = Math.abs((right - v) - (v - left));
    if (valley > 0.00015 || turn > 0.0003) {
      const score = Math.min(1, valley * 2 + turn * 1.5);
      salient.push({ e, kind: valley >= turn ? 'velocityMinimum' : 'directionTurn', score, reason: valley >= turn ? '速度局部极小，疑似姿态极值或停顿' : '速度曲率变化，疑似动作方向转折' });
    }
  }
  salient.sort((a, b) => b.score - a.score);
  for (const c of salient) { if (selected.size >= limit) break; add(c.e, { source: 'salient', kind: c.kind, score: c.score, reason: c.reason }); }
  const chosen = [...selected.entries()].sort((a, b) => a[0] - b[0]).slice(0, limit);
  return chosen.map(([index, meta]) => ({ ...entries[index], source: meta.source, kind: meta.kind, score: Number(meta.score.toFixed(4)), reason: meta.reason }));
}

export async function analyzeReferenceGif(args: { filePath: string; outputDir?: string; fallbackDelay?: number; phases?: Array<{ time: number; phase: string }>; loop?: boolean; columns?: number; maxTiles?: number; candidateMode?: 'uniform' | 'keypose'; candidateCount?: number; minCandidateGap?: number }, context: ToolContext = {}) {
  if(args.fallbackDelay!==undefined&&(!Number.isFinite(args.fallbackDelay)||args.fallbackDelay<=0))throw new Error('fallbackDelay 必须为正数。');
  const raw = await readFile(resolveWorkspacePath(args.filePath, context));
  if(!raw.subarray(0,6).toString().startsWith('GIF8'))return analyzeRasterReference(args,raw,context);
  const gif = parseGIF(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), frames = decompressFrames(gif, true);
  if (!frames.length || frames.length > 1000 || gif.lsd.width * gif.lsd.height > 4194304) throw new Error('参考 GIF 为空或超出处理上限。');
  const dir = args.outputDir ?? `previews/jobs/reference-${randomUUID()}`, absolute = resolveWorkspacePath(dir, context); await mkdir(absolute, { recursive: true });
  const c = createCanvas(gif.lsd.width, gif.lsd.height), ctx = c.getContext('2d');
  let previous: any, previousPixels: Uint8ClampedArray | undefined, time = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const entries: ReferenceFrameEntry[] = [], seen = new Map<string, number>();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (previous?.frame.disposalType === 2) ctx.clearRect(previous.frame.dims.left, previous.frame.dims.top, previous.frame.dims.width, previous.frame.dims.height);
    if (previous?.frame.disposalType === 3) ctx.putImageData(previous.saved, 0, 0);
    const saved = ctx.getImageData(0, 0, c.width, c.height), patch = createCanvas(f.dims.width, f.dims.height);
    patch.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.patch), f.dims.width, f.dims.height), 0, 0);
    ctx.drawImage(patch, f.dims.left, f.dims.top);
    const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3]) { const x = p / 4 % c.width, y = Math.floor(p / 4 / c.width); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const hash = createHash('sha256').update(pixels).digest('hex'), delay = f.delay > 0 ? f.delay : (args.fallbackDelay ?? 100);
    const frameBounds = boundsFromPixels(pixels, c.width, c.height);
    const filePath = `${dir}/frame-${String(i).padStart(4, '0')}.png`; await writeFile(resolveWorkspacePath(filePath, context), c.toBuffer('image/png'));
    entries.push({ index: i, time: time / 1000, delay, originalDelay: f.delay, delayCorrected: !f.delay, hash, duplicateOf: seen.get(hash) ?? null, filePath, frameBounds, appearanceDelta: calculateAppearanceDelta(previousPixels, pixels, c.width, c.height), bboxMotion: bboxMotion(previous?.frameBounds, frameBounds, c.width, c.height) });
    if (!seen.has(hash)) seen.set(hash, i); time += delay; previous = { frame: f, saved, frameBounds }; previousPixels = new Uint8ClampedArray(pixels);
  }
  const phases = args.phases ?? [];
  const columns = args.columns ?? 4, maxTiles = args.maxTiles ?? 12;
  assertContactSheetOptions(columns, maxTiles);
  if (phases.some(p => !Number.isFinite(p.time) || p.time < 0 || p.time > time / 1000 || !p.phase)) throw new Error('参考阶段标注的时间或名称无效。');
  const loopExtension = raw.includes(Buffer.from('NETSCAPE2.0'));
  const candidateMode = args.candidateMode ?? 'uniform';
  const keyposeCandidates = candidateMode === 'keypose' ? buildKeyposeCandidates(entries, c.width, c.height, args.candidateCount ?? 8, args.minCandidateGap) : undefined;
  const report = { ok: true, version: 2, sourceHash: createHash('sha256').update(raw).digest('hex'), filePath: args.filePath, width: c.width, height: c.height, duration: time / 1000, estimatedPeriod: time / 1000, loop: args.loop ?? loopExtension, loopEvidence: args.loop !== undefined ? 'Agent 指定' : 'GIF NETSCAPE 扩展', frames: entries, bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null, phases, phaseSource: phases.length ? 'Agent 标注' : '未标注', candidateMode, keyposeCandidates, warnings: ['GIF 只用于姿态和节奏参考；相机运动与角色运动不能仅凭拆帧自动区分。', '候选帧只供人工审查，不自动成为 KEY pose 或阶段。', 'estimatedPeriod 为文件总时长，需 Agent 确认是否完整循环。'], manifestPath: `${dir}/reference-manifest.json`, contactSheet: await buildReferenceContactSheet({ frames: (keyposeCandidates ?? entries.filter((e: any) => e.duplicateOf === null)) as any, dir, name: `frames-${columns}.png`, columns, maxTiles, context }) };
  await writeFile(resolveWorkspacePath(report.manifestPath, context), JSON.stringify(report, null, 2) + '\n'); return { ...report, __images: [report.contactSheet] };
}

export async function extractReferenceKeyframes(args: { manifestPath: string; count?: number; columns?: number; maxTiles?: number; candidateMode?: 'uniform' | 'keypose'; minCandidateGap?: number }, context: ToolContext = {}) {
  const r = JSON.parse(await readFile(resolveWorkspacePath(args.manifestPath, context), 'utf8')), count = args.count ?? 8;
  if (!Number.isInteger(count) || count < 2 || count > 32) throw new Error('关键姿态数量必须为2–32。');
  const columns = args.columns ?? 4, maxTiles = args.maxTiles ?? 12;
  assertContactSheetOptions(columns, maxTiles);
  const unique = r.frames.filter((f: any) => f.duplicateOf === null);
  const keys = args.candidateMode === 'keypose' ? (r.keyposeCandidates?.length ? r.keyposeCandidates.slice(0, count) : buildKeyposeCandidates(r.frames, r.width, r.height, count, args.minCandidateGap)) : Array.from({ length: Math.min(count, unique.length) }, (_, i) => unique[Math.floor(i * (unique.length - 1) / Math.max(1, Math.min(count, unique.length) - 1))]);
  const sheet = await buildReferenceContactSheet({ frames: keys, dir: manifestDir(args.manifestPath), name: `keyframes-${columns}.png`, columns, maxTiles, context });
  return { ok: true, sourceHash: r.sourceHash, candidateMode: args.candidateMode ?? 'uniform', keyframes: keys, phases: r.phases, warnings: [...(r.warnings ?? []), '候选帧不自动批准，仍需逐阶段参考标注与视觉审查。'], keyframeSheet: sheet, __images: [sheet] };
}

async function analyzeRasterReference(args:any,raw:Buffer,context:ToolContext) {
 const meta=await sharp(raw,{animated:true,limitInputPixels:4194304*1000}).metadata();const pages=meta.pages??1,width=meta.width!,height=meta.pageHeight??meta.height!;
 if(pages>1000||width*height>4194304||pages*width*height>64000000)throw new Error('参考图片超出处理上限。');
 const dir=args.outputDir??`previews/jobs/reference-${randomUUID()}`;await mkdir(resolveWorkspacePath(dir,context),{recursive:true});const decoded=await sharp(raw,{animated:true}).ensureAlpha().raw().toBuffer();const bytes=width*height*4;if(decoded.length!==pages*bytes)throw new Error('参考帧解码尺寸不匹配。');
 const frames: ReferenceFrameEntry[]=[],seen=new Map<string,number>();let time=0;let previousPixels: ArrayLike<number>|undefined;let previousBounds:any;
 for(let i=0;i<pages;i++){const pixels=decoded.subarray(i*bytes,(i+1)*bytes),hash=createHash('sha256').update(pixels).digest('hex'),delay=meta.delay?.[i]||args.fallbackDelay||100,filePath=`${dir}/frame-${String(i).padStart(4,'0')}.png`,frameBounds=boundsFromPixels(pixels,width,height);await sharp(pixels,{raw:{width,height,channels:4}}).png().toFile(resolveWorkspacePath(filePath,context));frames.push({index:i,time:time/1000,delay,originalDelay:meta.delay?.[i]??null,delayCorrected:!meta.delay?.[i],hash,duplicateOf:seen.get(hash)??null,filePath,frameBounds,appearanceDelta:calculateAppearanceDelta(previousPixels,pixels,width,height),bboxMotion:bboxMotion(previousBounds,frameBounds,width,height)});if(!seen.has(hash))seen.set(hash,i);time+=delay;previousPixels=new Uint8ClampedArray(pixels);previousBounds=frameBounds;}
 const columns=args.columns??4,maxTiles=args.maxTiles??12;assertContactSheetOptions(columns,maxTiles);
 const candidateMode=args.candidateMode??'uniform',keyposeCandidates=candidateMode==='keypose'?buildKeyposeCandidates(frames,width,height,args.candidateCount??8,args.minCandidateGap):undefined;
 const result={ok:true,version:2,filePath:args.filePath,sourceHash:createHash('sha256').update(raw).digest('hex'),format:meta.format,width,height,duration:time/1000,estimatedPeriod:time/1000,loop:args.loop??(meta.loop===0),frames,phases:args.phases??[],candidateMode,keyposeCandidates,warnings:['图像关键点需要 Agent 标注；总时长不能直接证明完整动作周期。','候选帧只供人工审查，不自动成为 KEY pose 或阶段。'],manifestPath:`${dir}/reference-manifest.json`,contactSheet:await buildReferenceContactSheet({frames:(keyposeCandidates??frames.filter((e:any)=>e.duplicateOf===null)) as any,dir,name:`frames-${columns}.png`,columns,maxTiles,context})};await writeFile(resolveWorkspacePath(result.manifestPath,context),JSON.stringify(result,null,2));return {...result,__images:[result.contactSheet]};
}
