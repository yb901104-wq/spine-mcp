#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { getAgentConnectionStatus } from "./agentTools.js";
import { checkPreviewAssets, getPreviewConfig, PREVIEW_DEFAULTS, runValidationPipeline, validatePreviewRuntime } from "./previewTools.js";
import { getPreviewSession } from "./sessionTools.js";

const workspaceRoot = path.resolve(process.env.SPINE_MCP_WORKSPACE ?? process.cwd());
const previewRoot = path.join(workspaceRoot, "preview");
const port = Number(process.env.SPINE_PREVIEW_PORT ?? getArgValue("--port") ?? 5177);
const host = process.env.SPINE_PREVIEW_HOST ?? "127.0.0.1";

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
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
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, message: "只支持 GET 请求。" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/preview" || url.pathname === "/preview/") {
    await sendFile(response, path.join(previewRoot, "index.html"));
    return;
  }

  if (url.pathname === "/api/config") {
    sendJson(response, 200, { ...getPreviewConfig(`http://${host}:${port}`), workspaceRoot });
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
    const packageRoot = path.join(workspaceRoot, "node_modules", "@esotericsoftware", "spine-player");
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
  return resolveInside(workspaceRoot, filePath);
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
