import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildRetryWaitLine } from "./format";

describe("buildRetryWaitLine", () => {
  it("formats ceil'ed seconds and the attempt count on one line", () => {
    assert.equal(
      buildRetryWaitLine({ provider: "zai", attempt: 2, waitMs: 29_001 }),
      "zai concurrency limit — retrying in 30s (attempt 2)",
    );
    assert.equal(
      buildRetryWaitLine({ provider: "zai", attempt: 1, waitMs: 5_000 }),
      "zai concurrency limit — retrying in 5s (attempt 1)",
    );
    assert.equal(
      buildRetryWaitLine({ provider: "zai-coding-cn", attempt: 4, waitMs: 1 }),
      "zai concurrency limit — retrying in 1s (attempt 4)",
    );
  });
});
