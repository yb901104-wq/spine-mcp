// 通过可见官方 player 页面采集三张基线；不得由模拟 capture 回传代替。
import { readFile,writeFile,mkdir,stat } from 'node:fs/promises';
import path from 'node:path';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
import { strictHash } from '../src/hostContracts.js';
import { validateHostGolden } from '../src/goldenValidation.js';
const root=process.cwd(),folder='test/golden/host',manifestPath=path.join(root,folder,'manifest.json');
try{await stat(manifestPath);throw Error('基线已存在，请先人工核对并保留旧基线；此脚本不覆盖。');}catch(error:any){if(error.code!=='ENOENT')throw error;}
await withHostFixture(async({context,root:temporary,manifest})=>{
  const base=JSON.parse(await readFile(path.join(temporary,'a.pose.json'),'utf8'));
  const inputs=[{id:'region-setup',pose:base},{id:'region-presentation',pose:{...base,frame:{...base.frame,presentation:{attachments:{bodySlot:'alternate',accentSlot:null},drawOrder:['accentSlot','bodySlot']}}}},{id:'region-rotated-overlap',pose:{...base,frame:{...base.frame,body:{...base.frame.body,rotate:27},presentation:{attachments:{accentSlot:'body'},drawOrder:['accentSlot','bodySlot']}}}}];
  for(const input of inputs){await writeFile(path.join(temporary,input.id+'.pose.json'),JSON.stringify(input.pose));manifest.documents.push({path:input.id+'.pose.json',kind:'pose',characterId:'hero'});}
  await writeFile(path.join(temporary,'.spine-workflow.json'),JSON.stringify(manifest));
  const host=await startHostServer(context,{captureTimeoutMs:10000}),cases:any[]=[];
  try{
    console.log(JSON.stringify({endpoint:host.endpoint,instruction:'请在可见浏览器中打开此临时 Host；三次采集自动进行，只用于合成渲染回归。'}));
    for(let wait=0;;wait++){
      const response=await fetch(host.endpoint+'/api/state',{headers:{'X-Spine-Host-Token':host.token}}),state:any=await response.json();
      if(state.preview.visibilityState==='visible')break;if(wait>1800)throw Error('等待可见页面超时。');await new Promise(resolve=>setTimeout(resolve,100));
    }
    await new Promise(resolve=>setTimeout(resolve,500));
    for(const input of inputs){
      await host.store.open({path:input.id+'.pose.json',...host.store.active?{expectedRevision:host.store.active.version}:{}});
      const snapshot=await host.store.snapshot(host.store.active!.version),result=await evaluateHostSnapshot(snapshot,context);
      await host.store.publishDerived({expectedRevision:snapshot.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result});
      const capture=await host.capture.request({expectedRevision:snapshot.version,size:320}),relative=`${folder}/${input.id}`;
      await mkdir(path.join(root,relative),{recursive:true});
      const files:Record<string,string>={};
      const save=async(name:string,bytes:Buffer|string)=>{const file=relative+'/'+name;await writeFile(path.join(root,file),bytes);files[file]=strictHash(bytes);return file;};
      const skeletonPath=await save('pose.json',await readFile(host.store.resolve(result.live.path))),atlasPath=await save('body.atlas',await readFile(path.join(temporary,'body.atlas')));
      await save('body.png',await readFile(path.join(temporary,'body.png')));
      const snapshotPath=await save('snapshot.json',JSON.stringify({bones:result.bones,skin:host.store.active!.mapping.skin??null,slotAttachments:host.store.active!.mapping.bones.slotAttachments,presentation:result.frame.presentation},null,2)+'\n');
      const pngPath=await save('player.png',Buffer.from(capture.pngBase64,'base64')),captureManifestPath=await save('capture.json',JSON.stringify(capture.manifest,null,2)+'\n');
      cases.push({id:input.id,source:'player',files,skeletonPath,atlasPath,snapshotPath,pngPath,captureManifestPath,skin:host.store.active!.mapping.skin??null,presentation:input.pose.frame.presentation??null,size:320,viewport:{width:320,height:320},dpr:1,camera:capture.manifest.camera,pma:capture.manifest.pma});
      console.log(JSON.stringify({captured:input.id,captureValidity:capture.manifest.captureValidity.status}));
    }
    const runtime={player:'4.1.56',core:'4.1.56',replaySchema:1,rendererHash:strictHash(await readFile(path.join(root,'dist/rasterRenderer.js'))),replayHash:strictHash(await readFile(path.join(root,'dist/renderSnapshot.js')))};
    await writeFile(manifestPath,JSON.stringify({version:1,scope:'三个合成不透明 region 场景；不代表 mesh/透明/tint/特殊混合或真实美术验收。',runtime,cases},null,2)+'\n');
    const verdict=await validateHostGolden();await writeFile(path.join(root,'docs/plans/host-golden-20261022.json'),JSON.stringify({capturedAt:new Date().toISOString(),cases:cases.map(c=>c.id),...verdict},null,2)+'\n');
    console.log(JSON.stringify(verdict));if(verdict.goldenPassed!==true)process.exitCode=1;
  }finally{await host.stop();}
});
