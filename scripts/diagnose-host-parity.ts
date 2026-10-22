// 复验既有真实 player 合成夹具截图；先核对顶点，禁止拿其它姿态进行像素比较。
import { readFile,writeFile } from 'node:fs/promises';
import { createCanvas,loadImage } from '@napi-rs/canvas';
import path from 'node:path';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { solvePoseData } from '../src/poseWorkflow.js';
import { worldVertices } from '../src/motionRuntime.js';
import { loadAtlasImages,rasterFrame } from '../src/rasterRenderer.js';
const directory=process.argv[2];if(!directory)throw Error('请提供既有 host-player-evidence-v2.json/png 所在目录。');
const manifest=JSON.parse(await readFile(path.join(directory,'host-player-evidence-v2.json'),'utf8'));
await withHostFixture(async({root,context})=>{
  const pose=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8')),solved=await solvePoseData(pose,context),actual=worldVertices(solved.skeleton),expected=manifest.actual.vertices;
  let vertexError=0;
  if(JSON.stringify(Object.keys(actual))!==JSON.stringify(Object.keys(expected)))throw Error('可见附件不一致，停止像素比较。');
  for(const key of Object.keys(actual))for(let i=0;i<actual[key].length;i++)vertexError=Math.max(vertexError,Math.abs(actual[key][i]-expected[key][i]));
  if(vertexError>1e-4)throw Error(`姿态顶点不一致：${vertexError}`);
  const images=await loadAtlasImages(solved.rt.atlas,'body.atlas',context),canvas=rasterFrame(solved.skeleton,images,manifest.camera,320,320,'#20242b');
  const player=createCanvas(320,320);player.getContext('2d').drawImage(await loadImage(path.join(directory,'host-player-evidence-v2.png')),0,0);
  const a=canvas.getContext('2d').getImageData(0,0,320,320).data,b=player.getContext('2d').getImageData(0,0,320,320).data;
  let changed=0,max=0;const worst:any[]=[];
  for(let i=0;i<a.length;i+=4){const error=Math.max(...[0,1,2,3].map(c=>Math.abs(a[i+c]-b[i+c])));if(error)changed++;max=Math.max(max,error);if(error>8)worst.push({x:i/4%320,y:Math.floor(i/1280),error,canvas:[...a.slice(i,i+4)],player:[...b.slice(i,i+4)]});}
  const report={source:'既有真实 player 证据与当前重新计算的合成夹具；仅诊断，不新签发截图准入。',vertexError,changedRatio:changed/(320*320),maximumChannelError:max,overLimitPixels:worst.length,worst:worst.sort((a,b)=>b.error-a.error)};
  // 独立复算原 4x MSAA 覆盖率试验；生产路径现已接入更严格的适用范围。
  const samples=[[.375,.875],[.875,.625],[.125,.375],[.625,.125]],buffer=new Float64Array(320*320*3);
  for(let i=0;i<buffer.length;i+=3){buffer[i]=32;buffer[i+1]=36;buffer[i+2]=43;}
  for(const slot of solved.skeleton.drawOrder){
    const attachment:any=slot.getAttachment();if(!attachment?.uvs||attachment.worldVerticesLength)throw Error('该诊断只适用当前两个 region 夹具。');
    const vertices=new Array(8).fill(0);attachment.computeWorldVertices(slot,vertices,0,2);
    const camera=manifest.camera,scale=320/(camera.maxX-camera.minX),p=Array.from({length:4},(_,i)=>[160+(vertices[i*2]-(camera.minX+camera.maxX)/2)*scale,160-(vertices[i*2+1]-(camera.minY+camera.maxY)/2)*scale]);
    const uv=attachment.uvs,u=Array.from({length:4},(_,i)=>[uv[i*2]*32,uv[i*2+1]*32]),du=[u[1][0]-u[0][0],u[1][1]-u[0][1]],dv=[u[2][0]-u[0][0],u[2][1]-u[0][1]],det=du[0]*dv[1]-dv[0]*du[1];
    const ax=((p[1][0]-p[0][0])*dv[1]-(p[2][0]-p[0][0])*du[1])/det,bx=((p[2][0]-p[0][0])*du[0]-(p[1][0]-p[0][0])*dv[0])/det;
    const ay=((p[1][1]-p[0][1])*dv[1]-(p[2][1]-p[0][1])*du[1])/det,by=((p[2][1]-p[0][1])*du[0]-(p[1][1]-p[0][1])*dv[0])/det,d=ax*by-bx*ay;
    const inverse=(x:number,y:number)=>{const dx=x-p[0][0],dy=y-p[0][1];return[u[0][0]+(by*dx-bx*dy)/d,u[0][1]+(-ay*dx+ax*dy)/d];};
    const image=images.values().next().value!,texture=createCanvas(32,32),tc=texture.getContext('2d');tc.drawImage(image,0,0);const pixels=tc.getImageData(0,0,32,32).data;
    for(let y=Math.max(0,Math.floor(Math.min(...p.map(v=>v[1]))));y<Math.min(320,Math.ceil(Math.max(...p.map(v=>v[1]))));y++)for(let x=Math.max(0,Math.floor(Math.min(...p.map(v=>v[0]))));x<Math.min(320,Math.ceil(Math.max(...p.map(v=>v[0]))));x++){
      const coverage=samples.filter(([sx,sy])=>{const [tx,ty]=inverse(x+sx,y+sy);return tx>=0&&tx<32&&ty>=0&&ty<32;}).length/4;if(!coverage)continue;
      const [tx,ty]=inverse(x+.5,y+.5),fx=Math.max(0,Math.min(31,tx-.5)),fy=Math.max(0,Math.min(31,ty-.5)),ix=Math.floor(fx),iy=Math.floor(fy),wx=fx-ix,wy=fy-iy;
      for(let c=0;c<3;c++){const at=(a:number,b:number)=>pixels[(Math.min(31,b)*32+Math.min(31,a))*4+c];const color=(at(ix,iy)*(1-wx)+at(ix+1,iy)*wx)*(1-wy)+(at(ix,iy+1)*(1-wx)+at(ix+1,iy+1)*wx)*wy;const i=(y*320+x)*3+c;buffer[i]=buffer[i]*(1-coverage)+color*coverage;}
    }
  }
  let msaaMaximum=0,msaaChanged=0;for(let i=0;i<320*320;i++){const error=Math.max(...[0,1,2].map(c=>Math.abs(Math.round(buffer[i*3+c])-b[i*4+c])));msaaMaximum=Math.max(msaaMaximum,error);if(error)msaaChanged++;}
  Object.assign(report,{diagnostic4xMsaa:{changedRatio:msaaChanged/(320*320),maximumChannelError:msaaMaximum,note:'仅独立复算旧 region 样本；不作为通用渲染证明或正式三张基线。'}});
  const output=path.join(process.cwd(),'docs/plans/host-parity-diagnostic-20261022.json');await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,worst:worst.slice(0,8),output}));
});
