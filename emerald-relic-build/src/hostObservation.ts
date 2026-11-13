import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { HostError, objectHash, strictHash } from './hostContracts.js';
import type { HostEditorStore } from './hostEditorStore.js';
import type { ToolContext } from './spineJson.js';
import { resolveWorkspacePathAsync } from './spineJson.js';
import { strictFileChecks } from './strictFileChecks.js';
import { appendObservationCatalog, readObservationCatalog } from './hostObservationCatalog.js';
import { hostBuildFingerprint, newEvidencePath, OBSERVATION_ROOT, ObservationAuthority, observationPublicKey, relativeFile, releaseBinding, TWO_WEEKS_MS, verifyEvidence, writeEvidenceFile, type ProtectFile, type SignedEvidence } from './hostReleaseEvidence.js';

export const OBSERVATION_INTERVAL_MS = 60_000;
interface Clock { wall(): number; monotonic(): number }
const realClock: Clock = { wall: () => Date.now(), monotonic: () => performance.now() };
/** 只记录白名单摘要，绝不序列化请求头、控制凭据、租约或请求体。 */
export class HostObservation {
  onChanged?: () => void;
  private authority?: ObservationAuthority;
  private handle?: FileHandle;
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<unknown> = Promise.resolve();
  private runId: string | null = null;
  private file: string | null = null;
  private sequence = 0;
  private previous = '';
  private startMono = 0;
  private lastMono = 0;
  private lastWall = 0;
  private binding: any;
  private candidate: any;
  private error: string | null = null;
  private requests: Record<string, number> = {};
  private events: Record<string, number> = {};
  private samples = 0;
  constructor(private readonly store: HostEditorStore, private readonly context: ToolContext, private readonly protect: ProtectFile,
    private readonly clock: Clock = realClock) {}
  status() { return { running: !!this.handle, runId: this.runId, file: this.file, samples: this.samples, intervalMs: OBSERVATION_INTERVAL_MS, error: this.error, testClock: this.clock !== realClock }; }
  noteRequest(method: string, route: string, status: number) {
    if (!this.handle) return;
    const allowed = ['/api/state', '/api/capabilities', '/api/open', '/api/frame', '/api/capture', '/api/events', '/api/snapshot', '/api/derived', '/api/evaluation-task', '/api/shutdown'];
    const key = `${method === 'GET' ? 'GET' : 'POST'} ${allowed.includes(route) ? route : 'other'} ${Math.floor(status / 100)}xx`;
    this.requests[key] = (this.requests[key] ?? 0) + 1;
  }
  noteEvent(type: string) {
    if (this.handle) { const key = ['doc-opened', 'doc-changed', 'frame-updated', 'capture-done', 'recovery-warning', 'evaluation-task-updated', 'preview-closed'].includes(type) ? type : 'other'; this.events[key] = (this.events[key] ?? 0) + 1; }
  }
  private enqueue<T>(work: () => Promise<T>) { const task = this.pending.then(work); this.pending = task.catch(() => undefined); return task; }
  private async append(record: any) {
    const payload = { ...record, runId: this.runId, sequence: this.sequence++, previous: this.previous, wallMs: this.clock.wall(), elapsedMs: this.clock.monotonic() - this.startMono };
    const envelope = this.authority!.seal(payload);
    await this.handle!.writeFile(JSON.stringify(envelope) + '\n'); await this.handle!.sync(); this.previous = envelope.hash;
  }
  async start() {
    return this.enqueue(async () => {
      if (this.handle) return this.status();
      if (this.store.writeMode !== 'observer' || this.store.frozen) throw new HostError('WRITE_FORBIDDEN', 'B 观察记录只接受正常观察模式。', 409);
      if (!this.store.active || this.store.active.kind !== 'pose') throw new HostError('DOC_NOT_LOADED', '开始观察前须显式打开真实工程的 pose。', 409);
      this.binding = await releaseBinding(this.context); this.candidate = await hostBuildFingerprint();
      this.authority = await ObservationAuthority.load(this.context, this.protect, true);
      this.runId = randomUUID(); this.file = `${OBSERVATION_ROOT}/runs/${this.runId}.jsonl`;
      await appendObservationCatalog(this.context, this.authority, { type: 'start', runId: this.runId, candidateHash: this.candidate.hash, bindingHash: objectHash(this.binding) });
      const absolute = relativeFile(this.file, this.context); await mkdir(path.dirname(absolute), { recursive: true });
      this.handle = await open(absolute, 'wx', 0o600); this.sequence = 0; this.previous = ''; this.samples = 0; this.error = null;
      this.requests = {}; this.events = {}; this.startMono = this.clock.monotonic(); this.lastMono = this.startMono; this.lastWall = this.clock.wall();
      try {
        await this.append({ type: 'start', schema: 1, binding: this.binding, candidateHash: this.candidate.hash, intervalMs: OBSERVATION_INTERVAL_MS,
          sessionId: this.store.sessionId, initialDocument: this.store.active.path, testClock: this.clock !== realClock });
        await this.sampleNow();
      } catch (error) { await this.handle.close(); this.handle = undefined; throw error; }
      this.timer = setInterval(() => { void this.sample().catch(error => { this.error = error instanceof HostError ? error.code : 'OBSERVATION_IO_FAILED'; }); }, OBSERVATION_INTERVAL_MS);
      this.timer.unref(); return this.status();
    });
  }
  private async sampleNow() {
    const before = this.store.active;
    const version = before ? structuredClone(before.version) : null;
    const files = before ? [{ filePath: before.path, hash: before.fileHash }, ...before.dependencies] : [];
    const check = () => strictFileChecks(files, file => resolveWorkspacePathAsync(file, this.context));
    const first = await check(), state = await this.store.state(false), second = await check();
    const currentCandidate = await hostBuildFingerprint(), binding = await releaseBinding(this.context);
    const now = this.clock.monotonic(), wall = this.clock.wall();
    const stableVersion = objectHash(version) === objectHash(this.store.active?.version ?? null) && objectHash(state.version) === objectHash(version);
    const readable = [...first, ...second].every(file => !file.error);
    const unchanged = readable && [...first, ...second].every(file => file.actual === file.hash);
    const suspectedFalsePositive = !!before && stableVersion && unchanged && state.targetStale === true;
    const delta = now - this.lastMono, wallDelta = wall - this.lastWall;
    const record = { type: 'sample', version, document: before?.path ?? null, writeMode: state.writeMode,
      targetStale: state.targetStale, suspectedFalsePositive, inconclusive: !stableVersion || !readable || !before,
      inputs: { count: second.length, expectedFingerprint: objectHash(files), actualFingerprint: objectHash(second.map(file => ({ filePath: file.filePath, hash: file.actual }))),
        changedCount: second.filter(file => file.error || file.actual !== file.hash).length,
        changed: second.filter(file => file.error || file.actual !== file.hash).slice(0, 16).map(file => ({ filePath: file.filePath, expected: file.hash, actual: file.actual, readable: !file.error })) },
      candidateMatches: currentCandidate.hash === this.candidate.hash, bindingMatches: objectHash(binding) === objectHash(this.binding),
      clockConsistent: delta >= 0 && Math.abs(wallDelta - delta) <= 5000,
      gapMs: delta > OBSERVATION_INTERVAL_MS * 2.5 ? delta : 0,
      requests: this.requests, events: this.events,
      frozen: state.writeMode === 'frozen', numericOk: state.numeric?.ok ?? null, derivedHash: state.derivedHash, pageEvidenceNotCollected: true };
    await this.append(record); this.samples++; this.lastMono = now; this.lastWall = wall; this.onChanged?.();
  }
  async sample() { return this.enqueue(async () => {
    if (this.handle) try { await this.sampleNow(); }
    catch (error) { this.error = error instanceof HostError ? error.code : 'OBSERVATION_SAMPLE_FAILED'; this.onChanged?.(); await this.append({ type: 'error', code: this.error }); throw error; }
    return this.status();
  }); }
  async stop(reason = 'operator-stop') {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    return this.enqueue(async () => {
      if (!this.handle) return this.status();
      try {
        await this.sampleNow(); await this.append({ type: 'stop', reason, samples: this.samples });
        await appendObservationCatalog(this.context, this.authority!, { type: 'stop', runId: this.runId, fileHash: strictHash(await readFile(relativeFile(this.file!, this.context))), finalHash: this.previous });
      }
      catch (error) { this.error = 'OBSERVATION_STOP_FAILED'; throw error; }
      finally { await this.handle.close(); this.handle = undefined; this.onChanged?.(); }
      return this.status();
    });
  }
}

export async function summarizeObservation(context: ToolContext, candidateHash: string, now = Date.now()) {
  const publicPem = await observationPublicKey(context), binding = await releaseBinding(context);
  const catalog = await readObservationCatalog(context, publicPem);
  const directory = relativeFile(`${OBSERVATION_ROOT}/runs`, context);
  const files = (await readdir(directory)).filter(file => /^[a-f0-9-]{36}\.jsonl$/.test(file)).sort();
  const sessions: any[] = [], excluded: any[] = [], errors: string[] = [];
  for (const id of catalog.starts.keys()) if (!files.includes(`${id}.jsonl`)) errors.push(`${id}: 索引登记的会话文件缺失`);
  const coverageDays = new Set<string>();
  let start = Infinity, end = -Infinity, monitoredMs = 0, samples = 0, inconclusive = 0, gaps = 0, unclean = 0;
  for (const name of files) {
    const file = `${OBSERVATION_ROOT}/runs/${name}`, bytes = await readFile(relativeFile(file, context));
    try {
      if (!bytes.toString().endsWith('\n')) throw Error('存在未完成末行');
      const records = bytes.toString().trimEnd().split('\n').map(line => JSON.parse(line) as SignedEvidence);
      let previous = '', lastElapsed = -1, lastWall = -Infinity;
      for (let index = 0; index < records.length; index++) {
        const record = verifyEvidence(records[index], publicPem);
        if (!['start', 'sample', 'stop', 'error'].includes(record.type) || (index > 0 && record.type === 'start') || (record.type === 'stop' && index !== records.length - 1) || record.sequence !== index || record.previous !== previous || record.runId !== name.slice(0, -6) || !Number.isFinite(record.elapsedMs) || record.elapsedMs < lastElapsed || !Number.isFinite(record.wallMs) || record.wallMs < lastWall || record.wallMs > now + 1000 || Math.abs(record.wallMs - records[0].payload.wallMs - record.elapsedMs) > 5000) throw Error('记录链、时钟或身份不一致');
        previous = records[index].hash; lastElapsed = record.elapsedMs; lastWall = record.wallMs;
      }
      const header = records[0]?.payload;
      if (header?.type !== 'start' || header.schema !== 1 || header.intervalMs !== OBSERVATION_INTERVAL_MS) throw Error('观察 header 无效');
      const registered = catalog.starts.get(header.runId), final = catalog.ends.get(header.runId);
      if (!registered || registered.candidateHash !== header.candidateHash || registered.bindingHash !== objectHash(header.binding)) throw Error('会话与观察索引不一致');
      if (final ? final.fileHash !== strictHash(bytes) || final.finalHash !== records.at(-1)?.hash || records.at(-1)?.payload.type !== 'stop' : records.at(-1)?.payload.type === 'stop') throw Error('会话末端与观察索引不一致');
      if (header.candidateHash !== candidateHash || objectHash(header.binding) !== objectHash(binding)) { excluded.push({ file, reason: '其它候选构建或工程绑定', fileHash: strictHash(bytes) }); continue; }
      if (header.testClock) errors.push(`${file}: 测试时钟不能用于真实观察准入`);
      const data = records.map(record => record.payload), readings = data.filter(record => record.type === 'sample');
      if (data.some(record => record.type === 'error')) errors.push(`${file}: 存在失败采样，须处理后重新观察`);
      if (!['sample', 'stop'].includes(data.at(-1)?.type)) throw Error('观察没有有效采样');
      if (data.at(-1).type !== 'stop') unclean++;
      let previousSample: any;
      for (const sample of readings) {
        samples++; inconclusive += Number(!!sample.inconclusive);
        if (sample.suspectedFalsePositive || sample.frozen || !sample.candidateMatches || !sample.bindingMatches || !sample.clockConsistent || sample.writeMode !== 'observer') errors.push(`${file}: 需处理误报疑点、冻结、构建/工程变化或时钟异常`);
        if (previousSample) {
          const delta = sample.elapsedMs - previousSample.elapsedMs;
          if (delta > OBSERVATION_INTERVAL_MS * 2.5) gaps++; else monitoredMs += delta;
        }
        if (!sample.inconclusive) coverageDays.add(new Date(sample.wallMs).toISOString().slice(0, 10));
        start = Math.min(start, sample.wallMs); end = Math.max(end, sample.wallMs); previousSample = sample;
      }
      sessions.push({ file, fileHash: strictHash(bytes), runId: header.runId, startMs: header.wallMs, endMs: lastWall, samples: readings.length, cleanStop: data.at(-1).type === 'stop', requests: readings.at(-1)?.requests ?? {}, events: readings.at(-1)?.events ?? {} });
    } catch (error) { errors.push(`${file}: ${String(error)}`); }
  }
  const spanMs = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
  return { kind: 'host-observation-report', schema: 1, generatedAt: now, binding, candidateHash, catalogHash: catalog.headHash, sessions, excluded, errors,
    sampleCount: samples, firstSampleMs: Number.isFinite(start) ? start : null, lastSampleMs: Number.isFinite(end) ? end : null,
    windowSpanMs: spanMs, monitoredMs, coverageDays: [...coverageDays].sort(), gapCount: gaps, uncleanSessions: unclean, inconclusiveSamples: inconclusive,
    windowSpanSatisfied: spanMs >= TWO_WEEKS_MS, readyForHumanReview: spanMs >= TWO_WEEKS_MS && coverageDays.size >= 14 && monitoredMs > 0 && sessions.length > 0 && errors.length === 0,
    publicEnablementReady: false, note: '跨两周仅是人工评审前置；必须另审真实使用覆盖、间断、异常、回归及视觉范围。本地签名不提供外部可信时间。' };
}

export async function saveObservationReport(context: ToolContext, protect: ProtectFile) {
  const candidate = await hostBuildFingerprint(), report = await summarizeObservation(context, candidate.hash);
  const authority = await ObservationAuthority.load(context, protect), file = newEvidencePath('reports');
  await writeEvidenceFile(file, authority.seal(report), context); return { file, report };
}
