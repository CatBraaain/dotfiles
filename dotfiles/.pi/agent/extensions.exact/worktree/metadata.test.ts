import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  DECLARATIONS_ENTRY_TYPE,
  getDeclarations,
  getWorkspaces,
  saveWorkspaces,
  WORKSPACES_ENTRY_TYPE,
} from "./metadata.ts";

describe("session worktree declarations", () => {
  it("rejects malformed latest snapshots instead of falling back to earlier declarations", () => {
    const manager = createSession();
    const live = { name: "live", path: "/worktrees/app/live" };
    const second = { name: "other", path: "/worktrees/app/other" };
    manager.appendCustomEntry(DECLARATIONS_ENTRY_TYPE, { worktrees: [live] });
    assert.deepEqual(getDeclarations(manager), [live]);
    for (const worktrees of [
      [live, { ...second, name: live.name }],
      [live, { ...second, path: live.path }],
      [{ ...live, path: "../live" }],
      [{ ...live, path: "/worktrees/../live" }],
      [{ ...live, name: "wt-copilot-conflict" }],
      [{ ...live, path: "/worktrees/with\0nul" }],
    ]) {
      manager.appendCustomEntry(DECLARATIONS_ENTRY_TYPE, { worktrees });
      assert.throws(() => getDeclarations(manager), /Invalid worktrees in custom entry/);
    }
  });
});

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
    const update = saveWorkspaces(writer(manager), manager, getWorkspaces(manager));
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
    const update = saveWorkspaces(writer(manager), manager, ["/worktree"]);
    const after = readFileSync(path);
    const appended = after.subarray(before.length).toString("utf8").trim().split("\n");
    assert.deepEqual(after.subarray(0, before.length), before);
    assert.equal(appended.length, 1);
    assert.deepEqual(JSON.parse(appended[0]!), manager.getEntries().at(-1));
    assert.equal(JSON.parse(appended[0]!).type, "custom");
    assert.equal(JSON.parse(appended[0]!).customType, WORKSPACES_ENTRY_TYPE);
    assert.deepEqual(JSON.parse(appended[0]!).data, { workspaces: ["/worktree"] });
    assert.deepEqual(manager.getHeader(), header);
    assert.deepEqual(update, { changed: true, workspaces: ["/worktree"] });
  });

  it("leaves initial persistence to the core and includes metadata in its first flush", () => {
    const manager = createSession();
    const header = structuredClone(manager.getHeader());
    saveWorkspaces(writer(manager), manager, ["/worktree"]);
    assert.equal(existsSync(manager.getSessionFile()!), false);
    const path = persistSession(manager);
    const entries = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(entries[0], JSON.parse(JSON.stringify(header)));
    assert.deepEqual(entries[1].data, { workspaces: ["/worktree"] });
    assert.deepEqual(getWorkspaces(SessionManager.open(path)), ["/worktree"]);
  });

  it("stores in-memory metadata through the same custom entry API", () => {
    const manager = SessionManager.inMemory();
    const update = saveWorkspaces(writer(manager), manager, ["/b", "/a", "/b"]);
    assert.deepEqual(update, { changed: true, workspaces: ["/b", "/a"] });
    assert.deepEqual(getWorkspaces(manager), ["/b", "/a"]);
    assert.equal(manager.getSessionFile(), undefined);
  });

  it("does not append a snapshot for an equal list", () => {
    const manager = createSession();
    const api = writer(manager);
    const path = persistSession(manager);
    saveWorkspaces(api, manager, ["/worktree"]);
    const before = readFileSync(path);
    const update = saveWorkspaces(api, manager, ["/worktree", "/worktree"]);
    assert.deepEqual(update, { changed: false, workspaces: ["/worktree"] });
    assert.deepEqual(readFileSync(path), before);
  });

  it("appends an empty snapshot when the last association is removed", () => {
    const manager = createSession();
    const api = writer(manager);
    saveWorkspaces(api, manager, ["/worktree"]);
    saveWorkspaces(api, manager, []);
    assert.deepEqual(getWorkspaces(manager), []);
    assert.deepEqual(manager.getEntries().at(-1)?.type, "custom");
    assert.equal(manager.getEntries().length, 2);
  });

  it("takes the last matching custom entry rather than the last line or notification", () => {
    const manager = createSession();
    const api = writer(manager);
    saveWorkspaces(api, manager, ["/first"]);
    manager.appendCustomEntry("other-extension", { workspaces: ["/unrelated"] });
    saveWorkspaces(api, manager, ["/second"]);
    manager.appendCustomMessageEntry("session-worktrees", "notice", true, {
      workspaces: ["/not-state"],
    });
    manager.appendThinkingLevelChange("off");
    assert.deepEqual(getWorkspaces(manager), ["/second"]);
  });

  it("keeps the newest session-wide snapshot after moving to an older conversation branch", () => {
    const manager = createSession();
    const api = writer(manager);
    persistSession(manager);
    const branchPoint = manager.getLeafId()!;
    saveWorkspaces(api, manager, ["/first"]);
    manager.branch(branchPoint);
    saveWorkspaces(api, manager, ["/second"]);
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
    saveWorkspaces(api, manager, ["/first"]);
    manager.branch(branchPoint);
    saveWorkspaces(api, manager, [...getWorkspaces(manager), "/second"]);
    const reopened = SessionManager.open(path);
    assert.deepEqual(getWorkspaces(reopened), ["/first", "/second"]);
    saveWorkspaces(writer(reopened), reopened, [...getWorkspaces(reopened), "/third"]);
    assert.deepEqual(getWorkspaces(SessionManager.open(path)), ["/first", "/second", "/third"]);
  });

  it("does not share snapshot arrays with callers", () => {
    const manager = createSession();
    const paths = ["/worktree"];
    const update = saveWorkspaces(writer(manager), manager, paths);
    paths.push("/input");
    update.workspaces.push("/result");
    getWorkspaces(manager).push("/read");
    assert.deepEqual(getWorkspaces(manager), ["/worktree"]);
  });

  for (const data of [
    undefined,
    { workspaces: "invalid" },
    { workspaces: ["relative"] },
    { workspaces: ["/duplicate", "/duplicate"] },
    { workspaces: ["/nul\0path"] },
  ]) {
    it(`rejects malformed latest metadata without falling back: ${JSON.stringify(data)}`, () => {
      const manager = createSession();
      saveWorkspaces(writer(manager), manager, ["/valid"]);
      manager.appendCustomEntry(WORKSPACES_ENTRY_TYPE, data);
      assert.throws(() => getWorkspaces(manager), /Invalid workspaces in custom entry/);
    });
  }

  for (const path of ["relative", "", "/nul\0path"]) {
    it(`rejects an invalid path before calling the entry API: ${JSON.stringify(path)}`, () => {
      const manager = createSession();
      assert.throws(() => saveWorkspaces(writer(manager), manager, [path]), /absolute paths/);
      assert.deepEqual(manager.getEntries(), []);
    });
  }

  it("propagates an entry API failure without returning success", () => {
    const manager = createSession();
    saveWorkspaces(writer(manager), manager, ["/old"]);
    const failingApi = {
      appendEntry(): void {
        throw new Error("Fixture append failure");
      },
    };
    assert.throws(() => saveWorkspaces(failingApi, manager, ["/new"]), /Fixture append failure/);
    assert.deepEqual(getWorkspaces(manager), ["/old"]);
  });

  it("opens independent session snapshots without reading or updating another session", () => {
    const first = createSession();
    const firstFile = persistSession(first);
    saveWorkspaces(writer(first), first, ["/first"]);
    const second = createSession();
    const secondFile = persistSession(second);
    saveWorkspaces(writer(second), second, ["/second"]);
    const secondBefore = readFileSync(secondFile);
    const reopenedFirst = SessionManager.open(firstFile);
    saveWorkspaces(writer(reopenedFirst), reopenedFirst, ["/updated"]);
    assert.deepEqual(getWorkspaces(SessionManager.open(firstFile)), ["/updated"]);
    assert.deepEqual(getWorkspaces(SessionManager.open(secondFile)), ["/second"]);
    assert.deepEqual(readFileSync(secondFile), secondBefore);
  });
});
