import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildStatePayload, parseStateRequest, type ManagedStateEntry } from "./state-rpc.ts";

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

describe("buildStatePayload", () => {
  it("returns the managed display state of the matching session", () => {
    assert.deepEqual(buildStatePayload(entries, "s-main"), {
      managed: true,
      agent: "main",
      className: "middle",
      manual: false,
    });
  });

  it("carries the manual flag through", () => {
    assert.deepEqual(buildStatePayload(entries, "s-chat"), {
      managed: true,
      agent: "chat",
      className: "low",
      manual: true,
    });
  });

  it("returns unmanaged for an unknown session", () => {
    assert.deepEqual(buildStatePayload(entries, "s-other"), { managed: false });
  });

  it("returns unmanaged when no session id was requested", () => {
    assert.deepEqual(buildStatePayload(entries, undefined), { managed: false });
  });
});
