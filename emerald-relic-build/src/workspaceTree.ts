import { opendir,lstat,readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspacePath,type ToolContext } from './spineJson.js';
import { getWorkspaceRoot } from './workspaceTools.js';
import { objectHash } from './hostContracts.js';
import { ToolError } from './toolError.js';
import { poseDigest } from './poseDigest.js';
export const WORKSPACE_IGNORES=['node_modules','.git','.spine-mcp','.aws','.codex','.agents','dist','previews','backups','releases','test-output','coverage'];
const pages=new Map<string,{key:string;created:number;entries:any[];counts:any;truncated:boolean}>();
export function relativeInput(value:string,allowRoot=false){
  if(typeof value!=='string'||(!value&&!allowRoot)||/[:\x00-\x1f]/.test(value)||path.win32.isAbsolute(value)||path.posix.isAbsolute(value)||value.replace(/\\/g,'/').split('/').some(p=>p==='..'))throw new ToolError('IO','路径必须在当前工作区内，禁止绝对路径和上级目录。','io');
  return value.replace(/\\/g,'/');
}
export async function getWorkspaceTree(args:any={},context:ToolContext={}){
  const root=relativeInput(args.root??'',true),depth=args.depth??3,limit=args.maxEntries??500,pageSize=args.pageSize??500;
  if(!Number.isInteger(depth)||depth<0||depth>6||!Number.isInteger(limit)||limit<1||limit>2000||!Number.isInteger(pageSize)||pageSize<1||pageSize>500)throw new ToolError('VALIDATION_FAILED','depth 需 0–6，maxEntries 需 1–2000，pageSize 需 1–500。');
  const base=path.resolve(context.workspaceRoot??getWorkspaceRoot(context.projectId)),absolute=root&&root!=='.'?resolveWorkspacePath(root,{...context,workspaceRoot:base}):base;
  const key=objectHash({base,root,depth,limit,details:!!args.details,kinds:args.kinds??null});
  let id:string,offset=0,record:any;
  if(args.cursor){
    try{const cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());id=cursor.id;offset=cursor.offset;record=pages.get(id);if(!record||record.key!==key||Date.now()-record.created>60000||!Number.isInteger(offset)||offset<0||offset>record.entries.length)throw Error();}
    catch{throw new ToolError('CONFLICT','工程树游标过期或属于不同查询，请从第一页重新读取。');}
  }else{
    if(!(await lstat(absolute)).isDirectory())throw new ToolError('IO','工程树 root 必须是目录。','io');
    const entries:any[]=[],counts={directories:0,files:0,dirsVisited:0,metadataReads:0,entriesVisited:0},start=Date.now();let truncated=false;
    const walk=async(dir:string,level:number):Promise<void>=>{
      if(counts.dirsVisited>=40||entries.length>=limit){truncated=true;return;}counts.dirsVisited++;
      const children=[];
      for await(const child of await opendir(dir)){if(counts.entriesVisited>=limit){truncated=true;break;}counts.entriesVisited++;children.push(child);}
      children.sort((a,b)=>a.name.localeCompare(b.name,'en'));
      for(const child of children){
        if(entries.length>=limit){truncated=true;break;}
        if(WORKSPACE_IGNORES.includes(child.name)||child.name.startsWith('.env')||child.isSymbolicLink())continue;
        const full=path.join(dir,child.name),relative=path.relative(base,full).replace(/\\/g,'/'),type=child.isDirectory()?'directory':'file';
        if(!child.isDirectory()&&!child.isFile())continue;
        const entry:any={path:relative,type};
        if(type==='file'){
          entry.kind=/\.pose\.json$/i.test(child.name)?'pose':/\.motion\.json$/i.test(child.name)?'motion':/\.atlas$/i.test(child.name)?'atlas':/\.(png|jpe?g|webp)$/i.test(child.name)?'image':child.name.endsWith('.json')?'json':'file';
          if(args.details&&counts.metadataReads<50&&Date.now()-start<250){
            const stat=await lstat(full);entry.size=stat.size;entry.mtime=stat.mtimeMs;counts.metadataReads++;
            if(child.name.endsWith('.json')&&stat.size<=1024*1024){
              try{const value=JSON.parse(await readFile(resolveWorkspacePath(relative,{...context,workspaceRoot:base}),'utf8'));entry.kind=value.skeleton?.spine?'skeleton':value.frame&&['standing','action'].includes(value.kind)?'pose':value.observation?'reference':value.nodes&&value.segments?'rig':value.duration&&value.frames?'motion':entry.kind;
                if(entry.kind==='pose'){const digest=await poseDigest(value,{...context,workspaceRoot:base});entry.fingerprint=digest.inputFingerprint;entry.status=digest.freshness;}
              }catch{entry.status='unverifiable';}
            }
          }
          counts.files++;
        }else counts.directories++;
        if(!args.kinds||type==='directory'||args.kinds.includes(entry.kind))entries.push(entry);
        if(type==='directory'&&level<depth&&counts.entriesVisited<limit)await walk(full,level+1);
      }
    };
    await walk(absolute,0);id=randomUUID();record={key,created:Date.now(),entries,counts,truncated};pages.set(id!,record);
    while(pages.size>16)pages.delete(pages.keys().next().value!);
  }
  const entries:any[]=[];let bytes=0;
  for(const entry of record.entries.slice(offset,offset+pageSize)){const size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>48000)break;bytes+=size;entries.push(entry);}
  const next=offset+entries.length,nextCursor=next<record.entries.length?Buffer.from(JSON.stringify({id:id!,offset:next})).toString('base64url'):null;
  return{ok:true,entries,counts:record.counts,truncated:record.truncated,nextCursor,ignored:WORKSPACE_IGNORES,note:'只读有界目录快照；游标有效 60 秒，不跟随链接，不执行求解。'};
}
