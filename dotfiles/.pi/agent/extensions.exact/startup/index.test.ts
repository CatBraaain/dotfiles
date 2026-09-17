import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import startupExtension, { startupScriptPath, type SpawnFn } from "./index";

interface FakeChild {
  errorListener: (() => void) | undefined;
  unrefCount: number;
  on(event: string, listener: () => void): void;
  unref(): void;
}

function fakeChild(): FakeChild & ChildProcess {
  const child: FakeChild = {
    errorListener: undefined,
    unrefCount: 0,
    on(event, listener) {
      if (event === "error") child.errorListener = listener;
    },
    unref() {
      child.unrefCount += 1;
    },
  };
  return child as unknown as FakeChild & ChildProcess;
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

function recordingSpawn(
  child: FakeChild & ChildProcess,
  throws = false,
): { spawnProcess: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnProcess: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    if (throws) throw new Error("spawn failed");
    return child;
  };
  return { spawnProcess, calls };
}

type SessionStartHandler = (event: { reason: string }) => Promise<void>;

function loadExtension(
  spawnProcess: SpawnFn,
): { sessionStart: SessionStartHandler | undefined } {
  let sessionStart: SessionStartHandler | undefined;
  startupExtension(
    {
      on: (name: string, handler: SessionStartHandler) => {
        if (name === "session_start") sessionStart = handler;
      },
    } as never,
    spawnProcess,
  );
  return { sessionStart };
}

async function startSession(
  spawnProcess: SpawnFn,
  reason: string,
): Promise<ReturnType<typeof loadExtension>> {
  const captured = loadExtension(spawnProcess);
  await captured.sessionStart?.({ reason });
  return captured;
}

describe("スクリプトのパス", () => {
  it("ホーム直下の .agents/startup を指す", () => {
    assert.equal(startupScriptPath("/home/u"), "/home/u/.agents/startup");
  });
});

describe("spawn 条件", () => {
  it("reason が startup のとき startup スクリプトを spawn する", async () => {
    const { spawnProcess, calls } = recordingSpawn(fakeChild());
    await startSession(spawnProcess, "startup");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, startupScriptPath());
    assert.deepEqual(calls[0]?.args, []);
  });

  for (const reason of ["new", "resume", "fork", "reload"]) {
    it(`reason が ${reason} のときは spawn しない`, async () => {
      const { spawnProcess, calls } = recordingSpawn(fakeChild());
      await startSession(spawnProcess, reason);
      assert.equal(calls.length, 0);
    });
  }
});

describe("spawn オプション", () => {
  it("detached かつ stdio ignore で起動する", async () => {
    const { spawnProcess, calls } = recordingSpawn(fakeChild());
    await startSession(spawnProcess, "startup");
    assert.equal(calls[0]?.options.detached, true);
    assert.equal(calls[0]?.options.stdio, "ignore");
  });
});

describe("子プロセスの扱い", () => {
  it("unref して pi の終了を妨げない", async () => {
    const child = fakeChild();
    const { spawnProcess } = recordingSpawn(child);
    await startSession(spawnProcess, "startup");
    assert.equal(child.unrefCount, 1);
  });

  it("async の error イベントを握り潰すリスナーを登録する", async () => {
    const child = fakeChild();
    const { spawnProcess } = recordingSpawn(child);
    await startSession(spawnProcess, "startup");
    assert.ok(child.errorListener, "error リスナーが未登録");
    assert.doesNotThrow(() => child.errorListener?.());
  });
});

describe("失敗時", () => {
  it("spawn が throw してもセッション開始を壊さない", async () => {
    const { spawnProcess } = recordingSpawn(fakeChild(), true);
    const captured = await startSession(spawnProcess, "startup");
    assert.ok(captured.sessionStart, "handler は登録されたまま");
  });
});
