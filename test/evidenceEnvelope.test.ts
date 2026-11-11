import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceEnvelope, assertEvidenceEnvelope } from '../src/evidenceEnvelope.js';

const version = { sessionId: 's', documentId: 'd', openEpoch: 'e', revision: 3 } as const;

test('Host evidence envelope binds version, hashes and evidence files', () => {
  const envelope = createEvidenceEnvelope({
    projectId: 'p', documentId: version.documentId, versionRef: version,
    sourceHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64),
    buildFingerprint: 'c'.repeat(64), buildLineageFingerprint: 'd'.repeat(64),
    evidence: [{ filePath: 'candidate.json', hash: 'b'.repeat(64) }],
    generatedAt: new Date().toISOString(),
  });
  assert.equal(assertEvidenceEnvelope(envelope, { projectId: 'p', version, sourceHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), buildLineageFingerprint: 'd'.repeat(64) }).fingerprint, envelope.fingerprint);
  const tampered = { ...envelope, candidateHash: 'e'.repeat(64) };
  assert.throws(() => assertEvidenceEnvelope(tampered, { projectId: 'p', version, sourceHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), buildLineageFingerprint: 'd'.repeat(64) }), /指纹不匹配/);
});

test('Host evidence envelope rejects stale document versions and malformed evidence', () => {
  const envelope = createEvidenceEnvelope({
    projectId: null, documentId: version.documentId, versionRef: version,
    sourceHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), buildFingerprint: 'c'.repeat(64), buildLineageFingerprint: 'd'.repeat(64),
    evidence: [{ filePath: 'candidate.json', hash: 'b'.repeat(64) }], generatedAt: new Date().toISOString(),
  });
  assert.throws(() => assertEvidenceEnvelope(envelope, { projectId: null, version: { ...version, revision: 4 }, sourceHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), buildLineageFingerprint: 'd'.repeat(64) }), /版本不匹配/);
  assert.throws(() => assertEvidenceEnvelope({ ...envelope, evidence: [{ filePath: 'candidate.json', hash: 'bad' }] }, { projectId: null, version, sourceHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), buildLineageFingerprint: 'd'.repeat(64) }), /指纹不匹配/);
});
