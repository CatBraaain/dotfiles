import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SessionHeaderInfo } from "./sessionFile";

/**
 * Decision logic for the "New Session" flow (no VS Code API, fs only):
 * where pi is launched, and whether a session file that appeared after the
 * launch is the one pi just started. pi creates the file lazily, when the
 * first assistant message completes, so detection polls the group directory.
 */

/** Header timestamps of sessions started before this slack before launch are treated as pre-existing. */
export const CLOCK_SKEW_MS = 5_000;

/** Minimal URI shape resolveLaunchCwd needs. */
export interface LaunchUri {
  scheme: string;
  fsPath: string;
}

/** Inputs for resolveLaunchCwd; production passes VS Code API values. */
export interface LaunchCwdSources {
  /** Workspace folders in order; undefined when no folder is open. */
  workspaceFolders: readonly { uri: LaunchUri }[] | undefined;
  /** URI of the active editor's document, or undefined when there is none. */
  activeDocumentUri: LaunchUri | undefined;
  /** Fallback directory when neither source is available. */
  homeDir: string;
}

/** Launch cwd: first file-scheme workspace folder, else the active editor file's dir, else home. */
export function resolveLaunchCwd(sources: LaunchCwdSources): string {
  const folder = sources.workspaceFolders?.find((f) => f.uri.scheme === "file");
  if (folder !== undefined) return folder.uri.fsPath;
  if (sources.activeDocumentUri?.scheme === "file") return dirname(sources.activeDocumentUri.fsPath);
  return sources.homeDir;
}

/** *.jsonl file names directly inside dir (missing dir => empty). */
export async function listSessionFileNames(groupDir: string): Promise<string[]> {
  try {
    const entries = await readdir(groupDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Candidate paths for a new session: unknown *.jsonl files in groupDir, newest mtime first. */
export async function newSessionCandidates(groupDir: string, known: ReadonlySet<string>): Promise<string[]> {
  const names = (await listSessionFileNames(groupDir)).filter((name) => !known.has(name));
  const withMtime = await Promise.all(
    names.map(async (name) => {
      const filePath = join(groupDir, name);
      try {
        return { filePath, mtimeMs: (await stat(filePath)).mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return withMtime
    .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.filePath);
}

/** Facts needed to decide whether a session header is the launched session. */
export interface LaunchedSessionMatch {
  cwd: string;
  launchedAtMs: number;
  /** Whether the session id is already claimed by an earlier launch's terminal. */
  isClaimed: (sessionId: string) => boolean;
}

/** Whether a session file header belongs to the session this launch started. */
export function isLaunchedSession(header: SessionHeaderInfo, match: LaunchedSessionMatch): boolean {
  if (match.isClaimed(header.id)) return false;
  if (resolve(header.cwd) !== resolve(match.cwd)) return false;
  const startedAtMs = headerStartMs(header.timestamp);
  return startedAtMs === undefined || startedAtMs >= match.launchedAtMs - CLOCK_SKEW_MS;
}

/** Parse a header timestamp into epoch ms; undefined when absent or unparseable. */
export function headerStartMs(timestamp: string | undefined): number | undefined {
  if (timestamp === undefined) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}
