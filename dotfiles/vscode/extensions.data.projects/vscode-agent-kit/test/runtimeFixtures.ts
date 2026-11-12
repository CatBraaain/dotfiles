import { vi } from "vitest";
import type {
  PiMux,
  PiMuxCurrentSession,
  PiMuxHistoryEntry,
  PiMuxWorkspace,
  PiRuntime,
  PiSession,
} from "../src/piMux";

/** CLI-shaped runtime fixture: one tmux client whose attachment the mocks move
 * between sessions through `current` and `switch`, mirroring pi-mux behavior. */
export function fakeRuntimes() {
  const live = new Map<string, PiRuntime>();
  const phases = new Map<string, string | null>();
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
    newSession: vi.fn(async (cwd: string) => {
      const sessionId = `new-${muxMocks.newSession.mock.calls.length}`;
      live.set(sessionId, { sessionId, cwd, target: `pi-${sessionId}` });
      return sessionId;
    }),
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
    switch: vi.fn(async (sessionId: string, clientPid?: number): Promise<boolean> => {
      if (!clientMatches(clientPid) || !live.has(sessionId)) return false;
      client.attachedId = sessionId;
      return true;
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
      [...history.values()].sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file)),
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
    temporary,
    emptyIds,
    history,
    client,
  };
}
