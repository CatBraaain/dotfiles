import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { assertZaiPayload, codexAccountId, fetchQuota, parseCodexGrant } from "./index";

/** A context with no services at all: no credentials, no settings. */
const emptyCtx = { get: () => undefined };

const ZAI_ENV_REFS = ["ZAI_API_KEY", "ZAI_CODING_API_KEY", "ZAI_CODING_CN_API_KEY"];

/** A JWT-shaped access token carrying the ChatGPT account id claim. */
function codexAccessToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

describe("fetchQuota", () => {
  it("fails loud naming every provider reason when no credential resolves", async () => {
    const saved = ZAI_ENV_REFS.map((ref) => [ref, process.env[ref]] as const);
    for (const [ref] of saved) delete process.env[ref];
    try {
      await assert.rejects(
        () => fetchQuota(emptyCtx, true),
        (error: Error) => {
          assert.match(error.message, /zai credential not found/);
          assert.match(error.message, /no codex credential grant/);
          return true;
        },
      );
    } finally {
      for (const [ref, value] of saved) {
        if (value !== undefined) process.env[ref] = value;
      }
    }
  });
});

describe("assertZaiPayload", () => {
  it("accepts a success body and rejects HTTP-200 error bodies (auth failure, rate limit)", () => {
    assert.doesNotThrow(() => assertZaiPayload({ code: 200, success: true, data: {} }));
    assert.throws(
      () => assertZaiPayload({ code: 401, msg: "invalid token", success: false }),
      /401\): invalid token/,
    );
    assert.throws(
      () => assertZaiPayload({ code: 429, msg: "Too Many Requests", success: false }),
      /429\): Too Many Requests/,
    );
    assert.throws(() => assertZaiPayload("nope"), /unexpected body/);
  });
});

describe("parseCodexGrant", () => {
  it("round-trips the exact shape the rotate writes back into the store payload", () => {
    const grant = {
      type: "oauth" as const,
      access: codexAccessToken("acc-1"),
      refresh: "r-1",
      expires: Date.now() + 60_000,
      accountId: "acc-1",
    };
    const stored = parseCodexGrant(grant);
    assert.deepEqual(stored, grant);
  });

  it("accepts a stored grant without accountId by deriving it from the access token JWT claim", () => {
    const stored = parseCodexGrant({
      type: "oauth",
      access: codexAccessToken("acc-2"),
      refresh: "r-2",
      expires: 1,
    });
    assert.equal(stored?.accountId, "acc-2");
  });

  it("rejects payloads missing the oauth type, tokens, or expiry", () => {
    assert.equal(parseCodexGrant({ type: "api-key", access: "a", refresh: "r", expires: 1 }), null);
    assert.equal(parseCodexGrant({ type: "oauth", refresh: "r", expires: 1 }), null);
    assert.equal(parseCodexGrant({ type: "oauth", access: "a", refresh: "r" }), null);
    assert.equal(parseCodexGrant(null), null);
  });
});

describe("codexAccountId", () => {
  it("reads the account id from the auth claim and returns null for opaque tokens", () => {
    assert.equal(codexAccountId(codexAccessToken("acc-3")), "acc-3");
    assert.equal(codexAccountId("not-a-jwt"), null);
  });
});
