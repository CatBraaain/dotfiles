export interface UsageState {
  remaining: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
}

const MINUTE_MS = 60_000;
const MIN_REMAINING_MINUTES = 60;

export function urgencyOf(usage: UsageState | undefined, now: number): number | null {
  if (usage === undefined) return null;
  const resetsAtMs = usage.resetsAt === null ? NaN : Date.parse(usage.resetsAt);
  const { remaining, windowMinutes } = usage;
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now || !Number.isFinite(now)) return null;
  if (windowMinutes === null || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  if (remaining === null || !Number.isFinite(remaining) || remaining < 0 || remaining > 100)
    return null;
  const remainingMinutes = Math.max((resetsAtMs - now) / MINUTE_MS, MIN_REMAINING_MINUTES);
  return ((remaining / 100) * windowMinutes) / remainingMinutes;
}
