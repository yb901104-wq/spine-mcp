import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveWorkspacePath, readSpineDocument, type ToolContext } from './spineJson.js';
import { readJson } from './poseWorkflow.js';
import { analyzeReferenceGif } from './referenceTools.js';
import { saveJson, hashObject } from './mappingTools.js';
import { readCharacterMapping } from './motionEngine.js';
import { prepareSemanticAnimationData } from './retargetEngine.js';
import { renderAnimationGif } from './previewRenderTools.js';
import { renderAnimationComparison } from './animationReview.js';

type WorkflowProfile = 'creative' | 'adaptive-preview' | 'production';

function profileOf(value: unknown): WorkflowProfile {
  if (value === 'creative' || value === 'adaptive-preview' || value === 'production') return value;
  return 'adaptive-preview';
}

async function sha256(path: string, context: ToolContext) {
  return createHash('sha256').update(await readFile(resolveWorkspacePath(path, context))).digest('hex');
}

async function renderAdaptiveDiagnosticPreview(args:any, coverage:any, stages:any[], context:ToolContext={}){
  const ordered=stages.filter(stage=>stage.expectedTarget?.frame&&stage.status!=='unreviewed').sort((a,b)=>Number(a.targetTime)-Number(b.targetTime));
  if(ordered.length<2)return {previewMode:'stage-hold',diagnosticPreviewAvailable:false,message:'可用目标关键姿态少于两个，无法生成连续插值预览。'};
  const rig=await readJson(args.visualRigPath,context);
  const targetCharacterPath=args.targetCharacterPath??rig.filePath;
  const mappingPath=args.mappingPath??rig.mappingPath;
  if(!targetCharacterPath||!mappingPath)throw new Error('连续诊断预览缺少目标角色或 mapping 绑定。');
  const targetDoc=await readSpineDocument(targetCharacterPath,context),mapping=await readCharacterMapping(mappingPath,context);
  const outputDir=args.outputDir??`previews/jobs/reference-retarget-${coverage.referenceGifHash.slice(0,12)}`;
  const previewDir=`${outputDir}/diagnostic-preview`;
  const animation=args.animation??`reference_diagnostic_${coverage.referenceGifHash.slice(0,8)}`;
  const duration=Number.isFinite(coverage.duration)&&coverage.duration>0?coverage.duration:Math.max(...ordered.map(stage=>Number(stage.targetTime)),0.001);
  const frames=ordered.map(stage=>({...structuredClone(stage.expectedTarget.frame),time:Number(stage.targetTime)}));
  frames[0].time=0;
  frames[frames.length-1].time=duration;
  const motion:any={version:2,name:animation,duration,loop:false,coordinateSystem:'normalizedSkeleton',groundY:0,frames,referenceRetarget:{referenceGifPath:args.referenceGifPath,referenceGifHash:coverage.referenceGifHash,sequencePath:args.sequencePath,retargetMode:args.retargetMode??'adaptive',workflowProfile:'adaptive-preview',previewMode:'keypose-interpolated',stages:ordered.map(stage=>({stageId:stage.stageId,targetTime:stage.targetTime,referenceTime:stage.referenceTime??stage.targetTime}))}};
  const prepared=await prepareSemanticAnimationData(targetDoc.json,mapping,motion,{filePath:targetCharacterPath,mappingPath,motionPath:`${previewDir}/${animation}.motion.json`,animation,atlasPath:mapping.atlasPath,retargetMode:args.retargetMode??'adaptive',workflowProfile:'adaptive-preview',diagnosticPreview:true,dryRun:true,preview:false} as any,context);
  const candidatePath=`${previewDir}/${animation}.candidate.json`,motionPath=`${previewDir}/${animation}.motion.json`;
  await saveJson(candidatePath,prepared.candidate,context);await saveJson(motionPath,motion,context);
  const frameCount=Math.min(240,Math.max(2,Math.ceil(duration*30)));
  const targetPreview=await renderAnimationGif({filePath:targetCharacterPath,atlasPath:mapping.atlasPath!,mappingPath,visualRigPath:args.visualRigPath,animation,jsonOverride:prepared.candidate,frames:frameCount,fps:30,width:320,height:320,outputDir:`${previewDir}/target-runtime`},context);
  const referencePreview=await readJson(coverage.referenceManifestPath,context);
  const targetManifest=await readJson(targetPreview.manifestPath,context);
  const firstReference=referencePreview.frames?.[0];
  const poseManifestPath=`${previewDir}/comparison-pose-manifest.json`;
  await saveJson(poseManifestPath,{version:1,bounds:targetManifest.bounds,reference:firstReference?{imagePath:firstReference.filePath,crop:[0,0,targetManifest.canvas.width,targetManifest.canvas.height],height:targetManifest.canvas.height,groundY:targetManifest.canvas.height,time:firstReference.time,facing:'right'}:null},context);
  const phaseMap=ordered.map(stage=>({targetTime:Number(stage.targetTime),referenceTime:Number(stage.referenceTime??stage.targetTime)})).sort((a,b)=>a.targetTime-b.targetTime);
  if(phaseMap.length&&phaseMap[0].targetTime!==0)phaseMap.unshift({targetTime:0,referenceTime:0});
  const last=phaseMap.at(-1);if(last&&Math.abs(last.targetTime-duration)>1e-6)phaseMap.push({targetTime:duration,referenceTime:Number(referencePreview.duration??duration)});
  const comparison=await renderAnimationComparison({targetManifestPath:targetPreview.manifestPath,referenceManifestPath:coverage.referenceManifestPath,poseManifestPath,phaseMap,outputDir:`${previewDir}/comparison`,layout:'reference-above-target'},context);
  const manifest={version:1,kind:'adaptive-diagnostic-preview',previewMode:'keypose-interpolated',diagnosticOnly:true,formalEligible:false,readyToCommit:false,referenceGifPath:args.referenceGifPath,referenceGifHash:coverage.referenceGifHash,sequencePath:args.sequencePath,sequenceHash:coverage.sequenceHash,targetCharacterPath,mappingPath,animation,duration,stageIds:ordered.map(stage=>stage.stageId),previewFrameCount:targetPreview.frameCount,unreviewedFrameCount:coverage.unreviewedFrameCount,unreviewedFrameIndices:coverage.unreviewedFrameIndices,semanticFailures:ordered.flatMap(stage=>stage.expectedTarget?.semanticFailures??[]),reachabilityFailures:ordered.flatMap(stage=>stage.expectedTarget?.reachabilityFailures??[]),targetRuntimeGif:targetPreview.gifPath,comparisonGif:comparison.gifPath,targetManifestPath:targetPreview.manifestPath,referenceManifestPath:coverage.referenceManifestPath,poseManifestPath,comparisonManifestPath:comparison.manifestPath,phaseMap,candidatePath,motionPath,createdAt:new Date().toISOString()};
  const manifestPath=`${previewDir}/diagnostic-preview-manifest.json`;await saveJson(manifestPath,manifest,context);
  return {previewMode:'keypose-interpolated',diagnosticPreviewAvailable:true,diagnosticPreviewManifestPath:manifestPath,runtimePreview:targetPreview,comparison,evidence:{targetGif:targetPreview.gifPath,dynamicComparisonGif:comparison.gifPath,targetManifestPath:targetPreview.manifestPath,comparisonManifestPath:comparison.manifestPath},motion:{motionPath,candidatePath,animation,duration,validation:prepared.validation,unreachable:prepared.build.unreachable,stats:prepared.build.stats},previewValidation:prepared.validation,previewCandidateStatus:prepared.ok?'runtime-valid':'runtime-diagnostic'};
}

/** 只核对参考阶段覆盖，不对未标注帧做插值或自动姿态识别。 */
export async function validateReferenceCoverage(args: { referenceGifPath: string; sequencePath: string; reportPath?: string; dryRun?: boolean }, context: ToolContext = {}) {
  const [gifHash, sequenceHash, sequence, analysis] = await Promise.all([
    sha256(args.referenceGifPath, context),
    sha256(args.sequencePath, context),
    readJson(args.sequencePath, context),
    analyzeReferenceGif({ filePath: args.referenceGifPath, outputDir: `previews/jobs/coverage-${Date.now()}` }, context),
  ]);
  const frames = analysis.frames ?? [];
  const stages = Array.isArray(sequence.stages) ? sequence.stages : [];
  const reviewedTimes = new Map<number, string>();
  const coveredStages: string[] = [];
  for (const stage of stages) {
    let time: number | null = Number.isFinite(stage.time) ? stage.time : null;
    try {
      const pose = await readJson(stage.referencePosePath, context);
      if (time === null && Number.isFinite(pose?.observation?.time)) time = pose.observation.time;
    } catch { /* 下方 issues 会报告资源缺失 */ }
    if (Number.isInteger(stage.frameStart) || Number.isInteger(stage.frameEnd)) {
      const start = Math.max(0, Number.isInteger(stage.frameStart) ? stage.frameStart : 0);
      const end = Math.min(frames.length - 1, Number.isInteger(stage.frameEnd) ? stage.frameEnd : start);
      for (let index = start; index <= end; index++) reviewedTimes.set(index, stage.stageId);
    } else if (Number.isFinite(stage.startTime) || Number.isFinite(stage.endTime)) {
      const start = Number.isFinite(stage.startTime) ? stage.startTime : 0;
      const end = Number.isFinite(stage.endTime) ? stage.endTime : start;
      for (const frame of frames) if (frame.time >= start - 1e-6 && frame.time <= end + 1e-6) reviewedTimes.set(frame.index, stage.stageId);
    } else if (time !== null) {
      const nearest = frames.reduce((best: any, frame: any) => !best || Math.abs(frame.time - time) < Math.abs(best.time - time) ? frame : best, null);
      if (nearest) reviewedTimes.set(nearest.index, stage.stageId);
    }
    if (time !== null) coveredStages.push(stage.stageId);
  }
  const coveredFrameIndices = [...reviewedTimes.keys()].sort((a, b) => a - b);
  const unreviewedFrameIndices = frames.map((f: any) => f.index).filter((index: number) => !reviewedTimes.has(index));
  const missingStages = stages.filter((s: any) => !coveredStages.includes(s.stageId)).map((s: any) => s.stageId);
  const issues = [
    ...(stages.length ? [] : [{ code: 'NO_REFERENCE_STAGES', message: 'sequence 没有可审查阶段。' }]),
    ...(missingStages.length ? [{ code: 'REFERENCE_COVERAGE_INCOMPLETE', message: `仍有 ${missingStages.length} 个阶段没有 reference pose：${missingStages.join('、')}。` }] : []),
  ];
  const complete = issues.length === 0 && unreviewedFrameIndices.length === 0;
  if (unreviewedFrameIndices.length) issues.push({ code: 'REFERENCE_COVERAGE_INCOMPLETE', message: `仍有 ${unreviewedFrameIndices.length} 帧没有 reference pose；只覆盖已审查阶段，不得伪装成完整动作。` });
  const report = {
    version: 1,
    ok: complete,
    status: complete ? 'covered' : 'blocked',
    referenceGifPath: args.referenceGifPath,
    referenceGifHash: gifHash,
    sequencePath: args.sequencePath,
    sequenceHash,
    duration: analysis.duration,
    referenceManifestPath: analysis.manifestPath,
    frameCount: frames.length,
    coveredFrameIndices,
    unreviewedFrameIndices,
    unreviewedFrameCount: unreviewedFrameIndices.length,
    coverageStages: coveredStages,
    missingStages,
    stageBindings: stages.map((s: any) => ({ stageId: s.stageId, referencePosePath: s.referencePosePath, frameIndex: [...reviewedTimes.entries()].find(([, id]) => id === s.stageId)?.[0] ?? null })),
    issues,
    nextAction: complete ? 'coverage 已完整；可以进入目标角色重定向与 runtime 回读。' : `先补齐未覆盖阶段/帧：${missingStages.join('、') || `${unreviewedFrameIndices.length} 帧未标注`}。`,
    diagnosticOnly: true,
    formalEligible: complete,
    fingerprint: hashObject({ gifHash, sequenceHash, coveredFrameIndices, missingStages }),
  };
  const reportPath = args.reportPath ?? `${args.sequencePath.replace(/\.json$/, '')}.coverage.json`;
  if (args.dryRun === false) await saveJson(reportPath, report, context);
  return { ...report, reportPath, dryRun: args.dryRun ?? true };
}

/** 将覆盖检查和阶段生成串起来，作为 Agent 可调用的统一编排入口。 */
export async function runReferenceRetargetFlow(args: any, context: ToolContext = {}) {
  const workflowProfile = profileOf(args.workflowProfile);
  const retargetMode = args.retargetMode ?? 'adaptive';
  const completedSteps: string[] = ['input-hash-checked', 'reference-coverage-checked'];
  const coverage = await validateReferenceCoverage({ referenceGifPath: args.referenceGifPath, sequencePath: args.sequencePath }, context);
  const [standardPoseHash, visualRigHash] = await Promise.all([
    args.standardPosePath ? sha256(args.standardPosePath, context) : Promise.resolve(null),
    args.visualRigPath ? sha256(args.visualRigPath, context) : Promise.resolve(null),
  ]);
  if (workflowProfile === 'production' && !coverage.ok) {
    const flowManifestPath = `${args.outputDir ?? 'previews/jobs/reference-retarget-flow'}/body-to-npc1-${coverage.referenceGifHash.slice(0, 12)}-${retargetMode}-${workflowProfile}-flow-manifest.json`;
    const blocked = { ok: false, status: 'blocked', workflowProfile, retargetMode, inputHashes: { referenceGif: coverage.referenceGifHash, sequence: coverage.sequenceHash, standardPose: standardPoseHash, visualRig: visualRigHash }, coverage, stages: [], completedSteps, blockingReasons: coverage.issues, nextAction: '为 coverage.missingStages 建立并逐项审查 reference pose；未完成前不会生成正式 motion 或写入目标。', diagnosticOnly: true, formalEligible: false, readyToCommit: false, message: 'production 要求完整 reference coverage；当前先补齐每个阶段的人工 reference pose。', flowManifestPath };
    await saveJson(flowManifestPath, { version: 1, kind: 'reference-retarget-flow', ...blocked, createdAt: new Date().toISOString() }, context);
    return blocked;
  }
  const { generateReferenceRetargetTarget } = await import('./referenceRetarget.js');
  const sequence = await readJson(args.sequencePath, context);
  const stages: any[] = [];
  for (const stage of sequence.stages ?? []) {
    let poseTime = 0;
    try { const pose = await readJson(stage.referencePosePath, context); poseTime = Number.isFinite(pose?.observation?.time) ? pose.observation.time : 0; } catch { /* 生成阶段会返回绑定错误 */ }
    const time = Number.isFinite(args.targetTimeByStage?.[stage.stageId]) ? args.targetTimeByStage[stage.stageId] : (Number.isFinite(stage.targetTime) ? stage.targetTime : (Number.isFinite(stage.time) ? stage.time : poseTime));
    if (!coverage.coverageStages.includes(stage.stageId)) {
      stages.push({ stageId: stage.stageId, status: 'unreviewed', diagnosticOnly: true, formalEligible: false });
      continue;
    }
    try {
      const generated = await generateReferenceRetargetTarget({
        referencePosePath: stage.referencePosePath,
        visualRigPath: args.visualRigPath,
        standardPosePath: args.standardPosePath,
        sequencePath: args.sequencePath,
        stageId: stage.stageId,
        targetTime: time,
        referenceGifPath: args.referenceGifPath,
        diagnosticPreview: workflowProfile === 'production' ? false : args.diagnosticPreview !== false,
        // 每个阶段使用独立目录，避免后一个阶段覆盖前一个阶段的
        // diagnostic-manifest、pose 和 GIF。统一入口需要保留所有阶段
        // 的证据，才能继续生成可观看的动作诊断结果。
        diagnosticOutputDir: args.outputDir ? `${args.outputDir}/stages/${stage.stageId}` : undefined,
        retargetManifestPath: workflowProfile === 'production' ? `${args.outputDir ?? 'previews/jobs/reference-retarget-flow'}/stages/${stage.stageId}.retarget.json` : undefined,
        retargetMode,
        workflowProfile,
        dryRun: true,
      }, context);
      const previewOnly = workflowProfile !== 'production';
      stages.push({ stageId: stage.stageId, targetTime: time, referenceTime: Number.isFinite(stage.referenceTime) ? stage.referenceTime : (Number.isFinite(stage.time) ? stage.time : (generated.referenceTime ?? poseTime)), status: generated.status, retargetQuality: generated.retargetQuality, diagnosticOnly: previewOnly || generated.diagnosticOnly === true, formalEligible: previewOnly ? false : (generated.formalEligible ?? false), retargetManifestPath: generated.retargetManifestPath, expectedTarget: generated.expectedTarget ?? null, conflicts: generated.conflicts ?? [] });
    } catch (error) {
      stages.push({ stageId: stage.stageId, status: 'unresolved', diagnosticOnly: true, formalEligible: false, error: String(error) });
    }
  }
  completedSteps.push('reviewed-stages-solved');
  const unresolved = stages.some(s => s.status === 'unresolved');
  const unreviewed = stages.filter(s => s.status === 'unreviewed').map(s => s.stageId);
  const diagnosticOnly = workflowProfile !== 'production' || unresolved || !coverage.ok;
  const formalEligible = workflowProfile === 'production' && coverage.ok && !unresolved;
  const result: any = { ok: !unresolved, status: unresolved ? 'unresolved' : (formalEligible ? 'formal-ready' : 'geometric-adapted'), workflowProfile, retargetMode, inputHashes: { referenceGif: coverage.referenceGifHash, sequence: coverage.sequenceHash, standardPose: standardPoseHash, visualRig: visualRigHash }, coverage, stages, completedSteps, blockingReasons: [...(coverage.issues ?? []), ...(unresolved ? stages.filter(s => s.status === 'unresolved').map(s => ({ code: 'RETARGET_UNRESOLVED', stageId: s.stageId, message: s.error ?? '阶段重定向未解析。' })) : [])], nextAction: formalEligible ? '继续生成 motion、在隔离副本写入并执行 runtime 回读和动态对比；仍需正式人工视觉审查。' : unreviewed.length ? `当前只覆盖 ${coverage.coverageStages.join('、') || '无'} 阶段；先审查未覆盖阶段：${unreviewed.join('、')}。` : '当前为诊断结果；查看阶段 GIF、visualPoints 与 residuals 后再决定是否补充标注或修正目标校准。', diagnosticOnly, formalEligible, readyToCommit: false, referenceGifHash: coverage.referenceGifHash, sequenceHash: coverage.sequenceHash, previewMode: workflowProfile==='adaptive-preview'?'keypose-interpolated':null, diagnosticPreviewAvailable:false };

  if (workflowProfile === 'adaptive-preview') {
    try {
      const preview = await renderAdaptiveDiagnosticPreview(args, coverage, stages, context);
      Object.assign(result, preview);
      if (preview.diagnosticPreviewAvailable) completedSteps.push('diagnostic-runtime-preview-rendered', 'diagnostic-comparison-rendered');
    } catch (error) {
      result.blockingReasons.push({ code: 'DIAGNOSTIC_PREVIEW_FAILED', message: error instanceof Error ? error.message : String(error) });
      result.previewMode = 'stage-hold';
      result.diagnosticPreviewAvailable = false;
    }
  }

  // 覆盖完整且阶段均已解析时，才进入完整 motion/runtime/动态证据流水线。
  // 这一段仍然只生成隔离候选，不写入目标角色，也不签发提交令牌。
  if (formalEligible && !unresolved) {
    try {
    const outputDir = args.outputDir ?? 'previews/jobs/reference-retarget-flow';
    const targetCharacterPath = args.targetCharacterPath ?? (await readJson(args.visualRigPath, context)).filePath;
    const mappingPath = args.mappingPath ?? (await readJson(args.visualRigPath, context)).mappingPath;
    const targetAnimation = args.animation ?? `reference_${coverage.referenceGifHash.slice(0, 8)}`;
    const targetDoc = await readSpineDocument(targetCharacterPath, context);
    const mapping = await readCharacterMapping(mappingPath, context);
    const ordered = stages.map((stage: any) => stage.retargetManifestPath ? stage : null).filter(Boolean);
    const expectedFrames = ordered.map((stage: any) => {
      const expected = stage.expectedTarget ?? null;
      if (!expected?.frame) throw new Error(`阶段 ${stage.stageId} 缺少 expectedTarget.frame，不能构建 motion。`);
      return { ...structuredClone(expected.frame), time: Number(stage.targetTime) };
    });
    if (expectedFrames.length < 2) throw new Error('完整 motion 至少需要两个已解析阶段；单阶段只能生成诊断姿态。');
    const duration = Number.isFinite(args.duration) && args.duration > 0 ? args.duration : Math.max(...expectedFrames.map(f => f.time), coverage.duration ?? 0);
    if (!(duration > 0)) throw new Error('完整 motion 缺少有效 duration。');
    expectedFrames[0].time = 0;
    expectedFrames[expectedFrames.length - 1].time = duration;
    const motion: any = {
      version: 2,
      name: targetAnimation,
      duration,
      loop: false,
      coordinateSystem: 'normalizedSkeleton',
      groundY: 0,
      frames: expectedFrames,
      referenceRetarget: { referenceGifPath: args.referenceGifPath, referenceGifHash: coverage.referenceGifHash, sequencePath: args.sequencePath, retargetMode, workflowProfile, stages: ordered.map((s: any) => ({ stageId: s.stageId, targetTime: s.targetTime, retargetManifestPath: s.retargetManifestPath })) },
    };
    const prepared = await prepareSemanticAnimationData(targetDoc.json, mapping, motion, {
      filePath: targetCharacterPath,
      mappingPath,
      motionPath: `${outputDir}/${targetAnimation}.motion.json`,
      animation: targetAnimation,
      atlasPath: mapping.atlasPath,
      retargetMode,
      workflowProfile,
      diagnosticPreview: true,
      dryRun: true,
      preview: false,
      rotationTolerance: args.rotationTolerance,
      translationTolerance: args.translationTolerance,
      footContactTolerance: args.footContactTolerance,
      handTolerance: args.handTolerance,
      vertexTolerance: args.vertexTolerance,
    } as any, context);
    const candidatePath = `${outputDir}/${targetAnimation}.candidate.json`;
    await saveJson(candidatePath, prepared.candidate, context);
    const motionPath = `${outputDir}/${targetAnimation}.motion.json`;
    await saveJson(motionPath, motion, context);
    completedSteps.push('motion-generated', 'target-runtime-solved', 'target-runtime-validated');
    const previewFrames = Math.min(240, Math.max(2, Number.isInteger(args.previewFrames) ? args.previewFrames : 60));
    const targetPreview = await renderAnimationGif({ filePath: targetCharacterPath, atlasPath: mapping.atlasPath!, mappingPath, visualRigPath: args.visualRigPath, animation: targetAnimation, jsonOverride: prepared.candidate, frames: previewFrames, fps: Math.max(1, Math.round(previewFrames / duration)), outputDir: `${outputDir}/${targetAnimation}-runtime` }, context);
    const referencePreview = { ...(await readJson(coverage.referenceManifestPath, context)), manifestPath: coverage.referenceManifestPath };
    const comparisonPosePath = `${outputDir}/comparison-pose-manifest.json`;
    const firstReference = (await readJson(referencePreview.manifestPath, context)).frames?.[0];
    const targetManifest = await readJson(targetPreview.manifestPath, context);
    await saveJson(comparisonPosePath, { version: 1, bounds: targetManifest.bounds, reference: firstReference ? { imagePath: firstReference.filePath, crop: [0, 0, targetManifest.canvas.width, targetManifest.canvas.height], height: targetManifest.canvas.height, groundY: targetManifest.canvas.height, time: firstReference.time, facing: 'right' } : null }, context);
    const phaseMap = ordered.map((stage: any) => ({ targetTime: Number(stage.targetTime), referenceTime: Number(stage.referenceTime ?? 0) })).sort((a: any, b: any) => a.targetTime - b.targetTime);
    if (phaseMap.length && phaseMap[0].targetTime !== 0) phaseMap.unshift({ targetTime: 0, referenceTime: 0 });
    const lastPhase = phaseMap.at(-1);
    if (lastPhase && Math.abs(lastPhase.targetTime - duration) > 1e-6) phaseMap.push({ targetTime: duration, referenceTime: Number(referencePreview.duration ?? duration) });
    const comparison = await renderAnimationComparison({ targetManifestPath: targetPreview.manifestPath, referenceManifestPath: referencePreview.manifestPath, poseManifestPath: comparisonPosePath, phaseMap, outputDir: `${outputDir}/comparison`, layout: 'reference-above-target' }, context);
    completedSteps.push('dynamic-comparison-rendered');
    result.motion = { motionPath, candidatePath, animation: targetAnimation, duration, numericOk: prepared.ok, validation: prepared.validation, unreachable: prepared.build.unreachable, stats: prepared.build.stats };
    result.runtimePreview = targetPreview;
    result.referencePreview = referencePreview;
    result.comparison = comparison;
    result.evidence = { dynamicComparisonGif: comparison.gifPath, targetGif: targetPreview.gifPath, referenceManifestPath: referencePreview.manifestPath, targetManifestPath: targetPreview.manifestPath, comparisonManifestPath: comparison.manifestPath };
    result.status = prepared.ok ? 'formal-ready' : 'unresolved';
    result.formalEligible = prepared.ok;
    result.diagnosticOnly = !prepared.ok;
    result.readyToCommit = false;
    result.nextAction = prepared.ok ? '已完成候选 motion、目标 runtime 回读和动态对比；现在必须进行正式人工视觉审查，之后才允许 Host 隔离副本提交。' : '查看 runtime validation、不可达目标和动态对比 GIF，修正目标校准或阶段姿态后重新运行。';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.ok = false;
      result.status = 'unresolved';
      result.formalEligible = false;
      result.diagnosticOnly = true;
      result.readyToCommit = false;
      result.blockingReasons = [...(result.blockingReasons ?? []), { code: 'REFERENCE_RETARGET_PIPELINE_FAILED', message }];
      result.nextAction = '读取已生成的候选、runtime 状态和阶段报告，修复流水线失败项后重新执行；当前没有写入或提交授权。';
    }
  }
  const outputDir = args.outputDir ?? 'previews/jobs/reference-retarget-flow';
  const flowManifestPath = `${outputDir}/body-to-npc1-${coverage.referenceGifHash.slice(0, 12)}-${retargetMode}-${workflowProfile}-flow-manifest.json`;
  await saveJson(flowManifestPath, { version: 1, kind: 'reference-retarget-flow', ...result, createdAt: new Date().toISOString() }, context);
  return { ...result, flowManifestPath };
}
