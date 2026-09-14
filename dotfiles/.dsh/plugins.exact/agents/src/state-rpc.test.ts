import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  buildStatePayload,
  isDisplayedAgent,
  isRootSessionHeader,
  parseSelectRequest,
  parseStateRequest,
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

/** The selectable vocabulary every managed answer carries. */
const choices = { agents: ["main", "senior", "junior"], classes: ["high", "middle", "low"] };

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
  const initial = { agent: "main", className: "high" };
  const payload = (sessionId: string | undefined) =>
    buildStatePayload(entries, rootIds, initial, choices, sessionId);

  it("returns the managed display state with the resolved model and menu vocabularies", () => {
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

  it("omits the model before the first route resolution", () => {
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

  it("shows the initial agent/class (no model) for an idle top-level session", () => {
    assert.deepEqual(payload("s-idle"), {
      managed: true,
      agent: "main",
      className: "high",
      manual: false,
      agents: ["main", "senior", "junior"],
      classes: ["high", "middle", "low"],
    });
  });

  it("returns unmanaged for an unknown session", () => {
    assert.deepEqual(payload("s-other"), { managed: false });
  });

  it("returns unmanaged when no session id was requested", () => {
    assert.deepEqual(payload(undefined), { managed: false });
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
