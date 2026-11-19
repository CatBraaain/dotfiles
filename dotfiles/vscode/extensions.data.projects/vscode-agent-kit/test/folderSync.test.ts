import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EMPTY_WINDOW_OPEN_TIMEOUT_MS,
  FolderSyncEngine,
  UNTITLED_TITLE_TEMPLATE,
  WORKTREE_DETECT_INTERVAL_MS,
} from "../src/folderSync";
import type { UriLike, VscodeLike } from "../src/folderSync";
import type { WorktreeEntry } from "../src/gitWorktrees";
import {
  createFakeGit,
  FakeVscode,
  savedWorkspace,
  untitledWorkspace,
  WORKSPACE_TARGET,
  wt,
  type FakeGit,
} from "./folderSyncFixtures";
import { cleanup, tempDir } from "./fixtures";

const HOME = "/home/user";
const AGENTS = "/home/user/.agents/workspace";
const MAIN = "/repo";
const FEAT = "/repo/wt/feat-x";

const mainEntry = wt(MAIN, { branch: "main" });
const featEntry = wt(FEAT, { branch: "feat-x" });

const TITLE_UPDATE = {
  section: "window",
  key: "title",
  value: UNTITLED_TITLE_TEMPLATE,
  target: WORKSPACE_TARGET,
};

interface SetupOptions {
  workspaceFile?: UriLike;
  entries?: readonly WorktreeEntry[] | ((cwd: string) => readonly WorktreeEntry[]);
}

let api: FakeVscode;
let git: FakeGit;
let engine: FolderSyncEngine;
let disposable: { dispose(): void };
let createdDirectories: string[];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  disposable?.dispose();
  vi.useRealTimers();
});

function setup(folderPaths: string[] | undefined, options: SetupOptions = {}): void {
  api = new FakeVscode(folderPaths, options.workspaceFile);
  git = createFakeGit(options.entries ?? [mainEntry]);
  createdDirectories = [];
  engine = new FolderSyncEngine({
    vscode: api,
    execFile: git.exec,
    homeDir: HOME,
    ensureDirectory: async (dirPath) => {
      createdDirectories.push(dirPath);
    },
  });
  disposable = engine.start();
}

/** Flush the startup transition queued by start(). */
async function boot(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await engine.idle();
}

/** Push a list result and wait for the list-based diff to settle. */
async function pushList(cwds: readonly string[]): Promise<void> {
  engine.updateList(cwds);
  await engine.idle();
  await vi.advanceTimersByTimeAsync(0);
  await engine.idle();
}

/** Advance to the next worktree detection and wait for its diff to settle. */
async function detectOnce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS);
  await engine.idle();
  await vi.advanceTimersByTimeAsync(0);
  await engine.idle();
}

// SPEC 起動時の付け替え: a folder 0 outside the agents workspace is swapped
// to [agents workspace, previous folder 0] with one edit in every startup
// configuration; in folder mode the edit itself is the untitled transition.
describe("startup folder-0 swap", () => {
  it("swaps folder 0 in a folder-mode window, transitions to untitled, and writes the title", async () => {
    setup(["/other/project"]);
    await boot();

    expect(createdDirectories).toEqual([AGENTS]);
    expect(api.folderPaths).toEqual([AGENTS, "/other/project"]);
    expect(api.workspace.workspaceFile?.scheme).toBe("untitled");
    expect(api.titleUpdates).toEqual([TITLE_UPDATE]);
  });

  it("swaps folder 0 in a saved workspace without changing the workspace file", async () => {
    const workspaceFile = savedWorkspace(`${AGENTS}/ws.code-workspace`);
    setup([MAIN, "/user/dir"], { workspaceFile });
    await boot();

    expect(createdDirectories).toEqual([AGENTS]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN, "/user/dir"]);
    expect(api.workspace.workspaceFile).toEqual(workspaceFile);
    expect(api.titleUpdates).toEqual([]);
  });

  it("swaps folder 0 in a multi-folder untitled workspace and keeps syncing", async () => {
    setup([MAIN, "/user/dir"], {
      workspaceFile: untitledWorkspace(),
      entries: [mainEntry, featEntry],
    });
    await boot();

    expect(api.folderPaths).toEqual([AGENTS, MAIN, "/user/dir"]);

    await pushList([MAIN]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
  });

  it("swaps folder 0 in a single-folder untitled workspace and writes the title", async () => {
    setup(["/other/project"], { workspaceFile: untitledWorkspace() });
    await boot();

    expect(api.folderPaths).toEqual([AGENTS, "/other/project"]);
    expect(api.titleUpdates).toEqual([TITLE_UPDATE]);
  });

  it("creates the agents workspace directory on the real file system before registering it", async () => {
    const root = await tempDir("folder-sync-mkdir-");
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      await mkdir(project, { recursive: true });
      const agents = join(home, ".agents", "workspace");
      api = new FakeVscode([project]);
      git = createFakeGit([mainEntry]);
      engine = new FolderSyncEngine({ vscode: api, execFile: git.exec, homeDir: home });
      disposable = engine.start();
      await boot();

      await expect(access(agents)).resolves.toBeUndefined();
      expect(api.folderPaths).toEqual([agents, project]);
    } finally {
      await cleanup(root);
    }
  });

  it("retries a rejected swap before the next sync application", async () => {
    setup(["/other/project"], { entries: [mainEntry, featEntry] });
    api.failNextUpdate = true;
    await boot();

    expect(api.folderPaths).toEqual(["/other/project"]);
    expect(api.workspace.workspaceFile).toBeUndefined();
    expect(api.titleUpdates).toEqual([]);

    await pushList([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
    expect(api.workspace.workspaceFile?.scheme).toBe("untitled");
    expect(api.titleUpdates).toEqual([TITLE_UPDATE]);
  });

  it("aborts the swap when creating the agents workspace fails and retries later", async () => {
    api = new FakeVscode(["/other/project"]);
    git = createFakeGit([mainEntry]);
    let failMkdir = true;
    engine = new FolderSyncEngine({
      vscode: api,
      execFile: git.exec,
      homeDir: HOME,
      ensureDirectory: async () => {
        if (failMkdir) throw new Error("mkdir failed");
      },
    });
    disposable = engine.start();
    await boot();
    expect(api.folderPaths).toEqual(["/other/project"]);

    failMkdir = false;
    await pushList([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("waits for folders to appear and then starts the transition and sync", async () => {
    setup(undefined, { entries: [mainEntry, featEntry] });
    const booting = boot();

    engine.updateList([MAIN]);
    await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS);
    expect(git.calls).toHaveLength(0);
    expect(api.added).toEqual([]);

    api.resolveFolders([MAIN]);
    await booting;
    await pushList([MAIN]);
    await detectOnce();

    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
    expect(api.workspace.workspaceFile?.scheme).toBe("untitled");
    expect(api.titleUpdates).toEqual([TITLE_UPDATE]);
  });

  it("does not open a folder while a saved workspace is still restoring", async () => {
    setup(undefined, {
      workspaceFile: savedWorkspace(`${AGENTS}/ws.code-workspace`),
      entries: [mainEntry, featEntry],
    });
    const booting = boot();

    await vi.advanceTimersByTimeAsync(EMPTY_WINDOW_OPEN_TIMEOUT_MS);
    expect(api.openedFolders).toEqual([]);

    api.resolveFolders([MAIN]);
    await booting;
    await pushList([MAIN]);
    await detectOnce();

    expect(api.openedFolders).toEqual([]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
  });

  it("opens the agents workspace when a folderless window never provides folders", async () => {
    setup(undefined);
    const booting = boot();

    await vi.advanceTimersByTimeAsync(EMPTY_WINDOW_OPEN_TIMEOUT_MS - 1);
    expect(api.openedFolders).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.openedFolders).toEqual([AGENTS]);

    disposable.dispose();
    await booting;
    expect(api.added).toEqual([]);
  });
});

// SPEC 起動時のワークスペース遷移: a single-folder window already on the
// agents workspace is transitioned to an untitled workspace by re-applying
// folder 0 unchanged; other configurations on the agents workspace stay.
describe("startup workspace transition", () => {
  it("re-applies folder 0 unchanged for a single agents workspace folder and writes the title", async () => {
    setup([AGENTS]);
    await boot();

    expect(api.added).toEqual([{ path: AGENTS, name: "workspace" }]);
    expect(api.removed).toEqual([AGENTS]);
    expect(api.folderPaths).toEqual([AGENTS]);
    expect(api.workspace.workspaceFile?.scheme).toBe("untitled");
    expect(api.titleUpdates).toEqual([TITLE_UPDATE]);
  });

  it("does not transition a saved workspace, an untitled workspace, or a multi-folder window on the agents workspace", async () => {
    for (const options of [
      { workspaceFile: savedWorkspace(`${AGENTS}/ws.code-workspace`) },
      { workspaceFile: untitledWorkspace() },
    ] as const) {
      setup([AGENTS, "/user/dir"], options);
      await boot();
      expect(api.added).toEqual([]);
      expect(api.folderPaths).toEqual([AGENTS, "/user/dir"]);
    }
    setup([AGENTS], { workspaceFile: savedWorkspace(`${AGENTS}/ws.code-workspace`) });
    await boot();
    expect(api.added).toEqual([]);
  });

  it("keeps folder 0 and syncs after a rejected promotion", async () => {
    setup([AGENTS], { entries: [mainEntry, featEntry] });
    api.failNextUpdate = true;
    await boot();

    expect(api.added).toEqual([]);
    expect(api.folderPaths).toEqual([AGENTS]);
    expect(api.workspace.workspaceFile).toBeUndefined();
    expect(api.titleUpdates).toEqual([]);

    await pushList([MAIN]);
    await detectOnce();
    // The folder application itself moves the window to an untitled workspace.
    expect(api.added.at(-1)).toEqual({ path: FEAT, name: "feat-x" });
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
    expect(api.workspace.workspaceFile?.scheme).toBe("untitled");
  });

  it("aborts the promotion when folders grow while waiting", async () => {
    const folders = [AGENTS];
    const currentApi = new FakeVscode(folders);
    let releaseIdentity!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    engine = new FolderSyncEngine({
      vscode: currentApi,
      execFile: createFakeGit([mainEntry, featEntry]).exec,
      homeDir: HOME,
      resolveIdentity: (folderPath) => gate.then(() => folderPath),
    });
    disposable = engine.start();
    // The folder grows while the identity resolution is pending (a direct
    // workspace mutation, not a folder edit, so no untitled state is made).
    currentApi.workspace.workspaceFolders?.push({
      uri: { scheme: "file", fsPath: "/user/dir" },
      name: "dir",
    });
    releaseIdentity();
    await boot();

    expect(currentApi.added).toEqual([]);
    expect(currentApi.folderPaths).toEqual([AGENTS, "/user/dir"]);
    expect(currentApi.titleUpdates).toEqual([]);
  });
});

// SPEC worktree の検出.
describe("worktree detection", () => {
  it("adds detected worktrees with branch and detached names in folder-name order", async () => {
    setup([AGENTS], {
      workspaceFile: untitledWorkspace(),
      entries: [
        mainEntry,
        wt("/repo/wt/topic", { branch: "topic" }),
        wt("/repo/wt/det", { head: "abcdef1234567890" }),
      ],
    });
    await boot();
    await pushList([MAIN]);
    await detectOnce();

    // Folder-name order: "(detached abcdef1)" sorts before "topic".
    expect(api.folderPaths).toEqual([AGENTS, MAIN, "/repo/wt/det", "/repo/wt/topic"]);
    expect(git.calls[0].args).toEqual(["worktree", "list", "--porcelain"]);
    expect(git.calls[0].cwd).toBe(MAIN);
  });

  it("does not run git without candidates and excludes the main repository entry", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await detectOnce();

    expect(git.calls).toHaveLength(0);
    expect(api.added).toEqual([]);
  });

  it("treats a list cwd that is itself a worktree as a detection candidate and still excludes the main repository", async () => {
    const other = wt("/repo/wt/other", { branch: "other" });
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry, other] });
    await boot();
    // FEAT (a linked worktree) is the pi-mux workspace; running
    // `git worktree list` there still lists the main repository first.
    // The list-based add carries no folder name; only the main repository
    // entry is excluded from the detection results.
    await pushList([FEAT]);
    await detectOnce();

    expect(api.folderPaths).toEqual([AGENTS, FEAT, "/repo/wt/other"]);
  });

  it("polls every 2500 ms", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([MAIN]);

    await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS);
    await engine.idle();
    expect(git.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS - 1);
    expect(git.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await engine.idle();
    expect(git.calls).toHaveLength(2);
    expect(git.calls.every((call) => call.cwd === MAIN)).toBe(true);
  });

  it("does not overlap detection runs", async () => {
    api = new FakeVscode([AGENTS], untitledWorkspace());
    git = createFakeGit([mainEntry, featEntry]);
    engine = new FolderSyncEngine({
      vscode: api,
      execFile: git.exec,
      homeDir: HOME,
      // Synchronous identity keeps the chain microtask-only so a held git
      // run deterministically blocks the serialized chain.
      resolveIdentity: (folderPath) => Promise.resolve(folderPath),
    });
    disposable = engine.start();
    await boot();
    // A rejected application keeps the list cwd absent from the workspace,
    // so the held detection run stays free of real file reads.
    api.failNextUpdate = true;
    engine.updateList([MAIN]);
    await engine.idle();
    expect(api.folderPaths).toEqual([AGENTS]);

    const release = git.holdNext();
    await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS);
    // Drain pending work so the held git run has started without waiting
    // for its completion; the main-repository resolution reads the real
    // file system before the git call.
    await vi.advanceTimersByTimeAsync(1);
    expect(git.calls).toHaveLength(1);
    // While the first run is held, no further detection runs: the next
    // tick is scheduled only after the current run completes.
    await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS * 4);
    expect(git.calls).toHaveLength(1);
    release();
    // The held run completes and the next detection starts one interval
    // later.
    await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS);
    await engine.idle();
    expect(git.calls).toHaveLength(2);
  });

  // SPEC: git コマンドが利用できない、実行が失敗する → worktree の検出を
  // 保留し、list に基づく同期は続ける。
  it("holds previous detection results when git fails and keeps list-based sync", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    await boot();
    await pushList([MAIN]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);

    git.failOnce();
    await detectOnce();
    // The worktree stays (previous results held) and a new list cwd is
    // still added; MAIN left the list, so its folder is removed. The list
    // cwd comes first; the worktree group without its main repository in
    // the list is appended at the end.
    await pushList(["/other/list-cwd"]);
    expect(api.folderPaths).toEqual([AGENTS, "/other/list-cwd", FEAT]);

    git.setEntries([mainEntry]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, "/other/list-cwd"]);
  });

  it("stops polling when disposed", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([MAIN]);
    await detectOnce();
    expect(git.calls).toHaveLength(1);

    disposable.dispose();
    await detectOnce();
    await detectOnce();
    expect(git.calls).toHaveLength(1);
  });

  // SPEC: 本体リポジトリが list から消えても、worktree フォルダの `.git`
  // ファイルから本体リポジトリを解決できる限り検出を続ける（実ディレクトリで検証）。
  it("keeps detecting through a worktree's gitdir after the main repository leaves the list", async () => {
    const root = await tempDir("folder-sync-gitdir-");
    try {
      const mainRepo = join(root, "main");
      const worktreeFolder = join(root, "feat");
      await mkdir(join(mainRepo, ".git"), { recursive: true });
      await mkdir(worktreeFolder, { recursive: true });
      await writeFile(
        join(worktreeFolder, ".git"),
        `gitdir: ${join(mainRepo, ".git", "worktrees", "feat")}\n`,
        "utf8",
      );
      const mainRepoEntry = wt(mainRepo, { branch: "main" });
      const worktreeEntry = wt(worktreeFolder, { branch: "feat" });

      setup([AGENTS], {
        workspaceFile: untitledWorkspace(),
        entries: [mainRepoEntry, worktreeEntry],
      });
      await boot();
      await pushList([mainRepo]);
      await detectOnce();
      expect(api.folderPaths).toEqual([AGENTS, mainRepo, worktreeFolder]);

      // The repository is unregistered from pi-mux: its own folder leaves
      // with the list, but the worktree's gitdir keeps the repository a
      // detection candidate, so the worktree folder stays.
      await pushList([]);
      await detectOnce();
      expect(api.folderPaths).toEqual([AGENTS, worktreeFolder]);

      // Once the worktree disappears from the list output, the folder is removed.
      git.setEntries([mainRepoEntry]);
      await detectOnce();
      expect(api.folderPaths).toEqual([AGENTS]);
    } finally {
      await cleanup(root);
    }
  });
});

// SPEC 管理フォルダの同期・フォルダの並び.
describe("managed folder sync", () => {
  it("applies nothing before the first successful list acquisition", async () => {
    setup([AGENTS, "/user/dir"], {
      workspaceFile: untitledWorkspace(),
      entries: [mainEntry, featEntry],
    });
    await boot();
    await detectOnce();
    // Detection runs, but no folder is added or removed before the list.
    expect(api.folderPaths).toEqual([AGENTS, "/user/dir"]);
    expect(git.calls).toHaveLength(0);

    await pushList([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);

    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
  });

  it("adds a list cwd missing from workspaceFolders", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([MAIN]);

    expect(api.added).toEqual([{ path: MAIN, name: undefined }]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("removes a managed folder when its cwd leaves the list and closes its tabs", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([MAIN]);
    api.openTabs(`${MAIN}/src/a.ts`, `${AGENTS}/README.md`);

    await pushList([]);

    expect(api.closedTabs).toEqual([`${MAIN}/src/a.ts`]);
    expect(api.openTabPaths).toEqual([`${AGENTS}/README.md`]);
    expect(api.removed).toEqual([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS]);
  });

  it("removes a folder 1+ folder that is the same entity as the agents workspace", async () => {
    const root = await tempDir("folder-sync-duplicate-");
    try {
      const home = join(root, "home");
      const agents = join(home, ".agents", "workspace");
      const alias = join(root, "alias");
      await mkdir(agents, { recursive: true });
      await symlink(agents, alias);
      api = new FakeVscode([agents, alias]);
      git = createFakeGit([mainEntry]);
      engine = new FolderSyncEngine({ vscode: api, execFile: git.exec, homeDir: home });
      disposable = engine.start();
      await boot();

      await pushList([MAIN]);

      expect(api.removed).toEqual([alias]);
      expect(api.folderPaths).toEqual([agents, MAIN]);
    } finally {
      await cleanup(root);
    }
  });

  it("does not duplicate folder 0 when the list carries the agents workspace cwd", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([AGENTS, MAIN]);

    expect(api.added).toEqual([{ path: MAIN, name: undefined }]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("removes a folder matching neither the list nor the worktrees and closes only its tabs", async () => {
    setup([AGENTS, "/user/dir"], { workspaceFile: untitledWorkspace(), entries: [mainEntry] });
    await boot();
    api.openTabs(`${MAIN}/src/a.ts`, "/user/dir/notes.md", `${AGENTS}/README.md`);

    await pushList([MAIN]);

    expect(api.closedTabs).toEqual(["/user/dir/notes.md"]);
    expect(api.openTabPaths).toEqual([`${MAIN}/src/a.ts`, `${AGENTS}/README.md`]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("re-adds a managed folder the user removed", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);

    api.workspace.updateWorkspaceFolders(1, 1);
    expect(api.folderPaths).toEqual([AGENTS]);

    await pushList([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("places worktrees directly after their main repository in folder-name order", async () => {
    setup([AGENTS, FEAT], {
      workspaceFile: untitledWorkspace(),
      entries: [
        mainEntry,
        featEntry,
        wt("/repo/wt/beta", { branch: "beta" }),
        wt("/repo/wt/alpha", { branch: "alpha" }),
      ],
    });
    await boot();

    await pushList([MAIN, FEAT]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);

    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, "/repo/wt/alpha", "/repo/wt/beta", FEAT]);
  });

  it("reorders folder 1 and beyond into the list order with one edit and keeps tabs open", async () => {
    setup([AGENTS, "/second", "/first"], {
      workspaceFile: untitledWorkspace(),
      entries: [mainEntry],
    });
    await boot();
    api.openTabs("/first/a.ts", "/second/b.ts");
    const updatesBefore = api.updateCalls;

    await pushList(["/first", "/second"]);

    expect(api.folderPaths).toEqual([AGENTS, "/first", "/second"]);
    expect(api.updateCalls - updatesBefore).toBe(1);
    expect(api.openTabPaths).toEqual(["/first/a.ts", "/second/b.ts"]);
    expect(api.closedTabs).toEqual([]);
  });

  it("appends worktree groups without a listed main repository at the end in display-name order", async () => {
    const root = await tempDir("folder-sync-orphans-");
    try {
      const worktreeA = join(root, "wt-a");
      const worktreeB = join(root, "wt-b");
      const repoA = join(root, "repo-a");
      const repoB = join(root, "repo-b");
      await mkdir(worktreeA, { recursive: true });
      await mkdir(worktreeB, { recursive: true });
      await writeFile(
        join(worktreeA, ".git"),
        `gitdir: ${join(repoA, ".git", "worktrees", "a")}\n`,
        "utf8",
      );
      await writeFile(
        join(worktreeB, ".git"),
        `gitdir: ${join(repoB, ".git", "worktrees", "b")}\n`,
        "utf8",
      );
      const worktreeAEntry = wt(worktreeA, { branch: "zeta" });
      const worktreeBEntry = wt(worktreeB, { branch: "alpha" });

      setup([AGENTS, worktreeA, worktreeB], {
        workspaceFile: untitledWorkspace(),
        entries: (cwd) =>
          cwd === repoA ? [wt(repoA), worktreeAEntry] : [wt(repoB), worktreeBEntry],
      });
      await boot();
      // Detection resolves each worktree folder's own main repository, so
      // two unlisted repositories become detection candidates.
      await detectOnce();
      expect(git.calls.map((call) => call.cwd).sort()).toEqual([repoA, repoB]);
      expect(api.folderPaths).toEqual([AGENTS, worktreeA, worktreeB]);

      // Without their main repositories in the list, both worktrees are
      // appended at the end in display-name order across the groups.
      await pushList([]);
      expect(api.folderPaths).toEqual([AGENTS, worktreeB, worktreeA]);
    } finally {
      await cleanup(root);
    }
  });

  it("keeps a prunable worktree folder that is also a list cwd", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    await boot();
    await pushList([MAIN, FEAT]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);

    git.setEntries([mainEntry, wt(FEAT, { branch: "feat-x", prunable: true })]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
  });

  // SPEC: worktree が検出結果から消える → 削除前にそのフォルダ配下の
  // エディタタブを閉じる。
  it("closes tabs under a worktree folder before removing it", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    await boot();
    await pushList([MAIN]);
    await detectOnce();
    api.openTabs(`${FEAT}/src/a.ts`, `${AGENTS}/README.md`);

    git.setEntries([mainEntry]);
    await detectOnce();

    expect(api.closedTabs).toEqual([`${FEAT}/src/a.ts`]);
    expect(api.openTabPaths).toEqual([`${AGENTS}/README.md`]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("removes a worktree folder that becomes prunable", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    await boot();
    await pushList([MAIN]);
    await detectOnce();

    git.setEntries([mainEntry, wt(FEAT, { branch: "feat-x", prunable: true })]);
    await detectOnce();

    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  // SPEC: 確認ダイアログがキャンセルされる → 通知せず同期状態を維持し、
  // 次の同期で再試行する。キャンセルされた削除対象は管理フォルダに残す。
  it("keeps the folder when the tab dialog is cancelled and retries on the next sync", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    await boot();
    await pushList([MAIN]);
    await detectOnce();

    git.setEntries([mainEntry]);
    api.openTabs(`${FEAT}/src/a.ts`);
    api.cancelNextTabClose = true;
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);

    await detectOnce();
    expect(api.closedTabs).toEqual([`${FEAT}/src/a.ts`]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("retries a rejected folder removal on the next sync", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    await boot();
    await pushList([MAIN]);
    await detectOnce();

    git.setEntries([mainEntry]);
    api.failNextUpdate = true;
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);

    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("retries a rejected addition on the next sync", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();

    api.failNextUpdate = true;
    await pushList([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS]);

    await pushList([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("adds a folder that is both a list cwd and a worktree once, keeping the worktree name", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    await boot();
    await pushList([MAIN]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);

    // Registering the worktree itself as a pi-mux workspace must not add a
    // second folder for it, and the worktree survives the list-driven
    // removal because it is still detected.
    await pushList([MAIN, FEAT]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);

    await pushList([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
  });
});

// SPEC タイトルバー.
describe("title bar", () => {
  it("writes the fixed template once and does not rewrite it on later syncs", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    await boot();
    await pushList([MAIN]);
    await detectOnce();
    await detectOnce();

    expect(api.titleUpdates).toEqual([TITLE_UPDATE]);
  });

  it("overwrites an existing window.title value", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    api.windowTitle = "${activeEditorShort}";
    await boot();

    expect(api.windowTitle).toBe(UNTITLED_TITLE_TEMPLATE);
  });

  it("does not write the title for a saved workspace", async () => {
    setup([AGENTS], { workspaceFile: savedWorkspace(`${AGENTS}/ws.code-workspace`) });
    await boot();
    await pushList([MAIN]);
    await detectOnce();

    expect(api.titleUpdates).toEqual([]);
  });

  it("does not write the title while the window stays in folder mode", async () => {
    setup(["/other/project"]);
    api.failNextUpdate = true;
    await boot();

    expect(api.workspace.workspaceFile).toBeUndefined();
    expect(api.titleUpdates).toEqual([]);
  });

  // 書き込み失敗は同期を壊さない（通知しない）。
  it("ignores a failed title write and keeps syncing", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace(), entries: [mainEntry, featEntry] });
    api.failTitleUpdate = true;
    await boot();
    expect(api.titleUpdates).toHaveLength(1);

    await pushList([MAIN]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, FEAT]);
  });
});

// VscodeLike 構造の型確認: FakeVscode が実装を満たすこと。
describe("fake wiring", () => {
  it("satisfies the VscodeLike shape", () => {
    const fake: VscodeLike = new FakeVscode([AGENTS]);
    expect(fake.workspace.workspaceFolders?.length).toBe(1);
  });
});
