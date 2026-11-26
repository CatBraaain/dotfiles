import type { HistoryEntry, LiveArchiveLookup } from "./saved-sessions";
import type { EmptySession, ListedSession, ListedWorkspace } from "./session-list";

type UnifiedSession = ListedSession & {
  active: boolean;
  saved: boolean;
  btime: number | null;
  mtime: number | null;
  size: number | null;
};

type UnifiedWorkspace = { cwd: string; sessions: UnifiedSession[] };

export function mergeSessionLists(
  active: ListedWorkspace[],
  history: HistoryEntry[],
  resolveLiveArchive?: LiveArchiveLookup,
): UnifiedWorkspace[] {
  const workspaces = new Map<string, UnifiedWorkspace>(
    active.map(({ cwd }) => [cwd, { cwd, sessions: [] }]),
  );
  const savedById = new Map<string, HistoryEntry>();
  for (const entry of history) {
    if (!savedById.has(entry.id)) savedById.set(entry.id, entry);
  }

  const seenActive = new Set<string>();
  for (const { cwd, sessions, empty } of active) {
    const workspace = workspaces.get(cwd)!;
    const entries: (EmptySession & Partial<ListedSession>)[] = [...sessions, ...empty];
    for (const entry of entries) {
      if (seenActive.has(entry.id)) continue;
      seenActive.add(entry.id);
      const hasLiveFile = "state" in entry;
      const saved =
        savedById.get(entry.id) ?? (hasLiveFile ? resolveLiveArchive?.(entry) : undefined);
      workspace.sessions.push({
        id: entry.id,
        file: saved?.file ?? entry.file,
        active: true,
        saved: hasLiveFile || saved !== undefined,
        state: entry.state ?? null,
        title: entry.title ?? saved?.title ?? null,
        publishPending: entry.publishPending ?? null,
        ...(entry.lastRun ? { lastRun: entry.lastRun } : {}),
        btime: saved?.btime ?? null,
        mtime: saved?.mtime ?? null,
        size: saved?.size ?? null,
        ...(entry.temporary ? { temporary: true } : {}),
      });
      savedById.delete(entry.id);
    }
  }

  for (const { cwd, ...entry } of savedById.values()) {
    let workspace = workspaces.get(cwd);
    if (!workspace) {
      workspace = { cwd, sessions: [] };
      workspaces.set(cwd, workspace);
    }
    workspace.sessions.push({
      ...entry,
      active: false,
      saved: true,
      state: null,
      publishPending: null,
    });
  }

  return [...workspaces.values()];
}

export function renderUnifiedTable(workspaces: UnifiedWorkspace[]): string {
  const rows = workspaces.flatMap(({ cwd, sessions }) =>
    sessions.map(({ id, active, saved, state, mtime, title }) => {
      const status = !active ? "inactive" : !saved ? "unsaved" : (state ?? "active");
      return [cwd, id, status, formatUpdatedAt(mtime), title];
    }),
  );
  return renderTable(["WORKSPACE", "SESSION ID", "STATE", "UPDATED (UTC)", "TITLE"], rows);
}

export function renderActiveTable(workspaces: ListedWorkspace[]): string {
  const rows = workspaces.flatMap(({ cwd, sessions, empty }) => [
    ...sessions.map(({ id, state, title }) => [cwd, id, state, title]),
    ...empty.map(({ id }) => [cwd, id, "unsaved", null]),
  ]);
  return renderTable(["WORKSPACE", "SESSION ID", "STATE", "TITLE"], rows);
}

export function renderHistoryTable(history: HistoryEntry[]): string {
  const rows = history.map(({ cwd, id, mtime, title }) => [cwd, id, formatUpdatedAt(mtime), title]);
  return renderTable(["WORKSPACE", "SESSION ID", "UPDATED (UTC)", "TITLE"], rows);
}

function formatUpdatedAt(mtime: number | null): string | null {
  return mtime === null ? null : new Date(mtime).toJSON();
}

export function renderTable(headers: string[], rows: (string | null)[][]): string {
  const table = [
    headers,
    ...rows.map((row) =>
      row.map((value) =>
        (value ?? "-").replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, (character) => {
          const hex = character.charCodeAt(0).toString(16).padStart(4, "0");
          return "\\u" + hex;
        }),
      ),
    ),
  ];
  const lastColumn = headers.length - 1;
  const widths = headers
    .slice(0, lastColumn)
    .map((_, column) =>
      table.reduce((width, row) => Math.max(width, Bun.stringWidth(row[column]!)), 0),
    );
  return table
    .map((row) =>
      row
        .map((cell, column) =>
          column === lastColumn ? cell : cell + " ".repeat(widths[column]! - Bun.stringWidth(cell)),
        )
        .join("  "),
    )
    .join("\n");
}
