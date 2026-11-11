import { vi } from "vitest";
import type { PiRuntime, TmuxClient, TmuxRuntimeStore } from "../src/tmux";
import type { PiMux, PiMuxWorkspace, PiSession } from "../src/piMux";

export function fakeRuntimes() {
  const live = new Map<string, PiRuntime>();
  const phases = new Map<string, string | null>();
  const workspaces = new Set<string>();
  const files = new Map<string, string>();
  const titles = new Map<string, string | null>();
  const client = { pid: 123, name: "/dev/fixture", target: "" };
  const open = vi.fn((session: PiSession) => {
    const runtime = live.get(session.sessionId) ?? {
      ...session,
      target: `pi-${session.sessionId}`,
    };
    live.set(session.sessionId, runtime);
    client.target = runtime.target;
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
    }),
    list: vi.fn(async (): Promise<PiMuxWorkspace[]> =>
      [...new Set([...workspaces, ...[...live.values()].map(({ cwd }) => cwd)])].map((cwd) => ({
        cwd,
        sessions: [...live.values()]
          .filter((runtime) => runtime.cwd === cwd)
          .map((runtime) => ({
            id: runtime.sessionId,
            file: files.get(runtime.sessionId) ?? `/sessions/${runtime.sessionId}.jsonl`,
            state: phases.get(runtime.sessionId) ?? null,
            title: titles.get(runtime.sessionId) ?? null,
          })),
      })),
    ),
    aliveSessionIds: vi.fn(
      async (ids: readonly string[]): Promise<Set<string> | null> =>
        new Set(ids.filter((id) => live.has(id))),
    ),
  };
  const tmuxMocks = {
    socketPath: "/run/user/1000/pi-tmux/server.sock",
    resolveTarget: vi.fn(async (sessionId: string) => live.get(sessionId)?.target),
    resolveSession: vi.fn(async (target: string) => {
      const runtime = [...live.values()].find((entry) => entry.target === target);
      return runtime === undefined
        ? undefined
        : { ...runtime, file: `/sessions/${runtime.sessionId}.jsonl` };
    }),
    resolveClientSessionId: vi.fn(
      async (displayClient: TmuxClient) =>
        [...live.values()].find((entry) => entry.target === displayClient.target)?.sessionId,
    ),
    clients: vi.fn(async () => [client]),
    switchClient: vi.fn(async (_client: TmuxClient, runtime: PiRuntime) => {
      client.target = runtime.target;
    }),
  };
  return {
    store: tmuxMocks as unknown as TmuxRuntimeStore,
    mux: muxMocks as unknown as PiMux,
    mocks: { ...tmuxMocks, ...muxMocks, open },
    live,
    workspaces,
    files,
    titles,
    phases,
    client,
  };
}
