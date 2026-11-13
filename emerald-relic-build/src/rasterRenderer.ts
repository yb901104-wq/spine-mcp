import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { RegionAttachment, MeshAttachment, ClippingAttachment, BlendMode } from '@esotericsoftware/spine-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { cacheHash,cachedAtlasImage } from './runtimeCache.js';
export const RASTER_RENDERER_VERSION = 'canvas-region-msaa4-v4';
const opaquePixels = new WeakMap<Image, { pixels: Uint8ClampedArray; opaque: boolean }>();
let sampleScratch={colors:new Uint8Array(0),touched:new Uint8Array(0),dirty:[] as number[]};
/** 有界的 region 路径：只处理全不透明、无 tint、普通混合且无 clipping/mesh 的场景。
 * 保留四份样本直到全部附件合成完成，避免附件重叠边缘先 resolve 再混合。
 * 坐标是 Canvas 顶部原点；样本位置已从 WebGL 底部原点转换。
 */
function rasterOpaqueRegions(skeleton:any, images:Map<string,Image>, bounds:any, width:number, height:number, background:string) {
  if(width>960||height>960)return null;
  const unit=(c:any)=>['r','g','b','a'].every(key=>Math.abs(c[key]-1)<1e-8);
  if(!unit(skeleton.color))return null;
  const entries:any[]=[];
  for(const slot of skeleton.drawOrder){
    if(!slot.bone.active)continue;const attachment=slot.getAttachment();if(!attachment)continue;
    if(!(attachment instanceof RegionAttachment)||slot.darkColor||slot.data.blendMode!==BlendMode.Normal||!unit(slot.color)||!unit(attachment.color))return null;
    const image=images.get((attachment.region as any)?.page?.name);if(!image)return null;
    let texture=opaquePixels.get(image);
    if(!texture){const c=createCanvas(image.width,image.height),ctx=c.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;let opaque=true;for(let i=3;i<pixels.length;i+=4)if(pixels[i]!==255){opaque=false;break;}texture={pixels,opaque};opaquePixels.set(image,texture);}
    if(!texture.opaque)return null;entries.push({slot,attachment,image,texture});
  }
  const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
  const output=ctx.getImageData(0,0,width,height);if(output.data[3]!==255)return null;
  if(sampleScratch.touched.length<width*height)sampleScratch={colors:new Uint8Array(width*height*12),touched:new Uint8Array(width*height),dirty:[]};
  const {colors,touched,dirty}=sampleScratch;for(const pixel of dirty)touched[pixel]=0;dirty.length=0;
  const samples=[[.375,.875],[.875,.625],[.125,.375],[.625,.125]];
  const scale=Math.min(width/(bounds.maxX-bounds.minX),height/(bounds.maxY-bounds.minY));
  const project=(x:number,y:number)=>[width/2+(x-(bounds.minX+bounds.maxX)/2)*scale,height/2-(y-(bounds.minY+bounds.maxY)/2)*scale];
  for(const {slot,attachment,image,texture}of entries){
    const vertices=new Array(8).fill(0);attachment.computeWorldVertices(slot,vertices,0,2);
    const p=Array.from({length:4},(_,i)=>project(vertices[i*2],vertices[i*2+1])),uv=attachment.uvs,u=Array.from({length:4},(_,i)=>[uv[i*2]*image.width,uv[i*2+1]*image.height]);
    const du=[u[1][0]-u[0][0],u[1][1]-u[0][1]],dv=[u[2][0]-u[0][0],u[2][1]-u[0][1]],det=du[0]*dv[1]-dv[0]*du[1];if(Math.abs(det)<1e-10)continue;
    const ax=((p[1][0]-p[0][0])*dv[1]-(p[2][0]-p[0][0])*du[1])/det,bx=((p[2][0]-p[0][0])*du[0]-(p[1][0]-p[0][0])*dv[0])/det;
    const ay=((p[1][1]-p[0][1])*dv[1]-(p[2][1]-p[0][1])*du[1])/det,by=((p[2][1]-p[0][1])*du[0]-(p[1][1]-p[0][1])*dv[0])/det,d=ax*by-bx*ay;if(Math.abs(d)<1e-10)continue;
    const ia=by/d,ib=-bx/d,ic=-ay/d,id=ax/d;
    const offsetU=samples.map(([x,y])=>ia*(x-.5)+ib*(y-.5)),offsetV=samples.map(([x,y])=>ic*(x-.5)+id*(y-.5));
    const minU=Math.min(...u.map(v=>v[0])),maxU=Math.max(...u.map(v=>v[0])),minV=Math.min(...u.map(v=>v[1])),maxV=Math.max(...u.map(v=>v[1]));
    for(let y=Math.max(0,Math.floor(Math.min(...p.map(v=>v[1]))));y<Math.min(height,Math.ceil(Math.max(...p.map(v=>v[1]))));y++)for(let x=Math.max(0,Math.floor(Math.min(...p.map(v=>v[0]))));x<Math.min(width,Math.ceil(Math.max(...p.map(v=>v[0]))));x++){
      const dx=x+.5-p[0][0],dy=y+.5-p[0][1],tx=u[0][0]+ia*dx+ib*dy,ty=u[0][1]+ic*dx+id*dy;let mask=0;
      for(let sample=0;sample<4;sample++){const su=tx+offsetU[sample],sv=ty+offsetV[sample];if(su>=minU&&su<maxU&&sv>=minV&&sv<maxV)mask|=1<<sample;}if(!mask)continue;
      const pixel=y*width+x;
      if(!touched[pixel]){touched[pixel]=1;dirty.push(pixel);for(let sample=0;sample<4;sample++)for(let c=0;c<3;c++)colors[pixel*12+sample*3+c]=output.data[pixel*4+c];}
      const fx=Math.max(0,Math.min(image.width-1,tx-.5)),fy=Math.max(0,Math.min(image.height-1,ty-.5)),ix=Math.floor(fx),iy=Math.floor(fy),wx=fx-ix,wy=fy-iy;
      const row0=iy*image.width,row1=Math.min(image.height-1,iy+1)*image.width,nextX=Math.min(image.width-1,ix+1),c00=(row0+ix)*4,c10=(row0+nextX)*4,c01=(row1+ix)*4,c11=(row1+nextX)*4,pixels=texture.pixels;
      for(let c=0;c<3;c++){
        const color=Math.round((pixels[c00+c]*(1-wx)+pixels[c10+c]*wx)*(1-wy)+(pixels[c01+c]*(1-wx)+pixels[c11+c]*wx)*wy);
        for(let sample=0;sample<4;sample++)if(mask&(1<<sample))colors[pixel*12+sample*3+c]=color;
      }
    }
  }
  for(const i of dirty)for(let c=0;c<3;c++)output.data[i*4+c]=Math.round((colors[i*12+c]+colors[i*12+3+c]+colors[i*12+6+c]+colors[i*12+9+c])/4);
  ctx.putImageData(output,0,0);return canvas;
}

export async function loadAtlasImages(atlas: any, atlasPath: string, context: ToolContext, pma?: boolean) {
  const images = new Map<string, Image>();
  for (const page of atlas.pages) {
    const raw=await readFile(resolveWorkspacePath(path.join(path.dirname(atlasPath),page.name),context));
    const image=await cachedAtlasImage(cacheHash(raw)+':'+String(pma??page.pma),async()=>{
    let image = await loadImage(raw);
    if (pma ?? page.pma) { const c = createCanvas(image.width, image.height), x = c.getContext('2d'); x.drawImage(image, 0, 0); const d = x.getImageData(0,0,c.width,c.height); for(let i=0;i<d.data.length;i+=4) if(d.data[i+3]) for(let k=0;k<3;k++) d.data[i+k]=Math.min(255,d.data[i+k]*255/d.data[i+3]); x.putImageData(d,0,0); image = await loadImage(c.toBuffer('image/png')); }
    return image;},raw.length*4);
    images.set(page.name, image);
  }
  return images;
}

export function rasterFrame(skeleton: any, images: Map<string, Image>, bounds: any, width: number, height: number, background: string) {
  const msaa=rasterOpaqueRegions(skeleton,images,bounds,width,height,background);if(msaa)return msaa;
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
  const scale = Math.min(width / (bounds.maxX - bounds.minX), height / (bounds.maxY - bounds.minY));
  const project = (x: number, y: number) => [width / 2 + (x - (bounds.minX + bounds.maxX) / 2) * scale, height / 2 - (y - (bounds.minY + bounds.maxY) / 2) * scale];
  let clippingEnd: any;
  for (const slot of skeleton.drawOrder) {
    if (!slot.bone.active) continue;
    if (slot.darkColor) throw new Error('离线渲染暂不支持双色 tint，请使用官方浏览器预览。');
    const a = slot.getAttachment();
    if (a instanceof ClippingAttachment) {
      if (clippingEnd) throw new Error('暂不支持嵌套 clipping，不能生成可信预览。');
      const v = new Array(a.worldVerticesLength).fill(0); a.computeWorldVertices(slot, 0, v.length, v, 0, 2);
      ctx.save(); ctx.beginPath(); for (let i = 0; i < v.length; i += 2) { const p = project(v[i], v[i + 1]); if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); } ctx.closePath(); ctx.clip(); clippingEnd = a.endSlot;
      continue;
    }
    if (a instanceof RegionAttachment || a instanceof MeshAttachment) {
      const region = a.region as any, image = images.get(region?.page?.name);
      if (!image) throw new Error(`找不到附件贴图：${a.name}`);
      const v = new Array(a instanceof RegionAttachment ? 8 : a.worldVerticesLength).fill(0);
      if (a instanceof RegionAttachment) a.computeWorldVertices(slot, v, 0, 2); else a.computeWorldVertices(slot, 0, v.length, v, 0, 2);
      const triangles = a instanceof MeshAttachment ? a.triangles : [0, 1, 2, 2, 3, 0], uv = a.uvs;
      ctx.globalAlpha = skeleton.color.a * slot.color.a * a.color.a;
      ctx.globalCompositeOperation = slot.data.blendMode === BlendMode.Additive ? 'lighter' : slot.data.blendMode === BlendMode.Multiply ? 'multiply' : slot.data.blendMode === BlendMode.Screen ? 'screen' : 'source-over';
      // 一次附件离屏合成，避免共享三角形边缘重复混合。
      const layer = createCanvas(width, height), lc = layer.getContext('2d');
      for (let t = 0; t < triangles.length; t += 3) {
        const ids = triangles.slice(t, t + 3), p = ids.map((i: number) => project(v[i * 2], v[i * 2 + 1])), u = ids.map((i: number) => [uv[i * 2] * image.width, uv[i * 2 + 1] * image.height]);
        const det = (u[1][0] - u[0][0]) * (u[2][1] - u[0][1]) - (u[2][0] - u[0][0]) * (u[1][1] - u[0][1]);
        if (Math.abs(det) < 1e-10) continue;
        const ax = ((p[1][0] - p[0][0]) * (u[2][1] - u[0][1]) - (p[2][0] - p[0][0]) * (u[1][1] - u[0][1])) / det;
        const bx = ((p[2][0] - p[0][0]) * (u[1][0] - u[0][0]) - (p[1][0] - p[0][0]) * (u[2][0] - u[0][0])) / det;
        const ay = ((p[1][1] - p[0][1]) * (u[2][1] - u[0][1]) - (p[2][1] - p[0][1]) * (u[1][1] - u[0][1])) / det;
        const by = ((p[2][1] - p[0][1]) * (u[1][0] - u[0][0]) - (p[1][1] - p[0][1]) * (u[2][0] - u[0][0])) / det;
        if (a instanceof RegionAttachment) {
          // region 是同一仿射矩形，整块裁图一次绘制，避免三角接缝与边缘的重复抗锯齿。
          const sx = Math.min(...[0,2,4,6].map(i => uv[i] * image.width));
          const sy = Math.min(...[1,3,5,7].map(i => uv[i] * image.height));
          const sw = Math.max(...[0,2,4,6].map(i => uv[i] * image.width)) - sx;
          const sh = Math.max(...[1,3,5,7].map(i => uv[i] * image.height)) - sy;
          lc.save(); lc.setTransform(ax, ay, bx, by, p[0][0] - ax * u[0][0] - bx * u[0][1], p[0][1] - ay * u[0][0] - by * u[0][1]);
          lc.drawImage(image, sx, sy, sw, sh, sx, sy, sw, sh); lc.restore();
          break;
        }
        lc.save(); lc.beginPath(); lc.moveTo(p[0][0], p[0][1]); lc.lineTo(p[1][0], p[1][1]); lc.lineTo(p[2][0], p[2][1]); lc.closePath(); lc.clip();
        lc.setTransform(ax, ay, bx, by, p[0][0] - ax * u[0][0] - bx * u[0][1], p[0][1] - ay * u[0][0] - by * u[0][1]); lc.drawImage(image, 0, 0); lc.restore();
      }
      const tint = [skeleton.color.r * slot.color.r * a.color.r, skeleton.color.g * slot.color.g * a.color.g, skeleton.color.b * slot.color.b * a.color.b];
      if (tint.some(x => Math.abs(x - 1) > .001)) { const data = lc.getImageData(0, 0, width, height); for (let i = 0; i < data.data.length; i += 4) for (let c = 0; c < 3; c++) data.data[i + c] *= tint[c]; lc.putImageData(data, 0, 0); }
      ctx.drawImage(layer, 0, 0);
    }
    if (clippingEnd === slot.data) { ctx.restore(); clippingEnd = undefined; }
  }
  if (clippingEnd) ctx.restore();
  return canvas;
}

