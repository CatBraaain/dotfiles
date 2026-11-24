import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ApplyHookLog } from "./apply-log.ts";
import { compareCodeUnits } from "./compare.ts";
import {
  ensureHookDirectory,
  forwardHookOutput,
  hookCommand,
  removeEmptyHookDirectories,
  removeHookSnapshot,
  writeHookSnapshot,
} from "./hook-runner.ts";
import { hookPlatform, isBuildHookName, isPostHookName } from "./path-mapping.ts";

type Hook = { absolutePath: string; relativeParent: string; name: string; contents: string };

export type HookEvent = (
  path: string,
  status: "start" | "success" | "failure",
  elapsedSeconds: number,
) => void;

export async function collectHooks(distDir: string, platform: string): Promise<Hook[]> {
  const hooks: Hook[] = [];
  async function walk(directory: string, relativeParent: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    );
    const postHooks: Hook[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isBuildHookName(entry.name)) continue;
      // OS-modified hooks (spec: SPEC.md §フックシステム) only run when the
      // build platform matches the modifier; other platforms treat them as
      // absent.
      const hookPlatformName = hookPlatform(entry.name);
      if (hookPlatformName !== undefined && hookPlatformName !== platform) continue;
      const entryPath = join(directory, entry.name);
      const hook = {
        absolutePath: entryPath,
        relativeParent,
        name: entry.name,
        contents: await readFile(entryPath, "utf8"),
      };
      if (isPostHookName(entry.name)) postHooks.push(hook);
      else hooks.push(hook);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const childParent = relativeParent === "" ? entry.name : `${relativeParent}/${entry.name}`;
      await walk(join(directory, entry.name), childParent);
    }
    hooks.push(...postHooks);
  }
  await walk(distDir, "");
  return hooks;
}

function hookRelativePath(hook: Hook): string {
  return hook.relativeParent === "" ? hook.name : `${hook.relativeParent}/${hook.name}`;
}

export async function runHooks(
  hooks: Hook[],
  distDir: string,
  homeRoot: string,
  onHookEvent?: HookEvent,
  hookLog?: ApplyHookLog,
): Promise<void> {
  hookLog?.begin(hooks.map(hookRelativePath));
  for (const hook of hooks) {
    const hookDistDir =
      hook.relativeParent === "" ? distDir : join(distDir, ...hook.relativeParent.split("/"));
    // Skip hooks whose folder an earlier hook removed or moved (spec:
    // SPEC.md §build: ローカルフック 検出と順序).
    if (!existsSync(hookDistDir)) continue;
    await runHook(hook, hookDistDir, distDir, homeRoot, onHookEvent, hookLog);
  }
}

async function runHook(
  hook: Hook,
  hookDistDir: string,
  distDir: string,
  homeRoot: string,
  onHookEvent?: HookEvent,
  hookLog?: ApplyHookLog,
): Promise<void> {
  const relativePath = hookRelativePath(hook);
  const started = performance.now();
  onHookEvent?.(relativePath, "start", 0);
  try {
    const createdDirectories = await ensureHookDirectory(hookDistDir, distDir);
    try {
      if (!relativePath.endsWith(".ts"))
        throw new Error(`build hook has unsupported extension: ${relativePath}`);

      const snapshotPath = await writeHookSnapshot(hookDistDir, hook.name, hook.contents);
      try {
        await runChildProcess(
          hookCommand(resolve(snapshotPath)),
          hookDistDir,
          {
            ...process.env,
            DOTFILES_DIST_DIR: resolve(distDir),
            DOTFILES_HOME_ROOT: resolve(homeRoot),
            DOTFILES_MANAGER_SRC: import.meta.dir,
          },
          relativePath,
          hookLog,
        );
      } finally {
        await removeHookSnapshot(snapshotPath, distDir);
      }
    } finally {
      await removeEmptyHookDirectories(createdDirectories);
    }
  } catch (error) {
    await report(false);
    throw error;
  }
  await report(true);

  async function report(succeeded: boolean): Promise<void> {
    const seconds = (performance.now() - started) / 1000;
    onHookEvent?.(relativePath, succeeded ? "success" : "failure", seconds);
    await hookLog?.finish(relativePath, succeeded, seconds.toFixed(2));
  }
}

async function runChildProcess(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  relativePath: string,
  hookLog?: ApplyHookLog,
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await forwardHookOutput(proc, relativePath, hookLog);
  if (exitCode !== 0) {
    const reason = proc.signalCode ? `signal ${proc.signalCode}` : `exit code ${exitCode}`;
    throw new Error(`local build hook failed: ${relativePath} (${reason})`);
  }
}
