import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { apply, name, startupScriptPath, type SpawnFn } from "./index.ts";

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

describe("plugin 契約", () => {
  it("cordis 行 id と export name が一致する", () => {
    assert.equal(name, "startup");
  });
});

describe("スクリプトのパス", () => {
  it("ホーム直下の .agents/startup を指す", () => {
    assert.equal(startupScriptPath("/home/u"), "/home/u/.agents/startup");
  });
});

describe("spawn 条件", () => {
  it("apply で startup スクリプトを spawn する", () => {
    const { spawnProcess, calls } = recordingSpawn(fakeChild());
    apply({} as never, spawnProcess);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, startupScriptPath());
    assert.deepEqual(calls[0]?.args, []);
    assert.equal(calls[0]?.options.detached, true);
    assert.equal(calls[0]?.options.stdio, "ignore");
  });
});

describe("子プロセスの扱い", () => {
  it("unref して harness の終了を妨げない", () => {
    const child = fakeChild();
    const { spawnProcess } = recordingSpawn(child);
    apply({} as never, spawnProcess);
    assert.equal(child.unrefCount, 1);
  });

  it("async の error イベントを握り潰すリスナーを登録する", () => {
    const child = fakeChild();
    const { spawnProcess } = recordingSpawn(child);
    apply({} as never, spawnProcess);
    assert.ok(child.errorListener, "error リスナーが未登録");
    assert.doesNotThrow(() => child.errorListener?.());
  });
});

describe("失敗時", () => {
  it("spawn が throw しても harness 起動を壊さない", () => {
    const { spawnProcess } = recordingSpawn(fakeChild(), true);
    assert.doesNotThrow(() => apply({} as never, spawnProcess));
  });
});
