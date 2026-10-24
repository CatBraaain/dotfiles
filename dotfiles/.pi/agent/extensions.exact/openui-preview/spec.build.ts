import { copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";

const LIBRARY_FILE = "library.data.ts";
const SPEC_FILE = "spec.json";
const PROMPT_OPTIONS_FILE = "prompt-options.json";

async function main(): Promise<void> {
  const hookDistDir = process.cwd();
  if (!existsSync(join(hookDistDir, LIBRARY_FILE))) return;

  const sharedModules = join(hookDistDir, "..", "..", ".build-deps", "node_modules");
  const cli = join(sharedModules, "@openuidev", "cli", "dist", "index.js");
  if (!existsSync(cli)) {
    throw new Error(
      `Shared pi build dependencies are missing: ${cli}; bun_install.build.ts must run first`,
    );
  }

  const buildDir = join(hookDistDir, ".build");
  mkdirSync(buildDir, { recursive: true });
  for (const file of [LIBRARY_FILE, "display-only.ts"]) {
    copyFileSync(join(hookDistDir, file), join(buildDir, file));
  }
  const localModules = join(buildDir, "node_modules");
  if (!existsSync(localModules)) {
    symlinkSync(relative(buildDir, sharedModules), localModules, "dir");
  }
  const library = join(buildDir, LIBRARY_FILE);
  const generated = Bun.spawnSync(
    [
      process.execPath,
      cli,
      "generate",
      library,
      "--spec",
      "--out",
      join(hookDistDir, SPEC_FILE),
      "--no-telemetry",
    ],
    { cwd: buildDir, stdout: "inherit", stderr: "inherit" },
  );
  if (generated.exitCode !== 0) {
    throw new Error(`openui generate failed with exit code ${generated.exitCode}`);
  }

  const { promptOptions } = await import(library);
  await Bun.write(
    join(hookDistDir, PROMPT_OPTIONS_FILE),
    JSON.stringify(promptOptions, null, 2) + "\n",
  );
}

if (import.meta.main) await main();
