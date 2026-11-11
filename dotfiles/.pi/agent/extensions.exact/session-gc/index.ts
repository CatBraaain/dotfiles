import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * Keeps only the most recent sessions per project so that `pi -r` (which parses
 * every listed JSONL in full to build search text) stays fast to load.
 */
export const KEEP_COUNT = 50;

export interface MoveTarget {
  from: string;
  to: string;
}

export interface SessionGcDeps {
  /** Root of pi session storage (~/.pi/agent/sessions). Injectable for tests. */
  sessionsDir: () => string;
  /** Sessions kept per project. Defaults to KEEP_COUNT. Injectable for tests. */
  keepCount?: number;
}

export interface SessionGcEvent {
  reason: SessionStartEvent["reason"];
}

export function collectArchiveTargets(
  sessionsDir: string,
  keepCount: number = KEEP_COUNT,
): MoveTarget[] {
  const targets: MoveTarget[] = [];
  let projectDirNames: string[];
  try {
    projectDirNames = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return targets;
  }
  for (const name of projectDirNames) {
    targets.push(...archiveTargetsInProject(join(sessionsDir, name), keepCount));
  }
  return targets;
}

function archiveTargetsInProject(projectDir: string, keepCount: number): MoveTarget[] {
  let files: string[];
  try {
    files = readdirSync(projectDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(projectDir, name));
  } catch {
    return [];
  }
  const needsArchiving = files.length > keepCount;
  if (!needsArchiving) return [];

  const byModifiedDesc = (a: string, b: string): number =>
    statSync(b).mtimeMs - statSync(a).mtimeMs;
  const archiveDir = join(projectDir, "archive");
  return [...files]
    .sort(byModifiedDesc)
    .slice(keepCount)
    .map((from) => ({ from, to: join(archiveDir, basename(from)) }));
}

export function executeArchives(targets: MoveTarget[]): number {
  let archived = 0;
  for (const target of targets) {
    try {
      mkdirSync(dirname(target.to), { recursive: true });
      renameSync(target.from, target.to);
      archived++;
    } catch {
      // The file may have been removed by another process; keep archiving the rest.
    }
  }
  return archived;
}

export function runSessionGc(event: SessionGcEvent, deps: SessionGcDeps): number {
  if (event.reason !== "startup") return 0;
  return executeArchives(collectArchiveTargets(deps.sessionsDir(), deps.keepCount));
}

const defaultDeps: SessionGcDeps = {
  sessionsDir: () => join(getAgentDir(), "sessions"),
};

export default function sessionGcExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    // Run after startup so the heavy file scan never blocks session loading.
    setTimeout(() => {
      const archived = runSessionGc(event, defaultDeps);
      if (archived > 0 && ctx.hasUI) {
        ctx.ui.notify(`session-gc: archived ${archived} old sessions to archive/`, "info");
      }
    });
  });
}
