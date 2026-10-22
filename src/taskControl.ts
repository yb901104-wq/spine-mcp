import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { ToolError } from './toolError.js';
interface Control{signal?:AbortSignal;progress?:(current:number,total:number,message?:string)=>void;lastAt?:number}
const scope=new AsyncLocalStorage<Control>();
export function runTask<T>(control:Control,fn:()=>Promise<T>){return scope.run({...control,lastAt:0},fn);}
export function checkpoint(label='当前任务'){
  if(scope.getStore()?.signal?.aborted)throw new ToolError('CANCELLED',`${label}已取消；已完成的事务不会回滚。`,'cancelled');
}
export async function taskCheckpoint(label?:string){await yieldNow();checkpoint(label);}
export function reportProgress(current:number,total:number,message?:string){
  checkpoint(message);const control=scope.getStore();if(!control?.progress)return;
  const now=Date.now();if(current>=total||!control.lastAt||now-control.lastAt>=200){control.lastAt=now;control.progress(current,total,message);}
}
export function taskSignal(){return scope.getStore()?.signal;}
