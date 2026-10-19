import fs from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root='D:/AI_cc/spine test',dir='previews/npc1-attack-retest-20261009',output=dir+'/ready-correction';
await fs.mkdir(root+'/'+output,{recursive:true});
const read=async p=>JSON.parse(await fs.readFile(root+'/'+p,'utf8'));
const client=new Client({name:'Codex-correct-ready-review',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
async function call(name,args){const result=await client.callTool({name,arguments:args});await fs.writeFile(root+'/'+output+'/'+Date.now()+'-'+name+'.json',JSON.stringify({args,result},null,2));if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);}
const reason='初始参考为分腿准备和身前双手握持，目标却继承窄站姿并把手降到腰部/身体两侧。数值通过只证明自设目标被求解，不证明匹配参考。此前 Agent 视觉批准错误，撤销整段通过结论。';
try{
 const dry=await read(dir+'/dry-run.json'),comparison=await read(dir+'/comparison.json');
 await call('spine_review_animation',{reviewToken:dry.reviewToken,manifestPath:comparison.manifestPath,decision:'rejected',reviewedBy:'Codex',reason,issues:[reason],checks:['transitions','timing','followThrough','keyPoses','loop'],dryRun:false});
 const keys=await read(dir+'/keys.json'),ready=keys.find(k=>k.stageId==='ready');
 await call('spine_review_pose',{posePath:ready.posePath,manifestPath:dir+'/pose-sheet-v4/pose-comparison.json',decision:'rejected',reviewedBy:'Codex',reason,issues:[reason],checks:['standingOrAction','silhouette','jointDirections','support','grip','occlusion','referenceDifferences'],dryRun:false});
 const report=await read(dir+'/acceptance-report.json');await fs.copyFile(root+'/'+dir+'/acceptance-report.json',root+'/'+output+'/previous-incorrect-report.json');report.ok=false;report.agentVisual='不通过：撤销此前错误视觉批准';report.correction={reason,at:new Date().toISOString(),existingAnimation:'此前写入的 attack_pose_reviewed 保留作负例；不代表已验收'};await fs.writeFile(root+'/'+dir+'/acceptance-report.json',JSON.stringify(report,null,2));
 const mapping=await read('previews/pose-workflow-20261009/npc1.mapping.json'),sc=mapping.calibration.scale,posePath=output+'/ready.v1.pose.json';
 await call('spine_adjust_pose',{posePath:ready.posePath,outputPosePath:posePath,patch:{frame:{body:{x:0,y:29/sc,rotate:0},targets:{leftFoot:{x:32/sc,y:0,angle:-15.46,contact:true},rightFoot:{x:-15/sc,y:0,angle:-32.8296,contact:true},leftHand:{angle:25},rightHand:{angle:25}}},weapon:{x:22/sc,y:99/sc,angle:25,grips:{left:8/sc,right:-8/sc}}},dryRun:false});
 const solved=await call('spine_solve_pose',{posePath,dryRun:false});console.log({ok:solved.ok,errors:solved.report.errors,gripErrors:solved.report.gripErrors,flexion:solved.report.flexion,issues:solved.report.issues});
 console.log(await call('spine_render_pose_comparison',{posePaths:[ready.posePath,posePath],stageIds:['old-ready-rejected','corrected-ready-draft'],targetTimes:[0,0],outputDir:output+'/comparison'}));
}finally{await client.close();}
