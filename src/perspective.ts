import { boundedLeastSquares } from './poseRefinementMath.js';
import { solveTwoBoneIK, wrapAngle } from './motionMath.js';

/** 首轮只验证单臂投影缩短；数学区间不是角色美术校准范围。 */
export interface PerspectiveInput {
  mode: 'diagnostic'|'calibration'|'calibrated'; limb: 'leftArm' | 'rightArm'; upper: number; lower: number; basis: string;
  calibrationPath?:string;calibrationHash?:string;widthUpper?:number;widthLower?:number;
}
export const perspectiveSchema = { type: 'object', additionalProperties: false, properties: {
  mode: { enum: ['diagnostic','calibration','calibrated'], description: 'diagnostic 是局部 scale 试验；calibration 是校准样本诊断；calibrated 需独立已审查校准，upper/lower 为实际世界段长相对基准的比例。' },
  limb: { type: 'string', enum: ['leftArm', 'rightArm'] },
  upper: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
  lower: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
  basis: { type: 'string', minLength: 1, description: '缩短的观察或创作依据；不自动推断前后。' },
  calibrationPath:{type:'string',minLength:1},calibrationHash:{type:'string',pattern:'^[a-f0-9]{64}$'},
  widthUpper:{type:'number',exclusiveMinimum:0,maximum:2},widthLower:{type:'number',exclusiveMinimum:0,maximum:2},
}, required: ['mode', 'limb', 'upper', 'lower', 'basis'] };
export function validatePerspective(v: any): asserts v is PerspectiveInput {
  if (!v || Array.isArray(v) || Object.keys(v).some(k => !['mode','limb','upper','lower','basis','calibrationPath','calibrationHash','widthUpper','widthLower'].includes(k)) || !['diagnostic','calibration','calibrated'].includes(v.mode) || !['leftArm','rightArm'].includes(v.limb)
    || ![v.upper,v.lower].every(n => Number.isFinite(n) && n > 0 && n <= 1) || typeof v.basis !== 'string' || !v.basis.trim())
    throw new Error('perspective 只接受 diagnostic 单臂、0 < upper/lower <= 1 和具体依据；不开放翻转或放大。');
  if(v.mode==='diagnostic'&&(v.calibrationPath!==undefined||v.calibrationHash!==undefined||v.widthUpper!==undefined||v.widthLower!==undefined))throw new Error('旧 diagnostic 不接受校准或宽度字段；不能迁移诊断批准。');
  if(v.mode!=='diagnostic'&&(typeof v.calibrationPath!=='string'||!v.calibrationPath.trim()||!/^[a-f0-9]{64}$/.test(v.calibrationHash??'')||[v.widthUpper??1,v.widthLower??1].some(n=>!Number.isFinite(n)||n<=0||n>2)))throw new Error('校准模式需校准文件、精确哈希及有效宽度比例。');
}
export const isDiagnosticPerspective=(frame:any)=>!!frame?.perspective&&frame.perspective.mode!=='calibrated';
export function assertFormalPerspectiveAbsent(frame: any) {
  if(isDiagnosticPerspective(frame))throw new Error('透视缩放仍为诊断：不能批准姿态、组装正式 motion 或取得源动画提交资格。');
}
const angle = (b: any) => Math.atan2(b.c,b.a)*180/Math.PI;
function worldAngle(b: any, degrees: number) {
  const r = degrees*Math.PI/180, x = Math.cos(r), y = Math.sin(r), p = b.parent;
  const det = p ? p.a*p.d-p.b*p.c : 1;
  if (!(det > 1e-10)) throw new Error('透视诊断不支持镜像或奇异父变换。');
  b.rotation = Math.atan2(p ? (p.a*y-p.c*x)/det : y,p ? (p.d*x-p.b*y)/det : x)*180/Math.PI-b.shearX;
}
/** 所有残差来自官方 runtime；不把非均匀缩放后的链当作固定长度刚杆。 */
export function solvePerspectiveArm(skeleton: any, mapping: any, input: PerspectiveInput, target: {x:number;y:number;angle?:number}, bend: 1|-1) {
  validatePerspective(input);
  if(input.mode!=='diagnostic')throw new Error('校准输入必须经过独立的世界投影求解入口。');
  const chain = mapping.bones[input.limb], role = input.limb.replace('Arm','Hand'), anchor = mapping.bones.anchors?.[role];
  if (!chain || chain.length !== 3 || anchor?.bone !== chain[2]) throw new Error('透视诊断需要既有三段臂链与末端锚点。');
  const bones = chain.map((n: string) => skeleton.findBone(n));
  if (bones.some((b:any,i:number) => !b || !(i===0?[0,2]:[0]).includes(b.data.transformMode) || b.scaleX <= 0 || b.scaleY <= 0 || b.shearX || b.shearY)) throw new Error('透视诊断需要正向、无 shear 的臂链；下段/手正常继承，上段另支持 noRotationOrReflection。');
  const affected = new Set(chain);
  if ([...(skeleton.ikConstraints??[]),...(skeleton.transformConstraints??[]),...(skeleton.pathConstraints??[])].some((c:any) => c.bones?.some((b:any)=>affected.has(b.data.name))))
    throw new Error('透视诊断臂链被现有约束接管，当前不支持。');
  const [a,b,c] = bones;
  for(let p=a;p;p=p.parent)if(p.a*p.d-p.b*p.c<=1e-10)throw new Error('透视诊断不支持镜像或奇异祖先变换。');
  a.scaleX *= input.upper; b.scaleX *= input.lower; skeleton.updateWorldTransform();
  const origin = mapping.calibration.origin, unit = mapping.calibration.scale;
  const world = [origin[0]+target.x*unit,origin[1]+target.y*unit], desired = target.angle ?? anchor.angle ?? angle(c);
  const point = () => [c.worldX+c.a*anchor.point[0]+c.b*anchor.point[1],c.worldY+c.c*anchor.point[0]+c.d*anchor.point[1]];
  const lengths = [Math.hypot(b.worldX-a.worldX,b.worldY-a.worldY),Math.hypot(c.worldX-b.worldX,c.worldY-b.worldY)];
  worldAngle(c,desired); skeleton.updateWorldTransform();
  const q = point(), endpoint: [number,number] = [world[0]-(q[0]-c.worldX),world[1]-(q[1]-c.worldY)];
  const seed = solveTwoBoneIK([a.worldX,a.worldY],endpoint,lengths[0],lengths[1],bend);
  const upperDirection=(seed.upperAngle-Math.atan2(b.y,b.x*input.upper)*180/Math.PI)*Math.PI/180;
  // 从实际 runtime 的两组基向量求上段初始角，包含 noRotationOrReflection 的有效父矩阵。
  a.rotation=0;skeleton.updateWorldTransform();const ux=a.a,uy=a.c;
  a.rotation=90;skeleton.updateWorldTransform();const vx=a.a,vy=a.c,det=ux*vy-vx*uy;
  if(!(det>1e-10))throw new Error('透视诊断有效父变换奇异或发生镜像。');
  const dx=Math.cos(upperDirection),dy=Math.sin(upperDirection);
  a.rotation=Math.atan2((ux*dy-uy*dx)/det,(vy*dx-vx*dy)/det)*180/Math.PI;skeleton.updateWorldTransform();
  const offset=(Math.atan2(b.y,b.x)-Math.atan2(c.y*b.scaleY,c.x*b.scaleX))*180/Math.PI;
  const branchBounds:[number,number]=bend===1?[offset+1e-8,offset+180-1e-8]:[offset-180+1e-8,offset-1e-8];
  // 非均匀父变换下解析下段角只能作近似，不能把错误近似夹到直臂奇点。
  // 在已确认分支内部起步，之后仅优化该连续区间，不试跳另一分支。
  const initial = [a.rotation,offset+bend*60];
  const evaluate = (x:number[]) => {
    a.rotation=x[0]; b.rotation=x[1]; skeleton.updateWorldTransform(); worldAngle(c,desired); skeleton.updateWorldTransform();
    const p=point(); return [(p[0]-world[0])/unit,(p[1]-world[1])/unit];
  };
  const fit = boundedLeastSquares(initial,evaluate,{bounds:[[initial[0]-179,initial[0]+179],branchBounds],steps:[.01,.01],iterations:60});
  evaluate(fit.x);
  const p=point(), error=Math.hypot(p[0]-world[0],p[1]-world[1]);
  const cross=(b.worldX-a.worldX)*(c.worldY-b.worldY)-(b.worldY-a.worldY)*(c.worldX-b.worldX);
  const branchOk=Math.abs(cross)<1e-8 || Math.sign(cross)===bend;
  const angleError=Math.abs(wrapAngle(angle(c)-desired));
  return { mode:'diagnostic', experimental:true, diagnosticOnly:true, readyToCommit:false, limb:input.limb, upper:input.upper, lower:input.lower,
    ok:error<=.01&&angleError<=1e-4&&branchOk,error,angleError,branchOk,iterations:fit.iterations,reason:fit.reason,
    actualLengths:[Math.hypot(b.worldX-a.worldX,b.worldY-a.worldY),Math.hypot(c.worldX-b.worldX,c.worldY-b.worldY)],
    note:'投影缩短不证明真实深度；比例未通过角色美术校准，禁止正式批准。' };
}

/** 正式/校准样本共用世界投影残差；局部 scale 是待解变量，不能当作请求的缩短比。 */
export function solveCalibratedArm(skeleton:any,mapping:any,input:PerspectiveInput,target:{x:number;y:number;angle?:number},bend:1|-1,calibration:any){
  validatePerspective(input);
  if(input.mode==='diagnostic'||!calibration||calibration.limb!==input.limb)throw new Error('缺少匹配的独立单臂校准。');
  const ranges=calibration.ranges;
  for(const [key,value]of Object.entries({upper:input.upper,lower:input.lower,widthUpper:input.widthUpper??1,widthLower:input.widthLower??1})as any){const range=ranges[key];if(!range||value<range[0]-1e-8||value>range[1]+1e-8)throw new Error(`透视 ${key} 超出角色已审查范围。`);}
  const chain=mapping.bones[input.limb],anchor=mapping.bones.anchors?.[input.limb.replace('Arm','Hand')],unit=mapping.calibration.scale;
  if(chain?.length!==3||anchor?.bone!==chain[2])throw new Error('校准臂链/末端绑定缺失。');
  const [a,b,c]=chain.map((n:string)=>skeleton.findBone(n));
  if([a,b,c].some((v:any,i:number)=>!v||!(i===0?[0,2]:[0]).includes(v.data.transformMode)||v.scaleX<=0||v.scaleY<=0||v.shearX||v.shearY))throw new Error('校准透视需要无镜像/shear 的支持继承链。');
  const affected=new Set(chain);
  if([...(skeleton.ikConstraints??[]),...(skeleton.transformConstraints??[]),...(skeleton.pathConstraints??[])].some((v:any)=>v.bones?.some((bone:any)=>affected.has(bone.data.name))))throw new Error('校准链被已有约束接管。');
  for(let p=a;p;p=p.parent)if(p.a*p.d-p.b*p.c<=1e-10)throw new Error('校准透视不支持镜像或奇异祖先。');
  const baseScale=[a.scaleX,b.scaleX,a.scaleY,b.scaleY,c.scaleX,c.scaleY],endNorm=calibration.baseline.endNorm;
  const origin=mapping.calibration.origin,world=[origin[0]+target.x*unit,origin[1]+target.y*unit],desired=target.angle??anchor.angle??angle(c);
  const offset=(Math.atan2(b.y,b.x)-Math.atan2(c.y*b.scaleY,c.x*b.scaleX))*180/Math.PI;
  const branch:[number,number]=bend===1?[offset+1e-7,offset+180-1e-7]:[offset-180+1e-7,offset-1e-7];
  const point=()=>[c.worldX+c.a*anchor.point[0]+c.b*anchor.point[1],c.worldY+c.c*anchor.point[0]+c.d*anchor.point[1]];
  const evaluate=(x:number[])=>{
    a.rotation=x[0];b.rotation=x[1];a.scaleX=baseScale[0]*x[2];b.scaleX=baseScale[1]*x[3];
    a.scaleY=baseScale[2]*(input.widthUpper??1);b.scaleY=baseScale[3]*(input.widthLower??1);c.scaleX=baseScale[4];c.scaleY=baseScale[5];skeleton.updateWorldTransform();worldAngle(c,desired);skeleton.updateWorldTransform();
    // 末端方向与世界双基向量长度补偿；不通过自动翻层或 shear 假装新视角。
    c.scaleX*=endNorm[0]/Math.hypot(c.a,c.c);c.scaleY*=endNorm[1]/Math.hypot(c.b,c.d);skeleton.updateWorldTransform();
    const q=point(),lengths=[Math.hypot(b.worldX-a.worldX,b.worldY-a.worldY),Math.hypot(c.worldX-b.worldX,c.worldY-b.worldY)];
    return [(q[0]-world[0])/unit,(q[1]-world[1])/unit,(lengths[0]-calibration.baseline.projection[0]*input.upper)/unit,(lengths[1]-calibration.baseline.projection[1]*input.lower)/unit];
  };
  const lengths=calibration.baseline.projection,seed=solveTwoBoneIK([a.worldX,a.worldY],[world[0],world[1]],lengths[0]*input.upper,lengths[1]*input.lower,bend);
  const initial=[a.rotation,offset+bend*60,input.upper,input.lower],bounds:any=[[a.rotation-179,a.rotation+179],branch,...calibration.localScaleBounds];
  // world angle 仅作种子；最终位置、段长、方向均回读官方 runtime。
  try{worldAngle(a,seed.upperAngle-Math.atan2(b.y,b.x)*180/Math.PI);skeleton.updateWorldTransform();initial[0]=a.rotation;bounds[0]=[a.rotation-179,a.rotation+179];}catch{}
  const fit=boundedLeastSquares(initial,evaluate,{bounds,steps:[.01,.01,.0001,.0001],iterations:60});const residual=evaluate(fit.x),q=point();
  const cross=(b.worldX-a.worldX)*(c.worldY-b.worldY)-(b.worldY-a.worldY)*(c.worldX-b.worldX),branchOk=Math.abs(cross)<1e-8||Math.sign(cross)===bend;
  const actualLengths=[Math.hypot(b.worldX-a.worldX,b.worldY-a.worldY),Math.hypot(c.worldX-b.worldX,c.worldY-b.worldY)],ratios=actualLengths.map((v,i)=>v/lengths[i]);
  const error=Math.hypot(q[0]-world[0],q[1]-world[1]),angleError=Math.abs(wrapAngle(angle(c)-desired)),projectionError=Math.max(Math.abs(ratios[0]-input.upper),Math.abs(ratios[1]-input.lower));
  const endLocalScale=[c.scaleX/c.data.scaleX,c.scaleY/c.data.scaleY],compensationOk=!calibration.endCompensationBounds||endLocalScale.every((v,i)=>v>=calibration.endCompensationBounds[i][0]-1e-5&&v<=calibration.endCompensationBounds[i][1]+1e-5);
  return {mode:input.mode,diagnosticOnly:input.mode!=='calibrated',experimental:input.mode!=='calibrated',readyToCommit:false,limb:input.limb,upper:input.upper,lower:input.lower,calibrationHash:input.calibrationHash,
    ok:error<=.01&&angleError<=1e-4&&projectionError<=1e-4&&branchOk&&compensationOk,error,angleError,projectionError,branchOk,compensationOk,endLocalScale,iterations:fit.iterations,reason:fit.reason,residual,actualLengths,actualRatios:ratios,localScales:fit.x.slice(2),worldWidths:[Math.hypot(a.b,a.d),Math.hypot(b.b,b.d)],endNorm:[Math.hypot(c.a,c.c),Math.hypot(c.b,c.d)],note:'世界投影由 runtime 求解与回读；缩短不推断前后。正式使用仍需当前参考、实际切片、连续性和姿态审查。'};
}
