import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TextureAtlas } from '@esotericsoftware/spine-core';
import { resolveWorkspacePath, SUPPORTED_SPINE_VERSION, type ToolContext } from './spineJson.js';
import { getRegisteredWorkspace, getWorkspaceRoot } from './workspaceTools.js';
import { withFileLock } from './jobTools.js';
import { validateMapping, validateMotion } from './motionEngine.js';
import { checkProjectSchema, createProjectSchema, projectManifestSchema, ProjectError, type ProjectManifest } from './projectSchema.js';

export const PROJECT_MANIFEST_PATH = '.spine-workflow.json';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const conflict = (message: string): never => { throw new ProjectError('PROJECT_BINDING_CONFLICT', message); };
const incomplete = (message: string): never => { throw new ProjectError('DOC_INCOMPLETE', message); };

function relativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized.trim() || normalized.includes('\0') || /[:\x00-\x1f]/.test(normalized) ||
      path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new ProjectError('PATH_FORBIDDEN', `必须使用工作区内相对路径：${value}`);
  }
  const result = path.posix.normalize(normalized);
  if (result === '.' || result.split('/').some(segment => /[. ]$/.test(segment))) {
    throw new ProjectError('PATH_FORBIDDEN', `路径不能指向工作区根目录或包含歧义段：${value}`);
  }
  return result;
}

function safePath(value: string, context: ToolContext): string {
  try { return resolveWorkspacePath(relativePath(value), context); }
  catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError('PATH_FORBIDDEN', `路径越界或无法确认工作区边界：${value}。${String(error)}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

function boundContext(context: ToolContext): ToolContext {
  return { ...context, workspaceRoot: context.workspaceRoot ?? getWorkspaceRoot(context.projectId) };
}

/** 只读检查：不运行求解、生成预览、校准或恢复批准。 */
export async function validateProjectManifest(value: unknown, inputContext: ToolContext = {}) {
  checkProjectSchema(value, projectManifestSchema);
  const manifest = structuredClone(value) as ProjectManifest;
  const context = boundContext(inputContext);
  const workspace = getRegisteredWorkspace(context.workspaceRoot!, context.projectId);
  if (!workspace) throw new ProjectError('PROJECT_NOT_REGISTERED', '请先显式调用 spine_register_workspace 登记当前目录。');
  if (manifest.projectId !== workspace.projectId) conflict('manifest.projectId 与当前已登记工作区不一致。');

  // 完成清单全部路径的结构与祖先检查后才读取资源内容。
  const files = new Map<string, string>();
  const normalizeFile = (value: string) => {
    const normalized = relativePath(value), absolute = safePath(normalized, context);
    if (canonical(absolute) === canonical(safePath(PROJECT_MANIFEST_PATH, context))) conflict('工程清单不能作为角色或文档资源。');
    files.set(normalized, absolute);
    return normalized;
  };
  for (const [id, character] of Object.entries(manifest.characters)) {
    if (!id.trim()) conflict('角色 ID 不能为空白。');
    character.skeletonPath = normalizeFile(character.skeletonPath);
    character.atlasPath = normalizeFile(character.atlasPath);
    character.mappingPath = normalizeFile(character.mappingPath);
    if (character.visualRigPath !== undefined) character.visualRigPath = normalizeFile(character.visualRigPath);
  }
  for (const document of manifest.documents) {
    if (!Object.hasOwn(manifest.characters, document.characterId)) conflict(`文档 ${document.path} 引用未知角色 ${document.characterId}。`);
    document.path = normalizeFile(document.path);
    for (const key of ['referencePosePath', 'sequencePath', 'standardPosePath'] as const) {
      if (document[key] !== undefined) document[key] = normalizeFile(document[key]!);
    }
    if (Boolean(document.sequencePath) !== Boolean(document.stageId)) conflict(`文档 ${document.path} 必须同时声明 sequencePath 与 stageId。`);
  }
  manifest.references.posePaths = manifest.references.posePaths.map(normalizeFile);
  manifest.references.sequencePaths = manifest.references.sequencePaths.map(normalizeFile);
  if (manifest.defaults?.documentPath !== undefined) manifest.defaults.documentPath = normalizeFile(manifest.defaults.documentPath);
  for (const key of ['previews', 'reports'] as const) {
    manifest.artifactRoots[key] = relativePath(manifest.artifactRoots[key]);
    const absolute = safePath(manifest.artifactRoots[key], context);
    if (await exists(absolute) && !(await stat(absolute)).isDirectory()) conflict(`artifactRoots.${key} 必须指向目录。`);
    if (canonical(absolute) === canonical(safePath(PROJECT_MANIFEST_PATH, context))) conflict('产物目录不能覆盖工程清单。');
  }

  const identities = new Map<string, string>();
  for (const [file, absolute] of files) {
    try {
      if (!(await stat(absolute)).isFile()) incomplete(`资源不是普通文件：${file}`);
      identities.set(file, canonical(await realpath(absolute)));
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      incomplete(`资源缺失或无法读取：${file}。${String(error)}`);
    }
  }
  const same = (a: string | undefined, b: string | undefined) => a === undefined || b === undefined
    ? a === b : identities.get(a) === identities.get(b);
  const registered = (paths: string[], file: string) => paths.some(p => same(p, file));
  const unique = (paths: string[], label: string) => {
    if (new Set(paths.map(p => identities.get(p))).size !== paths.length) conflict(`${label} 包含规范化后重复的路径。`);
  };
  unique(manifest.documents.map(d => d.path), 'documents');
  unique(manifest.references.posePaths, 'references.posePaths');
  unique(manifest.references.sequencePaths, 'references.sequencePaths');
  const docFor = (file: string) => manifest.documents.find(d => same(d.path, file));
  if (manifest.defaults?.characterId !== undefined && !Object.hasOwn(manifest.characters, manifest.defaults.characterId)) conflict('defaults.characterId 未登记。');
  if (manifest.defaults?.documentPath) {
    const document = docFor(manifest.defaults.documentPath);
    if (!document || manifest.defaults.characterId && document.characterId !== manifest.defaults.characterId) conflict('defaults.documentPath 未登记或与默认角色冲突。');
  }
  for (const document of manifest.documents) {
    if (document.referencePosePath && !registered(manifest.references.posePaths, document.referencePosePath)) conflict(`${document.path} 的参考姿态未登记。`);
    if (document.sequencePath && !registered(manifest.references.sequencePaths, document.sequencePath)) conflict(`${document.path} 的动作级记录未登记。`);
    if (document.standardPosePath) {
      const standard = docFor(document.standardPosePath);
      if (!standard || standard.kind !== 'pose' || standard.characterId !== document.characterId) conflict(`${document.path} 的标准姿态未绑定同一角色。`);
    }
  }

  const rawFiles = new Map<string, Buffer>();
  const jsonFiles = new Map<string, Record<string, any>>();
  const readBytes = async (file: string) => {
    if (!rawFiles.has(file)) {
      // 读取前再次检查真实祖先，拒绝清单校验期间被替换的越界链接。
      try { rawFiles.set(file, await readFile(safePath(file, context))); }
      catch (error) { if (error instanceof ProjectError) throw error; incomplete(`无法读取资源：${file}。${String(error)}`); }
    }
    return rawFiles.get(file)!;
  };
  const json = async (file: string) => {
    if (!jsonFiles.has(file)) {
      try {
        const value = JSON.parse((await readBytes(file)).toString('utf8').replace(/^\uFEFF/, ''));
        if (!value || typeof value !== 'object' || Array.isArray(value)) incomplete(`JSON 资源必须是对象：${file}`);
        jsonFiles.set(file, value);
      } catch (error) { if (error instanceof ProjectError) throw error; incomplete(`JSON 无法解析：${file}。${String(error)}`); }
    }
    return jsonFiles.get(file)!;
  };
  const matchPath = (actual: unknown, expected: string | undefined, label: string, required = false) => {
    if (actual === undefined || actual === null) { if (required) conflict(`${label} 缺少必需绑定。`); return; }
    if (typeof actual !== 'string') conflict(`${label} 必须是路径。`);
    const normalized = relativePath(actual as string);
    safePath(normalized, context);
    // 不读取来自资源内未经工程声明的额外路径。
    if (!expected || !files.has(normalized) || !same(normalized, expected)) conflict(`${label} 与工程声明冲突。`);
  };
  const warnings: string[] = [];
  for (const [id, character] of Object.entries(manifest.characters)) {
    const skeleton = await json(character.skeletonPath), mapping = await json(character.mappingPath);
    if (skeleton.skeleton?.spine !== character.spineVersion) conflict(`角色 ${id} 的 spineVersion 与 skeleton.spine 不一致。`);
    if (!Array.isArray(skeleton.bones) || !skeleton.bones.length) incomplete(`角色 ${id} 缺少骨骼结构。`);
    try { validateMapping(mapping as any, skeleton); }
    catch (error) { incomplete(`角色 ${id} 的 mapping 无效。${String(error)}`); }
    matchPath(mapping.atlasPath, character.atlasPath, `${id}.mapping.atlasPath`);
    if (mapping.skin !== undefined && mapping.skin !== (character.skin ?? '')) conflict(`角色 ${id} 的 mapping.skin 与工程声明冲突。`);
    if (character.skin) {
      const skins = skeleton.skins;
      if (!(Array.isArray(skins) ? skins.some(s => s.name === character.skin) : skins && Object.hasOwn(skins, character.skin))) conflict(`角色 ${id} 的皮肤不存在：${character.skin}`);
    }
    if (character.visualRigPath) {
      const rig = await json(character.visualRigPath);
      matchPath(rig.filePath, character.skeletonPath, `${id}.visualRig.filePath`, true);
      matchPath(rig.mappingPath, character.mappingPath, `${id}.visualRig.mappingPath`, true);
      if (rig.skin !== undefined && rig.skin !== (character.skin ?? '')) conflict(`角色 ${id} 的 visualRig.skin 冲突。`);
    }
    if (character.spineVersion !== SUPPORTED_SPINE_VERSION) warnings.push(`角色 ${id} 使用 ${character.spineVersion}；V1 动画写入仅支持 ${SUPPORTED_SPINE_VERSION}。`);
    let pages: string[];
    try { pages = new TextureAtlas((await readBytes(character.atlasPath)).toString('utf8')).pages.map(p => p.name); }
    catch (error) { if (error instanceof ProjectError) throw error; incomplete(`角色 ${id} 的 atlas 无法解析。${String(error)}`); }
    if (!pages!.length) incomplete(`角色 ${id} 的 atlas 缺少纹理页。`);
    const textures = pages!.map(page => {
      // 页名先独立检查，避免 join 将绝对路径或 ../ 消解成看似合法的路径。
      const name = relativePath(page);
      return relativePath(path.posix.join(path.posix.dirname(character.atlasPath), name));
    });
    for (const texture of textures) safePath(texture, context);
    for (const texture of textures) await readBytes(texture);
  }
  for (const file of [...manifest.references.posePaths, ...manifest.references.sequencePaths]) await json(file);
  for (const document of manifest.documents) {
    const value = await json(document.path), character = manifest.characters[document.characterId];
    if (document.kind === 'skeleton') {
      if (!same(document.path, character.skeletonPath)) conflict(`骨架文档 ${document.path} 与角色骨架不一致。`);
    } else if (document.kind === 'pose') {
      if (value.version !== 1 || !['standing', 'action'].includes(value.kind) || !value.frame || typeof value.frame !== 'object') incomplete(`姿态文档结构无效：${document.path}`);
      matchPath(value.filePath, character.skeletonPath, `${document.path}.filePath`, true);
      matchPath(value.mappingPath, character.mappingPath, `${document.path}.mappingPath`, true);
      matchPath(value.visualRigPath, character.visualRigPath, `${document.path}.visualRigPath`);
      for (const key of ['referencePosePath', 'sequencePath', 'standardPosePath'] as const) {
        matchPath(value[key], document[key], `${document.path}.${key}`);
        if (document[key] && !value[key]) conflict(`${document.path}.${key} 与工程声明缺项冲突。`);
      }
      if ((value.stageId ?? undefined) !== document.stageId) conflict(`${document.path}.stageId 与工程声明不一致。`);
    } else {
      try { validateMotion(value as any); }
      catch (error) { incomplete(`动作文档结构无效：${document.path}。${String(error)}`); }
      if (value.poseWorkflow) {
        matchPath(value.poseWorkflow.standardPosePath, document.standardPosePath, `${document.path}.poseWorkflow.standardPosePath`, true);
        for (const pose of value.poseWorkflow.keyPoses ?? []) {
          const normalized = typeof pose.posePath === 'string' ? relativePath(pose.posePath) : incomplete('motion 关键姿态缺少 posePath。');
          const target = docFor(normalized);
          if (!target || target.kind !== 'pose' || target.characterId !== document.characterId || target.stageId !== pose.stageId) conflict(`${document.path} 的关键姿态或阶段未绑定同一角色。`);
        }
      }
    }
    if (document.sequencePath) {
      const sequence = await json(document.sequencePath);
      const stages = Array.isArray(sequence.stages) ? sequence.stages : [];
      const matches = stages.filter(s => s.stageId === document.stageId);
      if (matches.length !== 1) conflict(`${document.path} 的阶段在动作记录中缺失或重复。`);
      matchPath(matches[0].referencePosePath, document.referencePosePath, `${document.path}.sequence.stage.referencePosePath`, true);
      matchPath(sequence.visualRigPath, character.visualRigPath, `${document.path}.sequence.visualRigPath`);
    }
  }
  for (const root of Object.values(manifest.artifactRoots)) {
    const absolute = canonical(safePath(root, context));
    for (const file of rawFiles.keys()) {
      const input = canonical(safePath(file, context));
      if (input === absolute || input.startsWith(absolute + path.sep)) conflict(`产物目录 ${root} 覆盖输入资源 ${file}。`);
    }
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  return {
    manifest, manifestHash: hash(serialized), serialized, warnings,
    dependencies: [...rawFiles].map(([filePath, bytes]) => ({ filePath, hash: hash(bytes) })),
  };
}

export async function createProject(args: unknown, inputContext: ToolContext = {}) {
  checkProjectSchema(args, createProjectSchema, 'arguments');
  const request = args as { manifest: ProjectManifest; expectedAbsent: true; dryRun?: boolean; projectId?: string };
  const context = boundContext({ ...inputContext, projectId: request.projectId ?? inputContext.projectId });
  const target = safePath(PROJECT_MANIFEST_PATH, context);
  const ensureAbsent = async () => {
    if (await exists(target)) throw new ProjectError('PROJECT_MANIFEST_EXISTS', '根 manifest 已存在；初始化工具禁止覆盖，请只读检查现有工程。');
  };
  await ensureAbsent();
  const candidate = await validateProjectManifest(request.manifest, context);
  const result = {
    ok: true, dryRun: request.dryRun !== false, created: false, manifestPath: PROJECT_MANIFEST_PATH,
    manifest: candidate.manifest, manifestHash: candidate.manifestHash, dependencies: candidate.dependencies,
    warnings: candidate.warnings, message: '已验证工程结构与依赖绑定；这不代表角色校准、姿态审查或动画写入已通过。',
  };
  if (result.dryRun) return result;
  return withFileLock(PROJECT_MANIFEST_PATH, context, async () => {
    await ensureAbsent();
    const current = await validateProjectManifest(request.manifest, context);
    if (JSON.stringify(current.dependencies) !== JSON.stringify(candidate.dependencies)) conflict('初始化期间依赖发生变化，请重新 dryRun。');
    const temp = safePath(`.spine-workflow.${randomUUID()}.tmp`, context);
    try {
      const handle = await open(temp, 'wx');
      try { await handle.writeFile(current.serialized, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      safePath(PROJECT_MANIFEST_PATH, context);
      // 同卷硬链接发布完整文件，EEXIST 永不覆盖。
      await link(temp, target);
    } catch (error: any) {
      if (error.code === 'EEXIST') throw new ProjectError('PROJECT_MANIFEST_EXISTS', '初始化期间根 manifest 已被创建，拒绝覆盖。');
      throw error;
    } finally { await unlink(temp).catch(() => {}); }
    return { ...result, created: true, message: '已原子初始化工程清单；角色资源未修改，未恢复任何审查或写入授权。' };
  });
}

export async function loadProject(inputContext: ToolContext = {}) {
  const context = boundContext(inputContext);
  const target = safePath(PROJECT_MANIFEST_PATH, context);
  if (!await exists(target)) return { mode: 'legacy' as const, manifestPath: PROJECT_MANIFEST_PATH, readOnly: true, message: '尚无工程清单；沿用显式路径工具，不扫描或生成工程。' };
  let value: any, raw: Buffer;
  try { raw = await readFile(target); value = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new ProjectError('PROJECT_MANIFEST_INVALID', `根 manifest 无法读取或解析。${String(error)}`); }
  if (value?.format === 'spine-ai-workspace' && value.schemaVersion !== 1) return {
    mode: 'unsupported' as const, manifestPath: PROJECT_MANIFEST_PATH, readOnly: true,
    code: 'PROJECT_SCHEMA_UNSUPPORTED', schemaVersion: value.schemaVersion ?? null,
    message: '工程 schemaVersion 未支持；仅报告诊断，不读取其资源或降级重写。',
  };
  const checked = await validateProjectManifest(value, context);
  if (hash(await readFile(safePath(PROJECT_MANIFEST_PATH, context))) !== hash(raw!)) conflict('读取期间工程清单发生变化，请重试。');
  return {
    mode: 'managed' as const, manifestPath: PROJECT_MANIFEST_PATH, readOnly: true,
    manifest: checked.manifest, manifestHash: hash(raw!),
    dependencies: checked.dependencies, warnings: checked.warnings,
    message: '只读加载工程与资源绑定；不求解、不批准、不授予动画写入能力。',
  };
}
