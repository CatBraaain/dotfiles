import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionScmSelection } from "../src/session-scm";
import type { ExecFile } from "../src/git-worktrees";
import { cleanup, tempDir } from "./fixtures";

const MAIN = "/repo";
const LINKED = "/linked";
const OWNED = "/owned";
const REPLACED = "/replaced";
const OLD_OWNED = "/old-owned";
const COMMON = "/repo/.git\n";

let folder: string;
beforeEach(async () => {
  folder = await tempDir("agent-kit-scm-");
});
afterEach(async () => cleanup(folder));

function header(id = "s1"): string {
  return JSON.stringify({ type: "session", id }) + "\n";
}

function snapshot(...workspaces: string[]): string {
  return metadata({ sessionId: "s1", workspaces });
}

function metadata(data: unknown): string {
  return JSON.stringify({ type: "custom", customType: "session-worktree-metadata", data }) + "\n";
}

function setup() {
  const worktrees = new Set([MAIN, LINKED, OWNED, REPLACED, OLD_OWNED]);
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
    execFile,
    detectedRoots: () => [...detected],
    selectRepositories,
    log,
  });
  return { selection, worktrees, detected, execFile, selectRepositories, log };
}

it("uses the last matching snapshot in append order and filters out foreign worktrees", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(
    filePath,
    header() +
      snapshot(OLD_OWNED) +
      snapshot(MAIN, LINKED, OWNED, REPLACED, "/foreign") +
      metadata({ sessionId: "other", workspaces: [OLD_OWNED] }) +
      '{"type":"message"}\n',
  );
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: `${LINKED}/subdirectory`, filePath });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED, OWNED]]]);
});

it("does not inherit fork source metadata or use legacy records", async () => {
  const filePath = join(folder, "fork.jsonl");
  const legacyDeclaration =
    JSON.stringify({
      type: "custom",
      customType: "session-worktree-declarations",
      data: { worktrees: [{ name: "old", path: LINKED }] },
    }) + "\n";
  await writeFile(
    filePath,
    header("fork") + snapshot(OWNED) + metadata({ workspaces: [LINKED] }) + legacyDeclaration,
  );
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "fork", cwd: LINKED, filePath });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]]]);
});

it("keeps the current SCM selection when the file belongs to another session", async () => {
  const filePath = join(folder, "other-session.jsonl");
  await writeFile(filePath, header() + snapshot(OWNED));
  const { selection, selectRepositories, log } = setup();
  selection.track({ sessionId: "other", cwd: MAIN, filePath });
  await selection.refresh();
  expect(selectRepositories).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("Session header does not match the selected session"),
  );
});

it("restores ownership when the same session ID resumes", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, header() + snapshot(LINKED));
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();
  selection.track(undefined);
  await selection.refresh();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED]], [[MAIN, LINKED]]]);
});

it("keeps an empty latest snapshot and does not reapply on an unchanged scope", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, header() + snapshot(OWNED));
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();

  await appendFile(filePath, '{"type":"message"}\n');
  selection.onSessionFileChanged(filePath);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]]]);

  await appendFile(filePath, snapshot());
  selection.onSessionFileChanged(filePath);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]], [[MAIN]]]);
});

it("excludes an owned worktree removed since the last detection", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, header() + snapshot(OWNED));
  const { selection, worktrees, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();
  worktrees.delete(OWNED);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]], [[MAIN]]]);
});

it("keeps the current SCM selection on an invalid latest matching snapshot", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, header() + snapshot(OWNED) + snapshot("relative"));
  const { selection, selectRepositories, log } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();
  expect(selectRepositories).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Invalid worktree metadata paths"));
});

it("uses only the main worktree before the selected session file is saved", async () => {
  const filePath = join(folder, "unsaved", "session.jsonl");
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: LINKED, filePath });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN]]]);

  await mkdir(join(folder, "unsaved"));
  await writeFile(filePath, header() + snapshot(OWNED));
  await selection.refresh();
  expect(selectRepositories.mock.calls.at(-1)).toEqual([[MAIN, OWNED]]);
});

it("keeps the current SCM selection if the saved session file disappears", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, header() + snapshot(OWNED));
  const { selection, selectRepositories, log } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();

  await unlink(filePath);
  selection.onSessionFileChanged(filePath);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, OWNED]]]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not read worktree metadata"));
});

it("retries pending SCM targets and preserves manual selection after they are applied", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, header() + snapshot(LINKED));
  const { selection, detected, selectRepositories, log } = setup();
  detected.delete(LINKED);
  selectRepositories.mockResolvedValueOnce("pending");
  selection.track({ sessionId: "s1", cwd: LINKED, filePath });
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

it("discards a previous scope while Git is still resolving it", async () => {
  const filePath = join(folder, "new.jsonl");
  await writeFile(filePath, header("new") + metadata({ sessionId: "new", workspaces: [LINKED] }));
  const { selection, execFile, selectRepositories } = setup();
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
  selection.track({ sessionId: "new", cwd: LINKED, filePath });
  finishOldScope({ stdout: `worktree ${MAIN}\0HEAD 123\0\0` });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED]]]);
});
