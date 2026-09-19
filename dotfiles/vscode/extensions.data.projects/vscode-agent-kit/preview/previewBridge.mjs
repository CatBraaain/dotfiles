// Provider-equivalent bridge for the static preview: pure logic over an
// in-memory sample store. Never touches real session files or the metadata
// store; openSession is ignored (terminals do not exist in the preview).

import { groupSessions } from "./lib/grouping.js";
import { visibleSessions } from "./lib/viewMode.js";

const ATLAS_CWD = "/Users/aya/Projects/atlas-dashboard";
const PI_TOOLS_CWD = "/Users/aya/Projects/pi-tools";
const NOTES_CWD = "/Users/aya/Notes";

/** Sample sessions (SessionSummary-compatible rows for grouping/viewMode). */
const sampleSessions = [
  {
    sessionId: "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10",
    filePath: `${ATLAS_CWD}/20260919_1f0e6f9a.jsonl`,
    cwd: ATLAS_CWD,
    displayName: "Polish the session sidebar",
    mtimeMs: Date.UTC(2026, 8, 19, 9, 42),
  },
  {
    sessionId: "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61",
    filePath: `${ATLAS_CWD}/20260919_2c9d7e1b.jsonl`,
    cwd: ATLAS_CWD,
    displayName: "Review keyboard navigation",
    mtimeMs: Date.UTC(2026, 8, 19, 8, 16),
  },
  {
    sessionId: "3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72",
    filePath: `${PI_TOOLS_CWD}/20260918_3a8b6d2c.jsonl`,
    cwd: PI_TOOLS_CWD,
    displayName: "Add session metadata tests",
    mtimeMs: Date.UTC(2026, 8, 18, 17, 34),
  },
  {
    sessionId: "4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83",
    filePath: `${PI_TOOLS_CWD}/20260917_4d7a5e3f.jsonl`,
    cwd: PI_TOOLS_CWD,
    displayName: "Untitled",
    mtimeMs: Date.UTC(2026, 8, 17, 13, 8),
  },
  {
    sessionId: "5b6c4a2d-9e1f-4c3b-af2a-4d5e6f7a8b94",
    filePath: `${NOTES_CWD}/20260916_5b6c4a2d.jsonl`,
    cwd: NOTES_CWD,
    displayName: "Plan the next release",
    mtimeMs: Date.UTC(2026, 8, 16, 10, 52),
  },
];

const ACTIVE_SAMPLE_IDS = new Set([
  "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10",
  "3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72",
]);

function cloneStore(sessions) {
  return sessions.map((session) => ({ ...session }));
}

/**
 * Create a preview bridge.
 *
 * @returns {{
 *   bridge: {
 *     postMessage(request: unknown): void;
 *     onMessage(callback: (message: { type?: string; state?: any }) => void): void;
 *   };
 *   postSessions(): void;
 *   reset(demoState: string): void;
 * }}
 */
export function createPreviewBridge() {
  let listener = () => {};
  let store = cloneStore(sampleSessions);
  let activeIds = new Set(ACTIVE_SAMPLE_IDS);
  let mode = "active";

  function postSessions() {
    listener({ type: "sessions", state: viewState() });
  }

  /** Same projection as the provider's sessionViewGroups. */
  function viewState() {
    return {
      mode,
      groups: groupSessions(visibleSessions(store, mode, activeIds)).map((group) => ({
        cwd: group.cwd,
        label: group.label,
        sessions: group.sessions.map((session) => ({
          sessionId: session.sessionId,
          displayName: session.displayName,
          mtimeMs: session.mtimeMs,
          isActive: activeIds.has(session.sessionId),
        })),
      })),
    };
  }

  function handleRequest(request) {
    if (request === null || typeof request !== "object") return;
    if (request.type === "setMode" && (request.mode === "active" || request.mode === "all")) {
      mode = request.mode;
      postSessions();
      return;
    }
    if (request.type === "refresh") {
      postSessions();
      return;
    }
    if (request.type === "deactivateSession" && typeof request.sessionId === "string") {
      activeIds.delete(request.sessionId);
      postSessions();
      return;
    }
    if (request.type === "newSession") {
      const session = {
        sessionId: crypto.randomUUID(),
        filePath: "",
        cwd: store[0]?.cwd ?? ATLAS_CWD,
        displayName: "New Pi session",
        mtimeMs: Date.now(),
      };
      store = [session, ...store];
      activeIds = new Set([...activeIds, session.sessionId]);
      mode = "active";
      postSessions();
    }
    // openSession and unknown requests are ignored: nothing to open in the preview.
  }

  /** Reset to a demo state: "sample" | "active-empty" | "all-empty". */
  function reset(demoState) {
    if (demoState === "sample") {
      store = cloneStore(sampleSessions);
      activeIds = new Set(ACTIVE_SAMPLE_IDS);
      mode = "active";
    } else if (demoState === "active-empty") {
      store = cloneStore(sampleSessions);
      activeIds = new Set();
      mode = "active";
    } else if (demoState === "all-empty") {
      store = [];
      activeIds = new Set();
      mode = "all";
    } else {
      return;
    }
    postSessions();
  }

  return {
    bridge: {
      postMessage: handleRequest,
      onMessage: (callback) => {
        listener = callback;
      },
    },
    postSessions,
    reset,
  };
}
