import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSessionIds,
  readMetadataStore,
  setSessionActive,
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

describe("activeSessionIds", () => {
  it("collects only sessions whose active attribute is truthy", () => {
    const data = JSON.parse(
      '{"sessions": {"a": {"active": true}, "b": {"active": false}, "c": {}, "d": 3}}',
    ) as MetadataStoreData;
    expect(activeSessionIds(data)).toEqual(new Set(["a"]));
  });

  it("treats missing metadata as no active sessions", () => {
    expect(activeSessionIds(undefined)).toEqual(new Set());
  });
});
