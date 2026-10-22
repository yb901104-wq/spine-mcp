import { readFile,writeFile } from 'node:fs/promises';
const files=process.argv.slice(2);if(files.length!==3)throw Error('需要三轮独立的 30 样本报告。');
const reports=await Promise.all(files.map(async file=>JSON.parse(await readFile(file,'utf8')))),first=reports[0];
if(reports.some(r=>r.sampleCount!==30||r.renderer!==first.renderer||r.workloadFingerprint!==first.workloadFingerprint||!r.workloadFingerprint))throw Error('样本数量、renderer 或工作负载不一致，不汇总。');
const samples=reports.flatMap(r=>r.samples),phases=Object.fromEntries(Object.keys(samples[0]).map(key=>{const values=samples.map(s=>s[key]).sort((a,b)=>a-b);return[key,{p50:values[Math.ceil(values.length*.5)-1],p95:values[Math.ceil(values.length*.95)-1],maximum:values.at(-1)}];}));
const report={summarizedAt:new Date().toISOString(),files,renderer:first.renderer,workloadFingerprint:first.workloadFingerprint,sampleCount:samples.length,scope:first.fixture,coldStartMs:reports.map(r=>r.coldLoadEvaluateFrameMs),phases,
  roundP95:reports.map(r=>Object.fromEntries(Object.entries(r.phases).map(([k,v]:any)=>[k,v.p95]))),budgets:{stateMs:20,frameMs:50,endToEndMs:120},allRoundsPassed:reports.every(r=>r.phases.stateMs.p95<20&&r.phases.frameMs.p95<50&&r.phases.endToEndMs.p95<120)};
await writeFile('docs/plans/host-performance-20261022-summary.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
