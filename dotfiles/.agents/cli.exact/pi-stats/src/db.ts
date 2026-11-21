import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionRecord {
  path: string;
  mtimeMs: number;
  size: number;
  project: string;
  sessionId: string | null;
  cwd: string | null;
  startedMs: number | null;
  isSubagent: boolean;
}

export interface TrackedFileMeta {
  mtimeMs: number;
  size: number;
}

export interface UsageEventRecord {
  sessionPath: string;
  tsMs: number;
  kind: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export function defaultDbPath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheHome, "pi-stats", "stats.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  project TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT,
  started_ms INTEGER,
  is_subagent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_events (
  session_path TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events (ts_ms);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events (session_path);
`;

export class StatsDb {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getTracked(): Map<string, TrackedFileMeta> {
    const rows = this.db
      .query<{ path: string; mtime_ms: number; size: number }, []>(
        "SELECT path, mtime_ms, size FROM sessions",
      )
      .all();
    const tracked = new Map<string, TrackedFileMeta>();
    for (const row of rows) {
      tracked.set(row.path, { mtimeMs: row.mtime_ms, size: row.size });
    }
    return tracked;
  }

  replaceSession(record: SessionRecord, events: readonly UsageEventRecord[]): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO sessions (path, mtime_ms, size, project, session_id, cwd, started_ms, is_subagent)
           VALUES ($path, $mtimeMs, $size, $project, $sessionId, $cwd, $startedMs, $isSubagent)
           ON CONFLICT(path) DO UPDATE SET
             mtime_ms = excluded.mtime_ms,
             size = excluded.size,
             project = excluded.project,
             session_id = excluded.session_id,
             cwd = excluded.cwd,
             started_ms = excluded.started_ms,
             is_subagent = excluded.is_subagent`,
        )
        .run({
          $path: record.path,
          $mtimeMs: Math.round(record.mtimeMs),
          $size: record.size,
          $project: record.project,
          $sessionId: record.sessionId,
          $cwd: record.cwd,
          $startedMs: record.startedMs,
          $isSubagent: record.isSubagent ? 1 : 0,
        });
      this.db.query("DELETE FROM usage_events WHERE session_path = $path").run({ $path: record.path });
      const insert = this.db.query(
        `INSERT INTO usage_events
           (session_path, ts_ms, kind, provider, model, input, output, cache_read, cache_write, total_tokens, cost)
         VALUES
           ($sessionPath, $tsMs, $kind, $provider, $model, $input, $output, $cacheRead, $cacheWrite, $totalTokens, $cost)`,
      );
      for (const event of events) insert.run(eventToParams(event));
    })();
  }

  removeSessions(paths: readonly string[]): void {
    if (paths.length === 0) return;
    this.db.transaction(() => {
      const remove = this.db.query(
        "DELETE FROM sessions WHERE path = $path",
      );
      const removeEvents = this.db.query(
        "DELETE FROM usage_events WHERE session_path = $path",
      );
      for (const path of paths) {
        remove.run({ $path: path });
        removeEvents.run({ $path: path });
      }
    })();
  }

  eachEvent(callback: (event: UsageEventRecord) => void): void {
    const rows = this.db.query<Record<string, unknown>, []>(
      "SELECT * FROM usage_events ORDER BY ts_ms",
    );
    for (const row of rows.iterate()) callback(rowToEvent(row));
  }

  eachSession(callback: (record: SessionRecord) => void): void {
    const rows = this.db.query<Record<string, unknown>, []>(
      "SELECT * FROM sessions ORDER BY started_ms",
    );
    for (const row of rows.iterate()) callback(rowToSession(row));
  }
}

function eventToParams(event: UsageEventRecord): Record<string, string | number | null> {
  return {
    $sessionPath: event.sessionPath,
    $tsMs: event.tsMs,
    $kind: event.kind,
    $provider: event.provider,
    $model: event.model,
    $input: event.input,
    $output: event.output,
    $cacheRead: event.cacheRead,
    $cacheWrite: event.cacheWrite,
    $totalTokens: event.totalTokens,
    $cost: event.cost,
  };
}

function rowToEvent(row: Record<string, unknown>): UsageEventRecord {
  return {
    sessionPath: String(row.session_path ?? ""),
    tsMs: Number(row.ts_ms ?? 0),
    kind: String(row.kind ?? ""),
    provider: String(row.provider ?? ""),
    model: String(row.model ?? ""),
    input: Number(row.input ?? 0),
    output: Number(row.output ?? 0),
    cacheRead: Number(row.cache_read ?? 0),
    cacheWrite: Number(row.cache_write ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    cost: Number(row.cost ?? 0),
  };
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    path: String(row.path ?? ""),
    mtimeMs: Number(row.mtime_ms ?? 0),
    size: Number(row.size ?? 0),
    project: String(row.project ?? ""),
    sessionId: typeof row.session_id === "string" ? row.session_id : null,
    cwd: typeof row.cwd === "string" ? row.cwd : null,
    startedMs: typeof row.started_ms === "number" ? row.started_ms : null,
    isSubagent: Number(row.is_subagent ?? 0) === 1,
  };
}
