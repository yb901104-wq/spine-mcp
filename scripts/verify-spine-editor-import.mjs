// 独立官方编辑器导入证据。只读取 MCP 的精确候选，在新产物目录创建 .spine，不改输入 JSON。
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {resolveWorkspacePath,validateSpineJson,validateOfficialAnimationSpec} from '../dist/spineJson.js';
import {strictHash} from '../dist/hostContracts.js';
const [workspaceRoot,candidatePath,expectedHash,outputDirectory]=process.argv.slice(2);
if(!workspaceRoot||!candidatePath||!/^[a-f0-9]{64}$/.test(expectedHash??'')||!outputDirectory)throw Error('用法：node scripts/verify-spine-editor-import.mjs <workspaceRoot> <candidatePath> <expectedHash> <新产物目录>');
const context={workspaceRoot:path.resolve(workspaceRoot)},input=resolveWorkspacePath(candidatePath,context),root=resolveWorkspacePath(outputDirectory,context);
const raw=await fs.readFile(input),json=JSON.parse(raw);if(strictHash(raw)!==expectedHash||json.skeleton?.spine!=='4.1.24')throw Error('候选哈希或版本不符，未启动编辑器。');
const structure=validateSpineJson(json),official=validateOfficialAnimationSpec(json);if(!structure.ok||!official.ok)throw Error('候选结构或官方 JSON 规范失败，未启动编辑器。');
const executable=process.env.SPINE_EDITOR_PATH??'D:/Program Files/Spine/Spine.com';
if(!/^Spine\.(?:exe|com)$/i.test(path.basename(executable)))throw Error('仅接受明确的官方 Spine 可执行文件，不执行任意程序。');
await fs.access(path.join(process.env.USERPROFILE??process.env.HOME,'Spine/updates/4.1.24'));
try{await fs.lstat(root);throw Error('产物目录已存在，拒绝覆盖。');}catch(error){if(error.code!=='ENOENT')throw error;}
await fs.mkdir(path.dirname(root),{recursive:true});await fs.mkdir(root);
const output=resolveWorkspacePath(path.posix.join(outputDirectory.replace(/\\/g,'/'),'candidate.spine'),context);
function sanitize(value){let skip=0;return value.split(/\r?\n/).filter(line=>{if(/^Licensed to:/i.test(line)){skip=2;return false;}if(skip){skip--;return false;}return true;}).join('\n').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[许可身份已省略]');}
async function run(args){return new Promise((resolve,reject)=>{const started=performance.now(),child=spawn(executable,args,{stdio:['ignore','pipe','pipe'],windowsHide:true}),chunks=[];let length=0;const timer=setTimeout(()=>{child.kill();reject(Error('编辑器超时，保留当前产物供诊断，不宣称导入通过。'));},60000);for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{length+=chunk.length;if(length>4*1024*1024){child.kill();reject(Error('编辑器输出超过上限。'));}else chunks.push(chunk);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({args,exitCode:code,signal,durationMs:performance.now()-started,output:sanitize(Buffer.concat(chunks).toString('utf8'))});});});}
const report={schemaVersion:1,at:new Date().toISOString(),workspaceRoot:context.workspaceRoot,candidatePath,candidateHash:expectedHash,outputDirectory,executable,officialBasis:'https://esotericsoftware.com/spine-command-line-interface#Import',scope:'官方 4.1.24 JSON 解析、工程保存；未验证编辑器画面/贴图，不代表完整参考动画批准。',visualReview:'notRun',referenceApproval:false,sourceUnchanged:false,passed:false};
try{
  report.version=await run(['-u','4.1.24','--version']);if(report.version.exitCode!==0||!report.version.output.includes('Spine 4.1.24'))throw Error('编辑器版本核验失败。');
  report.import=await run(['-u','4.1.24','-i',input,'-o',output,'--import']);if(report.import.exitCode!==0)throw Error('官方编辑器导入失败；不在错误 JSON 上修补，须从确认可用的输入重新制作。');
  const project=await fs.readFile(output);if(!project.length)throw Error('编辑器没有生成非空工程。');
  report.sourceUnchanged=strictHash(await fs.readFile(input))===expectedHash;if(!report.sourceUnchanged)throw Error('编辑器导入期间源候选发生变化。');
  report.project={path:path.relative(context.workspaceRoot,output).replace(/\\/g,'/'),hash:strictHash(project),bytes:project.length};report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
await fs.writeFile(path.join(root,'editor-import.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,reportPath:path.join(root,'editor-import.json'),project:report.project??null,error:report.error??null}));
