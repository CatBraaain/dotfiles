import { describe, expect, it, vi } from "vitest";
import { listSessionSnapshot } from "../src/sessionStore";
import { groupSessions } from "../src/grouping";
import {
  PiMux,
  type PiMuxHistoryEntry,
  type PiMuxSession,
  type PiMuxWorkspace,
} from "../src/piMux";

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
  };
}

function muxWithHistory(entries: readonly PiMuxHistoryEntry[]) {
  const history = vi.fn(async () => [...entries]);
  const mux = new PiMux(
    vi.fn(async (_executable: string, args: string[]) => {
      if (args[0] === "history") return JSON.stringify(await history());
      throw new Error(`Unexpected pi-mux command: ${args.join(" ")}`);
    }),
  );
  return { mux, history };
}

function live(id: string, file: string, title: string | null = null): PiMuxSession {
  return { id, file, state: null, title };
}

function workspace(cwd: string, sessions: PiMuxSession[]): PiMuxWorkspace {
  return { cwd, sessions, empty: [] };
}

describe("listSessionSnapshot", () => {
  it("uses list identity and cwd even when history entries disagree", async () => {
    const { mux } = muxWithHistory([historyEntry("header-id", "/other")]);
    const snapshot = await listSessionSnapshot(mux, [
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
    expect(snapshot.archivedIds.size).toBe(0);
  });

  it("retains an unsaved live row without history metadata", async () => {
    const { mux } = muxWithHistory([]);
    const snapshot = await listSessionSnapshot(mux, [
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
    expect(snapshot.archivedIds.size).toBe(0);
  });

  it("prefers the list title and falls back to the history title", async () => {
    const { mux } = muxWithHistory([historyEntry("A", ROOT, { title: "Saved name" })]);
    for (const [title, expected] of [
      ["Published", "Published"],
      [null, "Saved name"],
      ["", "Saved name"],
    ] as const) {
      const { sessions } = await listSessionSnapshot(mux, [
        workspace(ROOT, [live("A", "/saved/A.jsonl", title)]),
      ]);
      expect(sessions[0].displayName).toBe(expected);
    }
  });

  it("uses the history btime for start and the mtime for updates", async () => {
    const { mux } = muxWithHistory([historyEntry("A", ROOT, { btime: 1_000, mtime: 1_234 })]);
    const snapshot = await listSessionSnapshot(mux, [workspace(ROOT, [])]);
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
    const { mux } = muxWithHistory([
      historyEntry("archived", ROOT),
      historyEntry("A", ROOT),
      historyEntry("outside", "/outside"),
    ]);
    const snapshot = await listSessionSnapshot(mux, [
      workspace(ROOT, [live("A", "/planned.jsonl")]),
      workspace("/empty", []),
    ]);
    expect(snapshot.registeredCwds).toEqual([ROOT, "/empty"]);
    expect(snapshot.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(["A", "archived"]);
    expect(snapshot.sessions.find(({ sessionId }) => sessionId === "A")?.filePath).toBe(
      "/planned.jsonl",
    );
    expect(snapshot.archivedIds).toEqual(new Set(["archived"]));
  });

  it("merges temporary Pi with history without hiding unsaved rows or duplicating IDs", async () => {
    const { mux } = muxWithHistory([historyEntry("history", ROOT)]);
    const snapshot = await listSessionSnapshot(mux, [
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
    expect(snapshot.archivedIds).toEqual(new Set(["history", "temporary", "unsaved"]));
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
    const { mux } = muxWithHistory([]);
    const session = live("A", "/saved/A.jsonl");
    const temporary = await listSessionSnapshot(mux, [
      workspace(ROOT, [{ ...session, temporary: true }]),
    ]);
    const normal = await listSessionSnapshot(mux, [workspace(ROOT, [session])]);
    expect(temporary.archivedIds).toEqual(new Set(["A"]));
    expect(normal.archivedIds).toEqual(new Set());
    expect(normal.sessions).toEqual(temporary.sessions);
  });

  it("keeps start-time sorting with unknown start times last", async () => {
    const { mux } = muxWithHistory([historyEntry("known", ROOT, { btime: 5_000 })]);
    const { sessions } = await listSessionSnapshot(mux, [
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

  it("does not query history when the public list has no workspaces", async () => {
    const { mux, history } = muxWithHistory([]);
    expect(await listSessionSnapshot(mux, [])).toEqual({
      sessions: [],
      registeredCwds: [],
      archivedIds: new Set(),
    });
    expect(history).not.toHaveBeenCalled();
  });

  it("propagates history failures instead of treating them as missing files", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    await expect(listSessionSnapshot(new PiMux(execute), [workspace(ROOT, [])])).rejects.toThrow(
      "EACCES",
    );
  });
});
