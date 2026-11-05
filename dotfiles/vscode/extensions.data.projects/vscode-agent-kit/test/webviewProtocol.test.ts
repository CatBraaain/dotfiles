import { describe, expect, it } from "vitest";
import { parseWebviewRequest } from "../src/webview/protocol";

const sessionId = "00000000-0000-4000-8000-000000000001";
const otherSessionId = "00000000-0000-4000-8000-000000000002";

describe("parseWebviewRequest", () => {
  it.each([
    [{ type: "ready" }, { type: "ready" }],
    [{ type: "refresh" }, { type: "refresh" }],
    [
      { type: "newSession", cwd: "/home/user/project" },
      { type: "newSession", cwd: "/home/user/project" },
    ],
    [
      { type: "addWorkspace", path: "/home/user/project" },
      { type: "addWorkspace", path: "/home/user/project" },
    ],
    [
      { type: "unregisterWorkspace", cwd: "/home/user/project" },
      { type: "unregisterWorkspace", cwd: "/home/user/project" },
    ],
    [
      { type: "openSession", sessionId },
      { type: "openSession", sessionId },
    ],
    [
      { type: "archiveSessions", sessionIds: [sessionId] },
      { type: "archiveSessions", sessionIds: [sessionId] },
    ],
    [
      { type: "archiveSessions", sessionIds: [sessionId, otherSessionId] },
      { type: "archiveSessions", sessionIds: [sessionId, otherSessionId] },
    ],
    [
      { type: "setSessionLock", sessionId, locked: true },
      { type: "setSessionLock", sessionId, locked: true },
    ],
    [
      { type: "setSessionLock", sessionId, locked: false },
      { type: "setSessionLock", sessionId, locked: false },
    ],
    [
      { type: "copySessionId", sessionId },
      { type: "copySessionId", sessionId },
    ],
  ])("accepts supported request %#", (value, expected) => {
    expect(parseWebviewRequest(value)).toEqual(expected);
  });

  it.each([
    undefined,
    null,
    "refresh",
    { type: "setMode", mode: "unarchived" },
    { type: "setMode", mode: "all" },
    { type: "openSession" },
    { type: "openSession", sessionId: 1 },
    { type: "openSession", sessionId: "session-1" },
    { type: "openSession", sessionId: "/arbitrary/path" },
    { type: "archiveSessions" },
    { type: "archiveSessions", sessionIds: [] },
    { type: "archiveSessions", sessionIds: [sessionId, "session-1"] },
    { type: "archiveSessions", sessionIds: [sessionId, 3] },
    { type: "setSessionLock", sessionId },
    { type: "setSessionLock", sessionId, locked: "true" },
    { type: "setSessionLock", sessionId, locked: 1 },
    { type: "newSession" },
    { type: "newSession", cwd: "" },
    { type: "newSession", cwd: "   " },
    { type: "newSession", cwd: 3 },
    { type: "addWorkspace" },
    { type: "addWorkspace", path: "" },
    { type: "addWorkspace", path: "   " },
    { type: "addWorkspace", path: 7 },
    { type: "unregisterWorkspace" },
    { type: "unregisterWorkspace", cwd: "" },
    { type: "unregisterWorkspace", cwd: "  " },
    { type: "unregisterWorkspace", cwd: 9 },
    { type: "shell", command: "rm -rf /" },
  ])("rejects unsupported input %#", (value) => {
    expect(parseWebviewRequest(value)).toBeUndefined();
  });
});
