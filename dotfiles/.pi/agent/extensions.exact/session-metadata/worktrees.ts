import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { quote } from "shell-quote";
import { splitCommandSegments } from "../guardrails/config.ts";

export type BashQuery = (command: string) => Promise<string>;
export type WorktreeAction = "add" | "move" | "remove";
export interface WorktreeScope {
  cwd: string;
  actions: WorktreeAction[];
  paths: string[];
}
export interface Worktree {
  path: string;
  identity: string;
}
export interface WorktreeSnapshot {
  cwd: string;
  worktrees: Worktree[];
}
export interface WorkspaceChanges {
  added: string[];
  moved: { from: string; to: string }[];
  removed: string[];
}

function resolveScopePath(path: string, cwd: string): string | undefined {
  if (path.length === 0 || path.includes("\0")) return undefined;
  return resolveWorktreePath(path, cwd);
}

export function findWorktreeScopes(command: string, cwd: string): WorktreeScope[] {
  let shellCwd = cwd;
  const scopes = new Map<string, WorktreeScope>();
  for (const segment of splitCommandSegments(expandBashHome(command))) {
    if (segment[0] === "cd") {
      const path = segment[1] === "--" ? segment[2] : segment[1];
      if (path === "-") continue;
      shellCwd = resolve(shellCwd, path ?? homedir());
      continue;
    }
    const words = unwrapCommand(segment);
    if (basename(words[0] ?? "") !== "git") continue;
    let gitCwd = resolveWorktreePath(shellCwd, cwd);
    let cursor = 1;
    let unusable = false;
    while (words[cursor]?.startsWith("-")) {
      const option = words[cursor++]!;
      if (option === "-C") {
        if (words[cursor] === undefined) break;
        const next = resolveScopePath(words[cursor++]!, gitCwd);
        if (next === undefined) {
          unusable = true;
          break;
        }
        gitCwd = next;
      } else if (option.startsWith("-C") && option.length > 2) {
        const next = resolveScopePath(option.slice(2), gitCwd);
        if (next === undefined) {
          unusable = true;
          break;
        }
        gitCwd = next;
      } else if (option === "-c" || option === "--git-dir" || option === "--work-tree") {
        cursor++;
      }
    }
    if (unusable) continue;
    if (words[cursor] !== "worktree") continue;
    const action = words[cursor + 1];
    if (action !== "add" && action !== "move" && action !== "remove") continue;
    const operands = mutationOperands(words.slice(cursor + 2));
    const pathCount = action === "move" ? 2 : 1;
    const paths = operands
      .slice(0, pathCount)
      .map((path) => resolveScopePath(path, gitCwd))
      .filter((path): path is string => path !== undefined);
    if (paths.length === 0) continue;
    const scope: WorktreeScope = scopes.get(gitCwd) ?? { cwd: gitCwd, actions: [], paths: [] };
    scope.actions = [...new Set<WorktreeAction>([...scope.actions, action])];
    scope.paths.push(...paths);
    scopes.set(gitCwd, scope);
  }
  return [...scopes.values()];
}

export async function loadWorktreeSnapshot(cwd: string, run: BashQuery): Promise<WorktreeSnapshot> {
  const output = await run(quote(["git", "-C", cwd, "worktree", "list", "--porcelain", "-z"]));
  if (!output.startsWith("worktree ") || !output.endsWith("\0\0"))
    throw new Error(`Invalid or incomplete Git worktree list for ${cwd}`);
  const records = output.split("\0\0").filter(Boolean);
  const roots = records.map((record) => {
    const fields = record.split("\0");
    const path = fields[0]!.slice("worktree ".length);
    if (!fields[0]!.startsWith("worktree ") || !isAbsolute(path))
      throw new Error(`Invalid Git worktree path for ${cwd}`);
    return { path, bare: fields.includes("bare") };
  });
  const mainPath = roots[0]!.path;
  const worktrees = roots
    .filter((root) => !root.bare)
    .flatMap(({ path }) => {
      const identity = worktreeIdentity(path);
      return identity ? [{ path: realpathSync(path), identity }] : [];
    });
  return { cwd: mainPath, worktrees };
}

export function detectWorkspaceChanges(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
  actions: WorktreeAction[],
  paths: string[],
): WorkspaceChanges {
  const oldByIdentity = new Map(
    before.worktrees.map((worktree) => [worktree.identity, worktree.path]),
  );
  const newByIdentity = new Map(
    after.worktrees.map((worktree) => [worktree.identity, worktree.path]),
  );
  return {
    added: actions.includes("add")
      ? after.worktrees
          .filter(
            (worktree) => paths.includes(worktree.path) && !oldByIdentity.has(worktree.identity),
          )
          .map((worktree) => worktree.path)
      : [],
    moved: actions.includes("move")
      ? before.worktrees.flatMap((worktree) => {
          const target = newByIdentity.get(worktree.identity);
          const isTargeted =
            paths.includes(worktree.path) || (target !== undefined && paths.includes(target));
          return target && target !== worktree.path && isTargeted
            ? [{ from: worktree.path, to: target }]
            : [];
        })
      : [],
    removed: before.worktrees
      .filter((worktree) => !newByIdentity.has(worktree.identity))
      .map((worktree) => worktree.path),
  };
}

export function applyWorkspaceChanges(workspaces: string[], changes: WorkspaceChanges): string[] {
  const moved = new Map(changes.moved.map(({ from, to }) => [from, to]));
  const remaining = workspaces
    .filter((path) => !changes.removed.includes(path))
    .map((path) => moved.get(path) ?? path);
  return [...new Set([...remaining, ...changes.added])];
}

export async function retainLiveWorkspaces(
  workspaces: string[],
  run: BashQuery,
  snapshots: WorktreeSnapshot[] = [],
): Promise<string[]> {
  const live = new Set(
    snapshots.flatMap((snapshot) => snapshot.worktrees.map((worktree) => worktree.path)),
  );
  const retained: string[] = [];
  for (const path of workspaces) {
    if (!worktreeIdentity(path)) continue;
    const canonical = realpathSync(path);
    if (!live.has(canonical)) {
      const snapshot = await loadWorktreeSnapshot(canonical, run);
      snapshot.worktrees.forEach((worktree) => live.add(worktree.path));
    }
    if (live.has(canonical)) retained.push(canonical);
  }
  return [...new Set(retained)];
}

export function normalizeWorkspacePath(path: string, cwd: string): string {
  const reference = path.startsWith("@") ? path.slice(1) : path;
  const expanded =
    reference === "~"
      ? homedir()
      : reference.startsWith("~/")
        ? `${homedir()}/${reference.slice(2)}`
        : reference;
  return resolveWorktreePath(expanded, cwd);
}

function resolveWorktreePath(path: string, cwd: string): string {
  if (path.length === 0 || path.includes("\0"))
    throw new Error("Invalid empty or NUL-containing worktree path");
  const absolute = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  let ancestor = absolute;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(absolute);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync.native(ancestor), ...missing);
}

function expandBashHome(command: string): string {
  let result = "";
  let activeQuote: string | undefined;
  let wordStart = true;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === "\\" && activeQuote !== "'") {
      result += command.slice(index, index + 2);
      if (command[index + 1] !== "\n") wordStart = false;
      index++;
      continue;
    }
    if (activeQuote !== undefined) {
      if (character === activeQuote) activeQuote = undefined;
    } else if (character === "'" || character === '"') {
      activeQuote = character;
    } else if (wordStart && character === "#") {
      const newline = command.indexOf("\n", index);
      if (newline === -1) return result + command.slice(index);
      result += command.slice(index, newline + 1);
      index = newline;
      wordStart = true;
      continue;
    } else if (/\s|[;&|()<>]/.test(character)) {
      result += character;
      wordStart = true;
      continue;
    } else if (
      wordStart &&
      character === "~" &&
      (command[index + 1] === "/" || /\s|[;&|()<>]|^$/.test(command[index + 1] ?? ""))
    ) {
      result += quote([homedir()]);
      wordStart = false;
      continue;
    }
    result += character;
    wordStart = false;
  }
  return result;
}

function mutationOperands(words: string[]): string[] {
  const operands: string[] = [];
  let literal = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (!literal && word === "--") literal = true;
    else if (!literal && ["-b", "-B", "--reason"].includes(word)) index++;
    else if (literal || !word.startsWith("-")) operands.push(word);
  }
  return operands;
}

function unwrapCommand(words: string[]): string[] {
  if (words[0] === "command") return words.slice(1);
  if (words[0] !== "rtk") return words;
  return words[1] === "proxy" ? words.slice(2) : words.slice(1);
}

function worktreeIdentity(path: string): string | undefined {
  const gitPath = join(path, ".git");
  if (!existsSync(gitPath) || !statSync(path).isDirectory()) return undefined;
  if (statSync(gitPath).isDirectory()) return realpathSync(gitPath);
  const pointer = readFileSync(gitPath, "utf8").trim();
  if (!pointer.startsWith("gitdir: ")) return undefined;
  const directory = resolve(path, pointer.slice("gitdir: ".length));
  return existsSync(directory) ? realpathSync(directory) : undefined;
}
