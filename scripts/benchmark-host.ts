// 隔离合成负载：计时不代表真实角色视觉验收，不满足 D 的长期稳定运行前置。
import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
import { RASTER_RENDERER_VERSION } from '../src/rasterRenderer.js';
import { objectHash } from '../src/hostContracts.js';
const count=30,samples:any[]=[];
await withHostFixture(async({context})=>{
  const host=await startHostServer(context,{persist:false,writeEnabled:true}),headers={'X-Spine-Host-Token':host.token,'X-Spine-Host-Control':host.control,'Content-Type':'application/json',Origin:host.endpoint};
  const request=async(route:string,args?:any)=>{const r=await fetch(host.endpoint+route,{headers,...args?{method:'POST',body:JSON.stringify(args)}:{}});if(!r.ok)throw Error(await r.text());return r.headers.get('content-type')?.startsWith('image/png')?r.arrayBuffer():r.json();};
  try{
    await request('/api/open',{path:'a.pose.json'});await request('/api/pin',{expectedRevision:host.store.active!.version});
    const cold=performance.now(),initial=await request('/api/snapshot',{expectedRevision:host.store.active!.version});
    const initialResult=await evaluateHostSnapshot(initial,context);await request('/api/derived',{expectedRevision:initial.version,snapshotHash:initial.snapshotHash,dependencyFingerprint:initial.dependencyFingerprint,result:initialResult});
    await request('/api/frame?'+new URLSearchParams({...initial.version,revision:String(initial.version.revision),size:'480'}));
    const coldLoadEvaluateFrameMs=performance.now()-cold;
    for(let i=-2;i<count;i++){
      const started=performance.now(),edited:any=await request('/api/patch',{expectedRevision:host.store.active!.version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',x:.01+(i+2)*.0001}],dryRun:false});
      const afterPatch=performance.now(),snapshot:any=await request('/api/snapshot',{expectedRevision:edited.version});
      const afterSnapshot=performance.now();const result=await evaluateHostSnapshot(snapshot,context);const afterEvaluate=performance.now();
      await request('/api/derived',{expectedRevision:edited.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result});const afterPublish=performance.now();
      await request('/api/frame?'+new URLSearchParams({...edited.version,revision:String(edited.version.revision),size:'480'}));const afterFrame=performance.now();
      const stateStarted=performance.now();await request('/api/state');const stateMs=performance.now()-stateStarted;
      if(i>=0)samples.push({patchMs:afterPatch-started,snapshotMs:afterSnapshot-afterPatch,evaluateCompareExportMs:afterEvaluate-afterSnapshot,publishMs:afterPublish-afterEvaluate,frameMs:afterFrame-afterPublish,endToEndMs:afterFrame-started,stateMs});
    }
    const percentile=(key:string,p:number)=>samples.map(s=>s[key]).sort((a,b)=>a-b)[Math.ceil(samples.length*p)-1];
    const snapshot=await host.store.snapshot(host.store.active!.version);let dependencyBytes=0;
    for(const dep of snapshot.dependencies)dependencyBytes+=(await readFile(host.store.resolve(dep.filePath))).length;
    const doc=host.store.active!,workloadFingerprint=objectHash({skeleton:doc.skeletonJson,atlas:doc.atlasRaw,bones:doc.mapping.bones,origin:doc.mapping.calibration.origin,scale:doc.mapping.calibration.scale,camera:doc.camera,size:480});
    const report={date:new Date().toISOString(),renderer:RASTER_RENDERER_VERSION,workloadFingerprint,camera:doc.camera,fixture:'合成关节与两个 region，非真实美术验收',node:process.version,platform:os.platform(),release:os.release(),cpu:os.cpus()[0]?.model,logicalCores:os.cpus().length,sampleCount:samples.length,warmups:2,size:480,coldLoadEvaluateFrameMs,dependencyFiles:snapshot.dependencies.length,dependencyBytes,
      phases:Object.fromEntries(Object.keys(samples[0]).map(key=>[key,{p50:percentile(key,.5),p95:percentile(key,.95)}])),samples,
      decision:'保持 MCP 求解。尚无 C 稳定四周、真实每日调用量与真实角色工作负载证据；本次隔离数据不满足 D 搬迁前置。'};
    const output=process.argv[2];if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,samples:undefined},null,2));
  }finally{await host.stop();}
});
