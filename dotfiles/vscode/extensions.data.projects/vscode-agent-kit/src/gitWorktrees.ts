/**
 * Git worktree discovery: parsing of `git worktree list --porcelain`
 * output, worktree folder naming, and main-repository resolution from a
 * worktree's `.git` file. The exec runner is injectable so tests can feed
 * porcelain text without spawning git.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string;
  readonly branch: string | null;
  readonly prunable: boolean;
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<{ stdout: string }>;

export function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }

  const entries: WorktreeEntry[] = [];
  for (const block of blocks) {
    let worktreePath: string | undefined;
    let head: string | undefined;
    let branch: string | null = null;
    let bare = false;
    let prunable = false;
    for (const line of block) {
      const spaceAt = line.indexOf(" ");
      const key = spaceAt === -1 ? line : line.slice(0, spaceAt);
      const value = spaceAt === -1 ? "" : line.slice(spaceAt + 1);
      switch (key) {
        case "worktree":
          worktreePath = value;
          break;
        case "HEAD":
          head = value;
          break;
        case "branch":
          branch = value.replace(/^refs\/heads\//, "");
          break;
        case "bare":
          bare = true;
          break;
        case "prunable":
          prunable = true;
          break;
        // "detached" and "locked" markers and unknown keys are not
        // needed by the sync logic and are ignored.
      }
    }
    // SPEC workspaceFolders 同期/worktree の検出: bare repositories and
    // incomplete blocks (no worktree path or no HEAD line) are never
    // sync targets, so they do not become entries.
    if (worktreePath === undefined || bare || head === undefined) {
      continue;
    }
    entries.push({ path: worktreePath, head, branch, prunable });
  }
  return entries;
}

export async function listWorktrees(cwd: string, execFile: ExecFile): Promise<WorktreeEntry[]> {
  const { stdout } = await execFile("git", ["worktree", "list", "--porcelain"], {
    cwd,
  });
  return parseWorktreePorcelain(stdout);
}

/** SPEC: the folder label for a synced worktree is its branch name, or `(detached <HEAD7>)`. */
export function worktreeFolderName(entry: Pick<WorktreeEntry, "branch" | "head">): string {
  return entry.branch ?? `(detached ${entry.head.slice(0, 7)})`;
}

/**
 * Resolve the main repository root of a worktree folder from its `.git`
 * file: a linked worktree's `.git` file points at
 * `<main>/.git/worktrees/<id>`, so the main repository root is two
 * levels above the gitdir target. Returns undefined when the folder has
 * no readable `.git` file (main repositories have a `.git` directory)
 * or the gitdir does not have that shape (e.g. submodules), meaning the
 * folder is not a detectable worktree of a main repository.
 */
export async function resolveMainRepository(worktreeFolder: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(path.join(worktreeFolder, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir: (.+)$/m.exec(content.trim());
  if (match === null) return undefined;
  const gitdir = path.resolve(worktreeFolder, match[1].trim());
  const worktreesDir = path.dirname(gitdir);
  if (path.basename(worktreesDir) !== "worktrees" || path.basename(gitdir) === "") {
    return undefined;
  }
  return path.dirname(path.dirname(worktreesDir));
}
