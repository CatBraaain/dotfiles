// Local pre-chezmoi hook for dotfiles/.agents/skills.exact (spec §2).
// Syncs external skills from ~/mirrors/github.com/<owner>/<repo> into the
// matching dist folder. Source .pre-chezmoi.skills.yaml defines what to sync;
// .pre-chezmoi.skills.machine.yaml is the machine-specific layer (spec §2.1)
// that patches the shared config and declares localSkills; files that already
// exist here (local overrides, e.g. a custom SKILL.md) always win.
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applyYamlPatch } from "../../../pre-chezmoi.ts";
import yaml from "yaml";

export type SkillEntry = { path: string; appendSkillMd?: string };
export type SkillRepo = { repo: string; entries: SkillEntry[] };
export type SkillConfig = { repos: SkillRepo[]; localSkills: SkillEntry[] };

const machineLayerFileName = ".pre-chezmoi.skills.machine.yaml";
const localSkillsDirName = "local";

// Externals syncMirror/main reach through (mirror location, git runner, pull
// policy). Tests inject fakes; production takes the defaults.
export type SyncContext = {
  mirrorRoot: string;
  ttlMs: number;
  forcePull: boolean;
  runGit: (args: string[]) => Promise<{ ok: boolean; stderr: string }>;
};

const hookRelativePath = "dotfiles/.agents/skills.exact/.pre-chezmoi.ts";
const mirrorRoot = join(homedir(), "mirrors", "github.com");
// Skip mirror pulls whose recorded pull time is younger than this.
const pullTtlMs = 6 * 60 * 60 * 1000;
const pullTimeFileName = "pre-chezmoi-pull-time";

// Read at call time so tests can flip PRE_CHEZMOI_FORCE_PULL.
export function defaultContext(): SyncContext {
  return {
    mirrorRoot,
    ttlMs: pullTtlMs,
    forcePull: process.env.PRE_CHEZMOI_FORCE_PULL === "1",
    runGit,
  };
}

// Prefixes chezmoi parses as source-state attributes (scripts, removals, ...).
// Synced skill assets must land verbatim, so names using them are wrapped in
// literal_, which stops chezmoi's attribute parsing.
const chezmoiAttributePrefix =
  /^(after|before|create|dot|empty|encrypted|exact|executable|external|literal|modify|once|onchange|private|readonly|remove|run|symlink)_/;

export async function loadSkillConfig(configPath: string): Promise<SkillConfig> {
  const doc: unknown = yaml.parse(await readFile(configPath, "utf-8"));
  const externalSkills = (doc as { externalSkills?: unknown })?.externalSkills;
  if (!isPlainObject(externalSkills)) {
    throw new Error(`.pre-chezmoi.skills.yaml must have an externalSkills mapping: ${configPath}`);
  }

  // Machine-specific layer: patch the shared config (§9) and read localSkills.
  const machineLayerPath = join(dirname(configPath), machineLayerFileName);
  const merged = existsSync(machineLayerPath)
    ? (applyYamlPatch({ externalSkills }, await readFile(machineLayerPath, "utf-8")) as {
        externalSkills?: unknown;
        localSkills?: unknown;
      })
    : { externalSkills };
  if (!isPlainObject(merged.externalSkills)) {
    throw new Error(
      `${machineLayerFileName} must keep an externalSkills mapping: ${machineLayerPath}`,
    );
  }

  const repos = Object.entries(merged.externalSkills).map(([repo, rawEntries]) => ({
    repo,
    entries: normalizeEntries(`externalSkills.${repo}`, rawEntries),
  }));
  const localSkills = normalizeEntries("localSkills", merged.localSkills ?? []);
  return { repos, localSkills };
}

export async function resolveSkillDir(mirrorDir: string, path: string): Promise<string> {
  const matches = [...new Bun.Glob(path).scanSync({ cwd: mirrorDir, onlyFiles: false })]
    .map((relative) => join(mirrorDir, relative))
    .filter((absolute) => statSync(absolute).isDirectory());
  if (matches.length === 0) throw new Error(`skill path matched nothing: ${path}`);
  if (matches.length > 1)
    throw new Error(`skill path matched multiple directories: ${path}`);
  return matches[0];
}

export async function copySkillTree(sourceDir: string, targetDir: string): Promise<void> {
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

export async function appendSkillMd(skillDir: string, text: string): Promise<void> {
  const skillMdPath = join(skillDir, "SKILL.md");
  const current = existsSync(skillMdPath) ? await readFile(skillMdPath, "utf-8") : "";
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeFile(skillMdPath, current + separator + text);
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

export async function readLastPullAt(mirrorDir: string): Promise<number | undefined> {
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
    const configPath = options.configPath ?? join(import.meta.dir, ".pre-chezmoi.skills.yaml");
    const cwd = options.cwd ?? process.cwd();
    const context = options.context ?? defaultContext();
    const config = await loadSkillConfig(configPath);
    // Local skills run first: the existing-file rule then lets a local file
    // keep its content when a synced skill ships the same relative file.
    for (const entry of config.localSkills) {
      await copyEntry(dirname(configPath), cwd, entry);
    }
    await Promise.all(
      config.repos.map(async ({ repo, entries }) => {
        const mirrorDir = await syncMirror(repo, context);
        for (const entry of entries) await copyEntry(mirrorDir, cwd, entry);
      }),
    );
    // local/ only holds localSkills sources; keep it out of dist after use.
    await rm(join(cwd, localSkillsDirName), { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${hookRelativePath}: ${message}`);
    process.exitCode = 1;
  }
}

async function copyEntry(baseDir: string, cwd: string, entry: SkillEntry): Promise<void> {
  const skillDir = await resolveSkillDir(baseDir, entry.path);
  const targetDir = join(cwd, basename(entry.path));
  await copySkillTree(skillDir, targetDir);
  if (entry.appendSkillMd !== undefined) await appendSkillMd(targetDir, entry.appendSkillMd);
}

export async function syncMirror(
  repo: string,
  context: SyncContext = defaultContext(),
): Promise<string> {
  const { mirrorRoot: root, ttlMs, forcePull, runGit: run } = context;
  const mirrorDir = join(root, ...repo.split("/"));
  if (!existsSync(mirrorDir)) {
    const url = `https://github.com/${repo}.git`;
    const result = await run(["clone", "--depth", "1", "--quiet", url, mirrorDir]);
    if (!result.ok) throw new Error(`git clone failed for ${url}: ${result.stderr}`);
    await markPullAt(mirrorDir);
    return mirrorDir;
  }

  const lastPullAt = await readLastPullAt(mirrorDir);
  if (!isPullDue(lastPullAt, Date.now(), ttlMs, forcePull)) return mirrorDir;

  const result = await run(["-C", mirrorDir, "pull", "--ff-only", "--quiet"]);
  if (!result.ok) {
    console.error(`warning: git pull failed for ${repo}: ${result.stderr}`);
    return mirrorDir;
  }
  await markPullAt(mirrorDir);
  return mirrorDir;
}

async function runGit(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const ok = (await proc.exited) === 0;
  return { ok, stderr: stderr.trim() };
}

function normalizeEntries(prefix: string, rawEntries: unknown): SkillEntry[] {
  if (!Array.isArray(rawEntries)) {
    throw new Error(`${prefix} must be an array`);
  }
  return rawEntries.map((raw, index) => {
    if (typeof raw === "string") return { path: raw };
    if (isPlainObject(raw) && typeof raw.path === "string") {
      const appendSkillMd = raw.appendSkillMd;
      if (appendSkillMd !== undefined && typeof appendSkillMd !== "string") {
        throw new Error(`${prefix}[${index}].appendSkillMd must be a string`);
      }
      return { path: raw.path, appendSkillMd };
    }
    throw new Error(`${prefix}[${index}] must be a path string or { path, appendSkillMd }`);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  await main();
}
