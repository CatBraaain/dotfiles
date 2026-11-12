import { describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HistorySummaryCache } from "./history-summary";

const temporaryRoot = "/tmp/work/dotfiles/pi-mux-summary-race-tests";

describe("history summary read consistency", () => {
  it("does not save a summary when the original file changes during the read", () => {
    const directory = join(temporaryRoot, randomUUID());
    const file = join(directory, "session.jsonl");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_info", name: "Before update" }),
        JSON.stringify({ type: "message", text: "x".repeat(1024 * 1024) }),
        "",
      ].join("\n"),
    );
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(directory, "cache");
    const originalReadSync = fs.readSync;
    let updated = false;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      const count: number = Reflect.apply(originalReadSync, fs, args);
      if (!updated) {
        fs.appendFileSync(
          file,
          JSON.stringify({ type: "session_info", name: "After update" }) + "\n",
        );
        updated = true;
      }
      return count;
    });
    try {
      const summaries = new HistorySummaryCache();
      const duringUpdate = summaries.resolve(file);
      assert.equal(updated, true);
      assert.deepEqual(duringUpdate, { title: "Before update", mtime: null });
      const cacheDirectory = join(directory, "cache", "pi-mux", "history-titles");
      assert.deepEqual(fs.readdirSync(cacheDirectory), []);
      read.mockRestore();
      assert.deepEqual(summaries.resolve(file), { title: "After update", mtime: null });
      assert.equal(fs.readdirSync(cacheDirectory).length, 1);
      assert.deepEqual(summaries.resolve(file), { title: "After update", mtime: null });
    } finally {
      read.mockRestore();
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves the physically last message or compaction timestamp as the modified time", () => {
    const directory = join(temporaryRoot, randomUUID());
    const file = join(directory, "session.jsonl");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "s", timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", timestamp: "2026-01-02T00:00:00.000Z" }),
        JSON.stringify({ type: "session_info", name: "Named" }),
        JSON.stringify({ type: "custom", timestamp: "2026-01-03T00:00:00.000Z" }),
        JSON.stringify({ type: "message", timestamp: "2026-01-01T12:00:00.000Z" }),
      ].join("\n") + "\n",
    );
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(directory, "cache");
    try {
      const summaries = new HistorySummaryCache();
      assert.deepEqual(summaries.resolve(file), {
        title: "Named",
        mtime: Date.parse("2026-01-01T12:00:00.000Z"),
      });
    } finally {
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
