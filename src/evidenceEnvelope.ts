import { objectHash, type VersionRef } from './hostContracts.js';

/** Host 候选和审查证据的统一可复验绑定对象。它不授予写入权限。 */
export interface EvidenceEnvelope {
  version: 1;
  kind: 'host-animation';
  projectId: string | null;
  documentId: string;
  versionRef: VersionRef;
  sourceHash: string;
  candidateHash: string;
  buildFingerprint: string;
  buildLineageFingerprint: string;
  evidence: Array<{ filePath: string; hash: string }>;
  retargetManifestFingerprint?: string;
  generatedAt: string;
  fingerprint: string;
}

export function createEvidenceEnvelope(input: Omit<EvidenceEnvelope, 'version' | 'kind' | 'fingerprint'>): EvidenceEnvelope {
  const base = { version: 1 as const, kind: 'host-animation' as const, ...input };
  return { ...base, fingerprint: objectHash(base) };
}

export function assertEvidenceEnvelope(envelope: any, expected: {
  projectId?: string | null;
  version: VersionRef;
  sourceHash: string;
  candidateHash: string;
  buildFingerprint?: string;
  buildLineageFingerprint?: string;
  retargetManifestFingerprint?: string;
}) {
  if (!envelope || envelope.version !== 1 || envelope.kind !== 'host-animation' || typeof envelope.fingerprint !== 'string') throw new Error('证据 envelope 缺失或版本不受支持。');
  const { fingerprint, ...base } = envelope;
  if (objectHash(base) !== fingerprint) throw new Error('证据 envelope 指纹不匹配。');
  if (expected.projectId !== undefined && envelope.projectId !== expected.projectId) throw new Error('证据 envelope 工程绑定不匹配。');
  if (objectHash(envelope.versionRef) !== objectHash(expected.version)) throw new Error('证据 envelope 文档版本不匹配。');
  if (envelope.sourceHash !== expected.sourceHash || envelope.candidateHash !== expected.candidateHash) throw new Error('证据 envelope 候选或源文件哈希不匹配。');
  if (expected.buildFingerprint !== undefined && envelope.buildFingerprint !== expected.buildFingerprint) throw new Error('证据 envelope 构建指纹不匹配。');
  if (expected.buildLineageFingerprint !== undefined && envelope.buildLineageFingerprint !== expected.buildLineageFingerprint) throw new Error(`证据 envelope 构建 lineage 不匹配（证据=${envelope.buildLineageFingerprint}，当前=${expected.buildLineageFingerprint}）。`);
  if (expected.retargetManifestFingerprint !== undefined && envelope.retargetManifestFingerprint !== expected.retargetManifestFingerprint) throw new Error('证据 envelope retarget 来源指纹不匹配。');
  if (!Array.isArray(envelope.evidence) || envelope.evidence.some((item: any) => typeof item?.filePath !== 'string' || !/^[0-9a-f]{64}$/.test(item?.hash ?? ''))) throw new Error('证据 envelope 文件清单无效。');
  return envelope as EvidenceEnvelope;
}
