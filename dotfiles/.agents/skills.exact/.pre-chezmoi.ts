// Local pre-chezmoi hook for dotfiles/.agents/skills.exact (spec §2).
// Syncs external skills from Git mirrors into the matching dist folder. A
// repository may run argv commands after a Git update to materialize generated
// skill sources before copying them.
import { existsSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { applyYamlPatch } from "../../../pre-chezmoi.ts";
import yaml from "yaml";

export type ProcessResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};
export type SkillEdit = {
  path: string;
  text: string;
};
export type SkillRepo = {
  repo: string;
  entries: string[];
  runAfter: string[][];
  edits: SkillEdit[];
};
export type SkillConfig = {
  repos: SkillRepo[];
  localSkills: string[];
};

const machineLayerFileName = ".pre-chezmoi.skills.machine.yaml";
const localSkillsDirName = "local";

// main/syncMirror reach through these process runners. Tests inject fakes;
// production takes the defaults.
export type SyncContext = {
  mirrorRoot: string;
  ttlMs: number;
  forcePull: boolean;
  runGit: (args: string[]) => Promise<ProcessResult>;
  runCommand: (args: string[], cwd: string) => Promise<ProcessResult>;
};

type MirrorSyncResult = {
  mirrorDir: string;
  changed: boolean;
};

const hookRelativePath = "dotfiles/.agents/skills.exact/.pre-chezmoi.ts";
const mirrorRoot = join(homedir(), "mirrors", "github.com");
const pullTtlMs = 6 * 60 * 60 * 1000;
const pullTimeFileName = "pre-chezmoi-pull-time";

// Read at call time so tests can flip PRE_CHEZMOI_FORCE_PULL.
export function defaultContext(): SyncContext {
  return {
    mirrorRoot,
    ttlMs: pullTtlMs,
    forcePull: process.env.PRE_CHEZMOI_FORCE_PULL === "1",
    runGit,
    runCommand,
  };
}

// Prefixes chezmoi parses as source-state attributes (scripts, removals, ...).
// Synced skill assets must land verbatim, so names using them are wrapped in
// literal_, which stops chezmoi's attribute parsing.
const chezmoiAttributePrefix =
  /^(after|before|create|dot|empty|encrypted|exact|executable|external|literal|modify|once|onchange|private|readonly|remove|run|symlink)_/;

export async function loadSkillConfig(
  configPath: string,
): Promise<SkillConfig> {
  const doc: unknown = yaml.parse(await readFile(configPath, "utf-8"));
  const externalSkills = (doc as { externalSkills?: unknown })?.externalSkills;
  if (!isPlainObject(externalSkills)) {
    throw new Error(
      `.pre-chezmoi.skills.yaml must have an externalSkills mapping: ${configPath}`,
    );
  }

  const machineLayerPath = join(dirname(configPath), machineLayerFileName);
  const merged = existsSync(machineLayerPath)
    ? (applyYamlPatch(
        { externalSkills },
        await readFile(machineLayerPath, "utf-8"),
      ) as {
        externalSkills?: unknown;
        localSkills?: unknown;
      })
    : { externalSkills };
  if (!isPlainObject(merged.externalSkills)) {
    throw new Error(
      `${machineLayerFileName} must keep an externalSkills mapping: ${machineLayerPath}`,
    );
  }

  const repos = Object.entries(merged.externalSkills).map(([repo, rawConfig]) =>
    normalizeRepo(`externalSkills.${repo}`, repo, rawConfig),
  );
  const localSkills = normalizePathEntries(
    "localSkills",
    merged.localSkills ?? [],
  );
  return { repos, localSkills };
}

export async function resolveSkillDir(
  mirrorDir: string,
  path: string,
): Promise<string> {
  const matches = [
    ...new Bun.Glob(path).scanSync({ cwd: mirrorDir, onlyFiles: false }),
  ]
    .map((relative) => join(mirrorDir, relative))
    .filter((absolute) => statSync(absolute).isDirectory());
  if (matches.length === 0)
    throw new Error(`skill path matched nothing: ${path}`);
  if (matches.length > 1)
    throw new Error(`skill path matched multiple directories: ${path}`);
  return matches[0];
}

export async function copySkillTree(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;

    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, safeName(entry.name));
    if (entry.isDirectory()) await copySkillTree(sourcePath, targetPath);
    else if (!existsSync(targetPath)) await copyFile(sourcePath, targetPath);
  }
}

function safeName(name: string): string {
  return chezmoiAttributePrefix.test(name) ? `literal_${name}` : name;
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

export async function main(
  options: { configPath?: string; cwd?: string; context?: SyncContext } = {},
): Promise<void> {
  try {
    const configPath =
      options.configPath ?? join(import.meta.dir, ".pre-chezmoi.skills.yaml");
    const cwd = options.cwd ?? process.cwd();
    const context = options.context ?? defaultContext();
    const config = await loadSkillConfig(configPath);

    // Local skills run first: the existing-file rule then lets a local file
    // keep its content when a synced skill ships the same relative file.
    for (const path of config.localSkills) {
      await copyEntry(dirname(configPath), cwd, path);
    }

    await Promise.all(
      config.repos.map(async ({ repo, entries, runAfter, edits }) => {
        const sync = await syncMirror(repo, context);
        if (sync.changed && runAfter.length > 0) {
          await runAfterCommands(repo, sync.mirrorDir, runAfter, context);
        }
        await copyRepoEntries(sync.mirrorDir, cwd, entries, edits);
      }),
    );

    // local/ only holds localSkills sources; keep it out of dist after use.
    await rm(join(cwd, localSkillsDirName), { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${hookRelativePath}: ${singleLine(message)}`);
    process.exitCode = 1;
  }
}

async function copyEntry(
  baseDir: string,
  cwd: string,
  path: string,
): Promise<void> {
  const skillDir = await resolveSkillDir(baseDir, path);
  await copySkillTree(skillDir, join(cwd, basename(skillDir)));
}

type ResolvedEdit = SkillEdit & { filePath: string; index: number };

async function copyRepoEntries(
  baseDir: string,
  cwd: string,
  entries: string[],
  edits: SkillEdit[],
): Promise<void> {
  const resolvedEdits = edits.map((edit, index) => ({
    ...edit,
    filePath: resolveEditFile(baseDir, edit.path),
    index,
  }));
  const appliedEditIndexes = new Set<number>();

  for (const entry of entries) {
    const skillDir = await resolveSkillDir(baseDir, entry);
    const entryEdits = resolvedEdits.filter(({ filePath }) =>
      isPathInside(skillDir, filePath),
    );
    if (entryEdits.length === 0) {
      await copySkillTree(skillDir, join(cwd, basename(skillDir)));
      continue;
    }

    const stagingDir = await mkdtemp(join(tmpdir(), "pre-chezmoi-edit-"));
    try {
      await copyRawTree(skillDir, stagingDir);
      for (const edit of entryEdits) {
        try {
          await appendEditedFile(
            join(stagingDir, relative(skillDir, edit.filePath)),
            edit.text,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `edit failed for ${edit.path}: ${singleLine(message)}`,
          );
        }
        appliedEditIndexes.add(edit.index);
      }
      await copySkillTree(stagingDir, join(cwd, basename(skillDir)));
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

function resolveEditFile(baseDir: string, path: string): string {
  const filePath = join(baseDir, path);
  const parentDir = dirname(filePath);
  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
    throw new Error(`edit path matched nothing: ${path}`);
  }
  return filePath;
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const childPath = relative(parentDir, candidatePath);
  return (
    childPath !== "" && !childPath.startsWith("..") && !isAbsolute(childPath)
  );
}

async function copyRawTree(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
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
    throw new Error(
      `git clean failed for ${repo}: ${singleLine(clean.stderr)}`,
    );
  }

  for (const command of commands) {
    const result = await context.runCommand(command, mirrorDir);
    if (!result.ok) {
      throw new Error(
        `run_after failed for ${repo}: ${singleLine(result.stderr)}`,
      );
    }
  }
}

export async function syncMirror(
  repo: string,
  context: SyncContext = defaultContext(),
): Promise<MirrorSyncResult> {
  const { mirrorRoot: root, ttlMs, forcePull, runGit: run } = context;
  const mirrorDir = join(root, ...repo.split("/"));
  await mkdir(dirname(mirrorDir), { recursive: true });

  if (!existsSync(mirrorDir)) {
    const url = `https://github.com/${repo}.git`;
    const result = await run([
      "clone",
      "--depth",
      "1",
      "--quiet",
      url,
      mirrorDir,
    ]);
    if (!result.ok)
      throw new Error(
        `git clone failed for ${url}: ${singleLine(result.stderr)}`,
      );
    await markPullAt(mirrorDir);
    return { mirrorDir, changed: true };
  }

  const lastPullAt = await readLastPullAt(mirrorDir);
  if (!isPullDue(lastPullAt, Date.now(), ttlMs, forcePull))
    return { mirrorDir, changed: false };

  const before = await readRevision(repo, mirrorDir, context);
  const result = await run(["-C", mirrorDir, "pull", "--ff-only", "--quiet"]);
  if (!result.ok) {
    console.error(
      `warning: git pull failed for ${repo}: ${singleLine(result.stderr)}`,
    );
    return { mirrorDir, changed: false };
  }
  const after = await readRevision(repo, mirrorDir, context);
  await markPullAt(mirrorDir);
  return { mirrorDir, changed: before !== after };
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

async function runGit(args: string[]): Promise<ProcessResult> {
  return runProcess(["git", ...args]);
}

async function runCommand(args: string[], cwd: string): Promise<ProcessResult> {
  return runProcess(args, cwd);
}

async function runProcess(
  args: string[],
  cwd?: string,
): Promise<ProcessResult> {
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

function normalizeRepo(prefix: string, repo: string, raw: unknown): SkillRepo {
  if (!isPlainObject(raw)) throw new Error(`${prefix} must be a mapping`);
  return {
    repo,
    entries: normalizePathEntries(`${prefix}.entries`, raw.entries),
    runAfter: normalizeCommands(`${prefix}.run_after`, raw.run_after ?? []),
    edits: normalizeEdits(
      `${prefix}.edit`,
      raw.edit === undefined ? {} : raw.edit,
    ),
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

function normalizeEdits(prefix: string, raw: unknown): SkillEdit[] {
  if (!isPlainObject(raw)) throw new Error(`${prefix} must be a mapping`);
  return Object.entries(raw).map(([key, text]) => {
    const match = /^(.*)\.\$append$/.exec(key);
    if (!match || typeof text !== "string") {
      throw new Error(`${prefix}[${key}] must be a .$append text edit`);
    }
    return { path: match[1], text };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  await main();
}
