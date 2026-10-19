import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import gifenc from 'gifenc';
import {renderAnimationFrames} from '../dist/previewRenderTools.js';
const {GIFEncoder,quantize,applyPalette}=gifenc;
const root='D:/AI_cc/spine test/previews/验收优化-20261009',context={workspaceRoot:root};
async function compare(name,leftFile,leftAnimation,rightFile,rightAnimation,labels){
 const base={atlasPath:'npc1.atlas',frames:42,width:320,height:320};
 const l={...base,filePath:leftFile,animation:leftAnimation},r={...base,filePath:rightFile,animation:rightAnimation};
 let a=await renderAnimationFrames(l,context),b=await renderAnimationFrames(r,context);
 const bounds={minX:Math.min(a.bounds.minX,b.bounds.minX),minY:Math.min(a.bounds.minY,b.bounds.minY),maxX:Math.max(a.bounds.maxX,b.bounds.maxX),maxY:Math.max(a.bounds.maxY,b.bounds.maxY)};
 a=await renderAnimationFrames({...l,bounds},context);b=await renderAnimationFrames({...r,bounds},context);
 const gif=GIFEncoder();
 for(let i=0;i<42;i++){
  const canvas=createCanvas(640,360),ctx=canvas.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,640,360);
  for(const [render,x,label] of [[a,0,labels[0]],[b,320,labels[1]]]){ctx.drawImage(await loadImage(await readFile(path.join(root,render.frames[i]))),x,36,320,320);ctx.fillStyle='#fff';ctx.font='16px sans-serif';ctx.fillText(label,x+10,24);}
  const rgba=ctx.getImageData(0,0,640,360).data,palette=quantize(rgba,256),delay=Math.max(10,(Math.round((i+1)*a.duration*100/42)-Math.round(i*a.duration*100/42))*10);
  gif.writeFrame(applyPalette(rgba,palette),640,360,{palette,delay,repeat:0});if(i===0)await writeFile(path.join(root,name+'-first.png'),canvas.toBuffer('image/png'));
 }
 gif.finish();await writeFile(path.join(root,name+'.gif'),gif.bytes());await writeFile(path.join(root,name+'.manifest.json'),JSON.stringify({left:a.manifestPath,right:b.manifestPath,bounds,labels,frames:42,duration:a.duration},null,2));console.log(name+'.gif');
}
await compare('idle-before-vs-optimized','idle-before.json','idle-reference','npc1-idle-optimized.json','idle-reference',['Before: 1105 keys','Optimized: 2084 keys']);
const j=JSON.parse(await readFile(path.join(root,'npc1-walk.json'),'utf8'));
if(j.animations['walk-adjust_arm_swing'])await compare('walk-arm-adjustment','npc1-walk.json','walk-mcp-baseline','npc1-walk.json','walk-adjust_arm_swing',['MCP baseline','Arm swing x1.03']);
