import { expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { SessionScmSelection } from "../src/session-scm";
import type { ExecFile } from "../src/git-worktrees";

const MAIN = "/repo";
const LINKED = "/linked";
const OWNED = "/owned";
const REPLACED = "/replaced";
const COMMON = "/repo/.git\n";
const SESSION_FILE = "/sessions/2026-11-23T13-07-05-610Z_s1.jsonl";

function setup() {
  const sessionWorktrees = vi.fn<(id: string, cwd: string) => Promise<string[] | undefined>>(
    async () => [],
  );
  const isSessionUnsaved = vi.fn(async (_id: string) => false);
  const worktrees = new Set([MAIN, LINKED, OWNED, REPLACED]);
  const detected = new Set([MAIN, LINKED, OWNED]);
  const selectRepositories = vi.fn<(paths: string[]) => Promise<unknown>>(async () => "applied");
  const log = vi.fn();
  const execFile = vi.fn<ExecFile>(async (_command, args, { cwd }) => {
    if (args[0] === "worktree") {
      const stdout = [...worktrees].map((path) => `worktree ${path}\0HEAD 123\0\0`).join("");
      return { stdout };
    }
    if (args.includes("--show-toplevel")) {
      return { stdout: cwd.startsWith(LINKED) ? `${LINKED}\n` : `${MAIN}\n` };
    }
    if (args.includes("--show-prefix")) {
      return { stdout: cwd === REPLACED ? "/other/.git\n\n" : `${COMMON}\n` };
    }
    return { stdout: COMMON };
  });
  const selection = new SessionScmSelection({
    sessionWorktrees,
    isSessionUnsaved,
    execFile,
    detectedRoots: () => [...detected],
    selectRepositories,
    log,
  });
  return {
    selection,
    sessionWorktrees,
    isSessionUnsaved,
    worktrees,
    detected,
    execFile,
    selectRepositories,
    log,
  };
}

it("uses ID-based metadata and selects only existing worktrees from the session repository", async () => {
  const { selection, sessionWorktrees, selectRepositories } = setup();
  const cwd = `${LINKED}/subdirectory`;
  sessionWorktrees.mockResolvedValue([MAIN, LINKED, OWNED, REPLACED, "/foreign"]);
  selection.track({ sessionId: "s1", cwd });
  await selection.refresh();
  expect(sessionWorktrees).toHaveBeenCalledWith("s1", cwd);
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED, OWNED]]]);
});

it("does not infer ownership from the linked working directory", async () => {
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: LINKED });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]]]);
});

it("restores ownership when the same session ID resumes", async () => {
  const { selection, sessionWorktrees, selectRepositories } = setup();
  sessionWorktrees.mockResolvedValue([LINKED]);
  selection.track({ sessionId: "s1", cwd: MAIN });
  await selection.refresh();
  selection.track(undefined);
  await selection.refresh();
  selection.track({ sessionId: "s1", cwd: MAIN });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED]], [[MAIN, LINKED]]]);
});

it("rereads metadata when the archived session file changes and respects an empty list", async () => {
  const { selection, sessionWorktrees, selectRepositories } = setup();
  const id = "s_1";
  const archiveFile = `/sessions/archive/2026-11-23T13-07-05-610Z_${id}.jsonl`;
  sessionWorktrees.mockResolvedValue([OWNED]);
  selection.track({ sessionId: id, cwd: MAIN });
  await selection.refresh();

  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]]]);

  let finishUpdate!: () => void;
  const updated = new Promise<void>((resolve) => {
    finishUpdate = resolve;
  });
  selectRepositories.mockImplementationOnce(async () => {
    finishUpdate();
    return "applied";
  });
  sessionWorktrees.mockResolvedValue([]);
  selection.onSessionFileChanged(archiveFile);
  await updated;
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]], [[MAIN]]]);
});

it("only rereads a known custom-named session file when the matching file changes", async () => {
  const { selection, sessionWorktrees, selectRepositories } = setup();
  const activeFile = { id: "s1", file: "/sessions/live.jsonl", isSaved: true };
  const savedFile = { id: "s1", file: "/sessions/archive/history.jsonl", isSaved: true };
  selection.track({ sessionId: "s1", cwd: MAIN });
  selection.updateSessionFiles([activeFile, savedFile]);
  await selection.refresh();
  sessionWorktrees.mockClear().mockResolvedValue([OWNED]);

  selection.updateSessionFiles([savedFile, activeFile]);
  selection.onSessionFileChanged("/sessions/another.jsonl");
  await selection.refresh();
  expect(sessionWorktrees).not.toHaveBeenCalled();

  selection.onSessionFileChanged(savedFile.file);
  await selection.refresh();
  expect(sessionWorktrees).toHaveBeenCalledOnce();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]], [[MAIN, OWNED]]]);
});

it("excludes an owned worktree removed since the last detection", async () => {
  const { selection, sessionWorktrees, worktrees, selectRepositories } = setup();
  sessionWorktrees.mockResolvedValue([OWNED]);
  selection.track({ sessionId: "s1", cwd: MAIN });
  await selection.refresh();
  worktrees.delete(OWNED);
  await selection.refresh();
  expect(sessionWorktrees).toHaveBeenCalledOnce();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]], [[MAIN]]]);
});

it("keeps the current SCM selection on a metadata error even for an unsaved running session", async () => {
  const { selection, sessionWorktrees, isSessionUnsaved, selectRepositories, log } = setup();
  sessionWorktrees.mockRejectedValue(new Error("Invalid pi-mux metadata response"));
  isSessionUnsaved.mockResolvedValue(true);
  selection.track({ sessionId: "s1", cwd: MAIN });
  await selection.refresh();
  expect(selectRepositories).not.toHaveBeenCalled();
  expect(isSessionUnsaved).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Invalid pi-mux metadata response"));
});

it("uses only the main worktree before a running session saves its first metadata", async () => {
  const { selection, sessionWorktrees, isSessionUnsaved, selectRepositories } = setup();
  sessionWorktrees.mockResolvedValue(undefined);
  isSessionUnsaved.mockResolvedValue(true);
  selection.track({ sessionId: "s1", cwd: LINKED });
  await selection.refresh();
  expect(isSessionUnsaved).toHaveBeenCalledWith("s1");
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]]]);

  await selection.refresh();
  expect(sessionWorktrees).toHaveBeenCalledOnce();
  expect(isSessionUnsaved).toHaveBeenCalledOnce();

  sessionWorktrees.mockResolvedValue([OWNED]);
  selection.onSessionFileChanged(SESSION_FILE);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]], [[MAIN, OWNED]]]);
});

it("refreshes when the active list reports the first save without a file event", async () => {
  const { selection, sessionWorktrees, isSessionUnsaved, selectRepositories } = setup();
  const pending = { id: "s1", file: SESSION_FILE, isSaved: false };
  sessionWorktrees.mockResolvedValue(undefined);
  isSessionUnsaved.mockResolvedValue(true);
  selection.track({ sessionId: "s1", cwd: MAIN });
  selection.updateSessionFiles([pending]);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]]]);

  sessionWorktrees.mockResolvedValue([OWNED]);
  selection.updateSessionFiles([{ ...pending, isSaved: true }]);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]], [[MAIN, OWNED]]]);
});

it("keeps the current SCM selection if missing metadata is not for an unsaved running session", async () => {
  const { selection, sessionWorktrees, selectRepositories, log } = setup();
  sessionWorktrees.mockResolvedValue(undefined);
  selection.track({ sessionId: "s1", cwd: MAIN });
  await selection.refresh();
  expect(selectRepositories).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Saved session metadata is missing"));
});

it("remembers a successful lookup invalidated by a file event for the same selection", async () => {
  const { selection, sessionWorktrees, isSessionUnsaved, selectRepositories, log } = setup();
  let completeLookup!: (worktrees: string[]) => void;
  const lookupStarted = new Promise<void>((started) => {
    sessionWorktrees.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          completeLookup = complete;
          started();
        }),
    );
  });
  sessionWorktrees.mockResolvedValue(undefined);
  isSessionUnsaved.mockResolvedValue(true);
  selection.track({ sessionId: "s1", cwd: MAIN });
  await lookupStarted;
  selection.onSessionFileChanged(SESSION_FILE);
  completeLookup([OWNED]);
  await selection.refresh();
  expect(selectRepositories).not.toHaveBeenCalled();
  expect(isSessionUnsaved).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Saved session metadata is missing"));
});

it.each([[OWNED], []].map((worktrees) => ({ worktrees })))(
  "keeps the current SCM selection if previously read metadata disappears: $worktrees",
  async ({ worktrees }) => {
    const { selection, sessionWorktrees, isSessionUnsaved, selectRepositories, log } = setup();
    sessionWorktrees.mockResolvedValue(worktrees);
    selection.track({ sessionId: "s1", cwd: MAIN });
    await selection.refresh();

    sessionWorktrees.mockResolvedValue(undefined);
    isSessionUnsaved.mockResolvedValue(true);
    selection.onSessionFileChanged(SESSION_FILE);
    await selection.refresh();
    expect(isSessionUnsaved).not.toHaveBeenCalled();
    expect(selectRepositories.mock.calls).toEqual([[[MAIN, ...worktrees]]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Saved session metadata is missing"));
  },
);

it("retries pending SCM targets and preserves manual selection after they are applied", async () => {
  const { selection, sessionWorktrees, detected, selectRepositories, log } = setup();
  sessionWorktrees.mockResolvedValue([LINKED]);
  detected.delete(LINKED);
  selectRepositories.mockResolvedValueOnce("pending");
  selection.track({ sessionId: "s1", cwd: LINKED });
  await selection.refresh();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("pending"));

  detected.add(LINKED);
  await selection.refresh();
  detected.add("/unrelated");
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED]], [[MAIN, LINKED]]]);
});

it("does not overwrite SCM if the command is unavailable", async () => {
  const { selection, selectRepositories, log } = setup();
  selectRepositories.mockRejectedValueOnce(new Error("command not found"));
  selection.track({ sessionId: "s1", cwd: MAIN });
  await selection.refresh();
  await selection.refresh();
  expect(selectRepositories).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
});

it("leaves SCM selection alone while disabled even when the displayed session changes", async () => {
  const { selection, sessionWorktrees, execFile, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN });
  await selection.refresh();
  await selection.toggle();
  sessionWorktrees.mockClear().mockResolvedValue([OWNED]);
  execFile.mockClear();

  selection.track({ sessionId: "new", cwd: MAIN });
  selection.onSessionFileChanged("/sessions/2026-11-23T13-07-05-610Z_new.jsonl");
  await selection.refresh();

  expect(selectRepositories.mock.calls).toEqual([[[MAIN]]]);
  expect(sessionWorktrees).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
});

it("reapplies an unchanged scope immediately when re-enabled", async () => {
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN });
  await selection.refresh();
  await selection.toggle();

  await selection.toggle();

  expect(selectRepositories.mock.calls).toEqual([[[MAIN]], [[MAIN]]]);
});

it("applies the current session on re-enable without waiting for an obsolete Git lookup", async () => {
  const { selection, sessionWorktrees, execFile, selectRepositories } = setup();
  sessionWorktrees.mockImplementation(async (id) => (id === "new" ? [OWNED] : []));
  let finishWorktreeList!: (result: { stdout: string }) => void;
  let onWorktreeListStarted!: () => void;
  const worktreeListStarted = new Promise<void>((resolve) => {
    onWorktreeListStarted = resolve;
  });
  execFile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWorktreeList = resolve;
        onWorktreeListStarted();
      }),
  );
  selection.track({ sessionId: "s1", cwd: MAIN });
  const pending = selection.refresh();
  await worktreeListStarted;

  await selection.toggle();
  selection.track({ sessionId: "new", cwd: MAIN });
  await selection.toggle();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]]]);

  finishWorktreeList({ stdout: `worktree ${MAIN}\0HEAD 123\0\0` });
  await pending;
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]]]);
});

it("settles a dispatched SCM update before completing disable or sending the next update", async () => {
  const newMain = "/another-repo";
  const { selection, execFile, selectRepositories } = setup();
  execFile.mockImplementation(async (_command, args, { cwd }) => ({
    stdout: args[0] === "worktree" ? `worktree ${cwd}\0HEAD 123\0\0` : `${cwd}\n`,
  }));
  let finishScmUpdate!: () => void;
  const scmUpdateStarted = new Promise<void>((started) => {
    selectRepositories.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishScmUpdate = () => resolve("applied");
          started();
        }),
    );
  });
  selection.track({ sessionId: "s1", cwd: MAIN });
  await scmUpdateStarted;

  const disabled = selection.toggle();
  selection.track({ sessionId: "new", cwd: newMain });
  const enabled = selection.toggle();
  await setImmediate();
  const disableBeforeAcknowledgement = await Promise.race([disabled, Promise.resolve("pending")]);
  const requestsBeforeAcknowledgement = selectRepositories.mock.calls.length;
  finishScmUpdate();
  await Promise.all([disabled, enabled]);

  expect(disableBeforeAcknowledgement).toBe("pending");
  expect(requestsBeforeAcknowledgement).toBe(1);
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]], [[newMain]]]);
});

it("discards worktrees returned for a previously displayed session", async () => {
  const { selection, sessionWorktrees, selectRepositories } = setup();
  let completeStaleLookup!: (worktrees: string[]) => void;
  const lookupStarted = new Promise<void>((started) => {
    sessionWorktrees.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          completeStaleLookup = complete;
          started();
        }),
    );
  });
  sessionWorktrees.mockResolvedValue([LINKED]);
  selection.track({ sessionId: "old", cwd: MAIN });
  await lookupStarted;
  selection.track({ sessionId: "new", cwd: MAIN });
  completeStaleLookup([OWNED]);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED]]]);
});

it("discards a previous scope while Git is still resolving it", async () => {
  const { selection, sessionWorktrees, execFile, selectRepositories } = setup();
  sessionWorktrees.mockImplementation(async (id) => (id === "new" ? [LINKED] : []));
  let finishOldScope!: (result: { stdout: string }) => void;
  let startedOldScope!: () => void;
  const started = new Promise<void>((resolve) => {
    startedOldScope = resolve;
  });
  execFile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOldScope = resolve;
        startedOldScope();
      }),
  );
  selection.track({ sessionId: "old", cwd: MAIN });
  await started;
  selection.track({ sessionId: "new", cwd: LINKED });
  finishOldScope({ stdout: `worktree ${MAIN}\0HEAD 123\0\0` });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED]]]);
});
