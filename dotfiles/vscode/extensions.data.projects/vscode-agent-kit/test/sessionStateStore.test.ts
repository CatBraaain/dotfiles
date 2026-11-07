import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSessionIds,
  addActiveSession,
  archiveSessions,
  lockedSessionIds,
  mutateSessionStateStore,
  parseSessionStateStore,
  registerWorkspace,
  registeredWorkspaceCwds,
  unregisterWorkspace,
  readSessionStateStore,
  sessionPhases,
  setSessionLocks,
  unarchiveSessions,
  type SessionStateStoreData,
  type WorkspaceStateEntry,
} from "../src/sessionStateStore";
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

function seed(raw: string): void {
  writeFileSync(path, raw, "utf8");
}

describe("readSessionStateStore", () => {
  it("returns empty for a missing file", () => {
    expect(readSessionStateStore(path)).toEqual({ status: "empty" });
  });

  it("reads a valid store with unknown keys and fields", () => {
    seed(
      JSON.stringify({
        "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } }, pinned: true } },
        tags: ["a"],
      }),
    );
    const read = readSessionStateStore(path);
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.data["active-workspaces"]["/w"]["active-sessions"]).toEqual({
        s1: { lock: false },
      });
      expect(read.data.tags).toEqual(["a"]);
    }
  });

  it("returns error for unparseable JSON", () => {
    seed("{not json");
    const read = readSessionStateStore(path);
    expect(read.status).toBe("error");
    if (read.status === "error") expect(read.message).toMatch(/JSON/);
  });

  it.each([
    ["{}", "no active-workspaces"],
    ['{"active-workspaces":[]}', "an active-workspaces array"],
    ['{"active-workspaces":{"/w":{"active-sessions":["s1"]}}}', "a pre-map active-sessions array"],
    ['{"workspaces":{"/w":{}}}', "a pre-rename root workspaces object"],
    ["[]", "a JSON array"],
    ["42", "a JSON number"],
  ])("returns error when the store has %s", (raw) => {
    seed(raw);
    const read = readSessionStateStore(path);
    expect(read.status).toBe("error");
    if (read.status === "error") expect(read.message).toMatch(/not a valid session-state store/);
  });

  it("reports a read failure as an error", () => {
    seed("{}");
    const read = readSessionStateStore(join(path, "nested.json")); // reading under a file fails
    expect(read.status).toBe("error");
  });
});

describe("parseSessionStateStore", () => {
  it("accepts the documented store shape", () => {
    const read = parseSessionStateStore(
      JSON.stringify({
        "active-workspaces": {
          "/w": { "active-sessions": { s1: { lock: false, state: "running" } } },
        },
      }),
    );
    expect(read.status).toBe("ok");
  });
});

describe("mutateSessionStateStore", () => {
  it("creates a fresh store when the file is missing", () => {
    const result = mutateSessionStateStore(path, (store) => {
      store["active-workspaces"]["/w"] = { "active-sessions": { s1: {} } };
      return true;
    });

    expect(result.ok).toBe(true);
    expect(readWritten()).toEqual({
      "active-workspaces": { "/w": { "active-sessions": { s1: {} } } },
    });
  });

  it("writes nothing when the update reports no change", () => {
    const result = mutateSessionStateStore(path, () => false);

    expect(result.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("preserves unknown root keys on rewrite", () => {
    seed(JSON.stringify({ "active-workspaces": {}, tags: ["a"] }));

    mutateSessionStateStore(path, (store) => {
      store["active-workspaces"]["/w"] = { "active-sessions": { s1: {} } };
      return true;
    });

    expect(readWritten().tags).toEqual(["a"]);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    seed("{oops");

    const result = mutateSessionStateStore(path, () => true);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });

  it("fails on the write path: reports the error, keeps the previous content, and leaves no temp files", () => {
    const original = JSON.stringify({ "active-workspaces": {} });
    seed(original);
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

describe("membership queries", () => {
  const data = {
    "active-workspaces": {
      "/w": {
        "active-sessions": {
          a1: { state: "running" },
          a2: { lock: true, state: "waiting-approval" },
          broken: "not an object",
          stale: { state: "hibernating" },
        },
      },
      "/other": { "active-sessions": { a3: { state: "waiting-user" } } },
    },
  } as unknown as SessionStateStoreData;

  it("collects active ids across workspaces, ignoring non-object entries", () => {
    expect(activeSessionIds(data)).toEqual(new Set(["a1", "a2", "stale", "a3"]));
  });

  it("collects locked ids across workspaces", () => {
    expect(lockedSessionIds(data)).toEqual(new Set(["a2"]));
  });

  it("collects valid phases and ignores missing or invalid states", () => {
    expect(sessionPhases(data)).toEqual(
      new Map([
        ["a1", "running"],
        ["a2", "waiting-approval"],
        ["a3", "waiting-user"],
      ]),
    );
  });

  it("treats a missing store as empty state", () => {
    expect(activeSessionIds(undefined)).toEqual(new Set());
    expect(lockedSessionIds(undefined)).toEqual(new Set());
    expect(sessionPhases(undefined)).toEqual(new Map());
  });
});

describe("registration", () => {
  it("registerWorkspace creates the entry with an empty active-sessions map", () => {
    const result = registerWorkspace(path, "/home/user/project");

    expect(result).toEqual({ ok: true, added: true });
    expect(readWritten()).toEqual({
      "active-workspaces": { "/home/user/project": { "active-sessions": {} } },
    });
  });

  it("registerWorkspace resolves the cwd and skips an already registered directory", () => {
    registerWorkspace(path, "/home/user/project");

    const result = registerWorkspace(path, "/home/user/project/./");

    expect(result).toEqual({ ok: true, added: false });
    expect(registeredWorkspaceCwds(readWritten())).toEqual(["/home/user/project"]);
  });

  it("registeredWorkspaceCwds lists the workspaces keys", () => {
    registerWorkspace(path, "/w1");
    registerWorkspace(path, "/w2");

    expect(registeredWorkspaceCwds(readWritten())).toEqual(["/w1", "/w2"]);
    expect(registeredWorkspaceCwds(undefined)).toEqual([]);
  });

  it("unregisterWorkspace deletes the entry together with its memberships", () => {
    registerWorkspace(path, "/w");
    addActiveSession(path, "/w", "s1");

    const result = unregisterWorkspace(path, "/w/./");

    expect(result).toEqual({ ok: true, removed: true });
    expect(readWritten()).toEqual({ "active-workspaces": {} });
  });

  it("unregisterWorkspace writes nothing for an unregistered cwd", () => {
    const result = unregisterWorkspace(path, "/w");

    expect(result).toEqual({ ok: true, removed: false });
    expect(existsSync(path)).toBe(false);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    writeFileSync(path, "{oops", "utf8");

    expect(registerWorkspace(path, "/w").ok).toBe(false);
    expect(unregisterWorkspace(path, "/w").ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });
});

describe("addActiveSession", () => {
  it("creates the workspace entry and the session entry with lock false", () => {
    const result = addActiveSession(path, "/w", "s1");

    expect(result.ok).toBe(true);
    expect(readWritten()).toEqual({
      "active-workspaces": { "/w": { "active-sessions": { s1: { lock: false } } } },
    });
  });

  it("replaces a non-object active-sessions value", () => {
    mutateSessionStateStore(path, (store) => {
      store["active-workspaces"]["/w"] = {
        "active-sessions": "garbage",
        pinned: true,
      } as unknown as WorkspaceStateEntry;
      return true;
    });

    addActiveSession(path, "/w", "s1");

    expect(readWritten()["active-workspaces"]["/w"]).toEqual({
      "active-sessions": { s1: { lock: false } },
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
  it("deletes the entries, dropping their lock and state", () => {
    mutateSessionStateStore(path, (store) => {
      store["active-workspaces"]["/w"] = {
        "active-sessions": { s1: { state: "running" }, s2: { lock: false } },
      };
      return true;
    });

    const result = archiveSessions(path, [
      { sessionId: "s1", cwd: "/w" },
      { sessionId: "s2", cwd: "/w" },
    ]);

    expect(result.ok).toBe(true);
    expect(readWritten()["active-workspaces"]["/w"]).toEqual({ "active-sessions": {} });
  });

  it("skips locked sessions and archives the rest", () => {
    mutateSessionStateStore(path, (store) => {
      store["active-workspaces"]["/w"] = {
        "active-sessions": {
          locked1: { lock: true },
          locked2: { lock: true },
          open: { state: "running" },
        },
      };
      return true;
    });

    const result = archiveSessions(path, [
      { sessionId: "locked1", cwd: "/w" },
      { sessionId: "locked2", cwd: "/w" },
      { sessionId: "open", cwd: "/w" },
    ]);

    expect(result.ok).toBe(true);
    expect(readWritten()["active-workspaces"]["/w"]["active-sessions"]).toEqual({
      locked1: { lock: true },
      locked2: { lock: true },
    });
  });

  it("writes nothing when no session is a member", () => {
    const result = archiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    seed("{oops");

    const result = archiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });
});

describe("unarchiveSessions", () => {
  it("creates missing entries with lock false and keeps existing entries", () => {
    mutateSessionStateStore(path, (store) => {
      store["active-workspaces"]["/w"] = {
        "active-sessions": {
          s1: { lock: true, state: "running", note: "keep" },
          s2: { lock: false },
        },
      };
      return true;
    });

    const result = unarchiveSessions(path, [
      { sessionId: "s1", cwd: "/w" },
      { sessionId: "s3", cwd: "/w" },
    ]);

    expect(result.ok).toBe(true);
    expect(readWritten()["active-workspaces"]["/w"]["active-sessions"]).toEqual({
      s1: { lock: true, state: "running", note: "keep" },
      s2: { lock: false },
      s3: { lock: false },
    });
  });

  it("creates the workspace entry when missing", () => {
    const result = unarchiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(true);
    expect(readWritten()["active-workspaces"]["/w"]["active-sessions"]).toEqual({
      s1: { lock: false },
    });
  });

  it("writes nothing when every session is already listed", () => {
    addActiveSession(path, "/w", "s1");
    const before = readFileSync(path, "utf8");

    const result = unarchiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    seed("{oops");

    const result = unarchiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });
});

describe("setSessionLocks", () => {
  it("sets and clears locks in one write, keeping state and unknown fields", () => {
    mutateSessionStateStore(path, (store) => {
      store["active-workspaces"]["/w"] = {
        "active-sessions": {
          s1: { state: "running" },
          s2: { lock: true, note: "keep" },
        },
      };
      return true;
    });

    const result = setSessionLocks(path, [
      { sessionId: "s1", cwd: "/w", locked: true },
      { sessionId: "s2", cwd: "/w", locked: false },
    ]);

    expect(result.ok).toBe(true);
    expect(readWritten()["active-workspaces"]["/w"]["active-sessions"]).toEqual({
      s1: { lock: true, state: "running" },
      s2: { lock: false, note: "keep" },
    });
  });

  it("locks a non-member by creating its entry with lock true, making it active", () => {
    const result = setSessionLocks(path, [{ sessionId: "s1", cwd: "/w", locked: true }]);

    expect(result.ok).toBe(true);
    expect(readWritten()["active-workspaces"]["/w"]["active-sessions"]).toEqual({
      s1: { lock: true },
    });
  });

  it("writes nothing when unlocking a non-member", () => {
    const result = setSessionLocks(path, [{ sessionId: "s1", cwd: "/w", locked: false }]);

    expect(result.ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("writes nothing when the lock states already match", () => {
    addActiveSession(path, "/w", "s1");
    const before = readFileSync(path, "utf8");

    const result = setSessionLocks(path, [{ sessionId: "s1", cwd: "/w", locked: false }]);

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    seed("{oops");

    const result = setSessionLocks(path, [{ sessionId: "s1", cwd: "/w", locked: true }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });
});
