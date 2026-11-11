import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HostError, objectHash } from './hostContracts.js';
import { withFileLock } from './jobTools.js';
import { readJson, within, type Json, type ProjectSource } from './authoringProject.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';
import type { DraftAsset } from './authoringEdits.js';

export const authoringRoot = '.spine-mcp/authoring';
const observerFile = `${authoringRoot}/observer.json`;
const draftIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const hashPattern = /^[\da-f]{64}$/;
export type Candidate = { json: Json; assets: DraftAsset[] };
export type Draft = {
  version: 1; draftId: string; project: ProjectSource; skeleton: string; animation: string;
  revision: number; revisions: string[]; past: string[]; future: string[];
};
export type AuthoringPreview = { id: string; revision: number; frames: string[]; times: number[]; duration: number; gifPath?: string };
type Observation = {
  draftId: string; revision: number; animation: string; status: 'edited' | 'rendering' | 'ready' | 'error';
  preview?: AuthoringPreview; jobId?: string; error?: string;
};

export function draftDir(id: string) {
  if (!draftIdPattern.test(id)) throw new HostError('INVALID_ARGUMENT', '草稿标识无效。');
  return within(authoringRoot, id);
}
export const draftState = (id: string) => within(draftDir(id), 'journal.json');
export const currentHash = (draft: Draft) => draft.revisions[draft.revision];
export const draftSummary = (draft: Draft) => ({ draftId: draft.draftId, revision: draft.revision, candidateHash: currentHash(draft),
  source: draft.project.source, skeleton: draft.skeleton, animation: draft.animation, canUndo: draft.past.length > 0, canRedo: draft.future.length > 0 });

export async function atomicRecord(file: string, value: unknown, context: ToolContext) {
  const absolute = resolveWorkspacePath(file, context), temporary = resolveWorkspacePath(`${file}.${randomUUID()}.tmp`, context);
  await mkdir(path.dirname(absolute), { recursive: true });
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, absolute);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function loadDraft(id: string, context: ToolContext): Promise<Draft> {
  const record = await readJson(draftState(id), context).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HostError('NOT_FOUND', `找不到草稿 ${id}。`, 404);
    throw error;
  }) as Draft;
  if (record.version !== 1 || record.draftId !== id || !hashPattern.test(currentHash(record))) throw new HostError('TARGET_STALE', '草稿 journal 不完整或已变化。', 409);
  return record;
}

function candidateFile(id: string, hash: string) {
  if (!hashPattern.test(hash)) throw new HostError('INVALID_ARGUMENT', '候选哈希无效。');
  return within(draftDir(id), 'candidates', hash + '.json');
}
export async function saveCandidate(id: string, value: Candidate, context: ToolContext) {
  const hash = objectHash(value);
  await atomicRecord(candidateFile(id, hash), value, context);
  return hash;
}
export async function loadCandidate(id: string, hash: string, context: ToolContext) {
  const value = await readJson(candidateFile(id, hash), context) as Candidate;
  if (objectHash(value) !== hash) throw new HostError('TARGET_STALE', '草稿候选哈希已变化。', 409);
  return value;
}

export async function readAuthoringObservation(context: ToolContext): Promise<Observation | null> {
  return readJson(observerFile, context).then(value => value as Observation).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

export async function observeDraft(next: Observation, context: ToolContext) {
  // 观察状态不参与工程事务。并发观察时只接受当前渲染任务的完成通知。
  try {
    await withFileLock(observerFile, context, async () => {
      const last = await readAuthoringObservation(context);
      if (['ready', 'error'].includes(next.status) && (last?.jobId !== next.jobId || last?.draftId !== next.draftId || last?.revision !== next.revision)) return;
      if (last?.draftId === next.draftId && last.revision > next.revision) return;
      await atomicRecord(observerFile, { ...next, preview: next.preview ?? (last?.draftId === next.draftId ? last.preview : undefined) }, context);
    });
  } catch (error) {
    process.stderr.write(`草稿观察状态更新失败：${String(error)}\n`);
  }
}

export async function authoringObservationFrame(id: string, index: number, context: ToolContext) {
  const state = await readAuthoringObservation(context);
  const frame = state?.preview?.id === id && Number.isInteger(index) ? state.preview.frames[index] : undefined;
  if (!frame || !/^previews\/(?:authoring|cache)\//.test(frame) || !frame.endsWith('.png')) throw new HostError('NOT_FOUND', '该草稿预览帧不可用。', 404);
  const bytes = await readFile(resolveWorkspacePath(frame, context));
  return { bytes, revision: state!.preview!.revision };
}
