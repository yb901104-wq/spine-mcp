import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { TextureAtlas } from '@esotericsoftware/spine-core';
import { loadImage } from '@napi-rs/canvas';
import { HostEditorStore } from './hostEditorStore.js';
import { assertVersion, HostError, objectHash, strictHash } from './hostContracts.js';
import { validateHostGolden } from './goldenValidation.js';
import { createMotionRuntime } from './motionRuntime.js';
import { assertCaptureReadback, captureRuntimeState, CAPTURE_EVIDENCE_SCHEMA } from './captureEvidence.js';
import { fileURLToPath } from 'node:url';
const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class HostCapture {
  private pending = new Map<string, { task: any; proof?: any; resolve: (result: any) => void; reject: (error: any) => void }>();
  onRequest?: (task: any) => void;
  constructor(private store: HostEditorStore, private timeoutMs = 1200) {}
  async bundle(id: string) {
    const pending = this.pending.get(id);
    if (!pending) throw new HostError('CAPTURE_TIMEOUT', '截图请求已过期。', 409);
    const doc = this.store.active!; assertVersion(pending.task.version, doc.version); await this.store.assertFresh(doc);
    if (pending.task.derivedHash !== doc.derivedHash) throw new HostError('SOLUTION_STALE', '截图候选已替换。', 409);
    const live = doc.derived?.live;
    if (!live || strictHash(await readFile(this.store.resolve(live.path))) !== live.hash) throw new HostError('NO_SOLUTION', '缺少当前不可变 player 候选。', 409);
    const data: Record<string,string> = {
      'pose.json': 'data:application/json;base64,'+(await readFile(this.store.resolve(live.path))).toString('base64'),
      'atlas.atlas': 'data:text/plain;base64,'+Buffer.from(doc.atlasRaw).toString('base64'),
    };
    const atlas = new TextureAtlas(doc.atlasRaw);
    for (const page of atlas.pages) {
      const raw = await readFile(this.store.resolve(path.join(path.dirname(doc.atlasPath),page.name)));
      data[page.name] = `data:image/${/\.jpe?g$/i.test(page.name)?'jpeg':'png'};base64,${raw.toString('base64')}`;
    }
    const resourceHashes = Object.fromEntries(Object.entries(data).map(([name, uri]) => [name, strictHash(Buffer.from(uri.split(',')[1], 'base64'))]));
    const playerScriptHash = strictHash(await readFile(path.join(installRoot, 'node_modules/@esotericsoftware/spine-player/dist/iife/spine-player.min.js')));
    for (const name of ['spine-player','spine-core']) {
      if (JSON.parse(await readFile(path.join(installRoot, `node_modules/@esotericsoftware/${name}/package.json`), 'utf8')).version !== '4.1.56') throw new HostError('CAPTURE_UNVERIFIED', '官方 runtime 安装版本不匹配。', 409);
    }
    const rt = createMotionRuntime(JSON.parse(Buffer.from(data['pose.json'].split(',')[1], 'base64').toString('utf8')), doc.atlasRaw);
    const skin = doc.mapping.skin ?? rt.data.skins[0]?.name;
    pending.proof = { resourceHashes, playerScriptHash, runtime: captureRuntimeState(rt.sample(live.animation, pending.task.time, skin)), pma: atlas.pages.every(p=>p.pma) };
    return { ...pending.task, rawDataURIs:data, skin:doc.mapping.skin??null, animation:live.animation,
      pma:atlas.pages.every(p=>p.pma), expectedRenderState:doc.derived.renderState };
  }
  async request(args: any) {
    const doc = this.store.active;
    if (!doc) throw new HostError('DOC_NOT_LOADED','先打开 pose 文档。',409);
    assertVersion(args.expectedRevision,doc.version); await this.store.assertFresh(doc);
    if(doc.kind!=='pose')throw new HostError('UNSUPPORTED_DOC_KIND','首批 player capture 只支持 pose。');
    if(!doc.derived?.live)throw new HostError('NO_SOLUTION','先显式重算并发布当前 player 候选。',409);
    if(args.time!==undefined&&args.time!==doc.value.frame.time)throw new HostError('INVALID_ARGUMENT','单姿态截图只接受其记录的时间。');
    const size=args.size??960;
    if(![320,480,960].includes(size))throw new HostError('INVALID_ARGUMENT','capture 大小仅支持 320/480/960。');
    const viewport={width:size,height:size};
    const requestedViewport=args.viewport??viewport;
    const task={id:randomUUID(),version:structuredClone(doc.version),derivedHash:doc.derivedHash,size,viewport,dpr:1,camera:doc.camera,time:doc.derived.live.time??0};
    let timer:ReturnType<typeof setTimeout>;
    const result=await new Promise<any>((resolve,reject)=>{
      timer=setTimeout(()=>{this.pending.delete(task.id);reject(new HostError('CAPTURE_TIMEOUT','没有可见的 player 页面在时限内完成摆帧。',408));},this.timeoutMs);
      this.pending.set(task.id,{task,resolve,reject});this.onRequest?.(task);
    }).finally(()=>clearTimeout(timer!));
    assertVersion(task.version,this.store.active!.version);await this.store.assertFresh(doc);
    if(task.derivedHash!==doc.derivedHash)throw new HostError('SOLUTION_STALE','截图期间派生结果已变化。',409);
    const viewportMatches=objectHash(requestedViewport)===objectHash(viewport)&&objectHash(result.viewport)===objectHash(viewport)&&result.dpr===1;
    const golden=await validateHostGolden();
    const png=Buffer.from(result.pngBase64,'base64'),image=await loadImage(png);
    if(image.width!==size||image.height!==size)throw new HostError('CAPTURE_UNVERIFIED','实际 canvas 尺寸不匹配。',409);
    const source=this.store.project;
    const root=source?.mode==='managed'?source.manifest.artifactRoots.previews:'.spine-mcp/captures';
    const pngHash=strictHash(png),filePath=`${root}/captures/${task.version.documentId}/${task.version.openEpoch}/${task.id}/${pngHash}.png`;
    const captureValidity={status:viewportMatches?'verified':'invalid',checks:{version:true,dependencies:true,candidate:true,runtimeReadback:true,resourceHashes:true,playerScript:true,fixedCamera:true,visible:true,canvas:true,viewport:viewportMatches},reasons:viewportMatches?[]:['请求或实际 viewport/DPR 与记录不符。']};
    const rendererParity={status:golden.goldenPassed===true?'passed':golden.goldenPassed===false?'failed':'unverified',reportHash:golden.reportHash,reasons:golden.reasons,scope:golden.scope??null};
    const manifest={evidenceSchema:CAPTURE_EVIDENCE_SCHEMA,captureId:task.id,capturedAt:new Date().toISOString(),version:task.version,snapshotHash:doc.snapshotHash,source:'player',generated:true,contentHash:doc.contentHash,dependencyFingerprint:doc.dependencyFingerprint,derivedHash:doc.derivedHash,fileHash:doc.fileHash,
      exported:true,candidateHash:doc.derived.live.hash,camera:doc.camera,viewport,canvas:{width:size,height:size},dpr:1,
      skin:doc.mapping.skin??null,attachments:result.actual.attachments,drawOrder:result.actual.drawOrder,pma:result.pma,
      runtime:{player:'4.1.56',core:'4.1.56',replaySchema:1},goldenPassed:golden.goldenPassed,goldenReportHash:golden.reportHash,
      rendererParity,captureValidity,evidenceEligible:captureValidity.status==='verified',
      resourceHashes:result.resourceHashes,playerScriptHash:result.playerScriptHash,actual:result.actual,actualCamera:result.actualCamera,
      viewportMatches,advisory:captureValidity.status!=='verified',evidence:[{filePath,hash:pngHash}],goldenReasons:golden.reasons};
    for(const [file,bytes]of [[filePath,png],[filePath+'.manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')]]as const){
      const absolute=this.store.resolve(file);await mkdir(path.dirname(absolute),{recursive:true});
      try{const handle=await open(absolute,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
      catch(error:any){if(error.code!=='EEXIST'||strictHash(await readFile(absolute))!==strictHash(bytes))throw error;}
    }
    assertVersion(task.version,this.store.active!.version);await this.store.assertFresh(doc);
    if(task.derivedHash!==doc.derivedHash)throw new HostError('SOLUTION_STALE','登记截图前派生结果已变化。',409);
    await this.store.registerCapture(filePath+'.manifest.json',manifest);
    return {ok:true,pngBase64:png.toString('base64'),filePath,manifestPath:filePath+'.manifest.json',manifest};
  }
  async complete(args:any){
    const pending=this.pending.get(args.captureId);
    if(!pending)throw new HostError('CAPTURE_TIMEOUT','截图回传已过期。',409);
    this.pending.delete(args.captureId);
    try{
      const doc=this.store.active!;assertVersion(pending.task.version,doc.version);await this.store.assertFresh(doc);
      if(pending.task.derivedHash!==doc.derivedHash)throw new HostError('SOLUTION_STALE','截图结果过期。',409);
      if(args.visibilityState!=='visible'||args.error)throw new HostError('CAPTURE_TIMEOUT',args.error??'后台标签不接受截图。',408);
      if(typeof args.pngBase64!=='string'||!args.pngBase64.startsWith('iVBORw0KGgo')||!pending.proof)throw new HostError('CAPTURE_UNVERIFIED','缺少实际 PNG 或当前资源加载证明。',409);
      assertCaptureReadback(args.actual,pending.proof.runtime);
      assertCaptureReadback(args.resourceHashes,pending.proof.resourceHashes,'resources');
      assertCaptureReadback(args.playerScriptHash,pending.proof.playerScriptHash,'playerScript');
      assertCaptureReadback(args.pma,pending.proof.pma,'pma');
      const c=pending.task.camera,w=c.maxX-c.minX,h=c.maxY-c.minY;
      assertCaptureReadback(args.actualCamera,{x:(c.minX+c.maxX)/2,y:(c.minY+c.maxY)/2,zoom:Math.max(w,h)/pending.task.size,viewportWidth:pending.task.size,viewportHeight:pending.task.size},'camera');
      pending.resolve(args);return{ok:true};
    }catch(error){pending.reject(error);throw error;}
  }
  close(){for(const pending of this.pending.values())pending.reject(new HostError('HOST_UNAVAILABLE','Host 正在关闭。',409));this.pending.clear();}
}
