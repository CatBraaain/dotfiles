import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  buildStatePayload,
  isDisplayedAgent,
  isRootSessionHeader,
  parseStateRequest,
  type ManagedStateEntry,
} from "./state-rpc.ts";

const entries: readonly ManagedStateEntry[] = [
  {
    sessionId: "s-main",
    agentName: "main",
    effectiveClass: "middle",
    manualSelect: false,
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
  const initial = { agent: "main", className: "high" };

  it("returns the managed display state of the matching session", () => {
    assert.deepEqual(buildStatePayload(entries, rootIds, initial, "s-main"), {
      managed: true,
      agent: "main",
      className: "middle",
      manual: false,
    });
  });

  it("carries the manual flag through", () => {
    assert.deepEqual(buildStatePayload(entries, rootIds, initial, "s-chat"), {
      managed: true,
      agent: "chat",
      className: "low",
      manual: true,
    });
  });

  it("shows the initial agent/class for an idle top-level session", () => {
    assert.deepEqual(buildStatePayload(entries, rootIds, initial, "s-idle"), {
      managed: true,
      agent: "main",
      className: "high",
      manual: false,
    });
  });

  it("returns unmanaged for an unknown session", () => {
    assert.deepEqual(buildStatePayload(entries, rootIds, initial, "s-other"), { managed: false });
  });

  it("returns unmanaged when no session id was requested", () => {
    assert.deepEqual(buildStatePayload(entries, rootIds, initial, undefined), { managed: false });
  });
});
