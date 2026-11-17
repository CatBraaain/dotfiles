import { lstat, readdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

type DirectoryRename = { source: string; destination: string };

async function main(): Promise<void> {
  const configuredDistDir = process.env.DOTFILES_DIST_DIR;
  if (!configuredDistDir) throw new Error("DOTFILES_DIST_DIR must be set");
  const distDir = await realpath(configuredDistDir);
  const skillsDir = await realpath(process.cwd());
  const relativeSkillsDir = relative(distDir, skillsDir);
  if (
    relativeSkillsDir === "" ||
    relativeSkillsDir === ".." ||
    relativeSkillsDir.startsWith(`..${sep}`) ||
    isAbsolute(relativeSkillsDir)
  ) {
    throw new Error(`skills directory must be inside dist: ${skillsDir}`);
  }

  const renames: DirectoryRename[] = [];
  await collectRenames(skillsDir, renames);
  for (const { source, destination } of renames) await rename(source, destination);
}

async function collectRenames(directory: string, renames: DirectoryRename[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = join(directory, entry.name);
    const destination = entry.name.endsWith(".exact") ? source : `${source}.exact`;
    if (destination !== source) {
      const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing) throw new Error(`exact directory destination already exists: ${destination}`);
    }
    await collectRenames(source, renames);
    if (destination !== source) renames.push({ source, destination });
  }
}

if (import.meta.main) await main();
