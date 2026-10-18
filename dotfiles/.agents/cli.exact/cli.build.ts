// Build hook: compile each CLI folder under dist/cli that has src/main.ts
// into a single executable named after the folder (bun build --compile), so
// applying dist leaves only the executables plus pi-shot.executable under
// ~/.agents/cli.
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const distCliDir = process.cwd();
  for (const entry of await readdir(distCliDir, { withFileTypes: true })) {
    const cliDir = join(distCliDir, entry.name);
    const entryPath = join(cliDir, "src/main.ts");
    if (!entry.isDirectory() || !existsSync(entryPath)) continue;
    await compileCli(entry.name, entryPath, cliDir);
  }
}

async function compileCli(
  name: string,
  entryPath: string,
  cliDir: string,
): Promise<void> {
  // The executable carries .executable so apply grants the owner exec bit
  // (spec §.executable の解釈); the --outfile must not collide with the source
  // folder, so build beside it and swap after removing the folder.
  const buildPath = `${cliDir}.compile`;
  const executablePath = `${cliDir}.executable`;
  const compiled = Bun.spawnSync(
    [process.execPath, "build", "--compile", entryPath, "--outfile", buildPath],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (compiled.exitCode !== 0) {
    await rm(buildPath, { force: true });
    throw new Error(`bun build --compile failed for ${name} (exit code ${compiled.exitCode})`);
  }
  await rm(cliDir, { recursive: true });
  await rename(buildPath, executablePath);
}

if (import.meta.main) await main();
