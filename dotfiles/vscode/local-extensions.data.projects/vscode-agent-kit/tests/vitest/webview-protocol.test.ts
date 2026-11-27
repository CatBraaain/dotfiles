import { describe, expect, it } from "vitest";
import { parseWebviewRequest } from "../../src/webview/protocol";

const sessionId = "00000000-0000-4000-8000-000000000001";
const otherSessionId = "00000000-0000-4000-8000-000000000002";
const uuidV7SessionId = "01933d1e-3b7a-7bb2-a5d1-c27f6a857d13";
const customSessionId = "spec-d5-549bc7eb-1e89-4eb1-ab9d-16ff3be54fe7";

describe("parseWebviewRequest", () => {
  it.each([
    [{ type: "ready" }, { type: "ready" }],
    [
      { type: "ready", requestId: "connection-1" },
      { type: "ready", requestId: "connection-1" },
    ],
    [{ type: "refresh" }, { type: "refresh" }],
    [
      { type: "newSession", cwd: "/home/user/project" },
      { type: "newSession", cwd: "/home/user/project" },
    ],
    [
      { type: "newSession", cwd: "/home/user/project", requestId: "request-1" },
      { type: "newSession", cwd: "/home/user/project", requestId: "request-1" },
    ],
    [
      { type: "addWorkspace", path: "/home/user/project" },
      { type: "addWorkspace", path: "/home/user/project" },
    ],
    [
      { type: "openWorkspaceTerminal", cwd: "/home/user/my project" },
      { type: "openWorkspaceTerminal", cwd: "/home/user/my project" },
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
      { type: "openSession", sessionId: uuidV7SessionId },
      { type: "openSession", sessionId: uuidV7SessionId },
    ],
    [
      { type: "openSession", sessionId: "session-1" },
      { type: "openSession", sessionId: "session-1" },
    ],
    [
      { type: "reloadSession", sessionId },
      { type: "reloadSession", sessionId },
    ],
    [
      { type: "copySessionId", sessionId },
      { type: "copySessionId", sessionId },
    ],
    [
      { type: "deactivateSession", sessionId: customSessionId },
      { type: "deactivateSession", sessionId: customSessionId },
    ],
    [
      { type: "deactivateSession", sessionId },
      { type: "deactivateSession", sessionId },
    ],
    [
      { type: "deactivateSession", sessionId, requestId: "request-1" },
      { type: "deactivateSession", sessionId, requestId: "request-1" },
    ],
    [
      { type: "activateSession", sessionId },
      { type: "activateSession", sessionId },
    ],
    [
      { type: "activateSession", sessionId: otherSessionId },
      { type: "activateSession", sessionId: otherSessionId },
    ],
    [
      { type: "activateSession", sessionId, requestId: "request-1" },
      { type: "activateSession", sessionId, requestId: "request-1" },
    ],
  ])("accepts supported request %#", (value, expected) => {
    expect(parseWebviewRequest(value)).toEqual(expected);
  });

  it.each([
    undefined,
    null,
    "refresh",
    { type: "ready", requestId: "" },
    { type: "ready", requestId: " " },
    { type: "ready", requestId: 1 },
    { type: "setMode", mode: "active" },
    { type: "setMode", mode: "all" },
    { type: "openSession" },
    { type: "openSession", sessionId: 1 },
    { type: "openSession", sessionId: "" },
    { type: "openSession", sessionId: "session 1" },
    { type: "openSession", sessionId: "-leading-dash" },
    { type: "openSession", sessionId: "/arbitrary/path" },
    { type: "deactivateSessions" },
    { type: "deactivateSessions", sessionIds: [sessionId] },
    { type: "deactivateSession" },
    { type: "deactivateSession", sessionId: "" },
    { type: "deactivateSession", sessionId: 3 },
    { type: "deactivateSession", sessionId: "trailing_dot." },
    { type: "deactivateSession", sessionIds: [sessionId] },
    { type: "deactivateSession", sessionId, requestId: "" },
    { type: "deactivateSession", sessionId, requestId: 1 },
    { type: "activateSessions" },
    { type: "activateSessions", sessionIds: [sessionId] },
    { type: "activateSession" },
    { type: "activateSession", sessionId: 3 },
    { type: "activateSession", sessionId: "session 1" },
    { type: "activateSession", sessionIds: [sessionId] },
    { type: "activateSession", sessionId, requestId: "" },
    { type: "activateSession", sessionId, requestId: 2 },
    { type: "copySessionId", sessionId: "" },
    { type: "reloadSession" },
    { type: "reloadSession", sessionId: "--force" },
    { type: "setSessionLock", sessionId, locked: true },
    { type: "setSessionLock", sessionId, locked: false },
    { type: "setSessionLock", sessionId },
    { type: "setSessionLock", sessionId, locked: "true" },
    { type: "setSessionLock", sessionId, locked: 1 },
    { type: "newSession" },
    { type: "newSession", cwd: "" },
    { type: "newSession", cwd: "   " },
    { type: "newSession", cwd: 3 },
    { type: "newSession", cwd: "/project", requestId: 3 },
    { type: "newSession", cwd: "/project", requestId: "" },
    { type: "addWorkspace" },
    { type: "addWorkspace", path: "" },
    { type: "addWorkspace", path: "   " },
    { type: "addWorkspace", path: 7 },
    { type: "openWorkspaceTerminal" },
    { type: "openWorkspaceTerminal", cwd: "  " },
    { type: "openWorkspaceTerminal", cwd: 9 },
    { type: "unregisterWorkspace" },
    { type: "unregisterWorkspace", cwd: "" },
    { type: "unregisterWorkspace", cwd: "  " },
    { type: "unregisterWorkspace", cwd: 9 },
    { type: "shell", command: "rm -rf /" },
  ])("rejects unsupported input %#", (value) => {
    expect(parseWebviewRequest(value)).toBeUndefined();
  });
});
