// 只接受已加载输入；不读写文件、不发布结果、不签发授权。
import { createHash } from 'node:crypto';
import { validateMotion, type CharacterMapping } from './motionEngine.js';
import { solveSemanticPose } from './retargetEngine.js';
import { worldVertices, type loadMotionRuntime } from './motionRuntime.js';
export interface PreparedPoseSource {
  fingerprint: string;
  doc: { json: any; [key:string]: any };
  mapping: CharacterMapping;
  rt: Awaited<ReturnType<typeof loadMotionRuntime>>;
}
export function poseInputHash(p:any):string {
  const input=Object.fromEntries(['version','kind','facing','filePath','mappingPath','frame','groundY','weapon','policy','visualRigPath','referencePosePath','reference','correspondence','sequencePath','stageId','standardPosePath','sourceFingerprint'].map(k=>[k,p[k]??null]));
  const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  return createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
}
function geometricFlex(a:any,b:any,d:any){const ux=a.x-b.x,uy=a.y-b.y,vx=d.x-b.x,vy=d.y-b.y;return 180-Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/(Math.hypot(ux,uy)*Math.hypot(vx,vy)))))*180/Math.PI;}
export function solvePoseKernel(p:any,s:PreparedPoseSource,visualReader?: (skeleton:any)=>any) {
  if(!p.policy||!Number.isFinite(p.policy.kneeFlexionMax)||p.policy.kneeFlexionMax<0||p.policy.kneeFlexionMax>180||p.policy.kneeFlexionMax!==30&&!p.policy.reason?.trim())throw new Error('站姿阈值无效或缺少理由。');
  if(['leftFoot','rightFoot','leftHand','rightHand'].some(k=>!p.frame.targets?.[k]))throw new Error('姿态必须明确双手双脚目标。');
  if(s.fingerprint!==p.sourceFingerprint)throw new Error('姿态资源或 mapping 已改变，请重新建立姿态。');
  if(!Number.isFinite(p.frame.time)||p.frame.time<0)throw new Error('姿态时间需非负有限数。');
  const frame=structuredClone(p.frame),scale=s.mapping.calibration!.scale;
  if(p.weapon){const w=p.weapon;if(![w.x,w.y,w.angle,...Object.values(w.grips??{})].every(Number.isFinite)||!Number.isFinite(w.grips?.left)||!Number.isFinite(w.grips?.right))throw new Error('假想杆需 x/y/angle/grips.left/right，使用 normalizedSkeleton 坐标。');
    const r=w.angle*Math.PI/180;
    for(const side of ['left','right'] as const){const role=`${side}Hand` as const,anchor=s.mapping.bones.anchors?.[role];if(!anchor?.gripPoint)throw new Error(`${role} 未校准 gripPoint，不能假装手腕就是握持点。`);const t=frame.targets[role]??{};const angle=t.angle??w.angle;const h=angle*Math.PI/180,g=anchor.gripPoint,point=anchor.point;frame.targets[role]={...t,x:w.x+w.grips[side]*Math.cos(r)-((g[0]-point[0])*Math.cos(h)-(g[1]-point[1])*Math.sin(h))/scale,y:w.y+w.grips[side]*Math.sin(r)-((g[0]-point[0])*Math.sin(h)+(g[1]-point[1])*Math.cos(h))/scale,angle};}}
  validateMotion({version:2,name:'pose',duration:1,loop:false,coordinateSystem:'normalizedSkeleton',frames:[{...frame,time:0},{...frame,time:1}]});
  for(const v of Object.values(frame.bendDirections??{}))if(v!==1&&v!==-1)throw new Error('关节弯曲方向必须为 ±1。');
  const solved=solveSemanticPose(s.rt,s.mapping,frame,p.groundY),joints:any={},flexion:any={},errors:any={},issues:string[]=[];
  for(const role of ['leftLeg','rightLeg','leftArm','rightArm'] as const){const chain=s.mapping.bones[role]!;const labels=role.endsWith('Leg')?['Hip','Knee','Ankle']:['Shoulder','Elbow','Wrist'];const side=role.startsWith('left')?'left':'right';chain.forEach((n,i)=>{const b=solved.skeleton.findBone(n)!;joints[side+labels[i]]={x:b.worldX,y:b.worldY};});flexion[role]=geometricFlex(...chain.map(n=>{const b=solved.skeleton.findBone(n)!;return {x:b.worldX,y:b.worldY};}) as [any,any,any]);}
  if(p.kind==='standing'){for(const r of ['leftLeg','rightLeg'])if(flexion[r]>p.policy.kneeFlexionMax+1e-5)issues.push(`${r} 屈曲 ${flexion[r].toFixed(2)}° 超过站姿阈值 ${p.policy.kneeFlexionMax}°`);for(const r of ['leftFoot','rightFoot'])if(!frame.targets[r]?.contact)issues.push('标准站姿必须双脚接触地面。');}
  for(const [role,t] of Object.entries(frame.targets) as any){const a=s.mapping.bones.anchors![role as 'leftFoot']!;const b=solved.skeleton.findBone(a.bone)!;let x=b.worldX+b.a*a.point[0]+b.b*a.point[1],y=b.worldY+b.c*a.point[0]+b.d*a.point[1];if(a.solePoints?.length)y=Math.min(...a.solePoints.map(v=>b.worldY+b.c*v[0]+b.d*v[1]));const origin=s.mapping.calibration!.origin!;errors[role]=Math.hypot(x-origin[0]-t.x*scale,y-origin[1]-(t.contact?p.groundY:t.y)*scale);if(errors[role]>.01)issues.push(`${role} 目标误差 ${errors[role]}`);}
  if(solved.unreachable.length)issues.push('存在不可达手脚目标。');
  const vertexMap=worldVertices(solved.skeleton),vertices=Object.values(vertexMap).flat();if(!vertices.length)vertices.push(-1,-1,1,1);
  const xs=vertices.filter((_,i)=>i%2===0),ys=vertices.filter((_,i)=>i%2===1),bounds={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};
  if(!Object.values(bounds).every(Number.isFinite))issues.push('非有限渲染范围。');
  const gripErrors:any={};if(p.weapon){const w=p.weapon,r=w.angle*Math.PI/180,origin=s.mapping.calibration!.origin!;for(const side of ['left','right'] as const){const a=s.mapping.bones.anchors![`${side}Hand`]!,b=solved.skeleton.findBone(a.bone)!,g=a.gripPoint!;gripErrors[side]=Math.hypot(b.worldX+b.a*g[0]+b.b*g[1]-origin[0]-(w.x+w.grips[side]*Math.cos(r))*scale,b.worldY+b.c*g[0]+b.d*g[1]-origin[1]-(w.y+w.grips[side]*Math.sin(r))*scale);if(gripErrors[side]>.01)issues.push(`${side} 握持误差 ${gripErrors[side]}`);}}
  const warnings:string[]=[],headIntrusions:any[]=[];let headBox:any=null;const headSlot=s.doc.json.slots?.find((slot:any)=>slot.bone===s.mapping.bones.head);const hv=Object.entries(vertexMap).find(([name])=>name.startsWith(headSlot?.name+':'))?.[1];if(hv){const hx=hv.filter((_,i)=>i%2===0),hy=hv.filter((_,i)=>i%2===1);headBox={minX:Math.min(...hx),maxX:Math.max(...hx),minY:Math.min(...hy),maxY:Math.max(...hy)};const eps=.001;for(const side of ['left','right']){const w:any=joints[side+'Wrist'];if(w.x>headBox.minX+eps&&w.x<headBox.maxX-eps&&w.y>headBox.minY+eps&&w.y<headBox.maxY-eps){const overlapX=Math.min(headBox.maxX,w.x)-Math.max(headBox.minX,w.x),overlapY=Math.min(headBox.maxY,w.y)-Math.max(headBox.minY,w.y);headIntrusions.push({side,wrist:w,overlapX,overlapY,box:headBox});issues.push(`${side} 手腕进入头部包围盒（重叠 ${overlapX.toFixed(2)}×${overlapY.toFixed(2)}），需改手位`);}}}
  const visual=visualReader?.(solved.skeleton)??null;
  return {...s,...solved,frame,report:{ok:!issues.length,issues,warnings,headBox,headIntrusions,gripErrors,flexion,errors,joints,solverNodes:joints,visualNodes:visual?.points??null,visual,bounds,height:bounds.maxY-bounds.minY,unreachable:solved.unreachable}};
}
