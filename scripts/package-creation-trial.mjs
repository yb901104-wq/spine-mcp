// 打包工程与受控隔离启动入口；不携带角色、用户配置、journal、Writer、批准令牌或 node_modules。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const buildDirectory=process.env.SPINE_VALIDATION_BUILD??'dist';
const destination=path.resolve(process.argv[2]??'');if(!process.argv[2])throw Error('必须提供一个尚不存在的试用包输出目录。');
try{await fs.access(destination);throw Error('输出目录已存在；不合并或覆盖。');}catch(error){if(error.code!=='ENOENT')throw error;}
const {runtimeBuildIdentity}=await import(pathToFileURL(path.resolve(buildDirectory,'buildIdentity.js')).href),build=await runtimeBuildIdentity,pkg=JSON.parse(await fs.readFile('package.json','utf8'));
const files=[];
async function copy(source,target){const raw=await fs.readFile(source),absolute=path.join(destination,target);await fs.mkdir(path.dirname(absolute),{recursive:true});await fs.writeFile(absolute,raw,{flag:'wx'});files.push({path:target,hash:createHash('sha256').update(raw).digest('hex'),bytes:raw.length});}
async function tree(source,target){for(const item of await fs.readdir(source,{withFileTypes:true})){if(item.isSymbolicLink())throw Error('包输入不接受符号链接。');if(item.isDirectory())await tree(path.join(source,item.name),target+'/'+item.name);else await copy(path.join(source,item.name),target+'/'+item.name);}}
await fs.mkdir(destination,{recursive:true});
await tree(buildDirectory,'dist');await tree('preview','preview');await tree('policies','policies');
// 三个合成黄金帧是渲染器回归依据，不是用户角色或动作批准；随包保留原始捕获和版本登记。
await tree('test/golden/host','test/golden/host');
for(const file of ['package.json','package-lock.json','AGENTS.md'])await copy(file,file);
await copy('scripts/run-creation-trial.mjs','scripts/run-creation-trial.mjs');
for(const file of ['MCP操作清单.md','安全提交流程.md','浏览器预览系统.md','WinForms观察平台设计.md','自然语言验证用例.md','官方JSON规范审查.md'])await copy('docs/'+file,'docs/'+file);
await copy('docs/plans/creation-usability.md','docs/plans/creation-usability.md');
await copy('docs/plans/creation-completion-review-20261027.md','docs/plans/creation-completion-review-20261027.md');
const readme=`# Spine MCP 隔离创作试用包\n\n本包只用于隔离试用，版本 ${pkg.version}，构建 ${build.buildFingerprint}。不授予生产写入资格，不包含角色工程、用户配置或旧批准。\n\n1. 安装 Node.js 20 或更新版本，在包目录手动执行 \`npm ci --omit=dev\`。\n2. 通过正式 MCP \`spine_start_creation_task\` 的 \`isolatedDirectory\` 创建新副本；不要复制旧 journal 充当干净工程。\n3. 执行 \`node scripts/run-creation-trial.mjs --verify-only\` 检查版本和文件。\n4. 执行 \`node scripts/run-creation-trial.mjs --workspace <隔离工程绝对路径>\`；控制台返回本地页面地址。默认端口由正式 Host 分配，也可明确 \`--port\`。\n5. Agent 的 MCP 命令是 \`node <包绝对路径>/dist/server.js\`，环境变量 \`SPINE_MCP_WORKSPACE\` 指向隔离工程，\`SPINE_HOST_AUTOSTART=0\`。本包不修改全局 Agent 配置。\n6. 恢复旧会话先查看来源和差异，再显式加 \`--resume\`。独立内存诊断另用 \`spine_resume_diagnostic_pose\` 先预演；重启不恢复旧截图或批准。\n7. 结束前调用 Host 正式关闭入口并确认 Writer 释放。编辑器导入失败先恢复确认可用的备份，再制作；不要继续修改错误 JSON。\n\n默认 dryRun、Spine 4.1.24 时间线边界、备份、唯一 Writer 与官方 JSON 审查继续执行。播放不产生批准。新校准、完整动作、第二角色及编辑器验收按工单分别记录；本包本身不是作品交付证明。\n`;
await fs.writeFile(path.join(destination,'试用说明.md'),readme,{flag:'wx'});files.push({path:'试用说明.md',hash:createHash('sha256').update(readme).digest('hex'),bytes:Buffer.byteLength(readme)});
const manifest={format:'spine-creation-isolated-trial',schemaVersion:1,createdAt:new Date().toISOString(),version:pkg.version,build,sourceBuildDirectory:buildDirectory,files:files.sort((a,b)=>a.path.localeCompare(b.path)),includesNodeModules:false,includesCharacter:false,productionEnabled:false};
await fs.writeFile(path.join(destination,'trial-package.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({destination,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),buildFingerprint:build.buildFingerprint,productionEnabled:false}));
