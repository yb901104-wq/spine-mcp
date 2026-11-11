import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.cwd();
const workspace = process.env.SPINE_MCP_VALIDATION_WORKSPACE ?? path.join(root, 'diagnostic-fixture');
const server = path.join(root, 'dist', 'server.js');
const out = process.env.SPINE_REAL_MCP_REPORT ?? path.join(workspace, 'previews', 'jobs', 'real-mcp-e2e', 'validation-report.json');
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const prompt = '使用本轮绑定的 body.gif 参考动作，将动作适配到 npc1，并生成目标角色动态 GIF 和参考/目标同步对比 GIF。请通过 MCP 完成，不要直接修改源角色。';
const inputs = {
  referenceGifPath: 'clipboard-reference/reference.gif',
  sequencePath: 'clipboard-reference/clipboard-action.v2.sequence.json',
  standardPosePath: 'trial/neutral-stand-v2.pose.json',
  visualRigPath: 'trial/npc1.visual-rig.v3.json',
  targetCharacterPath: '目标/npc1.json',
  outputDir: 'previews/jobs/real-mcp-e2e',
};
const targetPath = path.join(workspace, inputs.targetCharacterPath);
const targetBefore = await sha(targetPath);
const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, SPINE_MCP_WORKSPACE: workspace, SPINE_HOST_AUTOSTART: '0' } });
const client = new Client({ name: 'real-mcp-validation', version: '1.0.0' }, { capabilities: {} });
const trace = [];
const call = async (name, args) => {
  const started = new Date().toISOString();
  // 参考 GIF 的 runtime 渲染可能超过 SDK 默认 60 秒；仍通过 MCP 请求，只延长本次真实验证的等待窗口。
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  trace.push({ name, args, started, result });
  return result;
};
await client.connect(transport);
const ping = await call('spine_agent_ping', { agentName: 'real-mcp-validation', clientType: 'custom', clientVersion: '1.0.0', note: prompt });
const taskResult = await call('spine_execute_task', { taskType: 'retarget_reference', inputs, options: { workflowProfile: 'adaptive-preview', retargetMode: 'adaptive', previewPolicy: 'auto', dryRun: true } });
const parsed = JSON.parse(taskResult.content?.find(item => item.type === 'text')?.text ?? '{}');
let previewCall = null;
const diagnostic = parsed.artifacts?.diagnosticPreview;
if (diagnostic?.manifestPath) {
  const manifestPath = path.join(workspace, diagnostic.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  previewCall = await call('spine_render_animation_comparison', {
    targetManifestPath: manifest.targetManifestPath,
    referenceManifestPath: manifest.referenceManifestPath,
    poseManifestPath: manifest.poseManifestPath,
    phaseMap: manifest.phaseMap,
    outputDir: 'previews/jobs/real-mcp-e2e/mcp-comparison',
    layout: 'reference-above-target',
  });
}
const targetAfter = await sha(targetPath);
await mkdir(path.dirname(out), { recursive: true });
const pingPayload = JSON.parse(ping.content?.find(item => item.type === 'text')?.text ?? '{}');
const toolTraceAbsolute = path.join(path.dirname(out), 'tool-trace.json');
const toolTracePath = path.relative(workspace, toolTraceAbsolute).replaceAll(path.sep, '/');
const targetRuntimeGif = diagnostic?.runtimePreview?.gifPath ?? null;
const comparisonGif = diagnostic?.comparison?.gifPath ?? null;
const report = { version: 1, kind: 'real-mcp-e2e-validation', prompt, workspace, executionMode: 'mcp-host-e2e', mcpServer: server, buildIdentity: parsed.buildIdentity ?? pingPayload.buildIdentity ?? null, hostSessionId: pingPayload.sessionId ?? null, toolTracePath, targetRuntimeGif, comparisonGif, formalEligible: parsed.formalEligible === true, task: parsed, previewRequested: Boolean(diagnostic?.manifestPath), previewCall, targetSourceHashBefore: targetBefore, targetSourceHashAfter: targetAfter, targetSourceUnchanged: targetBefore === targetAfter, toolTrace: trace, createdAt: new Date().toISOString() };
await writeFile(toolTraceAbsolute, JSON.stringify({ version: 1, kind: 'mcp-tool-trace', prompt, buildIdentity: report.buildIdentity, hostSessionId: report.hostSessionId, calls: trace }, null, 2) + '\n');
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: report.targetSourceUnchanged, reportPath: out, toolTracePath, status: parsed.status, stopLayer: parsed.stopLayer, buildIdentity: report.buildIdentity, targetRuntimeGif, comparisonGif, previewRequested: report.previewRequested }, null, 2));
if (!report.targetSourceUnchanged) process.exitCode = 1;
