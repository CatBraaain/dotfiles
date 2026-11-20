// One-shot elevation gate through gsudo for privileged syncs.

import type { Writer } from "./apply.ts";

export interface ElevationRequest {
  args: string[];
  execPath: string;
  scriptPath: string;
  runtime?: ElevationRuntime;
}

export interface ElevationRuntime {
  platform: NodeJS.Platform;
  which: (command: string) => string | null;
  isElevated(): boolean;
  selfElevate(request: ElevationRequest): number;
}

export const ELEVATION_RUNTIME: ElevationRuntime = {
  platform: process.platform,
  which: Bun.which,
  isElevated,
  selfElevate,
};

export function elevateIfNeeded(
  changesNeeded: boolean,
  request: ElevationRequest,
  err: Writer,
): number | undefined {
  if (!changesNeeded) return undefined;
  const runtime = request.runtime ?? ELEVATION_RUNTIME;
  if (runtime.platform !== "win32") return undefined;
  if (runtime.which("gsudo") === null) {
    err.write("wintasks: gsudo was not found in PATH\n");
    return 1;
  }
  if (runtime.isElevated()) return undefined;
  return runtime.selfElevate(request);
}

function isElevated(): boolean {
  // `gsudo status IsElevated` exits with 0 when elevated, 1 otherwise.
  const status = Bun.spawnSync(["gsudo", "status", "IsElevated"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return status.exitCode === 0;
}

function selfElevate(request: ElevationRequest): number {
  const child = Bun.spawnSync(
    ["gsudo", "-d", request.execPath, request.scriptPath, ...request.args],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  return child.exitCode ?? 1;
}
