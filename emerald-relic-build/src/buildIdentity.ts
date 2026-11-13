import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectHash, strictHash } from './hostContracts.js';

async function sourceFiles(directory:string,out:string[]=[]):Promise<string[]> {
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const full=path.join(directory,entry.name);
    if(entry.isDirectory())await sourceFiles(full,out);
    else if(entry.name.endsWith('.ts'))out.push(full);
  }
  return out;
}

async function currentSourceFingerprint(root:string){
  const files=[...(await sourceFiles(path.join(root,'src'))),path.join(root,'package.json'),path.join(root,'package-lock.json'),path.join(root,'preview','host.html')].sort();
  const entries=await Promise.all(files.map(async file=>({file:path.relative(root,file).replaceAll('\\','/'),hash:strictHash(await readFile(file))})));
  return objectHash(entries);
}

/** 每进程首次加载时冻结，不把磁盘后来生成的文件冒充已经加载的构建。 */
export const runtimeBuildIdentity=(async()=>{
  const modulePath=fileURLToPath(import.meta.url),directory=path.dirname(modulePath),extension=path.extname(modulePath);
  const files=(await readdir(directory)).filter(f=>f.endsWith(extension)).sort();
  const modules=await Promise.all(files.map(async file=>({file,hash:strictHash(await readFile(path.join(directory,file)))})));
  const root=path.dirname(directory),metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),sourceFingerprint=await currentSourceFingerprint(root);
  const previewHash=strictHash(await readFile(path.join(root,'preview/host.html')));
  let stamp:any=null;try{stamp=JSON.parse(await readFile(path.join(root,'dist','build-stamp.json'),'utf8'));}catch{}
  const kind=extension==='.js'?'compiled':'source';
  return {name:metadata.name,version:metadata.version,kind,buildFingerprint:objectHash({modules,previewHash,dependencies:metadata.dependencies}),sourceFingerprint,compiledBuildFingerprint:stamp?.compiledBuildFingerprint??null,stale:kind==='compiled'&&stamp?.sourceFingerprint!==sourceFingerprint,moduleCount:files.length};
})();

/** 源码版与编译版跨进程共享的构建 lineage；用于证据绑定，不替代执行文件指纹。 */
export const runtimeBuildLineage=(async()=>{
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const lockPath=path.join(root,'package-lock.json');
  let lockHash:string|null=null;
  try{lockHash=strictHash(await readFile(lockPath));}catch{}
  return {name:metadata.name,version:metadata.version,dependencies:metadata.dependencies,lockHash,nodeMajorMinor:process.versions.node.split('.').slice(0,2).join('.'),lineageFingerprint:objectHash({name:metadata.name,version:metadata.version,dependencies:metadata.dependencies,lockHash,nodeMajorMinor:process.versions.node.split('.').slice(0,2).join('.')})};
})();
