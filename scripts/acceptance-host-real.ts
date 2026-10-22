// 真实美术 C1 隔离联调：复制已确认资源，实际 MCP 与官方 player；视觉决定必须另行填写。
import { readFile,writeFile,mkdir,copyFile,stat } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requireReviewedPose } from '../src/poseWorkflow.js';
import { poseDependencies } from '../src/poseDigest.js';
import { resolveWorkspacePath } from '../src/spineJson.js';
import { registerWorkspace } from '../src/workspaceTools.js';
import { startHostServer } from '../src/hostServer.js';
import { objectHash,strictHash } from '../src/hostContracts.js';
const source='D:/AI_cc/spine test',posePath='previews/pose-workflow-20261009/standing.pose.json';
const original=await requireReviewedPose(posePath,{workspaceRoot:source}),mapping=JSON.parse(await readFile(resolveWorkspacePath(original.mappingPath,{workspaceRoot:source}),'utf8'));
const root=path.join(source,'host-acceptance',new Date().toISOString().replace(/[:.]/g,'-'));
const reportPath=`docs/plans/host-real-c1-${path.basename(root)}.json`;
await mkdir(root,{recursive:true});process.env.SPINE_MCP_REGISTRY_ROOT=root;process.env.SPINE_MCP_WORKSPACE=root;
const context={workspaceRoot:root,projectId:'npc1-host-c1-acceptance'};
await registerWorkspace({rootPath:root,projectId:context.projectId});
const files=new Set([posePath,...(await poseDependencies(original,{workspaceRoot:source})).dependencies.map(f=>f.filePath),...original.review.evidence.map((e:any)=>e.filePath),mapping.reportPath].filter(Boolean)),hashes:Record<string,string>={};
for(const file of files){const from=resolveWorkspacePath(file,{workspaceRoot:source}),to=resolveWorkspacePath(file,context);await mkdir(path.dirname(to),{recursive:true});await copyFile(from,to);hashes[file]=strictHash(await readFile(from));}
await requireReviewedPose(posePath,context);
let client:Client,host:Awaited<ReturnType<typeof startHostServer>>|undefined;let number=0;
const report:any={startedAt:new Date().toISOString(),workspace:root,sourcePose:posePath,scope:'真实 npc1 的无参考标准站姿，仅隔离 C1 手角度编辑；不是攻击动作或公开写入验收。',inputHashes:hashes};
async function connect(){
  client=new Client({name:'Codex-real-host-c1',version:'1'},{capabilities:{}});
  const env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>typeof e[1]==='string'));
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env,SPINE_MCP_WORKSPACE:root,SPINE_MCP_REGISTRY_ROOT:root,SPINE_HOST_AUTOSTART:'0',...host?{SPINE_HOST_ENDPOINT:host.endpoint,SPINE_HOST_TOKEN:host.token}:{}}}));
}
async function call(name:string,args:any={}){
  const result=await client.callTool({name,arguments:{projectId:context.projectId,...args}});
  await mkdir(path.join(root,'output/calls'),{recursive:true});
  const text=(result.content as any[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  await writeFile(path.join(root,`output/calls/${++number}-${name}.json`),JSON.stringify({args,text,isError:result.isError??false},null,2));
  if(result.isError)throw Error(text);return JSON.parse(text);
}
try{
  await connect();
  await call('spine_create_project',{expectedAbsent:true,dryRun:false,manifest:{format:'spine-ai-workspace',schemaVersion:1,projectId:context.projectId,name:'NPC1 真实美术 C1 隔离验收',characters:{npc1:{skeletonPath:original.filePath,mappingPath:original.mappingPath,atlasPath:mapping.atlasPath,...mapping.skin?{skin:mapping.skin}:{},spineVersion:'4.1.24'}},documents:[{path:posePath,kind:'pose',characterId:'npc1'}],references:{posePaths:[],sequencePaths:[]},artifactRoots:{previews:'output/previews',reports:'output/reports'}}});
  await client.close();host=await startHostServer(context,{writeEnabled:true,captureTimeoutMs:10000});await connect();
  let state=await call('spine_host_open',{path:posePath});await call('spine_host_pin',{expectedRevision:state.version});
  state=await call('spine_recheck_pose',{posePath});if(!state.numeric?.ok)throw Error('真实标准站姿当前数值未通过。');
  console.log(JSON.stringify({endpoint:host.endpoint,workspace:root,instruction:'打开可见浏览器；将自动采集修改前后两张真实 player 图，然后等待独立视觉决定。'}));
  for(let i=0;;i++){const s:any=await(await fetch(host.endpoint+'/api/state',{headers:{'X-Spine-Host-Token':host.token}})).json();if(s.preview.visibilityState==='visible')break;if(i>1800)throw Error('等待浏览器超时');await new Promise(r=>setTimeout(r,100));}
  await new Promise(r=>setTimeout(r,500));
  report.before=await call('spine_preview_capture',{expectedRevision:state.version,size:960});
  const role=process.argv.includes('--right-hand')?'rightHand':'leftHand';
  const op={op:'setPoseTarget',path:`pose/frame/targets/${role}`,role,angle:original.frame.targets[role].angle+10};report.editedRole=role;
  const before=await call('spine_preview_state');await call('spine_host_patch',{expectedRevision:state.version,ops:[op]});const afterDry=await call('spine_preview_state');
  for(const key of ['version','contentHash','undoDepth','redoDepth','uncommitted'])if(objectHash(before[key])!==objectHash(afterDry[key]))throw Error(`dryRun 改变了 ${key}`);
  const first=await call('spine_host_patch',{expectedRevision:state.version,ops:[op],dryRun:false});
  const second=await call('spine_host_patch',{expectedRevision:first.version,ops:[{...op,angle:op.angle+10}],dryRun:false});
  const undone=await call('spine_host_undo',{expectedRevision:second.version,dryRun:false});state=await call('spine_preview_state');
  if(!state.numeric?.ok||state.contentHash!==first.state.contentHash||state.version.revision!==3)throw Error('撤销后的实际内容、数值或单调版本不符。');
  report.after=await call('spine_preview_capture',{expectedRevision:undone.version,size:960});report.version=undone.version;
  const decisionPath=path.join(root,'review-decision.json');
  await writeFile(path.join(root,'pending-review.json'),JSON.stringify({before:report.before.filePath,after:report.after.filePath,manifestPath:report.after.manifestPath,version:undone.version,numeric:state.numeric,decisionPath,warning:'须查看两张干净 player 图后逐项决定；不得以数字或旧批准代替当前视觉审查。'},null,2));
  console.log(JSON.stringify({pendingReview:path.join(root,'pending-review.json'),before:path.join(root,report.before.filePath),after:path.join(root,report.after.filePath)}));
  for(let i=0;;i++){try{await stat(decisionPath);break;}catch(error:any){if(error.code!=='ENOENT')throw error;}if(i>2400)throw Error('未收到独立视觉决定');await new Promise(r=>setTimeout(r,500));}
  const decision=JSON.parse(await readFile(decisionPath,'utf8')),reviewArgs={posePath,manifestPath:report.after.manifestPath,expectedRevision:undone.version,...decision};
  report.reviewDryRun=await call('spine_review_pose',reviewArgs);report.review=await call('spine_review_pose',{...reviewArgs,dryRun:false});
  const commit={expectedRevision:undone.version,outputPath:'poses/standing-hand-angle.json',requestId:'npc1-real-c1-save',dryRun:false};
  report.saved=await call('spine_host_commit',commit);report.retried=await call('spine_host_commit',commit);
  const {replayed,...retryReceipt}=report.retried;
  if(replayed!==true||objectHash(report.saved)!==objectHash(retryReceipt))throw Error('相同 requestId 的稳定回执字段不一致。');
  await client.close();await host.stop();host=await startHostServer(context);await connect();
  report.reopened=await call('spine_host_open',{path:commit.outputPath});
  if(report.reopened.version.openEpoch===undone.version.openEpoch||report.reopened.pinned)throw Error('重开错误地恢复了旧 epoch/pin。');
  if(decision.decision==='approved'){await requireReviewedPose(commit.outputPath,context);report.savedPoseReverified=true;}
  for(const[file,hash]of Object.entries(hashes))if(strictHash(await readFile(resolveWorkspacePath(file,{workspaceRoot:source})))!==hash||strictHash(await readFile(resolveWorkspacePath(file,context)))!==hash)throw Error('源资源或隔离副本被修改。');
  report.sourceUnchanged=true;report.mechanicsPassed=true;report.agentVisual=decision.decision;report.publicWriteEnabled=false;report.editorImport='notRun';report.finishedAt=new Date().toISOString();
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({reportPath,mechanicsPassed:true,agentVisual:decision.decision,workspace:root,sourceUnchanged:true}));
}catch(error:any){report.error=error.message;await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});throw error;}
finally{await client!?.close().catch(()=>{});await host?.stop();}
