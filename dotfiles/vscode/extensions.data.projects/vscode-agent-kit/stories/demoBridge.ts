// Provider-equivalent bridge for the stories catalog: pure logic over an
// in-memory sample store. Never touches real session files or the metadata
// store; openSession is ignored (terminals do not exist in the catalog).

import type { SessionSummary } from "../src/sessionStore";
import { sessionViewGroups } from "../src/webview/sessionViewData";

/** Demo state a story starts from (SPEC.md「静的プレビュー」表 1 行目). */
export type DemoState = "sample" | "empty";

/** Request from the webview client, same protocol as the extension host side. */
export interface DemoBridgeRequest {
  type: string;
  sessionId?: string;
}

/** Bridge shape the webview client consumes (ClientBridge-compatible). */
export interface DemoBridge {
  postMessage(request: DemoBridgeRequest): void;
  onMessage(callback: (message: unknown) => void): void;
}

const ATLAS_CWD = "/Users/aya/Projects/atlas-dashboard";
const PI_TOOLS_CWD = "/Users/aya/Projects/pi-tools";
const NOTES_CWD = "/Users/aya/Notes";

const sampleSessions: SessionSummary[] = [
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

function cloneStore(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.map((session) => ({ ...session }));
}

/** Create a demo bridge for the stories catalog. */
export function createDemoBridge(): {
  bridge: DemoBridge;
  postSessions(): void;
  reset(demoState: DemoState): void;
} {
  let listener: (message: { type?: string; state?: unknown }) => void = () => {};
  let store: SessionSummary[] = cloneStore(sampleSessions);
  let activeIds = new Set(ACTIVE_SAMPLE_IDS);

  function postSessions(): void {
    // Same projection as the provider's: every session with active marks.
    listener({ type: "sessions", state: { groups: sessionViewGroups(store, activeIds) } });
  }

  function handleRequest(request: DemoBridgeRequest): void {
    if (request.type === "refresh") {
      postSessions();
      return;
    }
    if (request.type === "copySessionId" && typeof request.sessionId === "string") {
      // The catalog runs in a browser: copy directly through the Clipboard API.
      void navigator.clipboard?.writeText(request.sessionId);
      return;
    }
    if (request.type === "archiveSession" && typeof request.sessionId === "string") {
      activeIds.delete(request.sessionId);
      postSessions();
      return;
    }
    if (request.type === "newSession") {
      const session: SessionSummary = {
        sessionId: crypto.randomUUID(),
        filePath: "",
        cwd: store[0]?.cwd ?? ATLAS_CWD,
        displayName: "New Pi session",
        mtimeMs: Date.now(),
      };
      store = [session, ...store];
      activeIds = new Set([...activeIds, session.sessionId]);
      postSessions();
    }
    // openSession and unknown requests are ignored: nothing to open in the catalog.
  }

  /** Reset to a demo state. */
  function reset(demoState: DemoState): void {
    store = cloneStore(sampleSessions);
    activeIds = demoState === "sample" ? new Set(ACTIVE_SAMPLE_IDS) : new Set();
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
