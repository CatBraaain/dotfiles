// Internal command entry point for the dotfiles manager.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { main as apply } from "./apply.ts";
import { main as build } from "./build.ts";
import { main as diff } from "./diff.ts";
import { acquireHomeLock } from "./lock.ts";

const usage = "usage: bun dotfiles-manager <apply|diff|managed>";

export async function main(
  args: readonly string[],
  root = resolve(import.meta.dir, "../.."),
  homeRoot = homedir(),
): Promise<number> {
  const [command] = args;
  if (args.length !== 1 || (command !== "apply" && command !== "diff" && command !== "managed"))
    throw new Error(usage);

  const started = performance.now();
  const lock = acquireHomeLock(homeRoot, (holder) =>
    console.log(
      holder === null
        ? "Lock held by another session, waiting..."
        : `Lock held by PID ${holder}, waiting...`,
    ),
  );
  try {
    await logBuild(root, homeRoot);

    const distRoot = join(root, "dist");
    const code = await logStage(command, () =>
      command === "apply"
        ? apply([distRoot, homeRoot])
        : diff(command === "managed" ? ["--managed", distRoot, homeRoot] : [distRoot, homeRoot]),
    );
    logElapsed(`command ${command}`, code === 0 ? "success" : "failure", started);
    return code;
  } catch (error) {
    logElapsed(`command ${command}`, "failure", started);
    throw error;
  } finally {
    lock.release();
  }
}

async function logBuild(root: string, homeRoot: string): Promise<void> {
  const started = performance.now();
  console.log("Build started");
  try {
    await build(
      root,
      undefined,
      homeRoot,
      (path, status, elapsedSeconds, stdoutNeedsNewline) => {
        if (status === "start") {
          console.log(`  Running ${path}`);
          return;
        }
        if (stdoutNeedsNewline) console.log();
        console.log(
          `  ${status === "success" ? "✓" : "✗"} ${path} (${elapsedSeconds.toFixed(2)}s)`,
        );
      },
      (phase, elapsedSeconds) => console.log(`  ${phase} (${elapsedSeconds.toFixed(2)}s)`),
    );
    console.log(`Build complete (${elapsedSeconds(started)}s)`);
  } catch (error) {
    console.log(`Build failed (${elapsedSeconds(started)}s)`);
    throw error;
  }
}

async function logStage(name: string, action: () => Promise<number>): Promise<number> {
  const started = performance.now();
  console.log(`stage ${name} start`);
  try {
    const code = await action();
    logElapsed(`stage ${name}`, code === 0 ? "success" : "failure", started);
    return code;
  } catch (error) {
    logElapsed(`stage ${name}`, "failure", started);
    throw error;
  }
}

function logElapsed(label: string, status: "success" | "failure", started: number): void {
  console.log(`${label} ${status} (${elapsedSeconds(started)}s)`);
}

function elapsedSeconds(started: number): string {
  return ((performance.now() - started) / 1000).toFixed(2);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
