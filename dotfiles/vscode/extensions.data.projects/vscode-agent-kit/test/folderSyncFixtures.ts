/**
 * Test doubles for the workspaceFolders sync: a vscode-shaped fake that
 * records workspace-folder, tab, and title operations (mirroring how VS
 * Code edits move a single-folder window to an untitled workspace), and
 * an injectable git runner serving porcelain text per repository.
 */

import path from "node:path";
import type {
  ConfigurationLike,
  TabLike,
  UriLike,
  VscodeLike,
  WorkspaceFolderLike,
} from "../src/folderSync";
import type { ExecFile, WorktreeEntry } from "../src/gitWorktrees";

// Mirrors the numeric value of vscode.ConfigurationTarget.Workspace.
export const WORKSPACE_TARGET = 2;

/** A workspaceFile URI as VS Code reports it for an untitled workspace. */
export function untitledWorkspace(): UriLike {
  return { scheme: "untitled", fsPath: "/1555503116870" };
}

/** A workspaceFile URI as VS Code reports it for a saved workspace file. */
export function savedWorkspace(fsPath: string): UriLike {
  return { scheme: "file", fsPath };
}

interface FakeTab extends TabLike {
  readonly uriPath: string;
}

// Like VscodeLike["workspace"] but with live mutable state so the fake can
// update folders and workspaceFile in place.
interface MutableWorkspace {
  workspaceFolders: WorkspaceFolderLike[] | undefined;
  workspaceFile: UriLike | undefined;
  getConfiguration(section: string): ConfigurationLike;
  updateWorkspaceFolders(
    start: number,
    deleteCount: number | undefined,
    ...foldersToAdd: { uri: UriLike; name?: string }[]
  ): boolean;
  onDidChangeWorkspaceFolders(listener: () => void): { dispose(): void };
}

export class FakeVscode implements VscodeLike {
  readonly configurationTarget = { Workspace: WORKSPACE_TARGET };
  /** When true, the next updateWorkspaceFolders call is rejected (returns false, changes nothing). */
  failNextUpdate = false;
  /** When true, the next tabGroups.close call simulates a cancelled confirmation dialog. */
  cancelNextTabClose = false;
  /** When true, configuration updates reject (title write failure). */
  failTitleUpdate = false;
  /** Number of updateWorkspaceFolders invocations (one ordered edit = one call). */
  updateCalls = 0;
  /** Current `window.title` value; configuration updates overwrite it. */
  windowTitle: string | undefined = undefined;
  added: { path: string; name: string | undefined }[] = [];
  removed: string[] = [];
  closedTabs: string[] = [];
  titleUpdates: { section: string; key: string; value: unknown; target: unknown }[] = [];

  private readonly tabs: FakeTab[] = [];
  private readonly listeners = new Set<() => void>();

  readonly workspace: MutableWorkspace = {
    workspaceFolders: [],
    workspaceFile: undefined,
    getConfiguration: (section: string): ConfigurationLike => ({
      update: (key: string, value: unknown, target: unknown) => {
        this.titleUpdates.push({ section, key, value, target });
        if (section === "window" && key === "title") {
          this.windowTitle = value as string;
        }
        if (this.failTitleUpdate) {
          return Promise.reject(new Error("configuration update failed"));
        }
        return Promise.resolve();
      },
    }),
    updateWorkspaceFolders: (
      start: number,
      deleteCount: number | undefined,
      ...toAdd: { uri: UriLike; name?: string }[]
    ) => {
      this.updateCalls += 1;
      if (this.failNextUpdate) {
        this.failNextUpdate = false;
        return false;
      }
      const folders = this.workspace.workspaceFolders ?? [];
      const removed = folders.splice(
        start,
        deleteCount ?? 0,
        ...toAdd.map((folder) => ({
          uri: folder.uri,
          name: folder.name ?? path.basename(folder.uri.fsPath),
        })),
      );
      this.workspace.workspaceFolders = folders;
      this.added.push(...toAdd.map((folder) => ({ path: folder.uri.fsPath, name: folder.name })));
      this.removed.push(...removed.map((folder) => folder.uri.fsPath));
      // Mirror VS Code: editing the folders of a single-folder window
      // (no workspace file yet) moves it to an untitled workspace.
      if (this.workspace.workspaceFile === undefined) {
        this.workspace.workspaceFile = untitledWorkspace();
      }
      for (const listener of this.listeners) {
        listener();
      }
      return true;
    },
    onDidChangeWorkspaceFolders: (listener: () => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    },
  };

  readonly window: VscodeLike["window"] = {
    tabGroups: {
      all: [{ tabs: this.tabs }],
      close: (tabs: readonly TabLike[], _preserveFocus?: boolean) => {
        if (this.cancelNextTabClose) {
          this.cancelNextTabClose = false;
          return Promise.resolve(false);
        }
        const closed = new Set(tabs as readonly FakeTab[]);
        for (let i = this.tabs.length - 1; i >= 0; i--) {
          if (closed.has(this.tabs[i])) {
            this.tabs.splice(i, 1);
          }
        }
        this.closedTabs.push(...tabs.map((tab) => (tab as FakeTab).uriPath));
        return Promise.resolve(true);
      },
    },
  };

  constructor(folderPaths: string[] | undefined, workspaceFile?: UriLike) {
    this.workspace.workspaceFolders = (folderPaths ?? []).map((p) => ({
      uri: { scheme: "file", fsPath: p },
      name: path.basename(p),
    }));
    this.workspace.workspaceFile = workspaceFile;
  }

  get folderPaths(): string[] {
    return (this.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  }

  openTabs(...uriPaths: string[]): void {
    for (const uriPath of uriPaths) {
      this.tabs.push({ uriPath, input: { uri: { fsPath: uriPath } } });
    }
  }

  get openTabPaths(): string[] {
    return this.tabs.map((tab) => tab.uriPath);
  }
}

export interface WtOptions {
  branch?: string;
  head?: string;
  prunable?: boolean;
}

const DEFAULT_HEAD = "0123456789abcdef0123456789abcdef01234567";

export function wt(entryPath: string, options: WtOptions = {}): WorktreeEntry {
  return {
    path: entryPath,
    head: options.head ?? DEFAULT_HEAD,
    branch: options.branch ?? null,
    prunable: options.prunable ?? false,
  };
}

function serializeEntries(entries: readonly WorktreeEntry[]): string {
  const blocks = entries.map((entry) => {
    const lines = [`worktree ${entry.path}`, `HEAD ${entry.head}`];
    if (entry.branch) {
      lines.push(`branch refs/heads/${entry.branch}`);
    } else {
      lines.push("detached");
    }
    if (entry.prunable) {
      lines.push("prunable");
    }
    return lines.join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

export interface FakeGit {
  exec: ExecFile;
  calls: { at: number; cwd: string; args: string[] }[];
  setEntries(entries: readonly WorktreeEntry[]): void;
  /** Makes the next exec call reject with an error. */
  failOnce(): void;
  /** Makes the next exec call block until the returned release function is called. */
  holdNext(): () => void;
}

/** A git runner serving fixed porcelain output (per cwd when a resolver is given). */
export function createFakeGit(
  entries: readonly WorktreeEntry[] | ((cwd: string) => readonly WorktreeEntry[]),
): FakeGit {
  let current: readonly WorktreeEntry[] | ((cwd: string) => readonly WorktreeEntry[]) = entries;
  let failing = false;
  let held: { release(): void } | undefined;
  const calls: FakeGit["calls"] = [];
  const exec: ExecFile = async (_file, args, options) => {
    calls.push({ at: Date.now(), cwd: options.cwd, args: [...args] });
    if (failing) {
      failing = false;
      throw new Error("git worktree list failed");
    }
    if (held !== undefined) {
      const gate = held;
      held = undefined;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    }
    const list = typeof current === "function" ? current(options.cwd) : current;
    return { stdout: serializeEntries(list) };
  };
  return {
    exec,
    calls,
    setEntries: (next) => {
      if (typeof current !== "function") current = next;
    },
    failOnce: () => {
      failing = true;
    },
    holdNext: () => {
      const gate: { release(): void } = {} as { release(): void };
      held = gate;
      return () => gate.release();
    },
  };
}
