import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildSkillStatusLine } from "./format";

describe("buildSkillStatusLine", () => {
  it("renders one line with names joined in order", () => {
    assert.equal(buildSkillStatusLine(["review", "converge"]), "🎯 skills: review, converge");
  });

  it("renders the bare label with no used skill", () => {
    assert.equal(buildSkillStatusLine([]), "🎯 skills: ");
  });
});
