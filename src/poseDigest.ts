import { createHash } from 'node:crypto';
import { readFile,stat } from 'node:fs/promises';
import path from 'node:path';
import { TextureAtlas } from '@esotericsoftware/spine-core';
import { poseInputHash } from './animationKernel.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { poseFingerprint,referenceFingerprint,visualRigFingerprint,legacyEvidenceHash } from './domainFingerprints.js';
import { policyFingerprint,comparisonFingerprint } from './poseGraph.js';
import { cacheStats } from './runtimeCache.js';

export const bytesHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function poseDependencies(pose: any, context: ToolContext,values=new Map<string,Buffer>()) {
  const read = async (file: string) => {
    const key = file.replace(/\\/g, '/');
    if (!values.has(key)) values.set(key, await readFile(resolveWorkspacePath(key, context)));
    return values.get(key)!;
  };
  const json = async (file: string) => JSON.parse((await read(file)).toString('utf8'));
  const visited = new Set<string>();
  const visit = async (file: string) => {
    if (typeof file !== 'string') throw new Error('姿态依赖路径必须为字符串。');
    const key=file.replace(/\\/g,'/'); if(visited.has(key))return; visited.add(key);
    if(visited.size>2048)throw new Error('姿态依赖图超过上限，请检查循环或过大的动作绑定。');
    const value=await json(key);
    if(value.imagePath)await read(value.imagePath);
    if(value.observation?.imagePath)await read(value.observation.imagePath);
    for(const evidence of value.review?.evidence??[])await read(evidence.filePath);
    for(const field of ['filePath','mappingPath','visualRigPath','referencePosePath','sequencePath','standardPosePath','comparisonPath'])if(value[field])await visit(value[field]);
    if(Array.isArray(value.stages))for(const stage of value.stages)if(stage.referencePosePath)await visit(stage.referencePosePath);
    if(value.atlasPath){const atlas=new TextureAtlas((await read(value.atlasPath)).toString('utf8'));for(const page of atlas.pages)await read(path.join(path.dirname(value.atlasPath),page.name));}
  };
  for(const file of [pose.filePath,pose.mappingPath,pose.visualRigPath,pose.referencePosePath,pose.sequencePath,pose.standardPosePath].filter(Boolean))await visit(file);
  const dependencies = [...values].map(([filePath, raw]) => ({ filePath, hash: bytesHash(raw) })).sort((a, b) => a.filePath.localeCompare(b.filePath));
  return { dependencies, dependencyFingerprint: bytesHash(JSON.stringify(dependencies)) };
}

export async function poseDigest(pose: any, context: ToolContext, posePath?:string) {
  const started=performance.now(),contents=new Map<string,Buffer>();
  const inputFingerprint = poseInputHash(pose);
  let dependencyFingerprint: string | null = null, dependencyError: string | null = null;
  try { dependencyFingerprint = (await poseDependencies(pose, context,contents)).dependencyFingerprint; }
  catch (error) { dependencyError = String(error); }
  const solution = pose.solution;
  const freshness = !solution ? 'missing' : !solution.inputFingerprint || !solution.dependencyFingerprint
    ? 'unknown' : solution.inputFingerprint !== inputFingerprint || solution.dependencyFingerprint !== dependencyFingerprint ? 'stale' : 'current';
  const read=async(file:string)=>{const key=file.replace(/\\/g,'/');if(!contents.has(key))contents.set(key,await readFile(resolveWorkspacePath(file,context)));return contents.get(key)!;};
  const json=async(file:string)=>JSON.parse((await read(file)).toString('utf8'));
  const check=(stale:boolean|null,reason:string)=>({stale,reason,checked:stale!==null});
  const none=()=>check(false,'不适用。'),unknown=(reason:string)=>check(null,reason);
  const stale:any={solution:check(freshness==='current'?false:freshness==='stale'?true:null,dependencyError??`solution ${freshness}`),comparison:unknown('尚无当前比较报告。'),review:unknown('尚未完成当前审查。'),reference:none(),rig:none(),sequence:none(),policy:none()};
  let comparison:any=null,reference:any=null,rig:any=null,sequence:any=null,reviewEvidenceVerified=false;
  const evidence=async(record:any)=>{if(!record?.evidence?.length)return false;for(const item of record.evidence)if(legacyEvidenceHash(await read(item.filePath))!==item.hash)return false;return true;};
  if(pose.comparisonPath)try{comparison=await json(pose.comparisonPath);stale.comparison=check(freshness!=='current'||comparison.poseFingerprint!==poseFingerprint(pose)||comparison.policyFingerprint!==policyFingerprint,'比较输入、依赖与策略指纹核对。');}catch{stale.comparison=check(true,'比较报告缺失或不可读。');}
  else if(!pose.reference&&!pose.referencePosePath)stale.comparison=none();
  if(pose.reference||pose.referencePosePath){
    stale.policy=comparison?check(comparison.policyFingerprint!==policyFingerprint,'当前比较策略版本。'):unknown('缺少带策略指纹的报告。');
    try{const value=await json(pose.referencePosePath);reference=referenceFingerprint(value);stale.reference=check(value.version!==2||value.status!=='confirmed'||value.review?.fingerprint!==reference||legacyEvidenceHash(await read(value.observation.imagePath))!==value.imageHash||JSON.stringify(value.observation)!==JSON.stringify(pose.reference)||!await evidence(value.review),'参考标注、原图、审查及内嵌记录核对。');}catch{stale.reference=check(true,'参考缺失或无法核验。');}
    try{const value=await json(pose.visualRigPath);rig=visualRigFingerprint(value);stale.rig=check(value.version!==2||value.status!=='confirmed'||value.review?.fingerprint!==rig||value.sourceFingerprint!==pose.sourceFingerprint||!await evidence(value.review),'视觉绑定版本、角色与证据核对。');}catch{stale.rig=check(true,'视觉绑定缺失或无法核验。');}
    try{const value=await json(pose.sequencePath),references=[];for(const stage of value.stages)references.push({stageId:stage.stageId,fingerprint:referenceFingerprint(await json(stage.referencePosePath))});const raw=JSON.stringify({sequence:value,references,rig});sequence=bytesHash(raw);stale.sequence=comparison?check(sequence!==comparison.sequenceFingerprint,'动作级记录与各阶段参考指纹。'):unknown('缺少最新动作级比较报告。');}catch{stale.sequence=check(true,'动作级阶段与身份依赖缺失。');}
  }
  const hasReference=!!(pose.reference||pose.referencePosePath);
  if(hasReference&&stale.comparison.stale===false){
    const prerequisites=[stale.reference,stale.rig,stale.sequence,stale.policy];
    const known=prerequisites.every(item=>item.checked),failed=prerequisites.some(item=>item.stale===true);
    stale.comparison=check(failed||comparison.referenceFingerprint!==reference||comparison.visualRigFingerprint!==rig||comparison.sampleFingerprint!==null?true:known?false:null,'比较及其参考、绑定、动作级阶段和策略依赖核对；动画采样报告不充当姿态报告。');
  }
  if(pose.review)try{reviewEvidenceVerified=await evidence(pose.review);stale.review=check(freshness!=='current'||pose.review.poseFingerprint!==poseFingerprint(pose)||!reviewEvidenceVerified||hasReference&&(stale.comparison.stale!==false||!comparison||pose.review.comparisonFingerprint!==comparisonFingerprint(comparison)),'审查输入、适用关系报告及每份证据字节核对。');}catch{stale.review=check(true,'审查证据缺失或不可读。');}
  const digestOk=Object.values(stale).every((item:any)=>item.checked&&item.stale===false),officialOk={solved:freshness==='current'?solution.ok===true:null,comparison:!hasReference?null:stale.comparison.stale===false?comparison?.ok===true:null,review:stale.review.stale===false?solution?.ok===true&&pose.status==='confirmed'&&pose.review.decision==='approved'&&(!hasReference||comparison?.ok===true):null};
  const metadata=posePath?await stat(resolveWorkspacePath(posePath,context)):null;
  const metrics=comparison?.metrics?.map((m:any)=>({id:m.id,status:m.status,required:m.required,tolerance:m.tolerance,error:m.error}))??[];
  return {
    pose: { id: pose.id, stageId: pose.stageId ?? null, kind: pose.kind, status: pose.status ?? 'draft', frame: pose.frame, weapon: pose.weapon ?? null },
    freshness, inputFingerprint, dependencyFingerprint, dependencyError, checked: 'strictDependencies', solveCount: 0,
    fingerprints:{pose:poseFingerprint(pose),reference,visualRig:rig,policy:policyFingerprint,sequence:{current:sequence,stored:comparison?.sequenceFingerprint??null,reportPath:pose.comparisonPath??null}},stale,digestOk,officialOk,
    artifacts:{solution:{ok:officialOk.solved,matchesCurrentSolve:freshness==='current'},comparison:{path:pose.comparisonPath??null,ok:officialOk.comparison,source:'stored',digest:comparison?.metrics?.map((m:any)=>({id:m.id,status:m.status,required:m.required,error:m.error}))??null},review:{decision:pose.review?.decision??null,evidenceCount:pose.review?.evidence?.length??0,evidenceVerified:reviewEvidenceVerified}},
    read:{posePath:posePath??null,mtimeMs:metadata?.mtimeMs??null,sizeBytes:metadata?.size??null,readMs:performance.now()-started,dependencyFiles:contents.size},cache:{mode:'strict',...cacheStats()},
    solved: freshness === 'current' ? {
      ok: solution.ok, issues: solution.issues, warnings: solution.warnings,
      flexion: solution.flexion, errors: solution.errors, headIntrusions: solution.headIntrusions ?? [],
    } : null,
    comparison: comparison?{ok:officialOk.comparison,metrics,freshness:stale.comparison}:null,
    note: '仅检查已有结果与输入/依赖指纹；需要重算请显式设置 recheck:true。既有结果不代替当前正式审查。',
  };
}
