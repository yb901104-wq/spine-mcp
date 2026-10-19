import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync, statSync } from 'node:fs';
const workspaceScope = new AsyncLocalStorage<string>();
export const runInWorkspace = <T>(projectId: string | undefined, fn: () => T): T => workspaceScope.run(getWorkspaceRoot(projectId), fn);

export interface WorkspaceRecord {
  projectId: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  source: "explicit" | "environment" | "root";
}

interface WorkspaceRegistry { version: 1; activeProjectId?: string; workspaces: WorkspaceRecord[] }

const registryPath = () => path.join(path.resolve(process.env.SPINE_MCP_WORKSPACE ?? process.cwd()), ".spine-mcp", "workspaces.json");
export function activeProjectId() { const r = readRegistry(); return r.workspaces.find(w => w.rootPath === workspaceScope.getStore())?.projectId ?? r.activeProjectId; }

function readRegistry(): WorkspaceRegistry {
  try {
    const value = JSON.parse(readFileSync(registryPath(), "utf8"));
    return { version: 1, activeProjectId: value.activeProjectId, workspaces: Array.isArray(value.workspaces) ? value.workspaces : [] };
  } catch { return { version: 1, workspaces: [] }; }
}

async function saveRegistry(registry: WorkspaceRegistry) {
  await mkdir(path.dirname(registryPath()), { recursive: true });
  const temp = registryPath() + `.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(temp, registryPath());
}
let registryQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> { const result = registryQueue.then(fn, fn); registryQueue = result.catch(() => undefined); return result; }

export function getWorkspaceRoot(projectId?: string) {
  if (!projectId && workspaceScope.getStore()) return workspaceScope.getStore()!;
  const registry = readRegistry();
  const wanted = projectId ?? registry.activeProjectId;
  if (wanted) {
    const record = registry.workspaces.find(item => item.projectId === wanted);
    if (!record) throw new Error(`未登记的 projectId：${wanted}。请先调用 spine_register_workspace。`);
    return path.resolve(record.rootPath);
  }
  return path.resolve(process.env.SPINE_MCP_WORKSPACE ?? process.cwd());
}

export function getWorkspaceContext(projectId?: string) { return projectId ? { projectId, workspaceRoot: getWorkspaceRoot(projectId) } : {}; }

export async function listWorkspaces() {
  const registry = readRegistry();
  const fallback = path.resolve(process.env.SPINE_MCP_WORKSPACE ?? process.cwd());
  return { ok: true, activeProjectId: registry.activeProjectId ?? null, fallbackRoot: fallback, workspaces: registry.workspaces };
}

export async function registerWorkspace(args: { rootPath: string; projectId?: string; source?: "explicit" | "root" }) {
  return serialized(() => registerWorkspaceLocked(args));
}
async function registerWorkspaceLocked(args: { rootPath: string; projectId?: string; source?: "explicit" | "root" }) {
  const rootPath = realpathSync(path.resolve(args.rootPath));
  if (!existsSync(rootPath)) throw new Error(`工作区不存在：${rootPath}`);
  if (!statSync(rootPath).isDirectory()) throw new Error('工作区必须是目录。');
  const projectId = args.projectId?.trim() || `project-${createHash("sha1").update(rootPath.toLowerCase()).digest("hex").slice(0, 12)}`;
  const now = new Date().toISOString();
  const registry = readRegistry();
  const old = registry.workspaces.find(item => item.projectId === projectId);
  if (old && old.rootPath.toLowerCase() !== rootPath.toLowerCase()) throw new Error('projectId 已绑定其他目录，不能重新绑定。');
  const record: WorkspaceRecord = { projectId, rootPath, createdAt: old?.createdAt ?? now, updatedAt: now, source: args.source ?? "explicit" };
  registry.workspaces = [...registry.workspaces.filter(item => item.projectId !== projectId), record];
  registry.activeProjectId = projectId;
  await saveRegistry(registry);
  return { ok: true, projectId, workspace: record, message: "工作区已登记并设为当前项目。" };
}

export async function selectWorkspace(projectId: string) {
  return serialized(() => selectWorkspaceLocked(projectId));
}
async function selectWorkspaceLocked(projectId: string) {
  const registry = readRegistry();
  if (!registry.workspaces.some(item => item.projectId === projectId)) throw new Error(`未登记的 projectId：${projectId}。`);
  registry.activeProjectId = projectId;
  await saveRegistry(registry);
  return { ok: true, activeProjectId: projectId, workspaceRoot: getWorkspaceRoot(projectId) };
}

export async function getWorkspaceInfo(projectId?: string) {
  const root = getWorkspaceRoot(projectId);
  const registry = readRegistry();
  const record = registry.workspaces.find(item => item.projectId === (projectId ?? registry.activeProjectId));
  return { ok: true, projectId: record?.projectId ?? null, workspaceRoot: root, registered: Boolean(record), source: record?.source ?? "environment" };
}

