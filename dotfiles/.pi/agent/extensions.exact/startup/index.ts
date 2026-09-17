import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

// Shared priming script deployed from
// dotfiles/.agents/scripts/startup.executable (behavior contract:
// dotfiles/.agents/scripts/startup.spec.md).
export function startupScriptPath(home: string = homedir()): string {
  return join(home, ".agents", "scripts", "startup");
}

export default function startupExtension(pi: ExtensionAPI, spawnProcess: SpawnFn = spawn): void {
  pi.on("session_start", async (event) => {
    if (event.reason !== "startup") return;
    try {
      const child = spawnProcess(startupScriptPath(), [], { detached: true, stdio: "ignore" });
      // Script absence arrives as an async "error" event: without a listener
      // it would crash pi, even though priming is optional here.
      child.on("error", () => {});
      child.unref();
    } catch {
      // priming is optional: never break the session over it
    }
  });
}
