import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import gifenc from 'gifenc';
import { createCanvas } from '@napi-rs/canvas';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { renderAnimationComparison } from '../src/animationReview.js';
import { animationChecks } from '../src/poseWorkflow.js';
import { animationComparisonLayouts, skeletonFormalAcceptanceReady } from '../src/animationAcceptancePolicy.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const DIR = `.test-output-reference-overlay-${randomUUID()}`;
const W = 128, H = 128, N = 4;
const BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

/** 合成一张 PNG：整幅填色 + 一个位置随索引变化的方块。 */
async function writePng(p: string, fill: string, box: string, i: number) {
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = fill; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = box; ctx.fillRect(40, 20 + i * 12, 32, 32);
  await writeFile(p, c.toBuffer('image/png'));
}

async function writeGif(p: string) {
  const gif = GIFEncoder();
  for (let i = 0; i < N; i++) {
    const c = createCanvas(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = '#20242b'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e04f5f'; ctx.fillRect(40, 20 + i * 12, 32, 32);
    const data = ctx.getImageData(0, 0, W, H).data, palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: 100, repeat: 0 });
  }
  gif.finish();
  await writeFile(p, gif.bytes());
}

async function writeJson(p: string, obj: unknown) { await writeFile(p, JSON.stringify(obj, null, 2)); }

/** GIF 逻辑屏幕描述符：宽度在 6-7 字节，高度在 8-9 字节（小端）。 */
function gifSize(bytes: Buffer) { return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }; }

async function buildFixtures(): Promise<{ targetManifestPath: string; referenceManifestPath: string; poseManifestPath: string }> {
  await mkdir(`${DIR}/ref`, { recursive: true });
  await mkdir(`${DIR}/tgt`, { recursive: true });
  const refFrames = [], tgtFrames = [];
  for (let i = 0; i < N; i++) {
    const rp = `${DIR}/ref/frame-${i}.png`, tp = `${DIR}/tgt/frame-${i}.png`;
    await writePng(rp, '#20242b', '#4f9ee0', i);
    await writePng(tp, '#20242b', '#e04f5f', i);
    refFrames.push({ index: i, time: i * 0.25, filePath: rp });
    tgtFrames.push(tp);
  }
  const gifPath = `${DIR}/tgt/target.gif`;
  await writeGif(gifPath);
  const target = `${DIR}/target-manifest.json`, reference = `${DIR}/reference-manifest.json`, poses = `${DIR}/pose-manifest.json`;
  await writeJson(target, {
    ok: true, duration: 1, frameCount: N, frames: tgtFrames, gifPath, jsonHash: 'h'.repeat(64),
    canvas: { width: W, height: H, background: '#20242b' }, bounds: BOUNDS, outputDir: `${DIR}/tgt`,
  });
  await writeJson(reference, { ok: true, duration: 1, frames: refFrames });
  // 对齐参数刻意取成"参考与目标完全重合"：rs = targetScale*standardHeight/height = 1，
  // 且 refY = h*0.9 - groundY*rs = 0、refX = w/2 - cropW*rs/2 = 0。
  // 这样叠加处能直接看出半透明混合；若两者错位，视觉上无法判断 alpha 是否生效。
  await writeJson(poses, {
    ok: true, bounds: BOUNDS, standardHeight: H, targetScale: 1,
    reference: { imagePath: `${DIR}/ref/frame-0.png`, crop: [0, 0, W, H], height: H, groundY: H * 0.9, facing: 'left', time: 0 },
  });
  return { targetManifestPath: target, referenceManifestPath: reference, poseManifestPath: poses };
}

const phaseMap = [{ targetTime: 0, referenceTime: 0 }, { targetTime: 1, referenceTime: 1 }];

test.before(async () => { await rm(DIR, { recursive: true, force: true }); });
test.after(async () => { await rm(DIR, { recursive: true, force: true }); });

test('默认布局保持上下排列，不破坏既有证据', async () => {
  const f = await buildFixtures();
  const r: any = await renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-default` }, {});
  assert.equal(r.ok, true);
  assert.equal(r.layout, 'reference-above-target', '默认必须保持原布局');
  assert.ok(r.gifPath.endsWith('reference-above-target.gif'));
  const size = gifSize(await readFile(r.gifPath));
  assert.equal(size.width, W);
  assert.equal(size.height, (H + 28) * 2, '上下排列：画布为两倍高');
  assert.ok(r.evidence.length > 0, '证据必须绑定');
});

test('overlay 布局把目标叠在参考上，画布为单幅高', async () => {
  const f = await buildFixtures();
  const r: any = await renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-overlay`, layout: 'overlay', opacity: 0.5 }, {});
  assert.equal(r.ok, true);
  assert.equal(r.layout, 'overlay');
  assert.equal(r.opacity, 0.5);
  assert.ok(r.gifPath.endsWith('reference-overlay.gif'));
  const size = gifSize(await readFile(r.gifPath));
  assert.equal(size.width, W);
  assert.equal(size.height, H + 44, '叠加：画布为单幅高（+两行标签条）');
  assert.ok(r.evidence.length > 0, '叠加同样必须绑定证据');
});

test('布局与不透明度越界直接拒绝', async () => {
  const f = await buildFixtures();
  await assert.rejects(
    () => renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-bad`, layout: 'side-by-side' } as any, {}),
    /layout/,
  );
  await assert.rejects(
    () => renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-bad2`, layout: 'overlay', opacity: 1.5 } as any, {}),
    /opacity/,
  );
  await assert.rejects(
    () => renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-bad3`, layout: 'overlay', opacity: 0 } as any, {}),
    /opacity/,
  );
});

/** 统计 GIF 实际帧数，验证 times 真的减少了输出帧。用 gifuct 解码，不手写字节解析。 */
function gifFrameCount(bytes: Buffer): number {
  const gif = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return decompressFrames(gif, true).length;
}

test('times 只输出指定时间点，不强制整段', async () => {
  const f = await buildFixtures();
  const all: any = await renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-times-all` }, {});
  assert.equal(all.frameCount, N, '不给 times 时整段输出');
  assert.equal(gifFrameCount(await readFile(all.gifPath)), N);

  const two: any = await renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-times-2`, times: [0, 0.75] }, {});
  assert.equal(two.frameCount, 2);
  assert.deepEqual(two.frameTimes.map((v: number) => +v.toFixed(3)), [0, 0.75], '按最接近的采样帧取用');
  assert.equal(gifFrameCount(await readFile(two.gifPath)), 2, 'GIF 实际帧数应减少，而非只改报告字段');
});

test('times 越界或为空直接拒绝', async () => {
  const f = await buildFixtures();
  await assert.rejects(() => renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-t-bad`, times: [] } as any, {}), /times/);
  await assert.rejects(() => renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-t-bad2`, times: [0, 99] } as any, {}), /times/);
  await assert.rejects(() => renderAnimationComparison({ ...f, phaseMap, outputDir: `${DIR}/out-t-bad3`, times: [-1] } as any, {}), /times/);
});

test('审查门禁接受三种布局，且仍强制要求绑定证据', async () => {
  // 直接读取门禁源码所在行的可接受布局集合，防止后续有人只改一处而漏改另一处。
  const src = await readFile(new URL('../src/animationReview.ts', import.meta.url), 'utf8');
  const gateLine = src.split('\n').find(l => l.includes('requiresReferenceComparison') && l.includes('includes(m.layout)'));
  assert.ok(gateLine, '必须存在布局门禁行');
  assert.ok(gateLine.includes('animationComparisonLayouts.includes(m.layout)'), '门禁必须复用共享布局策略');
  assert.deepEqual(animationComparisonLayouts, ['reference-above-target', 'overlay', 'skeleton']);
  assert.equal(skeletonFormalAcceptanceReady({ acceptanceMode: 'diagnostic', acceptanceEligible: true }), false);
  assert.equal(skeletonFormalAcceptanceReady({ acceptanceMode: 'formal', acceptanceEligible: true }), true);
  const evidenceLine = src.split('\n').find(l => l.includes('requiresReferenceComparison') && l.includes('m.evidence'));
  assert.ok(evidenceLine, '放宽布局后仍须保留证据绑定校验');
  assert.ok(animationChecks.length >= 5, '完整动画审查项不得因本次改动减少');
});
