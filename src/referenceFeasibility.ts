import { comparisonPolicy } from './poseGraph.js';

/** 固定当前段长/躯干标尺的必要条件；视觉锚点、透视与其它姿态仍需实际验证，不当作全局无解证明。 */
export function referenceFeasibility(comparison:any,lengths:Record<string,number[]>|undefined,torsoLength:number,perspective=false){
  const metrics=comparison?.metrics??[];
  const checks=['left','right'].map(side=>{
    const limb=side+'Arm',reach=metrics.find((m:any)=>m.id===`arm.${side}.wristReach`)?.reference,flexion=metrics.find((m:any)=>m.id===`${limb}.flexion`)?.reference,pair=lengths?.[limb];
    if(perspective||!Number.isFinite(reach)||!Number.isFinite(flexion)||!Number.isFinite(torsoLength)||torsoLength<=1e-8||!pair||pair.length!==2||pair.some(v=>!Number.isFinite(v)||v<=0))return {limb,status:'unknown',reason:perspective?'缩放时不能套用未缩放的固定段长区间。':'缺少当前比较、已校准段长或可靠躯干标尺。'};
    const allowedFlexion=[Math.max(0,flexion-comparisonPolicy.flexionDegrees),Math.min(180,flexion+comparisonPolicy.flexionDegrees)];
    const distance=(a:number)=>Math.sqrt(Math.max(0,pair[0]**2+pair[1]**2+2*pair[0]*pair[1]*Math.cos(a*Math.PI/180)))/torsoLength;
    const possibleReach=[distance(allowedFlexion[1]),distance(allowedFlexion[0])],requiredReach=[Math.max(0,reach-comparisonPolicy.reach),reach+comparisonPolicy.reach];
    const conflict=possibleReach[1]<requiredReach[0]-1e-8||requiredReach[1]<possibleReach[0]-1e-8;
    return {limb,status:conflict?'conditionalConflict':'intervalsOverlap',lengths:pair,torsoLength,allowedFlexion,possibleReach,requiredReach,
      reason:conflict?'当前固定段长条件下，肘角与肩腕距离容许区间没有交集。':'必要区间有交集，但不能据此保证求解或视觉匹配成功。'};
  });
  return {checks,conditionalConflict:checks.some(c=>c.status==='conditionalConflict'),advisory:true,globalUnsolvable:false,
    assumptions:['当前校准骨段长度及躯干标尺固定；视觉切片锚点偏移另验。','不改变身份、支撑、弯曲分支或阈值；透视另按校准能力判断。'],nextSteps:['复核参考标注与视觉关节依据。','检查已声明角色范围；未开放透视只能诊断，不能自动放宽门禁。']};
}
