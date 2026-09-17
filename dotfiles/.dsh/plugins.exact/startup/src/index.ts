/**
 * dotfiles-dsh-startup — run the shared priming script once per harness boot.
 *
 * Spawns `~/.agents/startup` detached (behavior contract: SPEC.md; the
 * script's own tasks are contracted in dotfiles/.agents/startup.spec.md).
 * The script tolerates concurrent runs, so pi and dsh may both call it.
 * Priming must never break harness startup: spawn errors are swallowed.
 */
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Context } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { join } from "node:path";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export function startupScriptPath(home: string = homedir()): string {
  return join(home, ".agents", "startup");
}

export const name = "startup";

export function apply(ctx: Context, spawnProcess: SpawnFn = spawn): void {
  try {
    const child = spawnProcess(startupScriptPath(), [], { detached: true, stdio: "ignore" });
    // Script absence arrives as an async "error" event: without a listener it
    // would crash the harness, even though priming is optional here.
    child.on("error", () => {});
    child.unref();
  } catch {
    // priming is optional: never break harness startup over it
  }
}
