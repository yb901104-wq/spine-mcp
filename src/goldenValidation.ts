import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createMotionRuntime } from './motionRuntime.js';
import { applyRenderSnapshot, REPLAY_SCHEMA_VERSION } from './renderSnapshot.js';
import { rasterFrame, loadAtlasImages } from './rasterRenderer.js';
import { resolveWorkspacePath } from './spineJson.js';
import { objectHash, strictHash } from './hostContracts.js';
import { captureRuntimeState,assertCaptureReadback } from './captureEvidence.js';
const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export interface GoldenVerdict { goldenPassed: true | false | 'unverified'; reportHash: string | null; reasons: string[]; scope?:string; cases?:Array<{id:string;changedRatio:number;maximumChannelError:number}> }
/** 只根据实际基线与 canvas 重渲染得出结论；没有基线绝不默认通过。 */
export async function validateHostGolden(root = installRoot): Promise<GoldenVerdict> {
  const context = { workspaceRoot: root };
  let manifest: any;
  try { manifest = JSON.parse(await readFile(resolveWorkspacePath('test/golden/host/manifest.json', context), 'utf8')); }
  catch (error: any) {
    return { goldenPassed: error.code === 'ENOENT' ? 'unverified' : false, reportHash: null, reasons: ['尚无可验证的三张真实 player 黄金帧基线，或基线清单无法读取。'] };
  }
  try {
    const expected = { player: '4.1.56', core: '4.1.56', replaySchema: REPLAY_SCHEMA_VERSION,
      rendererHash: strictHash(await readFile(path.join(installRoot, 'dist/rasterRenderer.js'))), replayHash: strictHash(await readFile(path.join(installRoot, 'dist/renderSnapshot.js'))) };
    if (objectHash(manifest.runtime) !== objectHash(expected) || manifest.version !== 1 || !Array.isArray(manifest.cases) || manifest.cases.length !== 3 || new Set(manifest.cases.map((c: any) => c.id)).size !== 3) throw new Error('runtime/回放/渲染器版本或三张基线的登记失配。');
    const reports: any[] = [];
    for (const fixture of manifest.cases) {
      if (fixture.source !== 'player' || !fixture.files || !fixture.viewport || fixture.dpr !== 1 || ![320,480,960].includes(fixture.size) || !fixture.camera || typeof fixture.pma !== 'boolean') throw new Error('基线缺少 player 来源、资源、固定相机、PMA 或 viewport/canvas/DPR。');
      for (const [filePath, hash] of Object.entries(fixture.files)) if (strictHash(await readFile(resolveWorkspacePath(filePath, context))) !== hash) throw new Error(`基线资源变化：${filePath}`);
      for (const required of [fixture.skeletonPath, fixture.atlasPath, fixture.snapshotPath, fixture.pngPath,fixture.captureManifestPath]) if (!Object.hasOwn(fixture.files, required)) throw new Error('基线必需文件没有严格哈希。');
      const json = JSON.parse(await readFile(resolveWorkspacePath(fixture.skeletonPath, context), 'utf8'));
      const snapshot = JSON.parse(await readFile(resolveWorkspacePath(fixture.snapshotPath, context), 'utf8'));
      const rt = createMotionRuntime(json, await readFile(resolveWorkspacePath(fixture.atlasPath, context), 'utf8'));
      for (const page of rt.atlas.pages) if (!Object.hasOwn(fixture.files, path.posix.join(path.posix.dirname(fixture.atlasPath), page.name))) throw new Error('基线 atlas 纹理缺少哈希。');
      applyRenderSnapshot(rt.skeleton, snapshot);
      const capture=JSON.parse(await readFile(resolveWorkspacePath(fixture.captureManifestPath,context),'utf8'));
      if(capture.evidenceSchema!==2||capture.source!=='player'||capture.captureValidity?.status!=='verified'||capture.advisory||capture.candidateHash!==fixture.files[fixture.skeletonPath]||capture.evidence?.[0]?.hash!==fixture.files[fixture.pngPath]||capture.playerScriptHash!==strictHash(await readFile(path.join(installRoot,'node_modules/@esotericsoftware/spine-player/dist/iife/spine-player.min.js'))))throw new Error('基线缺少匹配的真实 player 核验记录。');
      assertCaptureReadback(capture.actual,captureRuntimeState(rt.skeleton));
      assertCaptureReadback(capture.camera,fixture.camera,'camera');assertCaptureReadback(capture.viewport,fixture.viewport,'viewport');
      if(capture.dpr!==1||fixture.viewport.width!==fixture.size||fixture.viewport.height!==fixture.size||capture.pma!==fixture.pma||objectHash(snapshot.skin??null)!==objectHash(fixture.skin??null)||objectHash(snapshot.presentation??null)!==objectHash(fixture.presentation??null))throw new Error('基线视口、PMA 或显示状态失配。');
      if(capture.resourceHashes?.['pose.json']!==fixture.files[fixture.skeletonPath]||capture.resourceHashes?.['atlas.atlas']!==fixture.files[fixture.atlasPath])throw new Error('基线实际 player 资源与夹具失配。');
      for(const page of rt.atlas.pages)if(capture.resourceHashes?.[page.name]!==fixture.files[path.posix.join(path.posix.dirname(fixture.atlasPath),page.name)])throw new Error('基线实际纹理与夹具失配。');
      const images = await loadAtlasImages(rt.atlas, fixture.atlasPath, context, fixture.pma);
      const actual = rasterFrame(rt.skeleton, images, fixture.camera, fixture.size, fixture.size, '#20242b');
      const baseline = await loadImage(await readFile(resolveWorkspacePath(fixture.pngPath, context)));
      if (baseline.width !== fixture.size || baseline.height !== fixture.size) throw new Error('基线 canvas 大小不符。');
      const canvas = createCanvas(fixture.size, fixture.size), ctx = canvas.getContext('2d'); ctx.drawImage(baseline, 0, 0);
      const a = actual.getContext('2d').getImageData(0,0,fixture.size,fixture.size).data, b = ctx.getImageData(0,0,fixture.size,fixture.size).data;
      let changed = 0, maximumChannelError = 0;
      for (let i=0;i<a.length;i+=4) {
        let differs = false;
        for (let c=0;c<4;c++) { const d=Math.abs(a[i+c]-b[i+c]); maximumChannelError=Math.max(maximumChannelError,d); if(d) differs=true; }
        if(differs) changed++;
      }
      const changedRatio = changed / (fixture.size * fixture.size);
      reports.push({ id:fixture.id, changedRatio, maximumChannelError });
      if (changedRatio > .005 || maximumChannelError > 8) throw new Error(`${fixture.id} 差异超标：比例 ${changedRatio}，最大通道差 ${maximumChannelError}。`);
    }
    return { goldenPassed: true, reportHash: objectHash({ manifestHash: objectHash(manifest), reports }), reasons: [],scope:manifest.scope??'仅登记的三个夹具与渲染配置。',cases:reports };
  } catch (error) { return { goldenPassed:false, reportHash:objectHash(manifest), reasons:[String(error)] }; }
}
