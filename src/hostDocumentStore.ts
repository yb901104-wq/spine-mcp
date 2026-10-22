import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextureAtlas } from '@esotericsoftware/spine-core';
import { loadProject, PROJECT_MANIFEST_PATH } from './projectModel.js';
import { type ProjectManifest } from './projectSchema.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import { readCommittedIndex } from './hostJournal.js';
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

export interface HostDocument {
  path: string; kind: DocumentKind; version: VersionRef; characterId: string | null;
  value: any; baseline: Buffer; fileHash: string; contentHash: string;
  dependencies: Array<{ filePath: string; hash: string }>; dependencyFingerprint: string;
  derived: any | null; derivedHash: string | null; snapshotHash: string;
  mapping: any; skeletonJson: any; atlasRaw: string; atlasPath: string;
  camera: { minX: number; minY: number; maxX: number; maxY: number };
  cameraInitialized: boolean;
  undo: any[]; redo: any[]; uncommitted: boolean; review: any | null; reviewHash: string | null;
}
export function editableValue(value: any) {
  const copy = structuredClone(value);
  for (const key of ['solution', 'review', 'comparisonPath', 'comparison', 'reviewToken', 'authorization']) delete copy[key];
  if (copy.kind === 'standing' || copy.kind === 'action') copy.status = 'draft';
  return copy;
}
export class HostDocumentStore {
  readonly sessionId = randomUUID();
  project: Awaited<ReturnType<typeof loadProject>> | null = null;
  active: HostDocument | null = null;
  pinned: { version: VersionRef; fileHashAtPin: string; pinnedAt: string } | null = null;
  writer: WriterLease | null = null;
  writeMode: 'observer' | 'attached' | 'frozen' = 'observer';
  frozen = false;
  protected queue: Promise<unknown> = Promise.resolve();
  protected pngCache = new Map<string, Buffer>();
  protected events: Array<{ id: number; type: string; version: VersionRef | null; data: unknown }> = [];
  protected eventNumber = 0;
  protected characterCatalog:any[]=[];
  onEvent?: (event: { id: number; type: string; version: VersionRef | null; data: unknown }) => void;
  constructor(public readonly context: ToolContext, public readonly mode: 'host' | 'mirror' = 'host') {}
  protected serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn); this.queue = result.catch(() => undefined); return result;
  }
  protected emit(type: string, data: unknown = {}) {
    const event = { id: ++this.eventNumber, type, version: this.active?.version ?? null, data };
    this.events.push(event); if (this.events.length > 200) this.events.shift(); this.onEvent?.(event);
  }
  eventHistory(after: number) {
    if (after && after < (this.events[0]?.id ?? 0) - 1) return [{ id: this.eventNumber, type: 'resync', version: this.active?.version ?? null, data: {} }];
    return this.events.filter(e => e.id > after);
  }
  protected requireDoc() {
    if (!this.active) throw new HostError('DOC_NOT_LOADED', '请先显式打开文档。', 409);
    return this.active;
  }
  resolve(file: string) {
    if (typeof file !== 'string' || !file.trim() || file.includes('\0') || /[:\x00-\x1f]/.test(file) || path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || file.replace(/\\/g, '/').split('/').includes('..')) throw new HostError('PATH_FORBIDDEN', '必须使用工作区内相对路径。', 403);
    try { return resolveWorkspacePath(file, this.context); }
    catch (error) { throw new HostError('PATH_FORBIDDEN', `路径越过工作区或边界无法核实：${String(error)}`, 403); }
  }
  protected async readJson(file: string) { return JSON.parse((await readFile(this.resolve(file), 'utf8')).replace(/^\uFEFF/, '')); }
  async assertFresh(document = this.requireDoc()) {
    const checks=await strictFileChecks([{ filePath: document.path, hash: document.fileHash }, ...document.dependencies],file=>this.resolve(file));
    for (const dependency of checks) {
      if(dependency.error){this.invalidateDerived(document);throw new HostError('TARGET_STALE',`依赖缺失或不可读：${dependency.filePath}`,409);}
      if (dependency.actual !== dependency.hash) {
        this.invalidateDerived(document);
        throw new HostError('TARGET_STALE', `磁盘或依赖发生变化：${dependency.filePath}，请保留未提交修改并显式处理重载。`, 409);
      }
    }
  }
  protected invalidateDerived(document: HostDocument) {
    document.derived = null; document.derivedHash = null; document.review = null; document.reviewHash = null;
    this.pngCache.clear();
  }
  protected updateSnapshot(document: HostDocument) {
    document.contentHash = objectHash(editableValue(document.value));
    document.snapshotHash = objectHash({ version: document.version, contentHash: document.contentHash, dependencyFingerprint: document.dependencyFingerprint });
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
  async open(args: { manifestPath?: string; path?: string; reload?: boolean; expectedRevision?: VersionRef }) {
    return this.serial(async () => {
      if (!args.manifestPath && !args.path) throw new HostError('INVALID_ARGUMENT', '至少给出 manifestPath 或 path。');
      if (args.manifestPath && args.manifestPath.replace(/\\/g, '/') !== PROJECT_MANIFEST_PATH) throw new HostError('PATH_FORBIDDEN', '工程清单只能使用工作区根 .spine-workflow.json。', 403);
      const old = this.active;
      if (old) {
        const identity=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
        const same = args.path && identity(await realpath(this.resolve(args.path))) === identity(await realpath(this.resolve(old.path)));
        if (same && !args.reload) { await this.assertFresh(old); return { ...await this.state(), reopened: true }; }
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
        this.project = project; this.characterCatalog=catalog; this.active = null; this.pinned = null; this.emit('doc-opened', { projectOnly: true });
        return { ...await this.state(), reopened: false };
      }
      const absolute = this.resolve(args.path), normalized = path.relative(this.context.workspaceRoot!, absolute).replace(/\\/g, '/');
      const actualPath = await realpath(absolute), identity = process.platform === 'win32' ? actualPath.toLowerCase() : actualPath;
      let binding: ProjectManifest['documents'][number] | undefined;
      if (project.mode === 'managed') {
        const key = (p: string) => process.platform === 'win32' ? this.resolve(p).toLowerCase() : this.resolve(p);
        binding = project.manifest.documents.find(d => key(d.path) === key(normalized));
        if (!binding) {
          const index = await readCommittedIndex(this.context), entry = index.find(d => key(d.path) === key(normalized));
          if (!entry) throw new HostError('PROJECT_BINDING_CONFLICT', '文档未在根 manifest 或已确认提交记录中登记。', 409);
          const visited = new Set<string>(); let source = entry.sourceDocument;
          while (!project.manifest.documents.some(d => key(d.path) === key(source))) {
            if (visited.has(source)) throw new HostError('PROJECT_BINDING_CONFLICT', '受管索引来源存在循环。', 409);
            visited.add(source); const previous = index.find(d => key(d.path) === key(source));
            if (!previous || previous.characterId !== entry.characterId) throw new HostError('PROJECT_BINDING_CONFLICT', '受管索引缺少可信源文档。', 409);
            source = previous.sourceDocument;
          }
          const origin = project.manifest.documents.find(d => key(d.path) === key(source))!;
          if (origin.characterId !== entry.characterId || origin.kind !== entry.kind || strictHash(await readFile(absolute)) !== entry.hash) throw new HostError('PROJECT_BINDING_CONFLICT', '受管修订的角色、类型或字节哈希不符。', 409);
          binding = { ...origin, path: normalized };
        }
      }
      const baseline = await readFile(absolute), value = JSON.parse(baseline.toString('utf8'));
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
      const document: HostDocument = {
        path: normalized, kind, version: { sessionId: this.sessionId, documentId: objectHash({ projectId: this.context.projectId ?? project.mode, path: identity, kind }), openEpoch: randomUUID(), revision: 0 },
        characterId: binding?.characterId ?? null, value: editableValue(value), baseline, fileHash: strictHash(baseline), contentHash: '',
        dependencies: deps, dependencyFingerprint: objectHash({files:deps,policyFingerprint}), snapshotHash: '', derived: null, derivedHash: null,
        mapping, skeletonJson, atlasRaw, atlasPath, camera: { minX: origin[0] - scale * 1.5, maxX: origin[0] + scale * 1.5, minY: origin[1] - scale * .25, maxY: origin[1] + scale * 2.75 },cameraInitialized:false,
        undo: [], redo: [], uncommitted: false, review: null, reviewHash: null,
      };
      this.updateSnapshot(document);
      if (kind === 'pose' && value.solution) {
        const digest = await poseDigest(value, this.context);
        if (digest.freshness === 'current') {
          document.derived = { bones: value.solution.bones, numeric: value.solution, frame: value.frame, actualNodes: value.solution.visualNodes ?? value.solution.joints, inputFingerprint: poseInputHash(value), poseDependencyFingerprint: value.solution.dependencyFingerprint };
          document.derivedHash = derivedFingerprint(document.snapshotHash, document.derived);
          const runtime=createMotionRuntime(document.skeletonJson,document.atlasRaw);
          applyRenderSnapshot(runtime.skeleton,{bones:value.solution.bones,skin:document.mapping.skin,slotAttachments:document.mapping.bones.slotAttachments,presentation:value.frame.presentation});
          this.initializeCamera(document,runtime.skeleton);
        }
      }
      const previousProject=this.project,previousPinned=this.pinned;
      this.project = project; this.active = document; this.pinned = null; this.pngCache.clear();
      try { await this.afterOpen(document); await this.assertFresh(document); }
      catch(error){this.project=previousProject;this.active=old;this.pinned=previousPinned;throw error;}
      this.characterCatalog=catalog;
      this.emit('doc-opened', { path: normalized });
      return { ...await this.state(), reopened: false };
    });
  }
  async state(includeCapabilities = true): Promise<any> {
    if(this.writer&&!this.frozen)try{await verifyWriter(this.writer,this.context);}catch{this.frozen=true;}
    let stale = false, staleReason: any = null;
    if (this.active) { try { await this.assertFresh(); } catch (error: any) { stale = true; staleReason = { code: error.code, message: error.message }; } }
    const doc = this.active;
    return {
      ok: true, apiVersion: '1', available: this.mode === 'host', degraded: this.mode === 'mirror' || this.frozen,
      mode: this.mode === 'mirror' ? 'mirror' : 'host', sessionId: this.sessionId, projectId: this.context.projectId ?? null,
      project: this.project ? { mode: this.project.mode, name:this.project.mode==='managed'?this.project.manifest.name:null, manifestPath: this.project.manifestPath, manifestHash: 'manifestHash' in this.project ? this.project.manifestHash : null } : null,
      activeDoc: doc ? { path: doc.path, kind: doc.kind, characterId: doc.characterId, version: doc.version } : null,
      version: doc?.version ?? null, revision: doc?.version.revision ?? null, contentHash: doc?.contentHash ?? null,
      fileHash: doc?.fileHash ?? null, dependencyFingerprint: doc?.dependencyFingerprint ?? null, snapshotHash: doc?.snapshotHash ?? null,
      target: this.pinned, pinned: !!this.pinned, targetStale: stale, staleReason,
      derivedHash: doc?.derivedHash ?? null, reviewHash: doc?.reviewHash ?? null,
      capabilitiesFingerprint:objectHash({characters:this.characterCatalog,kind:doc?.kind??null,writeMode:this.writeMode,replaySchema:REPLAY_SCHEMA_VERSION}),
      writeMode: this.frozen ? 'frozen' : this.writeMode, writer: this.writer ? { ownerId: this.writer.ownerId, generation: this.writer.generation, verified: !this.frozen } : null,
      undoDepth: doc?.undo.length ?? 0, redoDepth: doc?.redo.length ?? 0, uncommitted: doc?.uncommitted ?? false,
      numeric: doc?.derived?.numeric ?? { status: 'notRun' }, reference: doc?.derived?.comparison ?? { status: 'notRun' },
      agentVisual: doc?.review ? { status: doc.review.decision } : { status: 'notRun' }, editorImport: { status: 'notRun' },
      runtime: { player: '4.1.56', core: '4.1.56', replaySchema: REPLAY_SCHEMA_VERSION, versionDrift: false },
      ...(includeCapabilities ? { capabilities: this.capabilities(stale) } : {}),
    };
  }
  capabilities(stale = false) {
    const doc = this.active, mapping = doc?.mapping;
    const operations = [
      { operation: 'open', supported: true, canRun: true },
      { operation: 'inspect', supported: true, canRun: true },
      { operation: 'evaluate', supported: doc?.kind === 'pose', canRun: !!doc && doc.kind === 'pose' && !stale },
      { operation: 'frame', supported: doc?.kind === 'pose', canRun: !!doc?.derived && !stale },
      { operation: 'capture', supported: doc?.kind === 'pose', canRun: false, reason: '需要真实 player 摆帧与当前版本独立截图核验。' },
      { operation: 'review', supported: doc?.kind === 'pose' && this.writeMode === 'attached', canRun: false, reason: '附着审查需要当前 player 证据；可记录退回，批准另需内容门禁。' },
      { operation: 'patch', supported: this.writeMode === 'attached' && doc?.kind === 'pose', canRun: this.writeMode === 'attached' && !!this.pinned && !stale && !this.frozen },
      { operation: 'commit', supported: this.writeMode === 'attached' && doc?.kind === 'pose', canRun: false, reason: '真实提交仍须精确候选与 MCP 一次性授权。' },
    ];
    return {
      context: { projectId: this.context.projectId ?? null, characterId: doc?.characterId ?? null, version: doc?.version ?? null },
      characters:structuredClone(this.characterCatalog),
      operations: operations.map(op => ({ ...op, schemaVersion: 1, checked: 'fast',observedAt:new Date().toISOString(), state: stale ? 'stale' : op.canRun ? 'ready' : op.supported ? 'blocked' : 'unsupported', reasons: op.canRun ? [] : [{ code: stale ? 'TARGET_STALE' : 'CAPABILITY_MISSING', message: (op as any).reason ?? '缺少活动文档、当前结果、pin 或开放的写入能力。' }], nextAction: { tool: null, instruction: '按原因补齐依赖；执行前仍需 strict 检查。' } })),
      character: {
        channels: mapping?.bones?.channels ?? {}, chains: Object.fromEntries(['leftArm','rightArm','leftLeg','rightLeg'].map(k => [k, mapping?.bones?.[k] ?? null])),
        anchors: mapping?.bones?.anchors ?? {}, mappingStatus: mapping?.status ?? 'unknown',
        viewProfiles: { status: 'unknown', message: '视角需 visualRig 当前指纹与切片证据独立确认。' },
        handTargets: ['leftHand','rightHand'].map(role => ({ role, supported: !!mapping?.bones?.anchors?.[role], controlledFields: doc?.value.weapon ? ['x','y'] : [], coordinateSystem: 'normalizedSkeleton', angleUnit: 'degree' })),
      },
    };
  }
  async snapshot(expectedRevision: VersionRef) {
    return this.serial(async () => {
      const doc = this.requireDoc(); assertVersion(expectedRevision, doc.version); await this.assertFresh(doc);
      return structuredClone({ version: doc.version, project: this.project, document: doc.value, kind: doc.kind,
        path: doc.path, contentHash: doc.contentHash, dependencies: doc.dependencies, policyFingerprint, dependencyFingerprint: doc.dependencyFingerprint, snapshotHash: doc.snapshotHash, derived: doc.derived, derivedHash: doc.derivedHash });
    });
  }
  async publishDerived(args: any) {
    return this.serial(async () => {
      const doc = this.requireDoc(); assertVersion(args.expectedRevision, doc.version); await this.assertFresh(doc);
      if (args.snapshotHash !== doc.snapshotHash || args.dependencyFingerprint !== doc.dependencyFingerprint) throw new HostError('SOLUTION_STALE', '派生结果不属于当前完整快照。', 409);
      const result = args.result;
      if (!result || !result.bones || !result.numeric || !result.actualNodes || Object.keys(result).some(k => !['bones','numeric','actualNodes','comparison','frame','inputFingerprint','poseDependencyFingerprint','live','renderState','diagnosticOnly'].includes(k))) throw new HostError('SOLUTION_INVALID', '派生结果结构无效或包含未允许的审查/批准字段。');
      if (doc.kind !== 'pose') throw new HostError('UNSUPPORTED_DOC_KIND', '当前发布入口只支持 pose。');
      if (result.inputFingerprint !== poseInputHash(doc.value)) throw new HostError('SOLUTION_STALE', '求解输入指纹不匹配。', 409);
      const runtime = createMotionRuntime(doc.skeletonJson, doc.atlasRaw);
      applyRenderSnapshot(runtime.skeleton, { bones: result.bones, skin: doc.mapping.skin, slotAttachments: doc.mapping.bones.slotAttachments, presentation: doc.value.frame.presentation });
      if (result.live) {
        if (typeof result.live.path !== 'string' || result.live.path !== `.spine-mcp/live/${doc.version.documentId}/${doc.version.openEpoch}/${derivedFingerprint(doc.snapshotHash, result)}/pose.json` || strictHash(await readFile(this.resolve(result.live.path))) !== result.live.hash) throw new HostError('SOLUTION_INVALID', 'live 路径或内容哈希不符。');
      }
      const nextHash=derivedFingerprint(doc.snapshotHash,result);
      if(doc.derivedHash===nextHash)return{ok:true,version:doc.version,derivedHash:nextHash,reused:true};
      this.initializeCamera(doc,runtime.skeleton);
      this.invalidateDerived(doc); doc.derived = structuredClone(result); doc.derivedHash = nextHash;
      this.emit('frame-updated', { derivedHash: doc.derivedHash });
      return { ok: true, version: doc.version, derivedHash: doc.derivedHash, diagnosticOnly: result.numeric.ok !== true || result.comparison?.ok === false };
    });
  }
  async frame(args: { expectedRevision: VersionRef; size?: number; time?: number }) {
    const doc = this.requireDoc(); assertVersion(args.expectedRevision, doc.version); await this.assertFresh(doc);
    if (doc.kind !== 'pose') throw new HostError('UNSUPPORTED_DOC_KIND', '当前 frame 只支持 pose。');
    if (!doc.derived) throw new HostError('NO_SOLUTION', '没有可证明新鲜的求解结果；请显式重算。', 409);
    const size = args.size ?? 480;
    if (![320, 480].includes(size)) throw new HostError('INVALID_ARGUMENT', 'frame 尺寸仅支持 320/480。');
    if (args.time !== undefined && (!Number.isFinite(args.time) || args.time !== doc.value.frame.time)) throw new HostError('INVALID_ARGUMENT', '单姿态只允许其记录的时间。');
    const version = structuredClone(doc.version), derivedHash = doc.derivedHash;
    const key = objectHash({ version, derivedHash, camera: doc.camera, size, pma: true, time: args.time ?? doc.value.frame.time });
    let png = this.pngCache.get(key);
    if (!png) {
      const rt = createMotionRuntime(doc.skeletonJson, doc.atlasRaw);
      applyRenderSnapshot(rt.skeleton, { bones: doc.derived.bones, skin: doc.mapping.skin, slotAttachments: doc.mapping.bones.slotAttachments, presentation: doc.value.frame.presentation });
      const images = await loadAtlasImages(rt.atlas, doc.atlasPath, this.context);
      png = rasterFrame(rt.skeleton, images, doc.camera, size, size, '#20242b').toBuffer('image/png');
      assertVersion(version, this.requireDoc().version); await this.assertFresh(doc);
      if (derivedHash !== doc.derivedHash) throw new HostError('SOLUTION_STALE', '渲染期间结果已替换。', 409);
      this.pngCache.set(key, png); if (this.pngCache.size > 16) this.pngCache.delete(this.pngCache.keys().next().value!);
    }
    await this.assertFresh(doc);assertVersion(version,this.requireDoc().version);
    if(doc.derivedHash!==derivedHash)throw new HostError('SOLUTION_STALE','返回帧前派生结果已替换。',409);
    return { png, version, derivedHash, contentHash: doc.contentHash, dependencyFingerprint: doc.dependencyFingerprint, source: this.mode === 'mirror' ? 'disk' : 'solution', camera: doc.camera };
  }
  async inspect(view: string) {
    const doc = this.requireDoc(); await this.assertFresh(doc);
    const json = doc.skeletonJson;
    if (!['bones','slots','attachments','timelines'].includes(view)) throw new HostError('INVALID_ARGUMENT', 'view 仅支持 bones/slots/attachments/timelines。');
    return { ok: true, version: doc.version, view, value: view === 'bones' ? json?.bones ?? [] : view === 'slots' ? json?.slots ?? [] : view === 'attachments' ? json?.skins ?? [] : json?.animations ?? {} };
  }
}
