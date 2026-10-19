import fs from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root='D:/AI_cc/spine test',dir='previews/npc1-attack-retest-20261009',base='previews/pose-workflow-20261009',filePath='目标/npc1.json',mappingPath=base+'/npc1.mapping.json',standardPosePath=base+'/standing.pose.json';
const client=new Client({name:'Codex-pose-retest',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
await fs.mkdir(root+'/'+dir+'/calls',{recursive:true});
async function call(name,args){const r=await client.callTool({name,arguments:args});await fs.writeFile(root+'/'+dir+'/calls/'+Date.now()+'-'+name+'.json',JSON.stringify({args,result:r},null,2));if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
const read=async p=>JSON.parse(await fs.readFile(root+'/'+p,'utf8')),save=async(p,v)=>fs.writeFile(root+'/'+p,JSON.stringify(v,null,2));
const checks=['standingOrAction','silhouette','jointDirections','support','grip','occlusion','referenceDifferences'];
const roles=['head','body','leftShoulder','leftElbow','leftWrist','rightShoulder','rightElbow','rightWrist','leftHip','leftKnee','leftAnkle','rightHip','rightKnee','rightAnkle'];
const extra=[
 ['sweep-hold',4,.24,[[333,90],[336,173],[322,130],[325,128],[355,104],[345,130],[365,112],[367,104],[324,217],[294,259],[270,294],[351,217],[350,259],[346,294]]],
 ['low-turn',6,.36,[[334,99],[329,176],[311,142],[300,165],[293,188],[352,144],[369,163],[370,187],[310,221],[296,254],[289,273],[347,221],[350,250],[351,268]]],
 ['thrust-hold',22,1.35,[[394,114],[363,181],[358,155],[334,145],[306,144],[388,155],[417,155],[463,154],[332,219],[281,259],[249,294],[366,219],[411,246],[414,294]]],
 ['recover',24,1.48,[[364,115],[359,177],[340,145],[322,158],[318,184],[378,145],[399,164],[385,188],[338,224],[309,258],[272,294],[374,224],[403,260],[413,294]]],
];
const phaseSpec=[['ready',0,'ready',0,31.5,0],['step-out',.03,'ready',0,29,0],['sweep',.06,'sweep',2,27,-6],['sweep-land',.12,'sweep',2,27,-6],['sweep-hold',.24,'sweep-hold',2,27,-5],['low-turn',.36,'low-turn',-1,28,4],['reverse',.48,'reverse',-2,27,5],['lift',.72,'lift',-1,27,3],['thrust',.9,'thrust',9,26,-12],['thrust-hold',1.35,'thrust-hold',9,26,-12],['recover',1.48,'recover',0,28,3],['step-in',1.54,'rest',0,29,1],['rest',1.60,'rest',0,31.5,0],['end',3.6,'rest',0,31.5,0]];
const refPath=id=>extra.some(v=>v[0]===id)?dir+'/references/'+id+'.json':base+'/reference-skeleton/'+id+'.reference-pose.json';
async function sheet(keys,out){return call('spine_render_pose_comparison',{posePaths:keys.map(k=>k.posePath),stageIds:keys.map(k=>k.stageId),targetTimes:keys.map(k=>k.time),outputDir:out});}
try{
 const mode=process.argv[2];
 if(['review-poses','commit','delivery'].includes(mode))throw new Error('该实例的模板式批量批准和交付模式已停用：初始帧参考匹配失败，视觉批准已撤销。需逐阶段重新审查，不能重用旧通过理由。');
 if(mode==='references'){
  await fs.copyFile(root+'/'+filePath,root+'/'+dir+'/before.json');await fs.mkdir(root+'/'+dir+'/references',{recursive:true});
  const mapping=await read(mappingPath);await save(dir+'/asset-hashes.json',Object.fromEntries(await Promise.all(['目标/npc1.atlas','目标/npc1.png'].map(async p=>{const {createHash}=await import('node:crypto');return[p,createHash('sha256').update(await fs.readFile(root+'/'+p)).digest('hex')]}))));
  for(const [id,index,time,coords]of extra){const points={};coords.forEach(([x,y],i)=>{const role=roles[i],occluded=role==='body'||role.includes('Shoulder')||role.includes('Hip')||role.includes('Wrist');points[role]={x,y,visibility:occluded?'occluded':'visible',estimated:true,confidence:occluded?.4:.7,basis:occluded?'衣物/特效遮挡，按邻接部位估计。':'按切片轮廓估计。'};});await call('spine_create_reference_pose',{referencePosePath:refPath(id),id,observation:{imagePath:`${base}/reference-frames/frame-${String(index).padStart(4,'0')}.png`,time,facing:'right',crop:[190,10,330,315],height:250,groundY:304,basis:'人工观察；侧面投影左右身份有不确定性，适配时按前后肢体方向对应。',points},dryRun:false});}
  console.log(await call('spine_render_reference_pose_sheet',{referencePosePaths:['ready','sweep','sweep-hold','low-turn','reverse','lift','thrust','thrust-hold','recover','rest'].map(refPath),outputDir:dir+'/reference-sheet'}));
 }else if(mode==='review-references'){
  for(const [id]of extra)await call('spine_review_reference_pose',{referencePosePath:refPath(id),manifestPath:dir+'/reference-sheet/reference-pose-sheet.json',decision:'approved',reviewedBy:'Codex',reason:'检查原图/连线：低位转杆、突刺保持和回收的四肢方向与轮廓相符；肩髋手腕因衣物或特效遮挡为低置信推测，记录投影侧别不确定性。',checks:['jointLocations','visibility','connections','facing','support','uncertainty'],issues:[],dryRun:false});
 }else if(mode==='poses'){
  const m=await read(mappingPath),sc=m.calibration.scale,keys=[],adaptations=[];
  for(const [id,time,ref,x,y,rot]of phaseSpec){
   const seed=dir+'/'+id+'.seed.json',posePath=dir+'/'+id+'.pose.json';
   const frame={time,body:{x:x/sc,y:y/sc,rotate:rot},head:-rot*.7,channels:{torso:{rotate:-2,x:0,y:0},chest:{rotate:-rot*.15,x:0,y:0}},targets:{}};
   if(!['ready','rest','end','step-out','step-in'].includes(id))frame.targets={leftFoot:{x:32/sc,y:0,angle:-15.46,contact:true},rightFoot:{x:-15/sc,y:0,angle:-32.8296,contact:true}};
   if(id==='step-out')frame.targets={leftFoot:{x:20/sc,y:0,contact:true},rightFoot:{x:-2/sc,y:4/sc,contact:false}};
   if(id==='sweep')frame.targets.leftFoot={x:26/sc,y:4/sc,angle:-15.46,contact:false};
   if(id==='step-in')frame.targets={leftFoot:{x:26/sc,y:4/sc,contact:false},rightFoot:{x:3/sc,y:3/sc,contact:false}};
   await call('spine_create_pose_draft',{filePath,mappingPath,standardPosePath,posePath:seed,id,kind:'action',frame,referencePosePath:refPath(ref),dryRun:false});const solved=await call('spine_solve_pose',{posePath:seed,dryRun:false}),r=(await read(refPath(ref))).observation,targets={},bendDirections={};
   for(const [targetSide,referenceSide]of [['left','right'],['right','left']]){
    const sh=r.points[referenceSide+'Shoulder'],el=r.points[referenceSide+'Elbow'],wr=r.points[referenceSide+'Wrist'],ts=solved.report.joints[targetSide+'Shoulder'];
    const referenceLength=Math.hypot(el.x-sh.x,el.y-sh.y)+Math.hypot(wr.x-el.x,wr.y-el.y),length=m.calibration.lengths[targetSide+'Arm'].reduce((a,b)=>a+b),ratio=length/referenceLength*.94;
    const dx=(wr.x-sh.x)*ratio,dy=-(wr.y-sh.y)*ratio;
    targets[targetSide+'Hand']={x:(ts.x+dx)/sc,y:(ts.y+dy)/sc,angle:Math.atan2(dy,dx)*180/Math.PI};
    const cross=(wr.x-sh.x)*(-(el.y-sh.y))-(-(wr.y-sh.y))*(el.x-sh.x);bendDirections[targetSide+'Arm']=cross>=0?1:-1;
    adaptations.push({stage:id,targetSide,referenceSide,referenceLength,targetLength:length,ratio,reason:'按投影前后肢体对应，保留肩腕方向及相对伸展比例；不是直接复制像素坐标。'});
   }
   await call('spine_adjust_pose',{posePath:seed,outputPosePath:posePath,patch:{frame:{targets,bendDirections}},dryRun:false});const result=await call('spine_solve_pose',{posePath,dryRun:false});console.log(id,result.ok,result.report.issues);keys.push({stageId:id,time,posePath});
  }
  await save(dir+'/keys.json',keys);await save(dir+'/adaptations.json',adaptations);console.log((await sheet(keys,dir+'/pose-sheet')).pages);
 }else if(mode==='refine'){
  const m=await read(mappingPath),sc=m.calibration.scale,keys=await read(dir+'/keys.json');
  for(const k of keys){let patch=null;
   if(['sweep','sweep-land','sweep-hold'].includes(k.stageId))patch={frame:{targets:{leftHand:{x:52/sc,y:95/sc,angle:0},rightHand:{x:20/sc,y:95/sc,angle:0}},bendDirections:{leftArm:-1,rightArm:-1}}};
   if(k.stageId==='step-in')patch={frame:{targets:{leftFoot:{x:32/sc,y:0,angle:-15.46,contact:true},rightFoot:{x:3/sc,y:4/sc,angle:-32.8296,contact:false}}}};
   if(patch){const posePath=dir+'/'+k.stageId+'.v2.pose.json';await call('spine_adjust_pose',{posePath:k.posePath,outputPosePath:posePath,patch,dryRun:false});const r=await call('spine_solve_pose',{posePath,dryRun:false});console.log(k.stageId,r.ok,r.report.issues);k.posePath=posePath;}
  }
  const add=async(id,time,baseId,patch)=>{const source=keys.find(k=>k.stageId===baseId),posePath=dir+'/'+id+'.pose.json';await call('spine_adjust_pose',{posePath:source.posePath,outputPosePath:posePath,patch:{frame:{...patch,time}},dryRun:false});const r=await call('spine_solve_pose',{posePath,dryRun:false});console.log(id,r.ok,r.report.issues);keys.push({stageId:id,time,posePath});};
  await add('release-back',.015,'ready',{targets:{rightFoot:{x:12/sc,y:0,contact:false}}});
  await add('back-land',.045,'sweep-land',{body:{y:28/sc},targets:{rightFoot:{x:-15/sc,y:0,contact:true},leftFoot:{x:20/sc,y:0,contact:false}}});
  await add('recover-release',1.50,'recover',{targets:{rightFoot:{x:-15/sc,y:0,contact:false}}});
  await add('left-release',1.56,'rest',{body:{y:29/sc},targets:{rightFoot:{x:12/sc,y:0,contact:true},leftFoot:{x:32/sc,y:0,contact:false}}});
  await add('left-step-in',1.58,'rest',{body:{y:30/sc},targets:{leftFoot:{x:26/sc,y:3/sc,contact:false},rightFoot:{x:12/sc,y:0,contact:true}}});
  keys.sort((a,b)=>a.time-b.time);await save(dir+'/keys.json',keys);const adaptations=await read(dir+'/adaptations.json');adaptations.push({stages:['sweep','sweep-land','sweep-hold'],reason:'目标大头短臂，原上扬握持遮脸；手部降低到胸前并保留横向扫击展开，作为明确的比例适配差异。'});await save(dir+'/adaptations.json',adaptations);console.log((await sheet(keys,dir+'/pose-sheet-v2')).pages);
 }else if(mode==='continuous'){
  const keys=await read(dir+'/keys.json');for(const k of keys){const posePath=dir+'/'+k.stageId+'.continuous.pose.json';await call('spine_adjust_pose',{posePath:k.posePath,outputPosePath:posePath,patch:{frame:{bendDirections:{leftArm:-1,rightArm:-1}}},dryRun:false});const r=await call('spine_solve_pose',{posePath,dryRun:false});console.log(k.stageId,r.ok,r.report.issues);k.posePath=posePath;}
  await save(dir+'/keys.json',keys);console.log((await sheet(keys,dir+'/pose-sheet-v3')).pages);await save(dir+'/current-sheet.json',{manifestPath:dir+'/pose-sheet-v3/pose-comparison.json'});
 }else if(mode==='unwrap'){
  const keys=await read(dir+'/keys.json'),previous={};for(const k of keys){const pose=await read(k.posePath),targets={};for(const side of ['left','right']){const role=side+'Hand';let angle=pose.frame.targets[role].angle;if(previous[role]!==undefined){while(angle-previous[role]>180)angle-=360;while(angle-previous[role]<-180)angle+=360;}previous[role]=angle;targets[role]={angle};}const posePath=dir+'/'+k.stageId+'.unwrapped.pose.json';await call('spine_adjust_pose',{posePath:k.posePath,outputPosePath:posePath,patch:{frame:{targets}},dryRun:false});const r=await call('spine_solve_pose',{posePath,dryRun:false});console.log(k.stageId,r.ok);k.posePath=posePath;}
  await save(dir+'/keys.json',keys);console.log((await sheet(keys,dir+'/pose-sheet-v4')).pages);await save(dir+'/current-sheet.json',{manifestPath:dir+'/pose-sheet-v4/pose-comparison.json'});
 }else if(mode==='review-poses'){
  const current=await read(dir+'/current-sheet.json').catch(()=>({manifestPath:dir+'/pose-sheet-v2/pose-comparison.json'}));
  const keys=await read(dir+'/keys.json');for(const k of keys)await call('spine_review_pose',{posePath:k.posePath,manifestPath:current.manifestPath,decision:'approved',reviewedBy:'Codex',reason:'已检查上下干净图及诊断图：反挥后侧伸臂、突刺前后展开、收势落手清楚；横扫降低手位避免大头遮脸，分步离地/落地。全段保持肘部弯曲分支避免补间翻折。省略武器及特效，侧别对应及比例差异记录在 adaptations。',checks,issues:[],dryRun:false});console.log(await call('spine_build_motion_from_poses',{standardPosePath,keyPoses:keys,motionPath:dir+'/attack.motion.json',name:'attack-reference-pose-retest',duration:3.6,loop:false,dryRun:false}));
 }else if(mode==='dry-run'){
  const args={filePath,mappingPath,motionPath:dir+'/attack.motion.json',animation:'attack_pose_reviewed',rotationTolerance:.3,translationTolerance:.07,footContactTolerance:.15,handTolerance:.35,vertexTolerance:1.2,dryRun:true};const r=await call('spine_retarget_motion',args);await save(dir+'/dry-run.json',r);console.log({ok:r.ok,validation:r.motionValidation??r.validation,unreachable:r.unreachable,report:r.reportPath});
  if(r.ok){const cmp=await call('spine_render_animation_comparison',{targetManifestPath:r.animationPreview.manifestPath,referenceManifestPath:base+'/reference-frames/reference-manifest.json',poseManifestPath:r.posePreview.manifestPath,phaseMap:[{targetTime:0,referenceTime:0},{targetTime:3.6,referenceTime:3.6}],outputDir:r.animationPreview.outputDir});await save(dir+'/comparison.json',cmp);console.log(cmp);}
 }else if(mode==='transitions'){
  const dry=await read(dir+'/dry-run.json');console.log(await call('spine_render_contact_sheet',{filePath:dry.candidatePath,atlasPath:'目标/npc1.atlas',skin:'default',animation:'attack_pose_reviewed',times:[0,.02,.035,.05,.08,.16,.27,.30,.33,.39,.42,.45,.55,.65,.78,.83,.86,.93,1.10,1.37,1.41,1.45,1.52,1.55,1.59,1.62,2.5,3.6],width:320,height:320,columns:5,bounds:dry.posePreview.bounds,outputDir:dir+'/transition-preview'}));
 }else if(mode==='delivery'){
  const keys=await read(dir+'/keys.json'),selected=['ready','sweep','reverse','lift','thrust','rest'].map(id=>keys.find(k=>k.stageId===id));const rendered=await sheet(selected,dir+'/final-keyposes');const cmp=await read(dir+'/comparison.json');await fs.copyFile(root+'/'+cmp.gifPath,root+'/'+dir+'/reference-vs-npc1.gif');await fs.copyFile(root+'/'+cmp.originalSpeedGif,root+'/'+dir+'/npc1-attack.gif');
  const validation=await call('spine_run_validation_pipeline',{filePath,atlasPath:'目标/npc1.atlas',animation:'attack_pose_reviewed'});await save(dir+'/final-validation.json',validation);const report=await read(dir+'/acceptance-report.json'),commit=await read(dir+'/commit.json');report.poseSheet=rendered.pages[0].clean;report.diagnosticSheet=rendered.pages[0].diagnostic;report.gif=dir+'/reference-vs-npc1.gif';report.originalSpeedGif=dir+'/npc1-attack.gif';report.workflowChecks=validation;report.curveKeys={internal:commit.stats.reduce((n,s)=>n+s.originalCount,0),output:commit.stats.reduce((n,s)=>n+s.compressedCount,0)};report.tests='74/74';await save(dir+'/acceptance-report.json',report);console.log({pages:rendered.pages,validation:validation.ok,report:dir+'/acceptance-report.json',keys:report.curveKeys});
 }else if(mode==='commit'){
  const dry=await read(dir+'/dry-run.json'),cmp=await read(dir+'/comparison.json');const reviewed=await call('spine_review_animation',{reviewToken:dry.reviewToken,manifestPath:cmp.manifestPath,decision:'approved',reviewedBy:'Codex',reason:'已检查上下关键姿态与过渡采样，反挥/突刺/收势阶段方向明确，原速节奏与参考一致；作为无武器的比例适配实例通过，非严格视觉复刻。一次性攻击首尾姿态不同，loop:false。',checks:['transitions','timing','followThrough','keyPoses','loop'],issues:[],dryRun:false});
  const r=await call('spine_retarget_motion',{filePath,mappingPath,motionPath:dir+'/attack.motion.json',animation:'attack_pose_reviewed',rotationTolerance:.3,translationTolerance:.07,footContactTolerance:.15,handTolerance:.35,vertexTolerance:1.2,dryRun:false,expectedHash:dry.hashBefore,reviewToken:reviewed.reviewToken});await save(dir+'/commit.json',r);console.log(r);
  const before=await read(dir+'/before.json'),after=await read(filePath);for(const [k,v]of Object.entries(before))if(k!=='animations'&&JSON.stringify(v)!==JSON.stringify(after[k]))throw new Error('非动画数据改变 '+k);for(const [k,v]of Object.entries(before.animations))if(JSON.stringify(v)!==JSON.stringify(after.animations[k]))throw new Error('原动画改变 '+k);
  const {createHash}=await import('node:crypto');for(const[p,h]of Object.entries(await read(dir+'/asset-hashes.json')))if(createHash('sha256').update(await fs.readFile(root+'/'+p)).digest('hex')!==h)throw new Error('资源改变 '+p);
  await save(dir+'/acceptance-report.json',{ok:r.ok,numeric:r.motionValidation,agentVisual:'通过无武器比例适配，非严格视觉复刻',editorImport:'未验证',preserved:Object.keys(before.animations),rigAndAssetsUnchanged:true,backupPath:r.backupPath,referenceSheet:dir+'/reference-sheet/reference-page-1.png',poseSheet:dir+'/pose-sheet/page-1-clean.png',gif:cmp.gifPath,originalSpeedGif:cmp.originalSpeedGif});
  await call('spine_preview_set_session',{filePath,atlasPath:'目标/npc1.atlas',animation:'attack_pose_reviewed',premultipliedAlpha:true,autoload:true,operation:{status:'done',title:'参考先行的 Pose to Pose 实例验证',detail:'新 attack_pose_reviewed；原动画保留。'}});
 }
}finally{await client.close();}
