// 执行显式场景文件。审查决定必须由 Agent 看图后写入场景，不能自动生成统一批准。
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=process.env.SPINE_MCP_WORKSPACE??'D:/AI_cc/spine test';
const scenario=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const output=scenario.outputDir;await fs.mkdir(path.join(root,output,'calls'),{recursive:true});
const client=new Client({name:'pose-graph-acceptance',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,SPINE_MCP_WORKSPACE:root}}));
try{let i=0;for(const action of scenario.actions){const result=await client.callTool({name:action.tool,arguments:action.args});await fs.writeFile(path.join(root,output,'calls',`${++i}-${action.tool}.json`),JSON.stringify({args:action.args,result},null,2));if(result.isError){if(action.expectError){console.log(action.tool,'预期拒绝',result.content[0].text);continue;}throw new Error(result.content[0].text);}if(action.expectError)throw new Error(action.tool+' 应拒绝却通过');const r=JSON.parse(result.content[0].text);console.log(JSON.stringify({tool:action.tool,ok:r.ok,issues:r.issues,conflicts:r.conflicts,posePath:r.posePath,reportPath:r.reportPath,manifestPath:r.manifestPath,paths:r.paths,pages:r.pages,metrics:r.metrics?.map(m=>({id:m.id,status:m.status,error:m.error}))}));}}finally{await client.close();}
