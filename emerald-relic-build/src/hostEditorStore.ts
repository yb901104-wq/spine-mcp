import { readArmCalibration,assertCalibrationFrame } from './armCalibration.js';
import { poseDependencies } from './poseDigest.js';
import { isDiagnosticPerspective } from './perspective.js';
import { applyMotionInterval, intervalPoseValues, motionIntervalOpsSchema, assertMotionRecovery } from './motionInterval.js';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HostDocumentStore, editableValue, type HostDocument } from './hostDocumentStore.js';
import { inputDiff, invalidatePose } from './animationCommands.js';
import { applyHostPosePatch, assertPoseRecovery, c1PatchOpsSchema, c2PosePatchOpsSchema, poseParameterCapabilities, posePresentationCapabilities, poseTargetCapabilities, posePerspectiveCapabilities, type HostEditProfile } from './hostPosePatch.js';
import { assertVersion, HostError, objectHash, strictHash, rejectFields, type VersionRef } from './hostContracts.js';
import { HostJournal, readCommittedIndex, findJournalRequest, type JournalRecord } from './hostJournal.js';
import { acquireWriter, releaseWriter, verifyWriter } from './writerOwnership.js';
import { withFileLock } from './jobTools.js';
import { poseInputHash } from './animationKernel.js';
import { CAPTURE_EVIDENCE_SCHEMA } from './captureEvidence.js';
import { materializeHostPose } from './hostPose.js';
import { poseFingerprint, validatePoseReviewInput } from './poseWorkflow.js';
import { hashObject,rigHash } from './mappingTools.js';
import { comparisonFingerprint,policyFingerprint } from './poseGraph.js';
import type { ToolContext } from './spineJson.js';
import { hostPoseCommandCapabilities } from './hostPoseCommands.js';
import { managedDocumentBinding, assetDependencies, validateAssetBinding, type AssetBinding } from './hostAssetBinding.js';
import {assertAnimationSession,assertHostAnimationReviewFresh,validateHostAnimationReview,writeAnimationRecord,type AnimationSession} from './hostAnimationSession.js';
import { comparisonManifestProblem,expectedRetargetManifestProblem } from './animationAcceptancePolicy.js';
import {auditGeneratedAnimationCandidate,createWorkspaceReadResolver,resolveWorkspacePathAsync,type WorkspaceReadResolver} from './spineJson.js';
import {invalidate} from './runtimeCache.js';
import {withFileCheckBatch} from './strictFileChecks.js';
import { playbackInputHash } from './hostPlayback.js';
import { buildDiagnosticPose, diagnosticIdentity } from './hostDiagnosticPose.js';
interface Authorization {
  id: string; candidateHash: string; outputPath: string; snapshotHash: string; derivedHash: string | null;
  reviewHash: string | null; generation: number; expiresAt: number;
  intent?:'animation';sourceHash?:string;
}
export class HostEditorStore extends HostDocumentStore {
  /** C2 研发 profile 仅供程序内隔离验收；生产入口与 C1 审批不能选择或授予它。 */
  constructor(context: ToolContext, mode: 'host' | 'mirror' = 'host', public readonly editProfile: HostEditProfile = 'c1') {
    super(context, mode);
    if (!['c1', 'c2-pose'].includes(editProfile)) throw new HostError('INVALID_ARGUMENT', '未知编辑能力 profile。');
  }
  protected override capabilityEdition() { return this.editProfile; }
  override capabilities(stale = false, checked: 'fast' | 'strict' = 'fast') {
    const result = super.capabilities(stale, checked), c2 = this.editProfile === 'c2-pose';
    const assetSupported=c2&&this.mode==='host'&&['pose','skeleton'].includes(this.active?.kind??'');
    const pinCurrent=!!this.active&&!!this.pinned&&this.pinned.version.documentId===this.active.version.documentId&&this.pinned.version.openEpoch===this.active.version.openEpoch&&(this.active.kind!=='skeleton'||this.pinned.intent==='asset');
    const assetReason=!assetSupported?'CAPABILITY_MISSING':this.frozen?'WRITE_OWNERSHIP_UNCERTAIN':!this.writer||this.writeMode!=='attached'||this.writeDraining?'WRITE_FORBIDDEN':this.project?.mode!=='managed'?'PROJECT_MANIFEST_REQUIRED':stale?'TARGET_STALE':!pinCurrent?'TARGET_NOT_PINNED':this.pendingOperations?'HOST_BUSY':null;
    const candidateCurrent=!!this.assetCandidate&&objectHash(this.assetCandidate.version)===objectHash(this.active?.version)&&this.assetCandidate.snapshotHash===this.active?.snapshotHash;
    const assetReadiness=(save:boolean)=>{const code=assetReason??(save&&!candidateCurrent?'ASSET_CANDIDATE_MISSING':null);return {supported:assetSupported,canRun:!code,checked,reasons:code?[{code,message:code==='ASSET_CANDIDATE_MISSING'?'先预演并暂存精确新资产候选。':'按完整版本核对新资产来源的 profile、写入权、pin 与依赖状态。'}]:[]};};
    const animationSupported=c2&&this.mode==='host'&&this.active?.kind==='motion'&&this.active.skeletonJson?.skeleton?.spine==='4.1.24';
    const animationReason=!animationSupported?'CAPABILITY_MISSING':this.frozen?'WRITE_OWNERSHIP_UNCERTAIN':!this.writer||this.writeMode!=='attached'||this.writeDraining?'WRITE_FORBIDDEN':stale?'TARGET_STALE':!pinCurrent||this.pinned?.intent!=='animation'?'TARGET_NOT_PINNED':this.pendingOperations?'HOST_BUSY':!this.animationSessionValue?'NO_SOLUTION':this.animationSessionValue.review?.review.decision!=='approved'?'REVIEW_REQUIRED':null;
    return { ...result, operations: result.operations.map(operation => operation.operation === 'patch' ? { ...operation, schemaVersion: c2 ? 2 : 1 } : operation),
      editing: { profile: this.editProfile, experimental: c2, schemaVersion: c2 ? 2 : 1,
      patchOps: c2 ? this.active?.kind==='motion'?motionIntervalOpsSchema:c2PosePatchOpsSchema : c1PatchOpsSchema, targets: poseTargetCapabilities(this.active, c2 ? undefined : ['leftHand', 'rightHand']),
      parameters: c2 ? poseParameterCapabilities(this.active) : null, presentation: c2 ? posePresentationCapabilities(this.active) : null,
      perspective: c2 ? posePerspectiveCapabilities(this.active) : null,
      motionIntervals:{supported:c2&&this.mode==='host'&&this.active?.kind==='motion'&&!!this.active.value.poseWorkflow,tool:'spine_edit_motion_interval',boundaries:'existingFramesImmutable',selectedOnly:true,requiresReviewedKeyPoses:true},
      commandAdapters: hostPoseCommandCapabilities(c2 && this.mode==='host' && this.active?.kind==='pose'),
      assetDrafts:{supported:assetSupported,tools:['spine_create_pose_draft','spine_build_motion_from_poses','spine_retarget_reference_pose','spine_refine_reference_pose'],requiresPin:true,pinIntent:'asset',saveTool:'spine_host_commit',intent:'asset',requiresCandidateHash:true,saveSwitchesDocument:false,readiness:{stage:assetReadiness(false),commit:assetReadiness(true)}},
      animationCandidates:{supported:animationSupported,tool:'spine_retarget_motion',expectedRevision:'required',sourceVersion:'4.1.24',motionVersion:2,animationName:'motion.name',dryRunOnly:true,exactFittedPlayback:true,issuesReviewToken:true,reviewTool:'spine_review_animation',reviewRequiresPlayer:true,sourceCommitSupported:animationSupported,pinIntent:'animation',commitTool:'spine_host_commit',commitIntent:'animation',readiness:{commit:{supported:animationSupported,canRun:!animationReason,checked,reasons:animationReason?[{code:animationReason,message:'源动画提交须当前完整版本、显式动画 pin、精确候选及完整视觉批准。'}]:[]}}},
      fixedConditions: ['source', 'reference', 'mapping', 'visualRig', 'support', 'bendDirections', 'weapon', 'groundY'] } };
  }
  private journals = new Map<string, HostJournal>();
  private authorizations = new Map<string, Authorization>();
  private captureRecords = new Map<string, { manifestPath: string; manifestHash: string }>();
  private lastCapture: any = null;
  private assetCandidate: {version:VersionRef;snapshotHash:string;outputPath:string;candidate:any;candidateHash:string;bytes:string;binding:AssetBinding;dependencies:Array<{filePath:string;hash:string}>}|null=null;
  private animationSessionValue:AnimationSession|null=null;
  private writeDraining = false;
  override async state(includeCapabilities = true): Promise<any> {
    const pendingRoot=this.active?createWorkspaceReadResolver(this.context).catch(()=>undefined):Promise.resolve(undefined);
    const readResolver:WorkspaceReadResolver=async file=>{
      const resolved=await pendingRoot;
      return resolved?resolved(file):resolveWorkspacePathAsync(file,this.context,{canonicalExisting:true});
    };
    return withFileCheckBatch(async()=>{try{return await this.checkedState(includeCapabilities,readResolver);}finally{await pendingRoot;}});
  }
  private async checkedState(includeCapabilities:boolean,readResolver?:WorkspaceReadResolver):Promise<any>{
    const animationAtStart=this.animationSessionValue,documentAtStart=this.active;
    // 基线依赖与动画证据是独立只读核验；全部收束后再按同一版本消费，不缓存旧结果。
    const checked=await Promise.allSettled([super.state(includeCapabilities,readResolver),animationAtStart?assertAnimationSession(animationAtStart,documentAtStart,this.context,true,readResolver):Promise.resolve()]);
    if(checked[0].status==='rejected')throw checked[0].reason;
    const state=checked[0].value,capture = this.lastCapture;
    if(this.active?.review){
      try{if(state.targetStale)throw new HostError('REVIEW_STALE','文档依赖已漂移。',409);await this.assertReviewFresh(this.active);}
      catch(error:any){state.agentVisual={status:'stale',decision:this.active.review.decision,code:'REVIEW_STALE',message:error.message};}
    }
    const currentCapture=capture && !state.targetStale && objectHash(capture.version) === objectHash(state.version) && capture.derivedHash === state.derivedHash ? structuredClone(capture) : null;
    const operation=state.capabilities?.operations.find((op:any)=>op.operation==='review');
    if(operation?.supported&&operation.reasons.some((reason:any)=>reason.code==='CAPTURE_UNVERIFIED')&&currentCapture?.evidenceEligible&&!this.frozen){
      operation.canRun=true;operation.state='ready';operation.reasons=[];operation.nextAction={tool:'spine_review_pose',instruction:'携带当前完整版本与 player manifest；默认只预演，可记录退回，批准仍须全部内容门禁。'};
    }
    const asset=this.assetCandidate;
    const animation=this.animationSessionValue,currentAnimation=animation&&animation===animationAtStart&&objectHash(animation.version)===objectHash(state.version)&&animation.derivedHash===state.derivedHash?animation:null;
    const animationStale=!!currentAnimation&&checked[1].status==='rejected';
    if(animationStale&&state.capabilities?.editing.animationCandidates){const ready=state.capabilities.editing.animationCandidates.readiness.commit;ready.canRun=false;ready.reasons=[{code:'REVIEW_STALE',message:'动画候选或证据已变化，须重新制作和审查。'}];}
    return { ...state,...currentAnimation?.review?{agentVisual:{status:animationStale?'stale':currentAnimation.review.review.decision}}:{},capture:currentCapture,assetCandidate:asset&&objectHash(asset.version)===objectHash(state.version)&&asset.snapshotHash===state.snapshotHash?{candidateHash:asset.candidateHash,outputPath:asset.outputPath,kind:asset.binding.kind,persisted:false}:null,
      animationCandidate:currentAnimation?{candidateHash:currentAnimation.candidateHash,baseToken:currentAnimation.baseToken,sourcePath:currentAnimation.sourcePath,sourceHash:currentAnimation.sourceHash,readyForAnimationReview:!animationStale,reviewHash:currentAnimation.reviewHash??null,reviewDecision:animationStale?'stale':currentAnimation.review?.review.decision??'notRun',sourceCommitSupported:true}:null };
  }
  private async assertReviewFresh(doc:HostDocument){
    if(!doc.review)return;
    const record=doc.review.record;
    if(!doc.derived||record.poseFingerprint!==poseFingerprint(materializeHostPose(doc.value,doc.derived))||objectHash(record.hostBinding?.version)!==objectHash(doc.version)||record.hostBinding?.snapshotHash!==doc.snapshotHash||record.hostBinding?.derivedHash!==doc.derivedHash)throw new HostError('REVIEW_STALE','审查不属于当前姿态候选。',409);
    for(const item of doc.review.evidence){
      let bytes:Buffer;try{bytes=await readFile(this.resolve(item.filePath));}catch{throw new HostError('REVIEW_STALE','审查证据缺失，请重新截图并审查。',409);}
      if(strictHash(bytes)!==item.hash)throw new HostError('REVIEW_STALE','审查证据已变化，请重新截图并审查。',409);
    }
  }
  /** 仅由 Host 截图完成流程调用；重启后不恢复旧证据的准入状态。 */
  async registerCapture(manifestPath: string, manifest: any) {
    return this.serial(async () => {
      const doc = this.requireDoc(); assertVersion(manifest.version, doc.version); await this.assertFresh(doc);
      if (manifest.snapshotHash !== doc.snapshotHash || manifest.derivedHash !== doc.derivedHash) throw new HostError('SOLUTION_STALE', '登记截图前候选发生变化。', 409);
      this.captureRecords.set(manifest.evidence[0].filePath, { manifestPath, manifestHash: strictHash(await readFile(this.resolve(manifestPath))) });
      this.lastCapture = { version: manifest.version, derivedHash: manifest.derivedHash, captureValidity: manifest.captureValidity, rendererParity: manifest.rendererParity, evidenceEligible: manifest.evidenceEligible, manifestPath };
      if (this.captureRecords.size > 128) this.captureRecords.delete(this.captureRecords.keys().next().value!);
      this.emit('capture-done', { manifestPath, evidenceEligible: manifest.evidenceEligible, rendererParity: manifest.rendererParity });
    });
  }
  /** 只用于隔离故障测试；不从 HTTP 请求接收。 */
  fault?: (point: 'journal' | 'backup' | 'publish' | 'afterPublish' | 'committed') => void;
  async enableWriting() {
    if (this.mode !== 'host') throw new HostError('WRITE_FORBIDDEN', '镜像模式不能取得 Host 写入权。', 409);
    if (this.writer || this.frozen) throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '已有写入权或冻结状态，不能重复启用。', 409);
    this.writer = await acquireWriter(this.context, 'attached'); this.writeMode = 'attached'; this.frozen = false;
    this.writeDraining = false;
  }
  /** 立即拒绝新写操作，等待已开始事务及 journal 落盘，再记录撤销并释放排他权。 */
  async disableWriting(beforeRelease?: () => Promise<void>) {
    this.writeDraining = true;
    return this.serial(async () => {
      if (this.frozen) throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '冻结状态不能当作已安全释放，须先恢复裁决。', 409);
      try {
        await beforeRelease?.();
        if (this.writer) { await releaseWriter(this.writer, this.context); this.writer = null; }
        this.authorizations.clear(); this.pinned = null; this.writeMode = 'observer';
        this.emit('write-mode-changed', { writeMode: 'observer' });
        return { ok: true, writeMode: 'observer' };
      } catch (error) { this.frozen = true; this.writeMode = 'frozen'; throw error; }
    });
  }
  async shutdown() {
    await this.serial(async () => {
      if (this.writer && !this.frozen) { await releaseWriter(this.writer, this.context); this.writer = null; }
      this.writeMode = this.frozen ? 'frozen' : 'observer'; this.emit('preview-closed');
    });
  }
  protected override invalidateDerived(document: HostDocument) {
    super.invalidateDerived(document); this.authorizations.clear();this.assetCandidate=null;this.animationSessionValue=null;
  }
  private async writable(expectedRevision: VersionRef) {
    const doc = this.requireDoc(); assertVersion(expectedRevision, doc.version);
    if (this.writeDraining) throw new HostError('WRITE_FORBIDDEN', '正在收束写入并退回观察模式，拒绝新写操作。', 409);
    if (this.project?.mode !== 'managed') throw new HostError('PROJECT_MANIFEST_REQUIRED', '编辑前必须初始化并打开受管工程。', 409);
    if (this.frozen || !this.writer) throw new HostError(this.frozen ? 'WRITE_OWNERSHIP_UNCERTAIN' : 'WRITE_FORBIDDEN', '当前没有已确认的 Host 排他写入权。', 409);
    try { await verifyWriter(this.writer, this.context); }
    catch (error) { this.frozen = true; throw error; }
    if (!this.pinned || this.pinned.version.documentId !== doc.version.documentId || this.pinned.version.openEpoch !== doc.version.openEpoch) throw new HostError('TARGET_NOT_PINNED', '先调用 spine_host_pin 绑定当前活动文档。', 409);
    await this.assertFresh(doc);
    if (this.pinned.fileHashAtPin !== doc.fileHash) throw new HostError('TARGET_STALE', 'pin 的磁盘基线已失效。', 409);
    return doc;
  }
  private async journal(document: HostDocument) {
    let journal = this.journals.get(document.version.documentId);
    if (!journal) {
      journal = new HostJournal(document.version.documentId, this.context);
      await journal.read(); this.journals.set(document.version.documentId, journal);
    }
    await journal.initialize({ docPath: document.diagnostic?.sourcePath??document.path, sessionId: this.sessionId, lastCommittedHash: document.fileHash, lastCommittedRevision: 0,
      ...document.diagnostic?{diagnostic:document.diagnostic,diagnosticBaseline:JSON.parse(document.baseline.toString('utf8')),diagnosticDependencies:document.dependencies,diagnosticDependencyFingerprint:document.dependencyFingerprint}:{} });
    return journal;
  }
  protected override async afterOpen(document: HostDocument) {
    this.animationSessionValue=null;this.assetCandidate=null;this.authorizations.clear();this.captureRecords.clear();this.lastCapture=null;
    const journal = new HostJournal(document.version.documentId, this.context);
    let records: JournalRecord[];
    try { records = await journal.read(); }
    catch (error) {
      if (!this.writer) throw error;
      const archive = await journal.archive('corrupt'); this.emit('recovery-warning', { code: 'JOURNAL_CORRUPT', archive }); records = [];
    }
    this.journals.set(document.version.documentId, journal);
    if (!records.length) return;
    // 先裁决未完成提交，再考虑普通编辑恢复。
    for (const prepare of records.filter(r => r.type === 'prepare')) {
      if (records.some(r => ['committed', 'aborted'].includes(r.type) && r.requestId === prepare.requestId)) continue;
      if (!this.writer) throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '有未裁决的提交；取得排他写入权后恢复。', 409);
      let targetHash: string | null = null;
      try { targetHash = strictHash(await readFile(this.resolve(prepare.outputPath))); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (targetHash === prepare.candidateHash) {
        await journal.append({ type: 'committed', requestId: prepare.requestId, requestFingerprint: prepare.requestFingerprint, receipt: prepare.receipt, indexEntry: prepare.indexEntry,...prepare.animationCommit?{animationCommit:prepare.animationCommit}:{}, recovered: true });
      } else if (targetHash === prepare.expectedOutputHash) {
        await journal.append({ type: 'aborted', requestId: prepare.requestId, message: '原子发布未发生，不自动重试提交。' });
      } else {
        this.frozen = true;
        throw new HostError('TARGET_STALE', '未完成提交的输出既非候选也非旧基线，保持冻结并保留 journal。', 409);
      }
    }
    records = journal.records;
    const lastCommit = records.reduce((last, r, index) => r.type === 'committed'&&r.receipt?.switched!==false ? index : last, -1);
    const edit = records.slice(lastCommit + 1).reverse().find(r => r.type === 'edit');
    if (!edit) return;
    if (edit.fileHash !== document.fileHash) {
      if (!this.writer) throw new HostError('TARGET_STALE', '有未提交 journal 且磁盘已变化；需写入权归档冲突。', 409);
      const archive = await journal.archive('rejected'); this.emit('recovery-warning', { code: 'TARGET_STALE', archive, diskWins: true }); return;
    }
    try { for (const value of [edit.document, ...(edit.undo ?? []), ...(edit.redo ?? [])]) this.assertEditingRecovery(document, editableValue(value)); }
    catch { throw new HostError('JOURNAL_CORRUPT', '恢复内容超出当前 pose profile、参数能力或固定绑定白名单。', 409); }
    if(document.kind==='motion'){
      const binding=managedDocumentBinding(document.path,(this.project as any).manifest,await readCommittedIndex(this.context),this.context),deps=new Map(document.dependencies.map(d=>[d.filePath,d]));
      for(const value of [edit.document,...edit.undo??[],...edit.redo??[]]){
        await validateAssetBinding(value,binding,(this.project as any).manifest,await readCommittedIndex(this.context),this.context,false);
        for(const d of await assetDependencies(value,binding,(this.project as any).manifest,this.context)){const old=deps.get(d.filePath);if(old&&old.hash!==d.hash)throw new HostError('TARGET_STALE','恢复区间依赖漂移。',409);deps.set(d.filePath,d);}
      }
      const checked=[...deps.values()].sort((a,b)=>a.filePath.localeCompare(b.filePath));
      if(objectHash(checked)!==objectHash(edit.dependencies))throw new HostError('TARGET_STALE','恢复区间依赖与 journal 不一致。',409);
      document.dependencies=checked;document.dependencyFingerprint=objectHash({files:checked,policyFingerprint});
    }
    if(document.kind==='pose'&&[edit.document,...edit.undo??[],...edit.redo??[]].some(v=>v.frame?.perspective?.mode&&v.frame.perspective.mode!=='diagnostic')){
      const all=new Map(document.dependencies.map(d=>[d.filePath,d]));
      for(const v of [edit.document,...edit.undo??[],...edit.redo??[]]){if(v.frame?.perspective?.mode&&v.frame.perspective.mode!=='diagnostic'){const calibration=await readArmCalibration(v.frame.perspective,this.context,v.sourceFingerprint);assertCalibrationFrame(calibration,v.frame);}for(const d of (await poseDependencies(v,this.context)).dependencies){const old=all.get(d.filePath);if(old&&old.hash!==d.hash)throw new HostError('TARGET_STALE','恢复校准依赖已变化。',409);all.set(d.filePath,d);}}
      const checked=[...all.values()].sort((a,b)=>a.filePath.localeCompare(b.filePath));if(objectHash(checked)!==objectHash(edit.dependencies))throw new HostError('TARGET_STALE','恢复校准依赖与日志不一致。',409);document.dependencies=checked;document.dependencyFingerprint=objectHash({files:checked,policyFingerprint});
    }
    document.value = this.invalidateEditing(document,structuredClone(edit.document));
    document.undo = (edit.undo ?? []).map((p: any) => this.invalidateEditing(document,structuredClone(p)));
    document.redo = (edit.redo ?? []).map((p: any) => this.invalidateEditing(document,structuredClone(p)));
    document.version = { ...document.version, revision: 1 };
    document.uncommitted = edit.uncommitted;
    this.invalidateDerived(document); this.updateSnapshot(document);
    this.emit('doc-opened', { recovered: true, path: document.path });
  }
  async pin(expectedRevision: VersionRef,intent?:'asset'|'animation') {
    return this.serial(async () => {
      const doc = this.requireDoc(); assertVersion(expectedRevision, doc.version); await this.assertFresh(doc);
      if(intent!==undefined&&!['asset','animation'].includes(intent))throw new HostError('INVALID_ARGUMENT','pin intent 仅支持 asset/animation。');
      if(intent==='animation'&&(this.editProfile!=='c2-pose'||doc.kind!=='motion'||doc.skeletonJson?.skeleton?.spine!=='4.1.24'))throw new HostError('CAPABILITY_MISSING','动画提交 pin 仅限隔离 C2 的 4.1.24 当前 motion。',409);
      if(intent==='asset'&&(this.editProfile!=='c2-pose'||!['pose','skeleton'].includes(doc.kind)))throw new HostError('CAPABILITY_MISSING','新资产来源 pin 仅限隔离 C2 pose/skeleton，不授权源动画写入。',409);
      if(doc.kind!=='pose'&&!(doc.kind==='motion'&&doc.value.poseWorkflow&&this.editProfile==='c2-pose')&&intent!=='asset'&&intent!=='animation')throw new HostError('CAPABILITY_MISSING','non-pose 普通 pin 未开放；使用当前能力明确声明的资产或动画意图。',409);
      if (!this.writer || this.frozen) throw new HostError('WRITE_FORBIDDEN', '当前 Host 仅观察，不能 pin 写入目标。', 409);
      await verifyWriter(this.writer, this.context);
      this.pinned = { version: structuredClone(doc.version), fileHashAtPin: doc.fileHash, pinnedAt: new Date().toISOString(),...intent?{intent}:{} };
      return { ok: true, pinned: true, version: doc.version, fileHashAtPin: doc.fileHash };
    });
  }
  async patch(args: any) {
    return this.serial(async () => {
      const doc = await this.writable(args.expectedRevision);
      let candidate:any;
      if(doc.kind==='motion'&&this.editProfile==='c2-pose'){
        if(!Array.isArray(args.ops)||args.ops.length!==1)throw new HostError('INVALID_ARGUMENT','motion 每次只接受一个原子区间。');
        const poses=await intervalPoseValues(args.ops[0],this.context);
        candidate=applyMotionInterval(doc.value,args.ops[0],poses,doc.mapping);
        if(args.expectedCandidateHash&&objectHash(candidate)!==args.expectedCandidateHash)throw new HostError('TARGET_STALE','关键姿态在 MCP 门禁后变化，拒绝载入不同候选。',409);
        const binding=managedDocumentBinding(doc.path,(this.project as any).manifest,await readCommittedIndex(this.context),this.context);
        await validateAssetBinding(candidate,binding,(this.project as any).manifest,await readCommittedIndex(this.context),this.context,false);
        if(args.dryRun===false){const extra=await assetDependencies(candidate,binding,(this.project as any).manifest,this.context);
          const all=new Map(doc.dependencies.map(d=>[d.filePath,d]));for(const d of extra){const old=all.get(d.filePath);if(old&&old.hash!==d.hash)throw new HostError('TARGET_STALE','区间姿态依赖已变化。',409);all.set(d.filePath,d);}
          candidate=structuredClone(candidate); // 实际依赖在 journal 落盘成功后才一同安装。
          const deps=[...all.values()].sort((a,b)=>a.filePath.localeCompare(b.filePath));
          await this.publishEdit(doc,candidate,[...doc.undo,structuredClone(doc.value)],[],args.clientId??'mcp-motion',deps);
          return {ok:true,dryRun:false,version:doc.version,interval:{start:args.ops[0].start,end:args.ops[0].end},changedPaths:inputDiff(JSON.parse(doc.baseline.toString()),candidate).map(d=>d.path)};
        }
      }else{
        if (doc.kind !== 'pose') throw new HostError('UNSUPPORTED_DOC_KIND', '当前 profile 不支持该文档编辑。');
        candidate=applyHostPosePatch(doc,args.ops,this.editProfile);
        candidate.id = `pose-${objectHash({ version: doc.version, ops: args.ops }).slice(0, 24)}`;
      }
      const diff = inputDiff(doc.value, candidate);
      if (args.dryRun !== false) return { ok: true, dryRun: true, version: doc.version, diff, changedPaths: diff.map(d => d.path) };
      const undo = [...doc.undo, structuredClone(doc.value)], redo: any[] = [];
      let dependencies=doc.dependencies;
      if(candidate.frame?.perspective?.mode&&candidate.frame.perspective.mode!=='diagnostic'){
        const calibration=await readArmCalibration(candidate.frame.perspective,this.context,candidate.sourceFingerprint);assertCalibrationFrame(calibration,candidate.frame);
        const all=new Map(doc.dependencies.map(d=>[d.filePath,d]));for(const d of (await poseDependencies(candidate,this.context)).dependencies){const old=all.get(d.filePath);if(old&&old.hash!==d.hash)throw new HostError('TARGET_STALE','校准依赖已变化。',409);all.set(d.filePath,d);}dependencies=[...all.values()].sort((a,b)=>a.filePath.localeCompare(b.filePath));
      }
      await this.publishEdit(doc, candidate, undo, redo, args.clientId ?? 'mcp',dependencies);
      return { ok: true, dryRun: false, version: doc.version, diff, changedPaths: diff.map(d => d.path), nextAction: '读取新快照并重新求解、发布与出图。' };
    });
  }
  private async publishEdit(doc: HostDocument, candidate: any, undo: any[], redo: any[], clientId: string, dependencies=doc.dependencies) {
    const uncommitted = objectHash(editableValue(candidate)) !== objectHash(editableValue(JSON.parse(doc.baseline.toString('utf8'))));
    const journal = await this.journal(doc);
    this.fault?.('journal');
    await journal.append({ type: 'edit', document: candidate, undo, redo, uncommitted, clientId,dependencies, fileHash: doc.fileHash, revision: doc.version.revision + 1 });
    doc.dependencies=dependencies;doc.dependencyFingerprint=objectHash({files:dependencies,policyFingerprint});
    doc.value = candidate; doc.undo = undo; doc.redo = redo; doc.uncommitted = uncommitted;
    doc.version = { ...doc.version, revision: doc.version.revision + 1 };
    this.invalidateDerived(doc); this.updateSnapshot(doc); this.emit('doc-changed');
  }
  /** 只接纳同一已绑定 pose 的合法 frame；不能借诊断改身份、支撑、绑定或写磁盘资产。 */
  async adoptDiagnostic(args:any){
    return this.serial(async()=>{
      const doc=await this.writable(args.expectedRevision);
      if(this.editProfile!=='c2-pose'||doc.kind!=='pose')throw new HostError('CAPABILITY_MISSING','诊断修正仅限隔离 C2 当前 pose。',409);
      if(args.snapshotHash!==doc.snapshotHash)throw new HostError('TARGET_DRIFT','诊断候选来源已变化。',409);
      for(const key of ['filePath','mappingPath','visualRigPath','referencePosePath','sequencePath','stageId','standardPosePath'])if(args.document?.[key]!==doc.value[key])throw new HostError('PROJECT_BINDING_CONFLICT','诊断只能修正当前阶段，不能变更参考或角色绑定。',409);
      const candidate=invalidatePose({...structuredClone(doc.value),frame:structuredClone(args.document.frame)});
      assertPoseRecovery(doc,candidate,this.editProfile);
      const diff=inputDiff(doc.value,candidate);
      if(args.dryRun===false)await this.publishEdit(doc,candidate,[...doc.undo,structuredClone(doc.value)],[],'mcp-diagnostic');
      return {ok:false,diagnosticOnly:true,adopted:args.dryRun===false,dryRun:args.dryRun!==false,persisted:false,version:doc.version,diff,message:'内存诊断候选可继续修正；必须重新求解比较，失败不能索取提交令牌。'};
    });
  }
  /** 显式建立新的参考上下文，保留源文档和固定绑定；草稿只在内存及恢复 journal 中。 */
  async openDiagnostic(args:any){
    return this.serial(async()=>{
      const source=await this.writable(args.expectedRevision);
      if(this.editProfile!=='c2-pose'||this.mode!=='host'||source.diagnostic||!['pose','skeleton'].includes(source.kind))throw new HostError('CAPABILITY_MISSING','新阶段诊断仅限隔离 C2 的普通受管 pose/skeleton 来源。',409);
      if(source.kind==='skeleton'&&this.pinned?.intent!=='asset')throw new HostError('TARGET_NOT_PINNED','骨架来源需显式 intent:asset。',409);
      if(source.uncommitted)throw new HostError('UNCOMMITTED_CHANGES','建立新阶段前先保存来源修订或撤销；不把未保存来源冒充磁盘基线。',409);
      if(args.snapshotHash!==source.snapshotHash)throw new HostError('TARGET_DRIFT','新诊断阶段来源快照已变化。',409);
      const outputPath=await this.newAssetPath(args,source);
      const prepared=await buildDiagnosticPose({sourcePath:source.path,sourceHash:source.fileHash,document:args.document,outputPath,characterId:source.characterId!},this.sessionId,this.context),doc=prepared.document;
      if(objectHash(doc.dependencies)!==objectHash(args.dependencies))throw new HostError('TARGET_STALE','新诊断阶段计算依赖已变化或不完整。',409);
      const records=await new HostJournal(doc.version.documentId,this.context).read();
      const summary={ok:false,diagnosticOnly:true,memoryOnly:true,diagnosticId:doc.diagnostic!.id,documentPath:doc.path,outputPath,persisted:false,sourcePath:source.path,requiresPin:true};
      if(args.dryRun!==false)return {...summary,dryRun:true,opened:false,version:source.version,existing:records.length>0};
      if(records.length)throw new HostError('DIAGNOSTIC_EXISTS','此诊断上下文已有恢复记录，请显式恢复，不能覆盖旧修改。',409,{diagnosticId:doc.diagnostic!.id});
      await this.assertFresh(source);this.updateSnapshot(doc);await this.journal(doc);await this.assertFresh(doc);
      this.installDiagnostic(doc,prepared.project,prepared.characterCatalog);
      return {...summary,dryRun:false,opened:true,version:doc.version,message:'已打开独立内存诊断阶段；源资产和原文档绑定不变，需重新 pin/求解/比较，失败无正式保存资格。'};
    });
  }
  private installDiagnostic(doc:HostDocument,project:NonNullable<HostDocumentStore['project']>,catalog:any[]){
    this.project=project;this.active=doc;this.pinned=null;this.invalidateDerived(doc);
    this.captureRecords.clear();this.lastCapture=null;this.updateSnapshot(doc);
    this.characterCatalog=catalog;
    this.emit('doc-opened',{diagnostic:true,diagnosticId:doc.diagnostic!.id,path:doc.path});
  }
  async resumeDiagnostic(args:any){
    return this.serial(async()=>{
      if(this.mode!=='host'||this.editProfile!=='c2-pose'||!this.writer||this.frozen||this.writeDraining)throw new HostError('WRITE_FORBIDDEN','恢复诊断需隔离 C2 已确认的 Host 写入权。',409);
      await verifyWriter(this.writer,this.context);if(this.active)assertVersion(args.expectedRevision,this.active.version);
      if(!/^[a-f0-9]{64}$/.test(args.diagnosticId))throw new HostError('INVALID_ARGUMENT','diagnosticId 格式无效。');
      const journal=new HostJournal(args.diagnosticId,this.context),records=await journal.read(),header=records[0],context=header?.diagnostic;
      if(!context||context.id!==args.diagnosticId||diagnosticIdentity(context,this.context.projectId)!==context.id||context.policyFingerprint!==policyFingerprint||strictHash(JSON.stringify(header.diagnosticBaseline,null,2)+'\n')!==context.baselineHash)throw new HostError('JOURNAL_CORRUPT','诊断来源、基线、策略或身份无法核验；不能恢复为干净资产。',409);
      const commitRecovery=[];
      for(const prepare of records.filter(r=>r.type==='prepare'&&!records.some(end=>['committed','aborted'].includes(end.type)&&end.requestId===r.requestId))){
        let actual:string|null=null;try{actual=strictHash(await readFile(this.resolve(prepare.outputPath)));}catch(error:any){if(error.code!=='ENOENT')throw error;}
        const verdict=actual===prepare.candidateHash?'published':actual===prepare.expectedOutputHash?'notPublished':'unknown';
        commitRecovery.push({requestId:prepare.requestId,outputPath:prepare.outputPath,verdict});
        if(verdict==='unknown'){this.frozen=true;this.writeMode='frozen';throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','诊断提交的输出既非候选也非旧基线，保持冻结并保留记录。',409);}
        if(args.dryRun===false){if(verdict==='published')await journal.append({type:'committed',requestId:prepare.requestId,requestFingerprint:prepare.requestFingerprint,receipt:prepare.receipt,indexEntry:prepare.indexEntry,recovered:true});else await journal.append({type:'aborted',requestId:prepare.requestId,message:'原子发布未发生；显式恢复裁决，不自动重试。'});}
      }
      const committed=records.find(r=>r.type==='committed'&&r.receipt?.switched!==false);
      if(committed)throw new HostError('DIAGNOSTIC_COMMITTED','该诊断已保存为新资产，请打开实际输出，不恢复旧草稿。',409,{outputPath:committed.receipt.outputPath});
      const prepared=await buildDiagnosticPose({sourcePath:context.sourcePath,sourceHash:context.sourceHash,document:header.diagnosticBaseline,outputPath:context.proposedOutputPath,characterId:context.binding.characterId},this.sessionId,this.context),doc=prepared.document;
      if(objectHash(doc.diagnostic)!==objectHash(context)||objectHash(doc.dependencies)!==objectHash(header.diagnosticDependencies)||doc.dependencyFingerprint!==header.diagnosticDependencyFingerprint)throw new HostError('TARGET_STALE','诊断恢复依赖、角色或绑定已变化；保留记录，需从当前来源重新制作。',409);
      const edit=records.slice().reverse().find(r=>r.type==='edit');
      if(edit){
        if((edit.undo?.length??0)>1000||(edit.redo?.length??0)>1000)throw new HostError('JOURNAL_CORRUPT','诊断历史超出恢复上限。',409);
        for(const value of [edit.document,...edit.undo??[],...edit.redo??[]])assertPoseRecovery(doc,editableValue(value),this.editProfile);
        doc.value=invalidatePose(editableValue(edit.document));doc.undo=(edit.undo??[]).map((v:any)=>invalidatePose(editableValue(v)));doc.redo=(edit.redo??[]).map((v:any)=>invalidatePose(editableValue(v)));doc.uncommitted=objectHash(doc.value)!==objectHash(editableValue(header.diagnosticBaseline));doc.version.revision=1;
      }
      const changes=inputDiff(header.diagnosticBaseline,doc.value);
      const summary={ok:true,dryRun:args.dryRun!==false,diagnosticId:context.id,memoryOnly:true,sourcePath:context.sourcePath,sourceHash:context.sourceHash,documentPath:doc.path,proposedOutputPath:context.proposedOutputPath,changes:changes.slice(0,50),changeCount:changes.length,truncated:changes.length>50,commitRecovery,approved:false,message:'恢复前列出来源及相对诊断基线的差异；旧求解、截图准入、pin 和批准不恢复。'};
      if(args.dryRun!==false)return {...summary,version:this.active?.version??null};
      await this.assertFresh(doc);this.journals.set(doc.version.documentId,journal);this.installDiagnostic(doc,prepared.project,prepared.characterCatalog);
      return {...summary,version:doc.version};
    });
  }
  private invalidateEditing(doc:HostDocument,value:any){return doc.kind==='motion'?editableValue(value):invalidatePose(value);}
  private assertEditingRecovery(doc:HostDocument,value:any){if(doc.kind==='motion'){if(this.editProfile!=='c2-pose')throw new HostError('CAPABILITY_MISSING','C1 不恢复 motion 编辑。');assertMotionRecovery(doc,value);}else assertPoseRecovery(doc,value,this.editProfile);}
  async history(direction: 'undo' | 'redo', args: any) {
    const transactionStarted=performance.now();
    return this.serial(async () => {
      const doc = await this.writable(args.expectedRevision), source = direction === 'undo' ? doc.undo : doc.redo;
      if (!source.length) return { ok: true, dryRun: args.dryRun !== false, version: doc.version, noOp: true };
      const candidate = this.invalidateEditing(doc,structuredClone(source.at(-1))), diff = inputDiff(doc.value, candidate);
      if (args.dryRun !== false) return { ok: true, dryRun: true, version: doc.version, diff, changedPaths: diff.map(d => d.path) };
      const undo = direction === 'undo' ? doc.undo.slice(0, -1) : [...doc.undo, structuredClone(doc.value)];
      const redo = direction === 'redo' ? doc.redo.slice(0, -1) : [...doc.redo, structuredClone(doc.value)];
      await this.publishEdit(doc, candidate, undo, redo, args.clientId ?? 'mcp');
      return { ok: true, dryRun: false, version: doc.version, diff, changedPaths: diff.map(d => d.path),timings:{[direction+'TransactionMs']:performance.now()-transactionStarted} };
    });
  }
  private async newAssetPath(args:any,doc:HostDocument){
    if (!args.outputPath || this.resolve(args.outputPath) === this.resolve(doc.path)) throw new HostError('INVALID_ARGUMENT', '必须给出不同于源文档的新 outputPath。');
    const outputPath = path.relative(this.context.workspaceRoot!, this.resolve(args.outputPath)).replace(/\\/g, '/');
    if (/^(?:\.spine-mcp|\.git|\.codex|\.agents|node_modules|dist|backups|test-output)(?:\/|$)/i.test(outputPath) || !outputPath.endsWith('.json')) throw new HostError('PATH_FORBIDDEN', '输出必须是工作区内的新 JSON 资产，不能使用内部或生成目录。', 403);
    if(this.project?.mode==='managed'&&Object.values(this.project.manifest.artifactRoots).some(root=>outputPath.toLowerCase().startsWith(root.toLowerCase()+'/')))throw new HostError('PATH_FORBIDDEN','不能把预览/报告产物目录作为受管资产输出。',403);
    try { await readFile(this.resolve(outputPath)); throw new HostError('TARGET_STALE', '输出已存在，请使用新修订路径。', 409); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    return outputPath;
  }
  async stageAsset(args:any){
    return this.serial(async()=>{
      const doc=await this.writable(args.expectedRevision);
      if(this.editProfile!=='c2-pose'||!['pose','skeleton'].includes(doc.kind)||doc.kind==='skeleton'&&this.pinned?.intent!=='asset')throw new HostError('CAPABILITY_MISSING','资产暂存仅限隔离 C2 已 pin 的 pose，或显式 intent:asset 的 skeleton 来源。',409);
      if(args.snapshotHash!==doc.snapshotHash)throw new HostError('TARGET_DRIFT','资产候选来源快照已变化。',409);
      const outputPath=await this.newAssetPath(args,doc),binding=args.binding as AssetBinding;
      if(binding?.path!==outputPath||binding?.characterId!==doc.characterId)throw new HostError('PROJECT_BINDING_CONFLICT','资产候选路径或角色与当前来源不符。',409);
      const manifest=(this.project as any).manifest,index=await readCommittedIndex(this.context);
      await validateAssetBinding(args.document,binding,manifest,index,this.context);
      const dependencies=await assetDependencies(args.document,binding,manifest,this.context);
      if(objectHash(dependencies)!==objectHash(args.dependencies))throw new HostError('TARGET_STALE','资产计算依赖已变化或不完整。',409);
      if(doc.uncommitted&&dependencies.some(d=>this.resolve(d.filePath)===this.resolve(doc.path)))throw new HostError('UNCOMMITTED_CHANGES','新资产引用当前姿态前，必须先保存该姿态修订及批准。',409);
      const bytes=JSON.stringify(args.document,null,2)+'\n',candidateHash=strictHash(bytes);
      if(args.dryRun===false){this.authorizations.clear();this.assetCandidate={version:structuredClone(doc.version),snapshotHash:doc.snapshotHash,outputPath,candidate:structuredClone(args.document),candidateHash,bytes,binding:structuredClone(binding),dependencies};this.emit('asset-staged',{outputPath,candidateHash});}
      return {ok:true,dryRun:args.dryRun!==false,staged:args.dryRun===false,persisted:false,version:doc.version,outputPath,candidateHash,kind:binding.kind,nextAction:'使用 spine_host_commit 的 intent:asset 与 assetCandidateHash 保存，再显式打开新资产。'};
    });
  }
  private async draftCandidate(args: any) {
    const doc = await this.writable(args.expectedRevision);
    if(args.intent!=='asset'&&doc.value.referencePosePath&&(doc.derived?.numeric?.ok!==true||doc.derived?.comparison?.ok!==true))throw new HostError('COMMIT_NOT_AUTHORIZED','参考候选未通过数值或必要关系，仅可在内存中诊断修正。',409);
    if(doc.value.frame?.perspective&&doc.derived?.numeric?.ok!==true)throw new HostError('COMMIT_NOT_AUTHORIZED','失败透视候选只能保留诊断报告与截图，不能索取草稿保存授权。',409);
    if(args.intent==='asset'){
      const asset=this.assetCandidate;
      if(this.editProfile!=='c2-pose'||!asset||asset.candidateHash!==args.assetCandidateHash||asset.outputPath!==args.outputPath)throw new HostError('COMMIT_NOT_AUTHORIZED','缺少精确绑定的 C2 新资产候选。',409);
      assertVersion(asset.version,doc.version);
      if(asset.snapshotHash!==doc.snapshotHash)throw new HostError('TARGET_DRIFT','候选来源内存已变化。',409);
      await this.newAssetPath(args,doc);
      const manifest=(this.project as any).manifest;
      await validateAssetBinding(asset.candidate,asset.binding,manifest,await readCommittedIndex(this.context),this.context);
      if(objectHash(await assetDependencies(asset.candidate,asset.binding,manifest,this.context))!==objectHash(asset.dependencies))throw new HostError('TARGET_STALE','资产依赖在暂存后改变。',409);
      return {...asset,doc,intent:'asset' as const};
    }
    if(args.assetCandidateHash!==undefined)throw new HostError('INVALID_ARGUMENT','assetCandidateHash 只用于 asset 提交。');
    if (!['pose','motion'].includes(doc.kind) || doc.kind==='motion'&&this.editProfile!=='c2-pose' || args.intent && args.intent !== 'draft') throw new HostError('CAPABILITY_MISSING', '当前仅支持 pose 草稿和隔离 C2 新资产；动画写入未开放。');
    const outputPath=await this.newAssetPath(args,doc);
    if(doc.kind==='motion'){
      if(!doc.derived||doc.derived.inputFingerprint!==playbackInputHash('motion',doc.value,doc.view!)||doc.derived.numeric.unreachableCount!==0)throw new HostError('NO_SOLUTION','motion 修订保存需当前无不可达的完整观察候选，正式动画审查仍独立。',409);
      const candidate=editableValue(doc.value),bytes=JSON.stringify(candidate,null,2)+'\n';
      return {doc,candidate,bytes,candidateHash:strictHash(bytes),outputPath,intent:'draft' as const};
    }
    if (!doc.derived || doc.derived.inputFingerprint !== poseInputHash(doc.value)) throw new HostError('NO_SOLUTION', '保存草稿前须发布当前输入的求解结果。', 409);
    await this.assertReviewFresh(doc);
    const candidate = materializeHostPose(doc.value,doc.derived);
    if (doc.review) {
      candidate.review = structuredClone(doc.review.record);
      candidate.status = doc.review.decision === 'approved' ? 'confirmed' : 'rejected';
      if(candidate.review.comparisonPath)candidate.comparisonPath=candidate.review.comparisonPath;
    }
    if(doc.diagnostic){const manifest=(this.project as any).manifest;await validateAssetBinding(candidate,{...doc.diagnostic.binding,path:outputPath},manifest,await readCommittedIndex(this.context),this.context,false);}
    const bytes = `${JSON.stringify(candidate, null, 2)}\n`, candidateHash = strictHash(bytes);
    return { doc, candidate, bytes, candidateHash, outputPath, intent: 'draft' as const };
  }
  async registerAnimationCandidate(args:any){
    return this.serial(async()=>{
      const doc=this.requireDoc();assertVersion(args.expectedRevision,doc.version);await this.assertFresh(doc);
      if(this.editProfile!=='c2-pose'||doc.kind!=='motion'||this.mode!=='host')throw new HostError('CAPABILITY_MISSING','动画审查会话仅限隔离 C2 当前 motion。',409);
      const session=args.session as AnimationSession;
      rejectFields(session,['version','snapshotHash','dependencyFingerprint','derivedHash','candidatePath','candidateHash','sourcePath','sourceHash','animation','baseToken','recordPath','recordHash','poseManifestPath','previewManifestPath','retargetManifestPath','retargetManifestFingerprint','referenceApprovalFingerprint','targetCharacterFingerprint','actionBindingFingerprint','visualRigFingerprint']);
      const binding=this.project?.mode==='managed'?this.project.manifest.characters[doc.characterId!]:null;
      if(!binding||session.sourcePath!==binding.skeletonPath||session.animation!==doc.value.name)throw new HostError('PROJECT_BINDING_CONFLICT','动画候选角色来源或名称不符。',409);
      const record=await assertAnimationSession(session,doc,this.context),source=JSON.parse(await readFile(this.resolve(session.sourcePath),'utf8')),candidate=JSON.parse(await readFile(this.resolve(session.candidatePath),'utf8'));
      auditGeneratedAnimationCandidate(source,candidate,session.animation,record.tokenData.overwrite===true);
      await this.assertFresh(doc);this.authorizations.clear();this.animationSessionValue=structuredClone(session);
      this.emit('animation-candidate-ready',{candidateHash:session.candidateHash});return {ok:true,version:doc.version,readyForAnimationReview:true};
    });
  }
  async animationSession(expectedRevision:VersionRef){
    return this.serial(async()=>{
      const doc=this.requireDoc();assertVersion(expectedRevision,doc.version);await this.assertFresh(doc);
      if(!this.animationSessionValue)throw new HostError('NO_SOLUTION','先制作当前版本的精确候选和完整审查产物。',409);
      await assertAnimationSession(this.animationSessionValue,doc,this.context);return structuredClone(this.animationSessionValue);
    });
  }
  async registerAnimationReview(args:any){
    return this.serial(async()=>{
      const doc=this.requireDoc();assertVersion(args.expectedRevision,doc.version);await this.assertFresh(doc);
      const session=this.animationSessionValue;if(!session||args.baseToken!==session.baseToken)throw new HostError('COMMIT_NOT_AUTHORIZED','动画审查缺少当前准备令牌。',409);
      const record=await assertAnimationSession(session,doc,this.context),result=args.reviewRecord,review=result?.review;
      if(session.retargetManifestPath){
        const retarget=JSON.parse(await readFile(this.resolve(session.retargetManifestPath),'utf8'));
        const retargetProblem=expectedRetargetManifestProblem(retarget);
        if(retargetProblem)throw new HostError('COMMIT_NOT_AUTHORIZED',retargetProblem,409);
        if(retarget.retargetManifestFingerprint!==session.retargetManifestFingerprint||retarget.referenceApprovalFingerprint!==session.referenceApprovalFingerprint||retarget.targetCharacterFingerprint!==session.targetCharacterFingerprint||retarget.actionBindingFingerprint!==session.actionBindingFingerprint||retarget.visualRigFingerprint!==session.visualRigFingerprint)throw new HostError('COMMIT_NOT_AUTHORIZED','retarget manifest 与 session 来源指纹不一致。',409);
      }
      validateHostAnimationReview(review);assertVersion(review.hostBinding?.version,doc.version);
      if(hashObject({base:session.baseToken,review})!==result.reviewToken||review.baseToken!==session.baseToken||review.candidateHash!==record.candidateHash||objectHash(review.hostBinding)!==objectHash({...record.tokenData.hostBinding,baseToken:session.baseToken}))throw new HostError('COMMIT_NOT_AUTHORIZED','动画审查未绑定精确候选和当前完整版本。',409);
      if(!Array.isArray(result.evidence)||result.evidence.length!==review.evidence?.length||new Set(result.evidence.map((e:any)=>e.filePath)).size!==result.evidence.length)throw new HostError('CAPTURE_UNVERIFIED','动画审查证据集合不完整或重复。',409);
      let player=false;
      for(const item of result.evidence){
        const bytes=await readFile(this.resolve(item.filePath)),stored=review.evidence.find((e:any)=>e.filePath===item.filePath);
        if(strictHash(bytes)!==item.hash||!stored||hashObject(bytes.toString('base64'))!==stored.hash)throw new HostError('REVIEW_STALE','动画审查证据字节已变化。',409);
        if(item.source==='player'){
          const capture=this.captureRecords.get(item.filePath);if(!capture||capture.manifestPath!==item.manifestPath)throw new HostError('CAPTURE_UNVERIFIED','动画批准需要当前 Host 已核验登记的 player 截图。',409);
          const raw=await readFile(this.resolve(capture.manifestPath)),manifest=JSON.parse(raw.toString());assertVersion(manifest.version,doc.version);
          if(strictHash(raw)!==capture.manifestHash||manifest.evidenceSchema!==CAPTURE_EVIDENCE_SCHEMA||manifest.kind!=='motion'||manifest.source!=='player'||manifest.captureValidity?.status!=='verified'||manifest.advisory!==false||manifest.evidenceEligible!==true||manifest.snapshotHash!==doc.snapshotHash||manifest.derivedHash!==doc.derivedHash||manifest.dependencyFingerprint!==doc.dependencyFingerprint||manifest.candidateHash!==session.candidateHash||!manifest.evidence.some((e:any)=>e.filePath===item.filePath&&e.hash===item.hash))throw new HostError('CAPTURE_UNVERIFIED','player 证据不属于当前完整动画候选。',409);
          player=true;
        }
      }
      if(review.decision==='approved'&&!player)throw new HostError('CAPTURE_UNVERIFIED','完整动画批准缺少当前可信 player 证据。',409);
      const manifest=JSON.parse(await readFile(this.resolve(review.manifestPath),'utf8'));
      if(manifest.jsonHash!==record.candidateHash)throw new HostError('COMMIT_NOT_AUTHORIZED','对比证据不是当前完整候选动画。',409);
      if(session.retargetManifestPath){
        if(manifest.retargetManifestPath!==session.retargetManifestPath||manifest.retargetManifestFingerprint!==session.retargetManifestFingerprint)throw new HostError('COMMIT_NOT_AUTHORIZED','对比证据未绑定当前 retarget manifest。',409);
        if(manifest.referenceApprovalFingerprint!==session.referenceApprovalFingerprint||manifest.targetCharacterFingerprint!==session.targetCharacterFingerprint||manifest.actionBindingFingerprint!==session.actionBindingFingerprint||manifest.visualRigFingerprint!==session.visualRigFingerprint)throw new HostError('COMMIT_NOT_AUTHORIZED','对比证据的 retarget 来源指纹与 session 不一致。',409);
      }
      // 与 detached 审查共用同一套证据校验：按骨架证据特征判定，不信任可编辑的 layout 字段。
      const comparisonProblem=comparisonManifestProblem(manifest,review.decision,!!record.requiresReferenceComparison);
      if(comparisonProblem)throw new HostError('COMMIT_NOT_AUTHORIZED',comparisonProblem,409);
      await this.assertFresh(doc);await assertAnimationSession(session,doc,this.context);
      const reviewHash=objectHash(result);
      if(args.dryRun!==false)return {ok:true,dryRun:true,version:doc.version,reviewHash,reviewToken:result.reviewToken,review};
      await writeAnimationRecord(`.spine-mcp/reviews/${session.baseToken}.visual.json`,{review,reviewToken:result.reviewToken},this.context,true);
      await this.assertFresh(doc);session.review=structuredClone(result);session.reviewHash=reviewHash;this.authorizations.clear();
      this.emit('animation-review-updated',{decision:review.decision,reviewHash});return {ok:true,dryRun:false,version:doc.version,reviewHash,reviewToken:result.reviewToken,review};
    });
  }
  private async animationCommitCandidate(args:any){
    if(args.assetCandidateHash!==undefined)throw new HostError('INVALID_ARGUMENT','intent:animation 不接受 assetCandidateHash。');
    const doc=await this.writable(args.expectedRevision),session=this.animationSessionValue;
    if(this.editProfile!=='c2-pose'||doc.kind!=='motion'||this.pinned?.intent!=='animation')throw new HostError('CAPABILITY_MISSING','源动画提交仅限隔离 C2 当前 motion，并须显式 pin intent:animation。',409);
    if(!session||args.outputPath!==session.sourcePath||args.animationCandidateHash!==session.candidateHash||args.expectedHash!==session.sourceHash||session.review?.review.decision!=='approved'||args.reviewToken!==session.review.reviewToken)throw new HostError('COMMIT_NOT_AUTHORIZED','缺少当前精确候选、源预期哈希或完整动画批准。',409);
    const record=await assertAnimationSession(session,doc,this.context,true);
    if(session.candidateHash===session.sourceHash)throw new HostError('INVALID_ARGUMENT','候选与角色源字节相同，无需重复提交。');
    const sourceBytes=await readFile(this.resolve(session.sourcePath)),bytes=await readFile(this.resolve(session.candidatePath)),candidate=JSON.parse(bytes.toString());
    auditGeneratedAnimationCandidate(JSON.parse(sourceBytes.toString()),candidate,session.animation,record.tokenData.overwrite===true);
    if(!doc.dependencies.some(d=>this.resolve(d.filePath)===this.resolve(session.sourcePath)&&d.hash===session.sourceHash))throw new HostError('TARGET_DRIFT','角色源字节未绑定当前文档依赖。',409);
    const mappingBytes=await readFile(this.resolve(record.mappingPath)),mapping=JSON.parse(mappingBytes.toString()),reportBytes=await readFile(this.resolve(mapping.reportPath));
    return {doc,session,record,sourceBytes,bytes,candidate,candidateHash:session.candidateHash,sourceHash:session.sourceHash,outputPath:session.sourcePath,reviewHash:session.reviewHash!,mappingPath:record.mappingPath,mappingHash:strictHash(mappingBytes),reportPath:mapping.reportPath,reportHash:strictHash(reportBytes)};
  }
  private async commitAnimation(args:any,requestFingerprint:string,control:boolean){
    if(args.dryRun===false){const authorization=this.authorizations.get(args.authorizationId);if(!authorization||authorization.intent!=='animation'||authorization.expiresAt<Date.now())throw new HostError('COMMIT_NOT_AUTHORIZED','源动画提交须先经 MCP 复验并取得当前一次性授权。',409);}
    const current=await this.animationCommitCandidate(args),{doc,session}=current;
    const summary={ok:true,dryRun:true,intent:'animation',version:doc.version,outputPath:current.outputPath,candidateHash:current.candidateHash,sourceHash:current.sourceHash,reviewHash:current.reviewHash,readyToCommit:true,changedPaths:inputDiff(JSON.parse(current.sourceBytes.toString()),current.candidate).map(d=>d.path),gateRequirements:['4.1.24 单动画及完整数值报告','标准/关键姿态及完整动画批准','当前 player 证据','精确源哈希与一次性授权','来源备份及原子替换']};
    if(args.dryRun!==false)return {...summary,...control?{candidateBytes:current.bytes.toString(),animationSession:structuredClone(session)}:{}};
    const authorization=this.authorizations.get(args.authorizationId);
    if(!authorization||authorization.intent!=='animation'||authorization.expiresAt<Date.now()||authorization.candidateHash!==current.candidateHash||authorization.sourceHash!==current.sourceHash||authorization.outputPath!==current.outputPath||authorization.snapshotHash!==doc.snapshotHash||authorization.derivedHash!==doc.derivedHash||authorization.reviewHash!==current.reviewHash||authorization.generation!==this.writer!.generation)throw new HostError('COMMIT_NOT_AUTHORIZED','动画提交缺少、过期或不匹配的一次性授权。',409);
    return withFileLock(current.outputPath,this.context,async()=>{
      await verifyWriter(this.writer!,this.context);await this.assertFresh(doc);
      const journal=await this.journal(doc),absolute=this.resolve(current.outputPath),backupPath=`.spine-mcp/backups/${doc.version.documentId}/${Date.now()}-${randomUUID()}.json`,temp=`${absolute}.${randomUUID()}.tmp`;
      const version={...doc.version,revision:doc.version.revision+1};
      const receipt={ok:true,dryRun:false,committed:true,intent:'animation',switched:false,version,requestId:args.requestId,outputPath:current.outputPath,backupPath,hashBefore:current.sourceHash,hashAfter:current.candidateHash,candidateHash:current.candidateHash};
      const animationCommit={sourcePath:current.outputPath,hashBefore:current.sourceHash,hashAfter:current.candidateHash,backupPath,mappingPath:current.mappingPath,mappingHash:current.mappingHash,reportPath:current.reportPath,reportHash:current.reportHash,rigHash:rigHash(current.candidate),animation:session.animation,baseToken:session.baseToken,reviewHash:current.reviewHash};
      await journal.append({type:'prepare',requestId:args.requestId,requestFingerprint,sourcePath:doc.path,expectedSourceHash:doc.fileHash,outputPath:current.outputPath,expectedOutputHash:current.sourceHash,candidateHash:current.candidateHash,backupPath,generation:this.writer!.generation,receipt,animationCommit});
      let published=false;
      try{
        this.fault?.('backup');const backupAbsolute=this.resolve(backupPath);await mkdir(path.dirname(backupAbsolute),{recursive:true});
        const backup=await open(backupAbsolute,'wx',0o600);try{await backup.writeFile(current.sourceBytes);await backup.sync();}finally{await backup.close();}
        const file=await open(temp,'wx',0o600);try{await file.writeFile(current.bytes);await file.sync();}finally{await file.close();}
        this.fault?.('publish');await verifyWriter(this.writer!,this.context);await this.assertFresh(doc);await this.animationCommitCandidate(args);
        if(strictHash(await readFile(this.resolve(current.outputPath)))!==current.sourceHash)throw new HostError('TARGET_STALE','原子替换前源文件发生变化。',409);
        await rename(temp,absolute);published=true;this.fault?.('afterPublish');this.fault?.('committed');
        await journal.append({type:'committed',requestId:args.requestId,requestFingerprint,receipt,animationCommit});
        doc.dependencies=doc.dependencies.map(d=>this.resolve(d.filePath)===this.resolve(current.outputPath)?{...d,hash:current.candidateHash}:d);
        doc.dependencyFingerprint=objectHash({files:doc.dependencies,policyFingerprint});doc.skeletonJson=structuredClone(current.candidate);doc.version=version;doc.undo=[];doc.redo=[];doc.uncommitted=false;
        this.invalidateDerived(doc);this.updateSnapshot(doc);this.captureRecords.clear();this.lastCapture=null;
        this.pinned={version:structuredClone(version),fileHashAtPin:doc.fileHash,pinnedAt:new Date().toISOString(),intent:'animation'};invalidate(absolute);
        this.emit('animation-committed',{outputPath:current.outputPath,candidateHash:current.candidateHash});return receipt;
      }catch(error){this.authorizations.delete(authorization.id);if(published){this.frozen=true;throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','源动画已替换但回执未确认；保持冻结，按来源 journal 与候选哈希恢复。',409);}await journal.append({type:'aborted',requestId:args.requestId,requestFingerprint,message:String(error)});throw error;}
      finally{await unlink(temp).catch(()=>{});}
    });
  }
  async registerReview(args: any) {
    return this.serial(async () => {
      const doc = this.requireDoc(); assertVersion(args.expectedRevision, doc.version); await this.assertFresh(doc);
      if (args.snapshotHash !== doc.snapshotHash || !doc.derivedHash || args.derivedHash !== doc.derivedHash) throw new HostError('TARGET_DRIFT', '审查不属于当前快照与派生结果。', 409);
      const review = args.reviewRecord;
      if (!review || !['approved','rejected'].includes(review.decision) || !review.record || !Array.isArray(review.evidence) || !review.evidence.length) throw new HostError('COMMIT_NOT_AUTHORIZED', '缺少 MCP 既有审查记录或证据引用。', 409);
      let eligiblePlayer = false;
      for (const evidence of review.evidence) {
        if (strictHash(await readFile(this.resolve(evidence.filePath))) !== evidence.hash) throw new HostError('TARGET_DRIFT', '审查证据字节已变化。', 409);
        if (review.decision === 'approved' && evidence.source === 'player') {
          const registered = this.captureRecords.get(evidence.filePath);
          if (!registered || registered.manifestPath !== evidence.manifestPath) throw new HostError('CAPTURE_UNVERIFIED', '截图未在当前 Host 登记；旧截图须重新采集，不能靠声明字段升级。', 409);
          const bytes = await readFile(this.resolve(registered.manifestPath));
          if (strictHash(bytes) !== registered.manifestHash) throw new HostError('CAPTURE_UNVERIFIED', '截图 manifest 已变化。', 409);
          const manifest = JSON.parse(bytes.toString('utf8'));
          assertVersion(manifest.version, doc.version);
          if (manifest.evidenceSchema !== CAPTURE_EVIDENCE_SCHEMA || manifest.source !== 'player' || manifest.captureValidity?.status !== 'verified' || manifest.evidenceEligible !== true || manifest.advisory !== false || manifest.snapshotHash !== doc.snapshotHash || manifest.derivedHash !== doc.derivedHash || manifest.dependencyFingerprint !== doc.dependencyFingerprint || manifest.candidateHash !== doc.derived?.live?.hash || !manifest.evidence.some((e: any) => e.filePath === evidence.filePath && e.hash === evidence.hash)) throw new HostError('CAPTURE_UNVERIFIED', 'player 截图准入或当前候选绑定不通过。', 409);
          eligiblePlayer = true;
        }
      }
      if (review.decision === 'approved' && !eligiblePlayer) throw new HostError('CAPTURE_UNVERIFIED', '批准需要独立核验通过的官方 player 截图；诊断图不能替代。', 409);
      if (review.decision === 'approved' && (isDiagnosticPerspective(doc.value.frame) || doc.derived.numeric.ok !== true || doc.derived.comparison?.ok === false || (doc.value.reference||doc.value.referencePosePath)&&doc.derived.comparison?.ok!==true)) throw new HostError('COMMIT_NOT_AUTHORIZED', '失败诊断不能批准；透视试验即使数值通过也不能批准。', 409);
      validatePoseReviewInput(review.record,doc.value.reference||doc.value.referencePosePath?doc.value.stageId??'':undefined,true);
      assertVersion(review.record.hostBinding?.version,doc.version);
      if(review.record.decision!==review.decision||review.record.hostBinding.snapshotHash!==doc.snapshotHash||review.record.hostBinding.derivedHash!==doc.derivedHash||review.record.poseFingerprint!==poseFingerprint(materializeHostPose(doc.value,doc.derived)))throw new HostError('TARGET_DRIFT','审查内容未绑定当前精确姿态候选。',409);
      if(review.decision==='approved'&&(doc.value.reference||doc.value.referencePosePath)&&(review.record.comparisonFingerprint!==comparisonFingerprint(doc.derived.comparison)||review.record.comparisonPath!==doc.derived.live.path.replace(/pose\.json$/,'comparison.json')))throw new HostError('TARGET_DRIFT','审查未绑定当前完整参考比较。',409);
      if(!Array.isArray(review.record.evidence)||review.record.evidence.length!==review.evidence.length)throw new HostError('CAPTURE_UNVERIFIED','持久审查记录与当前证据集合不一致。',409);
      for(const file of review.record.evidence){
        const bytes=await readFile(this.resolve(file.filePath));
        if(hashObject(bytes.toString('base64'))!==file.hash||!review.evidence.some((e:any)=>e.filePath===file.filePath&&e.hash===strictHash(bytes)))throw new HostError('CAPTURE_UNVERIFIED','持久审查证据哈希与当前字节不一致。',409);
      }
      if(args.dryRun!==false)return{ok:true,dryRun:true,version:doc.version,reviewHash:objectHash({snapshotHash:doc.snapshotHash,derivedHash:doc.derivedHash,review}),review:structuredClone(review.record)};
      doc.review = structuredClone(review); doc.reviewHash = objectHash({ snapshotHash: doc.snapshotHash, derivedHash: doc.derivedHash, review }); this.authorizations.clear();
      this.emit('review-updated',{decision:review.decision,reviewHash:doc.reviewHash});
      return { ok: true,dryRun:false, version: doc.version, reviewHash: doc.reviewHash,review:structuredClone(review.record) };
    });
  }
  async authorize(args: any) {
    return this.serial(async () => {
      if(args.intent==='animation'){
        const current=await this.animationCommitCandidate(args),doc=current.doc,gate=args.gateRecord;
        if(args.candidateHash!==current.candidateHash||args.snapshotHash!==doc.snapshotHash||args.derivedHash!==doc.derivedHash||args.reviewHash!==current.reviewHash||!gate||gate.gate!=='animation'||gate.passed!==true||gate.candidateHash!==current.candidateHash||gate.sourceHash!==current.sourceHash||gate.baseToken!==current.session.baseToken||gate.reviewToken!==args.reviewToken||gate.reviewHash!==current.reviewHash)throw new HostError('COMMIT_NOT_AUTHORIZED','动画授权必须绑定当前完整审查、源哈希及精确候选。',409);
        const authorization:Authorization={id:randomUUID(),intent:'animation',sourceHash:current.sourceHash,candidateHash:current.candidateHash,outputPath:current.outputPath,snapshotHash:doc.snapshotHash,derivedHash:doc.derivedHash,reviewHash:current.reviewHash,generation:this.writer!.generation,expiresAt:Date.now()+60_000};
        this.authorizations.set(authorization.id,authorization);
        return{ok:true,authorizationId:authorization.id,expiresAt:new Date(authorization.expiresAt).toISOString(),candidateHash:authorization.candidateHash};
      }
      const current = await this.draftCandidate(args), doc = current.doc, gate = args.gateRecord;
      if (args.candidateHash !== current.candidateHash || args.snapshotHash !== doc.snapshotHash || args.derivedHash !== doc.derivedHash || (args.reviewHash ?? null) !== doc.reviewHash || !gate || gate.gate !== (current.intent==='asset'?'asset-draft':doc.kind==='motion'?'motion-draft':'pose-draft') || gate.passed !== true || gate.candidateHash !== current.candidateHash) throw new HostError('COMMIT_NOT_AUTHORIZED', '授权必须绑定当前精确草稿候选与 MCP 门禁记录。', 409);
      const authorization: Authorization = { id: randomUUID(), candidateHash: current.candidateHash, outputPath: current.outputPath, snapshotHash: doc.snapshotHash, derivedHash: doc.derivedHash, reviewHash: doc.reviewHash, generation: this.writer!.generation, expiresAt: Date.now() + 60_000 };
      this.authorizations.set(authorization.id, authorization);
      return { ok: true, authorizationId: authorization.id, expiresAt: new Date(authorization.expiresAt).toISOString(), candidateHash: authorization.candidateHash };
    });
  }
  async commit(args: any, control = false) {
    return this.serial(async () => {
      const { authorizationId: _authorization, dryRun: _dryRun, ...requestContent } = args;
      const requestFingerprint = objectHash({ ...requestContent, intent: args.intent ?? 'draft' });
      if (args.dryRun === false && (!args.requestId || typeof args.requestId !== 'string' || args.requestId.length > 128)) throw new HostError('INVALID_ARGUMENT', '真实提交必须携带稳定 requestId。');
      // 终态查询先于当前版本/授权检查，响应丢失后不重复提交。
      if (args.dryRun === false) {
        const persisted=await findJournalRequest(this.context,args.requestId);
        if(persisted){
          if(persisted.first.requestFingerprint!==requestFingerprint)throw new HostError('REQUEST_CONFLICT','requestId 已用于不同内容。',409);
          if(persisted.committed)return{...persisted.committed.receipt,replayed:true};
          throw new HostError('WRITE_OWNERSHIP_UNCERTAIN','已有非终态或中止记录，须先恢复裁决。',409);
        }
        for (const journal of this.journals.values()) {
          const terminal = journal.records.find(r => ['committed','prepare','aborted'].includes(r.type) && r.requestId === args.requestId);
          if (terminal) {
            if (terminal.requestFingerprint && terminal.requestFingerprint !== requestFingerprint) throw new HostError('REQUEST_CONFLICT', 'requestId 已用于不同内容。', 409);
            const committed = journal.records.find(r => r.type === 'committed' && r.requestId === args.requestId);
            if (committed) return { ...committed.receipt, replayed: true };
            throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '已有 prepare/aborted 记录；须先恢复裁决，不自动重放。', 409);
          }
        }
      }
      if(args.intent==='animation')return this.commitAnimation(args,requestFingerprint,control);
      if(args.animationCandidateHash!==undefined||args.expectedHash!==undefined||args.reviewToken!==undefined)throw new HostError('INVALID_ARGUMENT','动画专用参数必须使用 intent:animation。');
      const current = await this.draftCandidate(args), doc = current.doc;
      const summary = { ok: true, dryRun: true, version: doc.version, candidateHash: current.candidateHash, outputPath: current.outputPath, intent: current.intent, readyToCommit: true, gateRequirements: ['当前完整快照','MCP pose-draft 门禁','一次性授权','源文件备份'], changedPaths: inputDiff(JSON.parse(doc.baseline.toString('utf8')), current.candidate).map(d => d.path) };
      if (args.dryRun !== false) return { ...summary, ...(control ? { candidateBytes: current.bytes,...current.intent==='asset'?{binding:current.binding,dependencies:current.dependencies}:{} } : {}) };
      const authorization = this.authorizations.get(args.authorizationId);
      if (!authorization || authorization.expiresAt < Date.now() || authorization.candidateHash !== current.candidateHash || authorization.outputPath !== current.outputPath || authorization.snapshotHash !== doc.snapshotHash || authorization.derivedHash !== doc.derivedHash || authorization.reviewHash !== doc.reviewHash || authorization.generation !== this.writer!.generation) throw new HostError('COMMIT_NOT_AUTHORIZED', '缺少、过期、消费过或候选绑定不符的授权。', 409);
      return withFileLock(current.outputPath, this.context, async () => {
        await verifyWriter(this.writer!, this.context); await this.assertFresh(doc);
        const journal = await this.journal(doc), absolute = this.resolve(current.outputPath);
        const backupPath = `.spine-mcp/backups/${doc.version.documentId}/${Date.now()}-${randomUUID()}.json`;
        await mkdir(path.dirname(absolute),{recursive:true});
        const targetIdentity=path.join(await realpath(path.dirname(absolute)),path.basename(absolute));
        const identity = process.platform === 'win32' ? targetIdentity.toLowerCase() : targetIdentity;
        const kind=current.intent==='asset'?current.binding.kind:doc.kind;
        const version = { sessionId: this.sessionId, documentId: objectHash({ projectId: this.context.projectId, path: identity, kind }), openEpoch: randomUUID(), revision: 0 };
        const receipt = { ok: true, dryRun: false, committed: true, switched: current.intent!=='asset', version:current.intent==='asset'?doc.version:version, requestId: args.requestId, outputPath: current.outputPath, backupPath, hashBefore: doc.fileHash, hashAfter: current.candidateHash, candidateHash: current.candidateHash };
        const indexEntry = { path: current.outputPath, kind, characterId: doc.characterId, sourceDocument: doc.diagnostic?.sourcePath??doc.path, hash: current.candidateHash, documentId: version.documentId,...current.intent==='asset'?{assetBinding:current.binding}:doc.diagnostic?{assetBinding:{...doc.diagnostic.binding,path:current.outputPath}}:{} };
        await journal.append({ type: 'prepare', requestId: args.requestId, requestFingerprint, authorizationId: authorization.id, sourcePath: doc.path, expectedSourceHash: doc.fileHash, outputPath: current.outputPath, expectedOutputHash: null, candidateHash: current.candidateHash, backupPath, generation: this.writer!.generation, receipt, indexEntry });
        let published = false;
        const temp = `${absolute}.${randomUUID()}.tmp`;
        try {
          this.fault?.('backup');
          const backupAbsolute = this.resolve(backupPath); await mkdir(path.dirname(backupAbsolute), { recursive: true });
          const backup = await open(backupAbsolute, 'wx', 0o600);
          try { await backup.writeFile(doc.baseline); await backup.sync(); } finally { await backup.close(); }
          await mkdir(path.dirname(absolute), { recursive: true });
          const handle = await open(temp, 'wx', 0o600);
          try { await handle.writeFile(current.bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
          await verifyWriter(this.writer!, this.context); await this.assertFresh(doc); await this.assertReviewFresh(doc);
          if(current.intent==='asset')await this.draftCandidate(args);
          this.fault?.('publish'); await link(temp, absolute); published = true;
          this.fault?.('afterPublish'); this.fault?.('committed');
          await journal.append({ type: 'committed', requestId: args.requestId, requestFingerprint, receipt, indexEntry });
          this.authorizations.delete(authorization.id);
          if(current.intent==='asset'){
            this.assetCandidate=null;await this.rebuildIndex().catch(error=>this.emit('recovery-warning',{message:`索引待重建：${String(error)}`}));
            this.emit('asset-committed',{outputPath:current.outputPath,kind});return receipt;
          }
          const next: HostDocument = { ...doc,diagnostic:undefined, path: current.outputPath, version, baseline: Buffer.from(current.bytes), fileHash: current.candidateHash, value: editableValue(current.candidate), undo: [], redo: [], uncommitted: false, derived: null, derivedHash: null, review: null, reviewHash: null };
          this.updateSnapshot(next); this.active = next; this.pinned = null; this.pngCache.clear();
          await this.journal(next);
          await this.rebuildIndex().catch(error => this.emit('recovery-warning', { message: `索引待重建：${String(error)}` }));
          this.emit('doc-opened', { committed: true, outputPath: next.path }); return receipt;
        } catch (error) {
          this.authorizations.delete(authorization.id);
          if (published) { this.frozen = true; throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '资产已发布但事务回执未确认；保持冻结，按 journal 与候选哈希恢复。', 409); }
          await journal.append({ type: 'aborted', requestId: args.requestId, requestFingerprint, message: String(error) }); throw error;
        } finally { await unlink(temp).catch(() => {}); }
      });
    });
  }
  async rebuildIndex() {
    const entries = await readCommittedIndex(this.context), absolute = this.resolve('.spine-mcp/project-index.json');
    await mkdir(path.dirname(absolute), { recursive: true });
    const temp = `${absolute}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, entries }, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
      await rename(temp, absolute);
    } finally { await unlink(temp).catch(() => {}); }
    return entries;
  }
}
