import { describe, expect, it } from "vitest";
import { parseWebviewRequest } from "../src/webview/protocol";

const sessionId = "00000000-0000-4000-8000-000000000001";
const otherSessionId = "00000000-0000-4000-8000-000000000002";
const uuidV7SessionId = "01933d1e-3b7a-7bb2-a5d1-c27f6a857d13";
const customSessionId = "spec-d5-549bc7eb-1e89-4eb1-ab9d-16ff3be54fe7";

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
      { type: "openSession", sessionId: uuidV7SessionId },
      { type: "openSession", sessionId: uuidV7SessionId },
    ],
    [
      { type: "openSession", sessionId: "session-1" },
      { type: "openSession", sessionId: "session-1" },
    ],
    [
      { type: "archiveSessions", sessionIds: [customSessionId] },
      { type: "archiveSessions", sessionIds: [customSessionId] },
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
      { type: "unarchiveSessions", sessionIds: [sessionId] },
      { type: "unarchiveSessions", sessionIds: [sessionId] },
    ],
    [
      { type: "unarchiveSessions", sessionIds: [sessionId, otherSessionId] },
      { type: "unarchiveSessions", sessionIds: [sessionId, otherSessionId] },
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
    { type: "openSession", sessionId: "" },
    { type: "openSession", sessionId: "session 1" },
    { type: "openSession", sessionId: "-leading-dash" },
    { type: "openSession", sessionId: "/arbitrary/path" },
    { type: "archiveSessions" },
    { type: "archiveSessions", sessionIds: [] },
    { type: "archiveSessions", sessionIds: [sessionId, "trailing_dot."] },
    { type: "archiveSessions", sessionIds: [sessionId, 3] },
    { type: "unarchiveSessions" },
    { type: "unarchiveSessions", sessionIds: [] },
    { type: "unarchiveSessions", sessionIds: [sessionId, 3] },
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
