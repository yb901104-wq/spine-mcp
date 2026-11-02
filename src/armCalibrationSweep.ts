import gifenc from 'gifenc';
import {createCanvas} from '@napi-rs/canvas';
import {solvePoseKernel} from './animationKernel.js';
import {rasterFrame} from './rasterRenderer.js';
import {objectHash,HostError} from './hostContracts.js';
import {captureRuntimeState} from './captureEvidence.js';
const {GIFEncoder,quantize,applyPalette}=gifenc;
/** 校准批准前的诊断扫掠：不生成 pose/motion 资产或提交令牌。 */
export async function calibrationSweep(pose:any,source:any,visualReader:any,record:any,samples:any[],images:any,count=33,duration=2,signal?:AbortSignal,progress?:(stage:string)=>void){
  const role=record.limb.replace('Arm','Hand'),bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
  for(const s of record.samples){const b=s.renderBounds;bounds.minX=Math.min(bounds.minX,b.minX);bounds.minY=Math.min(bounds.minY,b.minY);bounds.maxX=Math.max(bounds.maxX,b.maxX);bounds.maxY=Math.max(bounds.maxY,b.maxY);}
  const pad=Math.max(bounds.maxX-bounds.minX,bounds.maxY-bounds.minY)*.1;bounds.minX-=pad;bounds.minY-=pad;bounds.maxX+=pad;bounds.maxY+=pad;
  const gif=GIFEncoder(),sheet=createCanvas(160*6,180*Math.ceil(count/6)),ctx=sheet.getContext('2d'),frames:any[]=[];let previous:any=null,maximumJointStep=0,encodedDurationMs=0;
  const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;
  for(let i=0;i<count;i++){
    if(signal?.aborted)throw new HostError('TASK_CANCELLED','校准连续性诊断已取消，未产生批准。',409);
    if(i%8===0){progress?.(`计算校准连续性 ${i+1}/${count}`);await new Promise<void>(r=>setImmediate(r));}
    const position=i*(samples.length-1)/(count-1),index=Math.min(samples.length-2,Math.floor(position)),fraction=position-index,a=samples[index],b=samples[index+1],p=structuredClone(pose);
    p.frame.body=Object.fromEntries(['x','y','rotate'].map(k=>[k,lerp((a.body??pose.frame.body)[k],(b.body??pose.frame.body)[k],fraction)]));
    p.frame.targets[role]={...p.frame.targets[role],...Object.fromEntries(['x','y','angle'].map(k=>[k,lerp(a.target[k],b.target[k],fraction)]))};
    const input={upper:lerp(a.upper,b.upper,fraction),lower:lerp(a.lower,b.lower,fraction),widthUpper:lerp(a.widthUpper??1,b.widthUpper??1,fraction),widthLower:lerp(a.widthLower??1,b.widthLower??1,fraction),basis:''};
    p.frame.perspective={...input,basis:record.basis,mode:'calibration',limb:record.limb,calibrationPath:'calibration-sweep.json',calibrationHash:'0'.repeat(64)};
    // 临时精确样本仅存在于此纯计算调用，完成立即移除；外部 calibration 仍只允许记录中的精确点。
    record.samples.push({input,frame:{body:p.frame.body,targets:{[role]:p.frame.targets[role]}}});
    let solved:any;try{solved=solvePoseKernel(p,{...source,perspectiveCalibration:record},visualReader);}finally{record.samples.pop();}
    const numeric=solved.report.perspective,actual=captureRuntimeState(solved.skeleton),chain=source.mapping.bones[record.limb].map((name:string)=>solved.skeleton.findBone(name)),joints=chain.map((bone:any)=>[bone.worldX,bone.worldY]);
    if(previous)joints.forEach((point:number[],j:number)=>{maximumJointStep=Math.max(maximumJointStep,Math.hypot(point[0]-previous[j][0],point[1]-previous[j][1])/source.mapping.calibration.scale);});previous=joints;
    const bnd=solved.report.bounds,cameraContains=bnd.minX>=bounds.minX&&bnd.maxX<=bounds.maxX&&bnd.minY>=bounds.minY&&bnd.maxY<=bounds.maxY;
    frames.push({time:duration*i/(count-1),input,numericOk:numeric.ok===true,branchOk:numeric.branchOk,projectionError:numeric.projectionError,cameraContains,runtimeHash:objectHash(actual)});
    const canvas=rasterFrame(solved.skeleton,images,bounds,320,320,'#20242b'),pixels=canvas.getContext('2d').getImageData(0,0,320,320).data,palette=quantize(pixels,256),delay=Math.max(10,(Math.round((i+1)*duration*100/count)-Math.round(i*duration*100/count))*10);encodedDurationMs+=delay;
    gif.writeFrame(applyPalette(pixels,palette),320,320,{palette,delay,repeat:0});ctx.drawImage(canvas,i%6*160,Math.floor(i/6)*180,160,160);ctx.fillStyle='#eff';ctx.font='11px sans-serif';ctx.fillText(`${frames.at(-1).time.toFixed(2)}s / ${input.upper.toFixed(3)}`,i%6*160+4,Math.floor(i/6)*180+174);
  }
  gif.finish();return {report:{kind:'diagnosticCalibrationSweep',approved:false,formalMotion:false,numericOk:frames.every(f=>f.numericOk&&f.cameraContains),branchStable:frames.every(f=>f.branchOk),frameCount:count,duration,encodedDurationMs,maximumJointStepNormalized:maximumJointStep,camera:bounds,frames,note:'固定身份与分支的诊断轨迹；记录变化量，不以自设连续性门限自动批准。真实 player 关键样本与独立视觉审查仍须另验。'},gif:Buffer.from(gif.bytes()),sheet:sheet.toBuffer('image/png')};
}
