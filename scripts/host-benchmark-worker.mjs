// 仅供性能脚本的 IPC 子进程；不能作为生产 C2 启动入口。
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {startHostServer} from '../dist/hostServer.js';
import {hostBuildFingerprint} from '../dist/hostReleaseEvidence.js';
import {strictHash} from '../dist/hostContracts.js';
import {resolveWorkspacePath} from '../dist/spineJson.js';
assert.ok(process.send&&process.connected,'性能 worker 必须由测试驱动通过 IPC 启动。');
const evidence=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.equal(evidence.passed,true);assert.equal(evidence.allInputsUnchanged,true);assert.ok(evidence.sourceWorkspace);assert.equal(evidence.native.checks.length,29);
const root=path.resolve(evidence.artifactDir,'workspace');assert.notEqual(root,path.resolve(evidence.sourceWorkspace));
const manifest=JSON.parse(await readFile(path.join(root,'.spine-workflow.json'),'utf8')),context={workspaceRoot:root,projectId:manifest.projectId};
for(const [file,hash]of Object.entries(evidence.inputHashes))assert.equal(strictHash(await readFile(resolveWorkspacePath(file,context))),hash);
process.env.SPINE_MCP_WORKSPACE=root;process.env.SPINE_MCP_REGISTRY_ROOT=root;
const host=await startHostServer(context,{developmentProfile:'c2-pose',writeEnabled:true});let closing;
function stop(){return closing??=(async()=>{try{await host.stop();if(process.connected)process.send({type:'stopped'});}catch(error){if(process.connected)process.send({type:'error',message:String(error)});process.exitCode=1;}finally{if(process.connected)process.disconnect();}})();}
process.on('message',message=>{if(message?.type==='stop')void stop();});process.on('disconnect',()=>void stop());
process.send({type:'ready',pid:process.pid,build:await hostBuildFingerprint()});
