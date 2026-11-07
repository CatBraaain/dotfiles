// Provider-equivalent bridge for the stories catalog: pure logic over an
// in-memory sample store. Never touches real session files or the metadata
// store; openSession is ignored (terminals do not exist in the catalog).

import type { SessionSummary } from "../src/sessionStore";
import { sessionViewGroups } from "../src/webview/sessionViewData";

/** Demo state a story starts from (SPEC.md「静的プレビュー」表 1 行目). */
export type DemoState = "sample" | "empty";

/** Per-session demo metadata: explicit archive and archive-protection lock. */
interface DemoEntry {
  archived: boolean;
  locked: boolean;
}

/** Request from the webview client, same protocol as the extension host side. */
export interface DemoBridgeRequest {
  type: string;
  sessionId?: string;
  sessionIds?: string[];
  locked?: boolean;
  cwd?: string;
  path?: string;
}

/** Bridge shape the webview client consumes (ClientBridge-compatible). */
export interface DemoBridge {
  postMessage(request: DemoBridgeRequest): void;
  onMessage(callback: (message: unknown) => void): void;
}

const PROJECT_CWD = "~/projects/vscode-pi-sessions";
const PI_TOOLS_CWD = "~/projects/pi-tools";
const PROJECT_WORKTREE_CWD = "~/.agents/worktrees/vscode-pi-sessions";
const REGISTERED_ONLY_CWD = "~/projects/agenda";

const sampleSessions: SessionSummary[] = [
  {
    sessionId: "1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10",
    filePath: `${PROJECT_CWD}/20260919_1f0e6f9a.jsonl`,
    cwd: PROJECT_CWD,
    displayName: "Polish the session sidebar",
    mtimeMs: Date.UTC(2026, 8, 19, 9, 42),
  },
  {
    sessionId: "2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61",
    filePath: `${PROJECT_CWD}/20260919_2c9d7e1b.jsonl`,
    cwd: PROJECT_CWD,
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
    filePath: `${PROJECT_WORKTREE_CWD}/20260916_5b6c4a2d.jsonl`,
    cwd: PROJECT_WORKTREE_CWD,
    displayName: "Plan the next release",
    mtimeMs: Date.UTC(2026, 8, 16, 10, 52),
  },
];

const UNARCHIVED: DemoEntry = { archived: false, locked: false };
const SAMPLE_METADATA = new Map<string, DemoEntry>([
  ["1f0e6f9a-3b1d-4c8e-9a2f-6d5b4c3a2e10", UNARCHIVED],
  ["2c9d7e1b-5a4f-4b3a-8e7d-1f2a3b4c5d61", { archived: true, locked: false }],
  ["3a8b6d2c-7f5e-4a9b-8d1c-0e3f4a5b6c72", UNARCHIVED],
  ["4d7a5e3f-8b9c-4d2a-9e1b-2c3d4e5f6a83", { archived: false, locked: true }],
  ["5b6c4a2d-9e1f-4c3b-af2a-4d5e6f7a8b94", UNARCHIVED],
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
  let metadata = new Map<string, DemoEntry>(SAMPLE_METADATA);
  // The list shows registered workspaces only. The worktree cwd and the
  // project share one basename, which the heading hint must distinguish; the
  // agenda workspace has no sessions and still keeps its empty group.
  let registeredCwds: string[] = [
    PROJECT_CWD,
    PI_TOOLS_CWD,
    PROJECT_WORKTREE_CWD,
    REGISTERED_ONLY_CWD,
  ];

  function postSessions(): void {
    // Same projection as the provider's: every session with archive and lock marks.
    const archivedIds = new Set(
      [...metadata].filter(([, entry]) => entry.archived).map(([sessionId]) => sessionId),
    );
    const lockedIds = new Set(
      [...metadata].filter(([, entry]) => entry.locked).map(([sessionId]) => sessionId),
    );
    listener({
      type: "sessions",
      state: {
        groups: sessionViewGroups(store, {
          registeredCwds,
          hiddenWorkspaceCwds: new Set(),
          archivedIds,
          lockedIds,
        }),
      },
    });
  }

  function entryOf(sessionId: string): DemoEntry {
    return metadata.get(sessionId) ?? UNARCHIVED;
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
    if (
      request.type === "setSessionLock" &&
      typeof request.sessionId === "string" &&
      typeof request.locked === "boolean"
    ) {
      const entry = entryOf(request.sessionId);
      metadata.set(request.sessionId, { ...entry, locked: request.locked });
      postSessions();
      return;
    }
    if (request.type === "archiveSessions" && Array.isArray(request.sessionIds)) {
      for (const sessionId of request.sessionIds) {
        if (typeof sessionId !== "string") continue;
        const entry = entryOf(sessionId);
        if (entry.locked) continue; // the same host-side lock guard as the provider
        metadata.set(sessionId, { ...entry, archived: true });
      }
      postSessions();
      return;
    }
    if (request.type === "unarchiveSessions" && Array.isArray(request.sessionIds)) {
      for (const sessionId of request.sessionIds) {
        if (typeof sessionId !== "string") continue;
        metadata.set(sessionId, { ...entryOf(sessionId), archived: false });
      }
      postSessions();
      return;
    }
    if (request.type === "newSession" && typeof request.cwd === "string") {
      const session: SessionSummary = {
        sessionId: crypto.randomUUID(),
        filePath: "",
        cwd: request.cwd,
        displayName: "New Pi session",
        mtimeMs: Date.now(),
      };
      store = [session, ...store];
      metadata.set(session.sessionId, UNARCHIVED);
      postSessions();
      return;
    }
    if (request.type === "addWorkspace" && typeof request.path === "string") {
      // The catalog validates no real folder: an empty-cwd group appears as is.
      if (!registeredCwds.includes(request.path))
        registeredCwds = [...registeredCwds, request.path];
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
    metadata = new Map(
      [...SAMPLE_METADATA].map(([sessionId, entry]) => [
        sessionId,
        demoState === "sample" ? { ...entry } : { ...entry, archived: true },
      ]),
    );
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
