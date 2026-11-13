import { readFile, mkdir, writeFile, rename, copyFile, unlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import TOML from '@iarna/toml';
import { getWorkspaceRoot } from './workspaceTools.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';

const serverName='spine-json-mcp';
export type ConfigClient='codex'|'claude-code'|'opencode';
export interface ConfigArgs {clientType:ConfigClient;scope?:'project'|'user';expectedHash?:string;dryRun?:boolean;}
export async function configureAgent(args:ConfigArgs,context:ToolContext={},userHome=os.homedir()) {
  if(!['codex','claude-code','opencode'].includes(args.clientType))throw new Error('自定义客户端请使用复制配置功能。');
  const workspace=path.resolve(context.workspaceRoot??getWorkspaceRoot(context.projectId)),scope=args.scope??'project';
  if(!['project','user'].includes(scope)||scope==='user'&&args.clientType!=='codex')throw new Error('用户级一键配置目前只支持 Codex。');
  const relative=args.clientType==='codex'?'.codex/config.toml':args.clientType==='claude-code'?'.mcp.json':'opencode.json';
  const codexHome=userHome===os.homedir()?(process.env.CODEX_HOME??path.join(userHome,'.codex')):path.join(userHome,'.codex');
  const target=scope==='user'?path.join(codexHome,'config.toml'):resolveWorkspacePath(relative,context);
  if(args.clientType==='opencode'&&existsSync(resolveWorkspacePath('opencode.jsonc',context)))throw new Error('检测到 opencode.jsonc；为保留注释和优先级，请使用复制配置，不能另建冲突配置。');
  // 拒绝链接配置文件/父目录，以免项目配置写到其他目录。
  let ancestor=target;while(!existsSync(ancestor))ancestor=path.dirname(ancestor);
  if(path.resolve(realpathSync(ancestor)).toLowerCase()!==path.resolve(ancestor).toLowerCase())throw new Error('配置路径包含符号链接或 junction，请使用实际项目路径。');
  let raw:string|undefined;try{raw=await readFile(target,'utf8');}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const hash=raw===undefined?'missing':createHash('sha256').update(raw).digest('hex');
  let config:any=raw===undefined?{}:args.clientType==='codex'?TOML.parse(raw.replace(/^\uFEFF/,'')):JSON.parse(raw.replace(/^\uFEFF/,''));
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('Agent 配置必须是对象。');
  const group=args.clientType==='codex'?'mcp_servers':args.clientType==='claude-code'?'mcpServers':'mcp';
  if(config[group]!==undefined&&(!config[group]||typeof config[group]!=='object'||Array.isArray(config[group])))throw new Error('已有 MCP 配置结构无效。');
  const serverJs=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','dist','server.js');
  if(!existsSync(serverJs))throw new Error('缺少 dist/server.js，请先构建项目。');
  const env={SPINE_MCP_WORKSPACE:workspace};
  const entry=args.clientType==='opencode'?{type:'local',command:[process.execPath,serverJs],environment:env,enabled:true}:{command:process.execPath,args:[serverJs],env,...(args.clientType==='codex'?{enabled:true}:{})};
  config[group]??={};const previous=config[group][serverName];config[group][serverName]=entry;
  const unchanged=isDeepStrictEqual(JSON.parse(JSON.stringify(previous??null)),entry);
  const content=args.clientType==='codex'?TOML.stringify(config):JSON.stringify(config,null,2)+'\n';
  const result={ok:true,dryRun:args.dryRun??true,targetPath:target,scope,clientType:args.clientType,expectedHash:hash,unchanged,replacesExisting:previous!==undefined,entry,note:args.clientType==='codex'?'写入会重新序列化 TOML；原始注释保留在备份。Codex 桌面建议用户级，项目配置只在受信任项目中加载。':'保留其他配置，仅更新 spine-json-mcp 条目。',nextStep:args.clientType==='codex'?'完全退出并重新打开 Codex，再检查 MCP 列表；写入配置不等于已连接。':'在所选 Agent 中打开同一项目并重新加载 MCP；配置写入不等于已连接。'};
  if(args.dryRun!==false)return result;
  if(args.expectedHash!==hash)throw new Error('配置已变化，请重新检测后写入。');
  if(unchanged)return {...result,wroteFile:false,backupPath:null};
  await mkdir(path.dirname(target),{recursive:true});
  const lock=await (await import('node:fs/promises')).open(target+'.spine-mcp.lock','wx');
  const temp=target+'.'+randomUUID()+'.tmp';let backupPath:string|null=null;
  try {
    let current:string|undefined;try{current=await readFile(target,'utf8');}catch(e:any){if(e.code!=='ENOENT')throw e;}
    if(current!==raw)throw new Error('配置在写入前被其他进程修改，请重试。');
    if(raw!==undefined){backupPath=target+'.spine-mcp-'+randomUUID()+'.bak';await copyFile(target,backupPath);}
    await writeFile(temp,content,{encoding:'utf8',flag:'wx'});await rename(temp,target);
    return {...result,wroteFile:true,backupPath};
  } finally {await lock.close();await unlink(target+'.spine-mcp.lock');await unlink(temp).catch(()=>{});}
}
