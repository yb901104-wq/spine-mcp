import path from 'node:path';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {loadMotionRuntime,worldVertices} from '../dist/motionRuntime.js';
const install=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const legacy='D:/AI_cc/spine test', workspace=path.join(legacy,'previews','验收优化-20261009');
await mkdir(workspace,{recursive:true});await mkdir(path.join(workspace,'tool-calls'),{recursive:true});
for(const [source,target] of [['npc1_idle_reference','idle-dense.json'],['npc1_idle_reference','npc1-idle-optimized.json'],['npc1_idle_tween','idle-before.json'],['npc1_walk','npc1-walk.json']])await copyFile(path.join(legacy,'输出',source,'npc1.json'),path.join(workspace,target));
for(const ext of ['atlas','png'])await copyFile(path.join(legacy,'输出','npc1_walk',`npc1.${ext}`),path.join(workspace,`npc1.${ext}`));
const client=new Client({name:'细节工具验收',version:'1'},{capabilities:{roots:{listChanged:true}}});
client.setRequestHandler(ListRootsRequestSchema,async()=>({roots:[{uri:pathToFileURL(workspace).href,name:'验收优化'}]}));
await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(install,'dist','server.js')],env:{...Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string')),SPINE_MCP_WORKSPACE:workspace}}));
let seq=0;const calls=[];
async function call(name,args,expectError=false){const r=await client.callTool({name,arguments:args});const text=r.content?.find(c=>c.type==='text')?.text??'';const result=r.isError?{error:text}:JSON.parse(text);const log={name,args,result,isError:!!r.isError};calls.push({name,isError:!!r.isError});await writeFile(path.join(workspace,'tool-calls',`${String(++seq).padStart(3,'0')}-${name}.json`),JSON.stringify(log,null,2));if(r.isError&&!expectError)throw new Error(`${name}: ${text}`);if(expectError&&!r.isError)throw new Error('应拒绝的输入被接受');return result;}
try{
 const summary=await call('spine_get_document_summary',{filePath:'npc1-idle-optimized.json'});
 const options={filePath:'npc1-idle-optimized.json',atlasPath:'npc1.atlas',animation:'idle-reference',rotationTolerance:.3,translationTolerance:.07,vertexTolerance:1.2,useCurves:true};
 console.log('正在通过实际 MCP 拟合并回读 idle 曲线');
 const review=await call('spine_fit_animation_curves',{...options,dryRun:true,expectedHash:summary.hash});
 console.log(JSON.stringify(review.curveFitReport));
 const commit=await call('spine_fit_animation_curves',{...options,dryRun:false,expectedHash:summary.hash});
 const json=JSON.parse(await readFile(path.join(workspace,'npc1-idle-optimized.json'),'utf8'));
 const bone=Object.keys(json.animations['idle-reference'].bones).find(n=>json.animations['idle-reference'].bones[n].rotate.length>1),frames=json.animations['idle-reference'].bones[bone].rotate;
 await call('spine_set_curve',{filePath:'npc1-idle-optimized.json',animation:'idle-reference',bone,timeline:'rotate',time:frames[0].time??0,curve:frames[0].curve??null,dryRun:true,expectedHash:commit.hashAfter});
 await call('spine_set_curve',{filePath:'npc1-idle-optimized.json',animation:'idle-reference',bone,timeline:'rotate',time:frames.at(-1).time??0,curve:'stepped',dryRun:true},true);
 await call('spine_set_curve',{filePath:'npc1-idle-optimized.json',animation:'idle-reference',bone,timeline:'rotate',time:frames[0].time??0,curve:null,dryRun:false,expectedHash:'stale-hash'},true);
 const preview=await call('spine_render_contact_sheet',{filePath:'npc1-idle-optimized.json',atlasPath:'npc1.atlas',animation:'idle-reference',frames:12});
 const result={idle:commit.curveFitReport,curveChecks:{existingCurveDryRun:true,finalFrameRejected:true,staleHashRejected:true},preview,calls};
 await writeFile(path.join(workspace,'idle-acceptance.json'),JSON.stringify(result,null,2));console.log('idle验收记录：'+path.join(workspace,'idle-acceptance.json'));
}finally{await client.close();}
