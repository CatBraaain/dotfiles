import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSessionIds,
  addActiveSession,
  archivedSessionNames,
  archiveSessions,
  buildV1Migration,
  hiddenWorkspaceCwds,
  lockedSessionIds,
  migrateLegacyStore,
  mutateSessionStateStore,
  parseSessionStateStore,
  readLegacyMetadataStore,
  readSessionStateStore,
  registeredWorkspaceCwds,
  registerWorkspace,
  unarchiveSessions,
  unregisterWorkspace,
  setSessionLocks,
  type LegacyMetadataStoreData,
  type SessionStateStoreData,
} from "../src/metadataStore";
import type { SessionSummary } from "../src/sessionStore";
import { cleanup, tempDir } from "./fixtures";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await tempDir("pi-session-state-test-");
  path = join(dir, "session-state.json");
});

afterEach(async () => {
  await cleanup(dir);
});

function readWritten(): SessionStateStoreData {
  const read = readSessionStateStore(path);
  if (read.status !== "ok") throw new Error(`expected ok, got ${read.status}`);
  return read.data;
}

function summary(sessionId: string, cwd: string): SessionSummary {
  return {
    sessionId,
    filePath: join(cwd, `${sessionId}.jsonl`),
    cwd,
    displayName: `Session ${sessionId}`,
    mtimeMs: 0,
  };
}

describe("parseSessionStateStore", () => {
  it("returns empty for a missing file", () => {
    expect(readSessionStateStore(path)).toEqual({ status: "empty" });
  });

  it("reads a valid v2 store with unknown keys and fields", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspaces: { "/w": { "active-sessions": ["s1"], pinned: true } },
        tags: ["a"],
      }),
      "utf8",
    );
    const read = readSessionStateStore(path);
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.data.workspaces["/w"]["active-sessions"]).toEqual(["s1"]);
      expect(read.data.tags).toEqual(["a"]);
    }
  });

  it("returns error for unparseable JSON", () => {
    writeFileSync(path, "{not json", "utf8");
    const read = readSessionStateStore(path);
    expect(read.status).toBe("error");
    if (read.status === "error") expect(read.message).toMatch(/JSON/);
  });

  it.each([
    ['{"version":1,"workspaces":{}}', "version 1"],
    ['{"version":3,"workspaces":{}}', "version 3"],
    ['{"version":"2","workspaces":{}}', "a version string"],
    ['{"workspaces":{}}', "no version"],
    ['{"version":2}', "no workspaces"],
    ['{"version":2,"workspaces":[]}', "a workspaces array"],
    ["[]", "a JSON array"],
    ["42", "a JSON number"],
  ])("returns error when the store has %s", (raw) => {
    writeFileSync(path, raw, "utf8");
    const read = readSessionStateStore(path);
    expect(read.status).toBe("error");
    if (read.status === "error") expect(read.message).toMatch(/not a valid session-state store/);
  });

  it("reports a read failure as an error", () => {
    writeFileSync(path, "{}", "utf8");
    const read = readSessionStateStore(join(path, "nested.json")); // reading under a file fails
    expect(read.status).toBe("error");
  });
});

describe("mutateSessionStateStore", () => {
  it("creates a fresh v2 store when the file is missing", () => {
    const result = mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = { "active-sessions": ["s1"] };
      return true;
    });

    expect(result.ok).toBe(true);
    expect(readWritten()).toEqual({
      version: 2,
      workspaces: { "/w": { "active-sessions": ["s1"] } },
    });
  });

  it("writes nothing when the update reports no change", () => {
    const result = mutateSessionStateStore(path, () => false);

    expect(result.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    writeFileSync(path, "{oops", "utf8");

    const result = mutateSessionStateStore(path, () => true);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });

  it("fails on the write path: reports the error, keeps the previous content, and leaves no temp files", () => {
    const original = JSON.stringify({ version: 2, workspaces: {} });
    writeFileSync(path, original, "utf8");
    chmodSync(dir, 0o500); // a read-only store directory makes the temp-file write fail
    try {
      const result = mutateSessionStateStore(path, () => true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/Failed to write/);
    } finally {
      chmodSync(dir, 0o700); // restore before afterEach cleanup removes the directory
    }
    expect(readFileSync(path, "utf8")).toBe(original); // the previous content is untouched
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("registration", () => {
  it("registerWorkspace creates the store and the registered list", () => {
    const result = registerWorkspace(path, "/home/user/project");

    expect(result).toEqual({ ok: true, added: true });
    const data = readWritten();
    expect(registeredWorkspaceCwds(data)).toEqual(["/home/user/project"]);
  });

  it("registerWorkspace resolves the cwd and rejects an already registered directory", () => {
    registerWorkspace(path, "/home/user/project");

    const result = registerWorkspace(path, "/home/user/project/./");

    expect(result).toEqual({ ok: true, added: false });
    expect(registeredWorkspaceCwds(readWritten())).toEqual(["/home/user/project"]);
  });

  it("registerWorkspace keeps the workspace entry so registering again restores the group", () => {
    registerWorkspace(path, "/w");
    mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = { "active-sessions": ["s1"] };
      return true;
    });

    unregisterWorkspace(path, "/w");
    const result = registerWorkspace(path, "/w");

    expect(result).toEqual({ ok: true, added: true });
    expect(readWritten().workspaces["/w"]["active-sessions"]).toEqual(["s1"]);
  });

  it("unregisterWorkspace removes the registration but keeps the workspace entry", () => {
    registerWorkspace(path, "/w");
    mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = { "active-sessions": ["s1"] };
      return true;
    });

    const result = unregisterWorkspace(path, "/w");

    expect(result).toEqual({ ok: true, removed: true });
    const data = readWritten();
    expect(registeredWorkspaceCwds(data)).toEqual([]);
    expect(data.workspaces["/w"]["active-sessions"]).toEqual(["s1"]);
  });

  it("unregisterWorkspace writes nothing when the cwd is not registered", () => {
    const result = unregisterWorkspace(path, "/w");

    expect(result).toEqual({ ok: true, removed: false });
    expect(existsSync(path)).toBe(false);
  });
});

describe("membership queries", () => {
  const data: SessionStateStoreData = {
    version: 2,
    workspaces: {
      "/w": {
        "active-sessions": ["a1", "a2"],
        "locked-sessions": ["l1"],
        "archived-names": { x1: "Archived x1", bad: 123 },
      },
      "/off": { active: false, "active-sessions": ["a3"] },
    },
  } as unknown as SessionStateStoreData;

  it("collects active ids across workspaces", () => {
    expect(activeSessionIds(data)).toEqual(new Set(["a1", "a2", "a3"]));
  });

  it("collects locked ids across workspaces", () => {
    expect(lockedSessionIds(data)).toEqual(new Set(["l1"]));
  });

  it("collects string display-name snapshots across workspaces", () => {
    expect(archivedSessionNames(data)).toEqual(new Map([["x1", "Archived x1"]]));
  });
  it("collects the workspace cwds toggled off for the default view", () => {
    expect(hiddenWorkspaceCwds(data)).toEqual(new Set(["/off"]));
  });

  it("treats a missing store as empty state", () => {
    expect(activeSessionIds(undefined)).toEqual(new Set());
    expect(lockedSessionIds(undefined)).toEqual(new Set());
    expect(archivedSessionNames(undefined)).toEqual(new Map());
    expect(hiddenWorkspaceCwds(undefined)).toEqual(new Set());
    expect(registeredWorkspaceCwds(undefined)).toEqual([]);
  });
});

describe("addActiveSession", () => {
  it("creates the workspace entry and lists the session", () => {
    const result = addActiveSession(path, "/w", "s1");

    expect(result.ok).toBe(true);
    expect(readWritten()).toEqual({
      version: 2,
      workspaces: { "/w": { "active-sessions": ["s1"] } },
    });
  });

  it("appends to the listed sessions and keeps unknown fields", () => {
    mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = { "active-sessions": ["s2"], pinned: true };
      return true;
    });

    addActiveSession(path, "/w", "s1");

    expect(readWritten().workspaces["/w"]).toEqual({
      "active-sessions": ["s2", "s1"],
      pinned: true,
    });
  });

  it("writes nothing when the session is already listed", () => {
    addActiveSession(path, "/w", "s1");
    const before = readFileSync(path, "utf8");

    const result = addActiveSession(path, "/w", "s1");

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("archiveSessions", () => {
  it("removes the sessions from active-sessions and snapshots their display names", () => {
    mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = { "active-sessions": ["s1", "s2"] };
      return true;
    });

    const result = archiveSessions(path, [
      { sessionId: "s1", cwd: "/w", displayName: "Archived s1" },
    ]);

    expect(result.ok).toBe(true);
    expect(readWritten().workspaces["/w"]).toEqual({
      "active-sessions": ["s2"],
      "archived-names": { s1: "Archived s1" },
    });
  });

  it("skips locked sessions and archives the rest", () => {
    mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = {
        "active-sessions": ["locked1", "locked2", "open"],
        "locked-sessions": ["locked1", "locked2"],
      };
      return true;
    });

    const result = archiveSessions(path, [
      { sessionId: "locked1", cwd: "/w", displayName: "Locked 1" },
      { sessionId: "locked2", cwd: "/w", displayName: "Locked 2" },
      { sessionId: "open", cwd: "/w", displayName: "Open" },
    ]);

    expect(result.ok).toBe(true);
    expect(readWritten().workspaces["/w"]).toEqual({
      "active-sessions": ["locked1", "locked2"],
      "locked-sessions": ["locked1", "locked2"],
      "archived-names": { open: "Open" },
    });
  });

  it("keeps the snapshot fresh for an already inactive session", () => {
    mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = { "archived-names": { s1: "Old name" } };
      return true;
    });

    archiveSessions(path, [{ sessionId: "s1", cwd: "/w", displayName: "New name" }]);

    expect(readWritten().workspaces["/w"]["archived-names"]).toEqual({ s1: "New name" });
  });

  it("does not write and reports an error when the file is corrupt", () => {
    writeFileSync(path, "{oops", "utf8");

    const result = archiveSessions(path, [{ sessionId: "s1", cwd: "/w", displayName: "n" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });
});

describe("unarchiveSessions", () => {
  it("adds the sessions to active-sessions, keeping other attributes", () => {
    mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = {
        "active-sessions": ["s2"],
        "locked-sessions": ["s1"],
        "archived-names": { s1: "Archived s1" },
      };
      return true;
    });

    const result = unarchiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(true);
    expect(readWritten().workspaces["/w"]).toEqual({
      "active-sessions": ["s2", "s1"],
      "locked-sessions": ["s1"],
    });
  });

  it("creates the workspace entry when missing", () => {
    const result = unarchiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(true);
    expect(readWritten().workspaces["/w"]["active-sessions"]).toEqual(["s1"]);
  });

  it("writes nothing when nothing changes", () => {
    addActiveSession(path, "/w", "s1");
    const before = readFileSync(path, "utf8");

    const result = unarchiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    writeFileSync(path, "{oops", "utf8");

    const result = unarchiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });
});

describe("setSessionLocks", () => {
  it("adds and removes locks in one write, keeping other attributes", () => {
    mutateSessionStateStore(path, (store) => {
      store.workspaces["/w"] = { "active-sessions": ["s1", "s2"], "locked-sessions": ["s3"] };
      return true;
    });

    const result = setSessionLocks(path, [
      { sessionId: "s1", cwd: "/w", locked: true },
      { sessionId: "s2", cwd: "/w", locked: false },
      { sessionId: "s3", cwd: "/w", locked: false },
    ]);

    expect(result.ok).toBe(true);
    expect(readWritten().workspaces["/w"]).toEqual({
      "active-sessions": ["s1", "s2"],
      "locked-sessions": ["s1"],
    });
  });

  it("writes nothing when the lock states already match", () => {
    addActiveSession(path, "/w", "s1");
    const before = readFileSync(path, "utf8");

    const result = setSessionLocks(path, [{ sessionId: "s1", cwd: "/w", locked: false }]);

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    writeFileSync(path, "{oops", "utf8");

    const result = setSessionLocks(path, [{ sessionId: "s1", cwd: "/w", locked: true }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });
});

describe("readLegacyMetadataStore", () => {
  it("returns empty for a missing file", () => {
    expect(readLegacyMetadataStore(path)).toEqual({ status: "empty" });
  });

  it("reads a v1 document as unknown data", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, sessions: { s1: { active: false } } }),
      "utf8",
    );
    const read = readLegacyMetadataStore(path);
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.data.sessions?.s1).toEqual({ active: false });
  });

  it("returns error for unparseable JSON", () => {
    writeFileSync(path, "{oops", "utf8");
    const read = readLegacyMetadataStore(path);
    expect(read.status).toBe("error");
    if (read.status === "error") expect(read.message).toMatch(/JSON/);
  });
});

const legacy: LegacyMetadataStoreData = {
  version: 1,
  sessions: {
    visible: { active: true },
    neverTouched: {},
    archived: { active: false, name: "Archived display name" },
    lockedAndArchived: { active: false, locked: true },
    lockedVisible: { active: true, locked: true },
    otherCwd: { active: true },
  },
  workspaces: { "/w": { addedAtMs: 1 } },
};

describe("migrateLegacyStore", () => {
  it("builds the v2 store: visible sessions join active-sessions, archived ones become snapshots", () => {
    const summaries = [
      summary("visible", "/w"),
      summary("neverTouched", "/w"),
      summary("archived", "/w"),
      summary("lockedAndArchived", "/w"),
      summary("lockedVisible", "/w"),
      summary("otherCwd", "/other"), // an unregistered cwd: never migrated
    ];

    const result = migrateLegacyStore(path, legacy, summaries);

    expect(result.ok).toBe(true);
    const data = readWritten();
    expect(data["migrated-v1"]).toBe(true);
    expect(data["registered-workspaces"]).toEqual(["/w"]);
    expect(data.workspaces["/w"]).toEqual({
      "active-sessions": ["visible", "neverTouched", "lockedVisible"],
      "locked-sessions": ["lockedAndArchived", "lockedVisible"],
      "archived-names": {
        archived: "Archived display name",
        lockedAndArchived: "Session lockedAndArchived",
      },
    });
    expect(data.workspaces["/other"]).toBeUndefined();
  });

  it("merges into an existing store without dropping pi-extension state", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspaces: { "/w": { "active-sessions": ["piSession"] } },
        tags: ["a"],
      }),
      "utf8",
    );

    const result = migrateLegacyStore(path, legacy, [
      summary("visible", "/w"),
      summary("archived", "/w"),
    ]);

    expect(result.ok).toBe(true);
    const data = readWritten();
    expect(data.tags).toEqual(["a"]);
    expect(data.workspaces["/w"]["active-sessions"]).toEqual(["piSession", "visible"]);
    expect(data.workspaces["/w"]["archived-names"]).toEqual({
      archived: "Archived display name",
    });
  });

  it("runs once: the marker skips later migrations", () => {
    migrateLegacyStore(path, legacy, [summary("visible", "/w")]);
    const afterFirst = readFileSync(path, "utf8");

    const result = migrateLegacyStore(path, legacy, []);

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    expect(JSON.parse(afterFirst)["migrated-v1"]).toBe(true);
  });
});

describe("buildV1Migration", () => {
  it("does not mutate its inputs", () => {
    const existing: SessionStateStoreData = { version: 2, workspaces: {} };
    buildV1Migration(legacy, existing, [summary("visible", "/w")]);

    expect(existing).toEqual({ version: 2, workspaces: {} });
  });
});
