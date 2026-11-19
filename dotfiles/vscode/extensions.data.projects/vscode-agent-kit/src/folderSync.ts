/**
 * workspaceFolders sync (SPEC "workspaceFolders 同期"): the startup folder-0
 * swap into the agents workspace, periodic worktree detection, the ordered
 * managed-folder application, and the untitled-workspace title bar write.
 * Folder 0 (`~/.agents/agents-workspace`) is fixed and never managed; folder
 * 1 and beyond are all managed folders.
 *
 * The pi-mux list side of the sync is push-driven: the session provider
 * calls updateList() with the latest `pi-mux list` cwds on every successful
 * list acquisition, and each call applies one ordered diff. Worktree
 * detection runs on its own 2500 ms timer. The vscode API is injected as
 * VscodeLike so the sync logic never imports "vscode" and tests can use a
 * plain fake.
 */

import { mkdir, realpath } from "node:fs/promises";
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

/** One managed folder entry of the desired order (folder 1 and beyond). */
interface DesiredFolder {
  readonly identity: string;
  readonly uri: UriLike;
  readonly name?: string;
}

function byFolderName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export interface FolderSyncDeps {
  readonly vscode: VscodeLike;
  readonly execFile: ExecFile;
  /** Home directory used to locate `~/.agents/agents-workspace`. */
  readonly homeDir: string;
  /** Overrides path identity resolution for tests. */
  readonly resolveIdentity?: (folderPath: string) => Promise<string>;
  /** Overrides agents-workspace directory creation for tests. */
  readonly ensureDirectory?: (dirPath: string) => Promise<void>;
}

export class FolderSyncEngine {
  private readonly agentsWorkspace: string;
  private started = false;
  private stopped = false;
  /** SPEC: an empty window (folder 0 only) neither transitions nor syncs. */
  private syncDisabled = false;
  /** SPEC: a rejected folder-0 swap is retried before the next sync application. */
  private swapPending = false;
  /** SPEC: the first folder application waits for the first successful list acquisition. */
  private listReceived = false;
  private detectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Main repository identity per workspace folder identity (folder 1 and beyond); a failed `.git` read keeps the previous entry. */
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
   * Receive the latest `pi-mux list` cwds and apply one ordered diff.
   * Called by the session provider on every successful list acquisition;
   * the first call marks that acquisition as done.
   */
  updateList(cwds: readonly string[]): void {
    if (!this.started || this.stopped) return;
    this.listReceived = true;
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

  /** SPEC: the agents workspace directory is created before it becomes folder 0. */
  private ensureDirectory(dirPath: string): Promise<void> {
    const ensure = this.deps.ensureDirectory;
    if (ensure !== undefined) return ensure(dirPath);
    return mkdir(dirPath, { recursive: true }).then(() => undefined);
  }

  private currentFolders(): readonly WorkspaceFolderLike[] {
    return this.deps.vscode.workspace.workspaceFolders ?? [];
  }

  /**
   * SPEC 起動時のワークスペース遷移: swap folder 0 to the agents workspace
   * for any other startup configuration, promote a single-folder window
   * already on the agents workspace to an untitled workspace, write the
   * title bar, and start detection. An empty window neither transitions
   * nor syncs.
   */
  private async startup(): Promise<void> {
    if (this.stopped) return;
    const workspace = this.deps.vscode.workspace;
    const folders = workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
      this.syncDisabled = true;
      return;
    }
    const agentsIdentity = await this.identity(this.agentsWorkspace);
    const folder0Identity = await this.identity(folders[0].uri.fsPath);
    if (this.stopped) return;
    if (folder0Identity !== agentsIdentity) {
      if (!(await this.swapFolder0())) this.swapPending = true;
    } else if (folders.length === 1 && workspace.workspaceFile === undefined) {
      await this.promoteSingleFolder();
    }
    // Title updates are cosmetic; a failure must not break the sync.
    await this.applyTitle().catch(() => undefined);
    this.scheduleDetection(WORKTREE_DETECT_INTERVAL_MS);
  }

  /**
   * SPEC 起動時の遷移: re-apply folder 0 with identical content; the edit
   * itself moves the single-folder window to an untitled workspace. A
   * rejected edit just aborts the transition: later folder applications
   * bring the untitled state.
   */
  private async promoteSingleFolder(): Promise<void> {
    // Folders may have grown while the identities were resolved; only a
    // still-single-folder workspace takes the transition.
    const current = this.currentFolders();
    if (current.length !== 1) return;
    await updateFoldersAndWait(this.deps.vscode, 0, 1, {
      uri: current[0].uri,
      name: current[0].name,
    });
  }

  /**
   * SPEC 起動時の付け替え: insert the agents workspace at position 0 and
   * move the previous folder 0 to position 1 with one edit; in folder
   * mode the edit itself transitions the window to an untitled
   * workspace. The agents workspace directory is created first when it
   * does not exist. Returns false when the edit is rejected or did not
   * take effect, so the caller retries before the next sync application.
   */
  private async swapFolder0(): Promise<boolean> {
    const folders = this.currentFolders();
    if (folders.length === 0) return false;
    const agentsIdentity = await this.identity(this.agentsWorkspace);
    const previousFolder0 = folders[0];
    if ((await this.identity(previousFolder0.uri.fsPath)) === agentsIdentity) return true;
    try {
      await this.ensureDirectory(this.agentsWorkspace);
    } catch {
      return false;
    }
    // Folders may have changed while the identities were resolved.
    const current = this.currentFolders();
    if (current.length === 0 || current[0].uri.fsPath !== previousFolder0.uri.fsPath) {
      return false;
    }
    await updateFoldersAndWait(
      this.deps.vscode,
      0,
      1,
      { uri: { fsPath: this.agentsWorkspace } },
      { uri: previousFolder0.uri, name: previousFolder0.name },
    );
    const after = this.currentFolders();
    if (after.length === 0) return false;
    return (await this.identity(after[0].uri.fsPath)) === agentsIdentity;
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
   * cwds plus gitdir-resolvable workspace folders), run
   * `git worktree list --porcelain` per candidate, and keep each
   * candidate's previous results when its git run fails. Results are
   * keyed by the main repository identity: a candidate that is itself a
   * linked worktree reports its whole repository, so its entries group
   * under the main repository. The main worktree (always the first
   * porcelain entry) is excluded.
   */
  private async detect(): Promise<void> {
    if (this.stopped || this.syncDisabled) return;
    const folders = this.currentFolders();
    const identities = await Promise.all(folders.map((folder) => this.identity(folder.uri.fsPath)));
    const candidates = new Set<string>();
    for (const cwd of this.latestListCwds) {
      candidates.add(await this.identity(cwd));
    }
    const folderIdentities = new Set(identities.slice(1));
    for (let i = 1; i < folders.length; i++) {
      const repository = await resolveMainRepository(folders[i].uri.fsPath);
      if (repository !== undefined) {
        this.gitRepos.set(identities[i], await this.identity(repository));
      }
      // An unreadable `.git` keeps the previous repository entry so
      // detection is held instead of dropping the worktrees.
    }
    for (const identity of this.gitRepos.keys()) {
      if (!folderIdentities.has(identity)) this.gitRepos.delete(identity);
    }
    for (const repository of this.gitRepos.values()) {
      candidates.add(repository);
    }
    const candidateRepos = new Set<string>();
    for (const candidate of candidates) {
      // A linked-worktree candidate reports its whole repository, so the
      // results group under the resolved main repository identity.
      const repository = await resolveMainRepository(candidate);
      const repoIdentity = repository !== undefined ? await this.identity(repository) : candidate;
      candidateRepos.add(repoIdentity);
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
      this.repoWorktrees.set(repoIdentity, found);
    }
    for (const repoIdentity of this.repoWorktrees.keys()) {
      if (!candidateRepos.has(repoIdentity)) this.repoWorktrees.delete(repoIdentity);
    }
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
   * SPEC フォルダの並び: the desired folder 1+ order is the pi-mux list
   * order. Each listed main repository's own worktrees (not themselves
   * list cwds) follow it directly in display-name order; a folder that is
   * both a list cwd and a worktree keeps its list position and its
   * existing name. Worktrees whose main repository is not a list cwd are
   * appended at the end in display-name order. The agents workspace
   * (folder 0) and duplicate identities are never included.
   */
  private async desiredFolders(
    folders: readonly WorkspaceFolderLike[],
    identities: readonly string[],
  ): Promise<DesiredFolder[]> {
    const seen = new Set<string>([await this.identity(this.agentsWorkspace)]);
    // Existing folders keep their uri and name so a re-edit never renames
    // them.
    const existing = new Map<string, WorkspaceFolderLike>();
    for (let i = 1; i < folders.length; i++) {
      existing.set(identities[i], folders[i]);
    }

    const desired: DesiredFolder[] = [];
    const pushFolder = (identity: string, folderPath: string, name: string | undefined) => {
      if (seen.has(identity)) return;
      seen.add(identity);
      const current = existing.get(identity);
      desired.push({
        identity,
        uri: current?.uri ?? { fsPath: folderPath },
        name: current?.name ?? name,
      });
    };

    const detected = new Map<string, DetectedWorktree>();
    for (const worktrees of this.repoWorktrees.values()) {
      for (const [identity, worktree] of worktrees) detected.set(identity, worktree);
    }
    const listedIdentities = new Set<string>();
    for (const cwd of this.latestListCwds) {
      listedIdentities.add(await this.identity(cwd));
    }

    for (const cwd of this.latestListCwds) {
      const identity = await this.identity(cwd);
      if (seen.has(identity)) continue;
      pushFolder(identity, cwd, detected.get(identity)?.name);
      const worktrees = this.repoWorktrees.get(identity);
      if (worktrees === undefined) continue;
      for (const [worktreeIdentity, worktree] of [...worktrees].sort(([, a], [, b]) =>
        byFolderName(a, b),
      )) {
        // A worktree that is also a list cwd is placed at its list
        // position, not inside this group.
        if (listedIdentities.has(worktreeIdentity)) continue;
        pushFolder(worktreeIdentity, worktree.path, worktree.name);
      }
    }

    const orphanWorktrees: Array<{ identity: string; worktree: DetectedWorktree }> = [];
    for (const [repoIdentity, worktrees] of this.repoWorktrees) {
      if (listedIdentities.has(repoIdentity)) continue;
      for (const [identity, worktree] of worktrees) {
        orphanWorktrees.push({ identity, worktree });
      }
    }
    orphanWorktrees.sort((a, b) => byFolderName(a.worktree, b.worktree));
    for (const { identity, worktree } of orphanWorktrees) {
      pushFolder(identity, worktree.path, worktree.name);
    }
    return desired;
  }

  /**
   * SPEC 管理フォルダの同期: build the desired folder 1+ order from the
   * latest list and the detected worktrees and, when the current folders
   * differ (order included), close the tabs under the folders that leave
   * and replace folder 1 and beyond with one edit. Additions, removals,
   * and reordering are that single edit. A cancelled tab dialog or a
   * rejected edit keeps the current state so the next sync retries.
   */
  private async applySync(): Promise<void> {
    if (this.stopped || this.syncDisabled) return;
    if (this.swapPending) {
      if (!(await this.swapFolder0())) return;
      this.swapPending = false;
      // The swap can move the window to an untitled workspace; the title
      // write is cosmetic and must not break the sync.
      await this.applyTitle().catch(() => undefined);
    }
    if (!this.listReceived) return;
    const folders = this.currentFolders();
    if (folders.length === 0) return;
    const identities = await Promise.all(folders.map((folder) => this.identity(folder.uri.fsPath)));
    const desired = await this.desiredFolders(folders, identities);
    const isSameOrder =
      identities.length === desired.length + 1 &&
      desired.every((entry, i) => entry.identity === identities[i + 1]);
    if (isSameOrder) return;

    const desiredIdentities = new Set(desired.map((entry) => entry.identity));
    for (let i = 1; i < folders.length; i++) {
      if (desiredIdentities.has(identities[i])) continue;
      // Tabs under leaving folders close first and follow VS Code's
      // confirmation dialog for unsaved changes; a cancelled dialog
      // aborts the application so the next sync retries.
      if (!(await this.closeTabsUnder(folders[i].uri.fsPath))) return;
    }
    await updateFoldersAndWait(
      this.deps.vscode,
      1,
      folders.length - 1,
      ...desired.map((entry) => ({ uri: entry.uri, name: entry.name })),
    );
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
