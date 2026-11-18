#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { meshBatchExitCode, runMeshCandidate, runMeshPlan } from './meshBatch.js';

const help = [
  '用法',
  '  mesh plan --input <PNG 或目录> --out <新目录> [--landmarks <JSON>] [--workspace <根目录>]',
  '  mesh candidate --job <清单 JSON> --spine <Spine.com 路径> --out <新目录> [--landmarks <JSON>] [--workspace <根目录>]',
  '工作区默认为当前目录。每项结果写入新目录，批次摘要输出为 JSON。',
].join('\n');

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    input: { type: 'string' }, out: { type: 'string' }, job: { type: 'string' }, spine: { type: 'string' },
    workspace: { type: 'string' }, landmarks: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    process.stdout.write(help + '\n');
    return 0;
  }
  const mode = positionals[0];
  if (positionals.length !== 1 || (mode !== 'plan' && mode !== 'candidate')) throw new Error(help);
  const common = { workspace: values.workspace ?? '.', outputDir: values.out ?? '', landmarksPath: values.landmarks };
  if (mode === 'plan' && (values.job || values.spine)) throw new Error('plan 使用 --input。');
  if (mode === 'candidate' && values.input) throw new Error('candidate 使用 --job。');
  const { report } = mode === 'plan'
    ? await runMeshPlan({ ...common, inputPath: values.input ?? '' })
    : await runMeshCandidate({ ...common, jobPath: values.job ?? '', editor: values.spine ?? '' });
  process.stdout.write(JSON.stringify(report) + '\n');
  return meshBatchExitCode(report);
}

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
