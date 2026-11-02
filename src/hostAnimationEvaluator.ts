import { loadMotionArmCalibrations } from './armCalibration.js';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { HostError, derivedFingerprint, strictHash } from './hostContracts.js';
import { playbackInputHash } from './hostPlayback.js';
import { createMotionRuntime } from './motionRuntime.js';
import { captureRuntimeState } from './captureEvidence.js';
import { buildSemanticAnimationSteps } from './retargetEngine.js';
import { poseGate } from './poseWorkflow.js';
import { resolveWorkspacePath, validateOfficialAnimationSpec, validateSpineJson, type ToolContext } from './spineJson.js';
import { taskCheckpoint } from './taskControl.js';

/** 只在 MCP 执行；Host 不调用求解器。生成的是观察用不可变候选，没有动画提交令牌。 */
export async function evaluateAnimationSnapshot(snapshot: any, context: ToolContext, verify: () => Promise<void>, signal?: AbortSignal, progress?: (stage: string) => void,prepared?:{source:any;unreachableCount:number}) {
  const check = () => { if (signal?.aborted) throw new HostError('TASK_CANCELLED', '动画预览计算已取消，未更改源资产。', 409); };
  check();
  if (snapshot.viewProfile !== 'c2-pose' || !snapshot.view || !['skeleton','motion'].includes(snapshot.kind)) throw new HostError('CAPABILITY_MISSING', '当前实例未声明该动画预览能力。', 409);
  const binding = snapshot.project?.mode === 'managed' && snapshot.project.manifest.characters[snapshot.characterId];
  if (!binding) throw new HostError('PROJECT_BINDING_CONFLICT', '动画预览需要已绑定受管角色。', 409);
  const read = async (file: string) => readFile(resolveWorkspacePath(file, context));
  const source = prepared?structuredClone(prepared.source):snapshot.kind === 'skeleton' ? structuredClone(snapshot.document) : JSON.parse((await read(binding.skeletonPath)).toString());
  const mapping = JSON.parse((await read(binding.mappingPath)).toString()), atlas = (await read(binding.atlasPath)).toString();
  if (!/^4\.1\./.test(source.skeleton?.spine ?? '')) throw new HostError('UNSUPPORTED_VERSION', '当前动画观察只支持匹配的 Spine 4.1 runtime。', 409);
  let unreachableCount = prepared?.unreachableCount??0;
  if (snapshot.kind === 'motion') {
    if (snapshot.document.version !== 2 || snapshot.view.animation !== snapshot.document.name) throw new HostError('UNSUPPORTED_DOC_KIND', '当前只预览 v2 motion 的同名候选。', 409);
    if (snapshot.document.poseWorkflow) {
      const gate=await poseGate(snapshot.document,context);
      if(!gate.ok)throw new HostError('COMMIT_NOT_AUTHORIZED','motion 的既有关键姿态审查未通过，不发布观察候选。',409,gate);
    }
    if(!prepared){check(); progress?.('MCP 预计算完整 motion 只读候选');
    const iterator = buildSemanticAnimationSteps(source, mapping, snapshot.document, { filePath: binding.skeletonPath, mappingPath: binding.mappingPath, animation: snapshot.view.animation, dryRun: true }, createMotionRuntime(source, atlas),await loadMotionArmCalibrations(snapshot.document,context));
    let step = iterator.next();
    while (!step.done) { check(); await taskCheckpoint('motion 观察候选'); await new Promise<void>(resolve => setImmediate(resolve)); step = iterator.next(); }
    source.animations ??= {}; source.animations[snapshot.view.animation] = step.value.dense;
    unreachableCount = step.value.unreachable.length;
    }
  }
  check(); await verify();
  const structural = validateSpineJson(source), official = validateOfficialAnimationSpec(source);
  if (!structural.ok || !official.ok) throw new HostError('SOLUTION_INVALID', '观察候选未通过结构与官方 JSON 规范审查。', 409, { structural, official });
  const runtime = createMotionRuntime(source, atlas), animation = snapshot.view.animation;
  const sampled = runtime.sample(animation ?? undefined, snapshot.view.time, mapping.skin);
  const actual = captureRuntimeState(sampled);
  if (actual.bones.some((bone: any[]) => bone.slice(1).some(value => !Number.isFinite(value))) || Object.values(actual.vertices).some((values: any) => values.some((value: number) => !Number.isFinite(value))))
    throw new HostError('SOLUTION_INVALID', '观察候选包含非有限 runtime 变换或顶点。', 409);
  const result: any = { bones: {}, actualNodes: { bones: Object.fromEntries(sampled.bones.map(bone => [bone.data.name, { x: bone.worldX, y: bone.worldY }])) },
    numeric: { status: 'previewOnly', finite: true, unreachableCount, note: '当前采样的观察检查，不是完整动画数值/视觉/编辑器验收。' },
    inputFingerprint: playbackInputHash(snapshot.kind, snapshot.document, snapshot.view), diagnosticOnly: true,
    renderState: { ...actual, maximumError: 0, replaySchema: 1 }, view: snapshot.view };
  const raw = JSON.stringify(source, null, 2) + '\n'; result.live = { hash: strictHash(raw), animation, time: snapshot.view.time };
  result.live.path = `.spine-mcp/live/${snapshot.version.documentId}/${snapshot.version.openEpoch}/${derivedFingerprint(snapshot.snapshotHash, result)}/scene.json`;
  check(); await verify();
  const file = resolveWorkspacePath(result.live.path, context); await mkdir(path.dirname(file), { recursive: true });
  try { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); } }
  catch (error: any) { if (error.code !== 'EEXIST' || strictHash(await readFile(file)) !== result.live.hash) throw error; }
  check(); await verify(); progress?.('发布当前动画/时间的只读候选'); return result;
}
