import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { it } from "bun:test";

it("reports no session files and exits with 1 for an empty sessions directory", () => {
  withStatsHome(({ runStats }) => {
    const result = runStats();
    const stderr = result.stderr.toString();

    assert.equal(result.exitCode, 1, stderr);
    assert.equal(result.stdout.toString(), "");
    assert.match(stderr, /^pi-stats: indexed 0 new\/changed, removed 0, total 0 files$/m);
    assert.match(stderr, /^pi-stats: no session files.*$/m);
  });
});

it("removes and reports stale cache rows when the last session file is deleted", () => {
  withStatsHome(({ sessionsRoot, dbPath, runStats }) => {
    const projectDir = join(sessionsRoot, "--project--");
    const sessionPath = join(projectDir, "session.jsonl");
    mkdirSync(projectDir);
    const session = {
      type: "session",
      version: 3,
      id: "session",
      timestamp: "2026-01-01T00:00:00Z",
    };
    writeFileSync(sessionPath, `${JSON.stringify(session)}\n`);

    const indexed = runStats();
    assert.equal(indexed.exitCode, 0, indexed.stderr.toString());
    assert.match(indexed.stdout.toString(), /^events: 0,/);
    assert.match(
      indexed.stderr.toString(),
      /^pi-stats: indexed 1 new\/changed, removed 0, total 1 files$/m,
    );
    unlinkSync(sessionPath);

    const refreshed = runStats();
    assert.equal(refreshed.exitCode, 1, refreshed.stderr.toString());
    assert.match(
      refreshed.stderr.toString(),
      /^pi-stats: indexed 0 new\/changed, removed 1, total 0 files$/m,
    );
    const cache = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual(cache.query("SELECT path FROM sessions").all(), []);
    } finally {
      cache.close();
    }
  });
});

interface StatsHome {
  sessionsRoot: string;
  dbPath: string;
  runStats: () => ReturnType<typeof spawnStats>;
}

function withStatsHome(check: (fixture: StatsHome) => void): void {
  const home = mkdtempSync(join(tmpdir(), "pi-stats-cli-"));
  try {
    const sessionsRoot = join(home, ".pi", "agent", "sessions");
    const dbPath = join(home, "stats.db");
    mkdirSync(sessionsRoot, { recursive: true });
    check({ sessionsRoot, dbPath, runStats: () => spawnStats(home, dbPath) });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function spawnStats(home: string, dbPath: string) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "main.ts"), "stats", "--db", dbPath],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    },
  );
}
