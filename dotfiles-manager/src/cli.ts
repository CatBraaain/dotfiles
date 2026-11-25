// Internal command entry point for the dotfiles manager.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ApplyHookLog, writeOutcome, writeTimedRow } from "./apply-log.ts";
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
  const distRoot = join(root, "dist");
  const hookLog = command === "apply" ? new ApplyHookLog(distRoot) : undefined;

  const started = performance.now();
  let confirmationWaitMs = 0;
  // Resolved once here and shared with build, externals and the GitAlias hook
  // (spec: §Windows の WSL 接続); Linux/macOS resolve no connection.
  const connection = await resolveWsl(root);
  try {
    const generatedLinks = await logBuild(root, homeRoot, connection, hookLog);

    const code = await logStage(
      stage,
      () => {
        if (stage === "apply") {
          const applyArgs = shouldAsk ? [distRoot, homeRoot] : [distRoot, homeRoot, "--yes"];
          return apply(applyArgs, confirmApply, hookLog, generatedLinks);
        }
        return diff(
          stage === "managed" ? ["--managed", distRoot, homeRoot] : [distRoot, homeRoot],
          generatedLinks,
        );
      },
      elapsedWithoutConfirmation,
    );
    logCommandOutcome(code === 0);
    return code;
  } catch (error) {
    logCommandOutcome(false);
    throw error;
  }

  function logCommandOutcome(succeeded: boolean): void {
    const seconds = elapsedWithoutConfirmation(started);
    if (command === "apply") {
      console.log();
      writeOutcome(succeeded ? "Done" : "Failed", succeeded, seconds);
    } else {
      logElapsed(`command ${command}`, succeeded ? "success" : "failure", seconds);
    }
  }

  async function confirmApply(): Promise<boolean> {
    const waitStarted = performance.now();
    try {
      return await confirmApplyStdin();
    } finally {
      confirmationWaitMs = performance.now() - waitStarted;
      if (!process.stdin.isTTY || !process.stdout.isTTY) console.log();
    }
  }

  function elapsedWithoutConfirmation(started: number): string {
    return elapsedSeconds(started, confirmationWaitMs);
  }
}

async function logBuild(
  root: string,
  homeRoot: string,
  wsl: WslConnection | undefined,
  hookLog?: ApplyHookLog,
): Promise<ReadonlySet<string>> {
  const started = performance.now();
  console.log(hookLog ? "Build\n  Steps" : "[build] Started");
  try {
    const generatedLinks = await build(root, undefined, homeRoot, {
      hookLog,
      onHookEvent: hookLog
        ? undefined
        : (path, status, seconds) => {
            if (status === "start") {
              console.log(`  [${path}] Started`);
              return;
            }
            const outcome = status === "success" ? "✓ Complete" : "✗ Failed";
            console.log(`  [${path}] ${outcome} (${seconds.toFixed(2)}s)`);
          },
      onPhase: (phase, seconds) => {
        if (hookLog) writeTimedRow(phase, seconds.toFixed(2));
        else console.log(`  [build] ${phase} (${seconds.toFixed(2)}s)`);
      },
      connection: wsl,
    });
    report(true);
    return generatedLinks;
  } catch (error) {
    report(false);
    throw error;
  }

  function report(succeeded: boolean): void {
    const seconds = elapsedSeconds(started);
    if (hookLog) writeOutcome(succeeded ? "Build complete" : "Build failed", succeeded, seconds);
    else console.log(`[build] ${succeeded ? "Complete" : "Failed"} (${seconds}s)`);
  }
}

async function logStage(
  name: string,
  action: () => Promise<number>,
  elapsedSince: (started: number) => string,
): Promise<number> {
  const started = performance.now();
  console.log(name === "apply" ? "\nApply" : `stage ${name} start`);
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
    writeOutcome(
      status === "success" ? "Apply complete" : "Apply failed",
      status === "success",
      seconds,
    );
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
