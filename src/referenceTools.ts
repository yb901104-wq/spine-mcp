import sharp from 'sharp';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';

export async function analyzeReferenceGif(args: { filePath: string; outputDir?: string; fallbackDelay?: number; phases?: Array<{ time: number; phase: string }>; loop?: boolean }, context: ToolContext = {}) {
  if(args.fallbackDelay!==undefined&&(!Number.isFinite(args.fallbackDelay)||args.fallbackDelay<=0))throw new Error('fallbackDelay 必须为正数。');
  const raw = await readFile(resolveWorkspacePath(args.filePath, context));
  if(!raw.subarray(0,6).toString().startsWith('GIF8'))return analyzeRasterReference(args,raw,context);
  const gif = parseGIF(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), frames = decompressFrames(gif, true);
  if (!frames.length || frames.length > 1000 || gif.lsd.width * gif.lsd.height > 4194304) throw new Error('参考 GIF 为空或超出处理上限。');
  const dir = args.outputDir ?? `previews/jobs/reference-${randomUUID()}`, absolute = resolveWorkspacePath(dir, context); await mkdir(absolute, { recursive: true });
  const c = createCanvas(gif.lsd.width, gif.lsd.height), ctx = c.getContext('2d');
  let previous: any, time = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const entries: any[] = [], seen = new Map<string, number>();
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
    const filePath = `${dir}/frame-${String(i).padStart(4, '0')}.png`; await writeFile(resolveWorkspacePath(filePath, context), c.toBuffer('image/png'));
    entries.push({ index: i, time: time / 1000, delay, originalDelay: f.delay, delayCorrected: !f.delay, hash, duplicateOf: seen.get(hash) ?? null, filePath });
    if (!seen.has(hash)) seen.set(hash, i); time += delay; previous = { frame: f, saved };
  }
  const phases = args.phases ?? [];
  if (phases.some(p => !Number.isFinite(p.time) || p.time < 0 || p.time > time / 1000 || !p.phase)) throw new Error('参考阶段标注的时间或名称无效。');
  const loopExtension = raw.includes(Buffer.from('NETSCAPE2.0'));
  const report = { ok: true, version: 1, sourceHash: createHash('sha256').update(raw).digest('hex'), filePath: args.filePath, width: c.width, height: c.height, duration: time / 1000, estimatedPeriod: time / 1000, loop: args.loop ?? loopExtension, loopEvidence: args.loop !== undefined ? 'Agent 指定' : 'GIF NETSCAPE 扩展', frames: entries, bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null, phases, phaseSource: phases.length ? 'Agent 标注' : '未标注', warnings: ['GIF 只用于姿态和节奏参考；相机运动与角色运动不能仅凭拆帧自动区分。', 'estimatedPeriod 为文件总时长，需 Agent 确认是否完整循环。'], manifestPath: `${dir}/reference-manifest.json` };
  await writeFile(resolveWorkspacePath(report.manifestPath, context), JSON.stringify(report, null, 2) + '\n'); return report;
}

export async function extractReferenceKeyframes(args: { manifestPath: string; count?: number }, context: ToolContext = {}) {
  const r = JSON.parse(await readFile(resolveWorkspacePath(args.manifestPath, context), 'utf8')), count = args.count ?? 8;
  if (!Number.isInteger(count) || count < 2 || count > 32) throw new Error('关键姿态数量必须为2–32。');
  const unique = r.frames.filter((f: any) => f.duplicateOf === null);
  const keys = Array.from({ length: Math.min(count, unique.length) }, (_, i) => unique[Math.floor(i * (unique.length - 1) / Math.max(1, Math.min(count, unique.length) - 1))]);
  return { ok: true, sourceHash: r.sourceHash, keyframes: keys, phases: r.phases, warnings: r.warnings };
}

async function analyzeRasterReference(args:any,raw:Buffer,context:ToolContext) {
 const meta=await sharp(raw,{animated:true,limitInputPixels:4194304*1000}).metadata();const pages=meta.pages??1,width=meta.width!,height=meta.pageHeight??meta.height!;
 if(pages>1000||width*height>4194304||pages*width*height>64000000)throw new Error('参考图片超出处理上限。');
 const dir=args.outputDir??`previews/jobs/reference-${randomUUID()}`;await mkdir(resolveWorkspacePath(dir,context),{recursive:true});const decoded=await sharp(raw,{animated:true}).ensureAlpha().raw().toBuffer();const bytes=width*height*4;if(decoded.length!==pages*bytes)throw new Error('参考帧解码尺寸不匹配。');
 const frames=[],seen=new Map<string,number>();let time=0;
 for(let i=0;i<pages;i++){const pixels=decoded.subarray(i*bytes,(i+1)*bytes),hash=createHash('sha256').update(pixels).digest('hex'),delay=meta.delay?.[i]||args.fallbackDelay||100,filePath=`${dir}/frame-${String(i).padStart(4,'0')}.png`;await sharp(pixels,{raw:{width,height,channels:4}}).png().toFile(resolveWorkspacePath(filePath,context));frames.push({index:i,time:time/1000,delay,originalDelay:meta.delay?.[i]??null,delayCorrected:!meta.delay?.[i],hash,duplicateOf:seen.get(hash)??null,filePath});if(!seen.has(hash))seen.set(hash,i);time+=delay;}
 const result={ok:true,version:1,filePath:args.filePath,sourceHash:createHash('sha256').update(raw).digest('hex'),format:meta.format,width,height,duration:time/1000,estimatedPeriod:time/1000,loop:args.loop??(meta.loop===0),frames,phases:args.phases??[],warnings:['图像关键点需要 Agent 标注；总时长不能直接证明完整动作周期。'],manifestPath:`${dir}/reference-manifest.json`};await writeFile(resolveWorkspacePath(result.manifestPath,context),JSON.stringify(result,null,2));return result;
}
