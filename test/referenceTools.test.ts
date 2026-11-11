import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import gifenc from 'gifenc';
import { analyzeReferenceGif, extractReferenceKeyframes } from '../src/referenceTools.js';
import { auditReferenceObservationImage, auditReferenceKeypose } from '../src/referencePose.js';
import { readFile } from 'node:fs/promises';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const DIR = `.test-output-reference-tools-${randomUUID()}`;

test.before(async () => { await rm(DIR, { recursive: true, force: true }); await mkdir(DIR, { recursive: true }); });
test.after(async () => { await rm(DIR, { recursive: true, force: true }); });

test('keypose 候选结合均匀覆盖与运动候选且不自动批准', async () => {
  const gif = GIFEncoder();
  for (let i = 0; i < 12; i++) {
    const c = createCanvas(64, 64), ctx = c.getContext('2d');
    ctx.fillStyle = '#20242b'; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#f0c040'; ctx.fillRect(i < 4 ? 8 : i < 8 ? 32 : 12, 20, 16, 16);
    const data = ctx.getImageData(0, 0, 64, 64).data, palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), 64, 64, { palette, delay: 100, repeat: 0 });
  }
  gif.finish();
  const gifPath = `${DIR}/reference.gif`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(gifPath, gif.bytes());
  const report: any = await analyzeReferenceGif({ filePath: gifPath, outputDir: `${DIR}/analysis`, candidateMode: 'keypose', candidateCount: 6 });
  assert.equal(report.candidateMode, 'keypose');
  assert.equal(report.frames.length, 12);
  assert.ok(Array.isArray(report.keyposeCandidates));
  assert.ok(report.keyposeCandidates.length >= 2 && report.keyposeCandidates.length <= 6);
  assert.ok(report.keyposeCandidates.some((x: any) => x.source === 'uniform'));
  assert.ok(report.warnings.some((x: string) => x.includes('不自动')));
  const extracted: any = await extractReferenceKeyframes({ manifestPath: report.manifestPath, candidateMode: 'keypose', count: 4 });
  assert.equal(extracted.sourceHash, report.sourceHash);
  assert.equal(extracted.candidateMode, 'keypose');
  assert.ok(extracted.keyframes.length <= 4);
});

test('真实参考 pose 的可见关键点落在背景时被输入审查拦截', async () => {
  const pose = JSON.parse(await readFile('diagnostic-fixture/clipboard-reference/poses2/stage-jump.reference.json', 'utf8'));
  const audit: any = await auditReferenceObservationImage(pose.observation, { workspaceRoot: 'diagnostic-fixture' });
  assert.equal(audit.ok, false);
  assert.ok(audit.blocking.some((item: any) => item.role === 'rightWrist'));
  assert.ok(audit.blocking.some((item: any) => item.role === 'rightAnkle'));
});

test('keypose 语义审查独立阻断未确认左右、支撑和朝向', () => {
  const observation:any = {
    facing: 'right',
    points: {
      head:{visibility:'visible',confidence:.9}, body:{visibility:'visible',confidence:.9},
      leftShoulder:{visibility:'visible',confidence:.9}, rightShoulder:{visibility:'visible',confidence:.9},
      leftHip:{visibility:'visible',confidence:.9}, rightHip:{visibility:'visible',confidence:.9}
    },
    anatomicalIdentity:{status:'pending',basis:''},
    support:{left:true},
    orientation:{version:1,band:'threeQuarter',basis:''},
    depth:{evidence:[]}
  };
  const audit:any = auditReferenceKeypose(observation,{ok:true});
  assert.equal(audit.ok,false);
  assert.ok(audit.blocking.some((x:any)=>x.code==='KEYPOSE_IDENTITY_UNCONFIRMED'));
  assert.ok(audit.blocking.some((x:any)=>x.code==='KEYPOSE_SUPPORT_UNCONFIRMED'));
  assert.ok(audit.blocking.some((x:any)=>x.code==='KEYPOSE_ORIENTATION_UNCONFIRMED'));
  assert.ok(audit.blocking.some((x:any)=>x.code==='KEYPOSE_DEPTH_UNCONFIRMED'));
});
