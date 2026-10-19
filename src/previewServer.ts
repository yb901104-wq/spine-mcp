#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from 'node:url';
import { getWorkspaceRoot, runInWorkspace } from './workspaceTools.js';
import { resolveWorkspacePath as safeWorkspacePath } from './spineJson.js';
import { getAgentConnectionStatus } from "./agentTools.js";
import { configureAgent } from './agentConfigTools.js';
import {getPreviewAlphaAssets} from './previewAlpha.js';
import { checkPreviewAssets, getPreviewConfig, PREVIEW_DEFAULTS, runValidationPipeline, validatePreviewRuntime } from "./previewTools.js";
import { getPreviewSession } from "./sessionTools.js";

const workspaceRoot = path.resolve(process.env.SPINE_MCP_WORKSPACE ?? process.cwd());
const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewRoot = path.join(installRoot, "preview");
const port = Number(process.env.SPINE_PREVIEW_PORT ?? getArgValue("--port") ?? 5177);
const host = process.env.SPINE_PREVIEW_HOST ?? "127.0.0.1";

const server = createServer(async (request, response) => {
  try {
    const incoming = new URL(request.url ?? '/', 'http://localhost');
    const match = incoming.pathname.match(/^\/projects\/([^/]+)(\/.*)$/);
    const projectId = match ? decodeURIComponent(match[1]) : incoming.searchParams.get('projectId') ?? undefined;
    if (match) request.url = match[2] + incoming.search;
    await runInWorkspace(projectId, () => handleRequest(request, response));
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Spine 预览服务已启动：http://${host}:${port}`);
  console.log(`工作区：${workspaceRoot}`);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  if(url.pathname==='/api/agent-config'&&request.method==='POST') {
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||request.headers['x-spine-config-action']!=='install'||request.headers['content-type']?.split(';')[0]!=='application/json'||request.headers.origin&&request.headers.origin!==`http://${host}:${port}`) {
      sendJson(response,403,{ok:false,message:'配置写入只允许本机观察平台明确点击触发。'});return;
    }
    let body='';for await(const part of request){body+=part;if(Buffer.byteLength(body)>8192){sendJson(response,413,{ok:false,message:'请求过大。'});return;}}
    const args=JSON.parse(body);
    sendJson(response,200,await configureAgent({clientType:args.clientType,scope:args.scope,expectedHash:args.expectedHash,dryRun:false}));return;
  }
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, message: "只支持 GET 请求。" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/preview" || url.pathname === "/preview/") {
    await sendFile(response, path.join(previewRoot, "index.html"));
    return;
  }

  if (url.pathname === "/api/config") {
    sendJson(response, 200, { ...getPreviewConfig(`http://${host}:${port}`), workspaceRoot: getWorkspaceRoot() });
    return;
  }

  if (url.pathname === "/api/session") {
    sendJson(response, 200, await getPreviewSession({ baseUrl: `http://${host}:${port}` }));
    return;
  }

  if (url.pathname === "/api/agent-connection") {
    sendJson(response, 200, await getAgentConnectionStatus({
      clientType: parseOptionalClientType(url.searchParams.get("clientType")),
    }));
    return;
  }
  if(url.pathname==='/api/preview-alpha-assets') {
    const atlasPath=url.searchParams.get('atlas');if(!atlasPath)throw new Error('必须指定 atlas。');
    sendJson(response,200,await getPreviewAlphaAssets({atlasPath,targetPma:url.searchParams.get('pma')==='true'}));return;
  }
  if(url.pathname==='/api/agent-config') {
    sendJson(response,200,await configureAgent({clientType:parseOptionalClientType(url.searchParams.get('clientType')) as any,scope:(url.searchParams.get('scope')??'project') as any,dryRun:true}));return;
  }

  if (url.pathname === "/api/check-assets") {
    const result = await checkPreviewAssets({
      filePath: url.searchParams.get("file") ?? PREVIEW_DEFAULTS.defaultJson,
      atlasPath: url.searchParams.get("atlas") ?? PREVIEW_DEFAULTS.defaultAtlas,
      animation: url.searchParams.get("animation") ?? PREVIEW_DEFAULTS.defaultAnimation,
    });
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  if (url.pathname === "/api/runtime-validate") {
    const result = await validatePreviewRuntime({
      filePath: url.searchParams.get("file") ?? PREVIEW_DEFAULTS.defaultJson,
      atlasPath: url.searchParams.get("atlas") ?? PREVIEW_DEFAULTS.defaultAtlas,
      animation: url.searchParams.get("animation") ?? PREVIEW_DEFAULTS.defaultAnimation,
      skin: url.searchParams.get("skin") ?? undefined,
      scale: parseOptionalNumber(url.searchParams.get("scale")),
    });
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  if (url.pathname === "/api/validation-pipeline") {
    const result = await runValidationPipeline({
      filePath: url.searchParams.get("file") ?? PREVIEW_DEFAULTS.defaultJson,
      atlasPath: url.searchParams.get("atlas") ?? PREVIEW_DEFAULTS.defaultAtlas,
      animation: url.searchParams.get("animation") ?? PREVIEW_DEFAULTS.defaultAnimation,
      skin: url.searchParams.get("skin") ?? undefined,
      scale: parseOptionalNumber(url.searchParams.get("scale")),
      speed: parseOptionalNumber(url.searchParams.get("speed")),
      premultipliedAlpha: parseOptionalBoolean(url.searchParams.get("pma")),
      mipmaps: parseOptionalBoolean(url.searchParams.get("mipmaps")),
      autoload: parseOptionalBoolean(url.searchParams.get("autoload")),
      baseUrl: `http://${host}:${port}`,
    });
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  if (url.pathname === "/api/hash") {
    const filePath = url.searchParams.get("file");
    if (!filePath) {
      sendJson(response, 400, { ok: false, message: "缺少 file 参数。" });
      return;
    }
    const absolutePath = resolveWorkspacePath(filePath);
    const raw = await readFile(absolutePath);
    sendJson(response, 200, {
      ok: true,
      filePath,
      hash: sha256(raw),
      byteLength: raw.byteLength,
    });
    return;
  }

  if (url.pathname === "/api/animations") {
    const filePath = url.searchParams.get("file");
    if (!filePath) {
      sendJson(response, 400, { ok: false, message: "缺少 file 参数。" });
      return;
    }
    const absolutePath = resolveWorkspacePath(filePath);
    const json = JSON.parse(await readFile(absolutePath, "utf8"));
    sendJson(response, 200, {
      ok: true,
      filePath,
      version: typeof json.skeleton?.spine === "string" ? json.skeleton.spine : null,
      animations: Object.keys(json.animations ?? {}),
      skins: Array.isArray(json.skins)
        ? json.skins.map((skin: Record<string, unknown>) => skin.name).filter(Boolean)
        : Object.keys(json.skins ?? {}),
    });
    return;
  }

  if (url.pathname.startsWith("/workspace/")) {
    const filePath = decodeURIComponent(url.pathname.slice("/workspace/".length));
    await sendWorkspaceFile(response, filePath);
    return;
  }

  if (url.pathname.startsWith("/preview/")) {
    const filePath = decodeURIComponent(url.pathname.slice("/preview/".length));
    await sendFile(response, resolveInside(previewRoot, filePath));
    return;
  }

  if (url.pathname.startsWith("/vendor/spine-player/")) {
    const filePath = decodeURIComponent(url.pathname.slice("/vendor/spine-player/".length));
    const packageRoot = path.join(installRoot, "node_modules", "@esotericsoftware", "spine-player");
    await sendFile(response, resolveInside(packageRoot, filePath));
    return;
  }

  sendJson(response, 404, { ok: false, message: "未找到资源。" });
}

async function sendWorkspaceFile(response: ServerResponse, filePath: string) {
  await sendFile(response, resolveWorkspacePath(filePath));
}

async function sendFile(response: ServerResponse, absolutePath: string) {
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    sendJson(response, 404, { ok: false, message: "不是可读取文件。" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": getContentType(absolutePath),
    "Content-Length": fileStat.size,
    "Cache-Control": "no-store",
  });
  createReadStream(absolutePath).pipe(response);
}

function resolveWorkspacePath(filePath: string) {
  return safeWorkspacePath(filePath);
}

function resolveInside(root: string, filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  const absolutePath = path.resolve(root, normalized);
  const relative = path.relative(root, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径必须位于允许目录内：${root}`);
  }
  return absolutePath;
}

function sendJson(response: ServerResponse, statusCode: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function getContentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".atlas":
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function getArgValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseOptionalNumber(value: string | null) {
  if (value === null || value === "") return undefined;
  return Number(value);
}

function parseOptionalBoolean(value: string | null) {
  if (value === null || value === "") return undefined;
  return value === "true";
}

function parseOptionalClientType(value: string | null) {
  if (value === null || value === "") return undefined;
  if (["codex", "claude-code", "opencode", "custom"].includes(value)) return value as "codex" | "claude-code" | "opencode" | "custom";
  return undefined;
}
