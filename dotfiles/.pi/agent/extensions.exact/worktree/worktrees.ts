import { homedir } from "node:os";
import { isAbsolute, posix, win32 } from "node:path";
import { quote } from "shell-quote";
import { splitCommandSegments } from "../guardrails/config.ts";

export type WorktreeMutation<Path> =
  | { action: "add" | "remove"; path: Path }
  | { action: "move"; from: Path | undefined; to: Path | undefined };
export interface WorktreeSnapshotRequest {
  shellDirectories: string[];
  gitDirectories: string[];
  paths: string[];
}
export interface WorktreeScope extends WorktreeSnapshotRequest {
  mutations: WorktreeMutation<number>[];
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

export function findWorktreeScopes(
  command: string,
  shell: "bash" | "powershell" = "bash",
  platform = process.platform,
): WorktreeScope[] {
  const home = process.env.HOME || homedir();
  const segments =
    shell === "bash"
      ? splitCommandSegments(expandBashHome(command, home))
      : platform === "win32"
        ? literalPowerShellGitCommands(command)
        : [];
  const scopes: WorktreeScope[] = [];
  let shellDirectories: string[] = [];
  let lastKey: string | undefined;
  for (const segment of segments) {
    if (shell === "bash" && segment[0] === "cd") {
      const path = segment[1] === "--" ? segment[2] : segment[1];
      if (path === "-") continue;
      const directory = path ?? home;
      if (isPathWord(directory)) shellDirectories = [...shellDirectories, directory];
      continue;
    }
    const words = shell === "bash" ? unwrapCommand(segment) : segment;
    if (!isGitExecutable(words[0] ?? "", platform)) continue;
    const gitDirectories: string[] = [];
    let cursor = 1;
    let unusable = false;
    while (words[cursor]?.startsWith("-")) {
      const option = words[cursor++]!;
      if (option === "-C" || (shell === "bash" && option.startsWith("-C"))) {
        const directory = option === "-C" ? words[cursor++] : option.slice(2);
        if (!isCommandPath(directory, shell)) {
          unusable = true;
          break;
        }
        gitDirectories.push(directory);
      } else if (shell === "powershell") {
        unusable = true;
        break;
      } else if (option === "-c" || option === "--git-dir" || option === "--work-tree") {
        cursor++;
      }
    }
    if (unusable || words[cursor] !== "worktree") continue;
    const action = words[cursor + 1];
    if (action !== "add" && action !== "move" && action !== "remove") continue;
    const operands = mutationOperands(words.slice(cursor + 2));
    const pathCount = action === "move" ? 2 : 1;
    const targets = operands
      .slice(0, pathCount)
      .map((path) => (isCommandPath(path, shell) ? path : undefined));
    if (targets.every((path) => path === undefined)) continue;
    if (shell === "powershell" && (targets.length < pathCount || targets.includes(undefined)))
      continue;

    const key = JSON.stringify([shellDirectories, gitDirectories]);
    const previous = lastKey === key ? scopes.at(-1) : undefined;
    const scope: WorktreeScope = previous ?? {
      shellDirectories,
      gitDirectories,
      paths: [],
      mutations: [],
    };
    const [first, second] = targets.map((path) =>
      path === undefined ? undefined : scope.paths.push(path) - 1,
    );
    if (action === "move") scope.mutations.push({ action, from: first, to: second });
    else if (first !== undefined) scope.mutations.push({ action, path: first });
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

export function resolveMutationPaths(
  mutations: WorktreeMutation<number>[],
  paths: string[],
): WorktreeMutation<string>[] {
  return mutations.map((mutation) =>
    mutation.action === "move"
      ? {
          action: "move",
          from: mutation.from === undefined ? undefined : paths[mutation.from],
          to: mutation.to === undefined ? undefined : paths[mutation.to],
        }
      : { action: mutation.action, path: paths[mutation.path]! },
  );
}

export function detectWorkspaceChanges(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
  mutations: WorktreeMutation<string>[],
): WorkspaceChanges {
  const oldByIdentity = new Map(
    before.worktrees.map((worktree) => [worktree.identity, worktree.path]),
  );
  const newByIdentity = new Map(
    after.worktrees.map((worktree) => [worktree.identity, worktree.path]),
  );
  const livePaths = new Set(newByIdentity.values());
  const addPaths = new Set<string>();
  const movePaths = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.action === "add") addPaths.add(mutation.path);
    if (mutation.action !== "move" || !mutation.from || !mutation.to) continue;
    movePaths.add(mutation.from);
    movePaths.add(mutation.to);
    if (addPaths.has(mutation.from) && !livePaths.has(mutation.from)) addPaths.add(mutation.to);
  }
  return {
    added: after.worktrees
      .filter(({ path, identity }) => addPaths.has(path) && !oldByIdentity.has(identity))
      .map(({ path }) => path),
    moved: before.worktrees.flatMap((worktree) => {
      const target = newByIdentity.get(worktree.identity);
      const isTargeted =
        movePaths.has(worktree.path) || (target !== undefined && movePaths.has(target));
      return target && target !== worktree.path && isTargeted
        ? [{ from: worktree.path, to: target }]
        : [];
    }),
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

function isGitExecutable(executable: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return posix.basename(executable) === "git";
  const name = win32.basename(executable).toLowerCase();
  return name === "git" || name === "git.exe";
}

function isCommandPath(path: unknown, shell: "bash" | "powershell"): path is string {
  if (!isPathWord(path)) return false;
  if (shell === "bash") return true;
  return !/^(?:\/[a-z](?:\/|$)|[a-z]:(?![\\/]))/i.test(path);
}

function literalPowerShellGitCommands(command: string): string[][] {
  if (command.includes("\0")) return [];
  const statementStart = /(?:[ \t;\r\n]|#[^\r\n]*)*/y;
  const gitInvocation = /(?:&[ \t]*(["']?)git(?:\.exe)?\1|git(?:\.exe)?)(?=[ \t;\r\n]|$)/iy;
  const literalArgument =
    /[ \t]+(?:'((?:[^'\r\n\u2018-\u201b]|'')*)'|"([^"$`\r\n\u201c-\u201f]*)"|([^\s'"`$;&|()[\]{},<>@#\u2018-\u201f]+))(?=[ \t;\r\n]|$)/y;
  const statementEnd = /[ \t]*(?:#[^\r\n]*)?(?:[;\r\n]|$)/y;
  const commands: string[][] = [];
  let offset = 0;
  while (offset < command.length) {
    statementStart.lastIndex = offset;
    statementStart.exec(command);
    gitInvocation.lastIndex = statementStart.lastIndex;
    if (!gitInvocation.exec(command)) break;

    const words = ["git"];
    literalArgument.lastIndex = gitInvocation.lastIndex;
    statementEnd.lastIndex = gitInvocation.lastIndex;
    for (let match = literalArgument.exec(command); match; match = literalArgument.exec(command)) {
      const [, singleQuoted, doubleQuoted, bare] = match;
      const word = singleQuoted?.replaceAll("''", "'") ?? doubleQuoted ?? bare!;
      if (word === "" || word === "--%" || word.includes('"')) return commands;
      words.push(word);
      statementEnd.lastIndex = literalArgument.lastIndex;
    }
    if (!statementEnd.exec(command)) break;
    commands.push(words);
    offset = statementEnd.lastIndex;
  }
  return commands;
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
