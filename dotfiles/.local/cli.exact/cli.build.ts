import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const { compileWithCache } = await import(
    join(managerSrcDir(), "compile-cache.ts")
  );
  const cliDir = join(process.cwd(), "pi-mux");
  const buildPath = `${cliDir}.compile`;
  await compileWithCache({
    name: "pi-mux",
    cliDir,
    entryPath: `${cliDir}/src/main.ts`,
    buildPath,
  });
  await rm(cliDir, { recursive: true });
  await rename(buildPath, `${cliDir}.executable`);
}

function managerSrcDir(): string {
  const value = process.env.DOTFILES_MANAGER_SRC;
  if (value === undefined || value === "")
    throw new Error("hook environment variable is not set: DOTFILES_MANAGER_SRC");
  return value;
}

if (import.meta.main) await main();
