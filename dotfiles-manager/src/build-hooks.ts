// Local build hooks (spec: SPEC.md §build: ローカルフック): collect
// .build.<ext> / .build-machine.<ext> files from dist once, then run each
// as an independent Bun child process via build-hook-runner.ts.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ensureHookDirectory,
  removeEmptyHookDirectories,
  removeHookSnapshot,
  writeHookSnapshot,
} from "./hook-runner.ts";

type Hook = { absolutePath: string; relativeParent: string; name: string; contents: string };

export type HookEvent = (
  path: string,
  status: "start" | "success" | "failure",
  elapsedSeconds: number,
  stdoutNeedsNewline?: boolean,
) => void;

const hookNamePattern = /\.build(?:-machine)?\.[^.]+$/;

export async function collectHooks(distDir: string): Promise<Hook[]> {
  const hooks: Hook[] = [];
  async function walk(directory: string, relativeParent: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      if (!entry.isFile() || !hookNamePattern.test(entry.name)) continue;
      const entryPath = join(directory, entry.name);
      hooks.push({
        absolutePath: entryPath,
        relativeParent,
        name: entry.name,
        contents: await readFile(entryPath, "utf8"),
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const childParent = relativeParent === "" ? entry.name : `${relativeParent}/${entry.name}`;
      await walk(join(directory, entry.name), childParent);
    }
  }
  await walk(distDir, "");
  return hooks;
}

function hookRelativePath(hook: Hook): string {
  return hook.relativeParent === "" ? hook.name : `${hook.relativeParent}/${hook.name}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function runHooks(
  hooks: Hook[],
  distDir: string,
  homeRoot: string,
  onHookEvent?: HookEvent,
): Promise<void> {
  for (const hook of hooks) {
    const relativePath = hookRelativePath(hook);
    const hookDistDir =
      hook.relativeParent === "" ? distDir : join(distDir, ...hook.relativeParent.split("/"));
    // Skip hooks whose folder an earlier hook removed or moved (spec:
    // SPEC.md §build: ローカルフック 検出と順序).
    if (!existsSync(hookDistDir)) continue;
    const started = performance.now();
    const stdoutState = { needsNewline: false };
    onHookEvent?.(relativePath, "start", 0);
    try {
      const createdDirectories = await ensureHookDirectory(hookDistDir, distDir);
      try {
        if (!relativePath.endsWith(".ts"))
          throw new Error(`build hook has unsupported extension: ${relativePath}`);

        const snapshotPath = await writeHookSnapshot(hookDistDir, hook.name, hook.contents);
        try {
          const command = [
            process.execPath,
            join(import.meta.dir, "build-hook-runner.ts"),
            resolve(snapshotPath),
            resolve(distDir),
            resolve(homeRoot),
          ];
          await runChildProcess(
            command,
            hookDistDir,
            relativePath,
            "local build hook",
            onHookEvent ? stdoutState : undefined,
          );
        } finally {
          await removeHookSnapshot(snapshotPath, distDir);
        }
      } finally {
        await removeEmptyHookDirectories(createdDirectories);
      }
      onHookEvent?.(
        relativePath,
        "success",
        (performance.now() - started) / 1000,
        stdoutState.needsNewline,
      );
    } catch (error) {
      onHookEvent?.(
        relativePath,
        "failure",
        (performance.now() - started) / 1000,
        stdoutState.needsNewline,
      );
      throw error;
    }
  }
}

async function runChildProcess(
  command: string[],
  cwd: string,
  relativePath: string,
  kind: string,
  stdoutState?: { needsNewline: boolean },
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: stdoutState ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const forwardStdout = async () => {
    if (!stdoutState || !proc.stdout) return;
    for await (const chunk of proc.stdout) {
      await Bun.write(Bun.stdout, chunk);
      if (chunk.length > 0) stdoutState.needsNewline = chunk[chunk.length - 1] !== 10;
    }
  };
  const [exitCode] = await Promise.all([proc.exited, forwardStdout()]);
  if (exitCode !== 0) {
    const reason = proc.signalCode ? `signal ${proc.signalCode}` : `exit code ${exitCode}`;
    throw new Error(`${kind} failed: ${relativePath} (${reason})`);
  }
}
