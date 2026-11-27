import { describe, expect, it } from "vitest";
import { listSessionSnapshot } from "../src/session-store";
import { groupSessions } from "../src/grouping";
import { type PiMuxHistoryEntry, type PiMuxSession, type PiMuxWorkspace } from "../src/pi-mux";

const ROOT = "/project";

function historyEntry(
  id: string,
  cwd: string,
  options: { title?: string | null; btime?: number; mtime?: number } = {},
): PiMuxHistoryEntry {
  return {
    id,
    cwd,
    file: `/saved/${id}.jsonl`,
    title: options.title ?? null,
    btime: options.btime ?? 500,
    mtime: options.mtime ?? 1_000,
    size: 10,
    source: "normal",
  };
}

function live(id: string, file: string, title: string | null = null): PiMuxSession {
  return { id, file, state: null, title };
}

function workspace(cwd: string, sessions: PiMuxSession[]): PiMuxWorkspace {
  return { cwd, sessions, empty: [] };
}

describe("listSessionSnapshot", () => {
  it("uses list identity and cwd even when history entries disagree", async () => {
    const history = [historyEntry("header-id", "/other")];
    const snapshot = await listSessionSnapshot(history, [
      workspace(ROOT, [live("mux-id", "/saved/mux-id.jsonl", "Published title")]),
    ]);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        sessionId: "mux-id",
        cwd: ROOT,
        filePath: "/saved/mux-id.jsonl",
        displayName: "Published title",
      }),
    ]);
    expect(snapshot.inactiveIds.size).toBe(0);
  });

  it("retains an unsaved live row without history metadata", async () => {
    const history: PiMuxHistoryEntry[] = [];
    const snapshot = await listSessionSnapshot(history, [
      workspace(ROOT, [live("unsaved", "/saved/unsaved.jsonl")]),
    ]);
    expect(snapshot.sessions).toEqual([
      {
        sessionId: "unsaved",
        cwd: ROOT,
        filePath: "/saved/unsaved.jsonl",
        displayName: "Untitled",
        createdAtMs: null,
        updatedAtMs: null,
      },
    ]);
    expect(snapshot.inactiveIds.size).toBe(0);
  });

  it("prefers the list title and falls back to the history title", async () => {
    const history = [historyEntry("A", ROOT, { title: "Saved name" })];
    for (const [title, expected] of [
      ["Published", "Published"],
      [null, "Saved name"],
      ["", "Saved name"],
    ] as const) {
      const { sessions } = await listSessionSnapshot(history, [
        workspace(ROOT, [live("A", "/saved/A.jsonl", title)]),
      ]);
      expect(sessions[0].displayName).toBe(expected);
    }
  });

  it("uses the history btime for start and the mtime for updates", async () => {
    const history = [historyEntry("A", ROOT, { btime: 1_000, mtime: 1_234 })];
    const snapshot = await listSessionSnapshot(history, [workspace(ROOT, [])]);
    expect(snapshot.sessions).toEqual([
      {
        sessionId: "A",
        cwd: ROOT,
        filePath: "/saved/A.jsonl",
        displayName: "Untitled",
        createdAtMs: 1_000,
        updatedAtMs: 1_234,
      },
    ]);
  });

  it("forms a registered-cwd union and gives list entries priority over saved duplicates", async () => {
    const history = [
      historyEntry("inactive", ROOT),
      historyEntry("A", ROOT),
      historyEntry("outside", "/outside"),
    ];
    const snapshot = await listSessionSnapshot(history, [
      workspace(ROOT, [live("A", "/planned.jsonl")]),
      workspace("/empty", []),
    ]);
    expect(snapshot.registeredCwds).toEqual([ROOT, "/empty"]);
    expect(snapshot.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(["A", "inactive"]);
    expect(snapshot.sessions.find(({ sessionId }) => sessionId === "A")?.filePath).toBe(
      "/planned.jsonl",
    );
    expect(snapshot.inactiveIds).toEqual(new Set(["inactive"]));
  });

  it("merges temporary Pi with history without hiding unsaved rows or duplicating IDs", async () => {
    const history = [historyEntry("history", ROOT)];
    const snapshot = await listSessionSnapshot(history, [
      workspace(ROOT, [
        live("normal", "/saved/normal.jsonl"),
        { ...live("temporary", "/saved/temporary.jsonl", "Live temporary title"), temporary: true },
        { ...live("unsaved", "/saved/unsaved.jsonl"), temporary: true },
      ]),
      workspace("/empty", []),
    ]);
    expect(snapshot.sessions.map(({ sessionId }) => sessionId).sort()).toEqual([
      "history",
      "normal",
      "temporary",
      "unsaved",
    ]);
    expect(snapshot.inactiveIds).toEqual(new Set(["history", "temporary", "unsaved"]));
    expect(snapshot.sessions.find(({ sessionId }) => sessionId === "temporary")?.displayName).toBe(
      "Live temporary title",
    );
    expect(snapshot.sessions.find(({ sessionId }) => sessionId === "unsaved")).toMatchObject({
      createdAtMs: null,
      updatedAtMs: null,
    });
    expect(snapshot.registeredCwds).toEqual([ROOT, "/empty"]);
  });

  it("moves a temporary Pi to the normal collection when the list attribute disappears", async () => {
    const history: PiMuxHistoryEntry[] = [];
    const session = live("A", "/saved/A.jsonl");
    const temporary = await listSessionSnapshot(history, [
      workspace(ROOT, [{ ...session, temporary: true }]),
    ]);
    const normal = await listSessionSnapshot(history, [workspace(ROOT, [session])]);
    expect(temporary.inactiveIds).toEqual(new Set(["A"]));
    expect(normal.inactiveIds).toEqual(new Set());
    expect(normal.sessions).toEqual(temporary.sessions);
  });

  it("uses archive metadata only for the same saved live file in a registered workspace", async () => {
    const archive = {
      ...historyEntry("A", ROOT, { title: "Archived title" }),
      source: "live-archive",
    } as const;
    const active = workspace(ROOT, [live(archive.id, archive.file)]);
    const matching = await listSessionSnapshot([archive], [active]);
    expect(matching.sessions[0]).toMatchObject({
      displayName: "Archived title",
      createdAtMs: archive.btime,
      updatedAtMs: archive.mtime,
    });

    const otherFile = workspace(ROOT, [live(archive.id, "/saved/other.jsonl")]);
    const otherHistoryCwd = { ...archive, cwd: "/unregistered" };
    for (const [history, workspaces] of [
      [[archive], [otherFile]],
      [[otherHistoryCwd], [active]],
    ] as const) {
      const snapshot = await listSessionSnapshot(history, workspaces);
      expect(snapshot.sessions[0]).toMatchObject({ displayName: "Untitled", updatedAtMs: null });
    }
  });

  it("does not add a row from archive history for a stopped or empty Pi", async () => {
    const archive = { ...historyEntry("A", ROOT), source: "live-archive" } as const;
    const ordinary = historyEntry("B", ROOT, { title: "Ordinary history" });
    const empty = { id: archive.id, file: archive.file };
    for (const workspaces of [
      [workspace(ROOT, [])],
      [{ cwd: ROOT, sessions: [], empty: [empty] }],
    ]) {
      const { sessions } = await listSessionSnapshot([archive, ordinary], workspaces);
      expect(sessions.map(({ sessionId }) => sessionId)).toEqual([ordinary.id]);
    }
  });

  it("keeps start-time sorting with unknown start times last", async () => {
    const history = [historyEntry("known", ROOT, { btime: 5_000 })];
    const { sessions } = await listSessionSnapshot(history, [
      workspace(ROOT, [
        live("z", "/saved/z.jsonl"),
        live("a", "/saved/a.jsonl"),
        live("known", "/saved/known.jsonl"),
      ]),
    ]);
    expect(groupSessions(sessions, [ROOT])[0].sessions.map(({ sessionId }) => sessionId)).toEqual([
      "known",
      "a",
      "z",
    ]);
  });

  it("returns an empty snapshot without registered workspaces", async () => {
    expect(await listSessionSnapshot([], [])).toEqual({
      sessions: [],
      registeredCwds: [],
      inactiveIds: new Set(),
    });
  });
});
