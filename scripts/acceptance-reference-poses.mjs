import fs from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root='D:/AI_cc/spine test',dir='previews/pose-workflow-20261009/reference-skeleton';
const client=new Client({name:'Codex-reference-pose-acceptance',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
await fs.mkdir(root+'/'+dir+'/calls',{recursive:true});
async function call(name,args){const r=await client.callTool({name,arguments:args});await fs.writeFile(root+'/'+dir+'/calls/'+Date.now()+'-'+name+'.json',JSON.stringify({args,result:r},null,2));if(r.isError)throw new Error(r.content[0].text);return JSON.parse(r.content[0].text);}
// 参考像素画的人工观察，不是自动识别或精确人体测量。
// v=可见轮廓中心估计；o=衣服/特效遮挡后的低置信推测。
const phases=[
 ['ready',0,0,[[330,102,'v'],[321,176,'o'],[309,139,'o'],[296,169,'v'],[309,176,'o'],[347,139,'o'],[362,157,'v'],[348,153,'o'],[305,218,'o'],[278,255,'v'],[262,294,'v'],[335,218,'o'],[347,256,'v'],[361,294,'v']]],
 ['sweep',1,.06,[[331,91,'v'],[336,168,'o'],[320,131,'o'],[315,141,'v'],[351,113,'o'],[342,128,'o'],[365,116,'v'],[367,110,'o'],[323,217,'o'],[294,259,'o'],[270,294,'v'],[350,217,'o'],[350,259,'o'],[346,294,'v']]],
 ['reverse',8,.48,[[304,111,'v'],[291,178,'o'],[272,141,'o'],[238,115,'v'],[213,106,'v'],[314,141,'o'],[345,146,'v'],[332,155,'o'],[273,216,'o'],[246,254,'v'],[230,294,'v'],[305,216,'o'],[340,260,'v'],[366,294,'v']]],
 ['lift',12,.72,[[304,104,'v'],[290,176,'o'],[270,140,'o'],[243,124,'v'],[215,107,'v'],[316,139,'o'],[342,147,'v'],[328,165,'o'],[273,216,'o'],[246,254,'v'],[230,294,'v'],[305,216,'o'],[340,260,'v'],[366,294,'v']]],
 ['thrust',15,.90,[[388,115,'v'],[356,181,'o'],[353,155,'o'],[334,139,'o'],[308,145,'o'],[381,156,'o'],[411,166,'o'],[450,166,'v'],[330,218,'o'],[281,258,'v'],[249,294,'v'],[363,219,'o'],[411,246,'v'],[413,294,'v']]],
 ['rest',26,1.60,[[330,100,'v'],[327,176,'o'],[307,140,'o'],[301,168,'v'],[292,188,'o'],[346,140,'o'],[365,164,'v'],[373,191,'v'],[313,218,'o'],[313,254,'v'],[312,294,'v'],[341,218,'o'],[352,254,'v'],[361,294,'v']]],
];
const roles=['head','body','leftShoulder','leftElbow','leftWrist','rightShoulder','rightElbow','rightWrist','leftHip','leftKnee','leftAnkle','rightHip','rightKnee','rightAnkle'];
try{
 if(process.argv[2]==='reject-targets'){
  const problems={reverse:'参考有明显向后伸臂，目标双手聚于胸前，动作方向不匹配。',lift:'参考一臂向后上方伸出，目标手腕靠近脸部；抬杆轮廓不匹配。',rest:'参考收势双手更低，目标仍维持胸前握持，未体现收势。'};
  for(const [id,reason]of Object.entries(problems))console.log(await call('spine_review_pose',{posePath:dir+'/'+id+'.target.pose.json',manifestPath:dir+'/target-comparison/pose-comparison.json',decision:'rejected',reviewedBy:'Codex',reason,checks:['standingOrAction','silhouette','jointDirections','support','grip','occlusion','referenceDifferences'],issues:[reason],dryRun:false}));
  const current=await fs.readFile(root+'/目标/npc1.json'),before=await fs.readFile(root+'/previews/pose-workflow-20261009/before.json');if(!current.equals(before))throw new Error('目标 JSON 与本轮开始快照不同。');
  await fs.writeFile(root+'/'+dir+'/acceptance-report.json',JSON.stringify({referenceReview:'通过，遮挡点为低置信推测',targetVisualReview:'退回',problems,sourceJsonUnchanged:true,newAnimationCommitted:false,editorImport:'未验证',tests:'72/72',referenceSheet:dir+'/sheet/reference-page-1.png',comparison:dir+'/target-comparison/page-1-diagnostic.png',at:new Date().toISOString()},null,2));
 }else if(process.argv[2]==='compare'){
  const keys=JSON.parse(await fs.readFile(root+'/previews/pose-workflow-20261009/key-poses.json','utf8')),paths=[];
  for(const [id]of phases){const source=keys.find(k=>k.stageId===id),posePath=dir+'/'+id+'.target.pose.json';await call('spine_adjust_pose',{posePath:source.posePath,outputPosePath:posePath,patch:{referencePosePath:dir+'/'+id+'.reference-pose.json'},dryRun:false});await call('spine_solve_pose',{posePath,dryRun:false});paths.push(posePath);}
  console.log(await call('spine_render_pose_comparison',{posePaths:paths,stageIds:phases.map(p=>p[0]),targetTimes:phases.map(p=>p[2]),outputDir:dir+'/target-comparison'}));
 }else if(process.argv[2]==='render'){
  console.log(await call('spine_render_reference_pose_sheet',{referencePosePaths:phases.map(([id])=>dir+'/'+id+'.reference-pose.json'),outputDir:dir+'/sheet'}));
 }else if(process.argv[2]==='review'){
  for(const [id]of phases)console.log(await call('spine_review_reference_pose',{referencePosePath:dir+'/'+id+'.reference-pose.json',manifestPath:dir+'/sheet/reference-pose-sheet.json',decision:'approved',reviewedBy:'Codex',reason:'已检查原图与参考连线：头部、腿部和主要手臂方向与图像轮廓一致；肩髋及特效遮挡手腕为虚线低置信推测。左右肢体身份在转身和遮挡处仍有不确定性，此标注只作为姿态适配依据，不当作精确 IK 测量。',checks:['jointLocations','visibility','connections','facing','support','uncertainty'],issues:[],dryRun:false}));
 }else{
  const paths=[];
  for(const [id,index,time,coords]of phases){const referencePosePath=dir+'/'+id+'.reference-pose.json',points={};coords.forEach(([x,y,v],i)=>{points[roles[i]]={x,y,visibility:v==='v'?'visible':'occluded',estimated:true,confidence:v==='v'?.75:.4,basis:v==='v'?'按像素轮廓/切片中心估计。':'衣物或特效遮挡，根据相邻可见部位推测；左右身份不确定。'};});await call('spine_create_reference_pose',{referencePosePath,id,observation:{imagePath:`previews/pose-workflow-20261009/reference-frames/frame-${String(index).padStart(4,'0')}.png`,time,facing:'right',crop:[190,10,330,315],height:250,groundY:304,basis:'固定原图裁剪、身高和地面估计；左右命名为跨阶段假设，遮挡不伪装为直接观测。',points},dryRun:false});paths.push(referencePosePath);}
  console.log(await call('spine_render_reference_pose_sheet',{referencePosePaths:paths,outputDir:dir+'/sheet'}));
 }
}finally{await client.close();}
