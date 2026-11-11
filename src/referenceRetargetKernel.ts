// 参考适配的纯计算内核：输入标注、绑定、已确认标准姿态及已加载角色，不读写文件。
import { solvePoseKernel } from './animationKernel.js';
import { forkMotionRuntime } from './motionRuntime.js';
import { readVisualNodes } from './visualRig.js';
import { runtimeGraph } from './referenceRetarget.js';
import { normalizedGraph,torsoAxis,torsoFrame,torsoCoordinate,distance,direction,finitePoint,limbNodes,normalizeImagePoints,angleError,signedAngle,compareGraphs,policyFingerprint,referenceBendDirections } from './poseGraph.js';
import { adaptationSummary, resolveRetargetMode } from './retargetPolicy.js';

/**
 * 为所有支撑脚求一个共同的身体竖直位移。
 *
 * 接触点必须同时落在各自两段腿的可达环带内；这里不平均两个高度，
 * 而是求可行区间交集。原始参考高度残差仍作为诊断证据保留。
 */
function solveJointSupportShift(contacts:string[],frame:any,s:any,v:any,scale:number,origin:number[],groundY:number,preferredShift:number|null,expected:any,targetFacing:string){
 const details:any[]=[],ranges:any[]=[];
 for(const side of contacts){
  const role=side+'Foot',limb=side+'Leg',target=frame.targets?.[role],anchor=v.mapping.bones.anchors?.[role],node=v.rig.nodes?.[side+'Ankle'],chain=v.mapping.bones[limb],lengths=v.mapping.calibration?.lengths?.[limb];
  if(!target||!anchor||!node||node.type!=='boneLocal'||node.bone!==anchor.bone||!expected?.[side+'Ankle']||!chain||chain.length!==3||!lengths){details.push({side,role,ok:false,reason:'支撑脚缺少 target、visual ankle、anchor、三段链或校准长度。'});continue;}
  const [hipBone,,endBone]=chain.map((name:string)=>s.skeleton.findBone(name)!);
  const factor=Math.hypot(endBone.a,endBone.c),rad=(target.angle??anchor.angle??0)*Math.PI/180,mirror=targetFacing==='left'?-1:1;
  // IK 的 endpoint 是末端骨骼原点；expected ankle 是末端骨骼上的 visual point。
  const endpointX=expected[side+'Ankle'].x-factor*(node.point[0]*Math.cos(rad)-node.point[1]*Math.sin(rad))*mirror;
  const hipX=hipBone.worldX,hipY=hipBone.worldY,dx=endpointX-hipX;
  const minReach=Math.abs(lengths[0]-lengths[1]),maxReach=lengths[0]+lengths[1],maxY2=maxReach*maxReach-dx*dx;
  if(maxY2<0){details.push({side,role,ok:false,reason:'参考脚位相对目标髋部的水平距离超过腿链最大可达长度。',dx,maxReach});continue;}
  const ground=origin[1]+groundY*scale;
  const lowest=anchor.solePoints?.length?Math.min(...anchor.solePoints.map((p:number[])=>factor*(p[0]*Math.sin(rad)+p[1]*Math.cos(rad)))):factor*(anchor.point[0]*Math.sin(rad)+anchor.point[1]*Math.cos(rad));
  const relative=ground-lowest-hipY,maxY=Math.sqrt(Math.max(0,maxY2)),minY2=minReach*minReach-dx*dx,minY=minY2>0?Math.sqrt(minY2):0;
  // q 上移会让髋部上移，因此 endpoint→髋部的相对 y 为 relative-q。
  const outer:[number,number]=[relative-maxY,relative+maxY],inner:[number,number]|null=minY2>0?[relative-minY,relative+minY]:null;
  ranges.push({side,role,outer,inner,relative,dx,minReach,maxReach,endpointX});details.push({side,role,ok:true,outer,inner,relative,dx,minReach,maxReach,endpointX});
 }
 const feasible=(q:number)=>ranges.every(r=>q>=r.outer[0]-1e-8&&q<=r.outer[1]+1e-8&&(!r.inner||q<=r.inner[0]+1e-8||q>=r.inner[1]-1e-8));
 const candidates=[preferredShift??0,0,...ranges.flatMap(r=>[...r.outer,...(r.inner??[])])];
 const shiftWorld=candidates.filter(feasible).sort((a,b)=>Math.abs(a-(preferredShift??0))-Math.abs(b-(preferredShift??0)))[0];
 return {ok:ranges.length===contacts.length&&Number.isFinite(shiftWorld),shiftWorld:Number.isFinite(shiftWorld)?shiftWorld:null,shiftNormalized:Number.isFinite(shiftWorld)?shiftWorld/scale:null,details};
}

/** 将 torsoCoordinate 的归一化坐标还原到当前目标躯干坐标系。
 *  torsoCoordinate 使用 (a=沿躯干轴、n=横向投影)；这里保持同一约定，
 *  这样 reference → target 的比例变化不会再退化成参考肢体方向复制。
 */
function torsoPointFromCoordinate(frame:any, local:any):{x:number,y:number}|null {
 if(!frame||!local||!Number.isFinite(local.a)||!Number.isFinite(local.n)||!Number.isFinite(frame.length)||frame.length<=1e-8)return null;
 const dx=local.n*frame.length;
 const ux=frame.u.x,uy=frame.u.y;
 if(Math.abs(uy)>1e-6){
  const dy=(local.a*frame.length-ux*dx)/uy;
  return {x:frame.hip.x+dx,y:frame.hip.y+dy};
 }
 // 极端水平躯干时，使用与躯干轴正交的侧向轴，避免数值爆炸。
 const side={x:-frame.u.y,y:frame.u.x};
 return {x:frame.hip.x+frame.u.x*local.a*frame.length+side.x*local.n*frame.length,y:frame.hip.y+frame.u.y*local.a*frame.length+side.y*local.n*frame.length};
}

function projectEndpointToReachable(start:{x:number,y:number},requested:{x:number,y:number},lengths:[number,number],epsilon=1e-4){
 const dx=requested.x-start.x,dy=requested.y-start.y,d=Math.hypot(dx,dy),minReach=Math.abs(lengths[0]-lengths[1]),maxReach=lengths[0]+lengths[1];
 const lo=Math.min(Math.max(minReach+epsilon,epsilon),Math.max(maxReach-epsilon,epsilon));
 const hi=Math.max(lo,Math.max(maxReach-epsilon,epsilon));
 const solvedDistance=Math.min(hi,Math.max(lo,d));
 if(d<=1e-8)return {point:{x:start.x+solvedDistance,y:start.y},requestedDistance:d,solvedDistance,residual:Math.abs(solvedDistance-d),relaxed:solvedDistance!==d,reason:'targetArmOrLegDirectionUndefined'};
 return {point:{x:start.x+dx/d*solvedDistance,y:start.y+dy/d*solvedDistance},requestedDistance:d,solvedDistance,residual:Math.abs(solvedDistance-d),relaxed:Math.abs(solvedDistance-d)>1e-6,reason:solvedDistance<d?'targetChainTooShort':'targetChainMinimumReach'};
}

export function retargetReferencePoseKernel(a:any,prepared:any){
 const {reference:r,visual:v,base,source}=prepared;
 const retargetMode=resolveRetargetMode(a.retargetMode,false);
 const solve=(pose:any)=>solvePoseKernel(pose,{...source,rt:forkMotionRuntime(source.rt)},pose.visualRigPath?(sk:any)=>readVisualNodes(sk,v.rig):undefined);
 let s=solve(base);const ref=normalizedGraph(r.observation.points,r.observation.facing,true),scale=v.mapping.calibration!.scale,origin=v.mapping.calibration!.origin!,targetFacing=a.facing??base.facing;
 const frame=structuredClone(base.frame),expected:any={},conflicts:string[]=[];frame.time=a.time??r.observation.time;frame.bendDirections={...frame.bendDirections};
 if(r.observation.actionSemantics){const anatomical=r.observation.actionSemantics.weaponHand,side=v.rig.anatomicalSides?.[anatomical];frame.action={driver:side?`${side}Hand`:null};if(!side)conflicts.push('未校准解剖持杖手到目标链的绑定。');}
 const calibrationNodes=readVisualNodes(s.skeleton,v.rig).points;
 const referenceFrame=torsoFrame(ref),targetNeutralFrame=torsoFrame(calibrationNodes);
 const intent:any={version:1,coordinateSystem:'targetTorsoLocal',retargetMode,reference:{facing:r.observation.facing,torsoLength:referenceFrame?.length??null},targetCalibration:{torsoLength:targetNeutralFrame?.length??null,shoulderWidth:targetNeutralFrame?distance(calibrationNodes.leftShoulder,calibrationNodes.rightShoulder):null,hipWidth:targetNeutralFrame?distance(calibrationNodes.leftHip,calibrationNodes.rightHip):null},limbs:{},support:{reference:structuredClone(r.observation.support??{}),targetGroundY:base.groundY??0},weapon:{reference:structuredClone(r.observation.grip??null)}};
 if(referenceFrame&&targetNeutralFrame){
  intent.reference.normalizedPoints=Object.fromEntries(Object.entries(ref).filter(([,p])=>finitePoint(p as any)).map(([k,p])=>[k,torsoCoordinate(referenceFrame,p as any)]));
  intent.targetCalibration.neutralPoints=Object.fromEntries(Object.entries(calibrationNodes).filter(([,p])=>finitePoint(p as any)).map(([k,p])=>[k,torsoCoordinate(targetNeutralFrame,p as any)]));
 }
 const referenceAxis=torsoAxis(ref),targetAxis=torsoAxis(calibrationNodes);
 if(referenceAxis&&targetAxis&&distance(referenceAxis.hip,referenceAxis.shoulder)>1e-8){const sign=targetFacing==='left'?-1:1,desired=direction({x:referenceAxis.hip.x*sign,y:referenceAxis.hip.y},{x:referenceAxis.shoulder.x*sign,y:referenceAxis.shoulder.y}),current=direction(targetAxis.hip,targetAxis.shoulder),delta=((desired-current+540)%360)-180;frame.body.rotate+=delta;s=solve({...base,frame});}
 else conflicts.push('肩中心—髋中心必要躯干轴未知。');
 // body.rotate 会同时转动肩线与髋线，改不了两者夹角（扭转）；参考的肩线朝向只能由躯干通道补偿。
 const torsoChannel=(v.mapping.bones.channels as any)?.torso,shL=ref[a.correspondence.left+'Shoulder'],shR=ref[a.correspondence.right+'Shoulder'];
 if(torsoChannel&&finitePoint(shL)&&finitePoint(shR)){const now=readVisualNodes(s.skeleton,v.rig).points;
  if(finitePoint(now.leftShoulder)&&finitePoint(now.rightShoulder)){const want=direction(shL,shR),have=direction(now.leftShoulder,now.rightShoulder),dt=((want-have+540)%360)-180;
   if(Math.abs(dt)>.05){frame.channels={...(frame.channels??{}),torso:{...(frame.channels?.torso??{}),rotate:(frame.channels?.torso?.rotate??0)+dt}};s=solve({...base,frame});}
  }else conflicts.push('躯干通道所需的肩节点未知。');
 }
 // 头部朝向：frame.head 一直被 schema 和执行层支持，但从未被赋值；这里按参考面部锚点补一次。
 const refHead=ref.head,refFace=ref.face;
 if(a.headFromReference===true&&finitePoint(refHead)&&finitePoint(refFace)){const now=readVisualNodes(s.skeleton,v.rig).points;
  if(finitePoint(now.head)&&finitePoint(now.face)){const wantH=direction(refHead,refFace),haveH=direction(now.head,now.face),dh=((wantH-haveH+540)%360)-180;
   if(Math.abs(dh)>.05){frame.head=(frame.head??0)+dh;s=solve({...base,frame});}
  }
 }
 const initial=readVisualNodes(s.skeleton,v.rig).points;
 const currentTorsoFrame=torsoFrame(initial);
 const fixedBranches=referenceBendDirections(r.observation,a.correspondence,targetFacing);
 const localProjections:any={};
 for(const [role,n]of Object.entries(limbNodes)){
  const side=role.startsWith('left')?'left':'right',rs=a.correspondence[side],rn=n.map(k=>rs+k.slice(side.length));
  if(!rn.every(k=>finitePoint(ref[k]))){conflicts.push(`${role} 必要参考节点未知。`);continue;}
  const lengths=v.mapping.calibration!.lengths![role as 'leftArm'];const start=initial[n[0]],factor=targetFacing==='left'?-1:1;
  const u=direction(ref[rn[0]],ref[rn[1]])*Math.PI/180,l=direction(ref[rn[1]],ref[rn[2]])*Math.PI/180;
  expected[n[0]]=start;expected[n[1]]={x:start.x+factor*lengths[0]*Math.cos(u),y:start.y+lengths[0]*Math.sin(u)};
  // 目标角色化局部位置直接参与末端求解：先按目标躯干当前坐标系还原，
  // 再投影到目标角色自身两段骨骼的可达环带。这样短臂/短腿只放宽距离，
  // 保留方向和弯曲分支，而不是复制参考角色的绝对末端位置。
  const intentLocalEnd=referenceFrame&&targetNeutralFrame?torsoCoordinate(referenceFrame,ref[rn[2]]):null;
  const requestedEnd=currentTorsoFrame&&intentLocalEnd?torsoPointFromCoordinate(currentTorsoFrame,intentLocalEnd):null;
  const fallbackEnd={x:expected[n[1]].x+factor*lengths[1]*Math.cos(l),y:expected[n[1]].y+lengths[1]*Math.sin(l)};
  const projection=requestedEnd?projectEndpointToReachable(start,requestedEnd,lengths,retargetMode==='adaptive'?Math.max(.5,(lengths[0]+lengths[1])*.04):1e-4):{point:fallbackEnd,requestedDistance:Math.hypot(fallbackEnd.x-start.x,fallbackEnd.y-start.y),solvedDistance:Math.hypot(fallbackEnd.x-start.x,fallbackEnd.y-start.y),residual:0,relaxed:false,reason:'missingTargetTorsoFrame'};
  expected[n[2]]=projection.point;
  localProjections[role]={requestedLocal:intentLocalEnd,requestedWorld:requestedEnd,solvedWorld:projection.point,requestedDistance:projection.requestedDistance,solvedDistance:projection.solvedDistance,residual:projection.residual,relaxed:projection.relaxed,reason:projection.reason};
  const neutralA=direction(calibrationNodes[n[0]],calibrationNodes[n[1]]),neutralB=direction(calibrationNodes[n[1]],calibrationNodes[n[2]]);
  intent.limbs[role]={segmentDirections:[direction(ref[rn[0]],ref[rn[1]]),direction(ref[rn[1]],ref[rn[2]])],relativeAngles:[signedAngle(neutralA,direction(ref[rn[0]],ref[rn[1]])),signedAngle(neutralB,direction(ref[rn[1]],ref[rn[2]]))],bendDirection:fixedBranches[role],targetEndLocal:intentLocalEnd??(targetNeutralFrame&&finitePoint(calibrationNodes[n[2]])?torsoCoordinate(targetNeutralFrame,calibrationNodes[n[2]]):null),projection:localProjections[role]};
  frame.bendDirections[role]=fixedBranches[role];
 }
 // 根据参考腿段同时计算两脚和身体高度；不可继承并腿准备姿态。
 const supportMode=r.observation.supportMode??(r.observation.support?.left===false&&r.observation.support?.right===false?'airborne':'grounded');
 const contacts=['left','right'].filter(side=>r.observation.support?.[a.correspondence[side]]===true);
 if(!contacts.length && supportMode!=='airborne')conflicts.push('缺少明确支撑关系；接地阶段至少需要一只支撑脚。');
 const deltas=contacts.map(side=>{
  const key=side+'Ankle',anchor=(v.mapping.bones.anchors as any)[side+'Foot'],node=v.rig.nodes[key],b=s.skeleton.findBone(anchor.bone)!;
  if(!expected[key]||node.type!=='boneLocal'||node.bone!==anchor.bone)return NaN;
  const rad=(frame.targets[side+'Foot'].angle??anchor.angle??0)*Math.PI/180,factor=Math.hypot(b.a,b.c),vertical=(p:number[])=>factor*(p[0]*Math.sin(rad)+p[1]*Math.cos(rad));
  // 地面锁定的是鞋底，不是踝；省略鞋底高度会把直腿准备误求解成深蹲。
  const lowest=anchor.solePoints?.length?Math.min(...anchor.solePoints.map(vertical)):vertical(anchor.point);
  const ankleHeight=base.groundY*scale+origin[1]-lowest+vertical(node.point);
  return ankleHeight-expected[key].y;
 });
 if(deltas.some(d=>!Number.isFinite(d)))conflicts.push('支撑脚必要节点未知。');
 // 先求所有支撑脚的可行竖直位移区间；不存在交集时保留失败，不能用平均高度制造通过。
 const preferredShift=deltas.length&&deltas.every(Number.isFinite)?deltas[0]:null;
 const supportSolve=solveJointSupportShift(contacts,frame,s,v,scale,origin,base.groundY??0,preferredShift,expected,targetFacing);
 const dy=supportSolve.ok&&supportSolve.shiftWorld!==null?supportSolve.shiftWorld:(deltas.length&&deltas.every(Number.isFinite)?deltas[0]:0);
 const contactResiduals=contacts.map((side,i)=>({side,requiredHeight:deltas[i],residual:deltas[i]-dy}));
 if((!supportSolve.ok||contactResiduals.some(v=>Math.abs(v.residual)>.15))&&retargetMode==='strict')conflicts.push('两脚接地高度要求冲突，需联合修正；未采用平均高度。');
 frame.body.y+=dy/scale;for(const point of Object.values(expected) as any[])point.y+=dy;
 // 身体移动后重新回读实际变换，用于视觉锚点到末端目标的转换。
 s=solve({...base,frame});
 for(const side of ['left','right'])for(const part of ['Leg','Arm']){
  const role=side+part,n=limbNodes[role],end=expected[n[2]],hand=part==='Arm',key=side+(hand?'Hand':'Foot');if(!end)continue;
  const anchor=(v.mapping.bones.anchors as any)[key],node=v.rig.nodes[n[2]],b=s.skeleton.findBone(anchor.bone)!,angle=frame.targets[key].angle??anchor.angle??0,rad=angle*Math.PI/180,factor=Math.hypot(b.a,b.c);
  // 握持偏移方向来自已标注腕到握点，不继承站姿的垂手角度。
  if(hand&&r.observation.grip?.points?.[a.correspondence[side]]&&anchor.gripPoint){const g=r.observation.grip.points[a.correspondence[side]],w=r.observation.points[a.correspondence[side]+'Wrist'],dx=(g.x-w.x)*(targetFacing==='left'?-1:1),dy=-(g.y-w.y),local=Math.atan2(anchor.gripPoint[1]-anchor.point[1],anchor.gripPoint[0]-anchor.point[0]);if(Math.hypot(dx,dy)>1e-8)frame.targets[key].angle=(Math.atan2(dy,dx)-local)*180/Math.PI;}
  const targetAngle=frame.targets[key].angle??angle,targetRad=targetAngle*Math.PI/180;
  // 视觉末端与骨骼末端之间的偏移，转换到现有锚点目标。
  if(node.type!=='boneLocal'||node.bone!==anchor.bone){conflicts.push(`${n[2]} 非末端骨骼局部锚点，第一版不自动反解网格目标。`);continue;}
  const dx=(anchor.point[0]-node.point[0])*factor,dy=(anchor.point[1]-node.point[1])*factor;
  frame.targets[key]={x:(end.x+dx*Math.cos(targetRad)-dy*Math.sin(targetRad)-origin[0])/scale,y:(end.y+dx*Math.sin(targetRad)+dy*Math.cos(targetRad)-origin[1])/scale,angle:targetAngle,...!hand?{contact:r.observation.support?.[a.correspondence[side]]===true}:{}};
 }
 const contactProjections=supportSolve;
 const supportPoints=['left','right'].map(side=>expected[side+'Ankle']).filter(finitePoint);
 if(supportPoints.length){intent.support.targetSupportCenter={x:supportPoints.reduce((sum,p)=>sum+p.x,0)/supportPoints.length,y:supportPoints.reduce((sum,p)=>sum+p.y,0)/supportPoints.length};intent.support.targetFootDistance=supportPoints.length===2?distance(supportPoints[0],supportPoints[1]):null;}
 const targetGripPoints={left:expected.leftWrist,right:expected.rightWrist};
 if(finitePoint(targetGripPoints.left)&&finitePoint(targetGripPoints.right)){intent.weapon.targetGripPoints=targetGripPoints;intent.weapon.targetAxis=direction(targetGripPoints.left,targetGripPoints.right);intent.weapon.gripDistance=distance(targetGripPoints.left,targetGripPoints.right);}
 const draft={pose:{version:1,id:a.id,kind:'action',facing:a.facing??base.facing,status:'draft',filePath:v.rig.filePath,mappingPath:v.rig.mappingPath,standardPosePath:a.standardPosePath,sourceFingerprint:v.fingerprint,frame:structuredClone(frame),groundY:base.groundY??0,weapon:a.weapon??null,referencePosePath:a.referencePosePath,reference:structuredClone(r.observation),policy:{kneeFlexionMax:30,reason:''},visualRigPath:a.visualRigPath,correspondence:a.correspondence,...a.sequencePath?{sequencePath:a.sequencePath,stageId:a.stageId}:{}} as any};
 draft.pose.retargetMode=retargetMode;
 draft.pose.adaptation={retargetMode,intent,expected,conflicts,contactResiduals,contactProjections,localProjections,policyFingerprint,method:'参考动作意图按目标角色躯干轴、neutral calibration 与校准链长重建；局部末端先投影到目标链可达环带，原始接地残差独立报告。'};
 // 参考握持线 → 假想杆：把双手约束到同一根轴上，避免「各握各的」；够不到时只会在杆上滑动。
 const rgp=r.observation.grip?.points,la=v.mapping.bones.anchors?.leftHand,ra=v.mapping.bones.anchors?.rightHand;
 if(a.weaponFromReference===true&&rgp?.left&&rgp?.right&&la?.gripPoint&&ra?.gripPoint){
  const L=draft.pose.frame.targets?.leftHand,R=draft.pose.frame.targets?.rightHand;
  if([L?.x,L?.y,R?.x,R?.y].every(Number.isFinite)){
   const gp=normalizeImagePoints({left:rgp.left,right:rgp.right},r.observation.facing) as any;
   let axis=direction(gp.left,gp.right);const cur=direction({x:L.x,y:L.y},{x:R.x,y:R.y});
   if(angleError(axis,cur)>90)axis=((axis+180+540)%360)-180;
   const rad=axis*Math.PI/180,ux=Math.cos(rad),uy=Math.sin(rad),cx=(L.x+R.x)/2,cy=(L.y+R.y)/2,proj=(t:any)=>(t.x-cx)*ux+(t.y-cy)*uy;
   draft.pose.weapon={x:cx,y:cy,angle:axis,grips:{left:proj(L),right:proj(R)}};
   draft.pose.adaptation.method+='；双手按参考握持轴吸附到同一根假想杆（weaponFromReference:true 显式开启）。';
  }
 }
 let solved=solve(draft.pose);
 let actual=runtimeGraph(solved.skeleton,v.rig,v.mapping,draft.pose);
 let comparison=compareGraphs(r.observation,actual,a.correspondence,{retargetMode});
 // 参考弯曲方向是语义约束，但不同角色的骨骼局部轴可能与参考图像坐标相反。
 // 不交换左右身份，只尝试当前肢体的另一 IK 分支；只有目标视觉节点确实更接近
 // 参考弯曲侧时才保留该分支，避免把 mapping 的局部轴约定误报成 keypose 失败。
 for(const role of Object.keys(limbNodes)){
  const metric=comparison.metrics.find((m:any)=>m.id===`${role}.bendSide`);
  if(!metric||metric.status==='pass'||!draft.pose.frame.bendDirections?.[role])continue;
  const candidate=structuredClone(draft.pose);
  candidate.frame.bendDirections[role]=-candidate.frame.bendDirections[role];
  try{
   const trial=solve(candidate),trialActual=runtimeGraph(trial.skeleton,v.rig,v.mapping,candidate),trialComparison=compareGraphs(r.observation,trialActual,a.correspondence,{retargetMode});
   const trialMetric=trialComparison.metrics.find((m:any)=>m.id===`${role}.bendSide`);
   if(trialMetric?.status==='pass'){
    draft.pose.frame=candidate.frame;solved=trial;actual=trialActual;comparison=trialComparison;
   }
  }catch{ /* 保留原分支及其诊断，不吞掉主求解结果。 */ }
 }
 draft.pose.frame=solved.frame;draft.pose.solution={bones:solved.bones,...solved.report};draft.pose.status=solved.report.ok?'solved':'failed';
 const changes={coordinateSystem:'normalizedSkeleton',body:Object.fromEntries(['x','y','rotate'].map(k=>[k,solved.frame.body[k as 'x']-base.frame.body[k]])),targets:Object.fromEntries(Object.entries(solved.frame.targets).map(([key,t]:any)=>[key,Object.fromEntries(['x','y','angle'].map(k=>[k,(t[k]??0)-(base.frame.targets[key]?.[k]??0)]))])),bendDirections:{before:base.frame.bendDirections??v.mapping.bones.bendDirections,after:solved.frame.bendDirections}};
 if(!comparison.ok)conflicts.push(...comparison.metrics.filter(m=>m.blocking&&m.status!=='pass').map(m=>`${m.id}: ${m.status}`));if(!solved.report.ok)conflicts.push(...solved.report.issues);
  const reachabilityFailures=(solved.unreachable??[]).map((entry:any)=>({
    role:entry.role,
    time:entry.time,
    error:entry.error??null,
    distance:entry.distance??null,
    minReach:entry.minReach??null,
    maxReach:entry.maxReach??null,
    tolerance:entry.tolerance??null,
    meaningful:entry.error===undefined||entry.tolerance===undefined?true:entry.error>entry.tolerance,
  }));
  const adaptation=adaptationSummary(comparison.metrics,retargetMode,conflicts);
  const semanticFailureDetails=comparison.metrics.filter((m:any)=>m.constraintTier==='semanticHard'&&m.status!=='pass').map((m:any)=>({id:m.id,referenceValue:m.referenceValue??m.reference,targetValue:m.targetValue??m.target,residual:m.residual??m.error,status:m.status,blocking:m.blocking,nodes:m.nodes}));
  const failureSummary={
    semanticFailures:[...new Set([...(adaptation.semanticFailures??[]),...comparison.metrics.filter((m:any)=>m.constraintTier==='semanticHard'&&m.status!=='pass').map((m:any)=>m.id),...conflicts.filter((value:string)=>!value.includes('不可达')).map((value:string)=>value.replace(/: (fail|unverifiable)$/,''))])],
    reachabilityFailures:reachabilityFailures.length?reachabilityFailures:(conflicts.filter((value:string)=>value.includes('不可达')).map((reason:string)=>({reason,meaningful:true}))),
    semanticFailureDetails,
    structuralResiduals:adaptation.structuralResiduals??{},
    styleResiduals:adaptation.styleResiduals??{},
  };
  draft.pose.adaptation={...draft.pose.adaptation,retargetMode,...adaptation,...failureSummary,expected,conflicts,contactResiduals,contactProjections,localProjections,branchAdjustments:solved.branchAdjustments??[],policyFingerprint,method:'参考动作意图按目标角色躯干轴与校准链长重建；adaptive 只阻断语义硬约束，strict 保留完整结构门禁。'};
  return {draft,solved,actual,comparison,changes,contactResiduals,contactProjections,conflicts,expected,retargetMode,adaptation:{...adaptation,...failureSummary,localProjections},failureSummary};
}
