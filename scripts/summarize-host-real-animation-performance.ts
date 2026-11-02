// 三轮完整真实资源采样必须同源码/编译构建、环境、输入与测量边界；失败轮次照常进入汇总。
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {objectHash,strictHash} from '../src/hostContracts.js';
const files=process.argv.slice(2);assert.equal(files.length,3);assert.equal(new Set(files).size,3);
const reports=await Promise.all(files.map(async file=>JSON.parse(await readFile(file,'utf8')))),first=reports[0];
for(const r of reports){
 assert.equal(r.mechanicsPassed,true);assert.equal(r.allInputsUnchanged,true);assert.equal(r.sampleCount,30);assert.equal(r.samples.length,30);assert.equal(r.warmups,2);assert.equal(r.diagnosticTracing,false);assert.equal(r.formalPerformanceEvidence,true);assert.equal(r.processSeparation,true);assert.equal(r.hostStopped,true);assert.ok(r.mcpBuild?.hash);
 if(r.hostProcessIsolation)assert.equal(r.hostBuild.hash,r.mcpBuild.hash,'Host 与 MCP 编译构建必须匹配');
 for(const key of ['desktopEvidence','workspace','scope','node','platform','cpu','size','warmups','budgets','build','mcpExecutableHash','mcpBuild','stateMeasurement','hostProcessIsolation','hostWorkerHash','hostBuild'])assert.equal(objectHash(r[key]),objectHash(first[key]),`三轮 ${key} 不一致`);
 for(const sample of r.samples)for(const key of ['candidateClientMs','stateClientMs','frameClientMs'])assert.ok(Number.isFinite(sample[key])&&sample[key]>=0);
}
const samples=reports.flatMap(r=>r.samples);assert.equal(new Set(samples.map(s=>s.candidateHash)).size,1,'三轮必须使用相同候选字节');
const phases=Object.fromEntries(['candidateClientMs','stateClientMs','frameClientMs'].map(k=>{const v=samples.map(s=>s[k]).sort((a,b)=>a-b);return[k,{p50:v[44],p95:v[85],maximum:v.at(-1)}];}));
const passed=(r:any)=>Object.entries(first.budgets).every(([key,limit])=>r.phases[key].p95<Number(limit));
const output=`docs/plans/host-real-animation-performance-summary-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,summary={at:new Date().toISOString(),files,reportHashes:await Promise.all(files.map(async file=>({file,hash:strictHash(await readFile(file))}))),sourceBuild:first.build,compiledMcpBuild:first.mcpBuild,hostProcessIsolation:first.hostProcessIsolation,hostBuild:first.hostBuild,hostWorkerHash:first.hostWorkerHash,hostsStopped:true,environment:{node:first.node,platform:first.platform,cpu:first.cpu},desktopEvidence:first.desktopEvidence,workspace:first.workspace,scope:first.scope,stateMeasurement:first.stateMeasurement,sampleCount:samples.length,warmupsPerRound:2,size:first.size,budgets:first.budgets,phases,roundP95:reports.map(r=>Object.fromEntries(Object.keys(phases).map(k=>[k,r.phases[k].p95]))),allRoundsPassed:reports.every(passed),aggregatePassed:passed({phases}),allInputsUnchanged:true,publicWriteEnabled:false,note:'不替代真实完整动作、第二角色、Spine 编辑器导入、长期稳定或公开启用；逐轮及总体分别报告。'};
await writeFile(output,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,allRoundsPassed:summary.allRoundsPassed,aggregatePassed:summary.aggregatePassed,phases}));
