// routing — class-based model routing core (candidate selection, cooldown,
// Retry-After, manual-select tracking). Ported from the former model-router
// extension. Every routing decision lives in these dependency-injected pure
// functions so tests need neither the pi runtime nor bash.

import { type CronSchedule } from "./cron.ts";

export interface NamespaceUrgencyMultiply {
  readonly provider: string;
}

export interface SettingsRule {
  readonly cron?: CronSchedule;
  readonly multiply: number | NamespaceUrgencyMultiply;
}

export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
  readonly weight?: number;
  readonly settings?: readonly SettingsRule[];
}

export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

// Errors treated as rate/usage limits. The HTTP 429 path in after_provider_response
// is provider-independent (raw status code), so these text patterns only matter for
// in-band stream errors that never surface a status: pi-ai normalizes every
// provider error to the errorMessage string, so each provider family needs its
// wording here. Mirrors pi-ai's own classification (utils/retry.js) plus
// provider-specific codes; transient server failures (5xx, "overloaded",
// "service unavailable") are intentionally excluded — pi core retries those.
const RATE_LIMIT_ERROR_PATTERNS = [
  // HTTP status codes echoed into the normalized message text.
  /\b429\b/,
  /\b402\b/,
  // Z.AI coding-plan: usage quota exhausted (1310) / account arrears (1113).
  /code"\s*:\s*"(1310|1113)"/,
  // OpenCode Zen subscription limits and Go / free-tier error types.
  /Weekly Limit Exhausted/i,
  /Monthly Limit Exhausted/i,
  /GoUsageLimitError/i,
  /FreeUsageLimitError/i,
  /available.?balance/i,
  // Codex / ChatGPT plan: in-band stream error ("Codex error: The usage limit
  // has been reached"), the friendly HTTP 429 message ("You have hit your
  // ChatGPT usage limit ..."), and the raw usage_limit_reached body code.
  /usage.?limit/i,
  // OpenAI and generic quota / billing exhaustion (also gateways wrapping them).
  /insufficient_quota/i,
  /quota exceeded/i,
  /out of budget/i,
  /billing/i,
  /insufficient.?balance/i,
  /insufficient.?credits?/i,
  // Generic throttle wording: Anthropic rate_limit_error, OpenAI "Rate limit
  // reached", gateways "ratelimit", etc.
  /rate.?limit/i,
  /too many requests/i,
  // Google (gRPC status) and AWS Bedrock throttling.
  /RESOURCE_EXHAUSTED/i,
  /throttl/i,
];

export function isRateLimitedError(errorMessage: string | undefined): boolean {
  return (
    errorMessage !== undefined &&
    RATE_LIMIT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
  );
}

export function misattributedHttp429ModelKey(
  errorMessage: string | undefined,
  messageModelKey: string,
  http429ModelKeys: ReadonlySet<string>,
): string | null {
  if (
    !errorMessage ||
    !isRateLimitedError(errorMessage) ||
    http429ModelKeys.has(messageModelKey) ||
    http429ModelKeys.size === 0
  ) {
    return null;
  }

  const matchingKeys = [...http429ModelKeys].filter((key) => {
    const provider = key.split("/", 1)[0];
    if (provider === "amazon-bedrock") {
      return /throttling error|too many tokens per day|throttlingexception/i.test(errorMessage);
    }
    if (provider === "zai" || provider === "z-ai") {
      return /code"\s*:\s*"(1310|1113)"/.test(errorMessage);
    }
    return false;
  });
  return matchingKeys.length === 1 ? matchingKeys[0]! : null;
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

export const LATEST_TOKEN = "<LATEST>";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compare "."-separated numeric version strings segment by segment. When all
// common segments are equal, the string with more segments is greater.
export function compareVersionStrings(left: string, right: string): number {
  const leftSegments = left.split(".").map(Number);
  const rightSegments = right.split(".").map(Number);
  const commonLength = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < commonLength; index++) {
    const difference = leftSegments[index]! - rightSegments[index]!;
    if (difference !== 0) return difference;
  }
  return leftSegments.length - rightSegments.length;
}

// Resolve a model template containing <LATEST> against concrete registry
// ids. The token becomes (\d+(?:\.\d+)*), the pattern must match a whole
// id, and the id with the greatest captured version wins. Returns null when
// nothing matches, leaving the candidate unavailable for this resolution.
export function resolveLatestModel(template: string, modelIds: readonly string[]): string | null {
  const pattern = new RegExp(
    `^${escapeRegExp(template).replaceAll(LATEST_TOKEN, "(\\d+(?:\\.\\d+)*)")}$`,
  );
  let best: { id: string; version: string } | null = null;
  for (const id of modelIds) {
    const match = pattern.exec(id);
    if (match === null) continue;
    const version = match[1] ?? "";
    if (best === null || compareVersionStrings(version, best.version) > 0) {
      best = { id, version };
    }
  }
  return best?.id ?? null;
}

// Resolve <LATEST> templates once per routing resolution. Candidates whose
// token matches no registry model are dropped for this resolution and
// retried on the next one.
export function resolveCandidates(
  candidates: readonly ModelCandidate[],
  listChatModelIds: (provider: string) => readonly string[],
): ModelCandidate[] {
  const resolved: ModelCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.model.includes(LATEST_TOKEN)) {
      resolved.push(candidate);
      continue;
    }
    const model = resolveLatestModel(candidate.model, listChatModelIds(candidate.provider));
    if (model === null) continue;
    resolved.push({ ...candidate, model });
  }
  return resolved;
}

export async function pickCandidates<M extends { provider: string; id: string }>(
  candidates: readonly ModelCandidate[],
  cooldowns: Map<string, number>,
  find: (provider: string, id: string) => M | undefined,
  now: number,
  sortByScore?: (
    candidates: readonly ModelCandidate[],
  ) => Promise<readonly ModelCandidate[] | null>,
): Promise<M[]> {
  const evaluated = await Promise.all(
    candidates.map(async (candidate) => {
      const model = find(candidate.provider, candidate.model);
      if (!model) return null;
      if (isCoolingDown(modelKey(model), cooldowns, now)) return null;
      return candidate;
    }),
  );
  const survivors = evaluated.filter(
    (candidate): candidate is ModelCandidate => candidate !== null,
  );
  const ordered =
    survivors.length > 1 && sortByScore ? ((await sortByScore(survivors)) ?? survivors) : survivors;
  return ordered
    .map((candidate) => find(candidate.provider, candidate.model))
    .filter((model): model is M => model !== undefined);
}

// pi-ai models declare their input modalities as ("text" | "image")[]. A
// model supports image input exactly when "image" is present.
export { modelSupportsImages } from "../shared/image-input.ts";

// A model_select event suspends auto-routing only when it is a genuine user
// pick — not our own setModel in flight (switching), nor a session restore.
export function isManualSelect(source: string | undefined, switching: boolean): boolean {
  return !switching && (source === "set" || source === "cycle");
}
