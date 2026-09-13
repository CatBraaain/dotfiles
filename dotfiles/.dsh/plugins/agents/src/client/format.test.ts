import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { agentStateLines, parseDisplayState } from "./format";

describe("agentStateLines", () => {
  it("renders the agent and class lines", () => {
    assert.deepEqual(
      agentStateLines({ managed: true, agent: "main", className: "middle", manual: false }),
      ["🤖 agent: main", "💎 class: middle"],
    );
  });

  it("appends (manual) while a manual /model pick suspends routing", () => {
    assert.deepEqual(
      agentStateLines({ managed: true, agent: "chat", className: "low", manual: true }),
      ["🤖 agent: chat", "💎 class: low (manual)"],
    );
  });

  it("renders only the agent line without a class", () => {
    assert.deepEqual(agentStateLines({ managed: true, agent: "main" }), ["🤖 agent: main"]);
  });

  it("renders nothing for an unmanaged session", () => {
    assert.deepEqual(agentStateLines({ managed: false }), []);
    assert.deepEqual(agentStateLines({ managed: true }), []);
  });
});

describe("parseDisplayState", () => {
  it("keeps a managed payload with its fields", () => {
    assert.deepEqual(
      parseDisplayState({ managed: true, agent: "main", className: "middle", manual: false }),
      { managed: true, agent: "main", className: "middle" },
    );
  });

  it("carries the manual flag only when true", () => {
    assert.deepEqual(
      parseDisplayState({ managed: true, agent: "chat", className: "low", manual: true }),
      { managed: true, agent: "chat", className: "low", manual: true },
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
