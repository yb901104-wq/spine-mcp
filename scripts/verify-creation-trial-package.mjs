// 已解包试用包的真实 MCP/隔离启动验证，不安装依赖、不改全局配置、不写角色资产。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const [packageDirectory,sourceDirectory]=process.argv.slice(2);
if(!packageDirectory||!sourceDirectory)throw Error('用法：node scripts/verify-creation-trial-package.mjs <已解包且已准备依赖的包目录> <已登记源工程>');
const pkg=path.resolve(packageDirectory),source=path.resolve(sourceDirectory),manifest=JSON.parse(await fs.readFile(path.join(pkg,'trial-package.json'),'utf8'));
const sourceManifest=JSON.parse(await fs.readFile(path.join(source,'.spine-workflow.json'),'utf8'));
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),reportPath=`docs/plans/creation-package-verification-${stamp}.json`;
const report={at:new Date().toISOString(),packageDirectory:pkg,buildFingerprint:manifest.build.buildFingerprint,source,scope:'已有本机依赖复用下的已解包包校验、真实 stdio 发现、全新隔离 Host 启动/看图/关闭；不是全新系统安装或 WinForms 发行验收。',dependencyPreparation:'验证者事先建立本机 node_modules 只读依赖复用链接；ZIP 不包含该链接或依赖。',passed:false};
const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd:pkg,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>output+=b.toString());child.once('error',reject);child.once('exit',code=>resolve({code,output}));});
const protocol=new Client({name:'creation-trial-package-verifier',version:'1'});let taskContext,hostChild,hostExit;
try{
 const verify=await run(['scripts/run-creation-trial.mjs','--verify-only']);assert.equal(verify.code,0,verify.output);report.integrity=true;
 const target=path.join(pkg,'dist/buildIdentity.js'),original=await fs.readFile(target);
 try{await fs.appendFile(target,'\n// 校验拒绝试验\n');const tampered=await run(['scripts/run-creation-trial.mjs','--verify-only']);assert.notEqual(tampered.code,0);assert.match(tampered.output,/试用包字节发生变化/);report.tamperRejected=true;}finally{await fs.writeFile(target,original);}
 assert.equal((await run(['scripts/run-creation-trial.mjs','--verify-only'])).code,0);report.restored=true;
 await protocol.connect(new StdioClientTransport({command:process.execPath,args:[path.join(pkg,'dist/server.js')],stderr:'pipe',env:{...process.env,SPINE_MCP_WORKSPACE:source,SPINE_MCP_REGISTRY_ROOT:source,SPINE_HOST_AUTOSTART:'0'}}));
 const call=async(name,args={})=>{const r=await protocol.callTool({name,arguments:{projectId:taskContext?.projectId??sourceManifest.projectId,...args}});assert.notEqual(r.isError,true,JSON.stringify(r.content));return {value:JSON.parse(r.content.find(c=>c.type==='text').text),images:r.content.filter(c=>c.type==='image')};};
 const list=await protocol.listTools();assert.equal(list.tools.length,115);for(const name of ['spine_edit_motion_interval','spine_calibrate_arm_perspective','spine_review_arm_perspective'])assert.ok(list.tools.some(t=>t.name===name));report.toolCount=list.tools.length;
 await call('spine_register_workspace',{rootPath:source,projectId:sourceManifest.projectId});
 const task=(await call('spine_start_creation_task',{characterId:'npc1',referencePath:'reference/body.gif',sequencePath:'reference/body.sequence.json',stages:[{stageId:'standard',documentPath:'trial/neutral-stand-v2.pose.json'}],isolatedDirectory:`creation-package-smoke/${stamp}`,dryRun:false})).value;taskContext=task.taskContext;report.taskContext=taskContext;
 hostChild=spawn(process.execPath,[path.join(pkg,'scripts/run-creation-trial.mjs'),'--workspace',taskContext.workspaceRoot],{cwd:pkg,stdio:['ignore','pipe','pipe'],windowsHide:true});
 hostExit=new Promise(resolve=>hostChild.once('exit',resolve));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('试用包 Host 启动超时。')),30000);let output='';hostChild.once('error',reject);hostChild.once('exit',code=>{clearTimeout(timer);reject(Error('Host 提前退出：'+code+' '+output));});hostChild.stderr.on('data',b=>output+=b.toString());hostChild.stdout.on('data',b=>{output+=b.toString();if(output.includes('"type":"creation-host-ready"')){clearTimeout(timer);resolve();}});});
 const opened=(await call('spine_host_open',{path:'trial/neutral-stand-v2.pose.json',recheck:true})).value;report.version=opened.version;
 const frame=await call('spine_preview_frame',{expectedRevision:opened.version,size:480});assert.equal(frame.images.length,1);report.frameHash=createHash('sha256').update(Buffer.from(frame.images[0].data,'base64')).digest('hex');
 const {validateHostGolden}=await import(pathToFileURL(path.join(pkg,'dist/goldenValidation.js')).href);report.golden=await validateHostGolden(pkg);assert.equal(report.golden.goldenPassed,true);
 const after=(await call('spine_get_creation_task',{taskId:task.taskId})).value;assert.equal(after.freshness.current,true);report.inputsUnchanged=true;report.passed=true;
}catch(error){report.error=error.stack??String(error);process.exitCode=1;}
finally{
 await protocol.close();
 if(taskContext&&hostChild){try{const record=JSON.parse(await fs.readFile(path.join(taskContext.workspaceRoot,'.spine-mcp/host-port.json'),'utf8'));const response=await fetch(`http://127.0.0.1:${record.port}/api/shutdown`,{method:'POST',headers:{'X-Spine-Host-Token':record.token,Origin:`http://127.0.0.1:${record.port}`,'Content-Type':'application/json'},body:JSON.stringify({reason:'package-verification-complete'}),signal:AbortSignal.timeout(3000)});assert.equal(response.ok,true);report.hostStopped=true;}catch(error){report.shutdownError=String(error);report.passed=false;process.exitCode=1;}
 await Promise.race([hostExit,new Promise(r=>setTimeout(r,5000))]);
 if(hostChild.exitCode===null)hostChild.kill();
 try{const {readWriter}=await import(pathToFileURL(path.join(pkg,'dist/writerOwnership.js')).href);report.writerReleased=await readWriter(taskContext)===null;if(!report.writerReleased){report.passed=false;process.exitCode=1;}}catch(error){report.writerCheckError=String(error);report.passed=false;process.exitCode=1;}}
 await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({reportPath,passed:report.passed,writerReleased:report.writerReleased,error:report.error??null}));
}
