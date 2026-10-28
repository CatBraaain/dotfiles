import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { CACHE_TTL_MS, cacheFilePath, loadSnapshot, saveSnapshot } from "./cache";

const NOW = Date.parse("2026-06-17T12:00:00+09:00");
const STATE = {
  windowMinutes: 300,
  remaining: 80,
  resetsAt: new Date(NOW + 3_600_000).toISOString(),
};
let tempDir: string | undefined;

function tempPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), "model-route-cache-test-"));
  return join(tempDir, "usage.json");
}

afterEach(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("loadSnapshot", () => {
  it("keeps the complete successful snapshot for exactly five minutes", () => {
    const path = tempPath();
    const snapshot = { fetchedAt: NOW, states: new Map([["zai", STATE]]) };
    saveSnapshot(path, snapshot);
    assert.deepEqual(loadSnapshot(path, NOW + CACHE_TTL_MS), snapshot);
    assert.equal(loadSnapshot(path, NOW + CACHE_TTL_MS + 1), null);
  });

  it("preserves an empty successful snapshot", () => {
    const path = tempPath();
    const snapshot = { fetchedAt: NOW, states: new Map() };
    saveSnapshot(path, snapshot);
    assert.deepEqual(loadSnapshot(path, NOW), snapshot);
  });

  it("rejects a missing file", () => {
    assert.equal(loadSnapshot(tempPath(), NOW), null);
  });

  it.each([
    "not json",
    "null",
    "[]",
    JSON.stringify({ version: 1, entries: { zai: STATE } }),
    JSON.stringify({ version: 2, fetchedAt: "now", entries: {} }),
    JSON.stringify({ version: 2, fetchedAt: NOW, entries: null }),
    JSON.stringify({ version: 2, fetchedAt: NOW, entries: [] }),
    JSON.stringify({ version: 2, fetchedAt: NOW + 1, entries: {} }),
  ])("rejects malformed, legacy, or future snapshots: %s", (input) => {
    const path = tempPath();
    writeFileSync(path, input);
    assert.equal(loadSnapshot(path, NOW), null);
  });

  it("keeps a valid snapshot while treating invalid rows as unknown", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        fetchedAt: NOW,
        entries: {
          zai: STATE,
          bad: { remaining: "80", resetsAt: STATE.resetsAt },
          missing: null,
          invalidReset: { remaining: 80, resetsAt: "bad" },
        },
      }),
    );
    assert.deepEqual(loadSnapshot(path, NOW)?.states, new Map([["zai", STATE]]));
  });
});

describe("legacy duration facts", () => {
  it("keeps missing duration null without inferring a provider period", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        fetchedAt: NOW,
        entries: { zai: { remaining: 80, resetsAt: STATE.resetsAt } },
      }),
    );
    assert.deepEqual(loadSnapshot(path, NOW)?.states.get("zai"), {
      remaining: 80,
      resetsAt: STATE.resetsAt,
      windowMinutes: null,
    });
  });
});

describe("saveSnapshot", () => {
  it("replaces the entire snapshot instead of retaining stale provider rows", () => {
    const path = tempPath();
    saveSnapshot(path, { fetchedAt: NOW, states: new Map([["zai", STATE]]) });
    const next = { fetchedAt: NOW + 1, states: new Map([["command-code", STATE]]) };
    saveSnapshot(path, next);
    assert.deepEqual(loadSnapshot(path, NOW + 1), next);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.version, 2);
    assert.equal(saved.fetchedAt, NOW + 1);
    assert.deepEqual(Object.keys(saved.entries["command-code"]).sort(), [
      "remaining",
      "resetsAt",
      "windowMinutes",
    ]);
  });
});

describe("cacheFilePath", () => {
  it("prefers XDG_CACHE_HOME", () => {
    assert.equal(
      cacheFilePath({ XDG_CACHE_HOME: "/xdg", HOME: "/home/x" }),
      "/xdg/model-route/usage.json",
    );
  });
  it("uses the home cache directory by default", () => {
    assert.equal(cacheFilePath({ HOME: "/home/x" }), "/home/x/.cache/model-route/usage.json");
  });
});
