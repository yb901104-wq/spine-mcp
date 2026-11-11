import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import gifenc from 'gifenc';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { analyzeReferenceGif, extractReferenceKeyframes, readReferenceFrames } from '../src/referenceTools.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const DIR = 'test-output/reference-contact-sheet';

/** 合成一份测试参考 GIF：小方块单调下移 12 帧（保证各帧互不相同），
 * 第 5 帧复用第 4 帧内容以制造唯一一处重复帧。
 * 刻意不使用正弦摆动——对称位置会产生额外重复帧，使唯一帧数不可预测。 */
async function writeFixtureGif(): Promise<string> {
  await mkdir(DIR, { recursive: true });
  const p = `${DIR}/probe.gif`, N = 12, S = 64, gif = GIFEncoder();
  for (let i = 0; i < N; i++) {
    const src = i === 5 ? 4 : i;
    const c = createCanvas(S, S), ctx = c.getContext('2d');
    ctx.fillStyle = '#20242b'; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#e04f5f'; ctx.fillRect(24, 6 + src * 4, 16, 16);
    const data = ctx.getImageData(0, 0, S, S).data, palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), S, S, { palette, delay: 100, repeat: 0 });
  }
  gif.finish();
  await writeFile(p, gif.bytes());
  return p;
}

test.before(async () => { await rm(DIR, { recursive: true, force: true }); });

test('按时间分页保留重复参考帧、原始延迟和原图', async () => {
  await writeFixtureGif();
  const context = { workspaceRoot: DIR };
  const first = await readReferenceFrames({ filePath: 'probe.gif', start: 0.4, end: 0.6, limit: 2 }, context);
  assert.deepEqual(first.frames.map(frame => frame.index), [4, 5]);
  assert.equal(first.frames[1].duplicateOf, 4);
  assert.equal(first.frames[1].originalDelay, 100);
  assert.equal(first.nextOffset, 2);
  const next = await readReferenceFrames({ filePath: 'probe.gif', start: 0.4, end: 0.6, offset: 2, view: 'frames' }, context);
  assert.deepEqual(next.frames.map(frame => frame.index), [6]);
  assert.deepEqual(next.__images, [next.frames[0].filePath]);
  assert.equal(next.nextOffset, null);
});

test('参考 GIF 分析产出联系表，并以图片回传给模型', async () => {
  const gifPath = await writeFixtureGif();
  const r: any = await analyzeReferenceGif({ filePath: gifPath, outputDir: `${DIR}/job` }, {});
  assert.equal(r.ok, true);
  assert.equal(r.frames.length, 12, '应拆出 12 帧');
  assert.equal(r.frames.filter((f: any) => f.duplicateOf === null).length, 11, '第 5 帧应识别为第 4 帧的重复');

  // 关键：联系表路径存在，且通过 __images 回传（这是该机制的首次启用）
  assert.ok(typeof r.contactSheet === 'string' && r.contactSheet.endsWith('.png'));
  assert.deepEqual(r.__images, [r.contactSheet], '__images 必须携带联系表，模型才无需自行读图');
  const bytes = await readFile(r.contactSheet);
  assert.ok(bytes.length > 0 && bytes.subarray(1, 4).toString() === 'PNG', '联系表必须是有效 PNG');

  // 画布尺寸：4 列 × 11 格 → 3 行
  const img = await loadImage(bytes);
  assert.equal(img.width, 4 * 256);
  assert.equal(img.height, Math.ceil(11 / 4) * 280);

  // manifest 持久化不含 __images（避免污染产物），但保留 contactSheet
  const manifest = JSON.parse(await readFile(r.manifestPath, 'utf8'));
  assert.equal(manifest.contactSheet, r.contactSheet);
  assert.equal(manifest.__images, undefined, 'manifest 不应写入 __images');
});

test('关键帧提取产出联系表并回传图片', async () => {
  const gifPath = await writeFixtureGif();
  const a: any = await analyzeReferenceGif({ filePath: gifPath, outputDir: `${DIR}/job2` }, {});
  const r: any = await extractReferenceKeyframes({ manifestPath: a.manifestPath, count: 8 }, {});
  assert.equal(r.keyframes.length, 8);
  assert.ok(typeof r.keyframeSheet === 'string');
  assert.deepEqual(r.__images, [r.keyframeSheet]);
  const img = await loadImage(await readFile(r.keyframeSheet));
  assert.equal(img.width, 4 * 256, '默认 4 列');
  assert.equal(img.height, Math.ceil(8 / 4) * 280, '8 格 → 2 行');
});

test('联系表列数与格数受控，超范围直接拒绝', async () => {
  const gifPath = await writeFixtureGif();
  const a: any = await analyzeReferenceGif({ filePath: gifPath, outputDir: `${DIR}/job3` }, {});
  await assert.rejects(() => analyzeReferenceGif({ filePath: gifPath, columns: 13 } as any, {}), /columns/);
  await assert.rejects(() => analyzeReferenceGif({ filePath: gifPath, maxTiles: 33 } as any, {}), /maxTiles/);
  await assert.rejects(() => extractReferenceKeyframes({ manifestPath: a.manifestPath, columns: 0 } as any, {}), /columns/);
});

test('maxTiles 限制联系表格数，避免大 GIF 撑爆画布', async () => {
  const gifPath = await writeFixtureGif();
  const a: any = await analyzeReferenceGif({ filePath: gifPath, outputDir: `${DIR}/job4`, maxTiles: 3, columns: 3 }, {});
  const img = await loadImage(await readFile(a.contactSheet));
  assert.equal(img.width, 3 * 256);
  assert.equal(img.height, 1 * 280, 'maxTiles=3 且 3 列 → 单行');
});
