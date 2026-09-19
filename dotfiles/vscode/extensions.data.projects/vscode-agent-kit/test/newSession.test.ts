import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import type { SessionHeaderInfo } from "../src/sessionFile";
import {
  CLOCK_SKEW_MS,
  headerStartMs,
  isLaunchedSession,
  newSessionCandidates,
  resolveLaunchCwd,
  type LaunchUri,
} from "../src/newSession";
import { cleanup, tempDir, writeJsonl } from "./fixtures";

describe("resolveLaunchCwd", () => {
  const fileUri = (fsPath: string): LaunchUri => ({ scheme: "file", fsPath });

  it("returns the first file-scheme workspace folder", () => {
    const cwd = resolveLaunchCwd({
      workspaceFolders: [{ uri: fileUri("/home/user/project") }],
      activeDocumentUri: fileUri("/elsewhere/note.txt"),
      homeDir: "/home/user",
    });
    expect(cwd).toBe("/home/user/project");
  });

  it("skips non-file workspace folders and uses the next file one", () => {
    const cwd = resolveLaunchCwd({
      workspaceFolders: [{ uri: { scheme: "vscode-vfs", fsPath: "/" } }, { uri: fileUri("/home/user/project") }],
      activeDocumentUri: undefined,
      homeDir: "/home/user",
    });
    expect(cwd).toBe("/home/user/project");
  });

  it("falls back to the active document's directory when no folder has the file scheme", () => {
    const cwd = resolveLaunchCwd({
      workspaceFolders: [{ uri: { scheme: "vscode-vfs", fsPath: "/" } }],
      activeDocumentUri: fileUri("/home/user/docs/note.txt"),
      homeDir: "/home/user",
    });
    expect(cwd).toBe("/home/user/docs");
  });

  it("falls back to home when the active document is not a file either", () => {
    const cwd = resolveLaunchCwd({
      workspaceFolders: undefined,
      activeDocumentUri: { scheme: "untitled", fsPath: "Untitled-1" },
      homeDir: "/home/user",
    });
    expect(cwd).toBe("/home/user");
  });

  it("falls back to home when no source is available", () => {
    const cwd = resolveLaunchCwd({ workspaceFolders: undefined, activeDocumentUri: undefined, homeDir: "/home/user" });
    expect(cwd).toBe("/home/user");
  });
});

describe("headerStartMs", () => {
  it("parses an ISO timestamp into epoch milliseconds", () => {
    expect(headerStartMs("2024-12-03T14:00:00.000Z")).toBe(1_733_234_400_000);
  });

  it("returns undefined for a missing timestamp", () => {
    expect(headerStartMs(undefined)).toBeUndefined();
  });

  it("returns undefined for an unparseable timestamp", () => {
    expect(headerStartMs("not a date")).toBeUndefined();
  });
});

describe("newSessionCandidates", () => {
  let root: string;
  let groupDir: string;

  beforeEach(async () => {
    root = await tempDir("pi-new-session-test-");
    groupDir = join(root, "--home-user-project--");
  });

  afterEach(async () => {
    await cleanup(root);
  });

  async function writeSession(name: string, mtimeMs: number): Promise<string> {
    const filePath = await writeJsonl(groupDir, name, []);
    await utimes(filePath, new Date(mtimeMs), new Date(mtimeMs));
    return filePath;
  }

  it("returns unknown session files, newest mtime first", async () => {
    const older = await writeSession("t1_old.jsonl", 1_000);
    const newer = await writeSession("t2_new.jsonl", 2_000);
    expect(await newSessionCandidates(groupDir, new Set())).toEqual([newer, older]);
  });

  it("excludes files that already existed at launch time", async () => {
    await writeSession("t1_known.jsonl", 1_000);
    const fresh = await writeSession("t2_fresh.jsonl", 2_000);
    expect(await newSessionCandidates(groupDir, new Set(["t1_known.jsonl"]))).toEqual([fresh]);
  });

  it("returns an empty list when the group directory does not exist", async () => {
    expect(await newSessionCandidates(join(root, "missing"), new Set())).toEqual([]);
  });

  it("ignores non-jsonl files and files inside subdirectories", async () => {
    await writeJsonl(groupDir, "notes.txt", []);
    await writeJsonl(join(groupDir, "nested"), "t1_inside.jsonl", []);
    const only = await writeSession("t1_real.jsonl", 1_000);
    expect(await newSessionCandidates(groupDir, new Set())).toEqual([only]);
  });
});

describe("isLaunchedSession", () => {
  const launchedAtMs = 1_733_234_400_000;

  function header(overrides: Partial<SessionHeaderInfo> = {}): SessionHeaderInfo {
    return {
      id: "new-id",
      cwd: "/home/user/project",
      timestamp: "2024-12-03T14:00:01.000Z",
      ...overrides,
    };
  }

  function match(overrides: Partial<{ cwd: string; isClaimed: (id: string) => boolean }> = {}) {
    return {
      cwd: "/home/user/project",
      launchedAtMs,
      isClaimed: () => false,
      ...overrides,
    };
  }

  it("accepts a session started in the launch cwd after the launch", () => {
    expect(isLaunchedSession(header(), match())).toBe(true);
  });

  it("rejects a session id already claimed by another launch", () => {
    expect(isLaunchedSession(header(), match({ isClaimed: (id) => id === "new-id" }))).toBe(false);
  });

  it("rejects a session whose header cwd is a different directory", () => {
    expect(isLaunchedSession(header({ cwd: "/home/user/other" }), match())).toBe(false);
  });

  it("matches the cwd by resolved path, not exact spelling", () => {
    expect(isLaunchedSession(header({ cwd: "/home/user/project" }), match({ cwd: "/home/user/project/" }))).toBe(true);
  });

  it("rejects a pre-existing session whose header predates the launch beyond the clock skew", () => {
    const stale = header({ timestamp: new Date(launchedAtMs - CLOCK_SKEW_MS - 1).toISOString() });
    expect(isLaunchedSession(stale, match())).toBe(false);
  });

  it("accepts a session whose header timestamp is within the clock skew before the launch", () => {
    const slightlyEarly = header({ timestamp: new Date(launchedAtMs - CLOCK_SKEW_MS).toISOString() });
    expect(isLaunchedSession(slightlyEarly, match())).toBe(true);
  });

  it("accepts a session whose header has no timestamp", () => {
    expect(isLaunchedSession(header({ timestamp: undefined }), match())).toBe(true);
  });
});
