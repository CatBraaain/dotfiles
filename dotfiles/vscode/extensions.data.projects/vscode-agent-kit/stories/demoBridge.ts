// Provider-equivalent bridge for the stories catalog: pure logic over an
// in-memory sample store. Never touches real session files or the metadata
// store; openSession is ignored (terminals do not exist in the catalog).

import { groupSessions } from "../src/grouping";
import { visibleSessions } from "../src/viewMode";

/** Demo state a story starts from (SPEC.md「静的プレビュー」表 1 行目). */
export type DemoState = "sample" | "all" | "active-empty" | "all-empty";

/** Demo session row: SessionSummary-compatible fields for grouping/viewMode. */
interface DemoSession {
  sessionId: string;
  filePath: string;
  cwd: string;
  displayName: string;
  mtimeMs: number;
}

/** Request from the webview client, same protocol as the extension host side. */
export interface DemoBridgeRequest {
  type: string;
  mode?: string;
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

const sampleSessions: DemoSession[] = [
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

function cloneStore(sessions: DemoSession[]): DemoSession[] {
  return sessions.map((session) => ({ ...session }));
}

/** Create a demo bridge for the stories catalog. */
export function createDemoBridge(): {
  bridge: DemoBridge;
  postSessions(): void;
  reset(demoState: DemoState): void;
} {
  let listener: (message: { type?: string; state?: unknown }) => void = () => {};
  let store: DemoSession[] = cloneStore(sampleSessions);
  let activeIds = new Set(ACTIVE_SAMPLE_IDS);
  let mode: "active" | "all" = "active";

  function postSessions(): void {
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

  function handleRequest(request: DemoBridgeRequest): void {
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
      const session: DemoSession = {
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
    // openSession and unknown requests are ignored: nothing to open in the catalog.
  }

  /** Reset to a demo state. */
  function reset(demoState: DemoState): void {
    if (demoState === "sample" || demoState === "all") {
      store = cloneStore(sampleSessions);
      activeIds = new Set(ACTIVE_SAMPLE_IDS);
      mode = demoState === "all" ? "all" : "active";
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
