import { getWorkspaceRoot as resolveRegisteredWorkspace } from "./workspaceTools.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSpineDocument, resolveWorkspacePath, validateSpineJson, type ToolContext } from "./spineJson.js";

export interface ListBackupsOptions {
  filePath?: string;
  includeValidation?: boolean;
}

export interface RestoreBackupOptions {
  backupPath: string;
  targetFilePath: string;
  dryRun?: boolean;
  expectedHash?: string;
  confirm?: boolean;
}

export async function listBackups(args: ListBackupsOptions = {}, context: ToolContext = {}) {
  const backupsDir = getBackupsDir(context);
  const entries = await safeReadBackupEntries(backupsDir);
  const matcher = args.filePath ? buildBackupMatcher(args.filePath, context) : null;
  const backups = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (matcher && !matcher(entry)) continue;
    const absolutePath = resolveInside(backupsDir, entry);
    const raw = await readFile(absolutePath, "utf8");
    const info = await stat(absolutePath);
    const validation = args.includeValidation === false ? null : validateBackupJson(raw);
    backups.push({
      backupPath: toWorkspaceRelative(absolutePath, context),
      absolutePath,
      fileName: entry,
      size: info.size,
      lastModified: info.mtime.toISOString(),
      hash: sha256(raw),
      validation,
    });
  }

  backups.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return {
    ok: true,
    filePath: args.filePath ?? null,
    backupRoot: backupsDir,
    count: backups.length,
    backups,
    message: backups.length > 0
      ? "已列出匹配的备份。恢复前建议先 dryRun，并确认目标文件 hash。"
      : "没有找到匹配的备份。",
  };
}

export async function restoreBackup(args: RestoreBackupOptions, context: ToolContext = {}) {
  if (!args.confirm) throw new Error("恢复备份属于高风险操作，必须显式传 confirm: true。");
  const dryRun = args.dryRun ?? true;
  const target = await readSpineDocument(args.targetFilePath, context);
  if (args.expectedHash && args.expectedHash !== target.hash) {
    throw new Error(`expectedHash mismatch. Current ${target.hash}, expected ${args.expectedHash}.`);
  }

  const backupAbsolutePath = resolveBackupPath(args.backupPath, context);
  const backupRaw = await readFile(backupAbsolutePath, "utf8");
  const backupJson = parseBackupJson(backupRaw, args.backupPath);
  const backupValidation = validateSpineJson(backupJson);
  if (!dryRun && !backupValidation.ok) {
    throw new Error("备份 JSON 未通过校验，拒绝真实恢复。请先选择更早的可用备份。");
  }
  const restoreRaw = backupRaw.endsWith("\n") ? backupRaw : `${backupRaw}\n`;
  const hashAfter = sha256(restoreRaw);
  const currentBackupPath = dryRun ? null : await backupCurrentTarget(target.absolutePath, context);

  if (!dryRun) {
    await writeFile(target.absolutePath, restoreRaw, "utf8");
  }

  return {
    ok: backupValidation.ok,
    dryRun,
    targetFilePath: args.targetFilePath,
    backupPath: toWorkspaceRelative(backupAbsolutePath, context),
    hashBefore: target.hash,
    hashAfter: dryRun ? null : hashAfter,
    restoreSourceHash: hashAfter,
    currentBackupPath,
    validation: backupValidation,
    summary: {
      operation: "spine_restore_backup",
      wroteFile: !dryRun,
      currentFileProtected: !!currentBackupPath,
      nextStep: backupValidation.ok
        ? "恢复后建议调用 spine_run_validation_pipeline，并在 Spine 软件中确认导入。"
        : "备份本身未通过校验，不建议写入；请选择更早的可用备份。",
    },
    message: dryRun
      ? "dryRun 完成：未写入目标文件。请检查 restoreSourceHash 和 validation 后再决定是否真实恢复。"
      : "已恢复备份，并在覆盖前备份了当前目标文件。",
  };
}

function getBackupsDir(context: ToolContext) {
  const workspaceRoot = getWorkspaceRoot(context);
  const backupsDir = context.backupRoot ? path.resolve(context.backupRoot) : path.join(workspaceRoot, "backups");
  const relative = path.relative(workspaceRoot, backupsDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`backupRoot must stay inside workspace root: ${workspaceRoot}`);
  }
  return backupsDir;
}

async function safeReadBackupEntries(backupsDir: string) {
  try {
    return await readdir(backupsDir);
  } catch {
    return [];
  }
}

function buildBackupMatcher(filePath: string, context: ToolContext) {
  const targetAbsolutePath = resolveWorkspacePath(filePath, context);
  const parsed = path.parse(targetAbsolutePath);
  const prefix = `${parsed.name}.`;
  const suffix = parsed.ext;
  return (entry: string) => entry.startsWith(prefix) && entry.endsWith(suffix);
}

function resolveBackupPath(backupPath: string, context: ToolContext) {
  if (!backupPath || typeof backupPath !== "string") throw new Error("backupPath 必须是非空字符串。");
  const workspaceRoot = getWorkspaceRoot(context);
  const backupsDir = getBackupsDir(context);
  const normalized = backupPath.replaceAll("\\", "/");
  const absolutePath = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workspaceRoot, normalized);
  const relativeToWorkspace = path.relative(workspaceRoot, absolutePath);
  if (relativeToWorkspace === "" || relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
    throw new Error(`backupPath must stay inside workspace root: ${workspaceRoot}`);
  }
  const relativeToBackups = path.relative(backupsDir, absolutePath);
  if (relativeToBackups === "" || relativeToBackups.startsWith("..") || path.isAbsolute(relativeToBackups)) {
    throw new Error(`backupPath must stay inside backups directory: ${backupsDir}`);
  }
  return absolutePath;
}

async function backupCurrentTarget(targetAbsolutePath: string, context: ToolContext) {
  const backupsDir = getBackupsDir(context);
  await mkdir(backupsDir, { recursive: true });
  const raw = await readFile(targetAbsolutePath, "utf8");
  const parsed = path.parse(targetAbsolutePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const currentBackupPath = path.join(backupsDir, `${parsed.name}.before-restore.${stamp}${parsed.ext}`);
  await writeFile(currentBackupPath, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
  return toWorkspaceRelative(currentBackupPath, context);
}

function validateBackupJson(raw: string) {
  try {
    return validateSpineJson(JSON.parse(raw));
  } catch (error) {
    return {
      ok: false,
      version: null,
      writable: false,
      issues: [{
        path: "/",
        message: `备份 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`,
        severity: "error" as const,
      }],
    };
  }
}

function parseBackupJson(raw: string, backupPath: string) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`备份 JSON 无法解析：${backupPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveInside(root: string, filePath: string) {
  const absolutePath = path.resolve(root, filePath);
  const relative = path.relative(root, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径必须位于允许目录内：${root}`);
  }
  return absolutePath;
}

function toWorkspaceRelative(absolutePath: string, context: ToolContext) {
  return path.relative(getWorkspaceRoot(context), absolutePath).replaceAll("\\", "/");
}

function getWorkspaceRoot(context: ToolContext) {
  return path.resolve(context.workspaceRoot ?? resolveRegisteredWorkspace(context.projectId));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
