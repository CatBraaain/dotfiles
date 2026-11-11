import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import type { SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
  KEEP_COUNT,
  collectArchiveTargets,
  executeArchives,
  runSessionGc,
  type SessionGcDeps,
} from "./index.ts";

const NOW = 1_700_000_000_000;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface TestRig {
  deps: SessionGcDeps;
  sessionsDir: string;
  agentDir: string;
}

function rig(keepCount?: number): TestRig {
  const dir = mkdtempSync(join(tmpdir(), "session-gc-test-"));
  tempDirs.push(dir);
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  return {
    deps: {
      sessionsDir: () => sessionsDir,
      keepCount,
    },
    sessionsDir,
    agentDir: dir,
  };
}

/** Creates `<sessionsDir>/<projectDir>/<name>` with mtime set to `mtime`. */
function writeSession(rigRig: TestRig, projectDir: string, name: string, mtime: number): string {
  const project = join(rigRig.sessionsDir, projectDir);
  mkdirSync(project, { recursive: true });
  const file = join(project, name);
  writeFileSync(file, "{}");
  utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

function startupEvent(reason: SessionStartEvent["reason"] = "startup"): SessionStartEvent {
  return { type: "session_start", reason };
}

describe("collectArchiveTargets", () => {
  it("keep 件を残し、それより古い .jsonl を archive 対象にする", () => {
    const testRig = rig();
    const oldFile = writeSession(testRig, "--home-u-proj--", "old.jsonl", NOW - 3_000);
    const midFile = writeSession(testRig, "--home-u-proj--", "mid.jsonl", NOW - 2_000);
    const newFile = writeSession(testRig, "--home-u-proj--", "new.jsonl", NOW - 1_000);

    const targets = collectArchiveTargets(testRig.sessionsDir, 2);

    const archivedFrom = targets.map((target) => target.from);
    assert.deepEqual(archivedFrom, [oldFile]);
    const firstTarget = targets[0];
    assert.ok(firstTarget);
    const expectedTo = join(testRig.sessionsDir, "--home-u-proj--", "archive", "old.jsonl");
    assert.equal(firstTarget.to, expectedTo);
    assert.ok(existsSync(midFile));
    assert.ok(existsSync(newFile));
  });

  it("keep 件以下なら対象ゼロ", () => {
    const testRig = rig();
    writeSession(testRig, "--home-u-proj--", "only.jsonl", NOW);

    const targets = collectArchiveTargets(testRig.sessionsDir, KEEP_COUNT);

    const targetCount = targets.length;
    assert.equal(targetCount, 0);
  });

  it("archive や subagents などサブディレクトリ内の .jsonl は対象外", () => {
    const testRig = rig();
    writeSession(testRig, "--home-u-proj--", "new.jsonl", NOW);
    writeSession(testRig, "--home-u-proj--/subagents", "child.jsonl", NOW - 5_000);
    writeSession(testRig, "--home-u-proj--/archive", "already-archived.jsonl", NOW - 5_000);

    const targets = collectArchiveTargets(testRig.sessionsDir, KEEP_COUNT);

    const targetCount = targets.length;
    assert.equal(targetCount, 0);
  });

  it("プロジェクトごとに keep 件を適用する", () => {
    const testRig = rig();
    writeSession(testRig, "--home-u-a--", "old.jsonl", NOW - 2_000);
    writeSession(testRig, "--home-u-a--", "new.jsonl", NOW - 1_000);
    writeSession(testRig, "--home-u-b--", "old.jsonl", NOW - 2_000);
    writeSession(testRig, "--home-u-b--", "new.jsonl", NOW - 1_000);

    const targets = collectArchiveTargets(testRig.sessionsDir, 1);

    const archivedFrom = targets.map((target) => target.from);
    assert.equal(archivedFrom.length, 2);
    assert.ok(archivedFrom.every((path) => path.endsWith("old.jsonl")));
  });

  it(".jsonl 以外のファイルは無視する", () => {
    const testRig = rig();
    writeSession(testRig, "--home-u-proj--", "keep.jsonl", NOW - 1_000);
    writeSession(testRig, "--home-u-proj--", "old.txt", NOW - 5_000);

    const targets = collectArchiveTargets(testRig.sessionsDir, 1);

    const targetCount = targets.length;
    assert.equal(targetCount, 0);
  });
});

describe("executeArchives", () => {
  it("対象を archive/ へ移動し、内容を保つ", () => {
    const testRig = rig();
    const file = writeSession(testRig, "--home-u-proj--", "old.jsonl", NOW);
    writeFileSync(file, '{"type":"session"}');

    const targets = collectArchiveTargets(testRig.sessionsDir, 0);
    const archivedCount = executeArchives(targets);

    assert.equal(archivedCount, 1);
    const movedFile = join(testRig.sessionsDir, "--home-u-proj--", "archive", "old.jsonl");
    assert.ok(existsSync(movedFile));
    const movedContent = readFileSync(movedFile, "utf8");
    assert.equal(movedContent, '{"type":"session"}');
    assert.ok(!existsSync(file));
  });

  it("移動元が無くても続行し、成功数だけ返す", () => {
    const testRig = rig(0);
    const removedFile = writeSession(testRig, "--home-u-proj--", "gone.jsonl", NOW);
    const keptFile = writeSession(testRig, "--home-u-proj--", "kept.jsonl", NOW - 1_000);
    writeFileSync(keptFile, '{"type":"session"}');

    const targets = collectArchiveTargets(testRig.sessionsDir, 0);
    rmSync(removedFile);
    const archivedCount = executeArchives(targets);

    assert.equal(archivedCount, 1);
    const archivedKeptFile = join(testRig.sessionsDir, "--home-u-proj--", "archive", "kept.jsonl");
    assert.ok(existsSync(archivedKeptFile));
  });
});

describe("runSessionGc execution conditions", () => {
  it("leaves sessions untouched for every non-startup reason", () => {
    const testRig = rig(0);
    const file = writeSession(testRig, "--home-u-proj--", "old.jsonl", NOW);
    const reasons = ["reload", "new", "resume", "fork"] as const;

    for (const reason of reasons) {
      const archivedCount = runSessionGc({ reason }, testRig.deps);
      assert.equal(archivedCount, 0, reason);
      assert.ok(existsSync(file), reason);
    }
    const projectEntries = readdirSync(join(testRig.sessionsDir, "--home-u-proj--"));
    assert.deepEqual(projectEntries, ["old.jsonl"]);
  });

  it("archives on startup without creating a timestamp", () => {
    const testRig = rig(1);
    writeSession(testRig, "--home-u-proj--", "old.jsonl", NOW - 1_000);
    writeSession(testRig, "--home-u-proj--", "new.jsonl", NOW);

    const archivedCount = runSessionGc(startupEvent(), testRig.deps);

    assert.equal(archivedCount, 1);
    const agentEntries = readdirSync(testRig.agentDir);
    assert.deepEqual(agentEntries, ["sessions"]);
  });

  it("archives newly added sessions on consecutive startups and keeps the latest 50", () => {
    const testRig = rig();
    for (let index = 0; index <= KEEP_COUNT; index++) {
      writeSession(testRig, "--home-u-proj--", `s${index}.jsonl`, NOW + index * 1_000);
    }

    const firstArchivedCount = runSessionGc(startupEvent(), testRig.deps);
    assert.equal(firstArchivedCount, 1);
    writeSession(testRig, "--home-u-proj--", "new.jsonl", NOW + (KEEP_COUNT + 1) * 1_000);

    const secondArchivedCount = runSessionGc(startupEvent(), testRig.deps);

    assert.equal(secondArchivedCount, 1);
    const projectDir = join(testRig.sessionsDir, "--home-u-proj--");
    const remaining = readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"));
    assert.equal(remaining.length, KEEP_COUNT);
    assert.ok(remaining.includes("new.jsonl"));
    const archived = readdirSync(join(projectDir, "archive")).sort();
    assert.deepEqual(archived, ["s0.jsonl", "s1.jsonl"]);
  });

  it("ignores and preserves a legacy timestamp", () => {
    const testRig = rig(1);
    const timestampFile = join(testRig.agentDir, ".session-gc-timestamp");
    const legacyTimestamp = String(Date.now());
    writeFileSync(timestampFile, legacyTimestamp);
    writeSession(testRig, "--home-u-proj--", "old.jsonl", NOW - 1_000);
    writeSession(testRig, "--home-u-proj--", "new.jsonl", NOW);

    const archivedCount = runSessionGc(startupEvent(), testRig.deps);

    assert.equal(archivedCount, 1);
    const storedTimestamp = readFileSync(timestampFile, "utf8");
    assert.equal(storedTimestamp, legacyTimestamp);
  });
});

describe("runSessionGc の退避", () => {
  it("keep 件を残し、古いものだけ archive へ移動する", () => {
    const testRig = rig(2);
    for (let index = 0; index < 3; index++) {
      writeSession(testRig, "--home-u-proj--", `s${index}.jsonl`, NOW - (3 - index) * 1_000);
    }

    const archivedCount = runSessionGc(startupEvent(), testRig.deps);

    assert.equal(archivedCount, 1);
    const remaining = readdirSync(join(testRig.sessionsDir, "--home-u-proj--"))
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    assert.deepEqual(remaining, ["s1.jsonl", "s2.jsonl"]);
    const archived = readdirSync(join(testRig.sessionsDir, "--home-u-proj--", "archive"));
    assert.deepEqual(archived, ["s0.jsonl"]);
  });

  it("returns zero without writing files when sessionsDir is missing", () => {
    const testRig = rig(2);
    rmSync(testRig.sessionsDir, { recursive: true, force: true });

    const archivedCount = runSessionGc(startupEvent(), testRig.deps);

    assert.equal(archivedCount, 0);
    const agentEntries = readdirSync(testRig.agentDir);
    assert.deepEqual(agentEntries, []);
  });
});
