import { describe, expect, it } from "vitest";
import { parseWebviewRequest } from "../src/webview/protocol";

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
      { type: "archiveSession", sessionId: customSessionId },
      { type: "archiveSession", sessionId: customSessionId },
    ],
    [
      { type: "archiveSession", sessionId },
      { type: "archiveSession", sessionId },
    ],
    [
      { type: "archiveSession", sessionId, requestId: "request-1" },
      { type: "archiveSession", sessionId, requestId: "request-1" },
    ],
    [
      { type: "unarchiveSession", sessionId },
      { type: "unarchiveSession", sessionId },
    ],
    [
      { type: "unarchiveSession", sessionId: otherSessionId },
      { type: "unarchiveSession", sessionId: otherSessionId },
    ],
    [
      { type: "unarchiveSession", sessionId, requestId: "request-1" },
      { type: "unarchiveSession", sessionId, requestId: "request-1" },
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
    { type: "setMode", mode: "unarchived" },
    { type: "setMode", mode: "all" },
    { type: "openSession" },
    { type: "openSession", sessionId: 1 },
    { type: "openSession", sessionId: "" },
    { type: "openSession", sessionId: "session 1" },
    { type: "openSession", sessionId: "-leading-dash" },
    { type: "openSession", sessionId: "/arbitrary/path" },
    { type: "archiveSessions" },
    { type: "archiveSessions", sessionIds: [sessionId] },
    { type: "archiveSession" },
    { type: "archiveSession", sessionId: "" },
    { type: "archiveSession", sessionId: 3 },
    { type: "archiveSession", sessionId: "trailing_dot." },
    { type: "archiveSession", sessionIds: [sessionId] },
    { type: "archiveSession", sessionId, requestId: "" },
    { type: "archiveSession", sessionId, requestId: 1 },
    { type: "unarchiveSessions" },
    { type: "unarchiveSessions", sessionIds: [sessionId] },
    { type: "unarchiveSession" },
    { type: "unarchiveSession", sessionId: 3 },
    { type: "unarchiveSession", sessionId: "session 1" },
    { type: "unarchiveSession", sessionIds: [sessionId] },
    { type: "unarchiveSession", sessionId, requestId: "" },
    { type: "unarchiveSession", sessionId, requestId: 2 },
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
    { type: "unregisterWorkspace" },
    { type: "unregisterWorkspace", cwd: "" },
    { type: "unregisterWorkspace", cwd: "  " },
    { type: "unregisterWorkspace", cwd: 9 },
    { type: "shell", command: "rm -rf /" },
  ])("rejects unsupported input %#", (value) => {
    expect(parseWebviewRequest(value)).toBeUndefined();
  });
});
