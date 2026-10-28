export interface CandidateInput {
  provider: string;
  model: string;
}

export interface UsageState {
  remaining: number;
  resetsAt: string;
  windowMinutes: number | null;
}

export interface CandidateResult {
  provider: string;
  model: string;
  urgency: number | null;
  usageState: (UsageState & { source: "cache" | "fresh" }) | null;
}

const MINUTE_MS = 60_000;
const MIN_REMAINING_MINUTES = 60;

export function isCandidateInput(value: unknown): value is CandidateInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.provider === "string" &&
    record.provider !== "" &&
    typeof record.model === "string" &&
    record.model !== ""
  );
}

export function urgencyOf(usage: UsageState | undefined, now: number): number | null {
  if (usage === undefined) return null;
  const resetsAtMs = Date.parse(usage.resetsAt);
  const { remaining, windowMinutes } = usage;
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now || !Number.isFinite(now)) return null;
  if (windowMinutes === null || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) return null;
  const remainingMinutes = Math.max((resetsAtMs - now) / MINUTE_MS, MIN_REMAINING_MINUTES);
  return ((remaining / 100) * windowMinutes) / remainingMinutes;
}
