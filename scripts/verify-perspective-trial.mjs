// 真实 npc1 受控单臂试验。所有姿态修改走正式 MCP；脚本仅读取资源和保存诊断报告/图。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startHostServer} from '../dist/hostServer.js';
import {registerWorkspace} from '../dist/workspaceTools.js';
import {strictHash} from '../dist/hostContracts.js';
import {createCanvas,loadImage,GlobalFonts} from '@napi-rs/canvas';
const sourceRoot=path.resolve(process.argv[2]??'D:/AI_cc/spine test/body-reference-trials/2026-10-24T15-53-20-542Z');
const projectId='npc1-body-reference-trial',stamp=new Date().toISOString().replace(/[:.]/g,'-'),dir=`trial/perspective-${stamp}`;
const root=path.resolve('D:/AI_cc/spine test/perspective-trials',stamp);
await fs.mkdir(root,{recursive:true});
async function copy(directory=''){
  for(const entry of await fs.readdir(path.join(sourceRoot,directory),{withFileTypes:true})){
    if(['.spine-mcp','.git','node_modules','dist','backups','test-output'].includes(entry.name)||entry.name.startsWith('perspective-'))continue;
    assert.equal(entry.isSymbolicLink(),false,'隔离拷贝拒绝链接');const relative=path.join(directory,entry.name),target=path.join(root,relative);
    if(entry.isDirectory()){await fs.mkdir(target,{recursive:true});await copy(relative);}else if(entry.isFile())await fs.copyFile(path.join(sourceRoot,relative),target);
  }
}
await copy();
const context={workspaceRoot:root,projectId},read=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
const original=await read('trial/neutral-stand-v2.pose.json'),mapping=await read(original.mappingPath),manifest=await read('.spine-workflow.json');
assert.equal(manifest.projectId,projectId);assert.equal(original.status,'confirmed');
const files=[original.filePath,original.mappingPath,mapping.atlasPath,original.visualRigPath,'trial/neutral-stand-v2.pose.json','reference/ready-v1.reference.json','reference/frames/frame-0000.png'];
const atlas=await fs.readFile(path.join(root,mapping.atlasPath),'utf8');
for(const line of atlas.split(/\r?\n/))if(/^[^\s].*\.png\s*$/.test(line))files.push(path.posix.join(path.posix.dirname(mapping.atlasPath),line.trim()));
const inputHashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,strictHash(await fs.readFile(path.join(root,f)))])));
await fs.mkdir(path.join(root,dir),{recursive:true});
process.env.SPINE_MCP_WORKSPACE=root;process.env.SPINE_MCP_REGISTRY_ROOT=root;
await registerWorkspace({rootPath:root,projectId});
let host;const protocol=new Client({name:'npc1-controlled-perspective',version:'1'},{capabilities:{}}),calls=[];
const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
const started=performance.now();let phase='reference';
const implementation=Object.fromEntries(await Promise.all(['perspective','retargetEngine','referenceParts','renderSnapshot','hostEvaluator','server','poseWorkflow'].map(async m=>[m,strictHash(await fs.readFile(path.resolve(`dist/${m}.js`)))])));
const statusFile=path.resolve('.codex-temp/perspective-status.json');
async function call(tool,args,allowError=false){
  const start=performance.now(),response=await protocol.callTool({name:tool,arguments:{projectId,...args}});
  const value=JSON.parse(response.content.filter(v=>v.type==='text').map(v=>v.text).join('\n'));
  const record={tool,args,isError:response.isError??false,milliseconds:performance.now()-start,result:value};calls.push(record);
  await fs.writeFile(path.join(root,dir,`call-${calls.length}-${tool}.json`),JSON.stringify(record,null,2));
  console.log(JSON.stringify({tool,ok:value.ok,isError:record.isError,milliseconds:record.milliseconds}));
  if(response.isError&&!allowError)throw new Error(JSON.stringify(value));return value;
}
try{
  await protocol.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/server.js')],env:{...env,SPINE_HOST_AUTOSTART:'0'}}));
  const listed=await protocol.listTools();assert.equal(listed.tools.length,102);assert.ok(listed.tools.some(v=>v.name==='spine_analyze_reference_parts'));
  const reference=await read('reference/ready-v1.reference.json'),observation=structuredClone(reference.observation);
  observation.parts={'leftArm.0':{source:'unknown',basis:'准备帧左上臂主体被衣袖遮挡，未取得可确认的身体刚性轮廓，也未测得肩肘误差圆。'},'leftArm.1':{source:'unknown',basis:'准备帧左前臂与袖口及手部交叠，不能将衣袖外缘冒认为身体轮廓，误差半径未知。'}};
  const referencePath=`${dir}/reference-parts.reference.json`;
  await call('spine_create_reference_pose',{referencePosePath:referencePath,observation,dryRun:false});
  const partAnalysis=await call('spine_analyze_reference_parts',{referencePosePath:referencePath,reportPath:`${dir}/parts-report.json`,dryRun:false});
  assert.equal(partAnalysis.ok,true);assert.ok(partAnalysis.parts.every(p=>p.method==='twoPoint'&&p.reliability==='estimated'));
  host=await startHostServer(context,{writeEnabled:true,developmentProfile:'c2-pose',captureTimeoutMs:20000});
  const opened=await call('spine_host_open',{path:'trial/neutral-stand-v2.pose.json',recheck:true});let version=opened.version;
  await call('spine_host_pin',{expectedRevision:version});
  const initialBody=JSON.stringify(host.store.active.value.frame.body),initialFeet=JSON.stringify({left:host.store.active.value.frame.targets.leftFoot,right:host.store.active.value.frame.targets.rightFoot});
  const initialTargets=JSON.stringify(host.store.active.value.frame.targets);
  phase='waiting-player';await fs.writeFile(statusFile,JSON.stringify({phase,endpoint:host.endpoint,root,dir},null,2));
  console.log(JSON.stringify({phase,endpoint:host.endpoint,root,dir}));
  // 页面必须由可见浏览器承载；不以模拟 player 代替真实美术对照。
  let visible=false;for(let i=0;i<240;i++){const state=await(await fetch(host.endpoint+'/api/state',{headers:{'X-Spine-Host-Token':host.token}})).json();if(state.preview?.visibilityState==='visible'){visible=true;break;}await new Promise(r=>setTimeout(r,500));}
  assert.equal(visible,true,'没有可见 player，不能完成本次真实对照');phase='capture';
  const samples=[];
  for(const [label,upper,lower] of [['baseline',1,1],['shorten-1',.9,.85],['shorten-2',.8,.7]]){
    if(label!=='baseline'){
      const value={mode:'diagnostic',limb:'leftArm',upper,lower,basis:'固定躯干、支撑、手目标及弯曲分支，检验纵向缩短对肘部和切片的影响；不宣称匹配参考。'};
      const edited=await call('spine_adjust_pose',{posePath:'trial/neutral-stand-v2.pose.json',expectedRevision:version,patch:{frame:{perspective:value}},dryRun:false});version=edited.version;
      assert.equal(host.store.active.derived.diagnosticOnly,true);
    }
    const doc=host.store.active;assert.equal(JSON.stringify(doc.value.frame.body),initialBody);assert.equal(JSON.stringify({left:doc.value.frame.targets.leftFoot,right:doc.value.frame.targets.rightFoot}),initialFeet);
    assert.equal(JSON.stringify(doc.value.frame.targets),initialTargets);
    if(label==='baseline'){assert.equal(doc.value.frame.perspective,undefined);assert.equal(doc.derived.numeric.ok,true);}
    await call('spine_preview_frame',{expectedRevision:version,size:480});
    const numeric=structuredClone(doc.derived.numeric);
    if(label!=='baseline'){assert.equal(numeric.perspective.branchOk,true);assert.equal(numeric.readyToCommit,false);assert.ok(numeric.perspective.iterations<=60);if(label==='shorten-1')assert.equal(numeric.ok,true);}
    assert.ok(doc.derived.renderState.maximumError<=1e-4);
    const result=await host.store.frame({expectedRevision:version,size:480});const pngPath=`${dir}/${label}.png`;await fs.writeFile(path.join(root,pngPath),result.png);
    const capture=await call('spine_preview_capture',{expectedRevision:version,size:960});assert.equal(capture.manifest.captureValidity.status,'verified');if(label!=='baseline')assert.equal(capture.manifest.evidenceEligible,false);
    const playerPath=`${dir}/${label}-player.png`;await fs.copyFile(path.join(root,capture.filePath),path.join(root,playerPath));
    samples.push({label,upper,lower,pngPath,playerPath,capture,numeric,renderState:doc.derived.renderState,version,derivedHash:doc.derivedHash});
  }
  const capture=samples.at(-1).capture;
  // 保存数值通过的诊断修订，失败的强缩短仅保留报告与截图，不索取保存授权。
  const restored=await call('spine_host_undo',{expectedRevision:version,dryRun:false});version=restored.version;
  const saved=await call('spine_host_commit',{expectedRevision:version,outputPath:`${dir}/shorten-1.pose.json`,requestId:`perspective-final-${stamp}`,dryRun:false});
  if(process.platform==='win32')GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc','Microsoft YaHei');
  const canvas=createCanvas(1440,620),ctx=canvas.getContext('2d');ctx.fillStyle='#20242b';ctx.fillRect(0,0,1440,620);ctx.font='20px "Microsoft YaHei", sans-serif';
  for(const [i,s] of samples.entries()){ctx.drawImage(await loadImage(await fs.readFile(path.join(root,s.playerPath))),i*480,40,480,480);ctx.fillStyle='white';ctx.fillText(`${['无缩放基线','温和缩短','强缩短（失败）'][i]}  ${s.upper} / ${s.lower}`,i*480+12,30);ctx.fillText(`数值：${s.numeric.ok?'通过':'未通过'} · 回放误差 ${s.renderState.maximumError.toExponential(1)}`,i*480+12,550);ctx.fillText(s.label==='baseline'?'既有站姿 · 官方 player':'仅诊断 · 未批准参考匹配 · 官方 player',i*480+12,582);}
  const sheet=`${dir}/comparison.png`;await fs.writeFile(path.join(root,sheet),canvas.toBuffer('image/png'));
  for(const [file,hash]of Object.entries(inputHashes)){assert.equal(strictHash(await fs.readFile(path.join(root,file))),hash,file);assert.equal(strictHash(await fs.readFile(path.join(sourceRoot,file))),hash,file);}
  const report={version:1,createdAt:new Date().toISOString(),purpose:'npc1-controlled-single-arm-perspective',implementation,sourceRoot,root,dir,durationMs:performance.now()-started,mcpCalls:calls.length,mcpTools:[...new Set(calls.map(v=>v.tool))],inputHashes,inputsUnchanged:true,partAnalysis,samples,sheet,capture,saved,
    referenceMatched:false,agentVisual:'pending',editorImport:'unverified',productionEnabled:false,note:'固定手目标的受控缩短验证；未制作或批准整段参考动画，关节可达不等于切片美术质量。'};
  await fs.writeFile(path.join(root,`${dir}/report.json`),JSON.stringify(report,null,2));
  await fs.writeFile(path.resolve(`docs/plans/host-perspective-trial-${stamp}.json`),JSON.stringify(report,null,2));
  await fs.writeFile(statusFile,JSON.stringify({phase:'complete',root,dir,sheet,reportPath:`docs/plans/host-perspective-trial-${stamp}.json`},null,2));
  console.log(JSON.stringify({phase:'complete',root,dir,sheet,mcpCalls:calls.length,samples:samples.map(s=>({label:s.label,numericOk:s.numeric.ok,perspective:s.numeric.perspective})),captureVerified:!!capture}));
}catch(error){
  await fs.writeFile(path.join(root,`${dir}/failure.json`),JSON.stringify({phase,root,dir,message:String(error),calls:calls.map(v=>({tool:v.tool,isError:v.isError,milliseconds:v.milliseconds})),note:'保留失败，不覆盖或放宽门禁。'},null,2));throw error;
}finally{await protocol.close();if(host)await host.stop();}
