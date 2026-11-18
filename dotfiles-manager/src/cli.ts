// Internal command entry point for the dotfiles manager.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { main as apply } from "./apply.ts";
import { main as build } from "./build.ts";
import { main as diff } from "./diff.ts";
import { resolveWsl, type WslConnection } from "./wsl.ts";

const usage = "usage: bun dotfiles-manager <apply|diff|managed> [--yes] (--yes is for apply only)";

export async function main(
  args: readonly string[],
  root = resolve(import.meta.dir, "../.."),
  homeRoot = homedir(),
): Promise<number> {
  const yes = args.includes("--yes");
  const rest = args.filter((argument) => argument !== "--yes");
  const [command] = rest;
  const isSingleArgument = rest.length === 1;
  const isKnownCommand = command === "apply" || command === "diff" || command === "managed";
  const isYesAllowed = !yes || command === "apply";
  if (!isSingleArgument || !isKnownCommand || !isYesAllowed) throw new Error(usage);

  const started = performance.now();
  // Resolved once here and shared with build, externals and the GitAlias hook
  // (spec: §Windows の WSL 接続); Linux/macOS resolve no connection.
  const connection = await resolveWsl(root);
  try {
    await logBuild(root, homeRoot, connection);

    const distRoot = join(root, "dist");
    const code = await logStage(command, () =>
      command === "apply"
        ? apply([distRoot, homeRoot, ...(yes ? ["--yes"] : [])])
        : diff(command === "managed" ? ["--managed", distRoot, homeRoot] : [distRoot, homeRoot]),
    );
    logElapsed(`command ${command}`, code === 0 ? "success" : "failure", started);
    return code;
  } catch (error) {
    logElapsed(`command ${command}`, "failure", started);
    throw error;
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

async function logStage(name: string, action: () => Promise<number>): Promise<number> {
  const started = performance.now();
  console.log(name === "apply" ? "[apply] Started" : `stage ${name} start`);
  try {
    const code = await action();
    logStageOutcome(name, code === 0 ? "success" : "failure", started);
    return code;
  } catch (error) {
    logStageOutcome(name, "failure", started);
    throw error;
  }
}

function logStageOutcome(name: string, status: "success" | "failure", started: number): void {
  if (name === "apply") {
    console.log(
      `[apply] ${status === "success" ? "Complete" : "Failed"} (${elapsedSeconds(started)}s)`,
    );
    return;
  }
  logElapsed(`stage ${name}`, status, started);
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
