import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {getAgentConnectionStatus} from '../src/agentTools.js';

test('real MCP protocol heartbeat becomes green while idle and red after client exit',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-protocol-'));
 const client=new Client({name:'codex-live-test',version:'1'},{capabilities:{}});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')),SPINE_MCP_WORKSPACE:root}}));
  let connected=false;for(let i=0;i<30;i++){const status=await getAgentConnectionStatus({clientType:'codex'},{workspaceRoot:root});if(status.selected?.light==='green'){connected=true;break;}await new Promise(r=>setTimeout(r,50));}assert.equal(connected,true);
  await client.close();let offline=false;for(let i=0;i<30;i++){const status=await getAgentConnectionStatus({clientType:'codex'},{workspaceRoot:root});if(status.selected?.light==='red'){offline=true;break;}await new Promise(r=>setTimeout(r,50));}assert.equal(offline,true);
 }finally{await client.close();await rm(root,{recursive:true,force:true});}
});

test('actual MCP stdio supports Roots, projectId, PNG previews and invalid paths', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-client-'));
  const client = new Client({ name: 'workflow-test', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(process.cwd()).href, name: 'fixture' }] }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => typeof e[1] === 'string')), SPINE_MCP_WORKSPACE: temp } });
  try {
    await client.connect(transport);
    const listed = await client.listTools(); assert.ok(listed.tools.some(t => t.name === 'spine_analyze_reference_gif'));for(const name of ['spine_calibrate_visual_rig','spine_review_visual_rig','spine_retarget_reference_pose','spine_compare_pose_graphs'])assert.ok(listed.tools.some(t=>t.name===name));
    const decode = (r: any) => { assert.equal(r.isError, undefined, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
    const registered = decode(await client.callTool({ name: 'spine_register_workspace', arguments: { rootPath: process.cwd(), projectId: 'explicit-test' } })); assert.equal(registered.projectId, 'explicit-test');
    const summary = decode(await client.callTool({ name: 'spine_get_document_summary', arguments: { projectId: 'explicit-test', filePath: 'example-json/skeleton-4.1.json' } })); assert.equal(summary.version, '4.1.24');
    const result = decode(await client.callTool({ name: 'spine_render_contact_sheet', arguments: { projectId: 'explicit-test', filePath: 'example-json/skeleton-4.1.json', atlasPath: 'preview/xiaoren.atlas', animation: 'walktest2', frames: 2, width: 64, height: 64 } })); assert.match(result.contactSheet, /png$/); assert.equal(result.trajectories, undefined);
    const bad = await client.callTool({ name: 'spine_get_document_summary', arguments: { projectId: 'missing', filePath: 'foo.json' } }); assert.equal(bad.isError, true);
    const outside = await client.callTool({ name: 'spine_render_animation_frames', arguments: { projectId: 'explicit-test', filePath: 'example-json/skeleton-4.1.json', atlasPath: 'preview/xiaoren.atlas', animation: 'walktest2', outputDir: '../outside' } }); assert.equal(outside.isError, true);
  } finally { await client.close(); await rm(temp, { recursive: true, force: true }); }
});
