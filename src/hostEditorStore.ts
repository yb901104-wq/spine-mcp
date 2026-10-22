import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HostDocumentStore, editableValue, type HostDocument } from './hostDocumentStore.js';
import { applyPoseCommands, inputDiff, invalidatePose } from './animationCommands.js';
import { assertVersion, HostError, objectHash, strictHash, type VersionRef } from './hostContracts.js';
import { HostJournal, readCommittedIndex, findJournalRequest, type JournalRecord } from './hostJournal.js';
import { acquireWriter, releaseWriter, verifyWriter } from './writerOwnership.js';
import { withFileLock } from './jobTools.js';
import { poseInputHash } from './animationKernel.js';
import { CAPTURE_EVIDENCE_SCHEMA } from './captureEvidence.js';
import { materializeHostPose } from './hostPose.js';
import { poseFingerprint, validatePoseReviewInput } from './poseWorkflow.js';
import { hashObject } from './mappingTools.js';
import { comparisonFingerprint } from './poseGraph.js';
interface Authorization {
  id: string; candidateHash: string; outputPath: string; snapshotHash: string; derivedHash: string | null;
  reviewHash: string | null; generation: number; expiresAt: number;
}
export class HostEditorStore extends HostDocumentStore {
  private journals = new Map<string, HostJournal>();
  private authorizations = new Map<string, Authorization>();
  private captureRecords = new Map<string, { manifestPath: string; manifestHash: string }>();
  private lastCapture: any = null;
  override async state(includeCapabilities = true): Promise<any> {
    const state = await super.state(includeCapabilities), capture = this.lastCapture;
    if(this.active?.review){
      try{if(state.targetStale)throw new HostError('REVIEW_STALE','文档依赖已漂移。',409);await this.assertReviewFresh(this.active);}
      catch(error:any){state.agentVisual={status:'stale',decision:this.active.review.decision,code:'REVIEW_STALE',message:error.message};}
    }
    const currentCapture=capture && !state.targetStale && objectHash(capture.version) === objectHash(state.version) && capture.derivedHash === state.derivedHash ? structuredClone(capture) : null;
    const operation=state.capabilities?.operations.find((op:any)=>op.operation==='review');
    if(operation?.supported&&currentCapture?.evidenceEligible&&!this.frozen){
      operation.canRun=true;operation.state='ready';operation.reasons=[];operation.nextAction={tool:'spine_review_pose',instruction:'携带当前完整版本与 player manifest；默认只预演，可记录退回，批准仍须全部内容门禁。'};
    }
    return { ...state, capture:currentCapture };
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
    this.writer = await acquireWriter(this.context, 'attached'); this.writeMode = 'attached'; this.frozen = false;
  }
  async shutdown() {
    await this.serial(async () => {
      if (this.writer && !this.frozen) { await releaseWriter(this.writer, this.context); this.writer = null; }
      this.writeMode = this.frozen ? 'frozen' : 'observer'; this.emit('preview-closed');
    });
  }
  protected override invalidateDerived(document: HostDocument) {
    super.invalidateDerived(document); this.authorizations.clear();
  }
  private async writable(expectedRevision: VersionRef) {
    const doc = this.requireDoc(); assertVersion(expectedRevision, doc.version);
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
    await journal.initialize({ docPath: document.path, sessionId: this.sessionId, lastCommittedHash: document.fileHash, lastCommittedRevision: 0 });
    return journal;
  }
  protected override async afterOpen(document: HostDocument) {
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
        await journal.append({ type: 'committed', requestId: prepare.requestId, requestFingerprint: prepare.requestFingerprint, receipt: prepare.receipt, indexEntry: prepare.indexEntry, recovered: true });
      } else if (targetHash === prepare.expectedOutputHash) {
        await journal.append({ type: 'aborted', requestId: prepare.requestId, message: '原子发布未发生，不自动重试提交。' });
      } else {
        this.frozen = true;
        throw new HostError('TARGET_STALE', '未完成提交的输出既非候选也非旧基线，保持冻结并保留 journal。', 409);
      }
    }
    records = journal.records;
    const lastCommit = records.reduce((last, r, index) => r.type === 'committed' ? index : last, -1);
    const edit = records.slice(lastCommit + 1).reverse().find(r => r.type === 'edit');
    if (!edit) return;
    if (edit.fileHash !== document.fileHash) {
      if (!this.writer) throw new HostError('TARGET_STALE', '有未提交 journal 且磁盘已变化；需写入权归档冲突。', 409);
      const archive = await journal.archive('rejected'); this.emit('recovery-warning', { code: 'TARGET_STALE', archive, diskWins: true }); return;
    }
    const checkRecovered=(value:any)=>inputDiff(document.value,editableValue(value)).every(d=>/^\/(?:id|status)$/.test(d.path)||/^\/frame\/targets\/(?:leftHand|rightHand)\/(?:x|y|angle)$/.test(d.path));
    if(!checkRecovered(edit.document)||![...(edit.undo??[]),...(edit.redo??[])].every(checkRecovered))throw new HostError('JOURNAL_CORRUPT','恢复内容超出 C1 固定绑定与手目标白名单。',409);
    document.value = invalidatePose(structuredClone(edit.document));
    document.undo = (edit.undo ?? []).map((p: any) => invalidatePose(structuredClone(p)));
    document.redo = (edit.redo ?? []).map((p: any) => invalidatePose(structuredClone(p)));
    document.version = { ...document.version, revision: 1 };
    document.uncommitted = edit.uncommitted;
    this.invalidateDerived(document); this.updateSnapshot(document);
    this.emit('doc-opened', { recovered: true, path: document.path });
  }
  async pin(expectedRevision: VersionRef) {
    return this.serial(async () => {
      const doc = this.requireDoc(); assertVersion(expectedRevision, doc.version); await this.assertFresh(doc);
      if (!this.writer || this.frozen) throw new HostError('WRITE_FORBIDDEN', '当前 Host 仅观察，不能 pin 写入目标。', 409);
      await verifyWriter(this.writer, this.context);
      this.pinned = { version: structuredClone(doc.version), fileHashAtPin: doc.fileHash, pinnedAt: new Date().toISOString() };
      return { ok: true, pinned: true, version: doc.version, fileHashAtPin: doc.fileHash };
    });
  }
  async patch(args: any) {
    return this.serial(async () => {
      const doc = await this.writable(args.expectedRevision);
      if (doc.kind !== 'pose') throw new HostError('UNSUPPORTED_DOC_KIND', 'C1 仅编辑 pose。');
      if (!Array.isArray(args.ops) || args.ops.length !== 1) throw new HostError('CAPABILITY_MISSING', 'C1 每次只接受一个手目标操作。');
      const op = args.ops[0];
      if (op.op !== 'setPoseTarget' || !['leftHand','rightHand'].includes(op.role) || op.path !== `pose/frame/targets/${op.role}` || Object.keys(op).some(k => !['op','path','role','x','y','angle'].includes(k))) throw new HostError('CAPABILITY_MISSING', 'C1 只开放既有 leftHand/rightHand 的 x/y/angle。');
      if (!doc.value.frame.targets?.[op.role] || !doc.mapping?.bones?.anchors?.[op.role]) throw new HostError('CAPABILITY_MISSING', '手目标或已校准末端锚点缺失。');
      if (doc.value.weapon && (op.x !== undefined || op.y !== undefined)) throw new HostError('OPERATION_NOT_READY', '该手的 x/y 由 weapon/grip 接管，不能用目标补丁声称已生效。', 409);
      if (op.angle !== undefined && (!Number.isFinite(op.angle) || op.angle < -180 || op.angle >= 180)) throw new HostError('INVALID_ARGUMENT', 'angle 必须在 [-180,180) 内。');
      const command = { op: 'target', role: op.role, ...Object.fromEntries(['x','y','angle'].filter(k => op[k] !== undefined).map(k => [k,op[k]])) };
      const candidate = applyPoseCommands(doc.value, [command]).pose;
      candidate.id = `pose-${objectHash({ version: doc.version, ops: args.ops }).slice(0, 24)}`;
      const diff = inputDiff(doc.value, candidate);
      if (args.dryRun !== false) return { ok: true, dryRun: true, version: doc.version, diff, changedPaths: diff.map(d => d.path) };
      const undo = [...doc.undo, structuredClone(doc.value)], redo: any[] = [];
      await this.publishEdit(doc, candidate, undo, redo, args.clientId ?? 'mcp');
      return { ok: true, dryRun: false, version: doc.version, diff, changedPaths: diff.map(d => d.path), nextAction: '读取新快照并重新求解、发布与出图。' };
    });
  }
  private async publishEdit(doc: HostDocument, candidate: any, undo: any[], redo: any[], clientId: string) {
    const uncommitted = objectHash(editableValue(candidate)) !== objectHash(editableValue(JSON.parse(doc.baseline.toString('utf8'))));
    const journal = await this.journal(doc);
    this.fault?.('journal');
    await journal.append({ type: 'edit', document: candidate, undo, redo, uncommitted, clientId, fileHash: doc.fileHash, revision: doc.version.revision + 1 });
    doc.value = candidate; doc.undo = undo; doc.redo = redo; doc.uncommitted = uncommitted;
    doc.version = { ...doc.version, revision: doc.version.revision + 1 };
    this.invalidateDerived(doc); this.updateSnapshot(doc); this.emit('doc-changed');
  }
  async history(direction: 'undo' | 'redo', args: any) {
    return this.serial(async () => {
      const doc = await this.writable(args.expectedRevision), source = direction === 'undo' ? doc.undo : doc.redo;
      if (!source.length) return { ok: true, dryRun: args.dryRun !== false, version: doc.version, noOp: true };
      const candidate = invalidatePose(structuredClone(source.at(-1))), diff = inputDiff(doc.value, candidate);
      if (args.dryRun !== false) return { ok: true, dryRun: true, version: doc.version, diff, changedPaths: diff.map(d => d.path) };
      const undo = direction === 'undo' ? doc.undo.slice(0, -1) : [...doc.undo, structuredClone(doc.value)];
      const redo = direction === 'redo' ? doc.redo.slice(0, -1) : [...doc.redo, structuredClone(doc.value)];
      await this.publishEdit(doc, candidate, undo, redo, args.clientId ?? 'mcp');
      return { ok: true, dryRun: false, version: doc.version, diff, changedPaths: diff.map(d => d.path) };
    });
  }
  private async draftCandidate(args: any) {
    const doc = await this.writable(args.expectedRevision);
    if (doc.kind !== 'pose' || args.intent && args.intent !== 'draft') throw new HostError('CAPABILITY_MISSING', 'C1 只提交 pose 新修订草稿；动画写入未开放。');
    if (!args.outputPath || this.resolve(args.outputPath) === this.resolve(doc.path)) throw new HostError('INVALID_ARGUMENT', '必须给出不同于源文档的新 outputPath。');
    const outputPath = path.relative(this.context.workspaceRoot!, this.resolve(args.outputPath)).replace(/\\/g, '/');
    if (/^(?:\.spine-mcp|\.git|\.codex|\.agents|node_modules|dist|backups|test-output)(?:\/|$)/i.test(outputPath) || !outputPath.endsWith('.json')) throw new HostError('PATH_FORBIDDEN', '输出必须是工作区内的新 JSON 资产，不能使用内部或生成目录。', 403);
    if(this.project?.mode==='managed'&&Object.values(this.project.manifest.artifactRoots).some(root=>outputPath.toLowerCase().startsWith(root.toLowerCase()+'/')))throw new HostError('PATH_FORBIDDEN','不能把预览/报告产物目录作为受管资产输出。',403);
    if (!doc.derived || doc.derived.inputFingerprint !== poseInputHash(doc.value)) throw new HostError('NO_SOLUTION', '保存草稿前须发布当前输入的求解结果。', 409);
    await this.assertReviewFresh(doc);
    try { await readFile(this.resolve(outputPath)); throw new HostError('TARGET_STALE', '输出已存在，请使用新修订路径。', 409); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const candidate = materializeHostPose(doc.value,doc.derived);
    if (doc.review) {
      candidate.review = structuredClone(doc.review.record);
      candidate.status = doc.review.decision === 'approved' ? 'confirmed' : 'rejected';
      if(candidate.review.comparisonPath)candidate.comparisonPath=candidate.review.comparisonPath;
    }
    const bytes = `${JSON.stringify(candidate, null, 2)}\n`, candidateHash = strictHash(bytes);
    return { doc, candidate, bytes, candidateHash, outputPath, intent: 'draft' as const };
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
      if (review.decision === 'approved' && (doc.derived.numeric.ok !== true || doc.derived.comparison?.ok === false || (doc.value.reference||doc.value.referencePosePath)&&doc.derived.comparison?.ok!==true)) throw new HostError('COMMIT_NOT_AUTHORIZED', '失败诊断不能批准。', 409);
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
      const current = await this.draftCandidate(args), doc = current.doc, gate = args.gateRecord;
      if (args.candidateHash !== current.candidateHash || args.snapshotHash !== doc.snapshotHash || args.derivedHash !== doc.derivedHash || (args.reviewHash ?? null) !== doc.reviewHash || !gate || gate.gate !== 'pose-draft' || gate.passed !== true || gate.candidateHash !== current.candidateHash) throw new HostError('COMMIT_NOT_AUTHORIZED', '授权必须绑定当前精确草稿候选与 MCP 门禁记录。', 409);
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
      const current = await this.draftCandidate(args), doc = current.doc;
      const summary = { ok: true, dryRun: true, version: doc.version, candidateHash: current.candidateHash, outputPath: current.outputPath, intent: current.intent, readyToCommit: true, gateRequirements: ['当前完整快照','MCP pose-draft 门禁','一次性授权','源文件备份'], changedPaths: inputDiff(JSON.parse(doc.baseline.toString('utf8')), current.candidate).map(d => d.path) };
      if (args.dryRun !== false) return { ...summary, ...(control ? { candidateBytes: current.bytes } : {}) };
      const authorization = this.authorizations.get(args.authorizationId);
      if (!authorization || authorization.expiresAt < Date.now() || authorization.candidateHash !== current.candidateHash || authorization.outputPath !== current.outputPath || authorization.snapshotHash !== doc.snapshotHash || authorization.derivedHash !== doc.derivedHash || authorization.reviewHash !== doc.reviewHash || authorization.generation !== this.writer!.generation) throw new HostError('COMMIT_NOT_AUTHORIZED', '缺少、过期、消费过或候选绑定不符的授权。', 409);
      return withFileLock(current.outputPath, this.context, async () => {
        await verifyWriter(this.writer!, this.context); await this.assertFresh(doc);
        const journal = await this.journal(doc), absolute = this.resolve(current.outputPath);
        const backupPath = `.spine-mcp/backups/${doc.version.documentId}/${Date.now()}-${randomUUID()}.json`;
        await mkdir(path.dirname(absolute),{recursive:true});
        const targetIdentity=path.join(await realpath(path.dirname(absolute)),path.basename(absolute));
        const identity = process.platform === 'win32' ? targetIdentity.toLowerCase() : targetIdentity;
        const version = { sessionId: this.sessionId, documentId: objectHash({ projectId: this.context.projectId, path: identity, kind: doc.kind }), openEpoch: randomUUID(), revision: 0 };
        const receipt = { ok: true, dryRun: false, committed: true, switched: true, version, requestId: args.requestId, outputPath: current.outputPath, backupPath, hashBefore: doc.fileHash, hashAfter: current.candidateHash, candidateHash: current.candidateHash };
        const indexEntry = { path: current.outputPath, kind: doc.kind, characterId: doc.characterId, sourceDocument: doc.path, hash: current.candidateHash, documentId: version.documentId };
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
          this.fault?.('publish'); await link(temp, absolute); published = true;
          this.fault?.('afterPublish'); this.fault?.('committed');
          await journal.append({ type: 'committed', requestId: args.requestId, requestFingerprint, receipt, indexEntry });
          this.authorizations.delete(authorization.id);
          const next: HostDocument = { ...doc, path: current.outputPath, version, baseline: Buffer.from(current.bytes), fileHash: current.candidateHash, value: editableValue(current.candidate), undo: [], redo: [], uncommitted: false, derived: null, derivedHash: null, review: null, reviewHash: null };
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
