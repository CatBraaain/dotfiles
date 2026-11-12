import { describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HistoryTitleCache } from "./history-titles";

const temporaryRoot = "/tmp/work/dotfiles/pi-mux-title-race-tests";

describe("history title read consistency", () => {
  it("does not save a title when the original file changes during the read", () => {
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
      const titles = new HistoryTitleCache();
      const duringUpdate = titles.resolveTitle(file);
      assert.equal(updated, true);
      assert.equal(duringUpdate, "Before update");
      const cacheDirectory = join(directory, "cache", "pi-mux", "history-titles");
      assert.deepEqual(fs.readdirSync(cacheDirectory), []);
      read.mockRestore();
      assert.equal(titles.resolveTitle(file), "After update");
      assert.equal(fs.readdirSync(cacheDirectory).length, 1);
      assert.equal(titles.resolveTitle(file), "After update");
    } finally {
      read.mockRestore();
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
