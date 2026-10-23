import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HostJournal, findJournalRequest, readCommittedIndex } from '../src/hostJournal.js';

test('多 journal 查询保持终态、索引顺序与逐次磁盘校验，不复用旧成功结果', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-journal-read-')), context = { workspaceRoot: root };
  try {
    assert.equal(await findJournalRequest(context, 'absent'), null);
    assert.deepEqual(await readCommittedIndex(context), []);
    const journals: HostJournal[] = [];
    for (let index = 0; index < 9; index++) {
      const journal = new HostJournal(index.toString(16).padStart(64, '0'), context);
      await journal.initialize({ baselineHash: 'baseline' });
      await journal.append({ type: 'prepare', requestId: `request-${index}`, requestFingerprint: `fingerprint-${index}` });
      await journal.append({ type: 'committed', requestId: `request-${index}`, receipt: { committed: true }, indexEntry: { path: `pose-${index}.json` } });
      journals.push(journal);
    }
    const last = await findJournalRequest(context, 'request-8');
    assert.equal(last!.first.type, 'prepare');
    assert.equal(last!.committed!.receipt.committed, true);
    assert.equal(await findJournalRequest(context, 'absent'), null);
    assert.deepEqual((await readCommittedIndex(context)).map(entry => entry.path), Array.from({ length: 9 }, (_, index) => `pose-${index}.json`));
    const damaged = path.join(root, journals[4].filePath);
    const bytes = await readFile(damaged, 'utf8');
    await writeFile(damaged, bytes.replace('fingerprint-4', 'tampered-value'));
    await assert.rejects(findJournalRequest(context, 'request-8'), { code: 'JOURNAL_CORRUPT' });
    await assert.rejects(readCommittedIndex(context), { code: 'JOURNAL_CORRUPT' });
    // 与原顺序查询一致：首个已找到的回执不依赖之后未遍历的记录。
    assert.equal((await findJournalRequest(context, 'request-0'))!.committed!.receipt.committed, true);
    await writeFile(damaged, bytes);
    assert.equal((await findJournalRequest(context, 'request-8'))!.committed!.receipt.committed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('journal 的异步边界解析失败不能作为文件不存在而吞掉', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'host-journal-link-')),context={workspaceRoot:root};
  try {
    const directory=path.join(root,'.spine-mcp/journals');await mkdir(directory,{recursive:true});
    const journal=new HostJournal('f'.repeat(64),context),link=path.join(root,journal.filePath);
    await symlink(path.join(root,'missing-journal-directory'),link,process.platform==='win32'?'junction':'dir');
    await assert.rejects(journal.read());
    await unlink(link);assert.deepEqual(await journal.read(),[]);
  } finally {await rm(root,{recursive:true,force:true});}
});
