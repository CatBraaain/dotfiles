import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  archivedSessionIds,
  archiveSessions,
  lockedSessionIds,
  readMetadataStore,
  registeredWorkspaceCwds,
  registerWorkspace,
  unregisterWorkspace,
  setSessionActive,
  setSessionLocked,
  writeMetadataStore,
  type MetadataStoreData,
} from "../src/metadataStore";
import { cleanup, tempDir } from "./fixtures";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await tempDir("pi-metadata-test-");
  path = join(dir, "session-metadata.json");
});

afterEach(async () => {
  await cleanup(dir);
});

function readWritten(): MetadataStoreData {
  const read = readMetadataStore(path);
  if (read.status !== "ok") throw new Error(`expected ok, got ${read.status}`);
  return read.data;
}

describe("readMetadataStore", () => {
  it("returns empty for a missing file", () => {
    expect(readMetadataStore(path)).toEqual({ status: "empty" });
  });

  it("reads a valid store", () => {
    writeFileSync(path, JSON.stringify({ version: 1, sessions: { s1: { active: true } } }), "utf8");
    const read = readMetadataStore(path);
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.data.sessions?.s1).toEqual({ active: true });
    }
  });

  it("returns error for unparseable JSON", () => {
    writeFileSync(path, "{not json", "utf8");
    const read = readMetadataStore(path);
    expect(read.status).toBe("error");
    if (read.status === "error") expect(read.message).toMatch(/JSON/);
  });

  it("returns error when the root is not an object", () => {
    writeFileSync(path, "[1,2]", "utf8");
    expect(readMetadataStore(path).status).toBe("error");
  });

  it("returns error when sessions is not an object", () => {
    writeFileSync(path, JSON.stringify({ version: 1, sessions: 3 }), "utf8");
    expect(readMetadataStore(path).status).toBe("error");
  });
});

describe("setSessionActive", () => {
  it("creates the store on first write with version 1", () => {
    const result = setSessionActive(path, "s1", true);
    expect(result.ok).toBe(true);
    const data = readWritten();
    expect(data.version).toBe(1);
    expect(data.sessions?.s1).toEqual({ active: true });
  });

  it("adds version 1 when an existing store lacked it", () => {
    writeFileSync(path, JSON.stringify({ sessions: { x: { active: true } } }), "utf8");
    setSessionActive(path, "y", true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.version).toBe(1);
  });

  it("deactivating keeps the entry, its other attributes, other sessions, and unknown top-level keys", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        meta: { lastClient: "cli" },
        sessions: {
          s1: { pinned: true, tags: ["a", "b"], active: true },
          s2: { active: false },
        },
      }),
      "utf8",
    );
    const result = setSessionActive(path, "s1", false);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.meta).toEqual({ lastClient: "cli" });
    expect(parsed.sessions.s1).toEqual({ pinned: true, tags: ["a", "b"], active: false });
    expect(parsed.sessions.s2).toEqual({ active: false });
  });

  it("sequential updates follow last-write-wins and keep all sessions", () => {
    setSessionActive(path, "a", true);
    setSessionActive(path, "b", true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.sessions).toEqual({ a: { active: true }, b: { active: true } });
  });

  it("does not write and reports an error when the file is corrupt", () => {
    writeFileSync(path, "{oops", "utf8");
    const result = setSessionActive(path, "s1", true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });

  it("fails on the write path: reports the error, keeps the previous content, and leaves no temp files", () => {
    const original = JSON.stringify({ version: 1, sessions: { s1: { active: false } } });
    writeFileSync(path, original, "utf8");
    chmodSync(dir, 0o500); // a read-only store directory makes the tmp-file write inside writeMetadataStore fail
    try {
      const result = setSessionActive(path, "s2", true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/Failed to write/); // the write step failed, not the read
    } finally {
      chmodSync(dir, 0o700); // restore before afterEach cleanup removes the directory
    }
    expect(readFileSync(path, "utf8")).toBe(original); // the previous content is untouched
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("writeMetadataStore", () => {
  it("replaces the previous content atomically and leaves no temp files", () => {
    writeMetadataStore(path, { version: 1, sessions: { a: { active: true } } });
    writeMetadataStore(path, { version: 1, sessions: { a: { active: false } } });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.sessions.a).toEqual({ active: false });
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("setSessionLocked", () => {
  it("persists the lock while keeping the entry's other attributes", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, sessions: { s1: { active: true, pinned: true } } }),
      "utf8",
    );

    const result = setSessionLocked(path, "s1", true);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.sessions.s1).toEqual({ active: true, pinned: true, locked: true });
  });

  it("unlocks by setting locked to false", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, sessions: { s1: { active: false, locked: true } } }),
      "utf8",
    );

    expect(setSessionLocked(path, "s1", false).ok).toBe(true);

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.sessions.s1).toEqual({ active: false, locked: false });
  });

  it("does not write and reports an error when the file is corrupt", () => {
    writeFileSync(path, "{oops", "utf8");

    const result = setSessionLocked(path, "s1", true);

    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });
});

describe("archiveSessions", () => {
  it("archives every requested session in one write", () => {
    setSessionActive(path, "a", true);

    const result = archiveSessions(path, ["a", "b"]);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.sessions).toEqual({ a: { active: false }, b: { active: false } });
  });

  it("skips locked sessions and archives the rest", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sessions: { locked1: { locked: true }, locked2: { active: true, locked: true }, open: {} },
      }),
      "utf8",
    );

    const result = archiveSessions(path, ["locked1", "locked2", "open"]);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.sessions.locked1).toEqual({ locked: true });
    expect(parsed.sessions.locked2).toEqual({ active: true, locked: true });
    expect(parsed.sessions.open).toEqual({ active: false });
  });

  it("writes nothing when every requested session is locked", () => {
    writeFileSync(path, JSON.stringify({ version: 1, sessions: { s1: { locked: true } } }), "utf8");
    const before = readFileSync(path, "utf8");

    const result = archiveSessions(path, ["s1"]);

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not write and reports an error when the file is corrupt", () => {
    writeFileSync(path, "{oops", "utf8");

    const result = archiveSessions(path, ["s1"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/JSON/);
    expect(readFileSync(path, "utf8")).toBe("{oops"); // untouched
  });

  it("fails on the write path: reports the error, keeps the previous content, and leaves no temp files", () => {
    const original = JSON.stringify({ version: 1, sessions: { s1: { active: true } } });
    writeFileSync(path, original, "utf8");
    chmodSync(dir, 0o500); // a read-only store directory makes the tmp-file write inside writeMetadataStore fail
    try {
      const result = archiveSessions(path, ["s1"]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/Failed to write/);
    } finally {
      chmodSync(dir, 0o700); // restore before afterEach cleanup removes the directory
    }
    expect(readFileSync(path, "utf8")).toBe(original); // the previous content is untouched
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("archives 1000 synthetic sessions in a single write", () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `s-${index}`);

    const result = archiveSessions(path, ids);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const archived = Object.values(parsed.sessions as Record<string, { active?: boolean }>).filter(
      (entry) => entry.active === false,
    );
    expect(archived).toHaveLength(1000);
  });
});

describe("archivedSessionIds and lockedSessionIds", () => {
  it("collects only sessions whose active attribute is explicitly false", () => {
    const data = JSON.parse(
      '{"sessions": {"a": {"active": false}, "b": {"active": true}, "c": {}, "d": 3}}',
    ) as MetadataStoreData;
    expect(archivedSessionIds(data)).toEqual(new Set(["a"]));
  });

  it("collects only sessions whose locked attribute is truthy", () => {
    const data = JSON.parse(
      '{"sessions": {"a": {"locked": true}, "b": {"locked": false}, "c": {}, "d": 3}}',
    ) as MetadataStoreData;
    expect(lockedSessionIds(data)).toEqual(new Set(["a"]));
  });

  it("treats missing metadata as no archived and no locked sessions", () => {
    expect(archivedSessionIds(undefined)).toEqual(new Set());
    expect(lockedSessionIds(undefined)).toEqual(new Set());
  });
});

describe("registerWorkspace", () => {
  it("creates the store with the resolved workspace path and added time", () => {
    const result = registerWorkspace(path, "/home/user/project", 1_000);

    expect(result).toEqual({ ok: true, added: true });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MetadataStoreData;
    expect(parsed.workspaces).toEqual({ "/home/user/project": { addedAtMs: 1_000 } });
    expect(parsed.version).toBe(1);
  });

  it("resolves the stored key and keeps existing sessions and keys", () => {
    writeFileSync(path, JSON.stringify({ version: 1, sessions: { a: { active: false } } }));

    const result = registerWorkspace(path, "/home/user/project/", 2_000);

    expect(result).toEqual({ ok: true, added: true });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MetadataStoreData;
    expect(parsed.sessions).toEqual({ a: { active: false } });
    expect(Object.keys(parsed.workspaces ?? {})).toEqual(["/home/user/project"]);
  });

  it("keeps an existing entry for the same directory without rewriting", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, workspaces: { "/home/user/project": { addedAtMs: 1_000 } } }),
    );
    const original = readFileSync(path, "utf8");

    const result = registerWorkspace(path, "/home/user/project/", 9_000);

    expect(result).toEqual({ ok: true, added: false });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("reports a store read error without writing", () => {
    writeFileSync(path, "not json");

    const result = registerWorkspace(path, "/home/user/project", 1_000);

    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});

describe("unregisterWorkspace", () => {
  it("removes the registration whose key resolves to the cwd", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sessions: { a: { active: false } },
        workspaces: { "/home/user/a": { addedAtMs: 1 }, "/home/user/b": { addedAtMs: 2 } },
      }),
    );

    const result = unregisterWorkspace(path, "/home/user/b/");

    expect(result).toEqual({ ok: true, removed: true });
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MetadataStoreData;
    expect(Object.keys(parsed.workspaces ?? {})).toEqual(["/home/user/a"]);
    expect(parsed.sessions).toEqual({ a: { active: false } });
  });

  it("keeps the file untouched when no registration points at the cwd", () => {
    writeFileSync(path, JSON.stringify({ version: 1, workspaces: { "/home/user/a": {} } }));
    const original = readFileSync(path, "utf8");

    const result = unregisterWorkspace(path, "/home/user/other");

    expect(result).toEqual({ ok: true, removed: false });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("keeps a missing store missing when unregistering", () => {
    const result = unregisterWorkspace(path, "/home/user/a");

    expect(result).toEqual({ ok: true, removed: false });
    expect(existsSync(path)).toBe(false);
  });

  it("reports a store read error without writing", () => {
    writeFileSync(path, "not json");

    const result = unregisterWorkspace(path, "/home/user/a");

    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});

describe("registeredWorkspaceCwds", () => {
  it("lists registered workspace cwds in registration order", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        workspaces: { "/a": { addedAtMs: 1 }, "/b": { addedAtMs: 2 } },
      }),
    );
    const read = readMetadataStore(path);

    expect(registeredWorkspaceCwds(read.status === "ok" ? read.data : undefined)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("treats missing metadata as no registered workspaces", () => {
    expect(registeredWorkspaceCwds(undefined)).toEqual([]);
  });

  it("rejects a store whose workspaces is not an object", () => {
    writeFileSync(path, JSON.stringify({ version: 1, workspaces: ["/a"] }));

    const read = readMetadataStore(path);

    expect(read).toMatchObject({ status: "error" });
    expect(read.status === "error" ? read.message : "").toContain("workspaces");
  });
});
