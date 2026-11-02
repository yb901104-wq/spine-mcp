import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {withHostFixture} from './helpers/hostFixture.js';
import {startHostServer} from '../src/hostServer.js';
import {HostClient} from '../src/hostClient.js';
import {HostEditorStore} from '../src/hostEditorStore.js';

test('并发发现逐次读取端口及 control：实例/会话错配不授权，恢复后不复用上一轮凭据',async()=>withHostFixture(async({root,context})=>{
 const host=await startHostServer(context),client=new HostClient(context),controlPath=path.join(root,'.spine-mcp/host-control.json'),portPath=path.join(root,'.spine-mcp/host-port.json');
 const controlRaw=await readFile(controlPath),portRaw=await readFile(portPath),control=JSON.parse(controlRaw.toString()),port=JSON.parse(portRaw.toString());
 try{
  const opened=await client.open({path:'a.pose.json'});assert.equal((await client.state()).available,true);assert.deepEqual((await client.rpc('/api/snapshot',{expectedRevision:opened.version},true)).version,opened.version);
  for(const change of [{sessionId:'wrong'},{instanceId:'wrong'},{control:'invalid'}]){
   await writeFile(controlPath,JSON.stringify({...control,...change}));assert.equal(await client.ensurePreview(),true);
   await assert.rejects(client.rpc('/api/snapshot',{expectedRevision:opened.version},true),{code:'CONTROL_REQUIRED'});
  }
  await writeFile(controlPath,controlRaw);await client.ensurePreview();assert.deepEqual((await client.rpc('/api/snapshot',{expectedRevision:opened.version},true)).version,opened.version);
  for(const change of [{sessionId:'wrong'},{instanceId:'wrong'},{startedAt:'wrong'},{projectId:'wrong',sessionId:'wrong'}]){
   await writeFile(portPath,JSON.stringify({...port,...change}));await assert.rejects(client.ensurePreview(),{code:'PROJECT_BINDING_CONFLICT'});
  }
  await writeFile(portPath,'{');await assert.rejects(client.ensurePreview(),{code:'HOST_UNAVAILABLE'});
  await writeFile(portPath,portRaw);assert.equal((await client.state()).targetStale,false);
 }finally{await writeFile(controlPath,controlRaw);await writeFile(portPath,portRaw);await host.stop();}
}));

test('状态核验途中切换文档：旧依赖检查不能将新文档标记为已核验，重查恢复严格状态',async()=>withHostFixture(async({context})=>{
 const store=new HostEditorStore(context);await store.open({path:'a.pose.json'});const oldVersion=structuredClone(store.active!.version),original=store.assertFresh.bind(store);
 let started!:()=>void,release!:()=>void,first=true;const begun=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>release=resolve);
 store.assertFresh=async(...args:Parameters<typeof store.assertFresh>)=>{if(first){first=false;started();await gate;}return original(...args);};
 const pending=store.state();
 try{
  await begun;await store.open({path:'b.pose.json',expectedRevision:oldVersion});release();
  const raced=await pending;assert.equal(raced.activeDoc.path,'b.pose.json');assert.equal(raced.targetStale,true);assert.equal(raced.staleReason.code,'TARGET_DRIFT');
  const next=await store.state();assert.equal(next.targetStale,false);assert.deepEqual(next.version,store.active!.version);
 }finally{release();store.assertFresh=original;await pending.catch(()=>{});await store.shutdown();}
}));
