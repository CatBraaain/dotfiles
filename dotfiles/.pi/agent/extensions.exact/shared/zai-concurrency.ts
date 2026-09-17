// Z.AI coding-plan concurrency errors (business codes 1302/1305).
//
// Z.AI reports a concurrency rejection as HTTP 429 whose JSON body carries a
// business error code:
//   1302  "Rate limit reached for requests"
//   1305  "The service may be temporarily overloaded, please try again later"
// pi-ai surfaces that body text (sometimes as raw JSON) in the final assistant
// errorMessage, so detection is a wording match on that string.
//
// Used by the agents extension, which must NOT route these errors into its
// model-fallback/cooldown path — Z.AI concurrency is account-wide, so switching
// models cannot help. The wait-and-retry loop lives in the concurrency-retry
// extension; its provider-generic detection mirrors the dsh concurrency-retry
// plugin instead of this Z.AI-specific matcher.

export const ZAI_PROVIDER_IDS = ["zai", "zai-coding-cn"] as const;

const CONCURRENCY_ERROR_PATTERNS = [
  // Raw JSON body, e.g. {"error":{"code":"1302","message":"Rate limit reached for requests"}}
  /code"\s*:\s*"130[25]"/,
  // Message-only forms (openai SDK APIError text).
  /rate limit reached for requests/i,
  /temporarily overloaded/i,
];

export function isZaiProvider(provider: string | undefined): boolean {
  return provider !== undefined && (ZAI_PROVIDER_IDS as readonly string[]).includes(provider);
}

// Quota codes (1113, 1308-1321) are deliberately NOT matched: they recover only
// at a reset time, so they must keep flowing into the regular rate-limit
// fallback instead of an unbounded retry loop.
export function isZaiConcurrencyLimited(errorMessage: string | undefined): boolean {
  return (
    errorMessage !== undefined &&
    CONCURRENCY_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
  );
}
