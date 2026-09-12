import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { defaultEffortOf, withDefaultEffort } from "./default-effort.ts";

describe("defaultEffortOf", () => {
  it("picks max when advertised", () => {
    assert.equal(defaultEffortOf(["off", "high", "max"]), "max");
  });

  it("falls back to the highest advertised level below max", () => {
    assert.equal(defaultEffortOf(["off", "low", "high"]), "high");
    assert.equal(defaultEffortOf(["off", "xhigh"]), "xhigh");
    assert.equal(defaultEffortOf(["off", "minimal"]), "minimal");
  });

  it("returns undefined when only off is advertised (non-reasoning model)", () => {
    assert.equal(defaultEffortOf(["off"]), undefined);
  });

  it("returns undefined when nothing is advertised", () => {
    assert.equal(defaultEffortOf([]), undefined);
  });

  it("does not depend on input order", () => {
    assert.equal(defaultEffortOf(["max", "off", "high"]), "max");
    assert.equal(defaultEffortOf(["high", "max", "off"]), "max");
  });
});

describe("withDefaultEffort", () => {
  it("stamps the default effort onto the base config through toEffort", () => {
    const base = { provider: "zai", model: "glm-5.3" };
    assert.deepEqual(
      withDefaultEffort(base, ["off", "low", "high", "max"], (level) => `E:${level}`),
      { provider: "zai", model: "glm-5.3", reasoningEffort: "E:max" },
    );
  });

  it("keeps the base config when the model advertises only off", () => {
    const base = { provider: "zai", model: "glm-4.7" };
    assert.deepEqual(withDefaultEffort(base, ["off"], (level) => level), base);
  });

  it("keeps the base config when nothing is advertised (catalog unresolved)", () => {
    const base = { provider: "zai", model: "glm-5.3" };
    assert.deepEqual(withDefaultEffort(base, [], (level) => level), base);
  });

  it("keeps an explicit selection untouched (no fallback applies)", () => {
    assert.deepEqual(
      withDefaultEffort({ reasoningEffort: "low" }, ["off", "high", "max"], (level) => `E:${level}`),
      { reasoningEffort: "low" },
    );
  });
});
