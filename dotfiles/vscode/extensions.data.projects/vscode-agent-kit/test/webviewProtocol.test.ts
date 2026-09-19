import { describe, expect, it } from "vitest";
import { parseWebviewRequest } from "../src/webview/protocol";

describe("parseWebviewRequest", () => {
  it.each([
    [{ type: "setMode", mode: "active" }, { type: "setMode", mode: "active" }],
    [{ type: "setMode", mode: "all" }, { type: "setMode", mode: "all" }],
    [{ type: "refresh" }, { type: "refresh" }],
    [{ type: "newSession" }, { type: "newSession" }],
    [
      { type: "openSession", sessionId: "00000000-0000-4000-8000-000000000001" },
      { type: "openSession", sessionId: "00000000-0000-4000-8000-000000000001" },
    ],
    [
      { type: "deactivateSession", sessionId: "00000000-0000-4000-8000-000000000001" },
      { type: "deactivateSession", sessionId: "00000000-0000-4000-8000-000000000001" },
    ],
  ])("accepts supported request %#", (value, expected) => {
    expect(parseWebviewRequest(value)).toEqual(expected);
  });

  it.each([
    undefined,
    null,
    "refresh",
    { type: "setMode", mode: "other" },
    { type: "openSession" },
    { type: "openSession", sessionId: 1 },
    { type: "openSession", sessionId: "session-1" },
    { type: "openSession", sessionId: "/arbitrary/path" },
    { type: "shell", command: "rm -rf /" },
  ])("rejects unsupported input %#", (value) => {
    expect(parseWebviewRequest(value)).toBeUndefined();
  });
});
