// 参考适配的纯计算内核：输入标注、绑定、已确认标准姿态及已加载角色，不读写文件。
import { solvePoseKernel } from './animationKernel.js';
import { forkMotionRuntime } from './motionRuntime.js';
import { readVisualNodes } from './visualRig.js';
import { runtimeGraph } from './referenceRetarget.js';
import { normalizedGraph,torsoAxis,distance,direction,finitePoint,limbNodes,normalizeImagePoints,angleError,compareGraphs,policyFingerprint } from './poseGraph.js';
export function retargetReferencePoseKernel(a:any,prepared:any){
 const {reference:r,visual:v,base,source}=prepared;
 const solve=(pose:any)=>solvePoseKernel(pose,{...source,rt:forkMotionRuntime(source.rt)},pose.visualRigPath?(sk:any)=>readVisualNodes(sk,v.rig):undefined);
 let s=solve(base);const ref=normalizedGraph(r.observation.points,r.observation.facing,true),scale=v.mapping.calibration!.scale,origin=v.mapping.calibration!.origin!,targetFacing=a.facing??base.facing;
 const frame=structuredClone(base.frame),expected:any={},conflicts:string[]=[];frame.time=a.time??r.observation.time;frame.bendDirections={...frame.bendDirections};
 if(r.observation.actionSemantics){const anatomical=r.observation.actionSemantics.weaponHand,side=v.rig.anatomicalSides?.[anatomical];frame.action={driver:side?`${side}Hand`:null};if(!side)conflicts.push('未校准解剖持杖手到目标链的绑定。');}
 const calibrationNodes=readVisualNodes(s.skeleton,v.rig).points;
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
 for(const [role,n]of Object.entries(limbNodes)){
  const side=role.startsWith('left')?'left':'right',rs=a.correspondence[side],rn=n.map(k=>rs+k.slice(side.length));
  if(!rn.every(k=>finitePoint(ref[k]))){conflicts.push(`${role} 必要参考节点未知。`);continue;}
  const lengths=v.mapping.calibration!.lengths![role as 'leftArm'];const start=initial[n[0]],factor=targetFacing==='left'?-1:1;
  const u=direction(ref[rn[0]],ref[rn[1]])*Math.PI/180,l=direction(ref[rn[1]],ref[rn[2]])*Math.PI/180;
  expected[n[0]]=start;expected[n[1]]={x:start.x+factor*lengths[0]*Math.cos(u),y:start.y+lengths[0]*Math.sin(u)};expected[n[2]]={x:expected[n[1]].x+factor*lengths[1]*Math.cos(l),y:expected[n[1]].y+lengths[1]*Math.sin(l)};
  const cross=(ref[rn[1]].x-ref[rn[0]].x)*(ref[rn[2]].y-ref[rn[1]].y)-(ref[rn[1]].y-ref[rn[0]].y)*(ref[rn[2]].x-ref[rn[1]].x);frame.bendDirections[role]=cross*factor>=0?-1:1;
 }
 // 根据参考腿段同时计算两脚和身体高度；不可继承并腿准备姿态。
 const contacts=['left','right'].filter(side=>r.observation.support?.[a.correspondence[side]]===true);
 if(!contacts.length)conflicts.push('缺少明确支撑关系；第一版需至少一只支撑脚。');
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
 // 保留主支撑脚的候选高度，另一侧差值必须明确报告并交联合求解，不取平均掩盖。
 const dy=deltas.length&&deltas.every(Number.isFinite)?deltas[0]:0;
 const contactResiduals=contacts.map((side,i)=>({side,requiredHeight:deltas[i],residual:deltas[i]-dy}));
 if(contactResiduals.some(v=>Math.abs(v.residual)>.15))conflicts.push('两脚接地高度要求冲突，需联合修正；未采用平均高度。');
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
 const draft={pose:{version:1,id:a.id,kind:'action',facing:a.facing??base.facing,status:'draft',filePath:v.rig.filePath,mappingPath:v.rig.mappingPath,standardPosePath:a.standardPosePath,sourceFingerprint:v.fingerprint,frame:structuredClone(frame),groundY:base.groundY??0,weapon:a.weapon??null,referencePosePath:a.referencePosePath,reference:structuredClone(r.observation),policy:{kneeFlexionMax:30,reason:''},visualRigPath:a.visualRigPath,correspondence:a.correspondence,...a.sequencePath?{sequencePath:a.sequencePath,stageId:a.stageId}:{}} as any};
 draft.pose.adaptation={expected,conflicts,contactResiduals,policyFingerprint,method:'参考两段方向与目标链长；躯干轴独立；双脚接地残差分别报告。'};
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
 const solved=solve(draft.pose);draft.pose.frame=solved.frame;draft.pose.solution={bones:solved.bones,...solved.report};draft.pose.status=solved.report.ok?'solved':'failed';
 const actual=runtimeGraph(solved.skeleton,v.rig,v.mapping,draft.pose),comparison=compareGraphs(r.observation,actual,a.correspondence);
 const changes={coordinateSystem:'normalizedSkeleton',body:Object.fromEntries(['x','y','rotate'].map(k=>[k,solved.frame.body[k as 'x']-base.frame.body[k]])),targets:Object.fromEntries(Object.entries(solved.frame.targets).map(([key,t]:any)=>[key,Object.fromEntries(['x','y','angle'].map(k=>[k,(t[k]??0)-(base.frame.targets[key]?.[k]??0)]))])),bendDirections:{before:base.frame.bendDirections??v.mapping.bones.bendDirections,after:solved.frame.bendDirections}};
 if(!comparison.ok)conflicts.push(...comparison.metrics.filter(m=>m.required&&m.status!=='pass').map(m=>`${m.id}: ${m.status}`));if(!solved.report.ok)conflicts.push(...solved.report.issues);
 return {draft,solved,actual,comparison,changes,contactResiduals,conflicts,expected};
}
