import fs from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=process.env.SPINE_LEGACY_ROOT??'D:/AI_cc/spine test',dir='previews/pose-workflow-20261009',filePath='目标/npc1.json',mappingPath=dir+'/npc1.mapping.json',standardPosePath=dir+'/standing.pose.json';
const client=new Client({name:'Codex-pose-acceptance',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
await fs.mkdir(root+'/'+dir+'/calls',{recursive:true});
let index=Date.now();
async function call(name,args){const r=await client.callTool({name,arguments:args});await fs.writeFile(root+'/'+dir+`/calls/${index++}-${name}.json`,JSON.stringify({args,result:r},null,2));if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
const read=async p=>JSON.parse(await fs.readFile(root+'/'+p,'utf8'));
const checks=['standingOrAction','silhouette','jointDirections','support','grip','occlusion','referenceDifferences'];
const sc=47.736149493599534;
const mode=process.argv[2]??'prepare-standing';
try{
 if(mode==='prepare-standing'){
  await fs.copyFile(root+'/'+filePath,root+'/'+dir+'/before.json');await fs.copyFile('C:/Users/Administrator/AppData/Local/Temp/codex-clipboard-3108cdb1-e80f-4506-b015-1d53d6beadec.webp',root+'/'+dir+'/reference.webp');
  const m=await read('previews/npc1-attack/npc1.mapping.json');delete m.calibration;m.bones.anchors.leftHand.gripPoint=[6.23,.71];m.bones.anchors.rightHand.gripPoint=[10,2];m.notes='握持锚点按既有手部切片中心估计，需结合诊断图视觉检查。';
  await call('spine_create_mapping_draft',{filePath,mappingPath,mapping:m,dryRun:false});await call('spine_calibrate_mapping',{filePath,mappingPath,dryRun:false});await call('spine_confirm_mapping',{filePath,mappingPath,confirmedBy:'Codex：复核既有链、脚底及手部切片，握持点为图像中心估计',semanticChecks:['body','head','sides','chains','anchors','bendDirections','setupPose','followBones'],dryRun:false});
  const frame={time:0,body:{x:0,y:31.5/sc,rotate:0},head:0,channels:{torso:{rotate:-2,x:0,y:0},chest:{rotate:0,x:0,y:0}},targets:{leftFoot:{x:20/sc,y:0,angle:-15.46,contact:true},rightFoot:{x:12/sc,y:0,angle:-32.8296,contact:true},leftHand:{x:20/sc,y:66/sc,angle:-85},rightHand:{x:-20/sc,y:66/sc,angle:-90}}};
  await call('spine_create_pose_draft',{filePath,mappingPath,posePath:standardPosePath,id:'standing',kind:'standing',facing:'right',frame,dryRun:false});const stand=await call('spine_solve_pose',{posePath:standardPosePath,dryRun:false});console.log('standing',stand.report);
  const old=await read('previews/npc1-attack/attack.motion.json');await call('spine_create_pose_draft',{filePath,mappingPath,posePath:dir+'/crouch-negative.pose.json',id:'old-crouch-negative',kind:'standing',frame:old.frames[0],dryRun:false});const neg=await call('spine_solve_pose',{posePath:dir+'/crouch-negative.pose.json',dryRun:false});console.log('negative',neg.report);
  const sheet=await call('spine_render_pose_comparison',{posePaths:[standardPosePath,dir+'/crouch-negative.pose.json'],outputDir:dir+'/standing-comparison'});console.log(sheet.pages);
  const reference=await call('spine_analyze_reference_gif',{filePath:dir+'/reference.webp',outputDir:dir+'/reference-frames'});console.log('reference',reference.frames.length,reference.duration);
 }else if(mode==='confirm-standing'){
  console.log(await call('spine_review_pose',{posePath:standardPosePath,manifestPath:dir+'/standing-comparison/pose-comparison.json',decision:'approved',reviewedBy:'Codex',reason:'已查看干净图与诊断图：身体抬高、双腿接近伸直，双手自然垂下，脚底接地；此为正常站姿，旧蹲姿被拒绝。',checks,issues:[],dryRun:false}));
 }else if(mode==='prepare-poses'){
  const ref=await read(dir+'/reference-frames/reference-manifest.json');
  const phases=[['ready',0,0,30.5,0,18,94,25],['sweep',.06,2,29,-6,24,108,0],['sweep-hold',.24,2,29,-5,24,106,-5],['low-turn',.36,-1,28,4,16,83,-60],['reverse',.48,-2,29,5,12,100,-45],['lift',.72,-1,29,3,13,121,-75],['thrust',.90,5,28,-8,34,101,0],['thrust-hold',1.35,5,28,-8,34,101,0],['recover',1.48,0,29,3,13,105,-65],['rest',1.60,0,30.5,0,18,94,25],['end',3.60,0,30.5,0,18,94,25]];
  const keys=[];
  for(const [id,time,x,y,rot,wx,wy,angle]of phases){const posePath=`${dir}/${id}.pose.json`,image=ref.frames.filter(f=>f.time<=Math.min(time,3.599)).at(-1);
   const frame={time,body:{x:x/sc,y:y/sc,rotate:rot},head:-rot*.7,channels:{torso:{rotate:-2,x:0,y:0},chest:{rotate:-rot*.15,x:0,y:0}},targets:{leftHand:{angle:-90},rightHand:{angle:0}}};
   await call('spine_create_pose_draft',{filePath,mappingPath,posePath,id,kind:'action',standardPosePath,facing:'right',frame,weapon:{x:wx/sc,y:wy/sc,angle,grips:{left:8/sc,right:-8/sc}},reference:{imagePath:image.filePath,time,facing:'right',crop:[190,10,330,315],height:250,groundY:304,basis:'固定裁剪和地面按参考角色像素轮廓估计；遮挡关节不宣称为精确测量。',points:{leftShoulder:{visibility:'occluded'},rightShoulder:{visibility:'occluded'},leftHip:{visibility:'occluded'},rightHip:{visibility:'occluded'},rightWrist:{visibility:'visible',x:id.startsWith('thrust')?410:id==='lift'?345:350,y:id.startsWith('thrust')?145:id==='lift'?125:155,estimated:true},leftWrist:{visibility:'visible',x:id.startsWith('thrust')?365:330,y:id==='lift'?135:165,estimated:true}}},dryRun:false});
   const result=await call('spine_solve_pose',{posePath,dryRun:false});console.log(id,result.ok,result.report.issues);keys.push({stageId:id,time,posePath});
  }
  await fs.writeFile(root+'/'+dir+'/key-poses.json',JSON.stringify(keys,null,2));const r=await call('spine_render_pose_comparison',{posePaths:keys.map(k=>k.posePath),stageIds:keys.map(k=>k.stageId),targetTimes:keys.map(k=>k.time),outputDir:dir+'/keypose-comparison'});console.log(r.pages);
 }else if(mode==='refine-poses'){
  const old=await read(dir+'/key-poses.json'),keys=[];
  for(const k of old){if(['ready','rest','end'].includes(k.stageId)){keys.push(k);continue;}
   const id=k.stageId,posePath=`${dir}/${id}.v2.pose.json`;let patch={frame:{body:{y:27/sc},targets:{leftFoot:{x:32/sc,y:0,contact:true},rightFoot:{x:-15/sc,y:0,contact:true}}},weapon:{grips:{left:-8/sc,right:6/sc}}};
   if(id==='sweep'||id==='sweep-hold'){patch.weapon.x=32/sc;patch.weapon.y=105/sc;}
   if(id==='lift'){patch.weapon.x=25/sc;patch.weapon.y=127/sc;}
   if(id.startsWith('thrust')){patch.frame.body={x:9/sc,y:26/sc,rotate:-12};patch.weapon.x=45/sc;patch.weapon.y=102/sc;}
   if(id==='recover'){patch.weapon.x=22/sc;patch.weapon.y=106/sc;}
   await call('spine_adjust_pose',{posePath:k.posePath,outputPosePath:posePath,patch,dryRun:false});const r=await call('spine_solve_pose',{posePath,dryRun:false});console.log(id,r.ok,r.report.issues);keys.push({...k,posePath});
  }
  const add=async(id,time,base,patch)=>{const posePath=`${dir}/${id}.pose.json`;await call('spine_adjust_pose',{posePath:base,outputPosePath:posePath,patch:{...patch,frame:{...patch.frame,time},reference:{time}},dryRun:false});const r=await call('spine_solve_pose',{posePath,dryRun:false});console.log(id,r.ok,r.report.issues);keys.push({stageId:id,time,posePath});};
  await add('step-out',.03,keys.find(k=>k.stageId==='ready').posePath,{frame:{body:{y:28/sc},targets:{rightFoot:{x:-2/sc,y:4/sc,contact:false}}}});
  await add('sweep-land',.09,keys.find(k=>k.stageId==='sweep').posePath,{});
  const sweep=keys.find(k=>k.stageId==='sweep');const sweepNew=dir+'/sweep-step.pose.json';await call('spine_adjust_pose',{posePath:sweep.posePath,outputPosePath:sweepNew,patch:{frame:{targets:{leftFoot:{x:26/sc,y:3/sc,contact:false}}}},dryRun:false});console.log('sweep-step',(await call('spine_solve_pose',{posePath:sweepNew,dryRun:false})).ok);sweep.posePath=sweepNew;
  await add('step-in',1.54,keys.find(k=>k.stageId==='recover').posePath,{frame:{body:{x:0,y:28/sc,rotate:1},targets:{rightFoot:{x:-1/sc,y:4/sc,contact:false}}}});
  await add('left-step-in',1.57,keys.find(k=>k.stageId==='rest').posePath,{frame:{body:{y:29/sc},targets:{leftFoot:{x:26/sc,y:3/sc,contact:false}}}});
  keys.sort((a,b)=>a.time-b.time);await fs.writeFile(root+'/'+dir+'/key-poses.json',JSON.stringify(keys,null,2));const r=await call('spine_render_pose_comparison',{posePaths:keys.map(k=>k.posePath),stageIds:keys.map(k=>k.stageId),targetTimes:keys.map(k=>k.time),outputDir:dir+'/keypose-comparison-v2'});console.log(r.pages);
 }else if(mode==='fix-turns'){
  const keys=await read(dir+'/key-poses.json');for(const k of keys){if(!['low-turn','reverse'].includes(k.stageId))continue;const posePath=`${dir}/${k.stageId}.v3.pose.json`;await call('spine_adjust_pose',{posePath:k.posePath,outputPosePath:posePath,patch:{weapon:{x:(k.stageId==='low-turn'?22:20)/sc,y:(k.stageId==='low-turn'?83:96)/sc}},dryRun:false});const r=await call('spine_solve_pose',{posePath,dryRun:false});console.log(k.stageId,r.ok,r.report.issues);k.posePath=posePath;}
  await fs.writeFile(root+'/'+dir+'/key-poses.json',JSON.stringify(keys,null,2));const r=await call('spine_render_pose_comparison',{posePaths:keys.map(k=>k.posePath),stageIds:keys.map(k=>k.stageId),targetTimes:keys.map(k=>k.time),outputDir:dir+'/keypose-comparison-v3'});console.log(r.pages);
 }else if(mode==='confirm-poses'){
  const keys=await read(dir+'/key-poses.json');for(const k of keys)await call('spine_review_pose',{posePath:k.posePath,manifestPath:dir+'/keypose-comparison-v3/pose-comparison.json',decision:'approved',reviewedBy:'Codex',reason:'已查看上下参考/目标图与诊断：保留横扫、反击、突刺、收势阶段；双手沿假想杆握持，正常姿态由站姿继承。角色比例及切片方向导致转身幅度与参考不同，记录为适配差异。',checks,issues:[],dryRun:false});console.log(await call('spine_build_motion_from_poses',{standardPosePath,keyPoses:keys,motionPath:dir+'/attack.motion.json',name:'attack-pose-reviewed',duration:3.60,loop:true,dryRun:false}));
 }else if(mode==='dry-run'){
  const args={filePath,mappingPath,motionPath:dir+'/attack.motion.json',animation:'attack_pose_reviewed',rotationTolerance:.3,translationTolerance:.07,footContactTolerance:.15,handTolerance:.35,vertexTolerance:1.2,dryRun:true};const r=await call('spine_retarget_motion',args);await fs.writeFile(root+'/'+dir+'/dry-run.json',JSON.stringify(r,null,2));console.log({ok:r.ok,validation:r.motionValidation??r.validation,poseGate:r.poseGate});
  if(r.ok){const keys=await read(dir+'/key-poses.json');const cmp=await call('spine_render_animation_comparison',{targetManifestPath:r.animationPreview.manifestPath,referenceManifestPath:dir+'/reference-frames/reference-manifest.json',poseManifestPath:r.posePreview.manifestPath,phaseMap:keys.map(k=>({targetTime:k.time,referenceTime:k.time})),outputDir:r.animationPreview.outputDir});await fs.writeFile(root+'/'+dir+'/comparison.json',JSON.stringify(cmp,null,2));console.log(cmp.gifPath);}
 }else if(mode==='review-commit'){
  const dry=await read(dir+'/dry-run.json'),cmp=await read(dir+'/comparison.json');const approval=await call('spine_review_animation',{reviewToken:dry.reviewToken,manifestPath:cmp.manifestPath,decision:'approved',reviewedBy:'Codex',reason:'已查看关键姿态上下对比与完整过渡帧。站立时双腿伸展，握持和突刺有明确方向，补间无不可达或旋转跳变；属于比例适配，未声明严格逐像素复刻。',checks:['transitions','timing','followThrough','keyPoses','loop'],issues:[],dryRun:false});
  const r=await call('spine_retarget_motion',{filePath,mappingPath,motionPath:dir+'/attack.motion.json',animation:'attack_pose_reviewed',rotationTolerance:.3,translationTolerance:.07,footContactTolerance:.15,handTolerance:.35,vertexTolerance:1.2,dryRun:false,expectedHash:dry.hashBefore,reviewToken:approval.reviewToken});await fs.writeFile(root+'/'+dir+'/commit.json',JSON.stringify(r,null,2));console.log({ok:r.ok,report:r.reportPath,validation:r.motionValidation});await call('spine_preview_set_session',{filePath,atlasPath:'目标/npc1.atlas',animation:'attack_pose_reviewed',premultipliedAlpha:true,autoload:true,operation:{status:'done',title:'Pose to Pose 姿态审查流程验收',detail:'新动画 attack_pose_reviewed；原 attack_reference、act、idle 保留。'}});
 }
}finally{await client.close();}
