import { vi } from "vitest";
import type { PiRuntime, TmuxClient, TmuxRuntimeStore } from "../src/tmux";
import type { PiMux, PiMuxSession, PiSession } from "../src/piMux";

export function fakeRuntimes() {
  const live = new Map<string, PiRuntime>();
  const phases = new Map<string, string | null>();
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
    list: vi.fn(async (): Promise<PiMuxSession[]> =>
      [...live.values()].map((runtime) => ({
        id: runtime.sessionId,
        cwd: runtime.cwd,
        file: null,
        state: phases.get(runtime.sessionId) ?? null,
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
    stop: vi.fn(async (sessionId: string) => {
      const target = live.get(sessionId)?.target;
      live.delete(sessionId);
      return target;
    }),
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
    phases,
    client,
  };
}
