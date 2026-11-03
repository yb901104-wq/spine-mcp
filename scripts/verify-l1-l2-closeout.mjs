import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, value] = item.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));
const workspace = path.resolve(args.workspace ?? process.cwd());
const out = path.resolve(workspace, args.out ?? 'docs/plans/l1-l2-closeout-20261102.json');
const distServer = path.join(workspace, 'dist', 'server.js');

const record = {
  kind: 'l1-l2-closeout-verification',
  generatedAt: new Date().toISOString(),
  commit: args.commit ?? null,
  workspace,
  build: { command: 'npm run build', result: args.build ?? 'not-recorded' },
  protocolTest: { command: 'npx tsx --test test/protocolFeatures.test.ts', result: args.protocol ?? 'not-recorded' },
  fullRegression: { command: 'npm test', result: args.full ?? 'not-recorded', note: args.fullNote ?? null },
  note: '当前构建标签；2026-10-21～10-23 的批次验收报告保留为历史，不为本构建背书。',
};

const client = new Client({ name: 'l1-l2-closeout', version: '1' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [distServer],
  env: { ...process.env, SPINE_MCP_WORKSPACE: workspace, SPINE_HOST_AUTOSTART: '0' },
});
const handshake = { ok: false };
try {
  await client.connect(transport);
  handshake.serverVersion = client.getServerVersion();
  handshake.capabilities = client.getServerCapabilities();
  const tools = await client.listTools();
  handshake.tools = {
    count: tools.tools.length,
    allAdditionalPropertiesFalse: tools.tools.every((tool) => tool.inputSchema?.additionalProperties === false),
  };
  const resources = await client.listResources();
  handshake.resources = {
    firstPageCount: resources.resources.length,
    firstPageBytes: Buffer.byteLength(JSON.stringify(resources)),
    hasSession: resources.resources.some((item) => item.uri === 'spine://session'),
    hasNextCursor: Boolean(resources.nextCursor),
  };
  handshake.resourceTemplates = { count: (await client.listResourceTemplates()).resourceTemplates.length };
  handshake.prompts = { names: (await client.listPrompts()).prompts.map((item) => item.name) };
  handshake.promptsGet = {};
  for (const name of ['pose-prepare', 'pose-diagnose', 'preview-verify']) {
    const got = await client.getPrompt({ name, arguments: { posePath: 'example-json/skeleton-4.1.json' } });
    handshake.promptsGet[name] = { messages: got.messages?.length ?? 0 };
  }
  handshake.loggingSetLevel = await client.setLoggingLevel('info');
  const session = await client.readResource({ uri: 'spine://session' });
  handshake.sessionResource = { textBytes: Buffer.byteLength(session.contents?.[0]?.text ?? '') };
  const invalid = await client.callTool({
    name: 'spine_get_pose_state',
    arguments: { posePath: 'example-json/skeleton-4.1.json', unknown: true },
  });
  const payload = JSON.parse(invalid.content?.[0]?.text ?? '{}');
  handshake.structuredError = { isError: invalid.isError === true, code: payload.error?.code ?? payload.code ?? null };
  handshake.ok = true;
} catch (error) {
  handshake.error = String(error?.stack ?? error);
} finally {
  await client.close();
}
record.handshake = handshake;
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  out,
  handshakeOk: handshake.ok,
  tools: handshake.tools?.count ?? null,
  error: handshake.error ?? null,
}, null, 2));
