import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export const THROTTLE_MS = 12 * 60 * 60 * 1000;

export interface UpdateDeps {
  /** Spawn `pi update --extensions` detached. Returns false when the spawn failed. */
  spawnUpdate: () => boolean;
  /** Injectable so tests can point the timestamp file at a temp directory. */
  timestampFile: () => string;
  now: () => number;
}

function timestampPath(): string {
  return join(homedir(), ".pi", "agent", ".auto-update-timestamp");
}

function readLastSpawnAt(file: string): number | undefined {
  try {
    const parsed = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

export function runAutoUpdate(
  event: SessionStartEvent,
  ctx: { mode: ExtensionContext["mode"] },
  deps: UpdateDeps,
): void {
  const lastSpawnAt = readLastSpawnAt(deps.timestampFile());
  const isThrottled = lastSpawnAt !== undefined && deps.now() - lastSpawnAt < THROTTLE_MS;
  const isDue = event.reason === "startup" && ctx.mode === "tui" && !isThrottled;
  if (!isDue) return;

  const spawnSucceeded = deps.spawnUpdate();
  if (!spawnSucceeded) return;
  writeFileSync(deps.timestampFile(), String(deps.now()));
}

const defaultDeps: UpdateDeps = {
  spawnUpdate: () => {
    try {
      spawn("pi", ["update", "--extensions"], {
        detached: true,
        stdio: "ignore",
        shell: true,
      }).unref();
      return true;
    } catch {
      return false;
    }
  },
  timestampFile: timestampPath,
  now: Date.now,
};

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => runAutoUpdate(event, ctx, defaultDeps));
}
