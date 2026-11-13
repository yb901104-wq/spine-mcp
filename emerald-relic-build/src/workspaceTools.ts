import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync, statSync } from 'node:fs';
export type WorkspaceSource='explicit'|'active'|'roots'|'env'|'cwd';
interface ResolvedWorkspace{root:string;projectId:string|null;resolvedFrom:WorkspaceSource}
const workspaceScope = new AsyncLocalStorage<ResolvedWorkspace>();
export const runInWorkspace = <T>(projectId: string | undefined, fn: () => T): T => workspaceScope.run(resolveWorkspace(projectId), fn);

export interface WorkspaceRecord {
  projectId: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  source: "explicit" | "environment" | "root";
}

interface WorkspaceRegistry { version: 1; activeProjectId?: string; rootsProjectIds?:string[]; workspaces: WorkspaceRecord[] }

const registryPath = () => path.join(path.resolve(process.env.SPINE_MCP_REGISTRY_ROOT ?? process.env.SPINE_MCP_WORKSPACE ?? process.cwd()), ".spine-mcp", "workspaces.json");
export function activeProjectId() { return resolveWorkspace().projectId??undefined; }

function readRegistry(): WorkspaceRegistry {
  try {
    const value = JSON.parse(readFileSync(registryPath(), "utf8"));
    return { version: 1, activeProjectId: value.activeProjectId,rootsProjectIds:Array.isArray(value.rootsProjectIds)?value.rootsProjectIds:[], workspaces: Array.isArray(value.workspaces) ? value.workspaces : [] };
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

export function resolveWorkspace(projectId?:string):ResolvedWorkspace{
  if(!projectId&&workspaceScope.getStore())return workspaceScope.getStore()!;
  const registry = readRegistry();
  if(projectId){
    const record=registry.workspaces.find(item=>item.projectId===projectId);
    if(!record)throw new Error(`未登记的 projectId：${projectId}。请先调用 spine_register_workspace。`);
    return {root:path.resolve(record.rootPath),projectId,resolvedFrom:'explicit'};
  }
  const valid=(record?:WorkspaceRecord)=>{try{return !!record&&statSync(record.rootPath).isDirectory();}catch{return false;}};
  const active=registry.workspaces.find(item=>item.projectId===registry.activeProjectId);
  if(valid(active))return{root:path.resolve(active!.rootPath),projectId:active!.projectId,resolvedFrom:'active'};
  for(const id of registry.rootsProjectIds??[]){const record=registry.workspaces.find(item=>item.projectId===id);if(valid(record))return{root:path.resolve(record!.rootPath),projectId:id,resolvedFrom:'roots'};}
  return {root:path.resolve(process.env.SPINE_MCP_WORKSPACE??process.cwd()),projectId:null,resolvedFrom:process.env.SPINE_MCP_WORKSPACE?'env':'cwd'};
}
export function getWorkspaceRoot(projectId?:string){return resolveWorkspace(projectId).root;}
export function getWorkspaceContext(projectId?: string) { const r=resolveWorkspace(projectId);return{workspaceRoot:r.root,...r.projectId?{projectId:r.projectId}:{}}; }

/** 只读查找与实际目录相符的登记；不把另一个活动工作区的 ID 带入当前作用域。 */
export function getRegisteredWorkspace(rootPath: string, projectId?: string) {
  const key = (value: string) => {
    const real = realpathSync(value);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  const root = key(rootPath), registry = readRegistry();
  const matches = registry.workspaces.filter(record => {
    try { return key(record.rootPath) === root; } catch { return false; }
  });
  return projectId ? matches.find(record => record.projectId === projectId)
    : matches.find(record => record.projectId === registry.activeProjectId) ?? matches[0];
}

export async function listWorkspaces() {
  const registry = readRegistry();
  const fallback = path.resolve(process.env.SPINE_MCP_WORKSPACE ?? process.cwd());
  return { ok: true, activeProjectId: registry.activeProjectId ?? null, fallbackRoot: fallback, workspaces: registry.workspaces };
}

export async function registerWorkspace(args: { rootPath: string; projectId?: string; source?: "explicit" | "root";setActive?:boolean }) {
  return serialized(() => registerWorkspaceLocked(args));
}
async function registerWorkspaceLocked(args: { rootPath: string; projectId?: string; source?: "explicit" | "root";setActive?:boolean }) {
  const rootPath = realpathSync(path.resolve(args.rootPath));
  if (!existsSync(rootPath)) throw new Error(`工作区不存在：${rootPath}`);
  if (!statSync(rootPath).isDirectory()) throw new Error('工作区必须是目录。');
  const registry = readRegistry();
  const registered=registry.workspaces.find(item=>item.rootPath.toLowerCase()===rootPath.toLowerCase());
  const projectId = args.projectId?.trim() || registered?.projectId || `project-${createHash("sha1").update(rootPath.toLowerCase()).digest("hex").slice(0, 12)}`;
  const now = new Date().toISOString();
  const old = registry.workspaces.find(item => item.projectId === projectId);
  if (old && old.rootPath.toLowerCase() !== rootPath.toLowerCase()) throw new Error('projectId 已绑定其他目录，不能重新绑定。');
  const record: WorkspaceRecord = { projectId, rootPath, createdAt: old?.createdAt ?? now, updatedAt: now, source: args.source==='root'&&old?.source==='explicit'?'explicit':args.source ?? "explicit" };
  registry.workspaces = [...registry.workspaces.filter(item => item.projectId !== projectId), record];
  if(args.setActive!==false)registry.activeProjectId = projectId;
  await saveRegistry(registry);
  return { ok: true, projectId, workspace: record, message: args.setActive===false?'工作区已登记，保留当前显式选择。':"工作区已登记并设为当前项目。" };
}
export async function setWorkspaceRoots(projectIds:string[]){return serialized(async()=>{const registry=readRegistry();registry.rootsProjectIds=[...new Set(projectIds)].filter(id=>registry.workspaces.some(w=>w.projectId===id));await saveRegistry(registry);});}

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
  const record = getRegisteredWorkspace(root, projectId);
  const { loadProject } = await import('./projectModel.js');
  const project = await loadProject({ workspaceRoot: root, projectId: record?.projectId });
  return { ok: true, projectId: record?.projectId ?? null, workspaceRoot: root, registered: Boolean(record), source: record?.source ?? "environment",resolvedFrom:resolveWorkspace(projectId).resolvedFrom, project };
}

