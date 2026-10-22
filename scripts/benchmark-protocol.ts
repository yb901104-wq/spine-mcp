// 测量只读协议入口；合成姿态指标与本仓库目录指标分开，不作为真实美术验收。
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { getWorkspaceTree } from '../src/workspaceTree.js';
import { listResources } from '../src/resources.js';
import { getPoseState } from '../src/poseOps.js';
import { cacheStats } from '../src/runtimeCache.js';
const root=process.cwd();
async function measure(run:()=>Promise<any>){
  await run();const samples=[];let result:any;
  for(let i=0;i<30;i++){const start=performance.now();result=await run();samples.push(performance.now()-start);}
  const sorted=[...samples].sort((a,b)=>a-b);
  return{samplesMs:samples,p50Ms:sorted[14],p95Ms:sorted[28],responseBytes:Buffer.byteLength(JSON.stringify(result)),result};
}
const tree=await measure(()=>getWorkspaceTree({depth:3},{workspaceRoot:root}));
const resources=await measure(()=>listResources());
let fixture:any;
await withHostFixture(async({context})=>{
  const reads=await measure(()=>getPoseState({posePath:'a.pose.json'},context));
  fixture={...reads,result:{freshness:reads.result.freshness,solveCount:reads.result.solveCount,checked:reads.result.checked,read:reads.result.read,cache:cacheStats()}};
});
const report={measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,samples:30,
  scope:'本仓库目录与临时合成姿态；不外推真实美术。当前进程测量，不含 MCP stdio 传输。',
  tree:{...tree,result:{counts:tree.result.counts,truncated:tree.result.truncated}},
  resources:{...resources,result:{count:resources.result.resources.length,hasNext:!!resources.result.nextCursor}},pose:fixture,
  budgets:{treeP95Ms:300,treeBytes:60000,resourcesP95Ms:200,resourcesBytes:5000,poseP95Ms:20},
  passed:tree.p95Ms<300&&tree.responseBytes<60000&&resources.p95Ms<200&&resources.responseBytes<5000&&fixture.p95Ms<20&&fixture.result.solveCount===0};
const output=path.join(root,'docs/plans/protocol-performance-20261021.json');
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,passed:report.passed,treeP95Ms:tree.p95Ms,resourcesP95Ms:resources.p95Ms,poseP95Ms:fixture.p95Ms}));
