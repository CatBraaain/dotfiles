import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { errorMessage, redactSecrets, redactUsageError, sanitizeDisplayText } from "./util";

describe("sanitizeDisplayText", () => {
  const cases = [
    ["BEL-terminated OSC", "\u001b]0;title\u0007tail", "tail"],
    ["ST-terminated OSC", "\u001b]0;title\u001b\\tail", "tail"],
    ["C1 OSC", "\u009dtitle\u009ctail", "tail"],
    ["unterminated OSC", "head\u001b]title", "head"],
    ["CSI color", "\u001b[31mred\u001b[0m", "red"],
    ["control whitespace", "a\nb\tc\u0000", "a b c"],
    ["unicode", "quota 🎉", "quota 🎉"],
  ];
  for (const [name, input, expected] of cases) {
    it(`removes ${name} without stalling`, () => {
      assert.equal(sanitizeDisplayText(input!), expected);
    });
  }
});

describe("secret redaction", () => {
  it("redacts long error secrets before truncating", () => {
    const secret = "credential-prefix-" + "x".repeat(900);
    const output = errorMessage(new Error(secret), [secret]);
    assert.equal(output, "<redacted>");
  });

  it("redacts string exceptions before truncating", () => {
    const secret = "credential-prefix-" + "y".repeat(900);
    assert.equal(errorMessage(secret, [secret]), "<redacted>");
  });

  it("redacts overlapping secrets longest first", () => {
    assert.equal(
      redactSecrets("Bearer key-value", ["key", "key-value", "Bearer key-value"]),
      "<redacted>",
    );
  });

  it("treats regex metacharacters as literal secrets", () => {
    assert.equal(redactSecrets("a.*[x] a", ["a.*[x]"]), "<redacted> a");
  });

  it("removes bearer credentials without a known secret list", () => {
    assert.equal(redactUsageError("failed: Bearer abc.123"), "failed: Bearer <redacted>");
  });
});
