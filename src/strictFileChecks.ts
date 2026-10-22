import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export interface FileCheck { filePath:string; hash:string; actual:string|null; error?:unknown }
/** 每次重新读取字节；只并发独立文件，不复用上一轮结果，也不因失败提前遗留后台工作。 */
export async function strictFileChecks(files:ReadonlyArray<{filePath:string;hash:string}>,resolve:(file:string)=>string):Promise<FileCheck[]> {
  const results=new Array<FileCheck>(files.length);let next=0;
  const worker=async()=>{
    while(next<files.length){
      const index=next++,file=files[index];
      try{const bytes=await readFile(resolve(file.filePath));results[index]={...file,actual:createHash('sha256').update(bytes).digest('hex')};}
      catch(error){results[index]={...file,actual:null,error};}
    }
  };
  await Promise.all(Array.from({length:Math.min(8,files.length)},worker));
  return results;
}
