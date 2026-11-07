import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { summarizeSessionFile, type SessionSummaryInfo } from "./sessionFile";
import { encodeCwdDirName } from "./paths";

/**
 * Scan Pi's session directory (read-only; no VS Code API).
 *
 * Layout: <sessionDir>/<cwd-group>/<timestamp>_<session-id>.jsonl
 * - Only *.jsonl files directly inside a cwd group directory are listed
 *   (no recursion, which excludes <group>/subagents/**).
 * - Session id and cwd come from each file's header line, not the directory name.
 * - Updated time is the file mtime.
 * - With `options.cwds`, only the cwd group directories of these workspace
 *   cwds (encoded with encodeCwdDirName) are read; unregistered groups are
 *   not scanned. Without it, every cwd group directory is scanned.
 * - With `options.archivedNames` (archived display-name snapshots keyed by
 *   session id), matching files skip the display-name scan and use the
 *   snapshot as their display name.
 *
 * Scans run with bounded concurrency and summaries are cached per file keyed
 * by (mtime, size) plus whether the display name came from a snapshot, so
 * unchanged files are not re-read on repeated refreshes. Appends by pi always
 * change size and mtime, so cache staleness is not possible for the
 * append-only session files.
 */

/** One Pi session as listed by the extension. */
export interface SessionSummary {
  sessionId: string;
  filePath: string;
  cwd: string;
  displayName: string;
  mtimeMs: number;
}

/** Whether a scanned session file still exists and is a regular file. */
export async function sessionFileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const SCAN_CONCURRENCY = 16;

export interface ListSessionsOptions {
  /** Scan only the cwd group directories these workspace cwds map to. */
  cwds?: readonly string[];
  /** Archived display-name snapshots (session id -> display name). */
  archivedNames?: ReadonlyMap<string, string>;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  info: SessionSummaryInfo;
  /** Whether `info.displayName` came from an archived-name snapshot. */
  fromSnapshot: boolean;
}

const summaryCache = new Map<string, CacheEntry>();

/** List sessions under sessionDir. A missing directory yields an empty list. */
export async function listSessions(
  sessionDir: string,
  options?: ListSessionsOptions,
): Promise<SessionSummary[]> {
  // Scoped scans only read the groups of the given cwds; group names are
  // precomputed once. Undefined means unscoped: every group is scanned.
  const groupDirs =
    options?.cwds === undefined ? undefined : new Set(options.cwds.map(encodeCwdDirName));
  const archivedNames = options?.archivedNames;

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
    if (groupDirs !== undefined && !groupDirs.has(group.name)) continue; // unregistered cwd group: not scanned
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

  // Scoped scans keep cache entries of other groups; only unscoped scans see
  // the full file set and can tell which entries are stale.
  if (groupDirs === undefined) pruneCache(candidates);

  const infos = await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async (candidate) => {
    const cached = summaryCache.get(candidate.filePath);
    if (
      cached !== undefined &&
      cached.mtimeMs === candidate.mtimeMs &&
      cached.size === candidate.size &&
      // Re-summarize when the snapshot state flipped (archive/unarchive), so
      // the display name switches between snapshot and file-derived value.
      cached.fromSnapshot === (archivedNames?.has(cached.info.header.id) ?? false)
    ) {
      return cached.info;
    }
    const info = await summarizeSessionFile(candidate.filePath, archivedNames);
    if (info !== null) {
      summaryCache.set(candidate.filePath, {
        mtimeMs: candidate.mtimeMs,
        size: candidate.size,
        info,
        fromSnapshot: archivedNames?.has(info.header.id) ?? false,
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

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
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
