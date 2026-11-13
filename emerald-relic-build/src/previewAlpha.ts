import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TextureAtlas} from '@esotericsoftware/spine-core';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {resolveWorkspacePath,type ToolContext} from './spineJson.js';

const cache=new Map<string,Buffer>();
export function convertAlphaPixels(pixels:Uint8ClampedArray,sourcePma:boolean,targetPma:boolean) {
  const out=new Uint8ClampedArray(pixels);
  if(sourcePma===targetPma)return out;
  for(let i=0;i<out.length;i+=4){const alpha=out[i+3];for(let c=0;c<3;c++)out[i+c]=alpha===0?0:targetPma?Math.round(out[i+c]*alpha/255):Math.min(255,Math.round(out[i+c]*255/alpha));}
  return out;
}
export async function getPreviewAlphaAssets(args:{atlasPath:string;targetPma:boolean},context:ToolContext={}) {
  const text=await readFile(resolveWorkspacePath(args.atlasPath,context),'utf8');
  const atlas=new TextureAtlas(text);
  const images:Record<string,string>={},pages:any[]=[];
  for(const page of atlas.pages){
    const filePath=path.posix.join(path.posix.dirname(args.atlasPath.replaceAll('\\','/')),page.name);
    const raw=await readFile(resolveWorkspacePath(filePath,context));
    const hash=createHash('sha256').update(raw).digest('hex');
    const key=`${hash}:${page.pma}:${args.targetPma}`;
    let png=cache.get(key);
    if(!png){
      if(page.pma===args.targetPma)png=raw;
      else{
        const image=await loadImage(raw),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');
        ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,image.width,image.height);
        pixels.data.set(convertAlphaPixels(pixels.data,page.pma,args.targetPma));ctx.putImageData(pixels,0,0);
        png=canvas.toBuffer('image/png');
      }
      if(cache.size>=16)cache.delete(cache.keys().next().value!);cache.set(key,png);
    }
    // 同模式返回原格式；不同模式统一为 PNG，均只驻留预览缓存。
    const mime=page.pma!==args.targetPma?'image/png':path.extname(filePath).toLowerCase()==='.jpg'||path.extname(filePath).toLowerCase()==='.jpeg'?'image/jpeg':path.extname(filePath).toLowerCase()==='.webp'?'image/webp':'image/png';
    images[page.name]=`data:${mime};base64,${png.toString('base64')}`;
    pages.push({name:page.name,sourcePma:page.pma,targetPma:args.targetPma,converted:page.pma!==args.targetPma,sourceHash:hash});
  }
  return {ok:true,images,pages,atlasText:text,atlasHash:createHash('sha256').update(text).digest('hex')};
}
