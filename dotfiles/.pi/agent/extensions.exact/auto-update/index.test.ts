import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { THROTTLE_MS, runAutoUpdate, type UpdateDeps } from "./index.ts";

const NOW = 1_700_000_000_000;

type Mode = ExtensionContext["mode"];

interface TestRig {
  deps: UpdateDeps;
  spawned: number[];
  timestampFile: string;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function rig(options: { now?: number; spawnOk?: boolean } = {}): TestRig {
  const dir = mkdtempSync(join(tmpdir(), "auto-update-test-"));
  tempDirs.push(dir);
  const timestampFile = join(dir, ".auto-update-timestamp");
  const spawned: number[] = [];
  const deps: UpdateDeps = {
    spawnUpdate: () => {
      if (options.spawnOk === false) return false;
      spawned.push(options.now ?? NOW);
      return true;
    },
    timestampFile: () => timestampFile,
    now: () => options.now ?? NOW,
  };
  return { deps, spawned, timestampFile };
}

function startEvent(reason: SessionStartEvent["reason"]): SessionStartEvent {
  return { type: "session_start", reason };
}

function runContext(mode: Mode): { mode: Mode } {
  return { mode };
}

describe("更新の実行条件", () => {
  const reasons = ["startup", "reload", "new", "resume", "fork"] as const;
  const modes = ["tui", "rpc", "json", "print"] as const;

  for (const reason of reasons) {
    for (const mode of modes) {
      const shouldUpdate = reason === "startup" && mode === "tui";
      it(`${reason} × ${mode} は${shouldUpdate ? "更新する" : "更新しない"}`, () => {
        const testRig = rig();
        runAutoUpdate(startEvent(reason), runContext(mode), testRig.deps);
        const spawnCount = testRig.spawned.length;
        assert.equal(spawnCount, shouldUpdate ? 1 : 0);
      });
    }
  }
});

describe("頻度制限（12時間）", () => {
  it("12時間以内の spawn 記録があるときは更新せず、記録を上書きしない", () => {
    const testRig = rig();
    const lastSpawnAt = NOW - THROTTLE_MS + 1_000;
    writeFileSync(testRig.timestampFile, String(lastSpawnAt));

    runAutoUpdate(startEvent("startup"), runContext("tui"), testRig.deps);

    const spawnCount = testRig.spawned.length;
    assert.equal(spawnCount, 0);
    const storedTimestamp = readFileSync(testRig.timestampFile, "utf8");
    assert.equal(storedTimestamp, String(lastSpawnAt));
  });

  it("12時間ちょうど経過したら更新する", () => {
    const testRig = rig();
    writeFileSync(testRig.timestampFile, String(NOW - THROTTLE_MS));

    runAutoUpdate(startEvent("startup"), runContext("tui"), testRig.deps);

    const spawnCount = testRig.spawned.length;
    assert.equal(spawnCount, 1);
  });

  it("記録がないときは更新し、spawn 成功時刻を書き込む", () => {
    const testRig = rig();

    runAutoUpdate(startEvent("startup"), runContext("tui"), testRig.deps);

    const spawnCount = testRig.spawned.length;
    assert.equal(spawnCount, 1);
    const storedTimestamp = readFileSync(testRig.timestampFile, "utf8");
    assert.equal(storedTimestamp, String(NOW));
  });

  it("spawn に失敗したら時刻を記録しない", () => {
    const testRig = rig({ spawnOk: false });

    runAutoUpdate(startEvent("startup"), runContext("tui"), testRig.deps);

    const spawnCount = testRig.spawned.length;
    assert.equal(spawnCount, 0);
    const timestampExists = existsSync(testRig.timestampFile);
    assert.equal(timestampExists, false);
  });
});
