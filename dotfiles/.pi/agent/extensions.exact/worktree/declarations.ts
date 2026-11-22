import { execFile } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { parseWorktreeRoots } from "./worktrees.ts";

const exec = promisify(execFile);
const NO_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_OPTIONS = [
  "-c",
  `core.hooksPath=${NO_CONFIG}`,
  "-c",
  "hook.reference-transaction.enabled=false",
  "-c",
  "core.fsmonitor=false",
];

type Repository = {
  main: string;
  common: string;
  subtrees: Set<string>;
};

export type VerifiedWorktree = {
  admin: string;
  isCurrent(): boolean;
};

export async function loadDeclarationRepository(
  cwd: string,
  signal: AbortSignal,
): Promise<Repository> {
  const roots = parseWorktreeRoots(
    await git(cwd, ["worktree", "list", "--porcelain", "-z"], signal),
    cwd,
  );
  if (roots[0]!.bare) throw new Error(`No main working tree for ${cwd}`);
  const main = realpathSync.native(roots[0]!.path);
  const commonPath = await git(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  const common = realpathSync.native(commonPath.replace(/\r?\n$/, ""));
  if (gitDirectory(main) !== common) throw new Error(`Cannot verify the main worktree at ${main}`);
  const subtrees = new Set(
    roots
      .slice(1)
      .filter(({ bare }) => !bare)
      .map(({ path }) => resolve(path)),
  );
  return { main, common, subtrees };
}

export function managedWorktreePath(home: string, main: string, name: string): string {
  const folder = /^(?:agents|copilot)-/.test(name) ? `wt-${name}` : name;
  const canonicalHome = realpathSync.native(home);
  const path = join(canonicalHome, ".agents", "worktrees", basename(main), folder);
  assertDirectoryChain(path, canonicalHome);
  return path;
}

export function verifyDeclaredWorktree(
  repository: Repository,
  path: string,
): VerifiedWorktree | undefined {
  if (!repository.subtrees.has(path)) return undefined;
  const identity = linkedWorktreeIdentity(repository.common, path);
  if (!identity) return undefined;
  return {
    admin: identity.admin,
    isCurrent() {
      const current = linkedWorktreeIdentity(repository.common, path);
      return current?.admin === identity.admin && current.key === identity.key;
    },
  };
}

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function createDeclaredWorktree(
  repository: Repository,
  path: string,
  name: string,
  signal: AbortSignal,
): Promise<VerifiedWorktree> {
  const { main, common } = repository;
  const source = [`--git-dir=${common}`, `--work-tree=${main}`];
  const commit = (
    await git(main, [...source, "rev-parse", "--verify", "HEAD^{commit}"], signal)
  ).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    throw new Error(`Invalid HEAD object ID for ${main}`);
  if (canonicalDirectory(common) !== common || gitDirectory(main) !== common)
    throw new Error(`Repository changed before creation: ${main}`);
  for (const dir of ["worktrees", "refs/heads", "logs/refs/heads", "reftable"])
    assertDirectoryChain(join(common, dir), common);
  assertDirectoryChain(path, parse(path).root);
  signal.throwIfAborted();
  if (pathExists(path)) throw new Error(`Worktree destination already exists: ${path}`);
  await git(
    main,
    [
      ...source,
      "worktree",
      "add",
      "--no-checkout",
      "--no-track",
      "--no-guess-remote",
      "-b",
      name,
      "--",
      path,
      commit,
    ],
    signal,
  );
  const refreshed = await loadDeclarationRepository(main, signal);
  const worktree = verifyDeclaredWorktree(refreshed, path);
  if (refreshed.common !== common || !worktree)
    throw new Error(`Git did not create the expected linked worktree at ${path}`);
  await checkoutWithoutRepositoryConfig(path, worktree, common, commit, signal);
  return worktree;
}

async function checkoutWithoutRepositoryConfig(
  path: string,
  worktree: VerifiedWorktree,
  common: string,
  commit: string,
  signal: AbortSignal,
): Promise<void> {
  const isolated = mkdtempSync(join(tmpdir(), "pi-worktree-checkout-"));
  try {
    const format = commit.length === 64 ? "sha256" : "sha1";
    await git(
      isolated,
      ["init", "--bare", "--template=", `--object-format=${format}`, isolated],
      signal,
    );
    const index = join(worktree.admin, "index");
    if (!worktree.isCurrent() || pathExists(index))
      throw new Error(`Worktree changed before checkout: ${path}`);
    await git(
      isolated,
      [
        `--git-dir=${isolated}`,
        `--work-tree=${path}`,
        "-c",
        "core.bare=false",
        "read-tree",
        "-m",
        "-u",
        commit,
      ],
      signal,
      { GIT_OBJECT_DIRECTORY: join(common, "objects"), GIT_INDEX_FILE: index },
    );
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  overrides?: NodeJS.ProcessEnv,
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
  );
  const { stdout } = await exec("git", [...GIT_OPTIONS, ...args], {
    cwd,
    signal,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...env,
      GIT_CONFIG_GLOBAL: NO_CONFIG,
      GIT_CONFIG_SYSTEM: NO_CONFIG,
      GIT_ALLOW_PROTOCOL: "",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...overrides,
    },
  });
  signal.throwIfAborted();
  return stdout;
}

function assertDirectoryChain(path: string, root: string): void {
  if (path === root) return;
  const parent = dirname(path);
  if (parent === path) throw new Error(`Path is outside the managed root: ${path}`);
  assertDirectoryChain(parent, root);
  if (pathExists(path) && canonicalDirectory(path) !== path)
    throw new Error(`Expected a directory without symbolic links: ${path}`);
}

function canonicalDirectory(path: string): string | undefined {
  return lstatSync(path).isDirectory() ? realpathSync.native(path) : undefined;
}

function readPointer(path: string): string | undefined {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.size > 16_384) return undefined;
  const value = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  return value !== "" && !value.includes("\0") ? value : undefined;
}

function gitDirectory(worktree: string): string | undefined {
  const path = join(worktree, ".git");
  if (lstatSync(path).isDirectory()) return realpathSync.native(path);
  const pointer = readPointer(path);
  return pointer?.startsWith("gitdir: ")
    ? realpathSync.native(resolve(worktree, pointer.slice(8)))
    : undefined;
}

function linkedWorktreeIdentity(
  common: string,
  path: string,
): { admin: string; key: string } | undefined {
  try {
    if (canonicalDirectory(path) !== path) return undefined;
    const admin = gitDirectory(path);
    const adminParent = join(common, "worktrees");
    if (!admin || dirname(admin) !== adminParent) return undefined;
    const adminPointer = readPointer(join(admin, "gitdir"));
    const commonPointer = readPointer(join(admin, "commondir"));
    if (
      !adminPointer ||
      !commonPointer ||
      resolve(admin, adminPointer) !== join(path, ".git") ||
      resolve(admin, commonPointer) !== common
    )
      return undefined;
    const stats = lstatSync(admin, { bigint: true });
    if (!stats.isDirectory()) return undefined;
    return { admin, key: `${stats.dev}:${stats.ino}:${stats.birthtimeNs}` };
  } catch {
    return undefined;
  }
}
