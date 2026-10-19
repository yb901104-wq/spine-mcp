// 右手挥击完整诊断：使用实际 MCP，保留失败门禁，不修改原角色。
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {characterFingerprint} from '../dist/poseWorkflow.js';
import {semanticAt,solveSemanticPose} from '../dist/retargetEngine.js';
const root='D:/AI_cc/spine test',base='previews/pose-workflow-20261009',corrected='previews/attack-keypose-correction-20261009';
const dir=`previews/right-attack-full-${new Date().toISOString().replaceAll(':','-')}`;
const read=async p=>JSON.parse(await fs.readFile(`${root}/${p}`,'utf8'));
const save=async(p,v)=>fs.writeFile(`${root}/${p}`,JSON.stringify(v,null,2));
await fs.mkdir(`${root}/${dir}/calls`,{recursive:true});
await fs.writeFile(`${root}/previews/latest-right-attack-full-path.txt`,dir);
const files=['目标/npc1.json','目标/npc1.atlas','目标/npc1.png'];
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await fs.readFile(`${root}/${p}`)).digest('hex')])));
const before=await hashes();
const client=new Client({name:'Codex-right-attack-full-diagnostic',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
let seq=0;async function call(name,args){const result=await client.callTool({name,arguments:args});await save(`${dir}/calls/${++seq}-${name}.json`,{args,result});if(result.isError)throw Error(result.content[0].text);return JSON.parse(result.content[0].text);}
try{
 const readyPath='previews/pose-instance-2026-10-09T09-06-56-129Z/ready.refined.pose.json';
 const upPath=corrected+'/right-up-swing.presentation.pose.json',downPath=corrected+'/right-down-swing.presentation.pose.json',thrustPath=corrected+'/right-thrust-turn.presentation.pose.json';
 const source=await characterFingerprint('目标/npc1.json',base+'/npc1.mapping.json',{workspaceRoot:root});
 const scale=source.mapping.calibration.scale,origin=source.mapping.calibration.origin;
 const shoulder=(frame,side)=>{const p=solveSemanticPose(source.rt,source.mapping,frame,0).skeleton.findBone(source.mapping.bones[side+'Arm'][0]);return [(p.worldX-origin[0])/scale,(p.worldY-origin[1])/scale];};
 const entries=[['ready',0,readyPath,.53],['up',.24,upPath,.49],['down-start',.48,downPath,.53],['down',.72,downPath,.52],['anticipation-start',.78,downPath,.51],['anticipation',.84,downPath,.50],['thrust',.90,thrustPath,.49],['hold',1.35,thrustPath,.49],['recover',1.48,thrustPath,.53],['rest',1.60,readyPath,.53],['end',3.6,readyPath,.53]];
 const keys=[],frames=[],reports=[],previousAngles={};
 for(const [id,time,sourcePath,y]of entries){const pose=await read(sourcePath),frame=structuredClone(pose.frame),dy=y-frame.body.y;
  frame.time=time;frame.body.y=y;frame.action={driver:'rightHand'};
  // 目标前腿/后腿保持固定骨骼身份；这一修订不重新批准参考腿部身份。
  frame.targets.leftFoot={x:.63,y:0,angle:-15.46,contact:true};
  frame.targets.rightFoot={x:-.38,y:0,angle:-32.8296,contact:true};
  frame.bendDirections.leftLeg=-1;frame.bendDirections.rightLeg=-1;
  frame.bendDirections.leftArm=-1;frame.bendDirections.rightArm=-1;
  for(const side of ['left','right'])frame.targets[side+'Hand'].y+=dy;
  if(id==='down-start'){frame.targets.rightHand={x:-.80,y:2.40,angle:140};frame.targets.leftHand={x:.50,y:1.70,angle:-85};frame.body.rotate=5;}
  if(id==='anticipation-start'){frame.targets.rightHand={x:-.85,y:2.15,angle:125};frame.targets.leftHand={x:.40,y:1.75,angle:-85};frame.body.rotate=5;}
  if(id==='anticipation'){frame.targets.rightHand={x:.20,y:1.90,angle:30};frame.targets.leftHand={x:-.30,y:1.70,angle:150};frame.body.rotate=0;}
  if(id==='recover'){frame.targets.rightHand={x:.40,y:1.85,angle:20};frame.targets.leftHand={x:-.40,y:1.80,angle:150};frame.body.rotate=-3;}
  for(const side of ['left','right']){const role=side+'Hand',s=shoulder(frame,side),t=frame.targets[role],dx=t.x-s[0],dy=t.y-s[1],r=Math.hypot(dx,dy),lengths=source.mapping.calibration.lengths[side+'Arm'];const max=(lengths[0]+lengths[1]-1)/scale;if(r>max){t.x=s[0]+dx*max/r;t.y=s[1]+dy*max/r;}if(previousAngles[role]!==undefined){while(t.angle-previousAngles[role]>180)t.angle-=360;while(t.angle-previousAngles[role]<-180)t.angle+=360;}previousAngles[role]=t.angle;}
  const posePath=`${dir}/${id}.pose.json`;
  await call('spine_adjust_pose',{posePath:sourcePath,outputPosePath:posePath,patch:{frame},dryRun:false});
  const solved=await call('spine_solve_pose',{posePath,dryRun:false});
  let comparison;try{comparison=await call('spine_compare_pose_graphs',{posePath,dryRun:false});}catch(e){comparison={ok:false,message:String(e)};}
  keys.push({stageId:id,time,posePath});frames.push((await read(posePath)).frame);
  reports.push({id,time,solveOk:solved.ok,compareOk:comparison.ok,errors:solved.solution?.errors??solved.errors});
  console.log(id,solved.ok,comparison.ok);
 }
 const motion={version:2,name:'right-up-down-thrust-diagnostic',duration:3.6,loop:false,coordinateSystem:'normalizedSkeleton',groundY:0,frames,poseWorkflow:{standardPosePath:base+'/standing.pose.json',keyPoses:keys}};
 // 在肩部坐标中沿弧线制作手腕轨迹，避免直线补间穿过两段 IK 内侧不可达圆。
 // 中间语义采样只用于求解；最终 Spine 时间线仍由曲线拟合压缩。
 const sampled=[];
 for(let i=0;i<frames.length-1;i++){const a=frames[i],b=frames[i+1];sampled.push(a);const count=Math.ceil((b.time-a.time)/(a.time>=.78&&b.time<=.90?.0025:.025));
  for(let j=1;j<count;j++){const u=j/count,t=a.time+(b.time-a.time)*u,f=semanticAt(motion,t);
   for(const side of ['left','right']){const role=side+'Hand',sa=shoulder(a,side),sb=shoulder(b,side),sm=shoulder(f,side);const ax=a.targets[role].x-sa[0],ay=a.targets[role].y-sa[1],bx=b.targets[role].x-sb[0],by=b.targets[role].y-sb[1];let da=Math.atan2(by,bx)-Math.atan2(ay,ax);while(da>Math.PI)da-=2*Math.PI;while(da< -Math.PI)da+=2*Math.PI;const theta=Math.atan2(ay,ax)+da*u,len=source.mapping.calibration.lengths[side+'Arm'];const radius=Math.max(Math.abs(len[0]-len[1])/scale+.015,Math.min((len[0]+len[1])/scale-.004,Math.hypot(ax,ay)*(1-u)+Math.hypot(bx,by)*u));f.targets[role].x=sm[0]+radius*Math.cos(theta);f.targets[role].y=sm[1]+radius*Math.sin(theta);}
   sampled.push(f);
  }
 }sampled.push(frames.at(-1));motion.frames=sampled;
 await save(dir+'/attack.draft.motion.json',motion);await save(dir+'/stage-results.json',reports);
 const result=await call('spine_retarget_motion',{filePath:'目标/npc1.json',mappingPath:base+'/npc1.mapping.json',motionPath:dir+'/attack.draft.motion.json',animation:'attack_right_turn_diagnostic',diagnosticPreview:true,dryRun:true,preview:false,rotationTolerance:.04,translationTolerance:.01,footContactTolerance:.15,handTolerance:.35,vertexTolerance:1.2});
 await save(dir+'/animation-result.json',result);
 if(result.animationPreview?.gifPath&&result.posePreview){const comparison=await call('spine_render_animation_comparison',{targetManifestPath:result.animationPreview.manifestPath,referenceManifestPath:base+'/reference-frames/reference-manifest.json',poseManifestPath:result.posePreview.manifestPath,phaseMap:[{targetTime:0,referenceTime:0},{targetTime:3.6,referenceTime:3.6}],outputDir:dir+'/comparison'});await save(dir+'/comparison.json',comparison);await fs.copyFile(`${root}/${comparison.gifPath}`,`${root}/${dir}/参考与目标同步.gif`);await fs.copyFile(`${root}/${result.animationPreview.gifPath}`,`${root}/${dir}/目标原速.gif`);}
 const sheet=await call('spine_render_contact_sheet',{filePath:result.candidatePath,atlasPath:'目标/npc1.atlas',animation:'attack_right_turn_diagnostic',times:[0,.12,.24,.48,.72,.84,.9,1.35,1.48,1.6,2.6,3.6],frames:12,columns:6,outputDir:dir+'/actual-animation-sheet'});await save(dir+'/actual-animation-sheet.json',sheet);
 const after=await hashes();await save(dir+'/验收报告.json',{before,after,originalUnchanged:JSON.stringify(before)===JSON.stringify(after),diagnosticOnly:true,numericOk:result.numericOk,issues:result.motionValidation?.issues,poseGate:result.poseGate,keyGraphs:result.keyGraphs,previewIssues:result.previewIssues,candidatePath:result.candidatePath,notes:['右手骨骼身份固定为 ys；上挥、下挥及突刺使用修订参考。','脚目标改为水平地面并固定分腿，参考腿部解剖身份尚未完全校准，保留关系失败。','蓄力和收势为相邻已标注姿态间的制作调整，不声称新增参考点已确认。','转身使用现有切片显隐与背包层序近似，无完整背面躯干。','未通过 Agent 视觉与编辑器验收；无提交令牌，原角色未写入。']});
 console.log(JSON.stringify({dir,candidatePath:result.candidatePath,numericOk:result.numericOk,issues:result.motionValidation?.issues,previewIssues:result.previewIssues,sheet},null,2));
}finally{await client.close();}
