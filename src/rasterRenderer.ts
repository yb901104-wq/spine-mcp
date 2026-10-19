import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { RegionAttachment, MeshAttachment, ClippingAttachment, BlendMode } from '@esotericsoftware/spine-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';

export async function loadAtlasImages(atlas: any, atlasPath: string, context: ToolContext, pma?: boolean) {
  const images = new Map<string, Image>();
  for (const page of atlas.pages) {
    let image = await loadImage(await readFile(resolveWorkspacePath(path.join(path.dirname(atlasPath), page.name), context)));
    if (pma ?? page.pma) { const c = createCanvas(image.width, image.height), x = c.getContext('2d'); x.drawImage(image, 0, 0); const d = x.getImageData(0,0,c.width,c.height); for(let i=0;i<d.data.length;i+=4) if(d.data[i+3]) for(let k=0;k<3;k++) d.data[i+k]=Math.min(255,d.data[i+k]*255/d.data[i+3]); x.putImageData(d,0,0); image = await loadImage(c.toBuffer('image/png')); }
    images.set(page.name, image);
  }
  return images;
}

export function rasterFrame(skeleton: any, images: Map<string, Image>, bounds: any, width: number, height: number, background: string) {
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

