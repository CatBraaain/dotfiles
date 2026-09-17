import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  buildSerpUrl,
  detectChallengePage,
  parseRedditPostUrl,
  parseRenderedPage,
  tryBackends,
} from "./web-search";

describe("web-search shared logic", () => {
  it("normalizes Reddit post URLs", () => {
    const post = parseRedditPostUrl("https://old.reddit.com/r/typescript/comments/abc123/title/");
    assert.equal(post?.permalink, "https://www.reddit.com/r/typescript/comments/abc123/title/");
  });

  it("detects challenge pages and rejects rendered challenge output", () => {
    assert.ok(detectChallengePage('<form id="captcha-form"></form>'));
    assert.throws(
      () => parseRenderedPage(`### Result\n${JSON.stringify({ mode: "challenge", html: "<html>" })}`),
      /challenge detected/,
    );
  });

  it("retries only the matching backend and preserves attempt order", async () => {
    let calls = 0;
    const result = await tryBackends(
      "web search",
      [
        [
          "first",
          async () => {
            calls += 1;
            if (calls === 1) throw new Error("retry");
            return "result";
          },
        ],
      ],
      (value) => !value,
      (error) => error instanceof Error && error.message === "retry",
    );
    assert.equal(result.payload, "result");
    assert.deepEqual(result.attempts.map(({ durationMs: _durationMs, ...attempt }) => attempt), [
      { backend: "first", ok: false, error: "retry" },
      { backend: "first", ok: true },
    ]);
  });

  it("builds a SERP URL with adapter-provided parameters", () => {
    assert.equal(
      buildSerpUrl("google", "hello world", { hl: "ja", gl: "jp" }),
      "https://www.google.com/search?q=hello+world&hl=ja&gl=jp",
    );
  });
});
