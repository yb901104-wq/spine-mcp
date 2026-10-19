import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('local configuration HTTP route requires explicit header, rejects foreign origin and uses reviewed hash',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-config-http-'));
 const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=(socket.address() as any).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
 const child=spawn(process.execPath,['dist/previewServer.js'],{env:{...process.env,SPINE_MCP_WORKSPACE:root,SPINE_PREVIEW_PORT:String(port)},stdio:['ignore','pipe','pipe'],windowsHide:true});
 const url=`http://127.0.0.1:${port}/api/agent-config`;const headers={'Content-Type':'application/json','X-Spine-Config-Action':'install'};
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('服务未启动')),5000);child.stdout.on('data',()=>{clearTimeout(timer);resolve();});child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);reject(Error('服务退出 '+code));});});
  const preview=await (await fetch(url+'?clientType=claude-code')).json() as any;
  const body=JSON.stringify({clientType:'claude-code',expectedHash:preview.expectedHash});
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://outside.invalid'},body})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({clientType:'claude-code',expectedHash:'stale'})})).status,500);
  const response=await fetch(url,{method:'POST',headers,body});assert.equal(response.status,200);const result=await response.json() as any;assert.equal(result.wroteFile,true);
  const config=JSON.parse(await readFile(path.join(root,'.mcp.json'),'utf8'));assert.equal(config.mcpServers['spine-json-mcp'].command,process.execPath);
 }finally{child.kill();await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});await rm(root,{recursive:true,force:true});}
});
