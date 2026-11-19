/**
 * workspaceFolders sync (SPEC "workspaceFolders 同期"): startup workspace
 * transition into the untitled agents workspace, periodic worktree
 * detection, managed-folder adoption and diff application, and the
 * untitled-workspace title bar write. Folder 0 (`~/.agents/agents-workspace`)
 * is fixed and never touched; only folder 1 and beyond are managed.
 *
 * The pi-mux list side of the sync is push-driven: the session provider
 * calls updateList() with the latest `pi-mux list` cwds on every list
 * acquisition, and each call applies a list-based diff. Worktree
 * detection runs on its own 2500 ms timer and applies a worktree-based
 * diff after each run. The vscode API is injected as VscodeLike so the
 * sync logic never imports "vscode" and tests can use a plain fake.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  listWorktrees,
  resolveMainRepository,
  worktreeFolderName,
  type ExecFile,
} from "./gitWorktrees";

export interface UriLike {
  readonly scheme?: string;
  readonly fsPath: string;
}

export interface WorkspaceFolderLike {
  readonly uri: UriLike;
  readonly name: string;
}

export interface ConfigurationLike {
  update(key: string, value: unknown, target: unknown): PromiseLike<void>;
}

export interface TabInputLike {
  readonly uri?: UriLike;
  readonly modified?: UriLike;
}

export interface TabLike {
  readonly input?: TabInputLike;
}

export interface VscodeLike {
  readonly workspace: {
    readonly workspaceFolders: readonly WorkspaceFolderLike[] | undefined;
    readonly workspaceFile: UriLike | undefined;
    getConfiguration(section: string): ConfigurationLike;
    updateWorkspaceFolders(
      start: number,
      deleteCount: number | undefined,
      ...foldersToAdd: ReadonlyArray<{ uri: UriLike; name?: string }>
    ): boolean;
    onDidChangeWorkspaceFolders(listener: () => void): { dispose(): void };
  };
  readonly window: {
    readonly tabGroups: {
      readonly all: ReadonlyArray<{ readonly tabs: readonly TabLike[] }>;
      close(tabs: readonly TabLike[], preserveFocus?: boolean): PromiseLike<boolean>;
    };
  };
  readonly configurationTarget: { readonly Workspace: unknown };
}

/** SPEC: worktree detection runs every 2500 ms and never overlaps. */
export const WORKTREE_DETECT_INTERVAL_MS = 2500;

/** SPEC タイトルバー: the template written for the untitled agents workspace. */
export const UNTITLED_TITLE_TEMPLATE =
  "${dirty}${activeEditorShort}${separator}${profileName}${separator}${appName}";

const APPLY_TIMEOUT_MS = 3000;

/** Folder 0 of the managed untitled workspace. */
export function agentsWorkspacePath(homeDir: string): string {
  return path.join(homeDir, ".agents", "agents-workspace");
}

/**
 * SPEC 用語/同じ実体: identity is the absolute path after resolving
 * symlinks; paths that cannot be resolved (e.g. already deleted) fall
 * back to lexical resolution.
 */
export async function pathIdentity(folderPath: string): Promise<string> {
  try {
    return await realpath(folderPath);
  } catch {
    return path.resolve(folderPath);
  }
}

/** True when `child` equals `parent` or is below it. */
export function isUnderOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "" || path.isAbsolute(rel)) {
    return false;
  }
  return rel.split(path.sep)[0] !== "..";
}

/**
 * updateWorkspaceFolders is asynchronous: the workspace folders list is
 * updated only after onDidChangeWorkspaceFolders fires. Wait for that
 * event (with a timeout fallback) so consecutive edits see fresh
 * indices.
 */
export function updateFoldersAndWait(
  vscode: VscodeLike,
  start: number,
  deleteCount: number | undefined,
  ...folders: ReadonlyArray<{ uri: UriLike; name?: string }>
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      subscription.dispose();
      clearTimeout(fallback);
      resolve();
    };
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(done);
    const fallback = setTimeout(done, APPLY_TIMEOUT_MS);
    const accepted = vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...folders);
    if (!accepted) {
      done();
    }
  });
}

/** A worktree found by detection, keyed by its path identity. */
interface DetectedWorktree {
  readonly path: string;
  readonly name: string;
}

export interface FolderSyncDeps {
  readonly vscode: VscodeLike;
  readonly execFile: ExecFile;
  /** Home directory used to locate `~/.agents/agents-workspace`. */
  readonly homeDir: string;
  /** Overrides path identity resolution for tests. */
  readonly resolveIdentity?: (folderPath: string) => Promise<string>;
}

export class FolderSyncEngine {
  private readonly agentsWorkspace: string;
  private started = false;
  private stopped = false;
  /** SPEC: single-folder startup outside the agents workspace stops the sync until the next activation. */
  private syncDisabled = false;
  private adopted = false;
  private firstDetectionDone = false;
  private detectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Folder identities this extension added or adopted (folder 1 and beyond). */
  private readonly managed = new Set<string>();
  /** Main repository identity per managed worktree folder identity; a failed `.git` read keeps the previous entry. */
  private readonly gitRepos = new Map<string, string>();
  /** Detected worktrees per main repository identity; a failed git run keeps the previous entry. */
  private readonly repoWorktrees = new Map<string, Map<string, DetectedWorktree>>();
  private latestListCwds: readonly string[] = [];
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: FolderSyncDeps) {
    this.agentsWorkspace = agentsWorkspacePath(deps.homeDir);
  }

  /** Start the startup transition and detection polling. Safe to dispose once. */
  start(): { dispose(): void } {
    if (this.started) {
      return { dispose: () => {} };
    }
    this.started = true;
    void this.enqueue(() => this.startup());
    return { dispose: () => this.stop() };
  }

  /**
   * Receive the latest `pi-mux list` cwds and apply a list-based diff.
   * Called by the session provider on every successful list acquisition.
   */
  updateList(cwds: readonly string[]): void {
    if (!this.started || this.stopped) return;
    this.latestListCwds = [...cwds];
    void this.enqueue(() => this.applySync());
  }

  /** Resolves when every queued sync step has settled (for tests). */
  idle(): Promise<void> {
    return this.pending;
  }

  private stop(): void {
    this.stopped = true;
    if (this.detectTimer !== undefined) {
      clearTimeout(this.detectTimer);
      this.detectTimer = undefined;
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation);
    this.pending = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private identity(folderPath: string): Promise<string> {
    return (this.deps.resolveIdentity ?? pathIdentity)(folderPath);
  }

  private currentFolders(): readonly WorkspaceFolderLike[] {
    return this.deps.vscode.workspace.workspaceFolders ?? [];
  }

  /**
   * SPEC 起動時のワークスペース遷移: promote a single-folder window on the
   * agents workspace to an untitled workspace, disable the sync for any
   * other single-folder window, write the title bar, and start detection.
   */
  private async startup(): Promise<void> {
    if (this.stopped) return;
    const workspace = this.deps.vscode.workspace;
    const folders = workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
      this.syncDisabled = true;
      return;
    }
    if (folders.length === 1 && workspace.workspaceFile === undefined) {
      const identity = await this.identity(folders[0].uri.fsPath);
      if (this.stopped) return;
      if (identity !== (await this.identity(this.agentsWorkspace))) {
        this.syncDisabled = true;
        return;
      }
      // Folders may have grown while the identity was resolved; only a
      // still-single-folder workspace takes the transition.
      const current = workspace.workspaceFolders;
      if (current === undefined || current.length !== 1) return;
      // Re-apply folder 0 with identical content; the edit itself moves
      // the window to an untitled workspace. A rejected edit just aborts
      // the transition: later folder additions bring the untitled state.
      await updateFoldersAndWait(this.deps.vscode, 0, 1, {
        uri: current[0].uri,
        name: current[0].name,
      });
    }
    // Title updates are cosmetic; a failure must not break the sync.
    await this.applyTitle().catch(() => undefined);
    this.scheduleDetection(WORKTREE_DETECT_INTERVAL_MS);
  }

  /** SPEC タイトルバー: write the title template once at startup, overwriting any existing value. */
  private async applyTitle(): Promise<void> {
    const workspace = this.deps.vscode.workspace;
    if (workspace.workspaceFile?.scheme !== "untitled") return;
    const folder = this.currentFolders()[0];
    if (folder === undefined) return;
    if ((await this.identity(folder.uri.fsPath)) !== (await this.identity(this.agentsWorkspace))) {
      return;
    }
    await workspace
      .getConfiguration("window")
      .update("title", UNTITLED_TITLE_TEMPLATE, this.deps.vscode.configurationTarget.Workspace);
  }

  private scheduleDetection(delayMs: number): void {
    if (this.stopped || this.syncDisabled) return;
    this.detectTimer = setTimeout(() => {
      this.detectTimer = undefined;
      // Runs through the serialized chain so detection never overlaps a
      // diff application or another detection run.
      void this.enqueue(() => this.detect());
    }, delayMs);
    this.detectTimer.unref();
  }

  /**
   * SPEC worktree の検出: collect main-repository candidates (pi-mux list
   * cwds plus gitdir-resolvable managed folders), run
   * `git worktree list --porcelain` per candidate, and keep each
   * candidate's previous results when its git run fails. The main
   * worktree (always the first porcelain entry) is excluded.
   */
  private async detect(): Promise<void> {
    if (this.stopped || this.syncDisabled) return;
    const folders = this.currentFolders();
    const identities = await Promise.all(folders.map((folder) => this.identity(folder.uri.fsPath)));
    const candidates = new Set<string>();
    for (const cwd of this.latestListCwds) {
      candidates.add(await this.identity(cwd));
    }
    const managedIdentities = new Set<string>();
    for (let i = 1; i < folders.length; i++) {
      if (!this.managed.has(identities[i])) continue;
      managedIdentities.add(identities[i]);
      const repository = await resolveMainRepository(folders[i].uri.fsPath);
      if (repository !== undefined) {
        this.gitRepos.set(identities[i], await this.identity(repository));
      }
      // An unreadable `.git` keeps the previous repository entry so
      // detection is held instead of dropping the worktrees.
    }
    for (const identity of this.gitRepos.keys()) {
      if (!managedIdentities.has(identity)) this.gitRepos.delete(identity);
    }
    for (const repository of this.gitRepos.values()) {
      candidates.add(repository);
    }
    for (const candidate of this.repoWorktrees.keys()) {
      if (!candidates.has(candidate)) this.repoWorktrees.delete(candidate);
    }
    for (const candidate of candidates) {
      let entries;
      try {
        entries = await listWorktrees(candidate, this.deps.execFile);
      } catch {
        // git failed for this candidate: keep the previous results and
        // retry on the next detection run.
        continue;
      }
      const found = new Map<string, DetectedWorktree>();
      for (const entry of entries.slice(1)) {
        if (entry.prunable) continue;
        found.set(await this.identity(entry.path), {
          path: entry.path,
          name: worktreeFolderName(entry),
        });
      }
      this.repoWorktrees.set(candidate, found);
    }
    this.firstDetectionDone = true;
    if (!this.stopped && !this.syncDisabled) {
      // The next detection starts one interval after this one completed,
      // independently of how long the diff application takes. Detection
      // runs inside the same serialized chain as the diffs, so runs never
      // overlap.
      this.scheduleDetection(WORKTREE_DETECT_INTERVAL_MS);
      void this.enqueue(() => this.applySync());
    }
  }

  /**
   * SPEC 管理フォルダの採用・管理フォルダの同期: diff the current targets
   * (pi-mux list cwds plus detected worktrees) against the workspace
   * folders and apply additions and removals. Targets equal to folder 0
   * are never added (folder 0 stays fixed), and folders this extension
   * did not manage are never removed.
   */
  private async applySync(): Promise<void> {
    if (this.stopped || this.syncDisabled) return;
    const folders = this.currentFolders();
    const identities = await Promise.all(folders.map((folder) => this.identity(folder.uri.fsPath)));
    const present = new Set(identities);

    // Targets: list cwds first so worktree entries (with their folder
    // names) win when a path is both.
    const targets = new Map<string, { path: string; name?: string }>();
    for (const cwd of this.latestListCwds) {
      const identity = await this.identity(cwd);
      if (!targets.has(identity)) targets.set(identity, { path: cwd });
    }
    for (const worktrees of this.repoWorktrees.values()) {
      for (const [identity, worktree] of worktrees) {
        targets.set(identity, worktree);
      }
    }

    // SPEC 管理フォルダの採用: folder 1 and beyond are adopted once,
    // after the first worktree detection completed.
    if (this.firstDetectionDone && !this.adopted) {
      this.adopted = true;
      for (let i = 1; i < folders.length; i++) {
        if (targets.has(identities[i])) this.managed.add(identities[i]);
      }
    }

    const additions = [...targets].filter(([identity]) => !present.has(identity));
    const removals = [...this.managed].filter((identity) => !targets.has(identity));

    if (additions.length > 0) await this.applyAdditions(additions);
    for (const identity of removals) await this.applyRemoval(identity);
  }

  private async applyAdditions(
    additions: ReadonlyArray<[string, { path: string; name?: string }]>,
  ): Promise<void> {
    const start = this.currentFolders().length;
    // Managed even when the edit is rejected, so the next sync retries.
    for (const [identity] of additions) this.managed.add(identity);
    await updateFoldersAndWait(
      this.deps.vscode,
      start,
      0,
      ...additions.map(([, target]) => ({ uri: { fsPath: target.path }, name: target.name })),
    );
  }

  /**
   * Remove one managed folder. Tabs under the folder are closed first
   * and follow VS Code's confirmation dialog for unsaved changes; a
   * cancelled dialog or a rejected edit keeps the folder managed so the
   * next sync retries.
   */
  private async applyRemoval(identity: string): Promise<void> {
    const folders = this.currentFolders();
    const identities = await Promise.all(folders.map((folder) => this.identity(folder.uri.fsPath)));
    const index = identities.indexOf(identity);
    // Not present anymore, or folder 0 (never managed): just forget it.
    if (index <= 0) {
      this.managed.delete(identity);
      return;
    }
    if (!(await this.closeTabsUnder(folders[index].uri.fsPath))) return;
    await updateFoldersAndWait(this.deps.vscode, index, 1);
    const current = await Promise.all(
      this.currentFolders().map((folder) => this.identity(folder.uri.fsPath)),
    );
    if (!current.includes(identity)) this.managed.delete(identity);
  }

  private async closeTabsUnder(folderPath: string): Promise<boolean> {
    const folder = path.resolve(folderPath);
    const tabsToClose = [];
    for (const group of this.deps.vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tab.input?.uri ?? tab.input?.modified;
        if (uri && isUnderOrEqual(path.resolve(uri.fsPath), folder)) {
          tabsToClose.push(tab);
        }
      }
    }
    if (tabsToClose.length === 0) return true;
    return await this.deps.vscode.window.tabGroups.close(tabsToClose, true);
  }
}
