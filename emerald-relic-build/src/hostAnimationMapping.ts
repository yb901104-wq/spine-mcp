import {readFile} from 'node:fs/promises';
import {assertConfirmedMapping,rigHash} from './mappingTools.js';
import {readCommittedAnimations} from './hostJournal.js';
import {HostError,objectHash,strictHash} from './hostContracts.js';
import {resolveWorkspacePath,type ToolContext} from './spineJson.js';

/** 只认可本 Host 已提交的单动画变更链；不重写或放宽普通 mapping 校准规则。 */
export async function assertHostAnimationMapping(mapping:any,source:any,sourceHash:string,sourcePath:string,mappingPath:string,context:ToolContext){
 const read=(p:string)=>readFile(resolveWorkspacePath(p,context));
 if(mapping.sourceHash===sourceHash){await assertConfirmedMapping(mapping,source,sourceHash,context);return {kind:'calibrated-source',fingerprint:objectHash({sourceHash,mappingPath,reportPath:mapping.reportPath})};}
 const mappingHash=strictHash(await read(mappingPath)),reportHash=strictHash(await read(mapping.reportPath)),records=await readCommittedAnimations(context),chain:any[]=[];
 const visited=new Set<string>();let current=sourceHash,original:any;
 while(current!==mapping.sourceHash){
  if(visited.has(current)||chain.length>=2048)throw new HostError('TARGET_DRIFT','动画校准来源链循环或超过上限。',409);visited.add(current);
  const matches=records.filter(r=>r.animationCommit.sourcePath===sourcePath&&r.animationCommit.hashAfter===current);
  if(matches.length!==1)throw new HostError('TARGET_DRIFT','角色变化不属于唯一的 Host 已确认动画提交链，须重新校准确认。',409);
  const proof=matches[0].animationCommit;
  if(proof.mappingPath!==mappingPath||proof.mappingHash!==mappingHash||proof.reportPath!==mapping.reportPath||proof.reportHash!==reportHash||proof.rigHash!==rigHash(source))throw new HostError('TARGET_DRIFT','动画提交链的角色结构、mapping 或校准报告已变化。',409);
  const backup=await read(proof.backupPath);
  if(strictHash(backup)!==proof.hashBefore||rigHash(JSON.parse(backup.toString()))!==rigHash(source))throw new HostError('TARGET_DRIFT','动画提交链的来源备份无效。',409);
  chain.push(proof);current=proof.hashBefore;original=JSON.parse(backup.toString());
 }
 if(!original)throw new HostError('TARGET_DRIFT','缺少动画校准来源。',409);
 await assertConfirmedMapping(mapping,original,current,context);
 return {kind:'host-animation-chain',fingerprint:objectHash(chain)};
}
