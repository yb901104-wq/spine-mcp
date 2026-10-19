// npc1 准备姿态实例：先出参考与绑定图，Agent 看图后提供审查理由，再执行求解。
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {referenceFingerprint} from '../dist/referencePose.js';
import {visualRigFingerprint} from '../dist/visualRig.js';
const root='D:/AI_cc/spine test',base='previews/pose-workflow-20261009',previous='previews/attack-keypose-correction-20261009';
const mode=process.argv[2],dir=mode==='prepare'?`previews/ready-refinement-${new Date().toISOString().replaceAll(':','-')}`:(await fs.readFile(root+'/previews/latest-ready-refinement-path.txt','utf8')).trim();
await fs.mkdir(`${root}/${dir}/calls`,{recursive:true});if(mode==='prepare')await fs.writeFile(root+'/previews/latest-ready-refinement-path.txt',dir);
const read=async p=>JSON.parse(await fs.readFile(`${root}/${p}`,'utf8'));
const save=async(p,v)=>fs.writeFile(`${root}/${p}`,JSON.stringify(v,null,2));
const files=['目标/npc1.json','目标/npc1.atlas','目标/npc1.png'];const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await fs.readFile(root+'/'+p)).digest('hex')])));
const client=new Client({name:'ready-refinement-acceptance',version:'1.0'});await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
let seq=0;async function call(name,args){const result=await client.callTool({name,arguments:args});await save(`${dir}/calls/${mode}-${++seq}-${name}.json`,{args,result});if(result.isError)throw Error(result.content[0].text);const value=JSON.parse(result.content[0].text);console.log(name,JSON.stringify({ok:value.ok,posePath:value.posePath,issues:value.issues,pages:value.pages,reportPath:value.reportPath,conflicts:value.conflicts}));return value;}
const names=['ready','up','down','thrust'];
try{
 if(mode==='prepare'){
  await save(dir+'/input-hashes.json',await hashes());const old=await read(previous+'/npc1.action-rig.json'),nodes=structuredClone(old.nodes);
  for(const [key,node]of Object.entries(nodes)){node.basis+='；本轮复核切片分解与关节叠加：保留接缝锚点及遮挡不确定性；不靠偏移迎合参考。';}
  await call('spine_calibrate_visual_rig',{filePath:'目标/npc1.json',mappingPath:base+'/npc1.mapping.json',visualRigPath:dir+'/npc1.visual-rig.json',nodes,segments:old.segments,anatomicalSides:old.anatomicalSides,viewProfiles:old.viewProfiles,outputDir:dir+'/calibration',dryRun:false});
  for(const id of names){const source=id==='ready'?'previews/pose-instance-2026-10-09T09-06-56-129Z/ready.reference.json':previous+`/right-${id==='up'?'up-swing':id==='down'?'down-swing':'thrust-turn'}.v2.reference.json`;const o=structuredClone((await read(source)).observation);
   // 准备帧旧标签按画面左右；上下挥的手臂已按用户右手身份修订，腿标签尚未修订。
   for(const part of id==='ready'?['Shoulder','Elbow','Wrist','Hip','Knee','Ankle']:['Hip','Knee','Ankle']){const l=o.points['left'+part];o.points['left'+part]=o.points['right'+part];o.points['right'+part]=l;}
   if(id==='ready'&&o.grip){const l=o.grip.points.left;o.grip.points.left=o.grip.points.right;o.grip.points.right=l;}
   o.anatomicalIdentity={status:'confirmed',basis:'按用户确认右手持杖，准备帧后侧低位手对应右手；跟踪袖口及分腿投影，后侧腿标为右、前侧为左。遮挡关节仍为估计，置信度不提高。'};
   if(id==='ready')o.actionSemantics={version:1,weaponHand:'right',identityStatus:'confirmed',anatomicalBasis:'用户确认右手持杖；准备阶段按袖口—肘—后侧低位握持手连续跟踪。',bodyView:'frontThreeQuarter',bodyViewBasis:'脸和正面胸衣可见，身体为前斜侧。',occlusion:[{front:'rightArm.1',back:'body',basis:'后侧低位右前臂在主体左下轮廓外可见；目标仍需回读层序。'}]};
   o.basis+='；重新统一解剖标签，旧交换对应不沿用；手、髋遮挡坐标保留原有估计不确定性。';
   await call('spine_create_reference_pose',{referencePosePath:dir+`/${id}.reference.json`,id,observation:o,dryRun:false});
  }
  await call('spine_render_reference_pose_sheet',{referencePosePaths:names.map(id=>dir+`/${id}.reference.json`),outputDir:dir+'/reference-sheet'});
 }else if(mode==='solve'){
  const reasons=await read(dir+'/review-reasons.json');
  await call('spine_review_visual_rig',{visualRigPath:dir+'/npc1.visual-rig.json',decision:'approved',reviewedBy:'Agent 静态绑定复核',reason:reasons.rig,dryRun:false});
  for(const id of names)await call('spine_review_reference_pose',{referencePosePath:dir+`/${id}.reference.json`,manifestPath:dir+'/reference-sheet/reference-pose-sheet.json',decision:reasons[id].decision,reviewedBy:'Agent 参考身份复核',reason:reasons[id].reason,checks:['jointLocations','visibility','connections','facing','support','uncertainty'],dryRun:false});
  const rig=await read(dir+'/npc1.visual-rig.json'),correspondence={left:'left',right:'right',basis:'统一后的解剖身份同侧对应，全阶段不按画面位置交换。',anatomicalIdentity:'目标 ys 右臂、zs 左臂；yt 后侧右腿、zt 前侧左腿；参考重标注保持同侧。',projectedOrder:'准备帧右侧肢体投影后侧；转身时投影允许变化，解剖身份不变化。'};
  const stages=[];for(const id of names){const ref=await read(dir+`/${id}.reference.json`);stages.push({stageId:id,referencePosePath:dir+`/${id}.reference.json`,referenceFingerprint:referenceFingerprint(ref)});}
  await save(dir+'/attack.sequence.json',{version:1,id:'npc1-right-staff',basis:'此次只验收初始准备；其余阶段用于身份一致性和能力检测。',confirmedBy:'Agent 根据用户右手纠正与逐帧参考复核',confirmedAt:new Date().toISOString(),correspondence,weaponHand:'right',visualRigPath:dir+'/npc1.visual-rig.json',visualRigFingerprint:visualRigFingerprint(rig),stages});
  const sequence=await call('spine_validate_pose_sequence',{sequencePath:dir+'/attack.sequence.json',dryRun:false});await save(dir+'/sequence-result.json',sequence);
  const legacy='previews/pose-instance-2026-10-09T09-06-56-129Z/ready.refined.pose.json';
  // 只更新参考和绑定关联，不修改旧帧数值，作为公平的修正前负例。
  await call('spine_adjust_pose',{posePath:legacy,outputPosePath:dir+'/before.pose.json',patch:{referencePosePath:dir+'/ready.reference.json',visualRigPath:dir+'/npc1.visual-rig.json',sequencePath:dir+'/attack.sequence.json',stageId:'ready'},dryRun:false});await call('spine_solve_pose',{posePath:dir+'/before.pose.json',dryRun:false});
  const mixed=await call('spine_validate_pose_sequence',{sequencePath:dir+'/attack.sequence.json',posePaths:[dir+'/before.pose.json'],dryRun:false,reportPath:dir+'/mixed-correspondence.validation.json'});await save(dir+'/mixed-result.json',mixed);
  const result=await call('spine_retarget_reference_pose',{referencePosePath:dir+'/ready.reference.json',visualRigPath:dir+'/npc1.visual-rig.json',standardPosePath:base+'/standing.pose.json',posePath:dir+'/ready.pose.json',sequencePath:dir+'/attack.sequence.json',stageId:'ready',dryRun:false});await save(dir+'/retarget-result.json',result);
  const posePath=result.posePath??dir+'/ready.pose.json';
  const comparison=await call('spine_compare_pose_graphs',{posePath,dryRun:false});await save(dir+'/comparison-result.json',comparison);
  const sheet=await call('spine_render_pose_comparison',{posePaths:[dir+'/before.pose.json',result.seedPath??posePath,posePath],stageIds:['legacy-before','direction-seed','joint-refined'],outputDir:dir+'/before-after'});await save(dir+'/sheet-result.json',sheet);
  await save(dir+'/验收状态.json',{numeric: (await read(posePath)).solution.ok,relations:comparison.ok,sequence:sequence.ok,agentVisual:'pending',editorImport:'notPerformed',before:await read(dir+'/input-hashes.json'),after:await hashes(),posePath});
 }else if(mode==='finalize'){
  const review=await read(dir+'/final-review.json'),posePath=review.posePath,comparison=await call('spine_compare_pose_graphs',{posePath,dryRun:false});
  const sheet=await call('spine_render_pose_comparison',{posePaths:[dir+'/before.pose.json',posePath],stageIds:['legacy-before','ready-refined'],outputDir:dir+'/final-comparison',width:420,height:420});
  await call('spine_review_pose',{posePath,comparisonPath:comparison.reportPath,manifestPath:sheet.manifestPath,decision:review.decision,reviewedBy:'Agent 准备姿态独立视觉审查',reason:review.reason,stageId:'ready',checks:['standingOrAction','silhouette','jointDirections','support','grip','occlusion','referenceDifferences'],checkResults:review.checkResults,issues:review.issues??[],dryRun:false});
  const p=await read(posePath),frame=structuredClone(p.frame);await save(dir+'/ready.snapshot.motion.json',{version:2,name:'ready-snapshot',duration:1,loop:false,groundY:0,coordinateSystem:'normalizedSkeleton',frames:[{...frame,time:0},{...frame,time:1}],poseWorkflow:{standardPosePath:base+'/standing.pose.json',keyPoses:[{posePath,stageId:'ready',time:0}]}});
  const result=await call('spine_retarget_motion',{filePath:'目标/npc1.json',mappingPath:base+'/npc1.mapping.json',motionPath:dir+'/ready.snapshot.motion.json',animation:'npc1_ready_pose_diagnostic',diagnosticPreview:true,dryRun:true,preview:false});await save(dir+'/snapshot-result.json',result);
  const runtime=await call('spine_runtime_validate',{filePath:result.candidatePath,atlasPath:'目标/npc1.atlas',animation:'npc1_ready_pose_diagnostic'});await save(dir+'/snapshot-runtime.json',runtime);
  await fs.mkdir(root+'/'+dir+'/candidate',{recursive:true});await fs.copyFile(root+'/'+result.candidatePath,root+'/'+dir+'/candidate/npc1.json');for(const name of ['npc1.atlas','npc1.png'])await fs.copyFile(root+'/目标/'+name,root+'/'+dir+'/candidate/'+name);
  const before=await read(dir+'/input-hashes.json'),after=await hashes();await save(dir+'/验收状态.json',{numeric:p.solution.ok,relations:comparison.ok,agentVisual:review.decision,editorImport:'notPerformed',sequence:(await read(dir+'/sequence-result.json')).ok,originalUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after,posePath,candidatePath:dir+'/candidate/npc1.json',runtime,notes:['仅验收准备姿态适配，不宣称严格视觉复刻。','单姿态先独立求解与审查；导入副本用静态时间线表示，不重做完整攻击。','快照候选走诊断出口，保留完整动画门禁失败，不取得真实写入令牌。']});
 }
 console.log(dir);
}finally{await client.close();}
