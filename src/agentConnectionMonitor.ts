import {mkdir,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {resolveWorkspacePath,type ToolContext} from './spineJson.js';
import type {AgentClientType} from './agentTools.js';
import {getWorkspaceRoot} from './workspaceTools.js';
export const CONNECTION_TTL_MS=25000;
export class AgentConnectionMonitor {
  readonly sessionId=randomUUID();private contexts=new Map<string,ToolContext>();private timer?:NodeJS.Timeout;private closed=false;private running?:Promise<void>;
  private lastSeenAt:string|null=null;private status='connecting';private error:string|null=null;
  private writes:Promise<void>=Promise.resolve();
  constructor(private ping:()=>Promise<unknown>,private agentName:string,private clientType:AgentClientType,private intervalMs=10000){}
  async bind(context:ToolContext={}){const root=path.resolve(context.workspaceRoot??getWorkspaceRoot(context.projectId));this.contexts.set(root,{...context,workspaceRoot:root});await this.persist();}
  async identify(clientType:AgentClientType,context:ToolContext={}){this.clientType=clientType;await this.bind(context);}
  async start(context:ToolContext={}){await this.bind(context);await this.check();if(!this.closed){this.timer=setInterval(()=>void this.check().catch(()=>{}),this.intervalMs);this.timer.unref();}}
  check(){if(this.running)return this.running;this.running=this.checkOnce().finally(()=>{this.running=undefined;});return this.running;}
  private async checkOnce(){if(this.closed)return;try{await this.ping();if(this.closed)return;this.lastSeenAt=new Date().toISOString();this.status='connected';this.error=null;}catch(e){if(this.closed)return;this.status='unresponsive';this.error=String(e);}await this.persist();}
  async stop(){this.closed=true;if(this.timer)clearInterval(this.timer);await this.running;this.status='disconnected';await this.persist();}
  private persist(){const task=this.writes.then(()=>this.persistNow());this.writes=task.catch(()=>{});return task;}
  private async persistNow(){for(const context of this.contexts.values()){const file=resolveWorkspacePath(`.spine-mcp/connections/${this.sessionId}.json`,context);await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify({sessionId:this.sessionId,pid:process.pid,clientType:this.clientType,agentName:this.agentName,status:this.status,lastSeenAt:this.lastSeenAt,checkedAt:new Date().toISOString(),error:this.error}));for(let i=0;;i++){try{await rename(temp,file);break;}catch(e:any){if(i>=3||!['EPERM','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,25));}}}}
}
