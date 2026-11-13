import {armReplayLimits} from './armCalibration.js';
import { isDiagnosticPerspective } from './perspective.js';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextureAtlas } from '@esotericsoftware/spine-core';
import { loadProject, PROJECT_MANIFEST_PATH } from './projectModel.js';
import { type ProjectManifest } from './projectSchema.js';
import { resolveWorkspacePath, resolveWorkspacePathAsync, type ToolContext,type WorkspaceReadResolver } from './spineJson.js';
import { readCommittedIndex } from './hostJournal.js';
import { managedDocumentBinding, validateAssetBinding } from './hostAssetBinding.js';
import { applyRenderSnapshot, REPLAY_SCHEMA_VERSION } from './renderSnapshot.js';
import { createMotionRuntime, worldVertices } from './motionRuntime.js';
import { loadAtlasImages, rasterFrame } from './rasterRenderer.js';
import { poseDigest, poseDependencies } from './poseDigest.js';
import { poseInputHash } from './animationKernel.js';
import { assertVersion, derivedFingerprint, HostError, objectHash, strictHash, type DocumentKind, type VersionRef } from './hostContracts.js';
import type { WriterLease } from './writerOwnership.js';
import { verifyWriter } from './writerOwnership.js';
import { policyFingerprint } from './poseGraph.js';
import { strictFileChecks } from './strictFileChecks.js';
import { handTargetCapabilities, hostOperationReadiness } from './hostReadiness.js';
import { HostEvaluationTasks } from './hostEvaluationTasks.js';
import { poseParameterCapabilities, poseTargetCapabilities } from './hostPosePatch.js';
import { animationCatalog, assertViewRequest, assertPlaybackSelection,hasView, loadPlayback, playbackInputHash, readLiveFile, selectView, type HostViewSelection } from './hostPlayback.js';
import { assertCaptureReadback } from './captureEvidence.js';
import type { DiagnosticPoseContext } from './hostDiagnosticPose.js';

export interface HostDocument {
  path: string; kind: DocumentKind; version: VersionRef; characterId: string | null;
  value: any; baseline: Buffer; fileHash: string; contentHash: string;
  dependencies: Array<{ filePath: string; hash: string }>; dependencyFingerprint: string;
  derived: any | null; derivedHash: string | null; snapshotHash: string;
  mapping: any; skeletonJson: any; atlasRaw: string; atlasPath: string;
  camera: { minX: number; minY: number; maxX: number; maxY: number };
  cameraInitialized: boolean;
  undo: any[]; redo: any[]; uncommitted: boolean; review: any | null; reviewHash: string | null;
  view?: HostViewSelection | null; animations?: Array<{ name: string; duration: number }>;
  diagnostic?:DiagnosticPoseContext;
}
export function editableValue(value: any) {
  const copy = structuredClone(value);
  for (const key of ['solution', 'review', 'comparisonPath', 'comparison', 'reviewToken', 'authorization']) delete copy[key];
  if (copy.kind === 'standing' || copy.kind === 'action') copy.status = 'draft';
  return copy;
}
export class HostDocumentStore {
  readonly sessionId = randomUUID();
  readonly evaluationTasks = new HostEvaluationTasks();
  project: Awaited<ReturnType<typeof loadProject>> | null = null;
  active: HostDocument | null = null;
  pinned: { version: VersionRef; fileHashAtPin: string; pinnedAt: string;intent?:'asset'|'animation' } | null = null;
  writer: WriterLease | null = null;
  writeMode: 'observer' | 'attached' | 'frozen' = 'observer';
  frozen = false;
  protected queue: Promise<unknown> = Promise.resolve();
  protected pendingOperations = 0;
  protected pngCache = new Map<string, Buffer>();
  private poseRasterCache=new Map<string,Buffer>();
  private recentFrame:any=null;
  private priorFrame:any=null;
  private playbackCache:{document:HostDocument;key:string;runtime:ReturnType<typeof createMotionRuntime>}|null=null;
  private playbackKey(document:HostDocument){return objectHash({snapshotHash:document.snapshotHash,derivedHash:document.derivedHash,live:document.derived?.live,view:document.view});}
  protected events: Array<{ id: number; type: string; version: VersionRef | null; data: unknown }> = [];
  protected eventNumber = 0;
  protected characterCatalog:any[]=[];
  onEvent?: (event: { id: number; type: string; version: VersionRef | null; data: unknown }) => void;
  constructor(public readonly context: ToolContext, public readonly mode: 'host' | 'mirror' = 'host') {}
  protected capabilityEdition(): string { return 'c1'; }
  animationViewingEnabled(document = this.active) { return this.mode === 'host' && this.capabilityEdition() === 'c2-pose' && (!document || !!document.characterId && /^4\.1\./.test(document.skeletonJson?.skeleton?.spine ?? '') && (document.kind !== 'motion' || document.value.version === 2)); }
  protected serial<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    const result = this.queue.then(fn, fn).finally(() => { this.pendingOperations--; });
    this.queue = result.catch(() => undefined); return result;
  }
  protected emit(type: string, data: unknown = {}) {
    const event = { id: ++this.eventNumber, type, version: this.active?.version ?? null, data };
    this.events.push(event); if (this.events.length > 200) this.events.shift(); this.onEvent?.(event);
  }
  /** 事件不携带控制凭据或任务租约。 */
  onEvaluationTaskChanged() { this.emit('evaluation-task-updated'); }
  onObservationChanged() { this.emit('observation-updated'); }
  eventHistory(after: number) {
    if (after && after < (this.events[0]?.id ?? 0) - 1) return [{ id: this.eventNumber, type: 'resync', version: this.active?.version ?? null, data: {} }];
    return this.events.filter(e => e.id > after);
  }
  protected requireDoc() {
    if (!this.active) throw new HostError('DOC_NOT_LOADED', '请先显式打开文档。', 409);
    return this.active;
  }
  private validatePath(file: string) {
    if (typeof file !== 'string' || !file.trim() || file.includes('\0') || /[:\x00-\x1f]/.test(file) || path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || file.replace(/\\/g, '/').split('/').includes('..')) throw new HostError('PATH_FORBIDDEN', '必须使用工作区内相对路径。', 403);
  }
  resolve(file: string) {
    this.validatePath(file);
    try { return resolveWorkspacePath(file, this.context); }
    catch (error) { throw new HostError('PATH_FORBIDDEN', `路径越过工作区或边界无法核实：${String(error)}`, 403); }
  }
  private async resolveForRead(file: string,readResolver?:WorkspaceReadResolver) {
    this.validatePath(file);
    try { return await (readResolver?readResolver(file):resolveWorkspacePathAsync(file, this.context,{canonicalExisting:true})); }
    catch (error) { throw new HostError('PATH_FORBIDDEN', `路径越过工作区或边界无法核实：${String(error)}`, 403); }
  }
  protected async readJson(file: string) { return JSON.parse((await readFile(this.resolve(file), 'utf8')).replace(/^\uFEFF/, '')); }
  async assertFresh(document = this.requireDoc(),readResolver?:WorkspaceReadResolver) {
    const source=document.diagnostic?{filePath:document.diagnostic.sourcePath,hash:document.diagnostic.sourceHash}:{filePath:document.path,hash:document.fileHash};
    const checks=await strictFileChecks([source, ...document.dependencies],file=>this.resolveForRead(file,readResolver));
    for (const dependency of checks) {
      if(dependency.error){this.invalidateDerived(document);throw new HostError('TARGET_STALE',`依赖缺失或不可读：${dependency.filePath}`,409);}
      if (dependency.actual !== dependency.hash) {
        this.invalidateDerived(document);
        throw new HostError('TARGET_STALE', `磁盘或依赖发生变化：${dependency.filePath}，请保留未提交修改并显式处理重载。`, 409);
      }
    }
  }
  protected invalidateDerived(document: HostDocument) {
    if(this.recentFrame&&this.recentFrame.version.documentId===document.version.documentId&&this.recentFrame.version.openEpoch===document.version.openEpoch&&this.recentFrame.derivedHash===document.derivedHash)this.priorFrame=this.recentFrame;
    document.derived = null; document.derivedHash = null; document.review = null; document.reviewHash = null;
    this.pngCache.clear();this.playbackCache=null;
  }
  protected updateSnapshot(document: HostDocument) {
    document.contentHash = objectHash(editableValue(document.value));
    document.snapshotHash = objectHash({ version: document.version, contentHash: document.contentHash, dependencyFingerprint: document.dependencyFingerprint, ...(document.kind !== 'pose' ? { view: document.view ?? null } : {}) });
  }
  /** 首次可信回放时确定相机，此后同一打开周期不随局部编辑移动。这里只读顶点，不求解。 */
  private initializeCamera(document:HostDocument,skeleton:any){
    if(document.cameraInitialized)return;
    const vertices=Object.values(worldVertices(skeleton)).flat();
    if(vertices.length&&vertices.every(Number.isFinite)){
      const xs=vertices.filter((_,i)=>i%2===0),ys=vertices.filter((_,i)=>i%2===1),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
      const padding=Math.max(maxX-minX,maxY-minY,1)*.05,previous=document.camera;
      document.camera={minX:Math.min(previous.minX,minX-padding),maxX:Math.max(previous.maxX,maxX+padding),minY:Math.min(previous.minY,minY-padding),maxY:Math.max(previous.maxY,maxY+padding)};
    }
    document.cameraInitialized=true;
  }
  protected async beforeSwitch() { /* 编辑实现重载：持久化旧文档后才切换。 */ }
  protected async afterOpen(_document: HostDocument) {}
  async open(args: { manifestPath?: string; path?: string; reload?: boolean; expectedRevision?: VersionRef; animation?: string | null; time?: number }) {
    return this.serial(async () => {
      if (!args.manifestPath && !args.path) throw new HostError('INVALID_ARGUMENT', '至少给出 manifestPath 或 path。');
      if (args.manifestPath && args.manifestPath.replace(/\\/g, '/') !== PROJECT_MANIFEST_PATH) throw new HostError('PATH_FORBIDDEN', '工程清单只能使用工作区根 .spine-workflow.json。', 403);
      const old = this.active;
      if (old) {
        const identity=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
        const same = !old.diagnostic&&args.path && identity(await realpath(this.resolve(args.path))) === identity(await realpath(this.resolve(old.path)));
        const selected = same && hasView(args) ? selectView(old.kind, args, old.animations ?? [], this.animationViewingEnabled()) : old.view ?? null;
        if (same && !args.reload && objectHash(selected) === objectHash(old.view ?? null)) { await this.assertFresh(old); return { ...await this.state(), reopened: true }; }
        assertVersion(args.expectedRevision, old.version);
        if (args.reload && old.uncommitted) throw new HostError('UNCOMMITTED_CHANGES', '存在未提交改动；先提交或撤销至基线。', 409);
        await this.beforeSwitch();
      }
      const project = await loadProject(this.context);
      if (project.mode === 'unsupported') throw new HostError('PROJECT_SCHEMA_UNSUPPORTED', project.message, 409, project);
      const catalog:any[]=[];
      if(project.mode==='managed')for(const[characterId,binding]of Object.entries(project.manifest.characters)){
        const mapping=await this.readJson(binding.mappingPath),rig=binding.visualRigPath?await this.readJson(binding.visualRigPath):null;
        catalog.push({characterId,spineVersion:binding.spineVersion,channels:mapping.bones?.channels??{},anchors:mapping.bones?.anchors??{},mappingDeclaredStatus:mapping.status??'unknown',verification:'unknown',
          views:['frontThreeQuarter','side','backThreeQuarter'].map(bodyView=>({bodyView,supported:rig?(rig.viewProfiles??[]).some((p:any)=>p.bodyView===bodyView)?'unknown':false:'unknown',reason:rig?'按已声明切片配置列出；执行仍需核对当前 visualRig 指纹与审查。':'尚无 visualRig，无法确认视角能力。'}))});
      }
      if (!args.path) {
        if (hasView(args)) throw new HostError('INVALID_ARGUMENT', '选择动画/时间时必须显式提供文档 path。');
        this.project = project; this.characterCatalog=catalog; this.active = null; this.pinned = null; this.emit('doc-opened', { projectOnly: true });
        return { ...await this.state(), reopened: false };
      }
      const absolute = this.resolve(args.path), normalized = path.relative(this.context.workspaceRoot!, absolute).replace(/\\/g, '/');
      const actualPath = await realpath(absolute), identity = process.platform === 'win32' ? actualPath.toLowerCase() : actualPath;
      let binding: ProjectManifest['documents'][number] | undefined;let registeredRevision=false;
      if (project.mode === 'managed') {
        const key = (p: string) => process.platform === 'win32' ? this.resolve(p).toLowerCase() : this.resolve(p);
        binding = project.manifest.documents.find(d => key(d.path) === key(normalized));
        if (!binding) {
          const index = await readCommittedIndex(this.context), entry = index.find(d => key(d.path) === key(normalized));
          if (!entry) throw new HostError('PROJECT_BINDING_CONFLICT', '文档未在根 manifest 或已确认提交记录中登记。', 409);
          binding = managedDocumentBinding(normalized,project.manifest,index,this.context);
          registeredRevision=true;
          if(strictHash(await readFile(absolute))!==entry.hash)throw new HostError('PROJECT_BINDING_CONFLICT','受管资产字节与已提交记录不符。',409);
        }
      }
      const baseline = await readFile(absolute), value = JSON.parse(baseline.toString('utf8'));
      if(registeredRevision&&binding&&project.mode==='managed')await validateAssetBinding(value,binding,project.manifest,await readCommittedIndex(this.context),this.context,false);
      const kind: DocumentKind = value.skeleton?.spine ? 'skeleton' : ['standing', 'action'].includes(value.kind) && value.frame ? 'pose' : value.name && Number.isFinite(value.duration) ? 'motion' : (() => { throw new HostError('UNSUPPORTED_DOC_KIND', '无法识别文档类型。'); })();
      if (binding && binding.kind !== kind) throw new HostError('PROJECT_BINDING_CONFLICT', '文件类型与工程绑定冲突。', 409);
      const character = project.mode === 'managed' && binding ? project.manifest.characters[binding.characterId] : undefined;
      if (kind === 'pose' && character) {
        for (const [field, expected] of Object.entries({ filePath: character.skeletonPath, mappingPath: character.mappingPath, visualRigPath: character.visualRigPath, referencePosePath: binding?.referencePosePath, sequencePath: binding?.sequencePath, standardPosePath: binding?.standardPosePath })) {
          if (value[field] && (!expected || this.resolve(value[field]) !== this.resolve(expected))) throw new HostError('PROJECT_BINDING_CONFLICT', `姿态 ${field} 与工程角色绑定冲突。`, 409);
        }
        if ((value.stageId ?? undefined) !== binding?.stageId) throw new HostError('PROJECT_BINDING_CONFLICT', '姿态阶段与工程绑定冲突。', 409);
      }
      const dependencies = new Map<string, string>();
      if (project.mode === 'managed') dependencies.set(PROJECT_MANIFEST_PATH, project.manifestHash);
      let mapping: any = null, skeletonJson: any = kind === 'skeleton' ? value : null, atlasRaw = '', atlasPath = '';
      const read = async (file: string) => {
        const raw = await readFile(this.resolve(file)); dependencies.set(file.replace(/\\/g, '/'), strictHash(raw)); return raw;
      };
      try {
        if (kind === 'pose') {
          if (!value.filePath || !value.mappingPath) throw new Error('姿态缺少 filePath/mappingPath');
          const prepared = await poseDependencies(value, this.context);
          for (const dep of prepared.dependencies) dependencies.set(dep.filePath, dep.hash);
          skeletonJson = JSON.parse((await read(value.filePath)).toString('utf8'));
          mapping = JSON.parse((await read(value.mappingPath)).toString('utf8'));
        } else if (character) {
          skeletonJson = JSON.parse((await read(character.skeletonPath)).toString('utf8'));
          mapping = JSON.parse((await read(character.mappingPath)).toString('utf8'));
          if (kind === 'motion') {
            const proof = await poseDependencies({ filePath: character.skeletonPath, mappingPath: character.mappingPath, visualRigPath: character.visualRigPath,
              referencePosePath: binding?.referencePosePath, sequencePath: binding?.sequencePath, standardPosePath: binding?.standardPosePath }, this.context);
            for (const dependency of proof.dependencies) dependencies.set(dependency.filePath, dependency.hash);
            const keyPoses = value.poseWorkflow?.keyPoses ?? [];
            if (!Array.isArray(keyPoses) || keyPoses.length > 2000) throw new Error('motion 关键姿态依赖超过上限。');
            for (const keyPose of keyPoses) {
              const pose = JSON.parse((await read(keyPose.posePath)).toString());
              const poseProof = await poseDependencies(pose, this.context);
              for (const dependency of poseProof.dependencies) dependencies.set(dependency.filePath, dependency.hash);
              if (dependencies.size > 2048) throw new Error('motion 依赖图超过上限。');
            }
          }
        }
        atlasPath = character?.atlasPath ?? mapping?.atlasPath ?? '';
        if (atlasPath) {
          atlasRaw = (await read(atlasPath)).toString('utf8');
          for (const page of new TextureAtlas(atlasRaw).pages) await read(path.join(path.dirname(atlasPath), page.name));
        }
      } catch (error) { throw new HostError('DOC_INCOMPLETE', `文档依赖不完整：${String(error)}`, 409); }
      dependencies.delete(normalized);
      const deps = [...dependencies].map(([filePath, hash]) => ({ filePath, hash })).sort((a, b) => a.filePath.localeCompare(b.filePath));
      const origin = mapping?.calibration?.origin ?? [0, 0], scale = mapping?.calibration?.scale ?? 100;
      const viewingEnabled = this.mode === 'host' && this.capabilityEdition() === 'c2-pose' && !!character && /^4\.1\./.test(skeletonJson?.skeleton?.spine ?? '') && (kind !== 'motion' || value.version === 2);
      const animations = kind !== 'pose' && viewingEnabled ? animationCatalog(kind, value, skeletonJson, atlasRaw) : [];
      const view = selectView(kind, args, animations, viewingEnabled);
      const document: HostDocument = {
        path: normalized, kind, version: { sessionId: this.sessionId, documentId: objectHash({ projectId: this.context.projectId ?? project.mode, path: identity, kind }), openEpoch: randomUUID(), revision: 0 },
        characterId: binding?.characterId ?? null, value: editableValue(value), baseline, fileHash: strictHash(baseline), contentHash: '',
        dependencies: deps, dependencyFingerprint: objectHash({files:deps,policyFingerprint}), snapshotHash: '', derived: null, derivedHash: null,
        mapping, skeletonJson, atlasRaw, atlasPath, camera: { minX: origin[0] - scale * 1.5, maxX: origin[0] + scale * 1.5, minY: origin[1] - scale * .25, maxY: origin[1] + scale * 2.75 },cameraInitialized:false,
        undo: [], redo: [], uncommitted: false, review: null, reviewHash: null, view, animations,
      };
      this.updateSnapshot(document);
      if (kind === 'pose' && value.solution) {
        const digest = await poseDigest(value, this.context);
        if (digest.freshness === 'current') {
          document.derived = { bones: value.solution.bones, numeric: value.solution, frame: value.frame, actualNodes: value.solution.visualNodes ?? value.solution.joints, inputFingerprint: poseInputHash(value), poseDependencyFingerprint: value.solution.dependencyFingerprint,...(isDiagnosticPerspective(value.frame)?{diagnosticOnly:true}:{}) };
          document.derivedHash = derivedFingerprint(document.snapshotHash, document.derived);
          const runtime=createMotionRuntime(document.skeletonJson,document.atlasRaw);
          applyRenderSnapshot(runtime.skeleton,{bones:value.solution.bones,skin:document.mapping.skin,slotAttachments:document.mapping.bones.slotAttachments,presentation:value.frame.presentation,scaleLimits:await armReplayLimits(value,document.mapping,this.context)});
          this.initializeCamera(document,runtime.skeleton);
        }
      }
      const previousProject=this.project,previousPinned=this.pinned;
      this.project = project; this.active = document; this.pinned = null; this.pngCache.clear();this.playbackCache=null;
      try { await this.afterOpen(document); await this.assertFresh(document); }
      catch(error){this.project=previousProject;this.active=old;this.pinned=previousPinned;throw error;}
      this.characterCatalog=catalog;
      this.emit('doc-opened', { path: normalized });
      return { ...await this.state(), reopened: false };
    });
  }
  async state(includeCapabilities = true,readResolver?:WorkspaceReadResolver): Promise<any> {
    const checkedDocument=this.active;
    const checks=await Promise.allSettled([this.writer&&!this.frozen?verifyWriter(this.writer,this.context):Promise.resolve(),checkedDocument?this.assertFresh(checkedDocument,readResolver):Promise.resolve()]);
    if(checks[0].status==='rejected')this.frozen=true;
    let stale=checks[1].status==='rejected',staleReason:any=checks[1].status==='rejected'?{code:checks[1].reason.code,message:checks[1].reason.message}:null;
    if(this.active!==checkedDocument){stale=true;staleReason={code:'TARGET_DRIFT',message:'查询期间活动文档已切换，请重新查询当前状态。'};}
    const doc = this.active;
    return {
      ok: true, apiVersion: '1', available: this.mode === 'host', degraded: this.mode === 'mirror' || this.frozen,
      mode: this.mode === 'mirror' ? 'mirror' : 'host', sessionId: this.sessionId, projectId: this.context.projectId ?? null,
      project: this.project ? { mode: this.project.mode, name:this.project.mode==='managed'?this.project.manifest.name:null, manifestPath: this.project.manifestPath, manifestHash: 'manifestHash' in this.project ? this.project.manifestHash : null } : null,
      activeDoc: doc ? { path: doc.path, kind: doc.kind, characterId: doc.characterId, version: doc.version, view: doc.view ?? null,stageId:doc.value.stageId??null,referencePosePath:doc.value.referencePosePath??null,referenceRequired:!!(doc.value.reference||doc.value.referencePosePath),sequencePath:doc.value.sequencePath??null,memoryOnly:!!doc.diagnostic,...doc.diagnostic?{diagnosticId:doc.diagnostic.id,sourcePath:doc.diagnostic.sourcePath,proposedOutputPath:doc.diagnostic.proposedOutputPath}:{} } : null,
      version: doc?.version ?? null, revision: doc?.version.revision ?? null, contentHash: doc?.contentHash ?? null,
      fileHash: doc?.fileHash ?? null, dependencyFingerprint: doc?.dependencyFingerprint ?? null, snapshotHash: doc?.snapshotHash ?? null,
      playback:doc?.kind!=='pose'&&doc?.derived?.live&&doc?.view?{version:doc.version,candidateHash:doc.derived.live.hash,animation:doc.view.animation,time:doc.view.time,duration:doc.animations?.find(a=>a.name===doc.view?.animation)?.duration??0,camera:doc.camera,advisory:true,evidenceEligible:false}:null,
      target: this.pinned, pinned: !!this.pinned, targetStale: stale, staleReason,
      derivedHash: doc?.derivedHash ?? null, reviewHash: doc?.reviewHash ?? null,
      capabilitiesFingerprint:objectHash({characters:this.characterCatalog,kind:doc?.kind??null,writeMode:this.writeMode,editing:this.capabilityEdition(),replaySchema:REPLAY_SCHEMA_VERSION}),
      writeMode: this.frozen ? 'frozen' : this.writeMode, writer: this.writer ? { ownerId: this.writer.ownerId, generation: this.writer.generation, verified: !this.frozen } : null,
      undoDepth: doc?.undo.length ?? 0, redoDepth: doc?.redo.length ?? 0, uncommitted: doc?.uncommitted ?? false,
      editValues:doc?.kind==='pose'?{body:doc.value.frame.body,head:doc.value.frame.head,targets:doc.value.frame.targets}:null,
      previousFrame:this.priorFrame&&doc&&this.priorFrame.version.documentId===doc.version.documentId&&this.priorFrame.version.openEpoch===doc.version.openEpoch?{available:true,version:this.priorFrame.version,derivedHash:this.priorFrame.derivedHash,advisory:true,evidenceEligible:false}:{available:false},
      numeric: doc?.derived?.numeric ?? { status: 'notRun' }, reference: doc?.derived?.comparison ?? { status: 'notRun' },
      agentVisual: doc?.review ? { status: doc.review.decision } : { status: 'notRun' }, editorImport: { status: 'notRun' },
      runtime: { player: '4.1.56', core: '4.1.56', replaySchema: REPLAY_SCHEMA_VERSION, versionDrift: false },
      evaluationTasks: this.evaluationTasks.state(doc?.version ?? null),
      ...(includeCapabilities ? { capabilities: this.capabilities(stale, 'strict') } : {}),
    };
  }
  capabilities(stale = false, checked: 'fast' | 'strict' = 'fast') {
    const doc = this.active, mapping = doc?.mapping;
    const parameters = this.capabilityEdition() === 'c2-pose' ? poseParameterCapabilities(doc) : null;
    const operations = hostOperationReadiness({ doc, mode: this.mode, writeMode: this.writeMode, managed: this.project?.mode === 'managed',
      pinned: !!this.pinned && this.pinned.version.documentId === doc?.version.documentId && this.pinned.version.openEpoch === doc?.version.openEpoch,
      stale, frozen: this.frozen, pendingOperations: this.pendingOperations, checked,
      evaluationTasks: this.evaluationTasks.state(doc?.version ?? null).active,
      extendedPoseTargets: parameters ? poseTargetCapabilities(doc) : undefined,
      motionEditing:this.capabilityEdition()==='c2-pose'&&this.active?.kind==='motion'&&!!this.active.value.poseWorkflow,animationViewing: this.animationViewingEnabled(),
      poseParametersAvailable: !!parameters && (parameters.body || parameters.head || parameters.channels.some(channel => channel.supported)) });
    return {
      context: { projectId: this.context.projectId ?? null, characterId: doc?.characterId ?? null, version: doc?.version ?? null },
      viewing: { supportedKinds: this.animationViewingEnabled() ? ['pose','motion','skeleton'] : ['pose'], selection: doc?.view ?? null,
        animations: doc?.animations ?? [], setupPose: this.animationViewingEnabled() && doc?.kind === 'skeleton', changeSelection: 'spine_host_open', recheck: 'spine_host_open recheck:true' },
      characters:structuredClone(this.characterCatalog),
      operations,
      character: {
        channels: mapping?.bones?.channels ?? {}, chains: Object.fromEntries(['leftArm','rightArm','leftLeg','rightLeg'].map(k => [k, mapping?.bones?.[k] ?? null])),
        anchors: mapping?.bones?.anchors ?? {}, mappingStatus: mapping?.status ?? 'unknown',
        viewProfiles: { status: 'unknown', message: '视角需 visualRig 当前指纹与切片证据独立确认。' },
        handTargets: handTargetCapabilities(doc),
      },
    };
  }
  async snapshot(expectedRevision: VersionRef,purpose:'control'|'evaluate'='control') {
    return this.serial(async () => {
      const doc = this.requireDoc(); assertVersion(expectedRevision, doc.version); await this.assertFresh(doc);
      if(!['control','evaluate'].includes(purpose))throw new HostError('INVALID_ARGUMENT','未知快照用途。');
      return structuredClone({ version: doc.version, project: this.project, document: purpose==='evaluate'?editableValue(doc.value):doc.value,...purpose==='control'?{baselineDocument:JSON.parse(doc.baseline.toString('utf8'))}:{}, fileHash:doc.fileHash,uncommitted:doc.uncommitted, kind: doc.kind, characterId: doc.characterId, view: doc.view ?? null, viewProfile: this.capabilityEdition(),
        path: doc.path, diagnostic:doc.diagnostic??null,contentHash: doc.contentHash, dependencies: doc.dependencies, policyFingerprint, dependencyFingerprint: doc.dependencyFingerprint, snapshotHash: doc.snapshotHash,...purpose==='control'?{derived:doc.derived}:{}, derivedHash: doc.derivedHash, reviewHash: doc.reviewHash });
    });
  }
  async publishDerived(args: any) {
    return this.serial(async () => {
      const doc = this.requireDoc(); assertVersion(args.expectedRevision, doc.version); await this.assertFresh(doc);
      if (args.snapshotHash !== doc.snapshotHash || args.dependencyFingerprint !== doc.dependencyFingerprint) throw new HostError('SOLUTION_STALE', '派生结果不属于当前完整快照。', 409);
      const result = args.result;
      if (doc.kind !== 'pose') {
        if (!this.animationViewingEnabled()) throw new HostError('UNSUPPORTED_DOC_KIND', '当前 profile 不接收动画观察候选。', 409);
        assertViewRequest(doc, {}, true);
        if (!result || Object.keys(result).some(key => !['bones','numeric','actualNodes','inputFingerprint','diagnosticOnly','renderState','view','live'].includes(key)) || !result.numeric || !result.actualNodes || !result.bones || result.inputFingerprint !== playbackInputHash(doc.kind, doc.value, doc.view!) || objectHash(result.view) !== objectHash(doc.view))
          throw new HostError('SOLUTION_STALE', '动画候选不属于当前输入与选择。', 409);
        if (result.diagnosticOnly !== true || result.numeric.status !== 'previewOnly') throw new HostError('SOLUTION_INVALID', '动画观察结果不能冒充数值或视觉批准。', 409);
        if (result.live?.path !== `.spine-mcp/live/${doc.version.documentId}/${doc.version.openEpoch}/${derivedFingerprint(doc.snapshotHash,result)}/scene.json`) throw new HostError('SOLUTION_INVALID', '动画候选路径与完整版本/派生哈希不符。');
        const playback = await loadPlayback({ ...doc, derived: result }, this.context);
        const { maximumError, replaySchema, ...expected } = result.renderState ?? {};
        if (maximumError !== 0 || replaySchema !== 1) throw new HostError('SOLUTION_INVALID', '动画候选缺少当前 runtime 回读。');
        assertCaptureReadback(playback.actual, expected);
        await this.assertFresh(doc); const nextHash = derivedFingerprint(doc.snapshotHash,result);
        this.initializeCamera(doc,playback.skeleton); this.invalidateDerived(doc); doc.derived=structuredClone(result);doc.derivedHash=nextHash;
        this.playbackCache={document:doc,key:this.playbackKey(doc),runtime:playback.runtime};
        this.emit('frame-updated',{derivedHash:nextHash});return{ok:true,version:doc.version,derivedHash:nextHash,diagnosticOnly:true};
      }
      if (!result || !result.bones || !result.numeric || !result.actualNodes || Object.keys(result).some(k => !['bones','numeric','actualNodes','comparison','frame','inputFingerprint','poseDependencyFingerprint','live','renderState','diagnosticOnly'].includes(k))) throw new HostError('SOLUTION_INVALID', '派生结果结构无效或包含未允许的审查/批准字段。');
      if (doc.kind !== 'pose') throw new HostError('UNSUPPORTED_DOC_KIND', '当前发布入口只支持 pose。');
      if (result.inputFingerprint !== poseInputHash(doc.value)) throw new HostError('SOLUTION_STALE', '求解输入指纹不匹配。', 409);
      const runtime = createMotionRuntime(doc.skeletonJson, doc.atlasRaw);
      applyRenderSnapshot(runtime.skeleton, { bones: result.bones, skin: doc.mapping.skin, slotAttachments: doc.mapping.bones.slotAttachments, presentation: doc.value.frame.presentation,scaleLimits:await armReplayLimits(doc.value,doc.mapping,this.context) });
      if (result.live) {
        if (typeof result.live.path !== 'string' || result.live.path !== `.spine-mcp/live/${doc.version.documentId}/${doc.version.openEpoch}/${derivedFingerprint(doc.snapshotHash, result)}/pose.json` || strictHash(await readFile(this.resolve(result.live.path))) !== result.live.hash) throw new HostError('SOLUTION_INVALID', 'live 路径或内容哈希不符。');
      }
      const nextHash=derivedFingerprint(doc.snapshotHash,result);
      if(doc.derivedHash===nextHash)return{ok:true,version:doc.version,derivedHash:nextHash,reused:true};
      this.initializeCamera(doc,runtime.skeleton);
      this.invalidateDerived(doc); doc.derived = structuredClone(result); doc.derivedHash = nextHash;
      this.emit('frame-updated', { derivedHash: doc.derivedHash });
      return { ok: true, version: doc.version, derivedHash: doc.derivedHash, diagnosticOnly: isDiagnosticPerspective(doc.value.frame) || result.numeric.ok !== true || result.comparison?.ok === false };
    });
  }
  async frame(args: { expectedRevision: VersionRef; size?: number; time?: number; animation?: string | null }) {
    const doc = this.requireDoc(); assertVersion(args.expectedRevision, doc.version); await this.assertFresh(doc);
    assertViewRequest(doc,args,this.animationViewingEnabled());
    if (!doc.derived) throw new HostError('NO_SOLUTION', '没有可证明新鲜的求解结果；请显式重算。', 409);
    const size = args.size ?? 480;
    if (![320, 480].includes(size)) throw new HostError('INVALID_ARGUMENT', 'frame 尺寸仅支持 320/480。');
    const version = structuredClone(doc.version), derivedHash = doc.derivedHash;
    const key = objectHash({ version, derivedHash, camera: doc.camera, size, pma: true, view: doc.view ?? null, time: args.time ?? doc.value.frame?.time });
    let png = this.pngCache.get(key);
    if (!png) {
      let rt:ReturnType<typeof createMotionRuntime>;
      if(doc.kind!=='pose'){
        assertPlaybackSelection(doc);
        if(this.playbackCache?.document===doc&&this.playbackCache.key===this.playbackKey(doc)){await readLiveFile(doc,this.context);rt=this.playbackCache.runtime;}
        else rt=(await loadPlayback(doc,this.context)).runtime;
      }else rt=createMotionRuntime(doc.skeletonJson,doc.atlasRaw);
      if (doc.kind === 'pose') applyRenderSnapshot(rt.skeleton, { bones: doc.derived.bones, skin: doc.mapping.skin, slotAttachments: doc.mapping.bones.slotAttachments, presentation: doc.value.frame.presentation,scaleLimits:await armReplayLimits(doc.value,doc.mapping,this.context) });
      const rasterKey=doc.kind==='pose'?objectHash({dependencies:doc.dependencyFingerprint,bones:doc.derived.bones,skin:doc.mapping.skin??null,slotAttachments:doc.mapping.bones.slotAttachments??null,presentation:doc.value.frame.presentation??null,camera:doc.camera,size,background:'#20242b',pma:true}):null;
      const rasterCached=rasterKey?this.poseRasterCache.get(rasterKey):undefined;
      if(rasterCached)png=Buffer.from(rasterCached);
      else{const images = await loadAtlasImages(rt.atlas, doc.atlasPath, this.context);png = rasterFrame(rt.skeleton, images, doc.camera, size, size, '#20242b').toBuffer('image/png');
        if(rasterKey){this.poseRasterCache.set(rasterKey,Buffer.from(png));if(this.poseRasterCache.size>16)this.poseRasterCache.delete(this.poseRasterCache.keys().next().value!);}}

      assertVersion(version, this.requireDoc().version); await this.assertFresh(doc);
      if (derivedHash !== doc.derivedHash) throw new HostError('SOLUTION_STALE', '渲染期间结果已替换。', 409);
      this.pngCache.set(key, png); if (this.pngCache.size > 16) this.pngCache.delete(this.pngCache.keys().next().value!);
    }else if(doc.kind!=='pose'){assertPlaybackSelection(doc);await readLiveFile(doc,this.context);}
    await this.assertFresh(doc);assertVersion(version,this.requireDoc().version);
    if (doc.kind !== 'pose') {assertPlaybackSelection(doc);await readLiveFile(doc, this.context);}
    if(doc.derivedHash!==derivedHash)throw new HostError('SOLUTION_STALE','返回帧前派生结果已替换。',409);
    const result={ png, version, derivedHash, contentHash: doc.contentHash, dependencyFingerprint: doc.dependencyFingerprint, source: this.mode === 'mirror' ? 'disk' : 'solution', camera: doc.camera };
    if(size===480&&doc.kind==='pose')this.recentFrame={...result,png:Buffer.from(png),camera:structuredClone(doc.camera)};
    return result;
  }
  async previousFrame(expectedRevision:VersionRef){
    const doc=this.requireDoc();assertVersion(expectedRevision,doc.version);await this.assertFresh(doc);const old=this.priorFrame;
    assertVersion(expectedRevision,this.requireDoc().version);
    if(!old||old.version.documentId!==doc.version.documentId||old.version.openEpoch!==doc.version.openEpoch||objectHash(old.camera)!==objectHash(doc.camera))throw new HostError('NO_PREVIOUS_FRAME','当前文档没有同相机的前次诊断图，不跨文档复用。',404);
    return {...old,png:Buffer.from(old.png),advisory:true,evidenceEligible:false};
  }
  async inspect(view: string) {
    const doc = this.requireDoc(); await this.assertFresh(doc);
    const json = doc.skeletonJson;
    if (!['bones','slots','attachments','timelines'].includes(view)) throw new HostError('INVALID_ARGUMENT', 'view 仅支持 bones/slots/attachments/timelines。');
    return { ok: true, version: doc.version, view, value: view === 'bones' ? json?.bones ?? [] : view === 'slots' ? json?.slots ?? [] : view === 'attachments' ? json?.skins ?? [] : json?.animations ?? {} };
  }
}
