import { boundedLeastSquaresSteps,type LeastSquaresOptions } from './poseRefinementMath.js';
import { checkpoint,taskCheckpoint,reportProgress } from './taskControl.js';
export async function boundedLeastSquaresTask(initial:number[],evaluate:(x:number[])=>number[],options:LeastSquaresOptions){
  checkpoint('局部修正');
  const iterator=boundedLeastSquaresSteps(initial,evaluate,options);let step=iterator.next();
  while(!step.done){await taskCheckpoint('局部修正');reportProgress(step.value.iteration,step.value.total,'逐次修正当前姿态');checkpoint('局部修正');step=iterator.next();}
  const total=Math.min(60,options.iterations??60);reportProgress(total,total,'局部修正计算结束，仍需视觉审查');return step.value;
}
