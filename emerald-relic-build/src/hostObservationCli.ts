#!/usr/bin/env node
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HostClient } from './hostClient.js';
import { HostError } from './hostContracts.js';
import { getRegisteredWorkspace } from './workspaceTools.js';
import { protectHostFile } from './hostFileProtection.js';
import { saveObservationReport } from './hostObservation.js';
import { createRolloutReview, preflightRolloutReview, type ReleaseEvidenceFiles } from './hostRollout.js';
import { REVIEW_CHECKS } from './hostReleaseEvidence.js';

const help = `Host 长期观察与 C1 启用审查（不会自动开启写入）
node dist/hostObservationCli.js start --workspace "已登记工作区绝对路径"
node dist/hostObservationCli.js status --workspace "工作区"
node dist/hostObservationCli.js stop --workspace "工作区"
node dist/hostObservationCli.js report --workspace "工作区"
node dist/hostObservationCli.js review --workspace "工作区" --report "相对报告路径" --regression "构建回归报告" --client-performance "编辑性能报告" --transactions "事务性能报告" --desktop "真实桌面报告"
node dist/hostObservationCli.js disable --workspace "工作区"
review 仅接受人工交互终端，逐项填写理由与精确确认；它只生成 24 小时内可发起启用的审批文件。
生产启动须另显式设置 SPINE_HOST_WRITE=1 与 SPINE_HOST_ROLLOUT_APPROVAL=工作区内审批相对路径。
记录默认每 60 秒采样；关机/暂停不会补记在线时长，短测不能替代真实两周。
`;
async function main() {
  const command = process.argv[2];
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (!['start', 'stop', 'status', 'report', 'review', 'disable'].includes(command)) throw new HostError('INVALID_ARGUMENT', '未知命令，请使用 --help。');
  const args: Record<string, string> = {};
  const allowed = command === 'review' ? ['workspace', 'report', 'regression', 'client-performance', 'transactions', 'desktop'] : ['workspace'];
  for (let index = 3; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1];
    if (!key.startsWith('--') || !allowed.includes(key.slice(2)) || args[key.slice(2)] || !value || value.startsWith('--')) throw new HostError('INVALID_ARGUMENT', '参数未知、重复或缺值。');
    args[key.slice(2)] = value;
  }
  if (!args.workspace || !path.isAbsolute(args.workspace)) throw new HostError('INVALID_ARGUMENT', '--workspace 必须为已登记工作区绝对路径。');
  const root = path.resolve(args.workspace); process.env.SPINE_MCP_WORKSPACE = root;
  const registered = getRegisteredWorkspace(root);
  if (!registered) throw new HostError('PROJECT_NOT_REGISTERED', '工作区未登记；请沿用 Host 启动时的 SPINE_MCP_REGISTRY_ROOT，不自动创建登记。', 409);
  const context = { workspaceRoot: root, projectId: registered.projectId };
  if (command === 'report') { console.log(JSON.stringify(await saveObservationReport(context, protectHostFile), null, 2)); return; }
  if (command === 'review') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new HostError('OPERATOR_APPROVAL_REQUIRED', '人工审批必须在交互终端执行，不能通过管道、MCP 或参数自动确认。', 403);
    for (const key of allowed) if (!args[key]) throw new HostError('INVALID_ARGUMENT', `缺少 --${key}。`);
    const evidence: ReleaseEvidenceFiles = { regression: args.regression, clientPerformance: args['client-performance'], transactions: args.transactions, desktop: args.desktop };
    const summary = await preflightRolloutReview(args.report, evidence, context); console.log(JSON.stringify(summary, null, 2));
    const labels: Record<typeof REVIEW_CHECKS[number], string> = { usageCoverage: '真实使用覆盖是否充分', gapsAndRestarts: '停机、间断及重启如何核验', staleIncidents: '误报疑点和异常如何核验', regressionAndRecovery: '同构建回归及恢复证据', performance: '同构建性能及适用范围', playerAndVisualScope: '真实 player、逐项视觉批准及 C1 范围' };
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const reviewedBy = await terminal.question('审查者：'), checks: Record<string, string> = {};
      for (const key of REVIEW_CHECKS) checks[key] = await terminal.question(`${labels[key]}（具体理由）：`);
      const challenge = `批准 C1 ${summary.reportHash}`;
      if (await terminal.question(`仅生成限定 C1 的审批；请输入“${challenge}”：`) !== challenge) throw new HostError('OPERATOR_APPROVAL_REQUIRED', '未确认，不生成审批。', 403);
      console.log(JSON.stringify(await createRolloutReview({ report: args.report, reviewedBy, checks, evidence }, context, protectHostFile), null, 2));
    } finally { terminal.close(); }
    return;
  }
  const client = new HostClient(context);
  if (!await client.ensurePreview(false)) throw new HostError('HOST_UNAVAILABLE', '当前工作区 Host 未运行；命令不自动启动或接管写入者。', 409);
  const result = command === 'status' ? await client.state({ autostart: false }) : command === 'disable'
    ? await client.rpc('/api/rollout-disable', {}, true) : await client.rpc('/api/observation', { action: command }, true);
  console.log(JSON.stringify(command === 'status' ? { version: result.version, observation: result.observation, rollout: result.rollout, writeMode: result.writeMode } : result, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code ?? 'OBSERVATION_FAILED', message: error.message })); process.exitCode = 1; });
