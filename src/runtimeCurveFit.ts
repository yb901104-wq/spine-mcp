import { fitCubicBezierTimeline, sampleTimeline } from './motionMath.js';
import { loadMotionRuntime, worldVertices } from './motionRuntime.js';
import type { ToolContext } from './spineJson.js';

function fitLinear(frames:any[],keys:string[],tolerance:number,defaults:number) {
  if(frames.some(f=>f.curve==='stepped')) return {frames:structuredClone(frames),originalCount:frames.length,compressedCount:frames.length,maxError:0};
  const points:any[]=[];
  for(let i=0;i<frames.length-1;i++)for(let j=0;j<8;j++){const time=(frames[i].time??0)+((frames[i+1].time??0)-(frames[i].time??0))*j/8;points.push({time,...Object.fromEntries(keys.map(k=>[k,sampleTimeline(frames,time,k,defaults)]))});}
  points.push({time:frames.at(-1).time??0,...Object.fromEntries(keys.map(k=>[k,frames.at(-1)[k]??defaults]))});
  const selected=new Set([0,points.length-1]);
  function split(a:number,b:number){if(b<=a+1)return;let worst=a,error=0;for(let i=a+1;i<b;i++){const u=(points[i].time-points[a].time)/(points[b].time-points[a].time);for(const k of keys){const e=Math.abs(points[i][k]-points[a][k]*(1-u)-points[b][k]*u);if(e>error){error=e;worst=i;}}}if(error>tolerance*.95){selected.add(worst);split(a,worst);split(worst,b);}}
  split(0,points.length-1);const result=[...selected].sort((a,b)=>a-b).map(i=>points[i]);
  let maxError=0;for(const point of points)for(const key of keys)maxError=Math.max(maxError,Math.abs(sampleTimeline(result,point.time,key,defaults)-point[key]));
  return {frames:result,originalCount:frames.length,compressedCount:result.length,maxError};
}
export async function fitRuntimeAnimation(json: any, animationName: string, options: { atlasPath?: string; skin?: string; rotationTolerance?: number; translationTolerance?: number; vertexTolerance?: number; useCurves?: boolean }, context: ToolContext) {
  const rotationTolerance = options.rotationTolerance ?? .25, translationTolerance = options.translationTolerance ?? .05, vertexTolerance = options.vertexTolerance ?? 1.2;
  if (![rotationTolerance,translationTolerance,vertexTolerance].every(v=>Number.isFinite(v)&&v>=0)) throw new Error('曲线误差阈值必须为非负有限数。');
  const source = structuredClone(json.animations[animationName]); if (!source) throw new Error('动画不存在。');
  const reference = options.atlasPath ? await loadMotionRuntime(json, options.atlasPath, context) : null;
  const duration = reference?.data.findAnimation(animationName)?.duration ?? 0;
  let result: any;
  for(let attempt=0;attempt<4;attempt++) {
    const fitted=structuredClone(source), stats:any[]=[];
    for(const [bone,tls] of Object.entries(fitted.bones ?? {}) as any) for(const kind of ['rotate','translate','scale','shear']) {
      const frames=tls[kind];if(!Array.isArray(frames)||!frames.length)continue;
      const keys=kind==='rotate'?['value']:['x','y'],tolerance=(kind==='rotate'?rotationTolerance:translationTolerance)/(4**attempt),defaults=kind==='scale'?1:0;
      const fit=options.useCurves===false?fitLinear(frames,keys,tolerance,defaults):fitCubicBezierTimeline(frames,keys,tolerance,8,defaults);
      tls[kind]=fit.frames;stats.push({bone,timeline:kind,...fit,frames:undefined});
    }
    let maxRotationError=0,maxTranslationError=0,maxVertexError=0,loopError=0,samples=0;
    if(reference) {
      const candidate=structuredClone(json);candidate.animations[animationName]=fitted;
      const rt=await loadMotionRuntime(candidate,options.atlasPath!,context);
      const times=new Set<number>(Array.from({length:1001},(_,i)=>duration*i/1000));
      for(const tls of Object.values(source.bones??{}) as any[]) for(const fs of Object.values(tls) as any[]) if(Array.isArray(fs)) for(let i=0;i<fs.length;i++){const t=fs[i].time??0;times.add(t);if(i) times.add(((fs[i-1].time??0)+t)/2);}
      for(const time of [...times].sort((a,b)=>a-b)) {
        const a=reference.sample(animationName,time,options.skin),b=rt.sample(animationName,time,options.skin);samples++;
        for(let i=0;i<a.bones.length;i++){maxRotationError=Math.max(maxRotationError,Math.abs(a.bones[i].rotation-b.bones[i].rotation));maxTranslationError=Math.max(maxTranslationError,Math.abs(a.bones[i].x-b.bones[i].x),Math.abs(a.bones[i].y-b.bones[i].y));}
        const va=worldVertices(a),vb=worldVertices(b);for(const name of Object.keys(va))for(let i=0;i<va[name].length;i+=2)maxVertexError=Math.max(maxVertexError,Math.hypot(va[name][i]-vb[name][i],va[name][i+1]-vb[name][i+1]));
      }
      const start=rt.sample(animationName,0,options.skin).bones.map(b=>[b.worldX,b.worldY,b.a,b.b,b.c,b.d]);
      const end=rt.sample(animationName,duration,options.skin).bones;
      for(let i=0;i<end.length;i++)[end[i].worldX,end[i].worldY,end[i].a,end[i].b,end[i].c,end[i].d].forEach((v,j)=>loopError=Math.max(loopError,Math.abs(v-start[i][j])));
    }
    const ok=!reference||maxRotationError<=rotationTolerance+1e-8&&maxTranslationError<=translationTolerance+1e-8&&maxVertexError<=vertexTolerance+1e-8;
    result={animation:fitted,report:{ok,runtimeVerified:!!reference,attempts:attempt+1,samples,maxRotationError:reference?maxRotationError:null,maxTranslationError:reference?maxTranslationError:null,maxVertexError:reference?maxVertexError:null,loopError:reference?loopError:null,originalCount:stats.reduce((n,s)=>n+s.originalCount,0),compressedCount:stats.reduce((n,s)=>n+s.compressedCount,0),rotationTolerance,translationTolerance,vertexTolerance,stats}};
    if(ok)return result;
  }
  throw new Error(`官方 runtime 曲线误差未满足阈值，未写入：${JSON.stringify(result.report)}`);
}
