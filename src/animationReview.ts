import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import gifenc from 'gifenc';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { saveJson, hashObject } from './mappingTools.js';
import { readJson, evidenceFiles, verifyEvidence, animationChecks, poseGate } from './poseWorkflow.js';

const {GIFEncoder,quantize,applyPalette}=gifenc;
// Spine runtime 用 float32 保存时长；边界容差防止 0.9s 错取上一帧。
export const referenceFrameAt=(frames:any[],time:number)=>frames.filter(v=>v.time<=time+1e-6).at(-1)??frames[0];
export async function renderAnimationComparison(a:any,c:ToolContext={}) {
 const target=await readJson(a.targetManifestPath,c),reference=await readJson(a.referenceManifestPath,c),poses=await readJson(a.poseManifestPath,c),map=a.phaseMap;
 if(!Array.isArray(map)||map.length<2||map[0].targetTime!==0||Math.abs(map.at(-1).targetTime-target.duration)>1e-5||map.some((v:any,i:number)=>![v.targetTime,v.referenceTime].every(Number.isFinite)||v.referenceTime<0||v.referenceTime>reference.duration+1e-6||i>0&&(v.targetTime<=map[i-1].targetTime||v.referenceTime<=map[i-1].referenceTime)))throw new Error('阶段时间映射必须严格递增且覆盖完整目标动画。');
 if(!poses.reference||!target.gifPath||!target.frames?.length||hashObject(poses.bounds)!==hashObject(target.bounds))throw new Error('需参考观察参数、目标原速 GIF，且沿用姿态对比的固定相机。');
 const view=poses.reference,w=target.canvas.width,h=target.canvas.height,rs=poses.targetScale*poses.standardHeight/view.height,refY=h*.9-(view.groundY-view.crop[1])*rs,refX=w/2-view.crop[2]*rs/2;
 const out=a.outputDir??target.outputDir;await mkdir(resolveWorkspacePath(out,c),{recursive:true});const gif=GIFEncoder();
 for(let i=0;i<target.frames.length;i++){const t=target.duration*i/target.frames.length;let k=map.findIndex((v:any)=>v.targetTime>t);if(k<0)k=map.length-1;k=Math.max(1,k);const l=map[k-1],r=map[k],rt=l.referenceTime+(r.referenceTime-l.referenceTime)*(t-l.targetTime)/(r.targetTime-l.targetTime);const f=referenceFrameAt(reference.frames,rt);
  const canvas=createCanvas(w,(h+28)*2),ctx=canvas.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,canvas.width,canvas.height);const im=await loadImage(await readFile(resolveWorkspacePath(f.filePath,c)));ctx.save();ctx.beginPath();ctx.rect(0,0,w,h);ctx.clip();ctx.drawImage(im,...view.crop as [number,number,number,number],refX,refY,view.crop[2]*rs,view.crop[3]*rs);ctx.restore();ctx.drawImage(await loadImage(await readFile(resolveWorkspacePath(target.frames[i],c))),0,h+28);ctx.fillStyle='white';ctx.font='14px sans-serif';ctx.fillText(`reference ${rt.toFixed(3)}s`,8,h+20);ctx.fillText(`target ${t.toFixed(3)}s`,8,2*h+48);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data,palette=quantize(pixels,256);const delay=Math.max(10,(Math.round((i+1)*target.duration*100/target.frames.length)-Math.round(i*target.duration*100/target.frames.length))*10);gif.writeFrame(applyPalette(pixels,palette),canvas.width,canvas.height,{palette,delay,repeat:0});
 }
 gif.finish();const gifPath=`${out}/reference-above-target.gif`;await writeFile(resolveWorkspacePath(gifPath,c),gif.bytes());const manifestPath=`${out}/animation-comparison.json`,evidence=await evidenceFiles([gifPath,a.targetManifestPath,target.gifPath,a.referenceManifestPath,a.poseManifestPath,...reference.frames.map((f:any)=>f.filePath)],c);const result={ok:true,layout:'reference-above-target',jsonHash:target.jsonHash,gifPath,originalSpeedGif:target.gifPath,phaseMap:map,evidence,manifestPath};await saveJson(manifestPath,result,c);return result;
}
export async function reviewAnimation(a:any,c:ToolContext={}) {
 if(!/^[0-9a-f]{64}$/.test(a.reviewToken))throw new Error('reviewToken 格式无效。');
 const record=await readJson(`.spine-mcp/reviews/${a.reviewToken}.json`,c),candidate=await readJson(record.candidatePath,c);
 if(hashObject(candidate)!==record.candidateHash)throw new Error('候选动画已改变。');
 const motion=await readJson(record.motionPath,c),gate=await poseGate(motion,c);if(!gate.ok||gate.fingerprint!==record.tokenData.poseReview)throw new Error('关键姿态确认已过期。');
 const keyGraphs=await (await import('./referenceRetarget.js')).compareAnimationKeyPoses(record.candidatePath,record.tokenData.animation,motion,record.duration??motion.duration,c);
 if(a.decision==='approved'&&!keyGraphs.ok)throw new Error('插值后实际关键时间的参考骨架关系失败，不能批准完整动画。');
 const m=await readJson(a.manifestPath,c);if(m.jsonHash!==record.candidateHash||!m.gifPath)throw new Error('视觉证据不是当前完整候选动画。');
 if(record.requiresReferenceComparison&&m.layout!=='reference-above-target')throw new Error('有参考的任务需上下同步 GIF 和原速 GIF。');
 if(!a.reviewedBy?.trim()||!a.reason?.trim()||!['approved','rejected'].includes(a.decision)||animationChecks.some(k=>!a.checks?.includes(k))||a.decision==='approved'&&a.issues?.length)throw new Error('完整动画审查需确认者、理由、全部检查项，未解决问题不得确认。');
 const evidence=[...m.evidence??[],...await evidenceFiles([a.manifestPath,m.gifPath,...m.originalSpeedGif?[m.originalSpeedGif]:[],...m.frames??[]],c)];await verifyEvidence(evidence,c);
 const review={decision:a.decision,reviewedBy:a.reviewedBy,reason:a.reason,checks:a.checks,issues:a.issues??[],keyGraphsFingerprint:keyGraphs.fingerprint,evidence,at:new Date().toISOString(),baseToken:a.reviewToken,candidateHash:record.candidateHash};const reviewToken=hashObject({base:a.reviewToken,review});
 if(a.dryRun===false)await saveJson(`.spine-mcp/reviews/${a.reviewToken}.visual.json`,{review,reviewToken},c);return {ok:true,dryRun:a.dryRun??true,reviewToken,review};
}
export async function assertAnimationReview(base:string,approval:string|undefined,c:ToolContext) {const r=await readJson(`.spine-mcp/reviews/${base}.visual.json`,c);if(r.review.decision!=='approved'||approval!==r.reviewToken||hashObject({base,review:r.review})!==r.reviewToken)throw new Error('缺少有效完整动画视觉审查。');const record=await readJson(`.spine-mcp/reviews/${base}.json`,c),candidate=await readJson(record.candidatePath,c);if(hashObject(candidate)!==record.candidateHash)throw new Error('完整候选已改变。');const motion=await readJson(record.motionPath,c),graphs=await (await import('./referenceRetarget.js')).compareAnimationKeyPoses(record.candidatePath,record.tokenData.animation,motion,record.duration??motion.duration,c);if(!graphs.ok||graphs.fingerprint!==r.review.keyGraphsFingerprint)throw new Error('实际动画关键时间关系比较失败或已过期。');await verifyEvidence(r.review.evidence,c);return r;}
