import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listSessionSnapshot } from "../src/sessionStore";
import { encodeCwdDirName } from "../src/paths";
import { groupSessions } from "../src/grouping";
import type { PiMuxSession } from "../src/piMux";
import { cleanup, header, messageEntry, sessionInfoEntry, tempDir, writeJsonl } from "./fixtures";

let root: string;
beforeEach(async () => {
  root = await tempDir("pi-list-snapshot-");
});
afterEach(async () => {
  await chmod(root, 0o700);
  await cleanup(root);
});

function live(id: string, file: string, title: string | null = null): PiMuxSession {
  return { id, file, state: null, title };
}

async function saved(id: string, cwd = root, entries: unknown[] = []) {
  return writeJsonl(join(root, "sessions", encodeCwdDirName(cwd)), `${id}.jsonl`, [
    header({ id, cwd }),
    ...entries,
  ]);
}

describe("listSessionSnapshot", () => {
  it("uses list identity and cwd even when JSONL headers disagree", async () => {
    const file = await saved("header-id", "/other");
    const snapshot = await listSessionSnapshot(join(root, "sessions"), [
      { cwd: root, sessions: [live("mux-id", file, "Published title")] },
    ]);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        sessionId: "mux-id",
        cwd: root,
        filePath: file,
        displayName: "Published title",
      }),
    ]);
    expect(snapshot.archivedIds.size).toBe(0);
  });

  it.each(["missing", "empty", "invalid"])(
    "retains an unsaved row with a %s JSONL and null metadata",
    async (kind) => {
      const file = join(root, `${kind}.jsonl`);
      if (kind !== "missing") await writeFile(file, kind === "empty" ? "" : "not a header\n");
      const snapshot = await listSessionSnapshot(join(root, "sessions"), [
        { cwd: root, sessions: [live("unsaved", file)] },
      ]);
      expect(snapshot.sessions).toEqual([
        {
          sessionId: "unsaved",
          cwd: root,
          filePath: file,
          displayName: "Untitled",
          createdAtMs: null,
          updatedAtMs: null,
        },
      ]);
      expect(snapshot.archivedIds.size).toBe(0);
    },
  );

  it("prefers list title and falls back through the existing JSONL name rules", async () => {
    const file = await saved("A", root, [
      messageEntry("user", [{ type: "text", text: "First user line\nSecond line" }]),
      sessionInfoEntry("Saved name"),
    ]);
    const before = await readFile(file, "utf8");
    for (const [title, expected] of [
      ["Published", "Published"],
      [null, "Saved name"],
      ["", "Saved name"],
    ] as const) {
      const { sessions } = await listSessionSnapshot(join(root, "sessions"), [
        { cwd: root, sessions: [live("A", file, title)] },
      ]);
      expect(sessions[0].displayName).toBe(expected);
    }
    await writeFile(file, before + JSON.stringify(sessionInfoEntry("")) + "\n");
    const { sessions } = await listSessionSnapshot(join(root, "sessions"), [
      { cwd: root, sessions: [live("A", file)] },
    ]);
    expect(sessions[0].displayName).toBe("First user line");
  });

  it("forms a registered-cwd union and gives list entries priority over saved duplicates", async () => {
    await saved("archived");
    await saved("A");
    await saved("outside", "/outside");
    await writeJsonl(join(root, "sessions", encodeCwdDirName(root)), "foreign.jsonl", [
      header({ id: "foreign", cwd: "/outside" }),
    ]);
    await writeJsonl(join(root, "sessions", encodeCwdDirName(root), "subagents"), "child.jsonl", [
      header({ id: "child", cwd: root }),
    ]);
    const direct = join(root, "planned.jsonl");
    const snapshot = await listSessionSnapshot(join(root, "sessions"), [
      { cwd: root, sessions: [live("A", direct)] },
      { cwd: "/empty", sessions: [] },
    ]);
    expect(snapshot.registeredCwds).toEqual([root, "/empty"]);
    expect(snapshot.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(["A", "archived"]);
    expect(snapshot.sessions.find(({ sessionId }) => sessionId === "A")?.filePath).toBe(direct);
    expect(snapshot.archivedIds).toEqual(new Set(["archived"]));
  });

  it("merges temporary Pi with history without hiding unsaved rows or duplicating IDs", async () => {
    await saved("history");
    await saved("temporary");
    const snapshot = await listSessionSnapshot(join(root, "sessions"), [
      {
        cwd: root,
        sessions: [
          live("normal", join(root, "normal.jsonl")),
          {
            ...live("temporary", join(root, "missing.jsonl"), "Live temporary title"),
            temporary: true,
          },
          { ...live("unsaved", join(root, "unsaved.jsonl")), temporary: true },
        ],
      },
      { cwd: "/empty", sessions: [] },
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
    expect(snapshot.registeredCwds).toEqual([root, "/empty"]);
  });

  it("moves a temporary Pi to the normal collection when the list attribute disappears", async () => {
    const session = live("A", join(root, "A.jsonl"));
    const temporary = await listSessionSnapshot(root, [
      { cwd: root, sessions: [{ ...session, temporary: true }] },
    ]);
    const normal = await listSessionSnapshot(root, [{ cwd: root, sessions: [session] }]);
    expect(temporary.archivedIds).toEqual(new Set(["A"]));
    expect(normal.archivedIds).toEqual(new Set());
    expect(normal.sessions).toEqual(temporary.sessions);
  });

  it("keeps existing date sorting with unknown dates last", async () => {
    const known = await saved("known");
    const { sessions } = await listSessionSnapshot(join(root, "sessions"), [
      {
        cwd: root,
        sessions: [
          live("z", join(root, "z.jsonl")),
          live("a", join(root, "a.jsonl")),
          live("known", known),
        ],
      },
    ]);
    expect(groupSessions(sessions, [root])[0].sessions.map(({ sessionId }) => sessionId)).toEqual([
      "known",
      "a",
      "z",
    ]);
  });

  it("does not scan history when the public list has no workspaces", async () => {
    const directory = join(root, "denied");
    await mkdir(directory);
    await chmod(directory, 0);
    try {
      expect(await listSessionSnapshot(directory, [])).toEqual({
        sessions: [],
        registeredCwds: [],
        archivedIds: new Set(),
      });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("reports permission failures instead of treating them as missing files", async () => {
    const directory = join(root, "denied");
    await mkdir(directory);
    const file = join(directory, "A.jsonl");
    await writeFile(file, JSON.stringify(header()));
    await chmod(directory, 0);
    try {
      await expect(
        listSessionSnapshot(join(root, "sessions"), [{ cwd: root, sessions: [live("A", file)] }]),
      ).rejects.toThrow("EACCES");
    } finally {
      await chmod(directory, 0o700);
    }
  });
});
