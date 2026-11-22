// Internal command entry point for the dotfiles manager.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { confirmApplyStdin, main as apply } from "./apply.ts";
import { main as build } from "./build.ts";
import { main as diff } from "./diff.ts";
import { resolveWsl, type WslConnection } from "./wsl.ts";

const usage = "usage: bun dotfiles-manager <apply [--ask | --dry-run] [--yes] | diff | managed>";
const applyFlags = ["--ask", "--dry-run", "--yes"];

export async function main(
  args: readonly string[],
  root = resolve(import.meta.dir, "../.."),
  homeRoot = homedir(),
): Promise<number> {
  const flags = args.filter((argument) => applyFlags.includes(argument));
  const [command, ...extraArgs] = args.filter((argument) => !applyFlags.includes(argument));
  const isKnownCommand = command === "apply" || command === "diff" || command === "managed";
  const hasMisplacedFlags = flags.length > 0 && command !== "apply";
  const shouldAsk = flags.includes("--ask");
  const isDryRun = flags.includes("--dry-run");
  const hasConflictingFlags = shouldAsk && isDryRun;
  if (!isKnownCommand || extraArgs.length > 0 || hasMisplacedFlags || hasConflictingFlags) {
    throw new Error(usage);
  }

  const stage = isDryRun ? "diff" : command;

  const started = performance.now();
  let confirmationWaitMs = 0;
  // Resolved once here and shared with build, externals and the GitAlias hook
  // (spec: §Windows の WSL 接続); Linux/macOS resolve no connection.
  const connection = await resolveWsl(root);
  try {
    await logBuild(root, homeRoot, connection);

    const distRoot = join(root, "dist");
    const code = await logStage(
      stage,
      () => {
        if (stage === "apply") {
          const applyArgs = shouldAsk ? [distRoot, homeRoot] : [distRoot, homeRoot, "--yes"];
          return apply(applyArgs, confirmApply);
        }
        return diff(stage === "managed" ? ["--managed", distRoot, homeRoot] : [distRoot, homeRoot]);
      },
      elapsedWithoutConfirmation,
    );
    logElapsed(
      `command ${command}`,
      code === 0 ? "success" : "failure",
      elapsedWithoutConfirmation(started),
    );
    return code;
  } catch (error) {
    logElapsed(`command ${command}`, "failure", elapsedWithoutConfirmation(started));
    throw error;
  }

  async function confirmApply(): Promise<boolean> {
    const waitStarted = performance.now();
    try {
      return await confirmApplyStdin();
    } finally {
      confirmationWaitMs = performance.now() - waitStarted;
    }
  }

  function elapsedWithoutConfirmation(started: number): string {
    return elapsedSeconds(started, confirmationWaitMs);
  }
}

async function logBuild(root: string, homeRoot: string, wsl?: WslConnection): Promise<void> {
  const started = performance.now();
  console.log("[build] Started");
  try {
    await build(root, undefined, homeRoot, {
      onHookEvent: (path, status, elapsedSeconds) => {
        if (status === "start") {
          console.log(`  [${path}] Started`);
          return;
        }
        const outcome = status === "success" ? "✓ Complete" : "✗ Failed";
        console.log(`  [${path}] ${outcome} (${elapsedSeconds.toFixed(2)}s)`);
      },
      onPhase: (phase, elapsedSeconds) =>
        console.log(`  [build] ${phase} (${elapsedSeconds.toFixed(2)}s)`),
      connection: wsl,
    });
    console.log(`[build] Complete (${elapsedSeconds(started)}s)`);
  } catch (error) {
    console.log(`[build] Failed (${elapsedSeconds(started)}s)`);
    throw error;
  }
}

async function logStage(
  name: string,
  action: () => Promise<number>,
  elapsedSince: (started: number) => string,
): Promise<number> {
  const started = performance.now();
  console.log(name === "apply" ? "[apply] Started" : `stage ${name} start`);
  try {
    const code = await action();
    logStageOutcome(name, code === 0 ? "success" : "failure", elapsedSince(started));
    return code;
  } catch (error) {
    logStageOutcome(name, "failure", elapsedSince(started));
    throw error;
  }
}

function logStageOutcome(name: string, status: "success" | "failure", seconds: string): void {
  if (name === "apply") {
    console.log(`[apply] ${status === "success" ? "Complete" : "Failed"} (${seconds}s)`);
    return;
  }
  logElapsed(`stage ${name}`, status, seconds);
}

function logElapsed(label: string, status: "success" | "failure", seconds: string): void {
  console.log(`${label} ${status} (${seconds}s)`);
}

function elapsedSeconds(started: number, excludedMs = 0): string {
  return ((performance.now() - started - excludedMs) / 1000).toFixed(2);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
