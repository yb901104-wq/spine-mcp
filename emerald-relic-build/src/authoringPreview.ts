import { createCanvas, loadImage } from '@napi-rs/canvas';
import { randomUUID } from 'node:crypto';
import { renderAnimationFrames, renderAnimationGif, renderContactSheet, encodePngGif, type RenderOptions } from './previewRenderTools.js';
import { worldVertices, type createMotionRuntime } from './motionRuntime.js';
import { invalid } from './authoringEdits.js';
import { readBytes, readJson, writeBytes, within, type Json } from './authoringProject.js';
import { taskCheckpoint } from './taskControl.js';
import { referenceManifest } from './referenceTools.js';
import type { ToolContext } from './spineJson.js';

type Runtime = ReturnType<typeof createMotionRuntime>;

export function measureDraft(runtime: Runtime, animation: string, skin: string | undefined,
  queries: Array<{ bone: string; start: number; end: number; tolerance?: number }>) {
  const duration = runtime.data.findAnimation(animation)?.duration ?? 0;
  return queries.map(query => {
    if (query.start > query.end || query.end > duration + 1e-6) invalid(`骨骼 ${query.bone} 的测量范围超出动画。`);
    const count = Math.max(2, Math.min(240, Math.ceil((query.end - query.start) * 60) + 1));
    const positions = Array.from({ length: count }, (_, index) => {
      const time = query.start + (query.end - query.start) * index / (count - 1);
      const bone = runtime.sample(animation, time, skin).findBone(query.bone);
      if (!bone) invalid(`找不到测量骨骼 ${query.bone}。`);
      return { x: bone.worldX, y: bone.worldY };
    });
    const { x, y } = positions[0];
    const maxDrift = Math.max(...positions.map(point => Math.hypot(point.x - x, point.y - y)));
    const xs = positions.map(point => point.x), ys = positions.map(point => point.y);
    return { ...query, samples: count, maxDrift, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
      aboveTolerance: query.tolerance === undefined ? null : maxDrift > query.tolerance };
  });
}

export async function renderDraftView(args: Json, source: { filePath: string; atlasPath: string; runtime: Runtime },
  animation: string, outputDir: string, context: ToolContext) {
  const animationData = source.runtime.data.findAnimation(animation);
  if (!animationData) invalid(`动画不存在或没有关键帧：${animation}。`);
  const duration = animationData.duration;
  const fps = args.fps ?? 24;
  const opts: RenderOptions = { filePath: source.filePath, atlasPath: source.atlasPath, animation,
    skin: args.skin, fps, frames: Math.max(2, Math.min(240, Math.ceil(duration * fps))), outputDir };
  if (args.view === 'frame' || args.view === 'debug') {
    const time = args.time ?? 0;
    if (time > duration + 1e-6) invalid(`采样时间超出动画时长 ${duration}s。`);
    const rendered = await renderAnimationFrames({ ...opts, times: [time] }, context);
    const frame = rendered.frames[0];
    const skeleton = source.runtime.sample(animation, time, rendered.skin ?? undefined);
    const coordinates = Object.fromEntries(skeleton.bones.map(bone => [bone.data.name, { x: bone.worldX, y: bone.worldY }]));
    if (args.view === 'frame') return { ...compact(rendered), frame, times: [time], coordinates, __images: [frame] };
    const overlay = await drawOverlay(rendered, skeleton, frame, outputDir, context);
    return { ...compact(rendered), frame, overlay, times: [time], coordinates, __images: [overlay] };
  }
  const rendered = await (args.view === 'sheet' ? renderContactSheet(opts, context) : renderAnimationGif(opts, context));
  return { ...compact(rendered), __images: rendered.contactSheet ? [rendered.contactSheet] : [rendered.frames[0]] };
}

function compact(value: Json) {
  return {
    manifestPath: value.manifestPath, duration: value.duration, frames: value.frames as string[], fps: value.fps,
    frameCount: value.frameCount, skin: value.skin, gifPath: value.gifPath, contactSheet: value.contactSheet,
    times: value.sampleTimes ?? Array.from({ length: value.frames.length }, (_, i) => value.duration * i / value.frames.length),
    bounds: value.bounds, canvas: value.canvas,
  };
}

async function drawOverlay(rendered: Json, skeleton: ReturnType<Runtime['sample']>, frame: string, output: string, context: ToolContext) {
  const { width, height } = rendered.canvas, bounds = rendered.bounds;
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  ctx.drawImage(await loadImage(await readBytes(frame, context)), 0, 0);
  const scale = Math.min(width / (bounds.maxX - bounds.minX), height / (bounds.maxY - bounds.minY));
  const px = (x: number) => width / 2 + (x - (bounds.minX + bounds.maxX) / 2) * scale;
  const py = (y: number) => height / 2 - (y - (bounds.minY + bounds.maxY) / 2) * scale;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#62e5d2';
  for (const values of Object.values(worldVertices(skeleton))) {
    for (let i = 0; i < values.length; i += 2) {
      ctx.beginPath(); ctx.arc(px(values[i]), py(values[i + 1]), 1.6, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.strokeStyle = '#ffcc80';
  for (const bone of skeleton.bones) {
    if (!bone.parent) continue;
    ctx.beginPath(); ctx.moveTo(px(bone.parent.worldX), py(bone.parent.worldY)); ctx.lineTo(px(bone.worldX), py(bone.worldY)); ctx.stroke();
  }
  const overlay = within(output, 'debug.png');
  await writeBytes(overlay, canvas.toBuffer('image/png'), context);
  return overlay;
}

export async function comparisonReference(args: Json, context: ToolContext) {
  const manifest = args.referencePath ? await referenceManifest(args.referencePath, context) : await readJson(args.referenceManifestPath, context);
  if (!Array.isArray(manifest.frames) || !manifest.frames.length || !Number.isFinite(manifest.duration)) invalid('参考 manifest 缺少帧或有效时长。');
  return { duration: manifest.duration as number, frames: manifest.frames.map((frame: string | Json, i: number) =>
    typeof frame === 'string' ? { filePath: frame, time: manifest.sampleTimes?.[i] ?? i * manifest.duration / manifest.frames.length } :
      { filePath: frame.filePath as string, time: frame.time as number }) };
}

export async function renderDraftComparison(target: Awaited<ReturnType<typeof renderDraftView>>,
  reference: Awaited<ReturnType<typeof comparisonReference>>, phaseMap: Array<{ targetTime: number; referenceTime: number }> | undefined,
  output: string, context: ToolContext) {
  if (phaseMap && (phaseMap[0].targetTime !== 0 || Math.abs(phaseMap.at(-1)!.targetTime - target.duration) > 1e-5 ||
    phaseMap.some((point, i) => point.referenceTime > reference.duration + 1e-6 ||
      (i > 0 && (point.targetTime <= phaseMap[i - 1].targetTime || point.referenceTime < phaseMap[i - 1].referenceTime))))) {
    invalid('对齐点需覆盖目标时长并按时间排列，参考时间不得越界。');
  }
  const refTime = (time: number) => {
    if (!phaseMap) return Math.min(reference.duration, time);
    const i = Math.min(phaseMap.length - 1, phaseMap.findIndex(point => point.targetTime >= time));
    if (i <= 0) return i === 0 ? phaseMap[0].referenceTime : phaseMap.at(-1)!.referenceTime;
    const left = phaseMap[i - 1], right = phaseMap[i];
    return left.referenceTime + (right.referenceTime - left.referenceTime) * (time - left.targetTime) / (right.targetTime - left.targetTime);
  };
  const frames: string[] = [], { width, height } = target.canvas;
  for (const [i, frame] of target.frames.entries()) {
    await taskCheckpoint('同步比较');
    const time = refTime(target.times[i]);
    const ref = reference.frames.findLast((entry: { time: number }) => entry.time <= time + 1e-8) ?? reference.frames[0];
    const source = await loadImage(await readBytes(ref.filePath, context)), candidate = await loadImage(await readBytes(frame, context));
    const canvas = createCanvas(width * 2, height), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#20242b'; ctx.fillRect(0, 0, width * 2, height);
    const scale = Math.min(width / source.width, height / source.height);
    ctx.drawImage(source, (width - source.width * scale) / 2, (height - source.height * scale) / 2, source.width * scale, source.height * scale);
    ctx.drawImage(candidate, width, 0, width, height);
    ctx.fillStyle = '#ffffff'; ctx.font = '14px sans-serif';
    ctx.fillText(`参考 ${time.toFixed(3)}s`, 8, 20);
    ctx.fillText(`候选 ${Number(target.times[i]).toFixed(3)}s`, width + 8, 20);
    const png = within(output, `compare-${i}.png`);
    await writeBytes(png, canvas.toBuffer('image/png'), context);
    frames.push(png);
  }
  const gif = await encodePngGif({ framePaths: frames, outputPath: within(output, `comparison-${randomUUID()}.gif`),
    delayMs: Math.max(10, Math.round(target.duration * 1000 / frames.length)) }, context);
  return { ...target, targetGif: target.gifPath, gifPath: gif.gifPath, frames, __images: [frames[0]] };
}
