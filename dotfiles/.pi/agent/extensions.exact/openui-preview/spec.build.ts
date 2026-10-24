/**
 * Build hook: generate `spec.json` and `prompt-options.json` for the
 * openui-preview extension from `library.data.ts` (the canonical library
 * definition in this folder), using the `openui` CLI installed as a
 * devDependency of `dotfiles/.pi/agent`.
 *
 * Runs from the dist copy of this folder (cwd), but the CLI must resolve the
 * npm packages imported by `library.data.ts`, so the generation executes with
 * the workspace `dotfiles/.pi/agent` folder as cwd — `bun install` must have
 * run there first (same prerequisite as `bun test`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const LIBRARY_FILE = "library.data.ts";
const SPEC_FILE = "spec.json";
const PROMPT_OPTIONS_FILE = "prompt-options.json";
const AGENT_DIR_SEGMENTS = [".pi", "agent"];

/**
 * The workspace folder of this extension in the source repository, derived
 * from the dist root: dist lives at `<repo>/dist` and mirrors `<repo>/dotfiles`,
 * so the source folder sits one level up under `dotfiles/`.
 */
export function resolveSourceDir(distDir: string, hookDistDir: string): string {
  if (!hookDistDir.startsWith(distDir + "/") && hookDistDir !== distDir) {
    throw new Error(`hook dir ${hookDistDir} is not inside dist dir ${distDir}`);
  }
  const relative = hookDistDir === distDir ? "" : hookDistDir.slice(distDir.length + 1);
  return join(distDir, "..", "dotfiles", relative);
}

function repoAgentDir(distDir: string): string {
  return join(distDir, "..", "dotfiles", ...AGENT_DIR_SEGMENTS);
}

async function main(): Promise<void> {
  const hookDistDir = process.cwd();
  if (!existsSync(join(hookDistDir, LIBRARY_FILE))) return;

  const distDir = process.env.DOTFILES_DIST_DIR;
  if (distDir === undefined || distDir.length === 0) {
    throw new Error("DOTFILES_DIST_DIR is not set");
  }
  const sourceDir = resolveSourceDir(distDir, hookDistDir);
  const sourceLibrary = join(sourceDir, LIBRARY_FILE);
  if (!existsSync(sourceLibrary)) {
    throw new Error(`library definition not found: ${sourceLibrary}`);
  }
  const agentDir = repoAgentDir(distDir);
  if (!existsSync(join(agentDir, "node_modules", ".bin", "openui"))) {
    throw new Error(
      `openui CLI is missing under ${agentDir}; run "bun install" in dotfiles/.pi/agent first`,
    );
  }

  const generated = Bun.spawnSync(
    [
      process.execPath,
      cliEntry(agentDir),
      "generate",
      sourceLibrary,
      "--spec",
      "--out",
      join(hookDistDir, SPEC_FILE),
      "--no-telemetry",
    ],
    { cwd: agentDir, stdout: "inherit", stderr: "inherit" },
  );
  if (generated.exitCode !== 0) {
    throw new Error(`openui generate failed with exit code ${generated.exitCode}`);
  }

  const { promptOptions } = await import(sourceLibrary);
  await Bun.write(
    join(hookDistDir, PROMPT_OPTIONS_FILE),
    JSON.stringify(promptOptions, null, 2) + "\n",
  );
}

if (import.meta.main) await main();

/** Bun executes the CLI entry directly — no node shebang involved. */
function cliEntry(agentDir: string): string {
  return join(agentDir, "node_modules", "@openuidev", "cli", "dist", "index.js");
}