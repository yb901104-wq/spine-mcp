// 只读盘点现有姿态；confirmed 标签须经当前正式门禁复验，不能据旧标签批准。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,stat,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requireReviewedPose,solvePoseData } from '../src/poseWorkflow.js';
const workspace=path.resolve(process.argv[2]??'D:/AI_cc/spine test'),context={workspaceRoot:workspace};
const found=await promisify(execFile)('rg',['--files','-g','*pose.json','-g','*standing*.json','-g','!backups/**','-g','!node_modules/**','-g','!dist/**','-g','!**/calls/**'],{cwd:workspace,maxBuffer:2*1024*1024});
const paths=found.stdout.split(/\r?\n/).filter(Boolean),records:any[]=[];
for(const file of paths.slice(0,500)){
  if((await stat(path.join(workspace,file))).size>1024*1024)continue;
  let pose:any;try{pose=JSON.parse(await readFile(path.join(workspace,file),'utf8'));}catch{continue;}
  if(!['standing','action'].includes(pose.kind)||!pose.frame)continue;
  const record:any={path:file.replace(/\\/g,'/'),kind:pose.kind,declaredStatus:pose.status,hasReference:!!(pose.reference||pose.referencePosePath),hasRig:!!pose.visualRigPath,weaponControlled:!!pose.weapon,verified:false};
  if(pose.status==='confirmed'){
    try{await requireReviewedPose(file,context);record.verified=true;}
    catch(error:any){record.reason=error.message;try{const result=await solvePoseData(pose,context);record.numeric={ok:result.report.ok,issues:result.report.issues};}catch(error:any){record.numeric={ok:false,message:error.message};}}
  }
  records.push(record);
}
const report={auditedAt:new Date().toISOString(),workspace,readOnly:true,found:paths.length,truncated:paths.length>500,poses:records.length,confirmed:records.filter(r=>r.declaredStatus==='confirmed').length,verified:records.filter(r=>r.verified).length,records};
await writeFile('docs/plans/real-pose-audit-20261022.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,records:records.filter(r=>r.declaredStatus==='confirmed')}));
