import { createHash } from "node:crypto";
import { readlinkSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import type { TmuxConfig } from "./configuration";
import { platform } from "./platform";
import { POLL_INTERVAL_MS, STARTUP_TIMEOUT_MS } from "./session-model";
import { windowsManagement } from "./tmux";
import type { WindowsManagement } from "./windows-management";

export class LockBusyError extends Error {}

export type ReleaseLock = () => Promise<void>;

export function lockAddress(config: TmuxConfig, scope = ""): string {
  const key = createHash("sha256")
    .update(realpathSync(config.stateDirectory))
    .update(scope)
    .digest("hex");
  return platform.lockAddress(key);
}

export async function tryAcquireLock(address: string): Promise<ReleaseLock | undefined> {
  const lock = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once("error", reject);
      lock.listen(address, resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return;
    throw error;
  }
  return () =>
    new Promise<void>((resolve, reject) => {
      lock.close((error) => (error ? reject(error) : resolve()));
    });
}

function canonicalSocketPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const parent = dirname(path);
  let link: string;
  try {
    link = readlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    return join(canonicalSocketPath(parent), basename(path));
  }
  return canonicalSocketPath(resolve(canonicalSocketPath(parent), link));
}

export async function withLock<T>(
  config: TmuxConfig,
  action: () => Promise<T>,
  mode: "wait" | "try" = "wait",
): Promise<T> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  if (platform.windows) {
    const statePath = canonicalSocketPath(config.stateDirectory).toLowerCase();
    return await withLockKey(windowsManagement(config).lockResource, deadline, mode, () =>
      withLockKey(statePath, deadline, mode, action),
    );
  }
  const statePath = realpathSync(config.stateDirectory);
  const socketPath = canonicalSocketPath(config.socket);
  return await withLockKey(`socket:${socketPath}`, deadline, mode, () =>
    withLockKey(statePath, deadline, mode, action),
  );
}

async function withLockKey<T>(
  resource: string,
  deadline: number,
  mode: "wait" | "try",
  action: () => Promise<T>,
): Promise<T> {
  const key = createHash("sha256").update(resource).digest("hex");
  const address = platform.lockAddress(key);
  while (Date.now() < deadline) {
    const release = await tryAcquireLock(address);
    if (!release) {
      if (mode === "try") throw new LockBusyError("Another pi-mux operation holds the lock");
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    try {
      return await action();
    } finally {
      await release();
    }
  }
  throw new Error("Timed out waiting for another pi-mux operation");
}

export function windowsClaimLock(management: WindowsManagement) {
  return <T>(action: () => Promise<T>) =>
    withLockKey(management.claimLockResource, Date.now() + STARTUP_TIMEOUT_MS, "wait", action);
}
