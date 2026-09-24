// External fetch stage of the build (spec: dotfiles-manager.spec.md
// §build: external fetch): syncs GitHub repository mirrors under
// ~/mirrors/github.com and materializes their entries into dist. Moved from
// the retired skills.exact hook; the externalSkills config format is kept.

// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { existsSync, statSync } from "node:fs";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { homedir } from "node:os";
// @ts-ignore Bun provides Node built-ins at runtime; this repo has no Node type package.
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import yaml from "yaml";

declare const Bun: {
  spawn(
    args: string[],
    options: { cwd?: string; stdout: "pipe"; stderr: "pipe" },
  ): { exited: Promise<number>; stdout: unknown; stderr: unknown };
  Glob: {
    new (pattern: string): {
      scanSync(options: { cwd: string; onlyFiles: boolean }): Iterable<string>;
    };
  };
};
declare const process: { env: Record<string, string | undefined> };
declare const console: { error(...data: unknown[]): void };
declare const Response: { new (body: unknown): { text(): Promise<string> } };

export type ProcessResult = { ok: boolean; stdout: string; stderr: string };
export type TextEdit = { path: string; text: string };
export type ExternalRepo = {
  repo: string;
  destination: string;
  entries: string[];
  ttlMs: number;
  runAfter: string[][];
  edits: TextEdit[];
};
export type ExternalConfig = { repos: ExternalRepo[] };
export type SyncContext = {
  mirrorRoot: string;
  forcePull: boolean;
  repoUrl: (repo: string) => string;
  runGit: (args: string[]) => Promise<ProcessResult>;
  runCommand: (args: string[], cwd: string) => Promise<ProcessResult>;
};

type MirrorSyncResult = { mirrorDir: string; changed: boolean };

export const defaultTtlHours = 6;
const pullTimeFileName = "pre-chezmoi-pull-time";
const defaultMirrorRoot = join(homedir(), "mirrors", "github.com");

export function defaultContext(): SyncContext {
  return {
    mirrorRoot: defaultMirrorRoot,
    forcePull: process.env.BUILD_FORCE_PULL === "1",
    repoUrl: (repo) => `https://github.com/${repo}.git`,
    runGit: (args) => runProcess(["git", ...args]),
    runCommand: (args, cwd) => runProcess(args, cwd),
  };
}

// ---------------------------------------------------------------- public API

export async function fetchExternals(
  configPath: string,
  distDir: string,
  context: SyncContext = defaultContext(),
): Promise<void> {
  const config = await loadExternalConfig(configPath);
  await Promise.all(
    config.repos.map(async (repo) => {
      const sync = await syncMirror(repo.repo, repo.ttlMs, context);
      if (sync.changed && repo.runAfter.length > 0)
        await runAfterCommands(repo.repo, sync.mirrorDir, repo.runAfter, context);
      await copyRepoEntries(
        sync.mirrorDir,
        join(distDir, repo.destination),
        repo.entries,
        repo.edits,
      );
    }),
  );
}

export async function loadExternalConfig(configPath: string): Promise<ExternalConfig> {
  const doc: unknown = yaml.parse(await readFile(configPath, "utf-8"));
  const externalSkills = (doc as { externalSkills?: unknown })?.externalSkills;
  if (!isPlainObject(externalSkills))
    throw new Error(`.build-external.yaml must have an externalSkills mapping: ${configPath}`);
  const repos = Object.entries(externalSkills).map(([repo, raw]) =>
    normalizeRepo(`externalSkills.${repo}`, repo, raw),
  );
  return { repos };
}

export async function syncMirror(
  repo: string,
  ttlMs: number,
  context: SyncContext = defaultContext(),
): Promise<MirrorSyncResult> {
  const { mirrorRoot: root, forcePull, repoUrl, runGit: run } = context;
  const mirrorDir = join(root, ...repo.split("/"));
  await mkdir(dirname(mirrorDir), { recursive: true });

  if (!existsSync(mirrorDir)) {
    const url = repoUrl(repo);
    const result = await run(["clone", "--depth", "1", "--quiet", url, mirrorDir]);
    if (!result.ok)
      throw new Error(`git clone failed for ${url}: ${singleLine(result.stderr)}`);
    await markPullAt(mirrorDir);
    return { mirrorDir, changed: true };
  }

  const lastPullAt = await readLastPullAt(mirrorDir);
  if (!isPullDue(lastPullAt, Date.now(), ttlMs, forcePull))
    return { mirrorDir, changed: false };

  const before = await readRevision(repo, mirrorDir, context);
  const result = await run(["-C", mirrorDir, "pull", "--ff-only", "--quiet"]);
  if (!result.ok) {
    console.error(`warning: git pull failed for ${repo}: ${singleLine(result.stderr)}`);
    return { mirrorDir, changed: false };
  }
  const after = await readRevision(repo, mirrorDir, context);
  await markPullAt(mirrorDir);
  return { mirrorDir, changed: before !== after };
}

export function isPullDue(
  lastPullAt: number | undefined,
  nowMs: number,
  ttlMs: number,
  forcePull = false,
): boolean {
  if (forcePull) return true;
  if (lastPullAt === undefined) return true;
  return nowMs - lastPullAt >= ttlMs;
}

export async function resolveSkillDir(
  mirrorDir: string,
  path: string,
): Promise<string> {
  const matches = [
    ...new Bun.Glob(path).scanSync({ cwd: mirrorDir, onlyFiles: false }),
  ]
    .map((relativePath) => join(mirrorDir, relativePath))
    .filter((absolute) => statSync(absolute).isDirectory());
  if (matches.length === 0)
    throw new Error(`skill path matched nothing: ${path}`);
  if (matches.length > 1)
    throw new Error(`skill path matched multiple directories: ${path}`);
  return matches[0]!;
}

export async function copySkillTree(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) await copySkillTree(sourcePath, targetPath);
    else if (!existsSync(targetPath)) await copyFile(sourcePath, targetPath);
  }
}

export async function readLastPullAt(
  mirrorDir: string,
): Promise<number | undefined> {
  const pullTimePath = join(mirrorDir, ".git", pullTimeFileName);
  if (!existsSync(pullTimePath)) return undefined;
  const raw = await readFile(pullTimePath, "utf-8").catch(() => undefined);
  const pullAt = Number(raw?.trim());
  return Number.isFinite(pullAt) ? pullAt : undefined;
}

export async function markPullAt(mirrorDir: string): Promise<void> {
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
): Promise<void> {
  const resolvedEdits = edits.map((edit, index) => ({
    ...edit,
    filePath: resolveEditFile(mirrorDir, edit.path),
    index,
  }));
  const appliedEditIndexes = new Set<number>();

  for (const entry of entries) {
    const skillDir = await resolveSkillDir(mirrorDir, entry);
    const entryEdits = resolvedEdits.filter(({ filePath }) =>
      isPathInside(skillDir, filePath),
    );
    if (entryEdits.length === 0) {
      await copySkillTree(skillDir, join(destinationDir, basename(skillDir)));
      continue;
    }

    const stagingDir = await mkdtemp(join(dirname(destinationDir), "external-edit-"));
    try {
      await copyRawTree(skillDir, stagingDir);
      for (const edit of entryEdits) {
        try {
          await appendEditedFile(
            join(stagingDir, relative(skillDir, edit.filePath)),
            edit.text,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`edit failed for ${edit.path}: ${singleLine(message)}`);
        }
        appliedEditIndexes.add(edit.index);
      }
      await copySkillTree(stagingDir, join(destinationDir, basename(skillDir)));
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  for (const edit of resolvedEdits) {
    if (!appliedEditIndexes.has(edit.index)) {
      throw new Error(`edit path is not included in entries: ${edit.path}`);
    }
  }
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

async function copyRawTree(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) await copyRawTree(sourcePath, targetPath);
    else await copyFile(sourcePath, targetPath);
  }
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
    throw new Error(
      `git revision lookup failed for ${repo}: ${singleLine(result.stderr)}`,
    );
  }
  return result.stdout.trim();
}

// ------------------------------------------------------------- config format

function normalizeRepo(prefix: string, repo: string, raw: unknown): ExternalRepo {
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
  return {
    repo,
    destination: raw.destination,
    entries: normalizePathEntries(`${prefix}.entries`, raw.entries),
    ttlMs:
      (typeof raw.ttlHours === "number" ? raw.ttlHours : defaultTtlHours) * 60 * 60 * 1000,
    runAfter: normalizeCommands(`${prefix}.run_after`, raw.run_after ?? []),
    edits: normalizeEdits(`${prefix}.edit`, raw.edit === undefined ? {} : raw.edit),
  };
}

function normalizePathEntries(prefix: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error(`${prefix} must be an array`);
  return raw.map((entry, index) => {
    if (typeof entry !== "string")
      throw new Error(`${prefix}[${index}] must be a path string`);
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

// ------------------------------------------------------------- child process

async function runProcess(args: string[], cwd?: string): Promise<ProcessResult> {
  const proc = Bun.spawn(args, {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const ok = (await proc.exited) === 0;
  return { ok, stdout: stdout.trim(), stderr: stderr.trim() };
}

function singleLine(message: string): string {
  return message.replace(/\r?\n/g, "\\n").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
