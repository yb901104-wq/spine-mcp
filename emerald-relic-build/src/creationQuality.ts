import { metricAdvice } from './poseOps.js';

/** 只投影已有结果和能力，不求解、不批准，也不修改比较策略。 */
export function creationQuality(state:any) {
  const comparison=state.reference??state.comparison,metrics=Array.isArray(comparison?.metrics)?comparison.metrics:[];
  const operations=state.capabilities?.operations??[];
  const patch=operations.find((op:any)=>op.operation==='patch');
  const failures=metrics.filter((m:any)=>m.required&&m.status!=='pass').map((m:any)=>{
    const fixed=/\.support$|bendSide$|^action\.|^depth\./.test(m.id),advice=metricAdvice(m.id);
    const role=/^arm\.(left|right)\./.exec(m.id),targetRole=role?role[1]+'Hand':null;
    const targetCapability=state.capabilities?.editing?.targets?.find((t:any)=>t.role===targetRole&&t.supported);
    const field=/Height/.test(m.id)?'y':'x',target=targetRole?state.editValues?.targets?.[targetRole]:null;
    const examples=!fixed&&patch?.canRun&&target&&targetCapability?.availableFields?.includes(field)?[-.01,.01].map(delta=>({tool:'spine_host_patch',arguments:{expectedRevision:state.version,dryRun:true,ops:[{op:'setPoseTarget',path:`pose/frame/targets/${targetRole}`,role:targetRole,[field]:target[field]+delta}]},note:'预演正/负小步候选，再比较实际结果；不保证该方向改善，不更改固定关系。'})):[];
    return {id:m.id,status:m.status,constraintTier:m.constraintTier??null,blocking:m.blocking??m.required!==false,relaxed:m.relaxed===true,preserved:m.preserved===true,error:m.error??null,tolerance:m.tolerance??null,
      category:fixed?'stageReview':m.status==='unverifiable'?'observation':'fit',
      instruction:fixed?'复核该阶段的参考、身份、支撑、弯曲分支或层序证据；不在局部优化中改固定关系。':m.status==='unverifiable'?'补充或复核对应观测；未知必要点不能自动通过。':advice.note,
      knob:fixed?null:advice.knob,
      nextAction:examples.length?examples[0]:null,examples};
  });
  if(comparison?.ok===false&&!metrics.length)failures.push({id:'reference.unverifiable',status:'unverifiable',error:null,tolerance:null,category:'observation',instruction:comparison.message??'参考比较缺失，需复核观测及绑定。',knob:null,nextAction:null,examples:[]});
  const current=!!state.version&&!state.targetStale&&state.writeMode!=='frozen';
  const comparisonPassed=state.activeDoc?.referenceRequired===false||comparison?.ok===true;
  return {stageId:state.activeDoc?.stageId??null,methods:comparison?.partObservations?.parts?.map((p:any)=>({id:p.id,method:p.method,reliability:p.reliability,uncertaintyKnown:p.uncertaintyKnown}))??[],
    numericPassed:state.numeric?.ok===true,referenceStatus:comparison?.ok===true?'passed':comparison?.ok===false?'failed':'notRun',
    failures,failureCount:failures.length,canContinueEditing:current&&patch?.canRun===true,
    canReview:current&&state.numeric?.ok===true&&comparisonPassed&&state.capture?.evidenceEligible===true,
    canBuildFormalMotion:current&&!state.activeDoc?.memoryOnly&&state.numeric?.ok===true&&comparisonPassed&&state.agentVisual?.status==='approved',
    canCommit:current&&operations.some((op:any)=>op.operation==='commit'&&op.canRun),
    observationMode:comparison?.partObservations?'分级轮廓/两点观测':'普通两点或尚无参考；未声称误差已知',note:'可编辑、数值、参考、视觉、正式组装与提交分别判定；未知或失败不因摘要而省略。'};
}

export function summarizeState(state:any):any {
  const quality=state.creationQuality??creationQuality(state);
  const numeric=state.numeric??{};
  const {joints,visual,bones,vertices,actualNodes,solverNodes,visualNodes,...smallNumeric}=numeric;
  const comparison=state.reference??{};
  const metrics=comparison.metrics,smallComparison=Object.fromEntries(['ok','status','retargetMode','retargetQuality','preservedConstraints','relaxedConstraints','residuals','message','version','policyFingerprint','referenceFingerprint','poseFingerprint','sequenceFingerprint','partObservationPolicyFingerprint'].filter(key=>comparison[key]!==undefined).map(key=>[key,comparison[key]]));
  const {characters,character,...capabilities}=state.capabilities??{};
  if(capabilities.editing){const {patchOps,...editing}=capabilities.editing;capabilities.editing={...editing,patchSchemaTool:'spine_host_patch'};}
  const {editValues,state:nestedState,...smallState}=state;
  return {...smallState,numeric:smallNumeric,reference:{...smallComparison,policyVersion:comparison.policy?.version??null,metricCount:metrics?.length??0,failures:quality.failures},
    ...(state.capabilities?{capabilities}:{}),...(nestedState?.apiVersion?{state:summarizeState(nestedState)}:nestedState?{state:nestedState}:{}),creationQuality:quality,
    details:{resource:`spine://session?${new URLSearchParams({...state.projectId?{projectId:state.projectId}:{},responseDetail:'full'})}`,responseDetail:'full'}};
}

export function summarizeHostResult(result:any,name?:string) {
  if(!result||typeof result!=='object')return result;
  if(name==='spine_analyze_reference_gif'&&Array.isArray(result.frames)){const {frames,...summary}=result;return {...summary,frameCount:frames.length,uniqueFrameCount:frames.filter((f:any)=>f.duplicateOf===null).length,details:{manifestPath:result.manifestPath,responseDetail:'full'},note:'默认返回原时序摘要；完整帧表读取 manifest 或 responseDetail:full，节点仍须独立标注。'};}
  if(result.apiVersion)return summarizeState(result);
  if(name==='spine_precheck_pose'&&result.reference){const c=result.reference;return {...result,reference:{ok:c.ok??null,status:c.status??null,metricCount:c.metrics?.length??0,failures:c.metrics?.filter((m:any)=>m.required&&m.status!=='pass').map((m:any)=>({id:m.id,status:m.status,error:m.error??null,tolerance:m.tolerance??null}))??[],message:c.message??null}};}
  if(name==='spine_get_creation_task'&&result.task){const {inputs,...task}=result.task;return {...result,task:{...task,inputCount:inputs?.length??0,details:'responseDetail:full 读取全部冻结输入'}};}
  return {...result,...result.state?.apiVersion?{state:summarizeState(result.state)}:{}};
}
