import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionScmSelection } from "../src/session-scm";
import type { ExecFile } from "../src/git-worktrees";
import { cleanup, tempDir } from "./fixtures";

const MAIN = "/repo";
const LINKED = "/linked";
const DECLARED = "/declared";
const REPLACED = "/replaced";
const OLD_DECLARED = "/old-declared";
const COMMON = "/repo/.git\n";

let folder: string;
beforeEach(async () => {
  folder = await tempDir("agent-kit-scm-");
});
afterEach(async () => cleanup(folder));

function declaration(...paths: string[]): string {
  return (
    JSON.stringify({
      type: "custom",
      customType: "session-worktree-declarations",
      data: { worktrees: paths.map((path, index) => ({ name: `worktree-${index}`, path })) },
    }) + "\n"
  );
}

function setup() {
  const worktrees = new Set([MAIN, LINKED, DECLARED, REPLACED, OLD_DECLARED]);
  const detected = new Set([MAIN, LINKED, DECLARED]);
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

it("uses only the latest declaration, plus the main and linked cwd roots", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(
    filePath,
    declaration(OLD_DECLARED) +
      declaration(LINKED, DECLARED, REPLACED, "/foreign") +
      '{"type":"message"}\n',
  );
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: `${LINKED}/subdirectory`, filePath });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED, DECLARED]]]);
});

it("refreshes changed declarations and does not reapply on unchanged scope", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, declaration(DECLARED));
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();

  await appendFile(filePath, '{"type":"message"}\n');
  selection.onSessionFileChanged(filePath);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, DECLARED]]]);

  await appendFile(filePath, declaration());
  selection.onSessionFileChanged(filePath);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, DECLARED]], [[MAIN]]]);
});

it("excludes a declared worktree removed since the last detection", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, declaration(DECLARED));
  const { selection, worktrees, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();
  worktrees.delete(DECLARED);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, DECLARED]], [[MAIN]]]);
});

it("keeps the current SCM selection on an invalid latest declaration", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, declaration(DECLARED) + declaration("relative"));
  const { selection, selectRepositories, log } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();
  expect(selectRepositories).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Invalid worktree declaration"));
});

it("uses the Git roots before the selected session file is saved", async () => {
  const filePath = join(folder, "unsaved", "session.jsonl");
  const { selection, selectRepositories } = setup();
  selection.track({ sessionId: "s1", cwd: LINKED, filePath });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED]]]);

  await mkdir(join(folder, "unsaved"));
  await writeFile(filePath, declaration(DECLARED));
  await selection.refresh();
  expect(selectRepositories.mock.calls.at(-1)).toEqual([[MAIN, LINKED, DECLARED]]);
});

it("keeps the current SCM selection if the saved session file disappears", async () => {
  const filePath = join(folder, "session.jsonl");
  await writeFile(filePath, declaration(DECLARED));
  const { selection, selectRepositories, log } = setup();
  selection.track({ sessionId: "s1", cwd: MAIN, filePath });
  await selection.refresh();

  await unlink(filePath);
  selection.onSessionFileChanged(filePath);
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, DECLARED]]]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not read worktree declarations"));
});

it("retries pending SCM targets and preserves manual selection after they are applied", async () => {
  const { selection, detected, selectRepositories, log } = setup();
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

it("discards a previous scope while Git is still resolving it", async () => {
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
  selection.track({ sessionId: "new", cwd: LINKED });
  finishOldScope({ stdout: `worktree ${MAIN}\0HEAD 123\0\0` });
  await selection.refresh();
  expect(selectRepositories.mock.calls).toEqual([[[MAIN, LINKED]]]);
});
