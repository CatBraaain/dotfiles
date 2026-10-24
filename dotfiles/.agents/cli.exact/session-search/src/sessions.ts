import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { messageText, parseEntryLine, type SessionEntry } from "./entry";
import { toSingleLine } from "./render";

export type SessionFilters = {
  project?: string;
  since?: string;
  until?: string;
};

export type SessionFile = {
  project: string;
  sessionId: string;
  startedAt: string;
  path: string;
};

export type SessionStat = SessionFile & {
  updatedAt: Date;
  sizeBytes: number;
};

export type SessionResolution =
  | { status: "unique"; file: SessionFile }
  | { status: "notFound" }
  | { status: "ambiguous"; candidates: SessionFile[] };

const SESSION_FILE_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function sessionsRootDir(homeDir: string = homedir()): string {
  return join(homeDir, ".pi", "agent", "sessions");
}

export function cwdToProjectDir(cwd: string): string {
  const dashedPath = cwd.replace(/^\//, "").replaceAll("/", "-");
  return `--${dashedPath}--`;
}

export function parseSessionFileName(
  fileName: string,
): { startedAt: string; sessionId: string } | null {
  const match = SESSION_FILE_PATTERN.exec(fileName);
  if (match === null) return null;
  const [, day, hour, minute, second, millisecond, sessionId] = match;
  return { startedAt: `${day}T${hour}:${minute}:${second}.${millisecond}Z`, sessionId };
}

export function isWithinDateRange(
  day: string,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (since !== undefined && day < since) return false;
  if (until !== undefined && day > until) return false;
  return true;
}

export function listSessionFiles(root: string, filters: SessionFilters = {}): SessionFile[] {
  const sessionFiles: SessionFile[] = [];
  for (const projectDir of listProjectDirs(root, filters.project)) {
    for (const fileName of readdirSync(join(root, projectDir))) {
      const parsed = parseSessionFileName(fileName);
      if (parsed === null) continue;
      const day = parsed.startedAt.slice(0, 10);
      if (!isWithinDateRange(day, filters.since, filters.until)) continue;
      sessionFiles.push({
        project: projectDir,
        sessionId: parsed.sessionId,
        startedAt: parsed.startedAt,
        path: join(root, projectDir, fileName),
      });
    }
  }
  return sessionFiles.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function listProjectDirs(root: string, projectPattern: string | undefined): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => projectPattern === undefined || name.includes(projectPattern))
    .sort();
}

export function resolveSessionById(files: SessionFile[], idPrefix: string): SessionResolution {
  const candidates = files.filter((file) => file.sessionId.startsWith(idPrefix));
  if (candidates.length === 0) return { status: "notFound" };
  if (candidates.length === 1) return { status: "unique", file: candidates[0] };
  return { status: "ambiguous", candidates };
}

export function statSessionFile(file: SessionFile): SessionStat {
  const stats = statSync(file.path);
  return { ...file, updatedAt: stats.mtime, sizeBytes: stats.size };
}

export async function readSessionTitle(path: string): Promise<string> {
  for await (const entry of iterateEntries(path)) {
    const message = entry.message;
    if (message === undefined || message.role !== "user") continue;
    const text = toSingleLine(messageText(message.content));
    if (text !== "") return text;
  }
  return "";
}

async function* iterateEntries(path: string): AsyncGenerator<SessionEntry> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream });
  for await (const line of lines) {
    const entry = parseEntryLine(line);
    if (entry !== null) yield entry;
  }
}
