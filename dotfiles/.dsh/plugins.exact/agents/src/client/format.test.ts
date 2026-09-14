import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { agentLineLabel, classLineLabel, parseDisplayState } from "./format";

describe("agentLineLabel", () => {
  it("renders the agent row label", () => {
    assert.equal(
      agentLineLabel({ managed: true, agent: "main", className: "middle", manual: false }),
      "🤖 agent: main",
    );
  });

  it("renders without a class", () => {
    assert.equal(agentLineLabel({ managed: true, agent: "main" }), "🤖 agent: main");
  });

  it("renders nothing for an unmanaged session", () => {
    assert.equal(agentLineLabel({ managed: false }), undefined);
    assert.equal(agentLineLabel({ managed: true }), undefined);
  });
});

describe("classLineLabel", () => {
  it("renders the auto mode with the resolved model", () => {
    assert.equal(
      classLineLabel({
        managed: true,
        agent: "main",
        className: "middle",
        manual: false,
        model: "glm-5.3-flash",
      }),
      "💎 class: middle (auto:glm-5.3-flash)",
    );
  });

  it("renders the manual mode with the resolved model", () => {
    assert.equal(
      classLineLabel({
        managed: true,
        agent: "chat",
        className: "low",
        manual: true,
        model: "glm-5.3",
      }),
      "💎 class: low (manual:glm-5.3)",
    );
  });

  it("omits the model before the first route resolution", () => {
    assert.equal(
      classLineLabel({ managed: true, agent: "main", className: "high", manual: false }),
      "💎 class: high (auto)",
    );
    assert.equal(
      classLineLabel({ managed: true, agent: "main", className: "high", manual: true }),
      "💎 class: high (manual)",
    );
  });

  it("renders nothing without a class or for an unmanaged session", () => {
    assert.equal(classLineLabel({ managed: true, agent: "main" }), undefined);
    assert.equal(classLineLabel({ managed: false }), undefined);
  });
});

describe("parseDisplayState", () => {
  it("keeps a managed payload with its fields", () => {
    assert.deepEqual(
      parseDisplayState({
        managed: true,
        agent: "main",
        className: "middle",
        manual: false,
        model: "glm-5.3-flash",
        agents: ["main", "senior"],
        classes: ["high", "middle"],
      }),
      {
        managed: true,
        agent: "main",
        className: "middle",
        model: "glm-5.3-flash",
        agents: ["main", "senior"],
        classes: ["high", "middle"],
      },
    );
  });

  it("carries the manual flag only when true", () => {
    assert.deepEqual(
      parseDisplayState({ managed: true, agent: "chat", className: "low", manual: true }),
      { managed: true, agent: "chat", className: "low", manual: true },
    );
  });

  it("drops non-string menu vocabularies instead of failing", () => {
    assert.deepEqual(
      parseDisplayState({
        managed: true,
        agent: "main",
        agents: ["senior", 7],
        classes: "high",
      }),
      { managed: true, agent: "main" },
    );
  });

  it("degrades malformed values to unmanaged", () => {
    assert.deepEqual(parseDisplayState(null), { managed: false });
    assert.deepEqual(parseDisplayState("s-main"), { managed: false });
    assert.deepEqual(parseDisplayState({ managed: false }), { managed: false });
    assert.deepEqual(parseDisplayState({ managed: true }), { managed: false });
    assert.deepEqual(parseDisplayState({ managed: true, agent: "" }), { managed: false });
  });
});
