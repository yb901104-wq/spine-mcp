import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {convertAlphaPixels,getPreviewAlphaAssets} from '../src/previewAlpha.js';
test('PMA conversion clears hidden transparent RGB, premultiplies partial alpha, and avoids double conversion',()=>{
 const source=new Uint8ClampedArray([255,0,255,0,200,100,50,128,100,50,25,255]);
 const pma=convertAlphaPixels(source,false,true);
 assert.deepEqual([...pma],[0,0,0,0,100,50,25,128,100,50,25,255]);assert.equal(source[0],255);
 assert.deepEqual(convertAlphaPixels(pma,true,true),pma);
 const straight=convertAlphaPixels(pma,true,false);assert.ok(Math.abs(straight[4]-200)<=1);
});
test('atlas PMA flags govern preview texture conversion, cache is stable and original files are untouched',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-alpha-')),context={workspaceRoot:root};
 try{
  const c=createCanvas(2,2),ctx=c.getContext('2d');ctx.fillStyle='rgba(200,100,50,0.5)';ctx.fillRect(0,0,2,2);const png=c.toBuffer('image/png');
  await writeFile(path.join(root,'a.png'),png);const atlas='a.png\nsize:2,2\nfilter:Linear,Linear\npma:false\n';await writeFile(path.join(root,'a.atlas'),atlas);
  const converted=await getPreviewAlphaAssets({atlasPath:'a.atlas',targetPma:true},context);assert.equal(converted.pages[0].converted,true);
  assert.deepEqual(await getPreviewAlphaAssets({atlasPath:'a.atlas',targetPma:true},context),converted);
  const image=await loadImage(Buffer.from(converted.images['a.png'].split(',')[1],'base64'));ctx.clearRect(0,0,2,2);ctx.drawImage(image,0,0);const px=ctx.getImageData(0,0,2,2).data;assert.ok(px[0]<=px[3]+1);
  assert.deepEqual(await readFile(path.join(root,'a.png')),png);assert.equal(await readFile(path.join(root,'a.atlas'),'utf8'),atlas);
  const raw=await getPreviewAlphaAssets({atlasPath:'a.atlas',targetPma:false},context);assert.equal(raw.pages[0].converted,false);assert.deepEqual(Buffer.from(raw.images['a.png'].split(',')[1],'base64'),png);
  await writeFile(path.join(root,'a.atlas'),atlas.replace('pma:false','pma:true'));const already=await getPreviewAlphaAssets({atlasPath:'a.atlas',targetPma:true},context);assert.equal(already.pages[0].converted,false);
  await assert.rejects(()=>getPreviewAlphaAssets({atlasPath:'../escape.atlas',targetPma:true},context),/workspace/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('NPC1 straight-alpha texture is converted only for preview',async t=>{
 const root=path.resolve(process.cwd(),'../spine test');try{await access(path.join(root,'目标/npc1.png'));}catch{t.skip('缺少 NPC1 样本');return;}
 const png=await readFile(path.join(root,'目标/npc1.png')),atlas=await readFile(path.join(root,'目标/npc1.atlas'));
 const result=await getPreviewAlphaAssets({atlasPath:'目标/npc1.atlas',targetPma:true},{workspaceRoot:root});assert.equal(result.pages[0].sourcePma,false);assert.equal(result.pages[0].converted,true);
 assert.deepEqual(await readFile(path.join(root,'目标/npc1.png')),png);assert.deepEqual(await readFile(path.join(root,'目标/npc1.atlas')),atlas);
});
