// routing — tier-based model routing core (candidate selection, cooldown,
// Retry-After, manual-select tracking). Ported from the former model-router
// extension. Every routing decision lives in these dependency-injected pure
// functions so tests need neither the pi runtime nor bash.

import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface ModelCandidate {
  provider: string;
  model: string;
  when?: string;
}

export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
export const WHEN_TIMEOUT_MS = 5_000;

const RATE_LIMIT_ERROR_PATTERNS = [
  /\b429\b/,
  /code"\s*:\s*"1310"/,
  /Weekly Limit Exhausted/,
  /Monthly Limit Exhausted/,
];

export function isRateLimitedError(errorMessage: string | undefined): boolean {
  return (
    errorMessage !== undefined &&
    RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
  );
}

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

// Parse Retry-After: integer seconds ("120") or HTTP-date. Returns ms duration or null.
export function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : Math.max(0, ms - Date.now());
}

// True if `key` is still cooling down at `now`. Lazily evicts expired entries
// so a stale cooldown never silently blocks a model forever.
export function isCoolingDown(key: string, cooldowns: Map<string, number>, now: number): boolean {
  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now >= expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

// Put `key` in the rate-limit doghouse until now + ms.
export function recordCooldown(
  cooldowns: Map<string, number>,
  key: string,
  ms: number,
  now: number,
): void {
  cooldowns.set(key, now + ms);
}

// The first candidate (top-to-bottom) whose model exists in the registry, is
// not cooling down, and whose `when` passes. find + evalWhen + now are
// injected so this needs neither pi nor bash to test.
export async function pickCandidate<M extends { provider: string; id: string }>(
  candidates: readonly ModelCandidate[],
  cooldowns: Map<string, number>,
  find: (provider: string, id: string) => M | undefined,
  evalWhen: (when: string | undefined) => Promise<boolean>,
  now: number,
): Promise<M | null> {
  for (const candidate of candidates) {
    const model = find(candidate.provider, candidate.model);
    if (!model) continue;
    if (isCoolingDown(modelKey(model), cooldowns, now)) continue;
    if (!(await evalWhen(candidate.when))) continue;
    return model;
  }
  return null;
}

// `when` コマンドの実行器。bashExecFrom(createLocalBashOperations()) が pi の
// local shell backend（pi.exec の実体）に繋いだ本物の実装で、テストも同じ道を通る。
export interface WhenExec {
  (
    command: string,
    opts: { timeout?: number; signal?: AbortSignal },
  ): Promise<{
    exitCode: number | null;
  }>;
}

// pi の BashOperations を WhenExec に適合させる。onData は破棄、cwd は固定
// （when コマンドは cwd 非依存のものだけ使う前提）。
export function bashExecFrom(ops: BashOperations, cwd = process.cwd()): WhenExec {
  return (command, opts) =>
    ops.exec(command, cwd, {
      onData: () => {},
      timeout: opts.timeout,
      signal: opts.signal,
    });
}

// `when` runs through pi's local shell. Omitted/blank -> always true; exit 0
// -> true; any non-zero exit, timeout, or failure -> false.
export async function evalWhen(
  when: string | undefined,
  exec: WhenExec,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!when || when.trim() === "") return true;
  try {
    const { exitCode } = await exec(when, { timeout: timeoutMs, signal });
    return exitCode === 0;
  } catch {
    return false;
  }
}

// A model_select event suspends auto-routing only when it is a genuine user
// pick — not our own setModel in flight (switching), nor a session restore.
export function isManualSelect(source: string | undefined, switching: boolean): boolean {
  return !switching && (source === "set" || source === "cycle");
}
