// Materialize external.data.yaml entries from GitHub mirrors after all path maps.
import { type Dirent, existsSync, statSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { editMarkdown, normalizeMarkdownEdits, type MarkdownEdit } from "./build-edit-markdown.ts";
import { fileOperationConcurrency, runWithConcurrency } from "./concurrency.ts";
import {
  guestMirrorPath,
  mirrorRoot,
  resolveWsl,
  runWsl,
  runProcess,
  type WslConnection,
} from "./wsl.ts";
import { parseDocument } from "yaml";

const externalFileName = "external.data.yaml";

type ProcessResult = { ok: boolean; stdout: string; stderr: string };
type TextEdit = { path: string; text: string };
type ExternalRepo = {
  repo: string;
  destination: string;
  entries: string[];
  exclude: string[];
  ttlMs: number;
  runAfter: string[][];
  edits: TextEdit[];
  markdownEdits: MarkdownEdit[];
};
type ExternalConfig = { repos: ExternalRepo[] };
type SyncContext = {
  mirrorRoot: string;
  forcePull: boolean;
  repoUrl: (repo: string) => string;
  runGit: (args: string[]) => Promise<ProcessResult>;
  runCommand: (args: string[], cwd: string) => Promise<ProcessResult>;
};

type MirrorSyncResult = { mirrorDir: string; changed: boolean };

const externalMachineFileName = "external.machine-data.yaml";

const defaultTtlHours = 6;
const pullTimeFileName = "build-pull-time";
const defaultMirrorRoot = join(homedir(), "mirrors", "github.com");
// Without core.longpaths, Git for Windows cannot delete paths over MAX_PATH (learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation)
const longPathArgs = ["-c", "core.longpaths=true"];

async function defaultContext(connection?: WslConnection): Promise<SyncContext> {
  const wsl = connection ?? (await resolveWsl(resolve(import.meta.dir, "../..")));
  if (wsl) {
    return {
      mirrorRoot: mirrorRoot(wsl),
      forcePull: process.env.BUILD_FORCE_PULL === "1",
      repoUrl: (repo) => `https://github.com/${repo}.git`,
      runGit: (args) => {
        const guestArgs = [...args];
        if (guestArgs[0] === "-C") guestArgs[1] = guestMirrorPath(wsl, guestArgs[1]!);
        if (guestArgs[0] === "clone")
          guestArgs[guestArgs.length - 1] = guestMirrorPath(wsl, guestArgs.at(-1)!);
        return runWsl(wsl, ["git", ...guestArgs]);
      },
      runCommand: (args, cwd) => runWsl(wsl, args, guestMirrorPath(wsl, cwd)),
    };
  }
  return {
    mirrorRoot: defaultMirrorRoot,
    forcePull: process.env.BUILD_FORCE_PULL === "1",
    repoUrl: (repo) => `https://github.com/${repo}.git`,
    runGit: (args) => runProcess(["git", ...longPathArgs, ...args]),
    runCommand: (args, cwd) => runProcess(args, cwd),
  };
}

export async function syncGithubMirror(repo: string, connection?: WslConnection): Promise<string> {
  const sync = await syncMirror(
    repo,
    defaultTtlHours * 60 * 60 * 1000,
    await defaultContext(connection),
  );
  return sync.mirrorDir;
}

export async function applyExternals(
  distDir: string,
  connection: WslConnection | undefined,
  platform: string,
): Promise<void> {
  const configPaths: string[] = [];
  async function collect(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.isFile() && entry.name === externalFileName)
        configPaths.push(join(directory, entry.name));
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules")
        await collect(join(directory, entry.name));
    }
  }
  await collect(distDir);
  const context = await defaultContext(connection);
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    const config = await loadExternalConfig(configPath, platform);
    await Promise.all(
      config.repos.map(async (repo) => {
        const sync = await syncMirror(repo.repo, repo.ttlMs, context);
        if (sync.changed && repo.runAfter.length > 0)
          await runAfterCommands(repo.repo, sync.mirrorDir, repo.runAfter, context);
        await copyRepoEntries(
          sync.mirrorDir,
          join(dirname(configPath), repo.destination),
          repo.entries,
          repo.edits,
          repo.markdownEdits,
          repo.exclude,
        );
      }),
    );
  }
}

export async function loadExternalConfig(configPath: string, platform: string): Promise<ExternalConfig> {
  const repos = await readExternalRepos(configPath);
  // Replacement layers per repo key, later ones win (spec: SPEC.md §build: 外部取得):
  // shared -> platform layer (matching build platform only) -> machine layer
  // -> platform machine layer.
  const dir = dirname(configPath);
  const byRepo = new Map(repos.map((repo) => [repo.repo, repo]));
  const replacementNames = [
    `external.${platform}-data.yaml`,
    "external.machine-data.yaml",
    `external.${platform}-machine-data.yaml`,
  ];
  for (const name of replacementNames) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    for (const repo of await readExternalRepos(path)) byRepo.set(repo.repo, repo);
  }
  return { repos: [...byRepo.values()] };
}

async function readExternalRepos(configPath: string): Promise<ExternalRepo[]> {
  const document = parseDocument(await readFile(configPath, "utf-8"));
  if (document.errors.length > 0) throw document.errors[0];
  const doc: unknown = document.toJS();
  const repos = (doc as { repos?: unknown })?.repos;
  if (!isPlainObject(repos))
    throw new Error(`${basename(configPath)} must have a repos mapping: ${configPath}`);
  const ordered: unknown = document.toJS({ mapAsMap: true });
  const orderedRepos: unknown = ordered instanceof Map ? ordered.get("repos") : undefined;
  return Object.entries(repos).map(([repo, raw]) =>
    normalizeRepo(
      `repos.${repo}`,
      repo,
      raw,
      orderedRepos instanceof Map ? orderedRepos.get(repo) : undefined,
    ),
  );
}

async function syncMirror(
  repo: string,
  ttlMs: number,
  context: SyncContext,
): Promise<MirrorSyncResult> {
  const { mirrorRoot: root, forcePull, repoUrl, runGit: run } = context;
  const mirrorDir = join(root, ...repo.split("/"));
  await mkdir(dirname(mirrorDir), { recursive: true });

  if (!existsSync(mirrorDir)) {
    const url = repoUrl(repo);
    const result = await run(["clone", "--depth", "1", "--quiet", url, mirrorDir]);
    if (!result.ok) throw new Error(`git clone failed for ${url}: ${singleLine(result.stderr)}`);
    await markPullAt(mirrorDir);
    return { mirrorDir, changed: true };
  }

  const lastPullAt = await readLastPullAt(mirrorDir);
  if (!isPullDue(lastPullAt, Date.now(), ttlMs, forcePull)) return { mirrorDir, changed: false };

  const before = await readRevision(repo, mirrorDir, context);
  const result = await run(["-C", mirrorDir, "pull", "--ff-only", "--quiet"]);
  if (!result.ok) {
    await assertMirrorAccessible(mirrorDir);
    console.error(`warning: git pull failed for ${repo}: ${singleLine(result.stderr)}`);
    return { mirrorDir, changed: false };
  }
  const after = await readRevision(repo, mirrorDir, context);
  await markPullAt(mirrorDir);
  return { mirrorDir, changed: before !== after };
}

// Throws when the mirror directory vanished, so a missing mirror becomes a
// hard failure instead of a pull warning.
async function assertMirrorAccessible(mirrorDir: string): Promise<void> {
  await readdir(mirrorDir);
}

function isPullDue(
  lastPullAt: number | undefined,
  nowMs: number,
  ttlMs: number,
  forcePull = false,
): boolean {
  if (forcePull) return true;
  if (lastPullAt === undefined) return true;
  return nowMs - lastPullAt >= ttlMs;
}

async function resolveEntryPath(mirrorDir: string, path: string): Promise<string> {
  const matches = [...new Bun.Glob(path).scanSync({ cwd: mirrorDir, onlyFiles: false })].map(
    (relativePath) => join(mirrorDir, relativePath),
  );
  if (matches.length === 0) throw new Error(`entry path matched nothing: ${path}`);
  if (matches.length > 1) throw new Error(`entry path matched multiple entries: ${path}`);
  return matches[0]!;
}

export async function copyTree(
  sourceDir: string,
  targetDir: string,
  shouldCopy: (entry: Dirent, targetPath: string) => boolean,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await runWithConcurrency(
    await readdir(sourceDir, { withFileTypes: true }),
    fileOperationConcurrency,
    async (entry) => {
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (!shouldCopy(entry, targetPath)) return;
      if (entry.isDirectory()) await copyTree(sourcePath, targetPath, shouldCopy);
      else await copyFile(sourcePath, targetPath);
    },
  );
}

// Skill trees skip VCS metadata and never overwrite files already present in
// the destination.
function shouldCopySkillEntry(entry: Dirent, targetPath: string): boolean {
  return entry.name !== ".git" && (entry.isDirectory() || !existsSync(targetPath));
}

async function readLastPullAt(mirrorDir: string): Promise<number | undefined> {
  const pullTimePath = join(mirrorDir, ".git", pullTimeFileName);
  if (!existsSync(pullTimePath)) return undefined;
  const raw = await readFile(pullTimePath, "utf-8").catch(() => undefined);
  const pullAt = Number(raw?.trim());
  return Number.isFinite(pullAt) ? pullAt : undefined;
}

async function markPullAt(mirrorDir: string): Promise<void> {
  const gitDir = join(mirrorDir, ".git");
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, pullTimeFileName), `${Date.now()}\n`);
}

// ------------------------------------------------------------- entry copying

export async function copyRepoEntries(
  mirrorDir: string,
  destinationDir: string,
  entries: string[],
  edits: TextEdit[],
  markdownEdits: MarkdownEdit[],
  exclude: string[],
): Promise<void> {
  const excludedPatterns = exclude.map((pattern) => new Bun.Glob(pattern));
  const resolvedEdits = edits.map((edit, index) => ({
    ...edit,
    filePath: resolveEditFile(mirrorDir, edit.path),
    index,
  }));
  const resolvedMarkdownEdits = await Promise.all(
    markdownEdits.map(async (edit, index) => ({
      ...edit,
      filePath: await resolveMarkdownFile(mirrorDir, edit),
      index,
    })),
  );
  const appliedEditIndexes = new Set<number>();
  const appliedMarkdownIndexes = new Set<number>();

  for (const entry of entries) {
    const entryPath = await resolveEntryPath(mirrorDir, entry);
    const repoPath = relative(mirrorDir, entryPath).split(sep).join("/");
    const entryExcluded = isExcludedPath(repoPath, excludedPatterns);
    // A file entry lands under the destination as-is and is never an edit
    // target.
    if (statSync(entryPath).isFile()) {
      if (entryExcluded) continue;
      await mkdir(destinationDir, { recursive: true });
      await copyFile(entryPath, join(destinationDir, basename(entryPath)));
      continue;
    }
    const skillDir = entryPath;
    const targetDir = join(destinationDir, basename(skillDir));
    function shouldCopyEntry(entry: Dirent, targetPath: string): boolean {
      const sourcePath = join(repoPath, relative(targetDir, targetPath)).split(sep).join("/");
      return (
        shouldCopySkillEntry(entry, targetPath) && !isExcludedPath(sourcePath, excludedPatterns)
      );
    }
    const entryEdits = resolvedEdits.filter(({ filePath }) => isPathInside(skillDir, filePath));
    const entryMarkdownEdits = resolvedMarkdownEdits.filter(({ filePath }) =>
      isMarkdownPathInside(skillDir, filePath),
    );
    if (entryEdits.length === 0 && entryMarkdownEdits.length === 0) {
      if (!entryExcluded) await copyTree(skillDir, targetDir, shouldCopyEntry);
      continue;
    }

    // mkdtemp does not create parent directories, and a nested destination
    // (e.g. out/nested) may not have them yet when no earlier entry ran mkdir.
    const stagingParent = dirname(destinationDir);
    await mkdir(stagingParent, { recursive: true });
    const stagingDir = await mkdtemp(join(stagingParent, "external-edit-"));
    try {
      await copyTree(skillDir, stagingDir, () => true);
      for (const edit of entryEdits) {
        try {
          await appendEditedFile(join(stagingDir, relative(skillDir, edit.filePath)), edit.text);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`edit failed for ${edit.path}: ${singleLine(message)}`);
        }
        appliedEditIndexes.add(edit.index);
      }
      for (const edit of entryMarkdownEdits) {
        const filePath = join(stagingDir, relative(skillDir, edit.filePath));
        try {
          const source = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
          await writeFile(filePath, editMarkdown(source, edit));
        } catch (error) {
          throw new Error(
            `${edit.label}: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error,
            },
          );
        }
        appliedMarkdownIndexes.add(edit.index);
      }
      if (!entryExcluded) await copyTree(stagingDir, targetDir, shouldCopyEntry);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  for (const edit of resolvedEdits) {
    if (!appliedEditIndexes.has(edit.index)) {
      throw new Error(`edit path is not included in entries: ${edit.path}`);
    }
  }
  for (const edit of resolvedMarkdownEdits) {
    if (!appliedMarkdownIndexes.has(edit.index)) {
      throw new Error(`${edit.label}: edit_markdown path is not included in folder entries`);
    }
  }
}

function isExcludedPath(path: string, patterns: Bun.Glob[]): boolean {
  const segments = path.split("/");
  return segments.some((_, index) => {
    const prefix = segments.slice(0, index + 1).join("/");
    return patterns.some((pattern) => pattern.match(prefix));
  });
}

async function resolveMarkdownFile(mirrorDir: string, edit: MarkdownEdit): Promise<string> {
  try {
    const path = edit.path;
    const filePath = resolve(mirrorDir, path);
    if (
      !path ||
      isAbsolute(path) ||
      win32.isAbsolute(path) ||
      /[*?[\]{}\0]/.test(path) ||
      /[\\/]$/.test(path) ||
      !isMarkdownPathInside(mirrorDir, filePath)
    ) {
      throw new Error("path must be a relative non-glob file inside the repository");
    }
    const root = await realpath(mirrorDir);
    const parent = await realpath(dirname(filePath));
    if (
      (parent !== root && !isMarkdownPathInside(root, parent)) ||
      !statSync(parent).isDirectory()
    ) {
      throw new Error("parent directory must exist inside the repository");
    }
    const stat = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat && !stat.isFile()) throw new Error("path must be a regular file");
    return filePath;
  } catch (error) {
    throw new Error(`${edit.label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function isMarkdownPathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function resolveEditFile(mirrorDir: string, path: string): string {
  const filePath = join(mirrorDir, path);
  const parentDir = dirname(filePath);
  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
    throw new Error(`edit path matched nothing: ${path}`);
  }
  return filePath;
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const childPath = relative(parentDir, candidatePath);
  return childPath !== "" && !childPath.startsWith("..") && !isAbsolute(childPath);
}

async function appendEditedFile(filePath: string, text: string): Promise<void> {
  const current = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, current + separator + text);
}

async function runAfterCommands(
  repo: string,
  mirrorDir: string,
  commands: string[][],
  context: SyncContext,
): Promise<void> {
  const clean = await context.runGit(["-C", mirrorDir, "clean", "-fdX"]);
  if (!clean.ok) {
    throw new Error(`git clean failed for ${repo}: ${singleLine(clean.stderr)}`);
  }
  for (const command of commands) {
    const result = await context.runCommand(command, mirrorDir);
    if (!result.ok) {
      throw new Error(`run_after failed for ${repo}: ${singleLine(result.stderr)}`);
    }
  }
}

async function readRevision(
  repo: string,
  mirrorDir: string,
  context: SyncContext,
): Promise<string> {
  const result = await context.runGit(["-C", mirrorDir, "rev-parse", "HEAD"]);
  if (!result.ok) {
    throw new Error(`git revision lookup failed for ${repo}: ${singleLine(result.stderr)}`);
  }
  return result.stdout.trim();
}

// ------------------------------------------------------------- config format

function normalizeRepo(prefix: string, repo: string, raw: unknown, ordered: unknown): ExternalRepo {
  if (!isPlainObject(raw)) throw new Error(`${prefix} must be a mapping`);
  if (
    typeof raw.destination !== "string" ||
    raw.destination === "" ||
    raw.destination.startsWith("/")
  )
    throw new Error(`${prefix}.destination must be a relative dist path`);
  if (
    typeof raw.ttlHours !== "undefined" &&
    (typeof raw.ttlHours !== "number" || !Number.isFinite(raw.ttlHours) || raw.ttlHours <= 0)
  )
    throw new Error(`${prefix}.ttlHours must be a positive number`);
  const sectionOrder = new Map<string, string[]>();
  const orderedEdits: unknown = ordered instanceof Map ? ordered.get("edit_markdown") : undefined;
  if (orderedEdits instanceof Map) {
    for (const [path, fields] of orderedEdits) {
      const sections: unknown = fields instanceof Map ? fields.get("sections") : undefined;
      if (sections instanceof Map) sectionOrder.set(String(path), [...sections.keys()].map(String));
    }
  }
  return {
    repo,
    destination: raw.destination,
    entries: normalizePathEntries(`${prefix}.entries`, raw.entries),
    exclude: normalizePathEntries(
      `${prefix}.exclude`,
      raw.exclude === undefined ? [] : raw.exclude,
    ),
    ttlMs: (typeof raw.ttlHours === "number" ? raw.ttlHours : defaultTtlHours) * 60 * 60 * 1000,
    runAfter: normalizeCommands(`${prefix}.run_after`, raw.run_after ?? []),
    edits: normalizeEdits(`${prefix}.edit`, raw.edit === undefined ? {} : raw.edit),
    markdownEdits: normalizeMarkdownEdits(
      `${prefix}.edit_markdown`,
      raw.edit_markdown === undefined ? {} : raw.edit_markdown,
      sectionOrder,
    ),
  };
}

function normalizePathEntries(prefix: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error(`${prefix} must be an array`);
  return raw.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${prefix}[${index}] must be a path string`);
    return entry;
  });
}

function normalizeCommands(prefix: string, raw: unknown): string[][] {
  if (!Array.isArray(raw)) throw new Error(`${prefix} must be an array`);
  return raw.map((command, index) => {
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((argument) => typeof argument !== "string")
    ) {
      throw new Error(`${prefix}[${index}] must be a non-empty string array`);
    }
    return command;
  });
}

function normalizeEdits(prefix: string, raw: unknown): TextEdit[] {
  if (!isPlainObject(raw)) throw new Error(`${prefix} must be a mapping`);
  return Object.entries(raw).map(([key, text]) => {
    const match = /^(.*)\.\$append$/.exec(key);
    if (!match || typeof text !== "string") {
      throw new Error(`${prefix}[${key}] must be a .$append text edit`);
    }
    return { path: match[1]!, text };
  });
}

// ------------------------------------------------------------ child process

function singleLine(message: string): string {
  return message.replace(/\r?\n/g, "\\n").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
