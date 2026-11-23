import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getWorkspaces, saveWorkspaces, WORKSPACES_ENTRY_TYPE } from "./metadata.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories
    .splice(0)
    .forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function createSession(): SessionManager {
  mkdirSync("/tmp/work/dotfiles/session-metadata-custom-qa", { recursive: true });
  const directory = mkdtempSync("/tmp/work/dotfiles/session-metadata-custom-qa/metadata-");
  temporaryDirectories.push(directory);
  return SessionManager.create(directory, join(directory, "sessions"));
}

function writer(manager: SessionManager) {
  return {
    appendEntry(customType: string, data?: unknown): void {
      manager.appendCustomEntry(customType, data);
    },
  };
}

function persistSession(manager: SessionManager): string {
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [],
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  return manager.getSessionFile()!;
}

describe("session worktree custom metadata", () => {
  it("reads a missing snapshot as empty without changing the session", () => {
    const manager = createSession();
    const header = structuredClone(manager.getHeader());
    const update = saveWorkspaces(
      writer(manager),
      manager,
      manager.getSessionId(),
      getWorkspaces(manager),
    );
    assert.deepEqual(update, { changed: false, workspaces: [] });
    assert.deepEqual(manager.getEntries(), []);
    assert.deepEqual(manager.getHeader(), header);
    assert.equal(existsSync(manager.getSessionFile()!), false);
  });

  it("appends a standard custom snapshot while keeping the existing file prefix unchanged", () => {
    const manager = createSession();
    const path = persistSession(manager);
    const before = readFileSync(path);
    const header = structuredClone(manager.getHeader());
    const update = saveWorkspaces(writer(manager), manager, manager.getSessionId(), ["/worktree"]);
    const after = readFileSync(path);
    const appended = after.subarray(before.length).toString("utf8").trim().split("\n");
    assert.deepEqual(after.subarray(0, before.length), before);
    assert.equal(appended.length, 1);
    assert.deepEqual(JSON.parse(appended[0]!), manager.getEntries().at(-1));
    assert.equal(JSON.parse(appended[0]!).type, "custom");
    assert.equal(JSON.parse(appended[0]!).customType, WORKSPACES_ENTRY_TYPE);
    assert.deepEqual(JSON.parse(appended[0]!).data, {
      sessionId: manager.getSessionId(),
      workspaces: ["/worktree"],
    });
    assert.deepEqual(manager.getHeader(), header);
    assert.deepEqual(update, { changed: true, workspaces: ["/worktree"] });
  });

  it("leaves initial persistence to the core and includes metadata in its first flush", () => {
    const manager = createSession();
    const header = structuredClone(manager.getHeader());
    saveWorkspaces(writer(manager), manager, manager.getSessionId(), ["/worktree"]);
    assert.equal(existsSync(manager.getSessionFile()!), false);
    const path = persistSession(manager);
    const entries = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(entries[0], JSON.parse(JSON.stringify(header)));
    assert.deepEqual(entries[1].data, {
      sessionId: manager.getSessionId(),
      workspaces: ["/worktree"],
    });
    assert.deepEqual(getWorkspaces(SessionManager.open(path)), ["/worktree"]);
  });

  it("stores in-memory metadata through the same custom entry API", () => {
    const manager = SessionManager.inMemory();
    const update = saveWorkspaces(writer(manager), manager, manager.getSessionId(), [
      "/b",
      "/a",
      "/b",
    ]);
    assert.deepEqual(update, { changed: true, workspaces: ["/b", "/a"] });
    assert.deepEqual(getWorkspaces(manager), ["/b", "/a"]);
    assert.equal(manager.getSessionFile(), undefined);
  });

  it("does not append a snapshot for an equal list", () => {
    const manager = createSession();
    const api = writer(manager);
    const path = persistSession(manager);
    saveWorkspaces(api, manager, manager.getSessionId(), ["/worktree"]);
    const before = readFileSync(path);
    const update = saveWorkspaces(api, manager, manager.getSessionId(), ["/worktree", "/worktree"]);
    assert.deepEqual(update, { changed: false, workspaces: ["/worktree"] });
    assert.deepEqual(readFileSync(path), before);
  });

  it("appends an empty snapshot when the last association is removed", () => {
    const manager = createSession();
    const api = writer(manager);
    saveWorkspaces(api, manager, manager.getSessionId(), ["/worktree"]);
    saveWorkspaces(api, manager, manager.getSessionId(), []);
    assert.deepEqual(getWorkspaces(manager), []);
    assert.deepEqual(manager.getEntries().at(-1)?.type, "custom");
    assert.equal(manager.getEntries().length, 2);
  });

  it("takes the last matching custom entry rather than the last line or notification", () => {
    const manager = createSession();
    const api = writer(manager);
    saveWorkspaces(api, manager, manager.getSessionId(), ["/first"]);
    manager.appendCustomEntry("other-extension", { workspaces: ["/unrelated"] });
    saveWorkspaces(api, manager, manager.getSessionId(), ["/second"]);
    manager.appendCustomMessageEntry("session-worktrees", "notice", true, {
      workspaces: ["/not-state"],
    });
    manager.appendThinkingLevelChange("off");
    assert.deepEqual(getWorkspaces(manager), ["/second"]);
  });

  it("ignores legacy entries and other owners even when appended after the latest owned snapshot", () => {
    const manager = createSession();
    const id = manager.getSessionId();
    manager.appendCustomEntry(WORKSPACES_ENTRY_TYPE, { workspaces: ["/legacy"] });
    manager.appendCustomEntry("session-worktree-declarations", {
      sessionId: id,
      worktrees: [{ name: "legacy", path: "/legacy" }],
    });
    assert.deepEqual(getWorkspaces(manager), []);
    saveWorkspaces(writer(manager), manager, id, ["/owned"]);
    manager.appendCustomEntry(WORKSPACES_ENTRY_TYPE, {
      sessionId: "another-session",
      workspaces: [],
    });
    manager.appendCustomEntry(WORKSPACES_ENTRY_TYPE, { workspaces: "invalid legacy metadata" });
    assert.deepEqual(getWorkspaces(manager), ["/owned"]);
  });

  it("does not inherit copied snapshots and writes the new owner in a real fork", () => {
    const source = createSession();
    const sourceFile = persistSession(source);
    saveWorkspaces(writer(source), source, source.getSessionId(), ["/source"]);
    const sourceBefore = readFileSync(sourceFile);

    const fork = SessionManager.forkFrom(sourceFile, source.getCwd(), source.getSessionDir());
    const forkId = fork.getSessionId();
    assert.notEqual(forkId, source.getSessionId());
    assert.deepEqual(fork.getEntries(), source.getEntries());
    assert.deepEqual(getWorkspaces(fork), []);

    saveWorkspaces(writer(fork), fork, forkId, ["/fork"]);
    assert.deepEqual(getWorkspaces(SessionManager.open(fork.getSessionFile()!)), ["/fork"]);
    const last = fork.getEntries().at(-1);
    assert.ok(last?.type === "custom");
    assert.deepEqual(last.data, { sessionId: forkId, workspaces: ["/fork"] });
    assert.deepEqual(readFileSync(sourceFile), sourceBefore);
  });

  it("keeps the newest session-wide snapshot after moving to an older conversation branch", () => {
    const manager = createSession();
    const api = writer(manager);
    persistSession(manager);
    const branchPoint = manager.getLeafId()!;
    saveWorkspaces(api, manager, manager.getSessionId(), ["/first"]);
    manager.branch(branchPoint);
    saveWorkspaces(api, manager, manager.getSessionId(), ["/second"]);
    manager.branch(branchPoint);
    assert.equal(
      manager.getBranch().some((entry) => entry.type === "custom"),
      false,
    );
    assert.deepEqual(getWorkspaces(manager), ["/second"]);
  });

  it("continues updating from the latest snapshot after branch movement and reopen", () => {
    const manager = createSession();
    const api = writer(manager);
    const path = persistSession(manager);
    const branchPoint = manager.getLeafId()!;
    saveWorkspaces(api, manager, manager.getSessionId(), ["/first"]);
    manager.branch(branchPoint);
    saveWorkspaces(api, manager, manager.getSessionId(), [...getWorkspaces(manager), "/second"]);
    const reopened = SessionManager.open(path);
    assert.deepEqual(getWorkspaces(reopened), ["/first", "/second"]);
    saveWorkspaces(writer(reopened), reopened, reopened.getSessionId(), [
      ...getWorkspaces(reopened),
      "/third",
    ]);
    assert.deepEqual(getWorkspaces(SessionManager.open(path)), ["/first", "/second", "/third"]);
  });

  it("does not share snapshot arrays with callers", () => {
    const manager = createSession();
    const paths = ["/worktree"];
    const update = saveWorkspaces(writer(manager), manager, manager.getSessionId(), paths);
    paths.push("/input");
    update.workspaces.push("/result");
    getWorkspaces(manager).push("/read");
    assert.deepEqual(getWorkspaces(manager), ["/worktree"]);
  });

  for (const workspaces of [
    undefined,
    "invalid",
    [""],
    ["relative"],
    ["/duplicate", "/duplicate"],
    ["/nul\0path"],
  ]) {
    it(`rejects malformed latest owned metadata without falling back: ${JSON.stringify(workspaces)}`, () => {
      const manager = createSession();
      saveWorkspaces(writer(manager), manager, manager.getSessionId(), ["/valid"]);
      manager.appendCustomEntry(WORKSPACES_ENTRY_TYPE, {
        sessionId: manager.getSessionId(),
        workspaces,
      });
      assert.throws(() => getWorkspaces(manager), /Invalid workspaces in custom entry/);
    });
  }

  for (const path of ["relative", "", "/nul\0path"]) {
    it(`rejects an invalid path before calling the entry API: ${JSON.stringify(path)}`, () => {
      const manager = createSession();
      assert.throws(
        () => saveWorkspaces(writer(manager), manager, manager.getSessionId(), [path]),
        /absolute paths/,
      );
      assert.deepEqual(manager.getEntries(), []);
    });
  }

  it("propagates an entry API failure without returning success", () => {
    const manager = createSession();
    saveWorkspaces(writer(manager), manager, manager.getSessionId(), ["/old"]);
    const failingApi = {
      appendEntry(): void {
        throw new Error("Fixture append failure");
      },
    };
    assert.throws(
      () => saveWorkspaces(failingApi, manager, manager.getSessionId(), ["/new"]),
      /Fixture append failure/,
    );
    assert.deepEqual(getWorkspaces(manager), ["/old"]);
  });

  it("opens independent session snapshots without reading or updating another session", () => {
    const first = createSession();
    const firstFile = persistSession(first);
    saveWorkspaces(writer(first), first, first.getSessionId(), ["/first"]);
    const second = createSession();
    const secondFile = persistSession(second);
    saveWorkspaces(writer(second), second, second.getSessionId(), ["/second"]);
    const secondBefore = readFileSync(secondFile);
    const reopenedFirst = SessionManager.open(firstFile);
    saveWorkspaces(writer(reopenedFirst), reopenedFirst, reopenedFirst.getSessionId(), [
      "/updated",
    ]);
    assert.deepEqual(getWorkspaces(SessionManager.open(firstFile)), ["/updated"]);
    assert.deepEqual(getWorkspaces(SessionManager.open(secondFile)), ["/second"]);
    assert.deepEqual(readFileSync(secondFile), secondBefore);
  });
});
