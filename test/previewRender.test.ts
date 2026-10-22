import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, cp, readFile, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { createPreviewManifest, renderContactSheet, renderAnimationGif, renderAnimationFrames, comparePreviewReports } from '../src/previewRenderTools.js';
import { analyzeReferenceGif, extractReferenceKeyframes } from '../src/referenceTools.js';
import { getWorkspaceInfo, registerWorkspace, selectWorkspace, runInWorkspace } from '../src/workspaceTools.js';
import { resolveWorkspacePath } from '../src/spineJson.js';
import { withFileLock } from '../src/jobTools.js';
import { adjustMotion } from '../src/motionAdjustmentTools.js';
const root = process.cwd();

test('PNG/GIF rendering, cache, fixed camera, reference decoding and comparison', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'spine-preview-'));
  try {
    await cp(path.join(root, 'preview'), path.join(workspace, 'preview'), { recursive: true });
    await cp(path.join(root, 'example-json'), path.join(workspace, 'example-json'), { recursive: true });
    const context = { workspaceRoot: workspace }, args = { filePath: 'example-json/skeleton-4.1.json', atlasPath: 'preview/xiaoren.atlas', animation: 'walktest2', frames: 4, width: 128, height: 128 };
    const manifest = await createPreviewManifest(args, context); assert.equal(manifest.images.length, 1);
    const result = await renderContactSheet(args, context); assert.equal(result.ok, true); assert.match(result.contactSheet, /\.png$/); assert.equal(result.frames.length, 4);
    const png = await readFile(resolveWorkspacePath(result.frames[0], context)); assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const cached = await renderAnimationFrames(args, context); assert.equal(cached.cached, true); assert.notEqual(cached.jobId, result.jobId);
    const gif = await renderAnimationGif(args, context); assert.equal((await readFile(resolveWorkspacePath(gif.gifPath, context))).subarray(0, 6).toString(), 'GIF89a');
    const ref = await analyzeReferenceGif({ filePath: gif.gifPath }, context); assert.equal(ref.frames.length, 4); assert.ok(ref.duration > 0);
    assert.ok(Math.abs(ref.duration - result.duration) <= .01);
    assert.ok((await extractReferenceKeyframes({ manifestPath: ref.manifestPath }, context)).keyframes.length > 0);
    const cmp = await comparePreviewReports({ firstManifestPath: result.manifestPath, secondManifestPath: cached.manifestPath }, context); assert.equal(cmp.durationDelta, 0);
    const refCmp = await comparePreviewReports({ firstManifestPath: result.manifestPath, secondManifestPath: ref.manifestPath }, context); assert.ok(refCmp.comparisonSheet);
    await assert.rejects(() => renderAnimationFrames({ ...args, outputDir: '../escape' }, context), /workspace root/);
    const lockDir = resolveWorkspacePath(`previews/cache/${manifest.cacheKey}`, context); await writeFile(path.join(lockDir, 'render.lock'), 'test');
    await assert.rejects(() => renderAnimationFrames(args, context), /正在渲染/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('workspace registry isolates concurrent scopes and rejects unknown selection', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'spine-workspace-')), previous = process.env.SPINE_MCP_WORKSPACE;
  process.env.SPINE_MCP_WORKSPACE = workspace;
  try {
    await registerWorkspace({ rootPath: root, projectId: 'test-project' });
    await registerWorkspace({ rootPath: workspace, projectId: 'second-project' });
    assert.equal((await selectWorkspace('test-project')).activeProjectId, 'test-project');
    assert.equal((await getWorkspaceInfo('test-project')).workspaceRoot, root);
    await assert.rejects(() => selectWorkspace('missing-project'), /未登记/);
    const paths = await Promise.all([runInWorkspace('test-project', async () => { await new Promise(r => setTimeout(r, 5)); return resolveWorkspacePath('foo.json'); }), runInWorkspace('second-project', async () => resolveWorkspacePath('foo.json'))]);
    assert.equal(paths[0], path.join(root, 'foo.json')); assert.equal(paths[1], path.join(workspace, 'foo.json'));
  } finally { if (previous === undefined) delete process.env.SPINE_MCP_WORKSPACE; else process.env.SPINE_MCP_WORKSPACE = previous; await rm(workspace, { recursive: true, force: true }); }
});
test('file locks and junction boundaries reject concurrent writes and escapes', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'spine-lock-')), outside = await mkdtemp(path.join(os.tmpdir(), 'spine-outside-')), context = { workspaceRoot: workspace };
  try {
    let release!: () => void, entered!: () => void; const wait = new Promise<void>(r=>release=r), ready = new Promise<void>(r=>entered=r);
    const first = withFileLock('character.json', context, async()=>{ entered(); await wait; }); await ready;
    await assert.rejects(()=>withFileLock('character.json',context,async()=>null),/其他任务/); release(); await first;
    // 业务异常必须释放锁，锁记录里应带 pid，后续写入可再次获得锁
    await assert.rejects(()=>withFileLock('character.json',context,async()=>{ throw new Error('业务失败'); }),/业务失败/);
    assert.equal(await withFileLock('character.json',context,async()=>'再次进入'),'再次进入');
    const lockDir = path.join(workspace,'.spine-mcp','locks'), leftovers = await readdir(lockDir).catch(()=>[] as string[]);
    assert.deepEqual(leftovers, []);
    await symlink(outside, path.join(workspace,'escape'), process.platform==='win32' ? 'junction' : 'dir');
    assert.throws(()=>resolveWorkspacePath('escape/character.json',context),/越过/);
  } finally { await rm(workspace,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
});
test('motion adjustments preserve loops and source while changing semantic targets', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(),'spine-adjust-')), context = {workspaceRoot:workspace};
  try {
    const first = {time:0,body:{x:0,y:0,rotate:0},targets:{leftFoot:{x:0,y:0,contact:true}}}, motion={name:'walk',version:2,duration:1,loop:true,coordinateSystem:'normalizedSkeleton',frames:[first,{...structuredClone(first),time:.5},{...structuredClone(first),time:1}]};
    await writeFile(path.join(workspace,'motion.json'),JSON.stringify(motion));
    const r=await adjustMotion('spine_set_foot_target',{motionPath:'motion.json',outputMotionPath:'adjusted.json',side:'left',time:0,x:.1,dryRun:false},context);
    assert.equal(r.motion.frames![0].targets.leftFoot!.x,.1);assert.equal(r.motion.frames!.at(-1)!.targets.leftFoot!.x,.1);
    assert.deepEqual(JSON.parse(await readFile(path.join(workspace,'motion.json'),'utf8')),motion);
  } finally {await rm(workspace,{recursive:true,force:true});}
});
