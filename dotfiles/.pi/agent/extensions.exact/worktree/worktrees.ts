import { homedir } from "node:os";
import { basename, isAbsolute } from "node:path";
import { quote } from "shell-quote";
import { splitCommandSegments } from "../guardrails/config.ts";

export type WorktreeAction = "add" | "move" | "remove";
export interface WorktreeSnapshotRequest {
  shellDirectories: string[];
  gitDirectories: string[];
  paths: string[];
}
export interface WorktreeScope extends WorktreeSnapshotRequest {
  actions: WorktreeAction[];
  destinationIndexes: number[];
}
export type SnapshotQuery = (request: WorktreeSnapshotRequest) => Promise<WorktreeSnapshot>;

export class WorktreeDirectoryUnavailable extends Error {
  constructor(
    readonly reason: "missing" | "not-repository",
    readonly directory: string,
    readonly paths: string[],
  ) {
    super(`Worktree directory ${reason}: ${directory}`);
  }
}
export interface Worktree {
  path: string;
  identity: string;
}
export interface WorktreeSnapshot {
  cwd: string;
  worktrees: Worktree[];
  paths: string[];
}
export interface WorkspaceChanges {
  added: string[];
  moved: { from: string; to: string }[];
  removed: string[];
}

export function findWorktreeScopes(command: string): WorktreeScope[] {
  const home = process.env.HOME || homedir();
  let shellDirectories: string[] = [];
  const scopes: WorktreeScope[] = [];
  let lastKey: string | undefined;
  for (const segment of splitCommandSegments(expandBashHome(command, home))) {
    if (segment[0] === "cd") {
      const path = segment[1] === "--" ? segment[2] : segment[1];
      if (path === "-") continue;
      const directory = path ?? home;
      if (isPathWord(directory)) shellDirectories = [...shellDirectories, directory];
      continue;
    }
    const words = unwrapCommand(segment);
    if (basename(words[0] ?? "") !== "git") continue;
    const gitDirectories: string[] = [];
    let cursor = 1;
    let unusable = false;
    while (words[cursor]?.startsWith("-")) {
      const option = words[cursor++]!;
      if (option === "-C" || option.startsWith("-C")) {
        const directory = option === "-C" ? words[cursor++] : option.slice(2);
        if (!isPathWord(directory)) {
          unusable = true;
          break;
        }
        gitDirectories.push(directory);
      } else if (option === "-c" || option === "--git-dir" || option === "--work-tree") {
        cursor++;
      }
    }
    if (unusable || words[cursor] !== "worktree") continue;
    const action = words[cursor + 1];
    if (action !== "add" && action !== "move" && action !== "remove") continue;
    const operands = mutationOperands(words.slice(cursor + 2));
    const pathCount = action === "move" ? 2 : 1;
    const targets = operands.slice(0, pathCount);
    if (!targets.some(isPathWord)) continue;

    const key = JSON.stringify([shellDirectories, gitDirectories]);
    const previous = lastKey === key ? scopes.at(-1) : undefined;
    const scope: WorktreeScope = previous ?? {
      shellDirectories,
      gitDirectories,
      actions: [],
      paths: [],
      destinationIndexes: [],
    };
    if (!scope.actions.includes(action)) scope.actions.push(action);
    const destinationIndex = action === "move" ? 1 : action === "add" ? 0 : -1;
    for (const [index, path] of targets.entries()) {
      if (!isPathWord(path)) continue;
      if (index === destinationIndex) scope.destinationIndexes.push(scope.paths.length);
      scope.paths.push(path);
    }
    if (!previous) scopes.push(scope);
    lastKey = key;
  }
  return scopes;
}

export function parseWorktreeSnapshot(output: string, pathCount: number): WorktreeSnapshot {
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed === "object" && parsed !== null) {
    const { cwd, worktrees, paths } = parsed as Record<string, unknown>;
    if (
      isAbsolutePath(cwd) &&
      Array.isArray(worktrees) &&
      worktrees.every(isWorktree) &&
      new Set(worktrees.map(({ path }) => path)).size === worktrees.length &&
      new Set(worktrees.map(({ identity }) => identity)).size === worktrees.length &&
      isResolvedPathList(paths, pathCount)
    )
      return { cwd, worktrees, paths };
  }
  throw new Error("Invalid pi-mux worktree snapshot");
}

export function parseUnavailableDirectory(stderr: string, pathCount: number) {
  const prefix = "pi-mux: Worktree directory unavailable: ";
  if (!stderr.startsWith(prefix)) return undefined;
  const parsed: unknown = JSON.parse(stderr.slice(prefix.length));
  if (typeof parsed === "object" && parsed !== null) {
    const { reason, directory, paths } = parsed as Record<string, unknown>;
    if (
      (reason === "missing" || reason === "not-repository") &&
      isAbsolutePath(directory) &&
      isResolvedPathList(paths, pathCount)
    )
      return new WorktreeDirectoryUnavailable(reason, directory, paths);
  }
  throw new Error("Invalid pi-mux worktree directory error");
}

function isResolvedPathList(paths: unknown, count: number): paths is string[] {
  return Array.isArray(paths) && paths.length === count && paths.every(isAbsolutePath);
}

function isWorktree(value: unknown): value is Worktree {
  if (typeof value !== "object" || value === null) return false;
  const { path, identity } = value as Record<string, unknown>;
  return isAbsolutePath(path) && isPathWord(identity);
}

function isAbsolutePath(path: unknown): path is string {
  return isPathWord(path) && isAbsolute(path);
}

function isPathWord(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.includes("\0");
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
  query: SnapshotQuery,
  snapshots: WorktreeSnapshot[] = [],
): Promise<string[]> {
  const live = new Set(
    snapshots.flatMap((snapshot) => snapshot.worktrees.map((worktree) => worktree.path)),
  );
  const retained: string[] = [];
  for (const path of workspaces) {
    if (live.has(path)) {
      retained.push(path);
      continue;
    }
    try {
      const snapshot = await query({
        shellDirectories: [],
        gitDirectories: [path],
        paths: [path],
      });
      snapshot.worktrees.forEach((worktree) => live.add(worktree.path));
      const canonical = snapshot.paths[0]!;
      if (live.has(canonical)) retained.push(canonical);
    } catch (error) {
      if (!(error instanceof WorktreeDirectoryUnavailable)) throw error;
    }
  }
  return [...new Set(retained)];
}

function expandBashHome(command: string, home: string): string {
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
      result += quote([home]);
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
