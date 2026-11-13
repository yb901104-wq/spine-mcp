import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import path from 'node:path';

export interface FileCheck { filePath:string; hash:string; actual:string|null; error?:unknown }
const batch=new AsyncLocalStorage<Map<string,Promise<string>>>();
/** 仅包围一次只读请求；调用方仍逐文件核验真实路径，不能跨请求或提交阶段复用。 */
export const withFileCheckBatch=<T>(fn:()=>Promise<T>)=>batch.run(new Map(),fn);
/** 每次重新读取字节；只并发独立文件，不复用上一轮结果，也不因失败提前遗留后台工作。 */
export async function strictFileChecks(files:ReadonlyArray<{filePath:string;hash:string}>,resolve:(file:string)=>string|Promise<string>):Promise<FileCheck[]> {
  const results=new Array<FileCheck>(files.length);let next=0;
  const worker=async()=>{
    while(next<files.length){
      const index=next++,file=files[index];
      try{
        const absolute=await resolve(file.filePath),scope=batch.getStore(),key=path.normalize(absolute);
        let reading=scope?.get(key);
        if(!reading){reading=readFile(absolute).then(bytes=>createHash('sha256').update(bytes).digest('hex'));scope?.set(key,reading);}
        results[index]={...file,actual:await reading};
      }
      catch(error){results[index]={...file,actual:null,error};}
    }
  };
  await Promise.all(Array.from({length:Math.min(8,files.length)},worker));
  return results;
}
