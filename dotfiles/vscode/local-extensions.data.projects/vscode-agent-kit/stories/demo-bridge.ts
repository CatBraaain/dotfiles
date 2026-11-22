// Provider-equivalent bridge for the stories catalog: pure logic over an
// in-memory sample store. Never touches real session files or the metadata
// store; openSession is ignored (terminals do not exist in the catalog).

import type { SessionSummary } from "../src/session-store";
import type { SessionPhase } from "../src/webview/protocol";
import { sessionViewGroups } from "../src/webview/session-view-data";

/** Demo state a story starts from (SPEC.md「静的プレビュー」表 1 行目). */
export type DemoState = "sample" | "empty" | "delayed";

/** Per-session demo metadata: explicit archive, live phase, and publish delay. */
interface DemoEntry {
  archived: boolean;
  state?: SessionPhase;
  delayed?: boolean;
}

/** Request from the webview client, same protocol as the extension host side. */
export interface DemoBridgeRequest {
  type: string;
  sessionId?: string;
  cwd?: string;
  path?: string;
  requestId?: string;
}

/** Bridge shape the webview client consumes (ClientBridge-compatible). */
export interface DemoBridge {
  postMessage(request: DemoBridgeRequest): void;
  onMessage(callback: (message: unknown) => void): void;
}

const PROJECT_CWD = "~/projects/vscode-agent-kit";
const PI_TOOLS_CWD = "~/projects/pi-tools";
const PROJECT_WORKTREE_CWD = "~/.agents/worktrees/vscode-agent-kit";
const REGISTERED_ONLY_CWD = "~/projects/agenda";

const sampleSessions: SessionSummary[] = [
  {
    sessionId: "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10",
    filePath: `${PROJECT_CWD}/20260919_1f0e6f9a.jsonl`,
    cwd: PROJECT_CWD,
    displayName: "Polish the session sidebar",
    createdAtMs: Date.UTC(2026, 8, 19, 9, 42),
    updatedAtMs: Date.UTC(2026, 8, 19, 9, 42),
  },
  {
    sessionId: "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61",
    filePath: `${PROJECT_CWD}/20260919_2c9d7e1b.jsonl`,
    cwd: PROJECT_CWD,
    displayName: "Review keyboard navigation",
    createdAtMs: Date.UTC(2026, 8, 19, 8, 16),
    updatedAtMs: Date.UTC(2026, 8, 19, 8, 16),
  },
  {
    sessionId: "3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72",
    filePath: `${PI_TOOLS_CWD}/20260918_3a8b6d2c.jsonl`,
    cwd: PI_TOOLS_CWD,
    displayName: "Add session metadata tests",
    createdAtMs: Date.UTC(2026, 8, 18, 17, 34),
    updatedAtMs: Date.UTC(2026, 8, 18, 17, 34),
  },
  {
    sessionId: "4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83",
    filePath: `${PI_TOOLS_CWD}/20260917_4d7a5e3f.jsonl`,
    cwd: PI_TOOLS_CWD,
    displayName: "Untitled",
    createdAtMs: Date.UTC(2026, 8, 17, 13, 8),
    updatedAtMs: Date.UTC(2026, 8, 17, 13, 8),
  },
  {
    sessionId: "5b6c4a2d-9e1f-4c3b-af2a-4d5e6f7a8b94",
    filePath: `${PROJECT_WORKTREE_CWD}/20260916_5b6c4a2d.jsonl`,
    cwd: PROJECT_WORKTREE_CWD,
    displayName: "Plan the next release",
    createdAtMs: Date.UTC(2026, 8, 16, 10, 52),
    updatedAtMs: Date.UTC(2026, 8, 16, 10, 52),
  },
];

const UNARCHIVED: DemoEntry = { archived: false };

/** Sessions the publish-delay story marks as delayed: the running row and the
 * archived row, so the dot shows beside a phase icon and without one. */
const DELAYED_SAMPLE_IDS = new Set([
  "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10",
  "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61",
]);

/** Demo displayed session: the catalog marks this row as the one the shared
 * terminal shows (openSession is ignored, so the mark never moves). */
const DISPLAYED_SESSION_ID = "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10";
const SAMPLE_METADATA = new Map<string, DemoEntry>([
  ["1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10", { archived: false, state: "running" }],
  ["2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61", { archived: true }],
  ["3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72", { archived: false, state: "waiting-user" }],
  ["4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83", UNARCHIVED],
  ["5b6c4a2d-9e1f-4c3b-af2a-4d5e6f7a8b94", { archived: false, state: "waiting-approval" }],
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
  let listener: (message: {
    type?: string;
    state?: unknown;
    requestId?: string;
  }) => void = () => {};
  let store: SessionSummary[] = cloneStore(sampleSessions);
  let metadata = new Map<string, DemoEntry>(SAMPLE_METADATA);
  let displayedSessionId: string | undefined = DISPLAYED_SESSION_ID;
  // The list shows registered workspaces only. The worktree cwd and the
  // project share one basename, which the heading hint must distinguish; the
  // agenda workspace has no sessions and still keeps its empty group.
  let registeredCwds: string[] = [
    PROJECT_CWD,
    PI_TOOLS_CWD,
    PROJECT_WORKTREE_CWD,
    REGISTERED_ONLY_CWD,
  ];

  function postSessions(requestId?: string): void {
    const archivedIds = new Set(
      [...metadata].filter(([, entry]) => entry.archived).map(([sessionId]) => sessionId),
    );
    const phases = new Map(
      [...metadata]
        .filter(([, entry]) => entry.state !== undefined)
        .map(([sessionId, entry]) => [sessionId, entry.state as SessionPhase]),
    );
    const delayedIds = new Set(
      [...metadata].filter(([, entry]) => entry.delayed).map(([sessionId]) => sessionId),
    );
    listener({
      type: "sessions",
      ...(requestId === undefined ? {} : { requestId }),
      state: {
        groups: sessionViewGroups(store, {
          registeredCwds,
          archivedIds,
          phases,
          delayedIds,
        }),
        displayedSessionId,
      },
    });
  }

  function entryOf(sessionId: string): DemoEntry {
    return metadata.get(sessionId) ?? UNARCHIVED;
  }

  function handleRequest(request: DemoBridgeRequest): void {
    if (request.type === "ready") {
      postSessions(request.requestId);
      return;
    }
    if (request.type === "refresh") {
      postSessions();
      return;
    }
    if (request.type === "archiveSession" && typeof request.sessionId === "string") {
      metadata.set(request.sessionId, { archived: true });
      if (displayedSessionId === request.sessionId) displayedSessionId = undefined;
      // Send the sessions update while the request is still pending, like the
      // extension host does, so the client animates the list change.
      postSessions();
      if (request.requestId !== undefined)
        listener({ type: "archiveFinished", requestId: request.requestId });
      return;
    }
    if (request.type === "unarchiveSession" && typeof request.sessionId === "string") {
      metadata.set(request.sessionId, { ...entryOf(request.sessionId), archived: false });
      postSessions();
      if (request.requestId !== undefined)
        listener({ type: "unarchiveFinished", requestId: request.requestId });
      return;
    }
    if (request.type === "newSession" && typeof request.cwd === "string") {
      const createdAtMs = Date.now();
      const session: SessionSummary = {
        sessionId: crypto.randomUUID(),
        filePath: "",
        cwd: request.cwd,
        displayName: "New Pi session",
        createdAtMs,
        updatedAtMs: createdAtMs,
      };
      store = [session, ...store];
      metadata.set(session.sessionId, UNARCHIVED);
      if (request.requestId !== undefined)
        listener({ type: "newSessionFinished", requestId: request.requestId });
      postSessions();
      return;
    }
    if (request.type === "addWorkspace" && typeof request.path === "string") {
      // The catalog validates no real folder: an empty-cwd group appears as is.
      if (!registeredCwds.includes(request.path))
        registeredCwds = [...registeredCwds, request.path];
      listener?.({ type: "workspaceAdded" });
      postSessions();
      return;
    }
    if (request.type === "unregisterWorkspace" && typeof request.cwd === "string") {
      registeredCwds = registeredCwds.filter((cwd) => cwd !== request.cwd);
      postSessions();
      return;
    }
    // openSession and unknown requests are ignored: nothing to open in the catalog.
  }

  /** Reset to a demo state. */
  function reset(demoState: DemoState): void {
    store = cloneStore(sampleSessions);
    displayedSessionId = DISPLAYED_SESSION_ID;
    metadata = new Map(
      [...SAMPLE_METADATA].map(([sessionId, entry]) => [
        sessionId,
        demoState === "empty" ? { ...entry, archived: true } : { ...entry },
      ]),
    );
    if (demoState === "delayed") {
      // The delayed preset keeps the sample archive states and only adds the
      // publish-delay mark to the running row and the archived row.
      for (const sessionId of DELAYED_SAMPLE_IDS) {
        metadata.set(sessionId, { ...entryOf(sessionId), delayed: true });
      }
    }
    registeredCwds = [PROJECT_CWD, PI_TOOLS_CWD, PROJECT_WORKTREE_CWD, REGISTERED_ONLY_CWD];
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
