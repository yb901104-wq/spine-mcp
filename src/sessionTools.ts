import { getWorkspaceRoot as resolveRegisteredWorkspace } from "./workspaceTools.js";
import { mkdir, readFile, rm, writeFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { getPreviewUrl, PREVIEW_DEFAULTS, type PreviewUrlOptions } from "./previewTools.js";
import { resolveWorkspacePath, type ToolContext } from "./spineJson.js";

export interface PreviewSessionContext {
  filePath: string;
  atlasPath: string;
  animation: string;
  skin?: string;
  speed: number;
  premultipliedAlpha: boolean;
  mipmaps: boolean;
  autoload: boolean;
}

export interface PreviewSessionOperation {
  title?: string;
  status?: "idle" | "planning" | "dryRun" | "writing" | "validating" | "previewing" | "failed" | "done";
  detail?: string;
  toolName?: string;
  dryRun?: boolean;
}

export interface PreviewSessionLogEntry {
  time: string;
  level: "info" | "warning" | "error";
  message: string;
  toolName?: string;
}

export interface PreviewSessionState {
  ok: true;
  revision: number;
  updatedAt: string;
  context: PreviewSessionContext;
  operation: PreviewSessionOperation;
  logs: PreviewSessionLogEntry[];
}

export interface SetPreviewSessionOptions extends Partial<PreviewSessionContext> {
  operation?: PreviewSessionOperation;
  log?: {
    level?: "info" | "warning" | "error";
    message: string;
    toolName?: string;
  };
}

export async function setPreviewSession(args: SetPreviewSessionOptions, context: ToolContext = {}) {
  const previous = await readPreviewSession(context).catch(() => defaultSessionState());
  const nextContext: PreviewSessionContext = {
    filePath: args.filePath ?? previous.context.filePath,
    atlasPath: args.atlasPath ?? previous.context.atlasPath,
    animation: args.animation ?? previous.context.animation,
    skin: args.skin ?? previous.context.skin,
    speed: args.speed ?? previous.context.speed,
    premultipliedAlpha: args.premultipliedAlpha ?? previous.context.premultipliedAlpha,
    mipmaps: args.mipmaps ?? previous.context.mipmaps,
    autoload: args.autoload ?? previous.context.autoload,
  };
  assertWorkspaceFile(nextContext.filePath, context, "filePath");
  assertWorkspaceFile(nextContext.atlasPath, context, "atlasPath");
  assertPositiveNumber(nextContext.speed, "speed");

  const logs = [...previous.logs];
  if (args.log) {
    logs.push({
      time: new Date().toISOString(),
      level: args.log.level ?? "info",
      message: args.log.message,
      toolName: args.log.toolName,
    });
  }

  const state: PreviewSessionState = {
    ok: true,
    revision: previous.revision + 1,
    updatedAt: new Date().toISOString(),
    context: nextContext,
    operation: {
      ...previous.operation,
      ...(args.operation ?? {}),
    },
    logs: logs.slice(-50),
  };
  await writeSessionState(state, context);

  return {
    ...state,
    previewUrl: buildSessionPreviewUrl(state),
    message: "已更新预览会话状态。WinForms 或浏览器预览层可读取该状态并同步展示。",
  };
}

export async function getPreviewSession(args: { baseUrl?: string } = {}, context: ToolContext = {}) {
  const state = await readPreviewSession(context).catch(async () => {
    const state=defaultSessionState();const available=await findProjectPreview(context);
    state.context={...state.context,...available};
    if(!state.context.filePath)state.operation={status:'idle',title:'等待选择角色',detail:'当前项目没有找到配套 JSON/atlas，请填写角色资源路径。'};
    return state;
  });
  return {
    ...state,
    previewUrl: buildSessionPreviewUrl(state, args.baseUrl),
    sessionPath: toWorkspaceRelative(getSessionPath(context), context),
    message: "已读取当前预览会话状态。",
  };
}
async function findProjectPreview(context:ToolContext):Promise<Partial<PreviewSessionContext>> {
  try{await access(resolveWorkspacePath(PREVIEW_DEFAULTS.defaultJson,context));await access(resolveWorkspacePath(PREVIEW_DEFAULTS.defaultAtlas,context));return {};}catch{}
  for(const folder of ['目标','','characters']) {
    const root=path.resolve(context.workspaceRoot??resolveRegisteredWorkspace(context.projectId));
    const names=await readdir(path.join(root,folder)).catch(()=>[]);
    for(const name of names.filter(n=>n.endsWith('.json')).slice(0,50)) {
      const filePath=path.posix.join(folder,name),atlasPath=filePath.replace(/\.json$/,'.atlas');
      try {
        await access(resolveWorkspacePath(atlasPath,context));
        const json=JSON.parse((await readFile(resolveWorkspacePath(filePath,context),'utf8')).replace(/^\uFEFF/,''));
        if(!Array.isArray(json.bones)||!json.animations)continue;
        return {filePath,atlasPath,animation:Object.keys(json.animations)[0]??'',autoload:true};
      }catch{}
    }
  }
  return {filePath:'',atlasPath:'',animation:'',autoload:false};
}

export async function clearPreviewSession(context: ToolContext = {}) {
  const sessionPath = getSessionPath(context);
  await rm(sessionPath, { force: true });
  const state = defaultSessionState();
  return {
    ...state,
    previewUrl: buildSessionPreviewUrl(state),
    message: "已清空预览会话状态，并恢复默认预览上下文。",
  };
}

async function readPreviewSession(context: ToolContext): Promise<PreviewSessionState> {
  const raw = await readFile(getSessionPath(context), "utf8");
  return normalizeSessionState(JSON.parse(raw));
}

async function writeSessionState(state: PreviewSessionState, context: ToolContext) {
  const sessionPath = getSessionPath(context);
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeSessionState(value: any): PreviewSessionState {
  const fallback = defaultSessionState();
  return {
    ok: true,
    revision: Number.isFinite(value?.revision) ? value.revision : fallback.revision,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    context: {
      filePath: typeof value?.context?.filePath === "string" ? value.context.filePath : fallback.context.filePath,
      atlasPath: typeof value?.context?.atlasPath === "string" ? value.context.atlasPath : fallback.context.atlasPath,
      animation: typeof value?.context?.animation === "string" ? value.context.animation : fallback.context.animation,
      skin: typeof value?.context?.skin === "string" ? value.context.skin : undefined,
      speed: Number.isFinite(value?.context?.speed) ? value.context.speed : fallback.context.speed,
      premultipliedAlpha: typeof value?.context?.premultipliedAlpha === "boolean" ? value.context.premultipliedAlpha : fallback.context.premultipliedAlpha,
      mipmaps: typeof value?.context?.mipmaps === "boolean" ? value.context.mipmaps : fallback.context.mipmaps,
      autoload: typeof value?.context?.autoload === "boolean" ? value.context.autoload : fallback.context.autoload,
    },
    operation: value?.operation && typeof value.operation === "object" ? value.operation : fallback.operation,
    logs: Array.isArray(value?.logs) ? value.logs.slice(-50) : fallback.logs,
  };
}

function defaultSessionState(): PreviewSessionState {
  return {
    ok: true,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    context: {
      filePath: PREVIEW_DEFAULTS.defaultJson,
      atlasPath: PREVIEW_DEFAULTS.defaultAtlas,
      animation: PREVIEW_DEFAULTS.defaultAnimation,
      speed: 1,
      premultipliedAlpha: PREVIEW_DEFAULTS.premultipliedAlpha,
      mipmaps: PREVIEW_DEFAULTS.mipmaps,
      autoload: true,
    },
    operation: {
      status: "idle",
      title: "等待 Agent 操作",
    },
    logs: [],
  };
}

function buildSessionPreviewUrl(state: PreviewSessionState, baseUrl?: string) {
  const options: PreviewUrlOptions = {
    ...state.context,
    baseUrl,
  };
  return getPreviewUrl(options);
}

function assertWorkspaceFile(filePath: string, context: ToolContext, name: string) {
  try {
    resolveWorkspacePath(filePath, context);
  } catch (error) {
    throw new Error(`${name} 必须是工作区内路径：${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertPositiveNumber(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是大于 0 的数字。`);
}

function getSessionPath(context: ToolContext) {
  const workspaceRoot = path.resolve(context.workspaceRoot ?? resolveRegisteredWorkspace(context.projectId));
  return path.join(workspaceRoot, ".spine-mcp", "preview-session.json");
}

function toWorkspaceRelative(absolutePath: string, context: ToolContext) {
  const workspaceRoot = path.resolve(context.workspaceRoot ?? resolveRegisteredWorkspace(context.projectId));
  return path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
}
