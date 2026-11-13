import { open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { HostError, strictHash } from './hostContracts.js';
import { withFileLock } from './jobTools.js';
import type { ToolContext } from './spineJson.js';
import { OBSERVATION_ROOT, ObservationAuthority, relativeFile, verifyEvidence, writeEvidenceFile, type SignedEvidence } from './hostReleaseEvidence.js';

const catalogFile = `${OBSERVATION_ROOT}/catalog.jsonl`;
const headFile = `${OBSERVATION_ROOT}/catalog-head.json`;
/** 索引和末端签名让整份会话删除、已结束会话截断变成显式失败；本地文件所有者仍是信任边界。 */
export async function readObservationCatalog(context: ToolContext, publicPem: string) {
  const bytes = await readFile(relativeFile(catalogFile, context));
  if (!bytes.toString().endsWith('\n')) throw new HostError('EVIDENCE_INVALID', '观察索引存在未完成末行。', 409);
  const records = bytes.toString().trimEnd().split('\n').map(line => JSON.parse(line) as SignedEvidence);
  const starts = new Map<string, any>(), ends = new Map<string, any>(); let previous = '';
  for (let index = 0; index < records.length; index++) {
    const record = verifyEvidence(records[index], publicPem);
    if (record.sequence !== index || record.previous !== previous || !/^[a-f0-9-]{36}$/.test(record.runId)) throw new HostError('EVIDENCE_INVALID', '观察索引链不一致。', 409);
    if (record.type === 'start' && !starts.has(record.runId)) starts.set(record.runId, record);
    else if (record.type === 'stop' && starts.has(record.runId) && !ends.has(record.runId)) ends.set(record.runId, record);
    else throw new HostError('EVIDENCE_INVALID', '观察索引会话顺序无效。', 409);
    previous = records[index].hash;
  }
  const headBytes = await readFile(relativeFile(headFile, context)), head = verifyEvidence(JSON.parse(headBytes.toString()), publicPem);
  if (head.kind !== 'host-observation-catalog-head' || head.count !== records.length || head.tail !== previous) throw new HostError('EVIDENCE_INVALID', '观察索引末端签名不一致。', 409);
  return { starts, ends, count: records.length, tail: previous, headHash: strictHash(headBytes) };
}
export async function appendObservationCatalog(context: ToolContext, authority: ObservationAuthority, record: any) {
  await withFileLock(catalogFile, context, async () => {
    let current: { count: number; tail: string };
    try { current = await readObservationCatalog(context, authority.publicPem); }
    catch (error: any) {
      if (error.code !== 'ENOENT' || record.type !== 'start') throw error;
      for (const file of [catalogFile, headFile]) {
        try { await readFile(relativeFile(file, context)); throw new HostError('EVIDENCE_INVALID', '观察索引不完整，不能重建覆盖。', 409); }
        catch (check: any) { if (check.code !== 'ENOENT') throw check; }
      }
      try { if ((await readdir(relativeFile(`${OBSERVATION_ROOT}/runs`, context))).length) throw new HostError('EVIDENCE_INVALID', '已有会话但索引缺失，不能重置历史。', 409); }
      catch (check: any) { if (check.code !== 'ENOENT') throw check; }
      current = { count: 0, tail: '' };
    }
    const sealed = authority.seal({ ...record, sequence: current.count, previous: current.tail });
    const handle = await open(relativeFile(catalogFile, context), 'a', 0o600);
    try { await handle.writeFile(JSON.stringify(sealed) + '\n'); await handle.sync(); } finally { await handle.close(); }
    const temporary = `${headFile}.${randomUUID()}.tmp`;
    try {
      await writeEvidenceFile(temporary, authority.seal({ kind: 'host-observation-catalog-head', count: current.count + 1, tail: sealed.hash }), context);
      await rename(relativeFile(temporary, context), relativeFile(headFile, context));
    } finally { await unlink(relativeFile(temporary, context)).catch(() => undefined); }
  });
}
