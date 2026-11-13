import { getWorkspaceRoot as resolveRegisteredWorkspace } from "./workspaceTools.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { CONNECTION_TTL_MS } from './agentConnectionMonitor.js';
import path from "node:path";
import { fileURLToPath } from 'node:url';
import type { ToolContext } from "./spineJson.js";

export type AgentClientType = "codex" | "claude-code" | "opencode" | "custom";

export interface AgentPingOptions {
  agentName?: string;
  clientType?: AgentClientType;
  clientVersion?: string;
  note?: string;
}

export interface AgentStatusOptions {
  clientType?: AgentClientType;
}

interface AgentHandshakeEntry {
  time: string;
  agentName: string;
  clientType: AgentClientType;
  clientVersion?: string;
  note?: string;
}

interface AgentHandshakeState {
  ok: true;
  revision: number;
  updatedAt: string;
  handshakes: AgentHandshakeEntry[];
}

const supportedClients: AgentClientType[] = ["codex", "claude-code", "opencode", "custom"];

export async function agentPing(args: AgentPingOptions = {}, context: ToolContext = {}) {
  const clientType = normalizeClientType(args.clientType);
  const agentName = normalizeAgentName(args.agentName, clientType);
  const previous = await readHandshakeState(context).catch(() => defaultHandshakeState());
  const entry: AgentHandshakeEntry = {
    time: new Date().toISOString(),
    agentName,
    clientType,
    clientVersion: trimOptional(args.clientVersion),
    note: trimOptional(args.note),
  };
  const state: AgentHandshakeState = {
    ok: true,
    revision: previous.revision + 1,
    updatedAt: entry.time,
    handshakes: [...previous.handshakes, entry].slice(-50),
  };
  await writeHandshakeState(state, context);

  return {
    ...buildAgentConnectionStatus({ clientType }, context, state, await readLiveConnections(context)),
    message: "语义握手已记录；绿灯另需 MCP 协议 ping 实时成功。",
  };
}

export async function getAgentConnectionStatus(args: AgentStatusOptions = {}, context: ToolContext = {}) {
  const state = await readHandshakeState(context).catch(() => defaultHandshakeState());
  return buildAgentConnectionStatus(args, context, state, await readLiveConnections(context));
}

async function readLiveConnections(context:ToolContext) {
  const dir=path.join(getWorkspaceRoot(context),'.spine-mcp','connections');
  const names=await readdir(dir).catch(()=>[]);
  const sessions=await Promise.all(names.filter(n=>n.endsWith('.json')).map(async n=>{try{return JSON.parse(await readFile(path.join(dir,n),'utf8'));}catch{return null;}}));
  return sessions.filter(Boolean).map(s=>{const age=Date.now()-Date.parse(s.lastSeenAt??'');let processAlive=false;if(Number.isInteger(s.pid)&&s.pid>0){try{process.kill(s.pid,0);processAlive=true;}catch(e:any){processAlive=e.code==='EPERM';}}return {...s,processAlive,ageMs:Number.isFinite(age)?age:null,live:processAlive&&s.status==='connected'&&age>=0&&age<=CONNECTION_TTL_MS};});
}
function buildAgentConnectionStatus(args: AgentStatusOptions, context: ToolContext, state: AgentHandshakeState, sessions:any[]) {
  const workspaceRoot = getWorkspaceRoot(context);
  const selectedClientType = args.clientType ? normalizeClientType(args.clientType) : undefined;
  const clients = supportedClients.map((clientType) => buildClientStatus(clientType, workspaceRoot, state, sessions));
  const selected = selectedClientType
    ? clients.find((client) => client.clientType === selectedClientType) ?? null
    : null;
  const latestHandshake = [...state.handshakes].reverse()[0] ?? null;

  return {
    ok: true,
    workspaceRoot,
    selectedClientType: selectedClientType ?? null,
    light: selected ? selected.light : clients.some(c=>c.light==='green')?'green':clients.some(c=>c.light==='yellow')?'yellow':'red',
    heartbeat: { intervalMs:10000,timeoutMs:5000,ttlMs:CONNECTION_TTL_MS,sessions },
    summary: selected ? selected.summary : buildOverallSummary(clients),
    handshake: {
      revision: state.revision,
      updatedAt: state.updatedAt,
      latest: latestHandshake,
      path: toWorkspaceRelative(getHandshakePath(context), context),
    },
    projectChecks: getProjectChecks(workspaceRoot),
    clients,
    selected,
    message: "绿灯表示近期 MCP 协议 ping 成功；黄灯表示已配置等待连接或检测暂未响应；红灯表示离线/心跳过期。绿灯不代表 Agent 正在执行任务。",
  };
}

function buildClientStatus(clientType: AgentClientType, workspaceRoot: string, state: AgentHandshakeState, sessions:any[]) {
  const latest = [...state.handshakes].reverse().find((entry) => entry.clientType === clientType) ?? null;
  const template = getClientTemplate(clientType, workspaceRoot);
  const projectChecks = getProjectChecks(workspaceRoot);
  const hasProjectRule = projectChecks.some((check) => check.name === "AGENTS.md" && check.exists);
  const own=sessions.filter(s=>s.clientType===clientType), live=own.filter(s=>s.live).sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt))[0];
  const pending=own.some(s=>s.processAlive&&['connecting','unresponsive'].includes(s.status)&&Date.now()-Date.parse(s.checkedAt)<CONNECTION_TTL_MS);
  const configured=clientType==='codex'?existsSync(path.join(workspaceRoot,'.codex','config.toml')):clientType==='claude-code'?existsSync(path.join(workspaceRoot,'.mcp.json')):clientType==='opencode'?existsSync(path.join(workspaceRoot,'opencode.json')):false;
  const light = live?'green':pending?'yellow':own.length?'red':configured||hasProjectRule||latest?'yellow':'red';
  const summary = live
    ? `${template.displayName} MCP 在线，最近协议响应：${live.lastSeenAt}`
    : own.length&&!pending?`${template.displayName} MCP 离线或心跳过期；历史握手不代表在线。`
    : pending?`${template.displayName} 等待协议响应。`
    : hasProjectRule
      ? `${template.displayName} 尚未握手；已检测到项目规则，可按配置片段接入后调用 spine_agent_ping。`
      : `${template.displayName} 尚未握手；未检测到项目规则文件。`;

  return {
    clientType,
    displayName: template.displayName,
    light,
    summary,
    latestHandshake: latest,
    connected:!!live,
    lastSeenAt:live?.lastSeenAt??own.sort((a,b)=>Date.parse(b.checkedAt)-Date.parse(a.checkedAt))[0]?.lastSeenAt??null,
    config: template,
  };
}

function getClientTemplate(clientType: AgentClientType, workspaceRoot: string) {
  const serverJs = normalizePath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js'));
  const workspace = normalizePath(workspaceRoot);
  switch (clientType) {
    case "codex":
      return {
        displayName: "Codex",
        configTargets: ["用户级 Codex 配置，例如 %USERPROFILE%/.codex/config.toml", "项目规则 AGENTS.md"],
        autoWriteSupported: true,
        note: "点击一键配置写入当前项目 .codex/config.toml；可明确选择用户级配置。保留其他设置并备份，需客户端信任项目并重新加载。",
        snippet: [
          "[mcp_servers.spine-json-mcp]",
          "command = \"node\"",
          `args = [\"${escapeToml(serverJs)}\"]`,
          "[mcp_servers.spine-json-mcp.env]",
          `SPINE_MCP_WORKSPACE = \"${escapeToml(workspace)}\"`,
        ].join("\n"),
        handshakeExample: "连接成功后，让 Codex 调用 spine_agent_ping({ clientType: \"codex\", agentName: \"Codex\" })。",
      };
    case "claude-code":
      return {
        displayName: "Claude Code",
        configTargets: ["Claude Code 项目级 .mcp.json", "或使用 claude mcp add 命令添加 stdio server"],
        autoWriteSupported: true,
        note: "点击一键配置写入当前项目 .mcp.json，备份并保留其他 MCP。客户端可能需要批准项目 MCP 并重新加载。",
        snippet: JSON.stringify({
          mcpServers: {
            "spine-json-mcp": {
              command: "node",
              args: [serverJs],
              env: {
                SPINE_MCP_WORKSPACE: workspace,
              },
            },
          },
        }, null, 2),
        commandExample: `claude mcp add spine-json-mcp -- node "${serverJs}"`,
        handshakeExample: "连接成功后，让 Claude Code 调用 spine_agent_ping({ clientType: \"claude-code\", agentName: \"Claude Code\" })。",
      };
    case "opencode":
      return {
        displayName: "opencode",
        configTargets: ["opencode 项目配置文件", "或 opencode 支持的用户级 MCP 配置"],
        autoWriteSupported: true,
        note: "点击一键配置写入当前项目 opencode.json。已有 JSONC 配置不自动修改，请使用复制配置。",
        snippet: JSON.stringify({
          mcp: {
            "spine-json-mcp": {
              type: "local",
              command: ["node",serverJs],
              enabled: true,
              environment: {
                SPINE_MCP_WORKSPACE: workspace,
              },
            },
          },
        }, null, 2),
        handshakeExample: "连接成功后，让 opencode 调用 spine_agent_ping({ clientType: \"opencode\", agentName: \"opencode\" })。",
      };
    case "custom":
      return {
        displayName: "自定义 MCP Client",
        configTargets: ["任意支持 stdio MCP server 的客户端"],
        autoWriteSupported: false,
        note: "自定义客户端只需要以 stdio 方式启动本项目 dist/server.js，并把工作区传入 SPINE_MCP_WORKSPACE。",
        snippet: JSON.stringify({
          name: "spine-json-mcp",
          transport: "stdio",
          command: "node",
          args: [serverJs],
          env: {
            SPINE_MCP_WORKSPACE: workspace,
          },
        }, null, 2),
        handshakeExample: "连接成功后，让客户端调用 spine_agent_ping({ clientType: \"custom\", agentName: \"你的客户端名\" })。",
      };
  }
}

function getProjectChecks(workspaceRoot: string) {
  return [
    buildFileCheck(workspaceRoot, "AGENTS.md", "项目规则文件，要求 Agent 不绕过 MCP 写 JSON。"),
    buildFileCheck(workspaceRoot, "dist/server.js", "MCP server 构建产物，Agent 配置应启动这个文件。"),
    buildFileCheck(workspaceRoot, "package.json", "Node 项目元信息。"),
    buildFileCheck(workspaceRoot, "docs/MCP操作清单.md", "MCP 操作说明清单。"),
    buildFileCheck(workspaceRoot, ".mcp.json", "常见项目级 MCP 配置文件。"),
    buildFileCheck(workspaceRoot, "opencode.json", "可能的 opencode 项目配置文件。"),
  ];
}

function buildFileCheck(workspaceRoot: string, relativePath: string, note: string) {
  return {
    name: relativePath,
    path: relativePath,
    exists: fileExistsSync(path.join(workspaceRoot, relativePath)),
    note,
  };
}

function fileExistsSync(absolutePath: string) {
  return existsSync(absolutePath);
}

async function readHandshakeState(context: ToolContext): Promise<AgentHandshakeState> {
  const raw = await readFile(getHandshakePath(context), "utf8");
  return normalizeHandshakeState(JSON.parse(raw));
}

async function writeHandshakeState(state: AgentHandshakeState, context: ToolContext) {
  const handshakePath = getHandshakePath(context);
  await mkdir(path.dirname(handshakePath), { recursive: true });
  await writeFile(handshakePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeHandshakeState(value: any): AgentHandshakeState {
  const fallback = defaultHandshakeState();
  return {
    ok: true,
    revision: Number.isFinite(value?.revision) ? value.revision : fallback.revision,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    handshakes: Array.isArray(value?.handshakes)
      ? (value.handshakes as unknown[])
        .map(normalizeHandshakeEntry)
        .filter((entry): entry is AgentHandshakeEntry => entry !== null)
        .slice(-50)
      : fallback.handshakes,
  };
}

function normalizeHandshakeEntry(value: any): AgentHandshakeEntry | null {
  if (!value || typeof value !== "object") return null;
  return {
    time: typeof value.time === "string" ? value.time : new Date(0).toISOString(),
    agentName: typeof value.agentName === "string" ? value.agentName : "unknown-agent",
    clientType: normalizeClientType(value.clientType),
    clientVersion: trimOptional(value.clientVersion),
    note: trimOptional(value.note),
  };
}

function defaultHandshakeState(): AgentHandshakeState {
  return {
    ok: true,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    handshakes: [],
  };
}

function normalizeClientType(value: unknown): AgentClientType {
  return supportedClients.includes(value as AgentClientType) ? value as AgentClientType : "custom";
}

function normalizeAgentName(value: unknown, clientType: AgentClientType) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return getClientTemplate(clientType, process.cwd()).displayName;
}

function trimOptional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildOverallSummary(clients: ReturnType<typeof buildClientStatus>[]) {
  const connected = clients.filter((client) => client.light === "green");
  if (connected.length > 0) return `已有 ${connected.length} 个 Agent MCP 在线：${connected.map((client) => client.displayName).join("、")}。`;
  return "尚无实时 MCP 连接。配置后在 Agent 中重新加载；历史握手不会保持绿灯。";
}

function getWorkspaceRoot(context: ToolContext) {
  return path.resolve(context.workspaceRoot ?? resolveRegisteredWorkspace(context.projectId));
}

function getHandshakePath(context: ToolContext) {
  return path.join(getWorkspaceRoot(context), ".spine-mcp", "agent-handshake.json");
}

function toWorkspaceRelative(absolutePath: string, context: ToolContext) {
  return path.relative(getWorkspaceRoot(context), absolutePath).replaceAll("\\", "/");
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/");
}

function escapeToml(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
