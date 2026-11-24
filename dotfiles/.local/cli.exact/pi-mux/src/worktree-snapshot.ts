import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep, win32 } from "node:path";

export interface WorktreeSnapshotRequest {
  shellDirectories: string[];
  gitDirectories: string[];
  paths: string[];
}

const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export function parseWorktreeSnapshotRequest(encoded: string): WorktreeSnapshotRequest {
  const input: unknown = JSON.parse(encoded);
  if (typeof input === "object" && input !== null && Object.keys(input).length === 3) {
    const { shellDirectories, gitDirectories, paths } = input as Record<string, unknown>;
    if (isPathList(shellDirectories) && isPathList(gitDirectories) && isPathList(paths))
      return { shellDirectories, gitDirectories, paths };
  }
  throw new Error(
    "Invalid worktree snapshot request: expected shellDirectories, gitDirectories and paths with nonempty, NUL-free strings",
  );
}

export function getWorktreeSnapshot(request: WorktreeSnapshotRequest) {
  const base = realpathSync.native(process.cwd());
  let shellDirectory = base;
  let hasMissingDirectory = false;
  for (const word of request.shellDirectories) {
    const path = nativePath(word);
    if (!canChangeLogicalDirectory(shellDirectory, path)) hasMissingDirectory = true;
    shellDirectory = resolve(shellDirectory, path);
  }

  let gitDirectory = resolvePath(shellDirectory, base);
  for (const word of request.gitDirectories) {
    const next = physicalPath(nativePath(word), gitDirectory);
    const existing = realDirectory(next);
    if (!existing) hasMissingDirectory = true;
    gitDirectory = existing ?? resolvePath(next, base);
  }
  const paths = request.paths.map((word) => resolvePath(word, gitDirectory));
  if (hasMissingDirectory) throw unavailableDirectory("missing", gitDirectory, paths);

  const result = spawnSync(
    gitExecutable(),
    ["-C", gitDirectory, "worktree", "list", "--porcelain", "-z"],
    {
      shell: false,
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C" },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error("Git worktree list terminated: " + result.signal);
  if (result.status !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    if (result.stdout.length === 0 && stderr.startsWith("fatal: not a git repository"))
      throw unavailableDirectory("not-repository", gitDirectory, paths);
    throw new Error("Git worktree list failed: " + (stderr || result.status));
  }
  const output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout);
  const roots = parseWorktreeRoots(output);
  const worktrees = roots.flatMap(({ path, bare }) => {
    const root = bare ? undefined : realDirectory(path);
    const identity = root === undefined ? undefined : worktreeIdentity(root);
    return root && identity ? [{ path: root, identity }] : [];
  });
  if (
    new Set(worktrees.map(({ path }) => path)).size !== worktrees.length ||
    new Set(worktrees.map(({ identity }) => identity)).size !== worktrees.length
  )
    throw new Error("Duplicate paths or identities in Git worktree list");
  return { cwd: resolvePath(roots[0]!.path, gitDirectory), worktrees, paths };
}

export function gitExecutable(
  platform = process.platform,
  path = process.env.PATH ?? "",
  isFile = (candidate: string) => statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false,
): string {
  if (platform !== "win32") return "git";
  for (const entry of path.split(";")) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!win32.isAbsolute(directory) || win32.parse(directory).root.length === 1) continue;
    const candidate = win32.join(directory, "git.exe");
    if (isFile(candidate)) return candidate;
  }
  throw new Error("git.exe not found on absolute Windows PATH directories");
}

function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((path) => typeof path === "string" && path.length > 0 && !path.includes("\0"))
  );
}

export function nativePath(word: string, platform = process.platform): string {
  if (platform !== "win32") return word;
  const bashDrive = /^\/([a-z])(?=\/|$)/i.exec(word);
  if (bashDrive) return bashDrive[1]!.toUpperCase() + ":/" + word.slice(bashDrive[0].length + 1);
  if (/^[a-z]:(?![\\/])/i.test(word))
    throw new Error("Drive-relative worktree paths are not supported: " + JSON.stringify(word));
  return word;
}

function canChangeLogicalDirectory(cwd: string, path: string): boolean {
  const parentComponent =
    process.platform === "win32" ? /(?:^|[\\/])\.\.(?=[\\/]|$)/g : /(?:^|\/)\.\.(?=\/|$)/g;
  for (const match of path.matchAll(parentComponent)) {
    const throughSeparator = match.index + match[0].length - "..".length;
    if (!realDirectory(resolve(cwd, path.slice(0, throughSeparator)))) return false;
  }
  return realDirectory(resolve(cwd, path)) !== undefined;
}

function physicalPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return cwd + (cwd.endsWith(sep) ? "" : sep) + path;
  if (process.platform === "win32" && /^[\\/](?![\\/])/.test(path))
    return win32.parse(cwd).root + path.slice(1);
  return path;
}

function resolvePath(word: string, cwd: string): string {
  let ancestor = physicalPath(nativePath(word), cwd);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(ancestor), ...missing);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function realDirectory(path: string): string | undefined {
  try {
    if (statSync(path).isDirectory()) return realpathSync.native(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return undefined;
}

function isMissingPath(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException;
  return code === "ENOENT" || code === "ENOTDIR";
}

function unavailableDirectory(
  reason: "missing" | "not-repository",
  directory: string,
  paths: string[],
): Error {
  return new Error(
    "Worktree directory unavailable: " + JSON.stringify({ reason, directory, paths }),
  );
}

export function parseWorktreeRoots(output: string): { path: string; bare: boolean }[] {
  const invalid = new Error("Invalid or incomplete Git worktree list");
  if (!output.endsWith("\0\0")) throw invalid;
  return output
    .slice(0, -2)
    .split("\0\0")
    .map((record) => {
      const [root, ...fields] = record.split("\0");
      const prefix = "worktree ";
      if (!root?.startsWith(prefix)) throw invalid;
      const path = root.slice(prefix.length);
      if (!isAbsolute(path)) throw invalid;

      const bare = fields.includes("bare");
      const keys = fields.map((field) => field.split(" ", 1)[0]);
      if (
        new Set(keys).size !== keys.length ||
        !fields.every((field) =>
          /^(?:bare|detached|HEAD (?:[a-f0-9]{40}|[a-f0-9]{64})|branch refs\/[\s\S]+|(?:locked|prunable)(?: [\s\S]+)?)$/.test(
            field,
          ),
        ) ||
        (!bare && !keys.includes("HEAD"))
      )
        throw invalid;
      return { path, bare };
    });
}

function worktreeIdentity(path: string): string | undefined {
  const gitPath = resolve(path, ".git");
  try {
    const kind = statSync(gitPath);
    if (kind.isDirectory()) return realpathSync.native(gitPath);
    if (!kind.isFile()) return undefined;
    const pointer = readFileSync(gitPath, "utf8").replace(/[\r\n]+$/, "");
    const prefix = "gitdir: ";
    if (!pointer.startsWith(prefix) || pointer.length === prefix.length) return undefined;
    return realDirectory(physicalPath(nativePath(pointer.slice(prefix.length)), path));
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}
