import { vi } from "vitest";
import type { PiLaunch, PiRuntime, TmuxClient, TmuxRuntimeStore } from "../src/tmux";

export function fakeRuntimes() {
  const live = new Map<string, PiRuntime>();
  const client = { pid: 123, name: "/dev/fixture", target: "" };
  const store = {
    socketName: "fixture-socket",
    executable: "tmux",
    connectionArgs: ["-L", "fixture-socket", "-f", "/dev/null"],
    ensure: vi.fn(async (launch: PiLaunch) => {
      const runtime = live.get(launch.sessionId) ?? {
        sessionId: launch.sessionId,
        cwd: launch.cwd,
        target: `pi-${launch.sessionId}`,
      };
      live.set(launch.sessionId, runtime);
      return runtime;
    }),
    stop: vi.fn(async (sessionId: string) => {
      live.delete(sessionId);
      return `pi-${sessionId}`;
    }),
    isAlive: vi.fn(async (runtime: PiRuntime) => live.has(runtime.sessionId)),
    aliveSessionIds: vi.fn(
      async (sessionIds: readonly string[]): Promise<Set<string> | null> =>
        new Set(sessionIds.filter((sessionId) => live.has(sessionId))),
    ),
    clients: vi.fn(async () => [client]),
    switchClient: vi.fn(async (_client: TmuxClient, runtime: PiRuntime) => {
      client.target = runtime.target;
    }),
  };
  return { store: store as unknown as TmuxRuntimeStore, mocks: store, live, client };
}
