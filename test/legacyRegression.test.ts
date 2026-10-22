import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { loadMotionRuntime, worldVertices } from '../src/motionRuntime.js';
import { validateSpineJson } from '../src/spineJson.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fitRuntimeAnimation } from '../src/runtimeCurveFit.js';
const legacyRoot = process.env.SPINE_LEGACY_ROOT ?? path.resolve(process.cwd(), '..', 'spine test');
const read = async (p: string) => JSON.parse((await readFile(path.join(legacyRoot, p), 'utf8')).replace(/^\uFEFF/, ''));
test('legacy idle cubic refit passes official runtime rotation, translation and vertex thresholds', async t => {
  try { await access(path.join(legacyRoot,'输出/npc1_idle_reference/npc1.json')); } catch { t.skip('缺少旧项目资源'); return; }
  const json=await read('输出/npc1_idle_reference/npc1.json');
  const original=JSON.stringify(json);
  const fit=await fitRuntimeAnimation(json,'idle-reference',{atlasPath:'输出/npc1_idle_reference/npc1.atlas',rotationTolerance:.3,translationTolerance:.07,vertexTolerance:1.2},{workspaceRoot:legacyRoot});
  assert.equal(fit.report.runtimeVerified,true);assert.ok(fit.report.samples>=1001);
  assert.ok(fit.report.maxRotationError<=.3);assert.ok(fit.report.maxTranslationError<=.07);assert.ok(fit.report.maxVertexError<=1.2);assert.ok(fit.report.loopError<1e-4);
  assert.ok(fit.report.compressedCount<fit.report.originalCount);assert.equal(JSON.stringify(json),original);
  for(const tls of Object.values(fit.animation.bones) as any[]) for(const frames of Object.values(tls) as any[]) if(Array.isArray(frames)) assert.equal(frames.at(-1)?.curve,undefined);
});
for (const [folder, animation] of [['npc1_walk','walk'],['npc1_idle_tween','idle-reference'],['npc1_explore_run','explore-run']]) {
  test(`legacy ${folder}: runtime, loop, original rig, animations and atlas unchanged`, async t => {
    try { await access(path.join(legacyRoot, '输出', folder, 'npc1.json')); } catch { t.skip('未配置旧项目资源；设置 SPINE_LEGACY_ROOT 后运行。'); return; }
    const json = await read(`输出/${folder}/npc1.json`), original = await read('previews/npc1-attack/original.json').catch(()=>read('目标/npc1.json'));
    for (const field of ['bones','slots','skins']) assert.deepEqual(json[field], original[field]);
    for (const [name, a] of Object.entries(original.animations)) assert.deepEqual(json.animations[name], a);
    for (const ext of ['atlas','png']) assert.deepEqual(await readFile(path.join(legacyRoot, '目标', `npc1.${ext}`)), await readFile(path.join(legacyRoot, '输出', folder, `npc1.${ext}`)));
    assert.equal(validateSpineJson(json).ok, true);
    const rt = await loadMotionRuntime(json, `输出/${folder}/npc1.atlas`, { workspaceRoot: legacyRoot }), duration = rt.data.findAnimation(animation)!.duration;
    const start = rt.sample(animation, 0).bones.map(b => [b.worldX,b.worldY,b.a,b.b,b.c,b.d]);
    const end = rt.sample(animation, duration).bones.map(b => [b.worldX,b.worldY,b.a,b.b,b.c,b.d]);
    for (let i=0;i<start.length;i++) for (let j=0;j<6;j++) assert.ok(Math.abs(start[i][j]-end[i][j]) < .002);
    let footError=0;
    for (let i=0;i<=72;i++) { const time = duration*i/72, vertices = worldVertices(rt.sample(animation,time)); assert.ok(Object.values(vertices).flat().every(Number.isFinite));
      if (animation === 'walk') { const feet = Object.entries(vertices).filter(([name]) => name.startsWith('yt2:') || name.startsWith('zt2:')).flatMap(([,v]) => v.filter((_,i) => i%2===1)); if(feet.length) footError=Math.max(footError,Math.abs(Math.min(...feet))); }
    }
    if (animation === 'walk') t.diagnostic(`官方 runtime 世界地面偏移实测 ${footError}；早期 Python 地面约定为0，单独回归。`);
    if (animation === 'idle-reference') {
      const dense = await read('输出/npc1_idle_reference/npc1.json'), old = await loadMotionRuntime(dense, `输出/${folder}/npc1.atlas`, {workspaceRoot:legacyRoot}); let maxR=0,maxT=0,maxV=0;
      for(let i=0;i<=336;i++) { const time=duration*i/336,s=rt.sample(animation,time), d=old.sample(animation,time); for(let k=0;k<s.bones.length;k++){ maxR=Math.max(maxR,Math.abs(s.bones[k].rotation-d.bones[k].rotation)); maxT=Math.max(maxT,Math.abs(s.bones[k].x-d.bones[k].x),Math.abs(s.bones[k].y-d.bones[k].y)); } const v=worldVertices(s), dv=worldVertices(d); for(const key of Object.keys(v)) for(let k=0;k<v[key].length;k+=2) maxV=Math.max(maxV,Math.hypot(v[key][k]-dv[key][k],v[key][k+1]-dv[key][k+1])); }
      assert.ok([maxR,maxT,maxV].every(Number.isFinite)); t.diagnostic(`官方 runtime idle 误差 rotation=${maxR}, translation=${maxT}, vertices=${maxV}；不同于早期 Python 曲线采样。`);
    }
  });
}
test('legacy Python numerical thresholds stay unchanged', async t => {
  try { await access(path.join(legacyRoot, 'spine_tools.py')); } catch { t.skip('未配置旧项目。'); return; }
  const python = process.env.SPINE_LEGACY_PYTHON ?? 'python';
  try { await promisify(execFile)(python, ['-c', 'import numpy']); }
  catch { t.skip(`解释器 ${python} 缺少 numpy，旧项目数值基线未执行；请用 SPINE_LEGACY_PYTHON 指向已安装 numpy 的 Python。门限未放宽。`); return; }
  const { stdout } = await promisify(execFile)(python, ['scripts/check-legacy-baseline.py', legacyRoot]);
  const report = JSON.parse(stdout); assert.ok(report.walk.maximum_foot_error < 9e-7); assert.ok(report['idle-reference'].rotation < .35); assert.ok(report['idle-reference'].translation < .09); t.diagnostic(stdout);
});
