import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { UsageState } from "./score";

export const CACHE_TTL_MS = 5 * 60_000;

export interface UsageSnapshot {
  fetchedAt: number;
  states: Map<string, UsageState>;
}

export function cacheFilePath(
  env: { XDG_CACHE_HOME?: string; HOME?: string } = {
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    HOME: process.env.HOME,
  },
): string {
  const base =
    env.XDG_CACHE_HOME && env.XDG_CACHE_HOME !== "" ? env.XDG_CACHE_HOME : joinHomeCache(env.HOME);
  return `${base}/model-route/usage.json`;
}

function joinHomeCache(home: string | undefined): string {
  return `${home && home !== "" ? home : homedir()}/.cache`;
}

export function loadSnapshot(path: string, now: number): UsageSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 2) return null;
    const { fetchedAt, entries } = record;
    if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) return null;
    if (now < fetchedAt || now - fetchedAt > CACHE_TTL_MS) return null;
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return null;

    const states = new Map<string, UsageState>();
    for (const [provider, entry] of Object.entries(entries)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const { remaining, resetsAt, windowMinutes } = entry as Record<string, unknown>;
      if (
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 100
      )
        continue;
      if (typeof resetsAt !== "string" || !Number.isFinite(Date.parse(resetsAt))) continue;
      states.set(provider, {
        remaining,
        resetsAt,
        windowMinutes:
          typeof windowMinutes === "number" && Number.isFinite(windowMinutes) && windowMinutes > 0
            ? windowMinutes
            : null,
      });
    }
    return { fetchedAt, states };
  } catch {
    return null;
  }
}

export function saveSnapshot(path: string, snapshot: UsageSnapshot): void {
  const file = {
    version: 2,
    fetchedAt: snapshot.fetchedAt,
    entries: Object.fromEntries(snapshot.states),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmpPath, path);
}
