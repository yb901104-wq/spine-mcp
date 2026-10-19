// 实际 MCP 完整动画诊断实例；不批准姿态、不获取提交令牌、不修改原角色。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root='D:/AI_cc/spine test',base='previews/pose-workflow-20261009';
const previous=(await fs.readFile(root+'/previews/latest-pose-instance-path.txt','utf8')).trim().replaceAll('\\','/');
const dir=process.env.ANIMATION_DIAGNOSTIC_DIR??`previews/attack-diagnostic-${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}`;
await fs.mkdir(root+'/'+dir+'/calls',{recursive:true});
await fs.writeFile(root+'/previews/latest-animation-diagnostic-path.txt',dir);
const read=async p=>JSON.parse(await fs.readFile(root+'/'+p,'utf8'));
const save=async(p,v)=>fs.writeFile(root+'/'+p,JSON.stringify(v,null,2));
const specs=[['ready',0,previous+'/ready.reference.json'],['sweep',.06,base+'/reference-skeleton/sweep.reference-pose.json'],['sweep-hold',.24,'previews/npc1-attack-retest-20261009/references/sweep-hold.json'],['reverse',.48,base+'/reference-skeleton/reverse.reference-pose.json'],['lift',.72,base+'/reference-skeleton/lift.reference-pose.json'],['thrust',.9,base+'/reference-skeleton/thrust.reference-pose.json'],['thrust-hold',1.35,'previews/npc1-attack-retest-20261009/references/thrust-hold.json'],['recover',1.48,'previews/npc1-attack-retest-20261009/references/recover.json'],['rest',1.6,base+'/reference-skeleton/rest.reference-pose.json'],['end',3.6,base+'/reference-skeleton/rest.reference-pose.json']];
const client=new Client({name:'Codex-full-animation-diagnostic',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
let sequence=0;async function call(name,args){const result=await client.callTool({name,arguments:args});await save(`${dir}/calls/${Date.now()}-${++sequence}-${name}.json`,{args,result});if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);}
try {
 const mode=process.argv[2];
 if(mode==='references') {
  const hashes={};for(const p of ['目标/npc1.json','目标/npc1.atlas','目标/npc1.png'])hashes[p]=createHash('sha256').update(await fs.readFile(root+'/'+p)).digest('hex');await save(dir+'/input-hashes.json',hashes);
  await fs.mkdir(root+'/'+dir+'/references',{recursive:true});
  for(const [id,time,p]of specs){const observation=structuredClone((await read(p)).observation);observation.time=time;observation.support={left:true,right:true};if(id==='end')observation.imagePath=base+'/reference-frames/frame-0033.png';
   observation.basis+='；完整诊断实例：地面可见两脚支撑，节点延用带不确定性人工标注。';
   await call('spine_create_reference_pose',{referencePosePath:`${dir}/references/${id}.json`,id,observation,dryRun:false});}
  console.log(await call('spine_render_reference_pose_sheet',{referencePosePaths:specs.map(([id])=>`${dir}/references/${id}.json`),outputDir:dir+'/reference-sheet'}));
 } else if(mode==='animate') {
  const reasons=await read(dir+'/reference-review-reasons.json');
  for(const [id]of specs)await call('spine_review_reference_pose',{referencePosePath:`${dir}/references/${id}.json`,manifestPath:dir+'/reference-sheet/reference-pose-sheet.json',decision:'approved',reviewedBy:'Agent reference inspection',reason:reasons[id],checks:['jointLocations','visibility','connections','facing','support','uncertainty'],dryRun:false});
  const rig=await read(previous+'/npc1.visual-rig.json'),mapping=await read(base+'/npc1.mapping.json'),initial=await read(previous+'/ready.refined.pose.json');
  const correspondence=initial.correspondence,keys=[],states=[];const scale=mapping.calibration.scale;
  const r0=(await read(dir+'/references/ready.json')).observation.points;
  const avgLeg=p=>['left','right'].reduce((total,s)=>total+Math.hypot(p[s+'Hip'].x-p[s+'Knee'].x,p[s+'Hip'].y-p[s+'Knee'].y)+Math.hypot(p[s+'Knee'].x-p[s+'Ankle'].x,p[s+'Knee'].y-p[s+'Ankle'].y),0)/2;
  const targetLeg=(mapping.calibration.lengths.leftLeg.reduce((a,b)=>a+b)+mapping.calibration.lengths.rightLeg.reduce((a,b)=>a+b))/2;
  for(const [id,time]of specs){const rawPath=`${dir}/${id}.generated.pose.json`,posePath=`${dir}/${id}.pose.json`;
   const retarget=await call('spine_retarget_reference_pose',{standardPosePath:base+'/standing.pose.json',referencePosePath:`${dir}/references/${id}.json`,visualRigPath:previous+'/npc1.visual-rig.json',correspondence,posePath:rawPath,id,time,dryRun:false});
   const raw=await read(rawPath),points=(await read(dir+'/references/'+id+'.json')).observation.points;
   const shift=(((points.leftHip.x+points.rightHip.x)-(r0.leftHip.x+r0.rightHip.x))/2)*targetLeg/avgLeg(r0)/scale;
   const targets={};for(const [k,v]of Object.entries(raw.frame.targets))targets[k]={...v,x:v.x+shift};
   const frame={body:{x:raw.frame.body.x+shift},targets};
   // 初始帧使用上一轮已求解修订；仍保留未通过视觉的状态，不作批准。
   if(id==='ready')Object.assign(frame,structuredClone(initial.frame),{time});
   else {
    // 手掌随参考前臂方向，避免继续继承标准站姿掌向。
    for(const side of ['left','right']){const rs=correspondence[side],e=points[rs+'Elbow'],w=points[rs+'Wrist'];frame.targets[side+'Hand'].angle=Math.atan2(-(w.y-e.y),w.x-e.x)*180/Math.PI;}
   }
   await call('spine_adjust_pose',{posePath:rawPath,outputPosePath:posePath,patch:{frame},dryRun:false});
   const solved=await call('spine_solve_pose',{posePath,dryRun:false});const comparison=await call('spine_compare_pose_graphs',{posePath,dryRun:false});
   keys.push({stageId:id,time,posePath});states.push({stageId:id,retargetOk:retarget.ok,solveOk:solved.ok,compareOk:comparison.ok,conflicts:retarget.conflicts});
   console.log(id,JSON.stringify(states.at(-1)));
  }
  await save(dir+'/keys.json',keys);await save(dir+'/stage-results.json',states);
  // 工作流草稿，未调用要求确认的 motion 构建器，也不声称是已确认动作。
  const frames=[];for(const k of keys)frames.push({...structuredClone((await read(k.posePath)).frame),time:k.time});
  const motion={version:2,name:'attack-full-diagnostic',duration:3.6,loop:false,coordinateSystem:'normalizedSkeleton',groundY:initial.groundY,frames,poseWorkflow:{standardPosePath:base+'/standing.pose.json',keyPoses:keys}};
  await save(dir+'/attack.draft.motion.json',motion);
  const result=await call('spine_retarget_motion',{filePath:'目标/npc1.json',mappingPath:base+'/npc1.mapping.json',motionPath:dir+'/attack.draft.motion.json',animation:'attack_full_diagnostic',diagnosticPreview:true,dryRun:true,preview:false,rotationTolerance:.3,translationTolerance:.07,footContactTolerance:.15,handTolerance:.35,vertexTolerance:1.2});
  await save(dir+'/animation-result.json',result);console.log(JSON.stringify({dir,numericOk:result.numericOk,issues:result.motionValidation.issues,previewIssues:result.previewIssues,gif:result.animationPreview?.gifPath,candidatePath:result.candidatePath}));
  if(result.posePreview&&result.animationPreview?.gifPath){const cmp=await call('spine_render_animation_comparison',{targetManifestPath:result.animationPreview.manifestPath,referenceManifestPath:base+'/reference-frames/reference-manifest.json',poseManifestPath:result.posePreview.manifestPath,phaseMap:[{targetTime:0,referenceTime:0},{targetTime:3.6,referenceTime:3.6}],outputDir:dir+'/comparison'});await save(dir+'/comparison.json',cmp);console.log(cmp.gifPath);}
  const selected=keys.filter(k=>['ready','sweep','reverse','lift','thrust','rest'].includes(k.stageId));console.log(await call('spine_render_pose_comparison',{posePaths:selected.map(k=>k.posePath),stageIds:selected.map(k=>k.stageId),targetTimes:selected.map(k=>k.time),outputDir:dir+'/six-stages'}));
 }
 console.log('实例目录：'+dir);
} finally {await client.close();}
