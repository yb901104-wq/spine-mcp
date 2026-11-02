// 只对既有参考做新策略分析，不批准参考、不修改角色或动画。
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {registerWorkspace} from '../dist/workspaceTools.js';
import {strictHash} from '../dist/hostContracts.js';
const trial=JSON.parse(await fs.readFile('docs/plans/host-perspective-trial-2026-10-25T07-44-44-456Z.json','utf8'));
const root=trial.root,projectId='npc1-body-reference-trial',referencePosePath=`${trial.dir}/reference-parts.reference.json`;
const referenceHash=strictHash(await fs.readFile(path.join(root,referencePosePath)));
process.env.SPINE_MCP_WORKSPACE=root;process.env.SPINE_MCP_REGISTRY_ROOT=root;
await registerWorkspace({rootPath:root,projectId});
const protocol=new Client({name:'reference-fallback-check',version:'1'},{capabilities:{}});
const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
try{
 await protocol.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/server.js')],env:{...env,SPINE_HOST_AUTOSTART:'0'}}));
 const reportPath=`trial/reference-fallback-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,start=performance.now();
 const response=await protocol.callTool({name:'spine_analyze_reference_parts',arguments:{projectId,referencePosePath,reportPath,dryRun:false}});
 assert.equal(response.isError,undefined);const result=JSON.parse(response.content.filter(v=>v.type==='text').map(v=>v.text).join('\n'));
 assert.equal(result.version,2);assert.equal(result.ok,true);assert.ok(result.parts.every(p=>p.method==='twoPoint'&&p.reliability==='estimated'&&Number.isFinite(p.directionDegrees)&&p.pointHalfAngle===null));
 assert.equal(strictHash(await fs.readFile(path.join(root,referencePosePath))),referenceHash);
 for(const [p,h]of Object.entries(trial.inputHashes))assert.equal(strictHash(await fs.readFile(path.join(root,p))),h);
 const record={version:1,date:'2026-10-25',root,referencePosePath,referenceHash,reportPath,mcpCalls:1,durationMs:performance.now()-start,result,referenceUnchanged:true,sourceInputsUnchanged:true,referenceApproved:false,animationProduced:false,note:'缺轮廓不再阻断：两个既有遮挡估计点给出近似方向；未编造误差圆、未批准匹配或制作整段动画。'};
 await fs.writeFile('docs/plans/reference-fallback-20261025.json',JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({ok:true,sourceInputsUnchanged:true,parts:result.parts.map(p=>({id:p.id,method:p.method,directionDegrees:p.directionDegrees,reliability:p.reliability,uncertaintyKnown:p.uncertaintyKnown})),record:'docs/plans/reference-fallback-20261025.json'}));
}finally{await protocol.close();}
