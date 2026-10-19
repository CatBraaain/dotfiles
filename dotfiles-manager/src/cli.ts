// Internal command entry point for the dotfiles manager.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { main as apply } from "./apply.ts";
import { main as build } from "./build.ts";
import { main as diff } from "./diff.ts";
import { resolveWsl, type WslConnection } from "./wsl.ts";

const usage =
  "usage: bun dotfiles-manager <apply|diff|managed> [--yes] (--yes is for apply only)";

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
  console.log("Build started");
  try {
    await build(root, undefined, homeRoot, {
      onHookEvent: (path, status, elapsedSeconds, stdoutNeedsNewline) => {
        if (status === "start") {
          console.log(`  Running ${path}`);
          return;
        }
        if (stdoutNeedsNewline) console.log();
        console.log(
          `  ${status === "success" ? "✓" : "✗"} ${path} (${elapsedSeconds.toFixed(2)}s)`,
        );
      },
      onPhase: (phase, elapsedSeconds) => console.log(`  ${phase} (${elapsedSeconds.toFixed(2)}s)`),
      connection: wsl,
    });
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
