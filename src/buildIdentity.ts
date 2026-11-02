import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectHash, strictHash } from './hostContracts.js';

/** 每进程首次加载时冻结，不把磁盘后来生成的文件冒充已经加载的构建。 */
export const runtimeBuildIdentity=(async()=>{
  const directory=path.dirname(fileURLToPath(import.meta.url)),extension=path.extname(fileURLToPath(import.meta.url));
  const files=(await readdir(directory)).filter(f=>f.endsWith(extension)).sort();
  const modules=await Promise.all(files.map(async file=>({file,hash:strictHash(await readFile(path.join(directory,file)))})));
  const root=path.dirname(directory),metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const previewHash=strictHash(await readFile(path.join(root,'preview/host.html')));
  return {name:metadata.name,version:metadata.version,kind:extension==='.js'?'compiled':'source',buildFingerprint:objectHash({modules,previewHash,dependencies:metadata.dependencies}),moduleCount:files.length};
})();
