import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildRetryWaitLine } from "./format";

describe("buildRetryWaitLine", () => {
  it("includes the provider and formats ceil'ed seconds and attempt", () => {
    assert.equal(
      buildRetryWaitLine({ provider: "catalog-provider", attempt: 2, waitMs: 29_001 }),
      "catalog-provider concurrency limit — retrying in 30s (attempt 2)",
    );
    assert.equal(
      buildRetryWaitLine({ provider: "commandcode", attempt: 1, waitMs: 5_000 }),
      "commandcode concurrency limit — retrying in 5s (attempt 1)",
    );
  });
});
