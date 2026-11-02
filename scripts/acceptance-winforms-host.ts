// 真实 .NET / WebView2 集成自检；默认合成夹具，--real-c1 使用已验收站姿的隔离副本。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { strictHash } from '../src/hostContracts.js';
import { HostClient } from '../src/hostClient.js';
import { registerWorkspace } from '../src/workspaceTools.js';
import { createProject } from '../src/projectModel.js';
import { requireReviewedPose,renderPoseComparison,reviewPose,poseChecks } from '../src/poseWorkflow.js';
import {fullAnimationChecks} from '../src/hostAnimationSession.js';
import { resolveWorkspacePath } from '../src/spineJson.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const realAnimationCandidate=process.argv.includes('--real-animation-candidate');
const real = process.argv.includes('--real-c1')||realAnimationCandidate;
const benchmark = process.argv.includes('--benchmark-host');
const playback = process.argv.find(arg => arg.startsWith('--playback='))?.slice('--playback='.length);
const commandSmoke = process.argv.includes('--pose-commands');
const animationCandidate = process.argv.includes('--animation-candidate')||realAnimationCandidate;
assert.ok(!animationCandidate||!playback&&(!real||realAnimationCandidate)&&!benchmark&&!commandSmoke,'完整动画候选与其它自检分别运行');
assert.ok(!playback || ['skeleton','motion','setup'].includes(playback), 'playback 仅支持 skeleton/motion/setup');
assert.ok(!playback || !real && !benchmark, '动画观察自检与真实 C1/性能自检分别运行');
assert.ok(!commandSmoke || !playback&&!real&&!benchmark, '姿态命令自检单独使用隔离夹具运行');
const captureCheckpoints = real || !!playback || commandSmoke || animationCandidate;
const artifactDir = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'D:/AI_cc/spine test/host-desktop-acceptance', runId);
await mkdir(artifactDir, { recursive: true });
const output = `docs/plans/host-winforms-${runId}.json`;
const report: any = { startedAt: new Date().toISOString(), artifactDir, scope: real ? '实际 WinForms/WebView2、只读 Host、已验收 npc1 无参考站姿隔离副本；通过 MCP 采集当前 player，未新增动作批准或编辑器导入。' : '实际 WinForms/WebView2、只读 Host、合成 region 夹具；不是真实美术动作或 MCP 审查截图验收。' };
const posePath = real ? 'poses/standing-hand-angle.json' : 'a.pose.json';
const candidateAnimationName=realAnimationCandidate?'host_c2_standing_readback':'idle';
const view = animationCandidate?{animation:candidateAnimationName,time:.15}:playback ? { animation: playback === 'setup' ? null : playback === 'motion' ? 'wave' : 'move', time: playback === 'setup' ? 0 : .5 } : null;
const playbackAnimations = { original: {}, move: { bones: { body: { rotate: [{value:0},{time:1,value:20}] } }, slots: {bodySlot:{attachment:[{name:'body'},{time:.5,name:'alternate'}]}}, drawOrder:[{time:.5,offsets:[{slot:'bodySlot',offset:1}]}] } };
async function withPlaybackFixture(fn: Parameters<typeof withHostFixture>[0]) {
  await withHostFixture(async fixture => {
    const pose = JSON.parse(await readFile(path.join(fixture.root,posePath),'utf8'));
    const motion = {version:2,name:'wave',duration:1,loop:false,coordinateSystem:'normalizedSkeleton',groundY:0,
      frames:[{...pose.frame,time:0},{...pose.frame,time:.5,head:10,presentation:{attachments:{bodySlot:'alternate'},drawOrder:['accentSlot','bodySlot']}},{...pose.frame,time:1,head:0}]};
    await writeFile(path.join(fixture.root,'wave.motion.json'),JSON.stringify(motion));
    fixture.manifest.documents.push({path:'wave.motion.json',kind:'motion',characterId:'hero'});
    await writeFile(path.join(fixture.root,'.spine-workflow.json'),JSON.stringify(fixture.manifest));
    const inputPaths=['body.json','body.atlas','body.png','mapping.json','wave.motion.json'];
    report.inputHashes=Object.fromEntries(await Promise.all(inputPaths.map(async file=>[file,strictHash(await readFile(path.join(fixture.root,file)))])));
    report.scope='实际 WinForms/WebView2、C2 开发 profile、只读动画观察；合成 region 夹具，不代表真实角色动作、完整动画数值或编辑器导入验收。';
    report.kind=playback==='motion'?'motion':'skeleton';report.view=view;
    await fn(fixture);
    for(const [file,hash] of Object.entries(report.inputHashes))assert.equal(strictHash(await readFile(path.join(fixture.root,file))),hash);
    report.allInputsUnchanged=true;
  },{neutralSetup:true,animations:playbackAnimations});
}
async function withRealFixture(fn: (fixture: { root: string; context: { workspaceRoot: string; projectId: string } }) => Promise<void>) {
  const source = path.resolve('D:/AI_cc/spine test/host-acceptance/2026-10-22T02-18-08-219Z');
  const root = path.join(artifactDir, 'workspace'), context = { workspaceRoot: root, projectId: 'npc1-host-c1-acceptance' };
  await mkdir(root, { recursive: true });
  const hashes: Record<string, string> = {};
  async function copyInputs(directory: string) {
    for (const entry of await readdir(resolveWorkspacePath(directory, { workspaceRoot: source }), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `输入不得经过链接：${relative}`);
      const from = resolveWorkspacePath(relative, { workspaceRoot: source }), to = resolveWorkspacePath(relative, context);
      if (entry.isDirectory()) { await mkdir(to, { recursive: true }); await copyInputs(relative); }
      else if (entry.isFile()) { await mkdir(path.dirname(to), { recursive: true }); await copyFile(from, to); hashes[relative] = strictHash(await readFile(from)); }
    }
  }
  for (const directory of ['目标', 'poses', 'previews', 'output']) await copyInputs(directory);
  process.env.SPINE_MCP_WORKSPACE = root; process.env.SPINE_MCP_REGISTRY_ROOT = root;
  await registerWorkspace({ rootPath: root, projectId: context.projectId });
  const manifest = JSON.parse(await readFile(path.join(source, '.spine-workflow.json'), 'utf8'));
  manifest.documents.push({ path: posePath, kind: 'pose', characterId: 'npc1' });
  await createProject({ manifest, expectedAbsent: true, dryRun: false }, context);
  await requireReviewedPose(posePath, context);
  report.sourceWorkspace = source; report.inputHashes = hashes;
  await fn({ root, context });
  for (const [relative, hash] of Object.entries(hashes)) {
    assert.equal(strictHash(await readFile(resolveWorkspacePath(relative, { workspaceRoot: source }))), hash, `原输入变化：${relative}`);
    assert.equal(strictHash(await readFile(resolveWorkspacePath(relative, context))), hash, `副本变化：${relative}`);
  }
  await requireReviewedPose(posePath, context);
  report.allInputsUnchanged = true; report.savedPoseReverified = true;
}
async function withCommandFixture(fn: Parameters<typeof withHostFixture>[0]) {
  await withHostFixture(async fixture=>{
    const files=['body.json','body.atlas','body.png','mapping.json','a.pose.json'];
    report.inputHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,strictHash(await readFile(path.join(fixture.root,file)))])));
    report.scope='实际 WinForms/WebView2、隔离 C2 高层姿态命令；编辑当前内存后释放测试 Writer，以观察模式采集实际 player，不保存角色或姿态源文件，不批准真实美术。';
    report.kind='pose';report.view=null;
    await fn(fixture);
    for(const [file,hash] of Object.entries(report.inputHashes))assert.equal(strictHash(await readFile(path.join(fixture.root,file))),hash);
    report.allInputsUnchanged=true;
  },{neutralSetup:true});
}
async function availablePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
try {
  await (real ? withRealFixture : playback ? withPlaybackFixture : commandSmoke ? withCommandFixture : withHostFixture)(async ({ root, context }) => {
    const sourcePath = path.join(root, real ? '目标/npc1.json' : 'body.json');
    const original = await readFile(sourcePath);
    const host = await startHostServer(context, { captureTimeoutMs: 12000, writeEnabled:commandSmoke, ...playback||commandSmoke||animationCandidate ? {developmentProfile:'c2-pose' as const} : {} });
    let frameRequests = 0;
    host.server.on('request', request => { if (new URL(request.url!, host.endpoint).pathname === '/api/frame') frameRequests++; });
    let mcp: Client | undefined;
    let preview: ReturnType<typeof spawn> | undefined, desktop: ReturnType<typeof spawn> | undefined;
    try {
      await host.store.open({ path: playback ? playback==='motion'?'wave.motion.json':'body.json' : posePath, ...animationCandidate?{}:view ?? {} });
      if(animationCandidate){
        if(realAnimationCandidate)await requireReviewedPose(posePath,context);
        else{const sheet=await renderPoseComparison({posePaths:[posePath]},context);
        await reviewPose({posePath,manifestPath:sheet.manifestPath,decision:'approved',reviewedBy:'桌面事务协议验证桩',reason:'仅验证合成完整动画链路，不作为真实美术验收',checks:poseChecks,dryRun:false},context);}
        await host.store.enableWriting();
        const adapter=new HostClient(context),opened=await adapter.open({path:posePath,reload:true,expectedRevision:host.store.active!.version});
        await adapter.rpc('/api/pin',{expectedRevision:opened.version});
        const staged=await adapter.assetCommand('spine_build_motion_from_poses',{expectedRevision:opened.version,standardPosePath:posePath,keyPoses:[{posePath,time:0,stageId:'start'},{posePath,time:.3,stageId:'end'}],motionPath:'idle.motion.json',name:candidateAnimationName,duration:.3,loop:true,dryRun:false});
        await adapter.commit({expectedRevision:opened.version,intent:'asset',assetCandidateHash:staged.candidateHash,outputPath:staged.outputPath,requestId:'native-motion',dryRun:false});
        const motion=await adapter.open({path:staged.outputPath,expectedRevision:opened.version,...view!,recheck:true});
        const character=host.store.project!.mode==='managed'?host.store.project!.manifest.characters[host.store.active!.characterId!]:null;assert.ok(character);
        const exact=await adapter.animationCandidate({expectedRevision:motion.version,filePath:character.skeletonPath,mappingPath:character.mappingPath,motionPath:staged.outputPath,animation:candidateAnimationName});
        const {__imageData:_image,...metadata}=exact;report.animationCandidate=metadata;
        assert.equal(report.animationCandidate.readyForAnimationReview,true);report.kind='motion';report.view=view;
        report.scope=realAnimationCandidate?'实际 npc1 已批准站姿的隔离副本、C2 精确固定站姿动画候选与当前真实 player；不制作新动作、不新增完整动画批准或写入角色源，不代表第二角色或编辑器导入。':'实际 WinForms/WebView2、隔离 C2 精确拟合动画、当前 player 核验、完整审查及源事务；合成协议夹具，不代表真实美术或 Spine 编辑器导入。';
        await host.store.disableWriting();report.testWriterReleased=true;
      }
      if(commandSmoke){
        const adapter=new HostClient(context);await adapter.state();await adapter.rpc('/api/pin',{expectedRevision:host.store.active!.version});
        const cases:[string,any][]=[['spine_adjust_pose',{patch:{frame:{body:{rotate:2},head:5,presentation:{attachments:{bodySlot:'alternate'},drawOrder:['accentSlot','bodySlot']}}}}],['spine_set_pose_channel',{name:'torso',rotate:1}],['spine_set_pose_target',{role:'leftHand',angle:-85}],['spine_batch_pose_ops',{ops:[{op:'channel',name:'torso',rotate:3},{op:'target',role:'rightHand',angle:-84}]}]];
        report.commandAdapters=[];
        for(const [name,args] of cases){const result=await adapter.poseCommand(name,{posePath,expectedRevision:host.store.active!.version,...args,dryRun:false});assert.ok(result.__imageData);report.commandAdapters.push({tool:name,version:result.version,adapter:result.adapter});}
        assert.equal(host.store.active!.version.revision,4);assert.equal(host.store.active!.value.frame.head,5);
        await host.store.disableWriting();assert.equal(host.store.writer,null);report.testWriterReleased=true;
      }
      if (captureCheckpoints) {
        // 观察模式显式发布快照求解结果，不取得写入权、不改姿态文件。
        const evaluator = new HostClient(context); await evaluator.state(); if(!commandSmoke&&!animationCandidate)await evaluator.evaluate(host.store.active!.version);
        if(real&&!animationCandidate)assert.equal(host.store.active!.derived?.numeric.ok, true);
        else if(commandSmoke){report.numeric=structuredClone(host.store.active!.derived.numeric);assert.equal(typeof report.numeric.ok,'boolean');report.diagnosticOnly=report.numeric.ok!==true;assert.equal(host.store.active!.review,null);}
        else assert.equal(host.store.active!.derived?.numeric.status,'previewOnly');
        mcp = new Client({ name: 'real-desktop-capture', version: '1' }, { capabilities: {} });
        const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
        await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server.js'], env: { ...env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_HOST_AUTOSTART: '0', SPINE_HOST_ENDPOINT: host.endpoint, SPINE_HOST_TOKEN: host.token } }));
      }
      const originalVersion = structuredClone(host.store.active!.version);
      const discovery = JSON.parse(await readFile(path.join(root, '.spine-mcp/host-port.json'), 'utf8'));
      const cases: Record<string, any> = {
        'wrong-workspace': { workspaceRoot: path.dirname(root) }, 'unknown-api': { apiVersion: '999' },
        'wrong-session': { sessionId: 'incorrect' }, 'wrong-instance': { instanceId: 'incorrect' },
        'wrong-started-at': { startedAt: 'incorrect' }, 'wrong-project': { projectId: 'another-project' },
        'invalid-port': { port: 70000 }, 'invalid-token': { token: 'invalid' }, 'dead-pid': { pid: 2147483647 },
      };
      for (const [name, changes] of Object.entries(cases)) {
        const directory = path.join(root, 'negative-cases', name); await mkdir(path.join(directory, '.spine-mcp'), { recursive: true });
        await writeFile(path.join(directory, '.spine-mcp/host-port.json'), JSON.stringify({ ...discovery, workspaceRoot: directory, ...changes }));
      }
      const missing = path.join(root, 'negative-cases/missing'); await mkdir(missing, { recursive: true });
      const linked = path.join(root, 'negative-cases/linked'); await mkdir(linked, { recursive: true });
      await symlink(path.join(root, '.spine-mcp'), path.join(linked, '.spine-mcp'), process.platform === 'win32' ? 'junction' : 'dir');
      const port = await availablePort(), previewUrl = `http://127.0.0.1:${port}/`;
      preview = spawn(process.execPath, ['dist/previewServer.js'], { env: { ...process.env, SPINE_MCP_WORKSPACE: root, SPINE_MCP_REGISTRY_ROOT: root, SPINE_PREVIEW_HOST: '127.0.0.1', SPINE_PREVIEW_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
      let ready = false;
      for (let i = 0; i < 100; i++) { try { const config = await (await fetch(previewUrl + 'api/config')).json(); if (config.workspaceRoot === root) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.ok(ready, '实际旧预览服务未启动');
      const nativeReport = path.join(root, 'native-report.json'), image = path.join(root, 'native-host.png');
      desktop = spawn('dotnet', [path.resolve('apps/winforms-observer/bin/Debug/net9.0-windows/SpineMcp.WinFormsObserver.dll'), '--host-self-test', ...captureCheckpoints ? ['--capture-checkpoints'] : [], ...benchmark ? ['--benchmark-host'] : [], ...view ? ['--expected-view-label',`${view.animation===null?'setup pose':view.animation} · ${view.time}s`] : [], '--workspace', root, '--preview-url', previewUrl, '--report', nativeReport, '--screenshot', image], { stdio: 'ignore', windowsHide: true });
      const exited = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { desktop?.kill(); reject(Error('WinForms 自检超时')); }, benchmark ? 240000 : 90000);
        desktop!.once('exit', code => { clearTimeout(timer); resolve(code); }); desktop!.once('error', error => { clearTimeout(timer); reject(error); });
      });
      if (captureCheckpoints) {
        // 若桌面提前失败，不把检查点轮询留成孤立任务。
        const captures = async () => {
          report.captures = {};
          for (const stage of ['initial', 'restored']) {
            const marker = nativeReport + '.' + stage;
            const until = Date.now() + (benchmark ? 120000 : 40000);
            for (;;) {
              try { assert.equal(await readFile(marker + '.ready', 'utf8'), stage); break; }
              catch (error: any) { if (error.code !== 'ENOENT') throw error; }
              if (Date.now() > until || desktop!.exitCode !== null) throw Error(`桌面未到达截图检查点 ${stage}`);
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            const captureSamples: any[] = [];
            const frameRequestsBeforeCaptures = frameRequests;
            const captureCount = benchmark && stage === 'initial' ? 32 : 1;
            for (let index = 0; index < captureCount; index++) {
            const started = performance.now();
            const response = await mcp!.callTool({ name: 'spine_preview_capture', arguments: { projectId: context.projectId, expectedRevision: originalVersion, size: 960 } });
            const durationMs = performance.now() - started;
            assert.ok(!response.isError, JSON.stringify(response));
            const result = JSON.parse((response.content as any[]).filter(item => item.type === 'text').map(item => item.text).join('\n'));
            assert.equal(result.manifest.captureValidity.status, 'verified');
            assert.equal(result.manifest.evidenceEligible, true);
            assert.deepEqual(result.manifest.version, originalVersion);
            assert.equal(result.manifest.source, 'player');
            if(playback||commandSmoke||animationCandidate){assert.equal(result.manifest.kind,report.kind);assert.deepEqual(result.manifest.view,view);}
            const png = await readFile(resolveWorkspacePath(result.filePath, context));
            assert.equal(strictHash(png), result.manifest.evidence[0].hash);
            report.captures[stage] = { filePath: result.filePath, manifestPath: result.manifestPath, manifest: result.manifest };
            if(playback||commandSmoke||animationCandidate){
              const saved=path.join(artifactDir,stage+'-player.png');await writeFile(saved,png,{flag:'wx'});
              await writeFile(saved+'.manifest.json',JSON.stringify(result.manifest,null,2)+'\n',{flag:'wx'});
              report.captures[stage].savedFilePath=saved;
            }
            if (captureCount > 1 && index >= 2) captureSamples.push({ durationMs, filePath: result.filePath, manifestPath: result.manifestPath, pngHash: strictHash(png) });
            }
            if (captureCount > 1) {
              await new Promise(resolve => setTimeout(resolve, 200));
              assert.equal(frameRequests, frameRequestsBeforeCaptures, '同版本的 capture 状态事件不应重复获取 frame');
              const values = captureSamples.map(sample => sample.durationMs).sort((a, b) => a - b);
              report.capturePerformance = { scope: '真实 npc1 已验收站姿隔离副本；实际 MCP stdio 到当前 WebView2 官方 player 截图，含独立核验、文件发布和 MCP image 回传；960 像素，不新增视觉批准。',
                warmups: 2, sampleCount: captureSamples.length, size: 960, samples: captureSamples, redundantFrameRequests: frameRequests - frameRequestsBeforeCaptures, p50: values[14], p95: values[28], maximum: values.at(-1), budgetMs: 1500, budgetPassed: values[28] < 1500 };
            }
            await writeFile(marker + '.release', stage, { flag: 'wx' });
          }
          // libvips 的 Windows 文件名接口不支持本项目的长证据路径；由 Node 严格读取字节。
          const first = await sharp(await readFile(resolveWorkspacePath(report.captures.initial.filePath, context))).ensureAlpha().raw().toBuffer();
          const second = await sharp(await readFile(resolveWorkspacePath(report.captures.restored.filePath, context))).ensureAlpha().raw().toBuffer();
          assert.deepEqual(first, second, '重连前后相同姿态、相机的 player 像素变化');
          report.reconnectPixelsIdentical = true;
        };
        const pendingCaptures = captures();
        // 同时挂接拒绝处理，避免原生启动失败时出现未处理的 Promise。
        await Promise.all([pendingCaptures, exited]);
      }
      const exit = await exited;
      const result = JSON.parse(await readFile(nativeReport, 'utf8')); report.native = result;
      if (result.screenshot) { const target = path.join(artifactDir, 'host-workspace.png'); await copyFile(image, target); report.screenshot = target; }
      await copyFile(nativeReport, path.join(artifactDir, 'native-report.json'));
      assert.equal(exit, 0, JSON.stringify(result)); assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(strictHash(await readFile(sourcePath)), strictHash(original));
      assert.equal(host.store.writeMode, 'observer');
      assert.deepEqual(host.store.active!.version, originalVersion);
      report.sourceUnchanged = true; report.documentVersionUnchanged = true; report.publicWriteEnabled = false; report.passed = true;
      if(animationCandidate&&!realAnimationCandidate){
        const adapter=new HostClient(context),candidate=report.animationCandidate;
        const reviewed=await adapter.animationReview({expectedRevision:originalVersion,reviewToken:candidate.reviewToken,manifestPath:candidate.animationPreview.manifestPath,playerManifestPath:report.captures.restored.manifestPath,decision:'approved',reviewedBy:'桌面完整动画事务协议验证桩',reason:'只验证合成夹具的真实 player 与事务绑定，五项内容由固定夹具预期检查，不作为真实角色美术批准',checks:fullAnimationChecks,checkResults:Object.fromEntries(fullAnimationChecks.map(k=>[k,{status:'pass',reason:k+' 的固定合成夹具协议断言'}])),dryRun:false});
        await host.store.enableWriting();await adapter.rpc('/api/pin',{expectedRevision:originalVersion,intent:'animation'});
        report.animationReceipt=await adapter.commit({expectedRevision:originalVersion,intent:'animation',animationCandidateHash:candidate.candidateHash,expectedHash:candidate.sourceHash,reviewToken:reviewed.reviewToken,outputPath:'body.json',requestId:'native-animation-source',dryRun:false});
        assert.equal(strictHash(await readFile(sourcePath)),candidate.candidateHash);assert.deepEqual(await readFile(resolveWorkspacePath(report.animationReceipt.backupPath,context)),original);
        await copyFile(sourcePath,path.join(artifactDir,'committed-source.json'));await copyFile(resolveWorkspacePath(report.animationReceipt.backupPath,context),path.join(artifactDir,'source-backup.json'));
        report.animationTransactionPassed=true;report.sourceUnchanged=false;report.documentVersionUnchanged=false;
        await host.store.disableWriting();
      }
    } finally {
      // 失败也保留原生诊断，不能让临时夹具清理掉真正的退出原因。
      if(!report.native)try{
        const raw=await readFile(path.join(root,'native-report.json'));report.native=JSON.parse(raw.toString());
        await writeFile(path.join(artifactDir,'native-report.json'),raw,{flag:'wx'});
        if(report.native.screenshot){const target=path.join(artifactDir,'host-workspace.png');await copyFile(path.join(root,'native-host.png'),target);report.screenshot=target;}
      }catch(error:any){if(error.code!=='ENOENT')report.nativeDiagnosticError=String(error);}
      await mcp?.close();
      if (desktop && desktop.exitCode === null) desktop.kill();
      if (preview && preview.exitCode === null) { preview.kill(); await new Promise<void>(resolve => preview!.once('exit', () => resolve())); }
      await host.stop();
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  },...animationCandidate?[{neutralSetup:true}]:[]);
} catch (error: any) { report.error = error.message; report.passed = false; throw error; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output, passed: report.passed, checks: report.native?.checks?.length, screenshot: report.screenshot, error: report.error })); }
