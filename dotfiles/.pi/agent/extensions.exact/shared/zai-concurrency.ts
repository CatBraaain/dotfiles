// Z.AI coding-plan concurrency errors (business codes 1302/1305).
//
// Z.AI reports a concurrency rejection as HTTP 429 whose JSON body carries a
// business error code:
//   1302  "Rate limit reached for requests"
//   1305  "The service may be temporarily overloaded, please try again later"
// pi-ai surfaces that body text (sometimes as raw JSON) in the final assistant
// errorMessage, so detection is a wording match on that string.
//
// Single source of the Z.AI concurrency knowledge (provider IDs, business
// codes, code-field extraction, wording patterns) for two consumers: the
// agents extension skips its model-fallback/cooldown path for these errors
// (Z.AI concurrency is account-wide, so switching models cannot help), and
// the provider-error-retry extension builds its fail-closed detector on the
// same evidence.

export const ZAI_PROVIDER_IDS = ["zai", "zai-coding-cn"] as const;

export const ZAI_CONCURRENCY_CODES: ReadonlySet<string> = new Set(["1302", "1305"]);

const ZAI_MESSAGE_PATTERNS = [
  /rate limit reached for requests/i,
  /temporarily overloaded/i,
] as const;

export function isZaiProvider(provider: string | undefined): boolean {
  return provider !== undefined && (ZAI_PROVIDER_IDS as readonly string[]).includes(provider);
}

// Extracts the value of a "code" field from a raw JSON body embedded in the
// error text, e.g. {"error":{"code":"1302","message":"..."}}.
const CODE_FIELD_PATTERN = /["']code["']\s*:\s*["']?([^"'\s,}]+)["']?/gi;

export function extractErrorCodes(errorMessage: string): Set<string> {
  const codes = new Set<string>();
  for (const match of errorMessage.matchAll(CODE_FIELD_PATTERN)) {
    if (match[1] !== undefined) codes.add(match[1]);
  }
  return codes;
}

export function isZaiConcurrencyEvidence(codes: Set<string>, errorMessage: string): boolean {
  if ([...codes].some((code) => ZAI_CONCURRENCY_CODES.has(code))) return true;
  return ZAI_MESSAGE_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export function isZaiConcurrencyLimited(errorMessage: string | undefined): boolean {
  if (errorMessage === undefined || errorMessage === "") return false;
  return isZaiConcurrencyEvidence(extractErrorCodes(errorMessage), errorMessage);
}
