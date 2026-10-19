import path from 'node:path';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {loadMotionRuntime,worldVertices} from '../dist/motionRuntime.js';
const install=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspace='D:/AI_cc/spine test/previews/验收优化-20261009', context={workspaceRoot:workspace};
const json=JSON.parse(await readFile(path.join(workspace,'npc1-walk.json'),'utf8'));
const runtime=await loadMotionRuntime(json,'npc1.atlas',context), setup=runtime.sample('walk',0,'default'), vertices=worldVertices(setup);
const chains={leftLeg:['zt1','zt2','zt3'],rightLeg:['yt1','yt2','yt3'],leftArm:['zs1','zs2','zs3'],rightArm:['ys1','ys2','ys3']};
const anchors={},bendDirections={};
for(const [limb,chain] of Object.entries(chains)){
 const role=limb.replace('Leg','Foot').replace('Arm','Hand'),bone=setup.findBone(chain[2]);
 anchors[role]={bone:chain[2],point:[0,0]};
 if(limb.endsWith('Leg')){
  const key=Object.keys(vertices).find(k=>k.split(':')[0]===(limb==='leftLeg'?'zt2':'yt2')); if(!key)throw Error('缺少脚掌网格');
  const points=vertices[key],det=bone.a*bone.d-bone.b*bone.c,local=[];
  for(let i=0;i<points.length;i+=2){const x=points[i]-bone.worldX,y=points[i+1]-bone.worldY;local.push([(bone.d*x-bone.b*y)/det,(-bone.c*x+bone.a*y)/det]);}
  anchors[role].solePoints=local; anchors[role].point=[local.reduce((s,p)=>s+p[0],0)/local.length,0];
 }
}
const first=runtime.sample('walk',0);
for(const [limb,chain] of Object.entries(chains)){const [a,b,c]=chain.map(n=>first.findBone(n));bendDirections[limb]=(c.worldX-a.worldX)*(b.worldY-a.worldY)-(c.worldY-a.worldY)*(b.worldX-a.worldX)>=0?1:-1;}
const excluded=new Set(['bone2','tou',...Object.values(chains).flat()]);
const channels=Object.fromEntries(json.bones.filter(b=>!excluded.has(b.name)).map((b,i)=>[`secondary${i}`,b.name]));
let ground=Infinity;
for(let i=0;i<73;i++){const s=runtime.sample('walk',runtime.data.findAnimation('walk').duration*i/72);for(const role of ['leftFoot','rightFoot']){const b=s.findBone(anchors[role].bone);ground=Math.min(ground,...anchors[role].solePoints.map(p=>b.worldY+b.c*p[0]+b.d*p[1]));}}
const client=new Client({name:'真实角色局部工具验收',version:'1'},{capabilities:{roots:{listChanged:true}}});
client.setRequestHandler(ListRootsRequestSchema,async()=>({roots:[{uri:pathToFileURL(workspace).href,name:'验收优化'}]}));
await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(install,'dist/server.js')],env:{...process.env,SPINE_MCP_WORKSPACE:workspace}}));
const auditDirectory=path.join(workspace,'walk-tool-calls',new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(auditDirectory,{recursive:true});let seq=0;const checks=[];
async function call(name,args,expectError=false){const r=await client.callTool({name,arguments:args}),txt=r.content?.find(c=>c.type==='text')?.text??'';const value=r.isError?{error:txt}:JSON.parse(txt);await writeFile(path.join(auditDirectory,`${String(++seq).padStart(3,'0')}-${name}.json`),JSON.stringify({name,args,isError:!!r.isError,result:value},null,2));if(r.isError&&!expectError)throw Error(txt);return value;}
async function retarget(motionPath,animation){const args={filePath:'npc1-walk.json',mappingPath:'npc1.mapping.json',motionPath,animation,overwrite:true,rotationTolerance:.3,translationTolerance:.07,footContactTolerance:.001,handTolerance:.1,vertexTolerance:1.2,preview:false};let review=await call('spine_retarget_motion',{...args,dryRun:true});if(!review.ok)return review;return call('spine_retarget_motion',{...args,dryRun:false,expectedHash:review.hashBefore,reviewToken:review.reviewToken});}
try{
 const slotAttachments=Object.fromEntries(setup.slots.map(s=>[s.data.name,s.getAttachment()?.name??null]));
 try {await readFile(path.join(workspace,'npc1.mapping.json'));} catch {await call('spine_create_mapping_draft',{filePath:'npc1-walk.json',mappingPath:'npc1.mapping.json',mapping:{character:'npc1',version:2,atlasPath:'npc1.atlas',skin:'default',bones:{body:'bone2',head:'tou',root:'root',...chains,anchors,bendDirections,channels,slotAttachments,follow:[]}},dryRun:false});}
 await call('spine_calibrate_mapping',{filePath:'npc1-walk.json',mappingPath:'npc1.mapping.json',dryRun:false});
 await call('spine_confirm_mapping',{filePath:'npc1-walk.json',mappingPath:'npc1.mapping.json',confirmedBy:'Codex-真实角色验收',semanticChecks:['body','head','sides','chains','anchors','bendDirections','setupPose','followBones'],dryRun:false});
 const extract=await call('spine_extract_motion',{filePath:'npc1-walk.json',mappingPath:'npc1.mapping.json',animation:'walk',motionPath:'walk.motion.json',samples:577,groundY:ground,contactTolerance:.002,dryRun:false});
 const baseline=await retarget('walk.motion.json','walk-mcp-baseline');checks.push({tool:'baseline',ok:baseline.ok,validation:baseline.motionValidation??baseline.validation});console.log('baseline',JSON.stringify(checks.at(-1)));
 const motion=extract.motion, swing=motion.frames.find(f=>!f.targets.leftFoot.contact&&f.time>0&&f.time<motion.duration),support=motion.frames.find(f=>f.targets.rightFoot.contact),hand=motion.frames[Math.floor(motion.frames.length/4)];
 const cases=[['spine_set_foot_target',{side:'left',time:swing.time,x:swing.targets.leftFoot.x+.002}],['spine_lock_foot_contact',{side:'right',time:support.time}],['spine_set_hand_target',{side:'left',time:hand.time,x:hand.targets.leftHand.x+.004}],['spine_adjust_body_motion',{bodyBob:.001}],['spine_adjust_step_length',{factor:1.01}],['spine_adjust_arm_swing',{factor:1.03}]];
 for(const [tool,options] of cases){const outputMotionPath=tool+'.motion.json';await call(tool,{motionPath:'walk.motion.json',outputMotionPath,...options,dryRun:false});const result=await retarget(outputMotionPath,tool.replace('spine_','walk-'));checks.push({tool,options,ok:result.ok,validation:result.motionValidation??result.validation,unreachable:result.unreachable});console.log(tool,JSON.stringify(checks.at(-1)));}
 await call('spine_set_hand_target',{motionPath:'walk.motion.json',outputMotionPath:'unreachable.motion.json',side:'left',time:hand.time,x:100,dryRun:false});const bad=await retarget('unreachable.motion.json','should-not-write');checks.push({tool:'unreachable-target-rejection',ok:bad.ok===false,validation:bad.validation});
 const after=JSON.parse(await readFile(path.join(workspace,'npc1-walk.json'),'utf8'));checks.push({tool:'original-data-preserved',ok:JSON.stringify({...json,animations:undefined})===JSON.stringify({...after,animations:undefined})&&Object.keys(json.animations).every(n=>JSON.stringify(json.animations[n])===JSON.stringify(after.animations[n]))});
 await writeFile(path.join(workspace,'walk-acceptance.json'),JSON.stringify({ground,checks},null,2));
}finally{await client.close();}
