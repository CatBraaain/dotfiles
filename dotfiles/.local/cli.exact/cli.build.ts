import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const cliDir = join(process.cwd(), "pi-mux");
  const buildPath = `${cliDir}.compile`;
  const compiled = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--compile-autoload-package-json",
      join(cliDir, "src/main.ts"),
      "--outfile",
      buildPath,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await compiled.exited;
  if (exitCode !== 0) {
    await rm(buildPath, { force: true });
    throw new Error(`bun build --compile failed for pi-mux (exit code ${exitCode})`);
  }
  await rm(cliDir, { recursive: true });
  await rename(buildPath, `${cliDir}.executable`);
}

if (import.meta.main) await main();
