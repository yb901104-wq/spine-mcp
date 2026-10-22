import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withHostFixture } from './helpers/hostFixture.js';
import { HostEditorStore } from '../src/hostEditorStore.js';
import { readWriter, recoverDeadWriter } from '../src/writerOwnership.js';
import { HostClient } from '../src/hostClient.js';
test('真实进程强杀：不按离线接管；明确核对死亡后恢复 journal，磁盘漂移和半行分别归档',async()=>withHostFixture(async({root,context})=>{
  const code=`import{HostEditorStore}from'./src/hostEditorStore.ts';const s=new HostEditorStore(${JSON.stringify(context)});await s.enableWriting();await s.open({path:'a.pose.json'});await s.pin(s.active.version);await s.patch({expectedRevision:s.active.version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',x:.08}],dryRun:false});console.log('JOURNAL_READY');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,SPINE_MCP_WORKSPACE:root},stdio:['ignore','pipe','pipe'],windowsHide:true});
  try{
    await new Promise<void>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('子进程未准备完成')),10000);child.stdout!.on('data',part=>{output+=part;if(output.includes('JOURNAL_READY')){clearTimeout(timer);resolve();}});child.once('error',reject);child.once('exit',()=>{if(!output.includes('JOURNAL_READY')){clearTimeout(timer);reject(Error('子进程提前退出'));}});});
    const lease=(await readWriter(context))!;await assert.rejects(recoverDeadWriter(context,lease),/保持冻结/);
    const client=new HostClient(context);assert.equal((await client.state()).writeMode,'frozen');
    const exit=once(child,'exit');child.kill('SIGKILL');await exit;
    assert.equal((await client.state()).writeMode,'frozen');
    await recoverDeadWriter(context,lease);
    const recovered=new HostEditorStore(context);await recovered.enableWriting();
    try{
      assert.ok(recovered.writer!.generation>lease.generation);await recovered.open({path:'a.pose.json'});assert.equal(recovered.active!.value.frame.targets.leftHand.x,.08);assert.equal(recovered.active!.uncommitted,true);assert.equal(recovered.pinned,null);
    }finally{await recovered.shutdown();}
    const original=JSON.parse(await readFile(path.join(root,'a.pose.json'),'utf8'));original.frame.body.y+=.2;await writeFile(path.join(root,'a.pose.json'),JSON.stringify(original));
    const diskWins=new HostEditorStore(context);await diskWins.enableWriting();
    try{
      await diskWins.open({path:'a.pose.json'});assert.equal(diskWins.active!.uncommitted,false);assert.equal(diskWins.active!.value.frame.body.y,original.frame.body.y);
      assert.ok((await readdir(path.join(root,'.spine-mcp/journals'))).some(f=>f.includes('.rejected-')));
      await diskWins.pin(diskWins.active!.version);await diskWins.patch({expectedRevision:diskWins.active!.version,ops:[{op:'setPoseTarget',path:'pose/frame/targets/leftHand',role:'leftHand',x:.09}],dryRun:false});
      await appendFile(path.join(root,'.spine-mcp/journals',diskWins.active!.version.documentId+'.jsonl'),'{');
    }finally{await diskWins.shutdown();}
    const corrupt=new HostEditorStore(context);await corrupt.enableWriting();try{await corrupt.open({path:'a.pose.json'});assert.equal(corrupt.active!.uncommitted,false);assert.ok((await readdir(path.join(root,'.spine-mcp/journals'))).some(f=>f.includes('.corrupt-')));}finally{await corrupt.shutdown();}
  }finally{if(child.exitCode===null&&!child.killed){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}}
}));
