import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  buildStatePayload,
  isDisplayedAgent,
  isRootSessionHeader,
  mergePendingSelection,
  parseSelectRequest,
  parseStateRequest,
  resolveStartSelection,
  type ManagedStateEntry,
} from "./state-rpc.ts";

const entries: readonly ManagedStateEntry[] = [
  {
    sessionId: "s-main",
    agentName: "main",
    effectiveClass: "middle",
    manualSelect: false,
    model: "glm-5.3-flash",
  },
  {
    sessionId: "s-chat",
    agentName: "chat",
    effectiveClass: "low",
    manualSelect: true,
  },
];

describe("parseStateRequest", () => {
  it("accepts a payload with a session id", () => {
    assert.deepEqual(parseStateRequest({ sessionId: "s-main" }), { sessionId: "s-main" });
  });

  it("accepts a payload without a session id", () => {
    assert.deepEqual(parseStateRequest({}), { sessionId: undefined });
  });

  it("rejects non-object payloads and non-string session ids", () => {
    assert.equal(parseStateRequest(null), undefined);
    assert.equal(parseStateRequest("s-main"), undefined);
    assert.equal(parseStateRequest({ sessionId: 7 }), undefined);
  });
});

describe("isDisplayedAgent", () => {
  it("displays root agents", () => {
    assert.equal(isDisplayedAgent({ session: { header: { origin: "user" } } }), true);
  });

  it("never displays one-shot children, while running or disposed", () => {
    assert.equal(isDisplayedAgent({ session: { header: { origin: "subagent" } } }), false);
  });

  it("displays agents whose session header carries no origin", () => {
    assert.equal(isDisplayedAgent({ session: { header: {} } }), true);
  });
});

describe("isRootSessionHeader", () => {
  it("accepts a header with no origin and no delegation depth", () => {
    assert.equal(isRootSessionHeader({}), true);
  });

  it("accepts an explicit top-level depth of zero", () => {
    assert.equal(isRootSessionHeader({ delegationDepth: 0 }), true);
  });

  it("rejects a subagent-origin header", () => {
    assert.equal(isRootSessionHeader({ origin: "subagent" }), false);
  });

  it("rejects a delegated header even without the origin tag", () => {
    assert.equal(isRootSessionHeader({ delegationDepth: 1 }), false);
  });
});

describe("buildStatePayload", () => {
  const rootIds = new Set(["s-idle", "s-main", "s-chat"]);
  const choices = { agents: ["main", "senior", "junior"], classes: ["high", "middle", "low"] };
  const idle = { agent: "main", className: "high", model: "glm-4.7" };
  const payload = (sessionId: string | undefined, idleDisplay: typeof idle | undefined = idle) =>
    buildStatePayload(entries, rootIds, choices, sessionId, idleDisplay);

  it("returns the managed display state with the display model and menu vocabularies", () => {
    assert.deepEqual(payload("s-main"), {
      managed: true,
      agent: "main",
      className: "middle",
      manual: false,
      model: "glm-5.3-flash",
      agents: ["main", "senior", "junior"],
      classes: ["high", "middle", "low"],
    });
  });

  it("omits the model when the display has none (manual before its first request)", () => {
    assert.equal("model" in payload("s-chat"), false);
  });

  it("carries the manual flag through", () => {
    assert.deepEqual(payload("s-chat"), {
      managed: true,
      agent: "chat",
      className: "low",
      manual: true,
      agents: ["main", "senior", "junior"],
      classes: ["high", "middle", "low"],
    });
  });

  it("shows the caller-resolved idle display (with model) for an idle top-level session", () => {
    assert.deepEqual(payload("s-idle"), {
      managed: true,
      agent: "main",
      className: "high",
      manual: false,
      model: "glm-4.7",
      agents: ["main", "senior", "junior"],
      classes: ["high", "middle", "low"],
    });
  });

  it("prefers a live entry over the idle display", () => {
    assert.deepEqual(payload("s-main"), {
      managed: true,
      agent: "main",
      className: "middle",
      manual: false,
      model: "glm-5.3-flash",
      agents: ["main", "senior", "junior"],
      classes: ["high", "middle", "low"],
    });
  });

  it("returns unmanaged for a root session when the caller resolved no idle display", () => {
    assert.deepEqual(buildStatePayload(entries, rootIds, choices, "s-idle", undefined), {
      managed: false,
    });
  });

  it("returns unmanaged for an unknown session", () => {
    assert.deepEqual(payload("s-other"), { managed: false });
  });

  it("returns unmanaged when no session id was requested", () => {
    assert.deepEqual(payload(undefined), { managed: false });
  });
});

describe("mergePendingSelection", () => {
  it("stores an agent pick alone: the agent's default class applies", () => {
    assert.deepEqual(
      mergePendingSelection({ agentName: "junior", className: "low" }, "agent", "senior"),
      { agentName: "senior" },
    );
  });

  it("folds a class pick into a pending agent pick", () => {
    assert.deepEqual(mergePendingSelection({ agentName: "junior" }, "class", "low"), {
      agentName: "junior",
      className: "low",
    });
  });

  it("stores a class pick without a pending agent", () => {
    assert.deepEqual(mergePendingSelection(undefined, "class", "low"), { className: "low" });
  });
});

describe("resolveStartSelection", () => {
  const config = {
    default: "main",
    agents: {
      main: { class: "high", tools: [], subagents: [], systemPrompt: [] },
      senior: { class: "middle", tools: [], subagents: [], systemPrompt: [] },
    },
    classes: { high: [], middle: [], low: [] },
  };

  it("falls back to the initial agent/class without a pending pick", () => {
    assert.deepEqual(resolveStartSelection(undefined, config, "main", "high"), {
      agentName: "main",
      className: "high",
    });
  });

  it("keeps a --class flag initial class when no pending pick exists", () => {
    assert.deepEqual(resolveStartSelection(undefined, config, "main", "low"), {
      agentName: "main",
      className: "low",
    });
  });

  it("starts a pending agent with its default class", () => {
    assert.deepEqual(resolveStartSelection({ agentName: "senior" }, config, "main", "high"), {
      agentName: "senior",
      className: "middle",
    });
  });

  it("starts a pending agent with a pending class override", () => {
    assert.deepEqual(
      resolveStartSelection({ agentName: "senior", className: "low" }, config, "main", "high"),
      { agentName: "senior", className: "low" },
    );
  });

  it("applies a class-only pending pick to the initial agent", () => {
    assert.deepEqual(resolveStartSelection({ className: "low" }, config, "main", "high"), {
      agentName: "main",
      className: "low",
    });
  });

  it("falls back to the initials when the pending agent vanished from the config", () => {
    assert.deepEqual(resolveStartSelection({ agentName: "ghost" }, config, "main", "low"), {
      agentName: "main",
      className: "low",
    });
  });

  it("falls back to the agent's default class when the pending class vanished", () => {
    assert.deepEqual(
      resolveStartSelection({ agentName: "senior", className: "ghost" }, config, "main", "high"),
      { agentName: "senior", className: "middle" },
    );
  });
});

describe("parseSelectRequest", () => {
  it("accepts a well-formed agent pick", () => {
    assert.deepEqual(
      parseSelectRequest({ sessionId: "s-main", kind: "agent", name: "senior" }),
      { sessionId: "s-main", kind: "agent", name: "senior" },
    );
  });

  it("accepts a well-formed class pick without a session id", () => {
    assert.deepEqual(parseSelectRequest({ kind: "class", name: "low" }), {
      sessionId: undefined,
      kind: "class",
      name: "low",
    });
  });

  it("rejects non-object payloads and bad fields", () => {
    assert.equal(parseSelectRequest(null), undefined);
    assert.equal(parseSelectRequest("s-main"), undefined);
    assert.equal(parseSelectRequest({ kind: "model", name: "x" }), undefined);
    assert.equal(parseSelectRequest({ kind: "agent", name: "" }), undefined);
    assert.equal(parseSelectRequest({ kind: "agent" }), undefined);
    assert.equal(parseSelectRequest({ sessionId: 7, kind: "agent", name: "x" }), undefined);
  });
});
