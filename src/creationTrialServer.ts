#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHostServer } from './hostServer.js';
import { getRegisteredWorkspace } from './workspaceTools.js';
import { HostJournal } from './hostJournal.js';
import { inputDiff } from './animationCommands.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { HostError, strictHash } from './hostContracts.js';

export async function describeCreationRecovery(context:ToolContext){
  let files:string[]=[];try{files=await readdir(resolveWorkspacePath('.spine-mcp/journals',context));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const result=[];
  for(const file of files.filter(f=>/^[a-f0-9]{64}\.jsonl$/.test(f)).sort()){
    const records=await new HostJournal(file.slice(0,-6),context).read(),header=records.find(r=>r.type==='header'),source=header?.diagnostic?.sourcePath??header?.docPath??records.find(r=>r.docPath)?.docPath;
    const edit=records.slice().reverse().find(r=>r.type==='edit');let diff:any[]=[],sourceHash:string|null=null;
    let sourceError:string|null=null,sourceToDiagnostic:any[]=[];
    if(source&&(edit||header?.diagnostic)){try{const raw=await readFile(resolveWorkspacePath(source,context));sourceHash=strictHash(raw);const value=JSON.parse(raw.toString('utf8'));if(header?.diagnostic){sourceToDiagnostic=inputDiff(value,header.diagnosticBaseline);if(edit)diff=inputDiff(header.diagnosticBaseline,edit.document);}else if(edit)diff=inputDiff(value,edit.document);}catch(error){sourceError=String(error);}}
    result.push({journal:`.spine-mcp/journals/${file}`,source:source??null,sourceHash,sourceError,lastEditRevision:edit?.revision??null,changeCount:diff.length,changes:diff.slice(0,50),truncated:diff.length>50,recordCount:records.length,...header?.diagnostic?{diagnosticId:header.documentId,memoryOnly:true,stageId:header.diagnostic.binding.stageId,referencePosePath:header.diagnostic.binding.referencePosePath,expectedSourceHash:header.diagnostic.sourceHash,sourceToDiagnosticChangeCount:sourceToDiagnostic.length,sourceToDiagnosticChanges:sourceToDiagnostic.slice(0,50),resumeTool:'spine_resume_diagnostic_pose',approved:false}:{} });
  }
  return result;
}
export async function startCreationTrial(args:string[]){
  const allowed=new Set(['--workspace','--isolated','--resume','--port']);for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw new HostError('INVALID_ARGUMENT',`未知参数 ${args[i]}。`);if(['--workspace','--port'].includes(args[i]))i++;}
  const workspace=args[args.indexOf('--workspace')+1];if(!args.includes('--workspace')||!workspace||!args.includes('--isolated'))throw new HostError('INVALID_ARGUMENT','用法：npm run host:creation -- --workspace <新隔离工作区> --isolated [--resume] [--port <端口>]。');
  const root=path.resolve(workspace),context:ToolContext={workspaceRoot:root};
  const isolation=JSON.parse(await readFile(resolveWorkspacePath('.spine-mcp/creation-isolation.json',context),'utf8'));
  if(isolation.schemaVersion!==1||isolation.journalCopied!==false||path.resolve(isolation.sourceRoot)===root)throw new HostError('PROJECT_BINDING_CONFLICT','缺少有效隔离来源，请先用 spine_start_creation_task isolatedDirectory 创建新副本。',409);
  // 仅读取创建副本时使用的工程登记位置；不更改用户的全局 Agent 配置。
  process.env.SPINE_MCP_REGISTRY_ROOT=isolation.registryRoot;process.env.SPINE_MCP_WORKSPACE=root;
  const registered=getRegisteredWorkspace(root);if(!registered)throw new HostError('PROJECT_NOT_REGISTERED','隔离副本尚未登记。',409);context.projectId=registered.projectId;
  const recovery=await describeCreationRecovery(context);
  console.log(JSON.stringify({type:'recovery-preview',workspaceRoot:root,sourceRoot:isolation.sourceRoot,recovery,mode:args.includes('--resume')?'explicitResume':'newSession'}));
  if(recovery.length&&!args.includes('--resume'))throw new HostError('RECOVERY_CHOICE_REQUIRED','存在旧 journal。已列出来源与差异；显式 --resume 才恢复，或创建全新隔离副本。',409);
  const port=args.includes('--port')?Number(args[args.indexOf('--port')+1]):0;if(!Number.isInteger(port)||port<0||port>65535)throw new HostError('INVALID_ARGUMENT','端口无效。');
  const host=await startHostServer(context,{port,writeEnabled:true,developmentProfile:'c2-pose',trialInfo:{isolated:true,sourceRoot:isolation.sourceRoot,recovery,resume:args.includes('--resume')}});
  console.log(JSON.stringify({type:'creation-host-ready',endpoint:host.endpoint,projectId:context.projectId,workspaceRoot:root,profile:'c2-pose',publicWriteEnabled:false}));
  return host;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startCreationTrial(process.argv.slice(2)).then(host=>{for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>{void host.stop();});}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
