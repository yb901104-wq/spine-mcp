// 对已由真实桌面验证的隔离副本重测候选/状态/出图；不新增姿态批准、不提交源动画。
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PerformanceObserver} from 'node:perf_hooks';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fork,type ChildProcess} from 'node:child_process';
import {startHostServer} from '../src/hostServer.js';
import {HostClient} from '../src/hostClient.js';
import {strictHash} from '../src/hostContracts.js';
import {hostBuildFingerprint} from '../src/hostReleaseEvidence.js';
const desktopEvidence=process.argv[2];assert.ok(desktopEvidence,'需要通过的 --real-animation-candidate 桌面报告路径。');
const native=JSON.parse(await readFile(desktopEvidence,'utf8'));assert.equal(native.passed,true);assert.equal(native.allInputsUnchanged,true);assert.equal(native.animationCandidate.numericOk,true);assert.ok(native.sourceWorkspace);
const root=path.join(native.artifactDir,'workspace'),manifest=JSON.parse(await readFile(path.join(root,'.spine-workflow.json'),'utf8')),context={workspaceRoot:root,projectId:manifest.projectId};
process.env.SPINE_MCP_WORKSPACE=root;process.env.SPINE_MCP_REGISTRY_ROOT=root;
const output=`docs/plans/host-real-animation-performance-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,report:any={startedAt:new Date().toISOString(),desktopEvidence,workspace:root,scope:'实际 npc1 已批准站姿的固定站姿动画，独立隔离副本。实际 HostClient 精确候选/完整数值及 GIF/联系图/PNG、严格 state 和缓存 frame；不含 stdio/真实浏览器耗时，不新增动作批准或源写入，不等于完整新动作交付。',node:process.version,platform:os.platform(),cpu:os.cpus()[0]?.model,warmups:2,sampleCount:30,size:480,samples:[],publicWriteEnabled:false};
let host:Awaited<ReturnType<typeof startHostServer>>|undefined;
const stdio=process.argv.includes('--stdio');let protocol:Client|undefined;
const isolatedHost=process.argv.includes('--isolated-host');assert.ok(!isolatedHost||stdio,'独立 Host 验收须同时使用实际 MCP stdio。');
let worker:ChildProcess|undefined,workerExit:Promise<void>|undefined;
report.hostProcessIsolation=isolatedHost;
if(isolatedHost)report.scope+=' 测试驱动、Host 和 MCP 三个独立进程，避免驱动接收图像的内存分配影响 Host。';
report.processSeparation=stdio;report.stateMeasurement='HostClient 严格 state 完整读取';report.testWriterForAttachedRouting=stdio;
if(stdio)report.scope=report.scope.replace('实际 HostClient 精确候选','实际 MCP stdio 精确候选').replace('不含 stdio/真实浏览器耗时','候选耗时包含 stdio；不含真实浏览器呈现耗时')+' 本轮候选通过独立编译版 MCP stdio 子进程计算，Host 与求解分进程；测试 Writer 仅用于附着路由，不提交源文件。state/frame 仍按 HostClient 实测，不含其 stdio 编解码。';
const diagnostic=process.argv.includes('--diagnostic'),gcEvents:any[]=[],observer=diagnostic?new PerformanceObserver(list=>{for(const e of list.getEntries())gcEvents.push({startTime:e.startTime,duration:e.duration});}):null;
observer?.observe({entryTypes:['gc']});report.diagnosticTracing=diagnostic;report.formalPerformanceEvidence=!diagnostic;
try{
 report.build=await hostBuildFingerprint();
 if(isolatedHost){
  report.hostWorkerHash=strictHash(await readFile('scripts/host-benchmark-worker.mjs'));worker=fork(path.resolve('scripts/host-benchmark-worker.mjs'),[desktopEvidence],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  worker.stderr?.on('data',b=>process.stderr.write(b));workerExit=new Promise<void>((resolve,reject)=>{worker!.once('exit',code=>code===0?resolve():reject(Error('性能 Host worker 退出异常 '+code)));worker!.once('error',reject);});void workerExit.catch(()=>{});
  const ready:any=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('性能 Host worker 启动超时')),30000);worker!.on('message',(message:any)=>{if(message.type==='ready'){clearTimeout(timeout);resolve(message);}else if(message.type==='error'){clearTimeout(timeout);reject(Error(message.message));}});worker!.once('exit',()=>{clearTimeout(timeout);reject(Error('性能 Host worker 在就绪前退出'));});});report.hostBuild=ready.build;
 }else host=await startHostServer(context,{developmentProfile:'c2-pose',writeEnabled:stdio});
 const client=new HostClient(context);
 if(stdio){protocol=new Client({name:'real-animation-performance',version:'1'},{capabilities:{}});const env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>typeof e[1]==='string'));await protocol.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env,SPINE_HOST_AUTOSTART:'0'}}));report.mcpExecutableHash=strictHash(await readFile('dist/server.js'));report.mcpBuild=await(await import('../dist/hostReleaseEvidence.js')).hostBuildFingerprint();}
 const opened=await client.open({path:'idle.motion.json',animation:'host_c2_standing_readback',time:.15}),character=manifest.characters.npc1;
 for(let i=-2;i<30;i++){
  const args={projectId:context.projectId,expectedRevision:opened.version,filePath:character.skeletonPath,mappingPath:character.mappingPath,motionPath:'idle.motion.json',animation:'host_c2_standing_readback'},start=performance.now();
  let candidate:any;if(protocol){const response=await protocol.callTool({name:'spine_retarget_motion',arguments:args});assert.equal(response.isError,undefined,JSON.stringify(response));candidate=JSON.parse((response.content as any[]).find(e=>e.type==='text').text);}else candidate=await client.animationCandidate(args);
  const candidateClientMs=performance.now()-start;
  assert.equal(candidate.numericOk,true);assert.equal(candidate.readyForAnimationReview,true);assert.equal(candidate.wroteFile,false);
  const stateStart=performance.now(),state=await client.state(),stateEnd=performance.now(),stateClientMs=stateEnd-stateStart;assert.equal(state.targetStale,false);
  const frameStart=performance.now();await client.frame({expectedRevision:opened.version,size:480});const frameClientMs=performance.now()-frameStart;
  if(i>=0)report.samples.push({candidateClientMs,stateClientMs,frameClientMs,...diagnostic?{stateStart,stateEnd}:{},numericSamples:candidate.motionValidation.samples,candidateHash:candidate.candidateHash,reportPath:candidate.reportPath});else(report.warmupSamples??=[]).push({candidateClientMs,stateClientMs,frameClientMs});
  await new Promise(resolve=>setTimeout(resolve,120));
 }
 for(const [file,hash]of Object.entries(native.inputHashes))assert.equal(strictHash(await readFile(path.join(root,file))),hash);
 report.allInputsUnchanged=true;report.phases=Object.fromEntries(['candidateClientMs','stateClientMs','frameClientMs'].map(k=>{const v=report.samples.map((s:any)=>s[k]).sort((a:number,b:number)=>a-b);return[k,{p50:v[14],p95:v[28],maximum:v.at(-1)}];}));
 report.budgets={stateClientMs:20,frameClientMs:50};report.budgetsPassed=Object.entries(report.budgets).every(([k,v])=>report.phases[k].p95<Number(v));report.mechanicsPassed=true;
}catch(error:any){report.error=error.stack;report.mechanicsPassed=false;process.exitCode=1;}
finally{await protocol?.close();await host?.stop();if(worker){if(worker.connected)worker.send({type:'stop'});await workerExit;}report.hostStopped=true;await new Promise(resolve=>setImmediate(resolve));observer?.disconnect();if(diagnostic){report.gcEvents=gcEvents;for(const s of report.samples)s.overlappingGc=gcEvents.filter(e=>e.startTime<s.stateEnd&&e.startTime+e.duration>s.stateStart);}report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,mechanicsPassed:report.mechanicsPassed,budgetsPassed:report.budgetsPassed,phases:report.phases,error:report.error}));}
