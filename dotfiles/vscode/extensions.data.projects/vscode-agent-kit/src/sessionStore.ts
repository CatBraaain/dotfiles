import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { summarizeSessionFile, type SessionSummaryInfo } from "./sessionFile";

/**
 * Scan Pi's session directory (read-only; no VS Code API).
 *
 * Layout: <sessionDir>/<cwd-group>/<timestamp>_<session-id>.jsonl
 * - Only *.jsonl files directly inside a cwd group directory are listed
 *   (no recursion, which excludes <group>/subagents/**).
 * - Session id and cwd come from each file's header line, not the directory name.
 * - Updated time is the file mtime.
 *
 * Scans run with bounded concurrency and summaries are cached per file keyed by
 * (mtime, size), so unchanged files are not re-read on repeated refreshes.
 * Appends by pi always change size and mtime, so cache staleness is not possible
 * for the append-only session files.
 */

/** One Pi session as listed by the extension. */
export interface SessionSummary {
  sessionId: string;
  filePath: string;
  cwd: string;
  displayName: string;
  mtimeMs: number;
}

const SCAN_CONCURRENCY = 16;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  info: SessionSummaryInfo;
}

const summaryCache = new Map<string, CacheEntry>();

/** List all sessions under sessionDir. A missing directory yields an empty list. */
export async function listSessions(sessionDir: string): Promise<SessionSummary[]> {
  let groups;
  try {
    groups = await readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const candidates: { filePath: string; mtimeMs: number; size: number }[] = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue; // session files live one level below, inside cwd group dirs
    if (group.name === "subagents") continue; // defensive: root-level subagents is not a cwd group
    const groupDir = join(sessionDir, group.name);
    let entries;
    try {
      entries = await readdir(groupDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue; // no recursion: skips subagents/ etc.
      const filePath = join(groupDir, entry.name);
      try {
        const { mtimeMs, size } = await stat(filePath);
        candidates.push({ filePath, mtimeMs, size });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // deleted between readdir and stat
        throw error;
      }
    }
  }

  pruneCache(candidates);

  const infos = await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async (candidate) => {
    const cached = summaryCache.get(candidate.filePath);
    if (cached !== undefined && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) {
      return cached.info;
    }
    const info = await summarizeSessionFile(candidate.filePath);
    if (info !== null) {
      summaryCache.set(candidate.filePath, {
        mtimeMs: candidate.mtimeMs,
        size: candidate.size,
        info,
      });
    }
    return info;
  });

  const summaries: SessionSummary[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const info = infos[i];
    if (info === null) continue; // not a valid Pi session (missing/invalid header)
    summaries.push({
      sessionId: info.header.id,
      filePath: candidates[i].filePath,
      cwd: info.header.cwd,
      displayName: info.displayName,
      mtimeMs: candidates[i].mtimeMs,
    });
  }
  return summaries;
}

/** Drop cache entries for files that no longer exist. */
function pruneCache(candidates: { filePath: string }[]): void {
  const alive = new Set(candidates.map((c) => c.filePath));
  for (const path of summaryCache.keys()) {
    if (!alive.has(path)) summaryCache.delete(path);
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
