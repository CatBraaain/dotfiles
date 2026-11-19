// Build hook: compile each CLI folder under dist/cli that has src/main.ts
// into a single executable named after the folder (bun build --compile), so
// applying dist leaves only the executables plus pi-shot.executable under
// ~/.agents/cli.
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const { compileWithCache } = await import(
    join(managerSrcDir(), "compile-cache.ts")
  );
  const distCliDir = process.cwd();
  const entries = await readdir(distCliDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const cliDir = join(distCliDir, entry.name);
      const entryPath = join(cliDir, "src/main.ts");
      if (!entry.isDirectory() || !existsSync(entryPath)) return;
      await compileCli(entry.name, cliDir, compileWithCache);
    }),
  );
}

async function compileCli(
  name: string,
  cliDir: string,
  compileWithCache: (request: {
    name: string;
    cliDir: string;
    entryPath: string;
    buildPath: string;
  }) => Promise<void>,
): Promise<void> {
  // The executable carries .executable so apply grants the owner exec bit
  // (spec §.executable の解釈); the --outfile must not collide with the source
  // folder, so build beside it and swap after removing the folder.
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const buildPath = `${cliDir}.compile${exeSuffix}`;
  await compileWithCache({ name, cliDir, entryPath: `${cliDir}/src/main.ts`, buildPath });
  await rm(cliDir, { recursive: true });
  await rename(buildPath, `${cliDir}${exeSuffix}.executable`);
}

function managerSrcDir(): string {
  const value = process.env.DOTFILES_MANAGER_SRC;
  if (value === undefined || value === "")
    throw new Error("hook environment variable is not set: DOTFILES_MANAGER_SRC");
  return value;
}

if (import.meta.main) await main();
