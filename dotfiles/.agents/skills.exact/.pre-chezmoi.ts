// Local pre-chezmoi hook for dotfiles/.agents/skills.exact (spec §2).
// Syncs external skills from ~/mirrors/github.com/<owner>/<repo> into the
// matching dist folder. Source .pre-chezmoi.skills.yaml defines what to sync; files that
// already exist here (local overrides, e.g. a custom SKILL.md) always win.
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import yaml from "yaml";

export type SkillEntry = { path: string; appendSkillMd?: string };
export type SkillRepo = { repo: string; entries: SkillEntry[] };

const hookRelativePath = "dotfiles/.agents/skills.exact/.pre-chezmoi.ts";
const mirrorRoot = join(homedir(), "mirrors", "github.com");

// Prefixes chezmoi parses as source-state attributes (scripts, removals, ...).
// Synced skill assets must land verbatim, so names using them are wrapped in
// literal_, which stops chezmoi's attribute parsing.
const chezmoiAttributePrefix =
  /^(after|before|create|dot|empty|encrypted|exact|executable|external|literal|modify|once|onchange|private|readonly|remove|run|symlink)_/;

export async function loadSkillConfig(configPath: string): Promise<SkillRepo[]> {
  const doc: unknown = yaml.parse(await readFile(configPath, "utf-8"));
  const externalSkills = (doc as { externalSkills?: unknown })?.externalSkills;
  if (!isPlainObject(externalSkills)) {
    throw new Error(`.pre-chezmoi.skills.yaml must have an externalSkills mapping: ${configPath}`);
  }
  return Object.entries(externalSkills).map(([repo, rawEntries]) => ({
    repo,
    entries: normalizeEntries(repo, rawEntries),
  }));
}

export async function resolveSkillDir(mirrorDir: string, path: string): Promise<string> {
  const matches = [...new Bun.Glob(path).scanSync({ cwd: mirrorDir, onlyFiles: false })]
    .map((relative) => join(mirrorDir, relative))
    .filter((absolute) => statSync(absolute).isDirectory());
  if (matches.length === 0) throw new Error(`skill path matched nothing in mirror: ${path}`);
  if (matches.length > 1)
    throw new Error(`skill path matched multiple directories in mirror: ${path}`);
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

async function main(): Promise<void> {
  const config = await loadSkillConfig(join(import.meta.dir, ".pre-chezmoi.skills.yaml"));
  for (const { repo, entries } of config) {
    const mirrorDir = await syncMirror(repo);
    for (const entry of entries) {
      const skillDir = await resolveSkillDir(mirrorDir, entry.path);
      const targetDir = join(process.cwd(), basename(entry.path));
      await copySkillTree(skillDir, targetDir);
      if (entry.appendSkillMd !== undefined) await appendSkillMd(targetDir, entry.appendSkillMd);
      console.log(`skill: ${basename(entry.path)} (${repo})`);
    }
  }
}

async function syncMirror(repo: string): Promise<string> {
  const mirrorDir = join(mirrorRoot, ...repo.split("/"));
  if (!existsSync(mirrorDir)) {
    const url = `https://github.com/${repo}.git`;
    const result = runGit(["clone", "--quiet", url, mirrorDir]);
    if (!result.ok) throw new Error(`git clone failed for ${url}: ${result.stderr}`);
    console.log(`mirror: cloned ${repo}`);
    return mirrorDir;
  }

  const result = runGit(["-C", mirrorDir, "pull", "--ff-only", "--quiet"]);
  if (result.ok) console.log(`mirror: pulled ${repo}`);
  else console.error(`warning: git pull failed for ${repo}: ${result.stderr}`);
  return mirrorDir;
}

function runGit(args: string[]): { ok: boolean; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "ignore", stderr: "pipe" });
  return { ok: proc.exitCode === 0, stderr: proc.stderr.toString().trim() };
}

function normalizeEntries(repo: string, rawEntries: unknown): SkillEntry[] {
  if (!Array.isArray(rawEntries)) {
    throw new Error(`externalSkills.${repo} must be an array`);
  }
  return rawEntries.map((raw, index) => {
    if (typeof raw === "string") return { path: raw };
    if (isPlainObject(raw) && typeof raw.path === "string") {
      const appendSkillMd = raw.appendSkillMd;
      if (appendSkillMd !== undefined && typeof appendSkillMd !== "string") {
        throw new Error(`externalSkills.${repo}[${index}].appendSkillMd must be a string`);
      }
      return { path: raw.path, appendSkillMd };
    }
    throw new Error(
      `externalSkills.${repo}[${index}] must be a path string or { path, appendSkillMd }`,
    );
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${hookRelativePath}: ${message}`);
    process.exitCode = 1;
  }
}
