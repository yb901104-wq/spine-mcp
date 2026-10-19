import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import {configureAgent} from '../src/agentConfigTools.js';
import {AgentConnectionMonitor,CONNECTION_TTL_MS} from '../src/agentConnectionMonitor.js';
import {getAgentConnectionStatus} from '../src/agentTools.js';
import {getPreviewSession} from '../src/sessionTools.js';
test('new project preview selects its own character and empty project never uses missing demo paths',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-default-preview-')),ctx={workspaceRoot:root};
 try {
  const empty=await getPreviewSession({},ctx);assert.equal(empty.context.filePath,'');assert.equal(empty.context.autoload,false);
  await mkdir(path.join(root,'目标'));await writeFile(path.join(root,'目标/npc1.json'),JSON.stringify({bones:[{name:'root'}],animations:{idle:{}}}));await writeFile(path.join(root,'目标/npc1.atlas'),'');
  const own=await getPreviewSession({},ctx);assert.equal(own.context.filePath,'目标/npc1.json');assert.equal(own.context.atlasPath,'目标/npc1.atlas');assert.equal(own.context.animation,'idle');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('one-click configuration preserves unrelated settings, backs up, refuses stale hash, and is idempotent',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-config-')),ctx={workspaceRoot:root};
 try {
  await mkdir(path.join(root,'.codex'));const original='# comment\nmodel = "test-model"\n[mcp_servers.other]\ncommand = "other"\n';await writeFile(path.join(root,'.codex/config.toml'),original);
  const preview=await configureAgent({clientType:'codex'},ctx);assert.equal(await readFile(preview.targetPath,'utf8'),original);
  await assert.rejects(()=>configureAgent({clientType:'codex',dryRun:false,expectedHash:'stale'},ctx),/配置已变化/);
  const written=await configureAgent({clientType:'codex',dryRun:false,expectedHash:preview.expectedHash},ctx);
  assert.equal(await readFile(written.backupPath!,'utf8'),original);const parsed:any=TOML.parse(await readFile(written.targetPath,'utf8'));assert.equal(parsed.model,'test-model');assert.equal(parsed.mcp_servers.other.command,'other');assert.equal(parsed.mcp_servers['spine-json-mcp'].env.SPINE_MCP_WORKSPACE,root);
  const again=await configureAgent({clientType:'codex'},ctx);assert.equal((await configureAgent({clientType:'codex',dryRun:false,expectedHash:again.expectedHash},ctx)).wroteFile,false);
  for(const clientType of ['claude-code','opencode'] as const){const p=await configureAgent({clientType},ctx);const w=await configureAgent({clientType,dryRun:false,expectedHash:p.expectedHash},ctx);const j=JSON.parse(await readFile(w.targetPath,'utf8'));if(clientType==='opencode')assert.ok(Array.isArray(j.mcp['spine-json-mcp'].command));else assert.equal(j.mcpServers['spine-json-mcp'].command,process.execPath);}
  await writeFile(path.join(root,'.mcp.json'),'{ broken');await assert.rejects(()=>configureAgent({clientType:'claude-code'},ctx));
  await writeFile(path.join(root,'opencode.jsonc'),'{}');await assert.rejects(()=>configureAgent({clientType:'opencode'},ctx),/jsonc/);
  const user=await configureAgent({clientType:'codex',scope:'user'},ctx,path.join(root,'fake-home'));assert.equal(user.targetPath,path.join(root,'fake-home','.codex','config.toml'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('live monitor expires, reports failed pings, restores green and isolates multiple sessions',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-live-')),ctx={workspaceRoot:root};let healthy=true;
 const monitor=new AgentConnectionMonitor(async()=>{if(!healthy)throw Error('offline');},'Codex','codex',600000);
 const second=new AgentConnectionMonitor(async()=>{},'Codex second','codex',600000);
 try{
  await monitor.start(ctx);assert.equal((await getAgentConnectionStatus({clientType:'codex'},ctx)).selected?.light,'green');
  healthy=false;await monitor.check();assert.equal((await getAgentConnectionStatus({clientType:'codex'},ctx)).selected?.light,'yellow');
  healthy=true;await monitor.check();await second.start(ctx);await monitor.stop();assert.equal((await getAgentConnectionStatus({clientType:'codex'},ctx)).selected?.light,'green');
  const file=path.join(root,'.spine-mcp/connections',second.sessionId+'.json'),j=JSON.parse(await readFile(file,'utf8'));j.lastSeenAt=new Date(Date.now()-CONNECTION_TTL_MS-1).toISOString();await writeFile(file,JSON.stringify(j));assert.equal((await getAgentConnectionStatus({clientType:'codex'},ctx)).selected?.light,'red');
  await second.check();await second.stop();assert.equal((await getAgentConnectionStatus({clientType:'codex'},ctx)).selected?.light,'red');
 }finally{await monitor.stop();await second.stop();await rm(root,{recursive:true,force:true});}
});
