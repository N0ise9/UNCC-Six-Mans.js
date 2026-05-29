import fs from "fs";
import path from "path";
import { getGeneratedMediaRoot } from "./runtimePaths";

export const GENERATED_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const GENERATED_MEDIA_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type GeneratedMediaKind = "images" | "videos";

export function buildGeneratedMediaPath(kind: GeneratedMediaKind, baseName: string, extension: string): string {
  const directory = path.join(getGeneratedMediaRootPath(), kind);
  ensureDirectory(directory);
  return path.join(directory, `${sanitizeFileSegment(baseName)}-${Date.now()}.${extension}`);
}

export function getGeneratedMediaRootPath(): string {
  return getGeneratedMediaRoot();
}

export function pruneGeneratedMedia(
  rootDirectory = getGeneratedMediaRootPath(),
  now = Date.now(),
  retentionMs = GENERATED_MEDIA_RETENTION_MS
): number {
  if (!fs.existsSync(rootDirectory)) {
    return 0;
  }

  return pruneDirectory(rootDirectory, now, retentionMs, false);
}

export function startGeneratedMediaPruner(log: Pick<Console, "info" | "error"> = console): NodeJS.Timeout {
  runPrune(log);
  return setInterval(() => {
    runPrune(log);
  }, GENERATED_MEDIA_PRUNE_INTERVAL_MS);
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "norm";
}

function runPrune(log: Pick<Console, "info" | "error">): void {
  try {
    const deletedCount = pruneGeneratedMedia();
    if (deletedCount > 0) {
      log.info(`[GeneratedMedia] Pruned ${deletedCount} generated media file(s).`);
    }
  } catch (error) {
    log.error("[GeneratedMedia] Failed to prune generated media:", error);
  }
}

function pruneDirectory(directory: string, now: number, retentionMs: number, removeIfEmpty: boolean): number {
  let deletedCount = 0;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      deletedCount += pruneDirectory(entryPath, now, retentionMs, true);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stats = fs.statSync(entryPath);
    if (now - stats.mtimeMs < retentionMs) {
      continue;
    }

    fs.unlinkSync(entryPath);
    deletedCount += 1;
  }

  if (removeIfEmpty && fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }

  return deletedCount;
}
