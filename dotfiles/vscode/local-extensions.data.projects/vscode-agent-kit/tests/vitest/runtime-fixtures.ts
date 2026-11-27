import { vi } from "vitest";
import type {
  PiMux,
  PiMuxCurrentSession,
  PiMuxHistoryEntry,
  PiMuxLastRun,
  PiMuxViewTarget,
  PiMuxWorkspace,
  PiRuntime,
  PiSession,
} from "../../src/pi-mux";

/** CLI-shaped runtime fixture: one tmux client whose attachment the mocks move
 * between sessions through `current` and `switch`, mirroring pi-mux behavior. */
export function fakeRuntimes() {
  const live = new Map<string, PiRuntime>();
  const phases = new Map<string, string | null>();
  const settlements = new Map<string, PiMuxLastRun>();
  const workspaces = new Set<string>();
  const files = new Map<string, string>();
  const titles = new Map<string, string | null>();
  const temporary = new Set<string>();
  const emptyIds = new Set<string>();
  const history = new Map<string, PiMuxHistoryEntry>();
  const client = {
    pid: 123,
    parentPid: undefined as number | undefined,
    attachedId: undefined as string | undefined,
  };
  const open = vi.fn((session: PiSession) => {
    if (session.temporary) {
      if (!live.has(session.sessionId)) temporary.add(session.sessionId);
    } else temporary.delete(session.sessionId);
    const runtime = live.get(session.sessionId) ?? {
      ...session,
      target: `pi-${session.sessionId}`,
    };
    live.set(session.sessionId, runtime);
    client.attachedId = runtime.sessionId;
    return runtime;
  });
  const muxMocks = {
    viewTarget: vi.fn(
      async (_sessionId: string, _file: string): Promise<PiMuxViewTarget | undefined> => undefined,
    ),
    recordView: vi.fn(
      async (_sessionId: string, _target: PiMuxViewTarget, _viewedAtMs: number) => {},
    ),
    registerWorkspace: vi.fn(async (cwd: string) => {
      workspaces.add(cwd);
    }),
    unregisterWorkspace: vi.fn(async (cwd: string) => {
      for (const [id, runtime] of live) {
        if (runtime.cwd !== cwd) continue;
        live.delete(id);
        temporary.delete(id);
        emptyIds.delete(id);
      }
      workspaces.delete(cwd);
    }),
    newSession: vi.fn(async (cwd: string) => {
      const sessionId = `new-${muxMocks.newSession.mock.calls.length}`;
      live.set(sessionId, { sessionId, cwd, target: `pi-${sessionId}` });
      emptyIds.add(sessionId);
      workspaces.add(cwd);
      return sessionId;
    }),
    reloadSession: vi.fn(async (_sessionId: string) => {}),
    closeSession: vi.fn(async (sessionId: string) => {
      live.delete(sessionId);
      temporary.delete(sessionId);
    }),
    closeTemporarySession: vi.fn(async (sessionId: string) => {
      if (!temporary.has(sessionId)) return;
      live.delete(sessionId);
      temporary.delete(sessionId);
    }),
    list: vi.fn(async (): Promise<PiMuxWorkspace[]> =>
      [...new Set([...workspaces, ...[...live.values()].map(({ cwd }) => cwd)])].map((cwd) => ({
        cwd,
        sessions: [...live.values()]
          .filter((runtime) => runtime.cwd === cwd && !emptyIds.has(runtime.sessionId))
          .map((runtime) => ({
            id: runtime.sessionId,
            file: files.get(runtime.sessionId) ?? `/sessions/${runtime.sessionId}.jsonl`,
            state: phases.get(runtime.sessionId) ?? null,
            title: titles.get(runtime.sessionId) ?? null,
            ...(settlements.has(runtime.sessionId)
              ? { lastRun: settlements.get(runtime.sessionId) }
              : {}),
            ...(temporary.has(runtime.sessionId) ? { temporary: true as const } : {}),
          })),
        empty: [...live.values()]
          .filter((runtime) => runtime.cwd === cwd && emptyIds.has(runtime.sessionId))
          .map((runtime) => ({
            id: runtime.sessionId,
            file: files.get(runtime.sessionId) ?? `/sessions/${runtime.sessionId}.jsonl`,
            ...(temporary.has(runtime.sessionId) ? { temporary: true as const } : {}),
          })),
      })),
    ),
    aliveSessionIds: vi.fn(
      async (ids: readonly string[]): Promise<Set<string> | null> =>
        new Set(ids.filter((id) => live.has(id))),
    ),
    switch: vi.fn(async (sessionId: string, clientPid?: number): ReturnType<PiMux["switch"]> => {
      if (!live.has(sessionId)) return "target-missing";
      if (!clientMatches(clientPid)) return "client-missing";
      client.attachedId = sessionId;
      return "switched";
    }),
    current: vi.fn(async (clientPid?: number): Promise<PiMuxCurrentSession | undefined> => {
      if (!clientMatches(clientPid) || client.attachedId === undefined) return undefined;
      const runtime = live.get(client.attachedId);
      if (runtime === undefined) return undefined;
      return {
        id: runtime.sessionId,
        cwd: runtime.cwd,
        file: files.get(runtime.sessionId) ?? `/sessions/${runtime.sessionId}.jsonl`,
        target: runtime.target,
      };
    }),
    history: vi.fn(async (): Promise<PiMuxHistoryEntry[]> =>
      [...history.values()].map((entry) => ({ ...entry })),
    ),
  };
  function clientMatches(clientPid: number | undefined): boolean {
    return client.pid === clientPid || client.parentPid === clientPid;
  }
  return {
    mux: muxMocks as unknown as PiMux,
    mocks: { ...muxMocks, open },
    live,
    workspaces,
    files,
    titles,
    phases,
    settlements,
    temporary,
    emptyIds,
    history,
    client,
  };
}
