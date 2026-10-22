import { readFile } from 'node:fs/promises';
import { HostCapture } from '../../src/hostCapture.js';
import { HostEditorStore } from '../../src/hostEditorStore.js';
import { createMotionRuntime } from '../../src/motionRuntime.js';
import { captureRuntimeState } from '../../src/captureEvidence.js';
import { strictHash } from '../../src/hostContracts.js';

/** 只模拟页面协议回传，PNG 来自 Canvas；不作为真实 player 或美术验收证据。 */
export function installSimulatedHostPage(capture:HostCapture,store:HostEditorStore) {
  capture.onRequest=task=>{void(async()=>{
    const b=await capture.bundle(task.id),raw=(name:string)=>Buffer.from(b.rawDataURIs[name].split(',')[1],'base64');
    const rt=createMotionRuntime(JSON.parse(raw('pose.json').toString()),raw('atlas.atlas').toString()),c=b.camera;
    const frame=await store.frame({expectedRevision:b.version,size:320});
    await capture.complete({captureId:b.id,visibilityState:'visible',pngBase64:frame.png.toString('base64'),viewport:b.viewport,dpr:1,pma:b.pma,
      actual:captureRuntimeState(rt.sample(b.animation,b.time,b.skin??rt.data.skins[0]?.name)),
      resourceHashes:Object.fromEntries(Object.keys(b.rawDataURIs).map(k=>[k,strictHash(raw(k))])),
      playerScriptHash:strictHash(await readFile('node_modules/@esotericsoftware/spine-player/dist/iife/spine-player.min.js')),
      actualCamera:{x:(c.minX+c.maxX)/2,y:(c.minY+c.maxY)/2,zoom:Math.max(c.maxX-c.minX,c.maxY-c.minY)/320,viewportWidth:320,viewportHeight:320}});
  })().catch(()=>{});};
}
