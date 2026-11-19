import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
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
const AGENTS = "/home/user/.agents/agents-workspace";
const MAIN = "/repo";
const FEAT = "/repo/wt/feat-x";

const mainEntry = wt(MAIN, { branch: "main" });
const featEntry = wt(FEAT, { branch: "feat-x" });

interface SetupOptions {
  workspaceFile?: UriLike;
  entries?: readonly WorktreeEntry[] | ((cwd: string) => readonly WorktreeEntry[]);
}

let api: FakeVscode;
let git: FakeGit;
let engine: FolderSyncEngine;
let disposable: { dispose(): void };

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
  engine = new FolderSyncEngine({ vscode: api, execFile: git.exec, homeDir: HOME });
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

// SPEC 起動時のワークスペース遷移: a single-folder window on the agents
// workspace is transitioned to an untitled workspace by re-applying
// folder 0 unchanged.
describe("startup workspace transition", () => {
  it("re-applies folder 0 unchanged for a single agents-workspace folder and writes the title", async () => {
    setup([AGENTS]);
    await boot();

    expect(api.added).toEqual([{ path: AGENTS, name: "agents-workspace" }]);
    expect(api.removed).toEqual([AGENTS]);
    expect(api.folderPaths).toEqual([AGENTS]);
    expect(api.workspace.workspaceFile?.scheme).toBe("untitled");
    expect(api.titleUpdates).toEqual([
      {
        section: "window",
        key: "title",
        value: UNTITLED_TITLE_TEMPLATE,
        target: WORKSPACE_TARGET,
      },
    ]);
  });

  it("does not transition a saved workspace, an untitled workspace, or a multi-folder window, and keeps syncing", async () => {
    for (const options of [
      { workspaceFile: savedWorkspace(`${AGENTS}/ws.code-workspace`) },
      { workspaceFile: untitledWorkspace() },
    ] as const) {
      setup([AGENTS, "/user/dir"], options);
      await boot();
      expect(api.added).toEqual([]);
    }
    setup([AGENTS, "/user/dir"], {
      workspaceFile: untitledWorkspace(),
      entries: [mainEntry, featEntry],
    });
    await boot();
    engine.updateList([MAIN]);
    await detectOnce();
    expect(api.added).toEqual([
      { path: MAIN, name: undefined },
      { path: FEAT, name: "feat-x" },
    ]);
  });

  // SPEC: `~/.agents/agents-workspace` 以外の単一フォルダで起動する → 遷移
  // せず、同期を停止する。実行中の構成変更で再開しない。
  it("stops the sync permanently for a single folder outside the agents workspace", async () => {
    setup(["/other/project"]);
    await boot();
    await pushList([MAIN]);
    await detectOnce();
    await detectOnce();

    expect(api.added).toEqual([]);
    expect(git.calls).toHaveLength(0);
    expect(api.titleUpdates).toEqual([]);
  });

  // SPEC: 遷移が拒否される → 遷移を中止し、通知しない。同期は続く。
  it("keeps folder 0 and syncs after a rejected transition", async () => {
    setup([AGENTS], { entries: [mainEntry, featEntry] });
    api.failNextUpdate = true;
    await boot();

    expect(api.added).toEqual([]);
    expect(api.folderPaths).toEqual([AGENTS]);
    expect(api.workspace.workspaceFile).toBeUndefined();
    expect(api.titleUpdates).toEqual([]);

    await pushList([MAIN]);
    await detectOnce();
    // The folder addition itself moves the window to an untitled workspace.
    expect(api.added).toEqual([
      { path: MAIN, name: undefined },
      { path: FEAT, name: "feat-x" },
    ]);
    expect(api.workspace.workspaceFile?.scheme).toBe("untitled");
  });

  // SPEC: 遷移待ちの間にフォルダが増える → 遷移を中止し、通知しない。
  it("aborts the transition when folders grow while waiting", async () => {
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
  it("adds detected worktrees with branch and detached names", async () => {
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

    expect(api.added).toEqual([
      { path: MAIN, name: undefined },
      { path: "/repo/wt/topic", name: "topic" },
      { path: "/repo/wt/det", name: "(detached abcdef1)" },
    ]);
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

    expect(api.added).toEqual([
      { path: FEAT, name: undefined },
      { path: "/repo/wt/other", name: "other" },
    ]);
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
    // A rejected addition keeps the list cwd managed but absent from the
    // workspace, so the held detection run stays free of real file reads.
    api.failNextUpdate = true;
    engine.updateList([MAIN]);
    await engine.idle();
    expect(api.folderPaths).toEqual([AGENTS]);

    const release = git.holdNext();
    await vi.advanceTimersByTimeAsync(WORKTREE_DETECT_INTERVAL_MS);
    // Drain the microtask chain so the held git run has started without
    // waiting for its completion.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
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
    // still added; MAIN left the list, so its folder is removed.
    await pushList(["/other/list-cwd"]);
    expect(api.folderPaths).toEqual([AGENTS, FEAT, "/other/list-cwd"]);

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

  // SPEC: 管理フォルダのうち `.git` ファイルを持ち、その `gitdir:` から
  // 本体リポジトリを解決できるフォルダは検出候補にする（実ディレクトリで検証）。
  it("keeps detecting through a managed worktree's gitdir after the main repository leaves the list", async () => {
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
      // with the list, but the managed worktree's gitdir keeps the
      // repository a detection candidate, so the worktree folder stays.
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

// SPEC 管理フォルダの採用.
describe("managed folder adoption", () => {
  it("adopts folder 1 and beyond matching list cwds or worktrees after the first detection", async () => {
    setup([AGENTS, MAIN, "/user/dir"], {
      workspaceFile: untitledWorkspace(),
      entries: [mainEntry, featEntry],
    });
    await boot();
    await pushList([MAIN]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, MAIN, "/user/dir", FEAT]);

    // Both adopted folders leave the target set; only they are removed.
    await pushList([]);
    git.setEntries([mainEntry]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, "/user/dir"]);
  });

  it("does not adopt folders whose list cwd appears only after the first detection", async () => {
    setup([AGENTS, MAIN], { workspaceFile: untitledWorkspace(), entries: [mainEntry] });
    await boot();
    // The first detection completes before any list arrives.
    await detectOnce();
    expect(git.calls).toHaveLength(0);

    await pushList([MAIN]);
    await pushList([]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("adopts by resolved identity, not by literal path", async () => {
    const root = await tempDir("folder-sync-adopt-");
    try {
      const worktreeFolder = join(root, "feat");
      const alias = join(root, "alias");
      await mkdir(worktreeFolder, { recursive: true });
      await symlink(worktreeFolder, alias);
      const worktreeEntry = wt(worktreeFolder, { branch: "feat" });

      setup([AGENTS, alias], {
        workspaceFile: untitledWorkspace(),
        entries: [mainEntry, worktreeEntry],
      });
      await boot();
      await pushList([MAIN]);
      await detectOnce();
      expect(api.folderPaths).toEqual([AGENTS, alias, MAIN]);
      // The alias folder was adopted because it is the same entity as the
      // detected worktree; removing the worktree removes the alias folder
      // while the adopted list cwd stays.
      git.setEntries([mainEntry]);
      await detectOnce();
      expect(api.removed).toEqual([alias]);
      expect(api.folderPaths).toEqual([AGENTS, MAIN]);
    } finally {
      await cleanup(root);
    }
  });
});

// SPEC 管理フォルダの同期.
describe("managed folder sync", () => {
  it("adds a list cwd missing from workspaceFolders", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([MAIN]);

    expect(api.added).toEqual([{ path: MAIN, name: undefined }]);
    expect(api.folderPaths).toEqual([AGENTS, MAIN]);
  });

  it("removes a managed folder when its cwd leaves the list", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([MAIN]);
    await pushList([]);

    expect(api.removed).toEqual([MAIN]);
    expect(api.folderPaths).toEqual([AGENTS]);
  });

  // SPEC: フォルダ0と同じ実体の cwd が pi-mux list に載る → 重複追加しない。
  it("does not duplicate folder 0 when the list carries the agents workspace cwd", async () => {
    setup([AGENTS], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([AGENTS, MAIN]);

    expect(api.added).toEqual([{ path: MAIN, name: undefined }]);
  });

  it("keeps user-added folders untouched", async () => {
    setup([AGENTS, "/user/dir"], {
      workspaceFile: untitledWorkspace(),
      entries: [mainEntry, featEntry],
    });
    await boot();
    await pushList([MAIN]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, "/user/dir", MAIN, FEAT]);

    git.setEntries([mainEntry]);
    await pushList([]);
    await detectOnce();
    expect(api.folderPaths).toEqual([AGENTS, "/user/dir"]);
  });

  // SPEC: ユーザーが管理フォルダを workspaceFolders から外す → 次の同期で再追加する。
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
    expect(api.added).toEqual([
      { path: MAIN, name: undefined },
      { path: FEAT, name: "feat-x" },
    ]);

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

    expect(api.titleUpdates).toEqual([
      {
        section: "window",
        key: "title",
        value: UNTITLED_TITLE_TEMPLATE,
        target: WORKSPACE_TARGET,
      },
    ]);
  });

  it("does not write the title for a saved workspace", async () => {
    setup([AGENTS], { workspaceFile: savedWorkspace(`${AGENTS}/ws.code-workspace`) });
    await boot();
    await pushList([MAIN]);
    await detectOnce();

    expect(api.titleUpdates).toEqual([]);
  });

  it("does not write the title for another untitled folder 0", async () => {
    setup(["/other/project"], { workspaceFile: untitledWorkspace() });
    await boot();
    await pushList([MAIN]);
    await detectOnce();

    expect(api.titleUpdates).toEqual([]);
  });

  it("does not write the title while the window stays in folder mode", async () => {
    setup([AGENTS]);
    api.failNextUpdate = true;
    await boot();

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
