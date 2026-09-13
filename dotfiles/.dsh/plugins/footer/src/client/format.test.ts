import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { formatSessionLabel } from "./format";

describe("formatSessionLabel", () => {
  it("formats a normal session id as `session: <id>`", () => {
    assert.equal(formatSessionLabel("abc-123"), "session: abc-123");
  });

  it("returns `session: ` without throwing for an empty session id", () => {
    assert.equal(formatSessionLabel(""), "session: ");
  });
});
