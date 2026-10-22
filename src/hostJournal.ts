import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { objectHash, HostError } from './hostContracts.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
export type JournalRecord = { type: string; [key: string]: any };
interface Envelope { previous: string; record: JournalRecord; checksum: string }
export class HostJournal {
  private tail = '';
  records: JournalRecord[] = [];
  readonly filePath: string;
  constructor(public documentId: string, private context: ToolContext) {
    if (!/^[a-f0-9]{64}$/.test(documentId)) throw new HostError('JOURNAL_CORRUPT', '非法 documentId。');
    this.filePath = `.spine-mcp/journals/${documentId}.jsonl`;
  }
  async read() {
    let raw: string;
    try { raw = await readFile(resolveWorkspacePath(this.filePath, this.context), 'utf8'); }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    if (!raw.endsWith('\n')) throw new HostError('JOURNAL_CORRUPT', 'journal 有未完成的末行，禁止静默重放。', 409);
    const records: JournalRecord[] = []; let previous = '';
    try {
      for (const line of raw.split('\n').slice(0, -1)) {
        const envelope = JSON.parse(line) as Envelope;
        if (!envelope.record || envelope.previous !== previous || objectHash({ previous, record: envelope.record }) !== envelope.checksum) throw new Error('校验链失配');
        records.push(envelope.record); previous = envelope.checksum;
      }
      if (records[0]?.type !== 'header' || records[0].documentId !== this.documentId) throw new Error('header 不匹配');
    } catch (error) { throw new HostError('JOURNAL_CORRUPT', `journal 无法验证：${String(error)}`, 409); }
    this.records = records; this.tail = previous; return records;
  }
  async append(record: JournalRecord) {
    const absolute = resolveWorkspacePath(this.filePath, this.context);
    await mkdir(path.dirname(absolute), { recursive: true });
    const checksum = objectHash({ previous: this.tail, record });
    const envelope = { previous: this.tail, record, checksum };
    const handle = await open(absolute, 'a', 0o600);
    try { await handle.writeFile(JSON.stringify(envelope) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    this.tail = checksum; this.records.push(structuredClone(record));
  }
  async initialize(header: Omit<JournalRecord, 'type'>) {
    if (!this.records.length) await this.append({ ...header, type: 'header', documentId: this.documentId, apiVersion: '1' });
  }
  async archive(reason: 'rejected' | 'corrupt') {
    const source = resolveWorkspacePath(this.filePath, this.context);
    const archive = `${this.filePath}.${reason}-${Date.now()}-${randomUUID()}`;
    await rename(source, resolveWorkspacePath(archive, this.context));
    this.records = []; this.tail = ''; return archive;
  }
}

/** 仅枚举内部 journal；legacy 工作区不会借此扫描美术资源。 */
export async function readCommittedIndex(context: ToolContext) {
  const result: Array<{ path: string; kind: string; characterId: string; sourceDocument: string; hash: string; documentId: string }> = [];
  let files: string[];
  try { files = await readdir(resolveWorkspacePath('.spine-mcp/journals', context)); }
  catch (error: any) { if (error.code === 'ENOENT') return result; throw error; }
  for (const file of files.filter(f => /^[a-f0-9]{64}\.jsonl$/.test(f))) {
    const journal = new HostJournal(file.slice(0, -6), context), records = await journal.read();
    for (const record of records) if (record.type === 'committed' && record.indexEntry) result.push(record.indexEntry);
  }
  return result;
}

export async function findJournalRequest(context: ToolContext, requestId: string) {
  let files:string[];
  try { files=await readdir(resolveWorkspacePath('.spine-mcp/journals',context)); }
  catch(error:any){if(error.code==='ENOENT')return null;throw error;}
  for(const file of files.filter(f=>/^[a-f0-9]{64}\.jsonl$/.test(f))){
    const journal=new HostJournal(file.slice(0,-6),context),records=await journal.read();
    const matching=records.filter(r=>r.requestId===requestId);
    if(matching.length)return{first:matching[0],committed:matching.find(r=>r.type==='committed')};
  }
  return null;
}
