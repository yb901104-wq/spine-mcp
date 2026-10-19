import {type ToolContext} from './spineJson.js';
import {readJson} from './poseWorkflow.js';
import {requireReferencePose,referenceFingerprint,referenceRoles} from './referencePose.js';
import {requireVisualRig,visualRigFingerprint} from './visualRig.js';
import {validateCorrespondence,finitePoint} from './poseGraph.js';
import {hashObject,saveJson} from './mappingTools.js';

export type PoseIssue={category:'inputMissing'|'identityConflict'|'calibrationMissing'|'unreachable'|'relationMismatch'|'resourceCapability';stageId?:string;message:string;metric?:string};
class PoseSequenceError extends Error{constructor(message:string,public issues:PoseIssue[]){super(message);}}
export const poseIssuesFromError=(e:any,stageId?:string):PoseIssue[]=>e.issues??[{category:'inputMissing',stageId,message:String(e)}];
export async function validatePoseSequence(a:any,c:ToolContext={}){
 const sequence=await readJson(a.sequencePath,c),issues:PoseIssue[]=[],add=(category:PoseIssue['category'],message:string,stageId?:string)=>issues.push({category,message,stageId});
 if(sequence.version!==1||!sequence.id?.trim()||!sequence.basis?.trim()||!sequence.confirmedBy?.trim()||!sequence.confirmedAt||!Array.isArray(sequence.stages)||!sequence.stages.length||sequence.stages.length>60)throw new Error('动作对应记录需 version:1、id、basis、confirmedBy/At、1–60 个 stages。');
 validateCorrespondence(sequence.correspondence);
 const rig=await requireVisualRig(sequence.visualRigPath,c);
 if(rig.rig.torsoAxis?.version!==1)add('calibrationMissing','视觉绑定未记录肩中心—髋中心躯干轴，需重新校准。');
 if(sequence.visualRigFingerprint!==visualRigFingerprint(rig.rig))add('calibrationMissing','动作记录的 visualRig 指纹已改变。');
 if(sequence.weaponHand!==null&&!['left','right'].includes(sequence.weaponHand))throw new Error('weaponHand 需 left/right 或明确 null。');
 const ids=new Set(),references:any[]=[];
 for(const stage of sequence.stages){
  if(!stage.stageId?.trim()||ids.has(stage.stageId)||!stage.referencePosePath)throw new Error('阶段需唯一 stageId 和 referencePosePath。');ids.add(stage.stageId);
  try{
   const r=await requireReferencePose(stage.referencePosePath,c),o=r.observation;references.push({stageId:stage.stageId,fingerprint:referenceFingerprint(r)});
   if(stage.referenceFingerprint!==referenceFingerprint(r))add('inputMissing','参考标注或审查发生变化，需更新动作记录。',stage.stageId);
   if(!o.anatomicalIdentity?.basis?.trim()||o.anatomicalIdentity?.status!=='confirmed')add('identityConflict','参考缺少解剖左右确认，旧画面左右不得自动继承。',stage.stageId);
   for(const k of referenceRoles)if(!finitePoint(o.points[k]))add('inputMissing',`${k} 必要参考节点未知。`,stage.stageId);
   for(const side of ['left','right'])if(typeof o.support?.[side]!=='boolean')add('inputMissing',`${side} 支撑关系未知。`,stage.stageId);
   const semantics=o.actionSemantics;
   if(sequence.weaponHand!==null&&(!semantics||semantics.identityStatus!=='confirmed'||semantics.weaponHand!==sequence.weaponHand))add('identityConflict','持杖手身份与动作级记录不一致。',stage.stageId);
   if(sequence.weaponHand!==null&&rig.rig.anatomicalSides?.[sequence.weaponHand]!==Object.keys(sequence.correspondence).find(k=>sequence.correspondence[k]===sequence.weaponHand))add('identityConflict','持杖解剖身份、目标链与动作对应冲突。',stage.stageId);
   if(semantics){const view=semantics.bodyView,profiles=rig.rig.viewProfiles??[],supported=profiles.some((p:any)=>p.bodyView===view||view==='sideOrBackThreeQuarter'&&['side','backThreeQuarter'].includes(p.bodyView));if(!supported)add('resourceCapability',`身体视角 ${view} 未校准；不能用面部显隐替代躯干能力。`,stage.stageId);}
  }catch(e){add('inputMissing',String(e),stage.stageId);}
 }
 for(const posePath of a.posePaths??[]){try{const p=await readJson(posePath,c),stage=sequence.stages.find((s:any)=>s.stageId===p.stageId);if(!stage||stage.referencePosePath!==p.referencePosePath||p.sequencePath!==a.sequencePath)add('identityConflict',`姿态 ${posePath} 未关联动作级阶段。`,p.stageId);if(hashObject(p.correspondence)!==hashObject(sequence.correspondence))add('identityConflict',`姿态 ${posePath} 混用左右对应约定。`,p.stageId);if(p.visualRigPath!==sequence.visualRigPath)add('calibrationMissing','姿态视觉绑定与动作记录不同。',p.stageId);}catch(e){add('inputMissing',String(e));}}
 const fingerprint=hashObject({sequence,references,rig:visualRigFingerprint(rig.rig)}),report={version:1,ok:!issues.length,issues,fingerprint,sequencePath:a.sequencePath,stages:references};
 const reportPath=a.reportPath??a.sequencePath.replace(/\.json$/,'.validation.json');if(a.dryRun===false)await saveJson(reportPath,report,c);return {...report,reportPath};
}
export async function sequenceForPose(p:any,c:ToolContext){
 if(!p.sequencePath||!p.stageId)throw new PoseSequenceError('参考任务缺少动作级身份 sequencePath/stageId，需补校准。',[{category:'calibrationMissing',message:'需补动作级身份记录。'}]);
 const report=await validatePoseSequence({sequencePath:p.sequencePath},c),sequence=await readJson(p.sequencePath,c),stage=sequence.stages.find((s:any)=>s.stageId===p.stageId);
 if(!stage||stage.referencePosePath!==p.referencePosePath||p.visualRigPath!==sequence.visualRigPath||hashObject(p.correspondence)!==hashObject(sequence.correspondence))throw new PoseSequenceError('动作级身份或阶段对应冲突。',[{category:'identityConflict',stageId:p.stageId,message:'姿态、参考与动作级阶段对应不同。'}]);
 // 未参与本姿态的阶段能力失败不阻止只修正已选阶段，但整段验证仍失败。
 const relevant=report.issues.filter(i=>!i.stageId||i.stageId===p.stageId);
 if(relevant.length)throw new PoseSequenceError('动作级校验失败：'+relevant.map(i=>i.message).join('；'),relevant);
 return {fingerprint:report.fingerprint,sequence,report};
}
