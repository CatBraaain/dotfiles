import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSessionIds,
  addActiveSession,
  archiveSessions,
  mutateSessionStateStore,
  parseSessionStateStore,
  registerWorkspace,
  registeredWorkspaceCwds,
  unregisterWorkspace,
  readSessionStateStore,
  sessionPhases,
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
    const before = readFileSync(path, "utf8");
    readSessionStateStore(path);
    expect(readFileSync(path, "utf8")).toBe(before);
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
          "/w": { "active-sessions": { s1: { state: "running" } } },
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

  it("removes legacy session locks when registering another workspace", () => {
    seed(
      JSON.stringify({
        "active-workspaces": {
          "/w": { "active-sessions": { s1: { lock: true, state: "running", note: "keep" } } },
        },
      }),
    );
    expect(registerWorkspace(path, "/other")).toEqual({ ok: true, added: true });
    expect(readWritten()).toEqual({
      "active-workspaces": {
        "/w": { "active-sessions": { s1: { state: "running", note: "keep" } } },
        "/other": { "active-sessions": {} },
      },
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
  it("creates the workspace entry and an empty session entry", () => {
    const result = addActiveSession(path, "/w", "s1");

    expect(result.ok).toBe(true);
    expect(readWritten()).toEqual({
      "active-workspaces": { "/w": { "active-sessions": { s1: {} } } },
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
      "active-sessions": { s1: {} },
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
  it("deletes the entries and their phase", () => {
    mutateSessionStateStore(path, (store) => {
      store["active-workspaces"]["/w"] = {
        "active-sessions": { s1: { state: "running" }, s2: {} },
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

  it.each([
    { name: "single", ids: ["s1"], remaining: { s2: { state: "running", note: "keep" }, s3: {} } },
    { name: "batch", ids: ["s1", "s2", "s3"], remaining: {} },
  ])(
    "archives $name requests from legacy lock data and cleans every remaining entry",
    ({ ids, remaining }) => {
      seed(
        JSON.stringify({
          "active-workspaces": {
            "/w": {
              "active-sessions": {
                s1: { lock: true, state: "waiting-approval" },
                s2: { lock: true, state: "running", note: "keep" },
                s3: { lock: false },
              },
              pinned: true,
            },
            "/other": {
              "active-sessions": {
                untouched: { lock: true, state: "waiting-user", tags: ["keep"] },
                invalidLock: { lock: "old", extra: { lock: true } },
              },
              lock: "workspace-field",
            },
          },
          lock: "root-field",
          tags: ["root"],
        }),
      );
      const result = archiveSessions(
        path,
        ids.map((sessionId) => ({ sessionId, cwd: "/w" })),
      );
      const expected = {
        "active-workspaces": {
          "/w": { "active-sessions": remaining, pinned: true },
          "/other": {
            "active-sessions": {
              untouched: { state: "waiting-user", tags: ["keep"] },
              invalidLock: { extra: { lock: true } },
            },
            lock: "workspace-field",
          },
        },
        lock: "root-field",
        tags: ["root"],
      };
      expect(result).toEqual({ ok: true, data: expected });
      expect(readWritten()).toEqual(expected);
    },
  );

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
  it("creates empty entries and keeps other fields while removing legacy locks", () => {
    seed(
      JSON.stringify({
        "active-workspaces": {
          "/w": {
            "active-sessions": {
              s1: { lock: true, state: "running", note: "keep" },
              s2: { lock: false },
            },
          },
        },
      }),
    );

    const result = unarchiveSessions(path, [
      { sessionId: "s1", cwd: "/w" },
      { sessionId: "s3", cwd: "/w" },
    ]);

    expect(result.ok).toBe(true);
    expect(readWritten()["active-workspaces"]["/w"]["active-sessions"]).toEqual({
      s1: { state: "running", note: "keep" },
      s2: {},
      s3: {},
    });
  });

  it("creates the workspace entry when missing", () => {
    const result = unarchiveSessions(path, [{ sessionId: "s1", cwd: "/w" }]);

    expect(result.ok).toBe(true);
    expect(readWritten()["active-workspaces"]["/w"]["active-sessions"]).toEqual({
      s1: {},
    });
  });

  it("writes nothing when every session is already listed", () => {
    seed(
      JSON.stringify({
        "active-workspaces": {
          "/w": { "active-sessions": { s1: { lock: true, state: "running" } } },
        },
      }),
    );
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
