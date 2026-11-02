import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertVersion,HostError,objectHash,strictHash,type VersionRef} from './hostContracts.js';
import {resolveWorkspacePath,resolveWorkspacePathAsync,type ToolContext,type WorkspaceReadResolver} from './spineJson.js';
import {hashObject} from './mappingTools.js';
import {strictFileChecks} from './strictFileChecks.js';

export interface AnimationSession {
 version:VersionRef;snapshotHash:string;dependencyFingerprint:string;derivedHash:string;candidatePath:string;candidateHash:string;
 sourcePath:string;sourceHash:string;animation:string;baseToken:string;recordPath:string;recordHash:string;
 poseManifestPath:string;previewManifestPath:string;review?:any;reviewHash?:string;
}
export async function writeAnimationRecord(file:string,value:any,context:ToolContext,replace=false){
 const absolute=resolveWorkspacePath(file,context),bytes=JSON.stringify(value,null,2)+'\n';await mkdir(path.dirname(absolute),{recursive:true});
 const temp=replace?`${absolute}.${randomUUID()}.tmp`:absolute;
 try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}if(replace)await rename(temp,absolute);}
 catch(error:any){if(replace||error.code!=='EEXIST'||strictHash(await readFile(absolute))!==strictHash(bytes))throw error;}
 finally{if(replace)await unlink(temp).catch(()=>{});}
 return strictHash(bytes);
}
export async function assertAnimationSession(session:AnimationSession,doc:any,context:ToolContext,includeReview=false,readResolver?:WorkspaceReadResolver){
 assertVersion(session.version,doc.version);
 if(session.snapshotHash!==doc.snapshotHash||session.dependencyFingerprint!==doc.dependencyFingerprint||session.derivedHash!==doc.derivedHash||session.candidatePath!==doc.derived?.live?.path||session.candidateHash!==doc.derived?.live?.hash)throw new HostError('TARGET_DRIFT','动画审查会话不属于当前精确候选。',409);
 if(!/^[0-9a-f]{64}$/.test(session.baseToken)||session.recordPath!==`.spine-mcp/reviews/${session.baseToken}.json`)throw new HostError('COMMIT_NOT_AUTHORIZED','动画准备记录路径或令牌不符。',409);
 const read=(file:string)=>readFile(resolveWorkspacePath(file,context)),raw=await read(session.recordPath);
 if(strictHash(raw)!==session.recordHash)throw new HostError('TARGET_DRIFT','动画准备记录字节已改变。',409);
 const record=JSON.parse(raw.toString()),binding=record.tokenData?.hostBinding;
 assertVersion(binding?.version,doc.version);
 if(hashObject(record.tokenData)!==session.baseToken||record.reviewToken!==session.baseToken||objectHash(binding)!==objectHash({version:session.version,snapshotHash:session.snapshotHash,dependencyFingerprint:session.dependencyFingerprint,derivedHash:session.derivedHash,candidateHash:session.candidateHash,sourceHash:session.sourceHash})||record.candidatePath!==session.candidatePath||record.previewManifestPath!==session.previewManifestPath||record.poseManifestPath!==session.poseManifestPath||record.sourcePath!==session.sourcePath||record.sourceHash!==session.sourceHash||record.tokenData.animation!==session.animation||record.numericOk!==true||record.keyGraphsOk!==true)throw new HostError('COMMIT_NOT_AUTHORIZED','动画准备记录未绑定当前通过的完整候选。',409);
 if(!Array.isArray(record.artifacts)||!record.artifacts.length||hashObject(record.artifacts)!==record.tokenData.artifacts)throw new HostError('COMMIT_NOT_AUTHORIZED','完整动画产物未绑定准备令牌。',409);
 // 同一次核验内合并重叠证据，不跨调用缓存；同路径的冲突哈希直接拒绝。
 const expected=new Map<string,any>();
 for(const item of [{filePath:session.candidatePath,hash:session.candidateHash},{filePath:session.sourcePath,hash:session.sourceHash},...record.artifacts,...includeReview?session.review?.evidence??[]:[]]){
  if(expected.has(item.filePath)&&expected.get(item.filePath).hash!==item.hash)throw new HostError('TARGET_DRIFT','动画证据存在同路径冲突哈希。',409);
  expected.set(item.filePath,item);
 }
 const files=await strictFileChecks([...expected.values()],readResolver??(file=>resolveWorkspacePathAsync(file,context,{canonicalExisting:true})));
 if(files.some(file=>file.error||file.actual!==file.hash))throw new HostError('REVIEW_STALE','完整动画产物已变化。',409);
 if(includeReview)await assertHostAnimationReviewFresh(session,context,new Set(expected.keys()),readResolver);
 return record;
}
export async function assertHostAnimationReviewFresh(session:AnimationSession,context:ToolContext,verifiedInThisCall?:Set<string>,readResolver?:WorkspaceReadResolver){
 if(!session.review)return;
 const files=await strictFileChecks(session.review.evidence.filter((e:any)=>!verifiedInThisCall?.has(e.filePath)),readResolver??(file=>resolveWorkspacePathAsync(file,context,{canonicalExisting:true})));
 if(files.some(file=>file.error||file.actual!==file.hash))throw new HostError('REVIEW_STALE','已登记完整动画审查的证据已变化。',409);
 const persisted=JSON.parse(await readFile(resolveWorkspacePath(`.spine-mcp/reviews/${session.baseToken}.visual.json`,context),'utf8'));
 if(objectHash(persisted)!==objectHash({review:session.review.review,reviewToken:session.review.reviewToken}))throw new HostError('REVIEW_STALE','完整动画审查记录已变化。',409);
}
export const fullAnimationChecks=['transitions','timing','followThrough','keyPoses','loop'];
export function validateHostAnimationReview(value:any){
 if(!value||!['approved','rejected'].includes(value.decision)||typeof value.reviewedBy!=='string'||!value.reviewedBy.trim()||typeof value.reason!=='string'||!value.reason.trim()||!Array.isArray(value.checks)||value.checks.length!==5||new Set(value.checks).size!==5||fullAnimationChecks.some(k=>!value.checks.includes(k)))throw new HostError('INVALID_ARGUMENT','完整动画审查需确认者、具体理由和五个独立检查项。');
 if(value.issues!==undefined&&(!Array.isArray(value.issues)||value.issues.some((v:any)=>typeof v!=='string'))||value.decision==='approved'&&value.issues?.length)throw new HostError('COMMIT_NOT_AUTHORIZED','存在未解决问题不能批准完整动画。',409);
 if(value.decision==='approved'){
  const results=value.checkResults;
  if(!results||Object.keys(results).length!==5||fullAnimationChecks.some(k=>results[k]?.status!=='pass'||typeof results[k]?.reason!=='string'||!results[k].reason.trim())||new Set(fullAnimationChecks.map(k=>results[k].reason.trim())).size!==5)throw new HostError('INVALID_ARGUMENT','完整动画批准需五项各自 pass 和不同具体理由。');
 }
}
