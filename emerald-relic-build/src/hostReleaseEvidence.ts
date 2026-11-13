import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostError, objectHash, strictHash } from './hostContracts.js';
import { loadProject } from './projectModel.js';
import { resolveWorkspacePath, type ToolContext } from './spineJson.js';

export const OBSERVATION_ROOT = '.spine-mcp/observation';
export const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
export const REVIEW_CHECKS = ['usageCoverage', 'gapsAndRestarts', 'staleIncidents', 'regressionAndRecovery', 'performance', 'playerAndVisualScope'] as const;
export type ProtectFile = (file: string) => Promise<boolean>;
export interface SignedEvidence { payload: any; hash: string; signature: string }

export function relativeFile(file: string, context: ToolContext) {
  if (typeof file !== 'string' || !file || path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || /[:\x00-\x1f]/.test(file) || file.replace(/\\/g, '/').split('/').includes('..'))
    throw new HostError('PATH_FORBIDDEN', '证据必须使用工作区内相对路径。', 403);
  return resolveWorkspacePath(file, context);
}
export async function writeEvidenceFile(file: string, value: unknown, context: ToolContext) {
  const absolute = relativeFile(file, context); await mkdir(path.dirname(absolute), { recursive: true });
  const handle = await open(absolute, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
}
export async function releaseBinding(context: ToolContext) {
  const project = await loadProject(context);
  if (project.mode !== 'managed') throw new HostError('PROJECT_MANIFEST_REQUIRED', '观察和启用需要已登记的受管工程。', 409);
  return { workspace: await realpath(context.workspaceRoot!), projectId: context.projectId ?? null, manifestHash: project.manifestHash };
}
/** 绑定实际执行目录；源码与编译版本不同，不能相互冒充。没有跨调用指纹缓存。 */
export async function hostBuildFingerprint() {
  const directory = path.dirname(fileURLToPath(import.meta.url)), extension = path.extname(fileURLToPath(import.meta.url));
  const root = path.resolve(directory, '..'), files: Array<{ file: string; hash: string }> = [];
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new HostError('BUILD_UNVERIFIED', '构建目录不能包含链接。', 409);
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && path.extname(file) === extension) files.push({ file: path.relative(root, file).replace(/\\/g, '/'), hash: strictHash(await readFile(file)) });
    }
  }
  await visit(directory);
  for (const file of ['package.json', 'package-lock.json', 'preview/host.html', 'node_modules/@esotericsoftware/spine-player/dist/iife/spine-player.min.js'])
    files.push({ file, hash: strictHash(await readFile(path.join(root, file))) });
  files.sort((a, b) => a.file.localeCompare(b.file));
  const identity = { schema: 1, node: process.version, platform: process.platform, arch: process.arch, files };
  return { ...identity, hash: objectHash(identity) };
}

export class ObservationAuthority {
  private constructor(private readonly privatePem: string, readonly publicPem: string) {}
  static async load(context: ToolContext, protect: ProtectFile, create = false) {
    const privatePath = relativeFile(`${OBSERVATION_ROOT}/authority.private.json`, context);
    let data: any;
    try { data = JSON.parse(await readFile(privatePath, 'utf8')); }
    catch (error: any) {
      if (error.code !== 'ENOENT' || !create) throw new HostError('EVIDENCE_INVALID', '观察签名密钥缺失或无法解析。', 409);
      const pair = generateKeyPairSync('ed25519');
      data = { format: 1, privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
      await mkdir(path.dirname(privatePath), { recursive: true });
      const handle = await open(privatePath, 'wx', 0o600);
      try {
        if (!await protect(privatePath)) throw new HostError('CONTROL_REQUIRED', '签名私钥保护失败；未写入密钥。', 403);
        await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync();
      } finally { await handle.close(); }
    }
    if (!await protect(privatePath)) throw new HostError('CONTROL_REQUIRED', '观察签名私钥保护未通过，不能记录或批准。', 403);
    try {
      if (data.format !== 1 || createPublicKey(createPrivateKey(data.privatePem)).export({ type: 'spki', format: 'pem' }) !== data.publicPem) throw Error('不匹配');
    } catch { throw new HostError('EVIDENCE_INVALID', '观察签名密钥不匹配或无法核验。', 409); }
    const publicPath = `${OBSERVATION_ROOT}/authority.public.json`;
    try {
      const old = JSON.parse(await readFile(relativeFile(publicPath, context), 'utf8'));
      if (old.publicPem !== data.publicPem) throw new HostError('EVIDENCE_INVALID', '观察公钥已变化。', 409);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; await writeEvidenceFile(publicPath, { format: 1, publicPem: data.publicPem }, context); }
    return new ObservationAuthority(data.privatePem, data.publicPem);
  }
  seal(payload: any): SignedEvidence {
    const hash = objectHash(payload);
    return { payload, hash, signature: sign(null, Buffer.from(hash), this.privatePem).toString('base64') };
  }
}
export async function observationPublicKey(context: ToolContext) {
  const data = JSON.parse(await readFile(relativeFile(`${OBSERVATION_ROOT}/authority.public.json`, context), 'utf8'));
  if (data.format !== 1 || typeof data.publicPem !== 'string') throw new HostError('EVIDENCE_INVALID', '观察公钥无效。', 409);
  return data.publicPem as string;
}
export function verifyEvidence(value: SignedEvidence, publicPem: string) {
  if (!value || value.hash !== objectHash(value.payload) || !verify(null, Buffer.from(value.hash), publicPem, Buffer.from(value.signature ?? '', 'base64')))
    throw new HostError('EVIDENCE_INVALID', '证据哈希或签名不通过。', 409);
  return value.payload;
}
export async function readSignedFile(file: string, context: ToolContext, publicPem: string) {
  const bytes = await readFile(relativeFile(file, context));
  const envelope = JSON.parse(bytes.toString('utf8')) as SignedEvidence;
  return { envelope, payload: verifyEvidence(envelope, publicPem), fileHash: strictHash(bytes) };
}
export const newEvidencePath = (kind: 'reports' | 'reviews') => `${OBSERVATION_ROOT}/${kind}/${randomUUID()}.json`;
