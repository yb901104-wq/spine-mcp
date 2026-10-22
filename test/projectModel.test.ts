import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProject, loadProject, validateProjectManifest } from '../src/projectModel.js';
import { registerWorkspace, runInWorkspace, getWorkspaceInfo } from '../src/workspaceTools.js';
import type { ProjectManifest } from '../src/projectSchema.js';

const atlas = 'body.png\nsize: 1,1\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n';
async function fixture(fn: (root: string, manifest: ProjectManifest) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spine-project-'));
  const previous = process.env.SPINE_MCP_WORKSPACE;
  process.env.SPINE_MCP_WORKSPACE = root;
  try {
    await mkdir(path.join(root, 'assets'));
    const files = {
      'assets/body.json': { skeleton: { spine: '4.1.24' }, bones: [{ name: 'root' }], slots: [], skins: [{ name: 'default', attachments: {} }] },
      'assets/mapping.json': { version: 1, character: '测试角色', bones: { body: 'root' }, atlasPath: 'assets/body.atlas' },
      'standing.pose.json': { version: 1, kind: 'standing', filePath: 'assets/body.json', mappingPath: 'assets/mapping.json', frame: { time: 0, body: { x: 0, y: 0, rotate: 0 }, targets: {} } },
    };
    for (const [file, value] of Object.entries(files)) await writeFile(path.join(root, file), JSON.stringify(value));
    await writeFile(path.join(root, 'assets/body.atlas'), atlas);
    await writeFile(path.join(root, 'assets/body.png'), Buffer.from([1, 2, 3]));
    const manifest: ProjectManifest = {
      format: 'spine-ai-workspace', schemaVersion: 1, projectId: 'test-project', name: '工程测试',
      characters: { hero: { skeletonPath: 'assets/body.json', mappingPath: 'assets/mapping.json', atlasPath: 'assets/body.atlas', spineVersion: '4.1.24' } },
      documents: [{ path: 'standing.pose.json', kind: 'pose', characterId: 'hero' }],
      references: { posePaths: [], sequencePaths: [] }, artifactRoots: { previews: 'output/previews', reports: 'output/reports' },
      defaults: { characterId: 'hero', documentPath: 'standing.pose.json' },
    };
    await registerWorkspace({ rootPath: root, projectId: manifest.projectId });
    await fn(root, manifest);
  } finally {
    if (previous === undefined) delete process.env.SPINE_MCP_WORKSPACE; else process.env.SPINE_MCP_WORKSPACE = previous;
    await rm(root, { recursive: true, force: true });
  }
}
const json = async (root: string, file: string) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const save = (root: string, file: string, value: unknown) => writeFile(path.join(root, file), JSON.stringify(value));
const context = (root: string) => ({ workspaceRoot: root, projectId: 'test-project' });

test('工程初始化：默认 dryRun 零写入，实际创建、重开与拒绝覆盖', async () => fixture(async (root, manifest) => {
  assert.equal((await loadProject(context(root))).mode, 'legacy');
  const before = await readdir(root, { recursive: true });
  const source = await readFile(path.join(root, 'assets/body.json'));
  const dry = await createProject({ manifest, expectedAbsent: true }, context(root));
  assert.equal(dry.created, false); assert.equal(dry.dryRun, true);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  const created = await createProject({ manifest, expectedAbsent: true, dryRun: false }, context(root));
  assert.equal(created.created, true); assert.equal(created.manifestHash, dry.manifestHash);
  const loaded = await loadProject(context(root));
  assert.equal(loaded.mode, 'managed');
  assert.equal('manifestHash' in loaded && loaded.manifestHash, created.manifestHash);
  assert.equal((await getWorkspaceInfo('test-project')).project.mode, 'managed');
  assert.deepEqual(await readFile(path.join(root, 'assets/body.json')), source);
  await assert.rejects(createProject({ manifest, expectedAbsent: true, dryRun: false }, context(root)), /PROJECT_MANIFEST_EXISTS/);
  assert.equal((await readdir(root)).some(f => f.endsWith('.tmp')), false);
}));

test('工程初始化：schema、身份、重复路径、默认文档与缺失资源负例', async () => fixture(async (root, manifest) => {
  const check = (m: unknown, pattern: RegExp) => assert.rejects(validateProjectManifest(m, context(root)), pattern);
  await check({ ...manifest, workspaceRoot: root }, /PROJECT_MANIFEST_INVALID/);
  await check({ ...manifest, characters: {} }, /PROJECT_MANIFEST_INVALID/);
  await check({ ...manifest, projectId: 'another' }, /PROJECT_BINDING_CONFLICT/);
  await check({ ...manifest, documents: [...manifest.documents, { ...manifest.documents[0], path: './standing.pose.json' }] }, /PROJECT_BINDING_CONFLICT/);
  await check({ ...manifest, defaults: { documentPath: 'assets/body.json' } }, /PROJECT_BINDING_CONFLICT/);
  await check({ ...manifest, documents: [{ ...manifest.documents[0], characterId: 'missing' }] }, /PROJECT_BINDING_CONFLICT/);
  await check({ ...manifest, documents: [{ ...manifest.documents[0], path: 'missing.json' }] }, /DOC_INCOMPLETE/);
  await assert.rejects(createProject({ manifest, expectedAbsent: false }, context(root)), /PROJECT_MANIFEST_INVALID/);
  await assert.rejects(createProject({ manifest, expectedAbsent: true, dryRun: 'false' }, context(root)), /PROJECT_MANIFEST_INVALID/);
}));

test('工程路径：绝对路径、上级目录、符号链接与 atlas 页越界均拒绝', async () => fixture(async (root, manifest) => {
  for (const file of ['../outside.json', 'assets/../body.json', 'C:\\body.json', 'C:body.json', '/tmp/body.json', '\\\\host\\file', 'assets/body.json:stream']) {
    const changed = structuredClone(manifest); changed.characters.hero.skeletonPath = file;
    await assert.rejects(validateProjectManifest(changed, context(root)), /PATH_FORBIDDEN/);
  }
  const outside = await mkdtemp(path.join(os.tmpdir(), 'spine-outside-'));
  try {
    await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const changed = structuredClone(manifest); changed.artifactRoots.reports = 'escape/reports';
    await assert.rejects(validateProjectManifest(changed, context(root)), /PATH_FORBIDDEN/);
    await writeFile(path.join(root, 'assets/body.atlas'), atlas.replace('body.png', '../outside.png'));
    await assert.rejects(validateProjectManifest(manifest, context(root)), /PATH_FORBIDDEN/);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('工程绑定：pose、mapping、版本、皮肤与标准姿态不能互相矛盾', async () => fixture(async (root, manifest) => {
  const pose = await json(root, 'standing.pose.json');
  await save(root, 'standing.pose.json', { ...pose, mappingPath: 'another.json' });
  await assert.rejects(validateProjectManifest(manifest, context(root)), /PROJECT_BINDING_CONFLICT/);
  await save(root, 'standing.pose.json', pose);
  const changed = structuredClone(manifest); changed.characters.hero.spineVersion = '4.2.0';
  await assert.rejects(validateProjectManifest(changed, context(root)), /PROJECT_BINDING_CONFLICT/);
  changed.characters.hero.spineVersion = '4.1.24'; changed.characters.hero.skin = 'unknown';
  await assert.rejects(validateProjectManifest(changed, context(root)), /PROJECT_BINDING_CONFLICT/);
  await save(root, 'assets/body.json', { skeleton: { spine: '4.2.0' }, bones: [{ name: 'root' }] });
  changed.characters.hero.spineVersion = '4.2.0'; delete changed.characters.hero.skin;
  assert.match((await validateProjectManifest(changed, context(root))).warnings.join(), /仅支持 4.1.24/);
}));

test('工程重开：未知 schema 只诊断，损坏清单与丢失依赖不降级 legacy', async () => fixture(async (root, manifest) => {
  await save(root, '.spine-workflow.json', { format: manifest.format, schemaVersion: 99, characters: { hostile: { skeletonPath: '../outside' } } });
  const unsupported = await loadProject(context(root));
  assert.equal(unsupported.mode, 'unsupported');
  await writeFile(path.join(root, '.spine-workflow.json'), '{');
  await assert.rejects(loadProject(context(root)), /PROJECT_MANIFEST_INVALID/);
  await save(root, '.spine-workflow.json', manifest);
  await rm(path.join(root, 'assets/body.png'));
  await assert.rejects(loadProject(context(root)), /DOC_INCOMPLETE/);
}));

test('工作区身份：作用域目录不能误用另一个活动工作区的登记 ID', async () => fixture(async (root) => {
  const other = path.join(root, 'other'); await mkdir(other);
  await registerWorkspace({ rootPath: other, projectId: 'other-project' });
  const scoped = await runInWorkspace('test-project', () => getWorkspaceInfo());
  assert.equal(scoped.projectId, 'test-project'); assert.equal(scoped.project.mode, 'legacy');
}));

test('真实 MCP：初始化 schema、显式登记、dryRun、落盘与只读工程回执', async () => fixture(async (root, manifest) => {
  const client = new Client({ name: 'project-test', version: '1' }, { capabilities: {} });
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: { ...env, SPINE_MCP_WORKSPACE: root } }));
    const tools = await client.listTools();
    const tool = tools.tools.find(t => t.name === 'spine_create_project')!;
    assert.ok(tool); assert.deepEqual(tool.inputSchema.required, ['manifest', 'expectedAbsent']);
    const decode = (r: any) => { assert.equal(r.isError, undefined, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
    const dry = decode(await client.callTool({ name: 'spine_create_project', arguments: { projectId: 'test-project', manifest, expectedAbsent: true } }));
    assert.equal(dry.created, false);
    decode(await client.callTool({ name: 'spine_create_project', arguments: { projectId: 'test-project', manifest, expectedAbsent: true, dryRun: false } }));
    const info = decode(await client.callTool({ name: 'spine_get_workspace_info', arguments: { projectId: 'test-project' } }));
    assert.equal(info.project.mode, 'managed');
    const bad = await client.callTool({ name: 'spine_create_project', arguments: { manifest, expectedAbsent: true, dryRun: false } });
    assert.equal(bad.isError, true);
  } finally { await client.close(); }
}));
