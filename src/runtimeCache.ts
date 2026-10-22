import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile,stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Image } from '@napi-rs/canvas';
export type CacheMode='fast'|'strict';
const scope=new AsyncLocalStorage<CacheMode>();
const entries=new Map<string,{value:any;bytes:number}>();
let bytes=0;const limit=128*1024*1024;
const counters={hits:0,misses:0,strictReads:0,fastReads:0,documentParses:0,skeletonDataBuilds:0,imageLoads:0};
export const cacheHash=(raw:string|Buffer)=>createHash('sha256').update(raw).digest('hex');
export function cacheMode(){return scope.getStore()??'strict';}
export function withStrict<T>(fn:()=>T){return scope.run('strict',fn);}
export function withFast<T>(fn:()=>T){return scope.run('fast',fn);}
export function cachedValue<T>(key:string,build:()=>T,size:number):T{
  const old=entries.get(key);if(old){entries.delete(key);entries.set(key,old);counters.hits++;return old.value;}
  counters.misses++;const value=build();put(key,value,size);return value;
}
function put(key:string,value:any,size:number){
  const old=entries.get(key);if(old){bytes-=old.bytes;entries.delete(key);}
  if(size>limit)return;
  while(bytes+size>limit&&entries.size){const first=entries.keys().next().value!;bytes-=entries.get(first)!.bytes;entries.delete(first);}
  entries.set(key,{value,bytes:size});bytes+=size;
}
export async function cachedDocument(absolutePath:string,mode=cacheMode()){
  const key='doc:'+absolutePath,metadata=await stat(absolutePath),old=entries.get(key)?.value;
  if(mode==='fast'&&old?.mtime===metadata.mtimeMs&&old?.size===metadata.size){counters.fastReads++;counters.hits++;return{raw:old.raw,hash:old.hash,json:structuredClone(old.json),checked:'fast' as const};}
  counters.strictReads++;const raw=await readFile(absolutePath,'utf8'),hash=cacheHash(raw);
  if(old?.hash===hash){old.mtime=metadata.mtimeMs;old.size=metadata.size;counters.hits++;return{raw,hash,json:structuredClone(old.json),checked:'strict' as const};}
  counters.documentParses++;const json=JSON.parse(raw);put(key,{raw,hash,json,mtime:metadata.mtimeMs,size:metadata.size},Buffer.byteLength(raw)*8);
  return{raw,hash,json:structuredClone(json),checked:'strict' as const};
}
export function cachedRuntime<T>(key:string,build:()=>T,size:number){return cachedValue('runtime:'+key,()=>{counters.skeletonDataBuilds++;return build();},size);}
export async function cachedAtlasImage(key:string,build:()=>Promise<Image>,estimate:number){
  const id='image:'+key,old=entries.get(id);if(old){counters.hits++;entries.delete(id);entries.set(id,old);return old.value as Image;}
  counters.imageLoads++;const value=await build();put(id,value,Math.max(estimate,value.width*value.height*8));return value;
}
export function invalidate(absolutePath?:string){
  if(absolutePath){const key='doc:'+absolutePath,entry=entries.get(key);if(entry){bytes-=entry.bytes;entries.delete(key);}}
  else{entries.clear();bytes=0;}
}
export function cacheStats(){return{...counters,entries:entries.size,bytes,limitBytes:limit,defaultMode:'strict',note:'bytes 为保守记账，不等同进程 RSS；不缓存可变 Skeleton。'};}
