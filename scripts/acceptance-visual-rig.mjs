// 真实 MCP 实例；默认只校准候选和诊断，不自动批准视觉结果。
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=process.env.SPINE_MCP_WORKSPACE??'D:/AI_cc/spine test';
const dir=process.env.VISUAL_RIG_OUTPUT??'previews/visual-rig-20261009';
await fs.mkdir(path.join(root,dir,'calls'),{recursive:true});
const client=new Client({name:'visual-rig-acceptance',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
let index=0;
async function call(name,args){const result=await client.callTool({name,arguments:args});await fs.writeFile(path.join(root,dir,'calls',`${++index}-${name}.json`),JSON.stringify({args,result},null,2));if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);}
try{
 const inputPath=process.argv[2];
 const args=inputPath?JSON.parse(await fs.readFile(inputPath,'utf8')):{filePath:'目标/npc1.json',mappingPath:'previews/pose-workflow-20261009/npc1.mapping.json',visualRigPath:dir+'/npc1.candidate.visual-rig.json',outputDir:dir+'/candidate',dryRun:false};
 const result=await call('spine_calibrate_visual_rig',args);console.log(JSON.stringify({ok:result.ok,issues:result.issues,paths:result.paths,visualRigPath:result.visualRigPath,manifestPath:result.manifestPath},null,2));
}finally{await client.close();}
