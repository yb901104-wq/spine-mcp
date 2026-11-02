// 隔离试用包入口：先验证包内字节与构建，再调用正式 Host 入口。
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'trial-package.json'),'utf8'));
if(manifest.format!=='spine-creation-isolated-trial'||manifest.schemaVersion!==1)throw Error('试用包清单不兼容。');
if(Number(process.versions.node.split('.')[0])<20)throw Error('需要 Node.js 20 或更新版本。');
for(const item of manifest.files){
 if(typeof item.path!=='string'||path.isAbsolute(item.path)||item.path.split(/[\\/]/).some(p=>!p||p==='..'||p==='.')||item.path.includes(':'))throw Error('试用包包含不安全路径。');
 const target=await fs.realpath(path.join(root,item.path));if(!target.toLowerCase().startsWith(root.toLowerCase()+path.sep))throw Error('试用包文件越界。');
 if(createHash('sha256').update(await fs.readFile(target)).digest('hex')!==item.hash)throw Error('试用包字节发生变化：'+item.path);
}
const actualBuild=await(await import(pathToFileURL(path.join(root,'dist/buildIdentity.js')).href)).runtimeBuildIdentity;if(actualBuild.buildFingerprint!==manifest.build.buildFingerprint)throw Error('实际运行模块与试用包构建指纹不同。');
console.log(JSON.stringify({type:'trial-package-verified',version:manifest.version,buildFingerprint:manifest.build.buildFingerprint,fileCount:manifest.files.length,productionEnabled:false}));
if(process.argv.includes('--verify-only'))process.exit(0);
try{await fs.access(path.join(root,'node_modules/@modelcontextprotocol/sdk/package.json'));}catch{throw Error('试用包尚未准备依赖；请先在此目录执行 npm ci --omit=dev。启动器不会静默安装。');}
const args=process.argv.slice(2);if(!args.includes('--workspace')||args.some((v,i)=>!['--workspace','--resume','--port'].includes(v)&&!['--workspace','--port'].includes(args[i-1])))throw Error('用法：node scripts/run-creation-trial.mjs --workspace <正式工具生成的新隔离副本> [--resume] [--port <端口>]。');
const child=spawn(process.execPath,[path.join(root,'dist/creationTrialServer.js'),...args,'--isolated'],{cwd:root,stdio:'inherit',windowsHide:true});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
