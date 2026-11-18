import path from 'node:path';
import { meshBatchExitCode, runMeshCandidate, runMeshPlan, type MeshBatchReport } from './meshBatch.js';
import { validateMeshEditor } from './meshSpine43.js';
import { reportProgress, taskCheckpoint } from './taskControl.js';
import { ToolError } from './toolError.js';

type OutputOptions = { workspace: string; outputDir: string; landmarksPath?: string };
const outputProperties = {
  outputDir: { type: 'string', minLength: 1, description: '工作区内尚不存在的输出目录。父目录须已存在。' },
  landmarksPath: { type: 'string', minLength: 1, description: '可选。工作区内的归一化地标 JSON。' },
};

export const meshToolDefinitions = [
  {
    name: 'spine_mesh_plan',
    description: '为透明 PNG 生成 Mesh 点位、三角网和叠图，输出到新目录。目录输入按文件名批量处理。',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', minLength: 1, description: '工作区内的透明 PNG 或包含 PNG 的目录。' },
        ...outputProperties,
      },
      required: ['inputPath', 'outputDir'],
    },
  },
  {
    name: 'spine_mesh_build_candidate',
    description: '由批处理清单为已有 Spine 4.3.26 加权 Mesh 生成候选工程，重新导出并验证。源工程只读。',
    inputSchema: {
      type: 'object',
      properties: {
        jobPath: { type: 'string', minLength: 1, description: '工作区内的 Mesh 候选批处理清单 JSON。' },
        ...outputProperties,
      },
      required: ['jobPath', 'outputDir'],
    },
  },
];

const hooks = { checkpoint: taskCheckpoint, progress: reportProgress };

function summarize(result: { outputDir: string; report: MeshBatchReport }, workspace: string) {
  const { outputDir, report } = result;
  return {
    ok: meshBatchExitCode(report) === 0,
    mode: report.mode,
    outputDir,
    summaryPath: path.posix.join(outputDir, 'summary.json'),
    items: report.items.map(({ project, report: reportFile, overlay, mesh, reason, ...item }) => ({
      ...item,
      ...(project && { project: path.posix.join(outputDir, project) }),
      ...(reportFile && { report: path.posix.join(outputDir, reportFile) }),
      ...(overlay && { overlay: path.posix.join(outputDir, overlay) }),
      ...(mesh && { mesh: path.posix.join(outputDir, mesh) }),
      ...(reason && { reason: reason.replaceAll(workspace + path.sep, '') }),
    })),
  };
}

export async function planMeshTool(options: OutputOptions & { inputPath: string }) {
  return summarize(await runMeshPlan(options, hooks), options.workspace);
}

export async function buildMeshTool(options: OutputOptions & { jobPath: string }) {
  const editor = process.env.SPINE_MCP_MESH_EDITOR;
  if (!editor) throw new ToolError('CAPABILITY_MISSING', '请设置 MCP 启动环境中的 SPINE_MCP_MESH_EDITOR。');
  await taskCheckpoint('检查 Mesh 编辑器配置');
  try {
    await validateMeshEditor(editor, options.workspace);
  } catch {
    await taskCheckpoint('检查 Mesh 编辑器配置');
    throw new ToolError('CAPABILITY_MISSING', 'SPINE_MCP_MESH_EDITOR 无法运行 Spine 4.3.26，请检查本机编辑器路径和版本。');
  }
  return summarize(await runMeshCandidate({ ...options, editor }, hooks), options.workspace);
}
