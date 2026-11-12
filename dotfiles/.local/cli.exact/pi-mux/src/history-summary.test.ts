import { describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HistorySummaryCache } from "./history-summary";

const temporaryRoot = "/tmp/work/dotfiles/pi-mux-summary-race-tests";

function writeSummaryFixture(entries: unknown[]): { file: string; cacheHome: string } {
  const directory = join(temporaryRoot, randomUUID());
  const file = join(directory, "session.jsonl");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { file, cacheHome: join(directory, "cache") };
}

function resolveTitleIsolated(cacheHome: string, file: string): string | null {
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome;
  try {
    return new HistorySummaryCache().resolve(file).title;
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
  }
}

function userMessage(content: unknown, id = "m1"): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content },
  };
}

function assistantMessage(content: unknown): unknown {
  return {
    type: "message",
    id: "a1",
    parentId: "m1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "assistant", content },
  };
}

function sessionInfo(name: unknown): unknown {
  return {
    type: "session_info",
    id: "s1",
    parentId: null,
    timestamp: "2026-01-01T00:00:02.000Z",
    name,
  };
}

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

describe("history first user message fallback", () => {
  it("extracts a string user message as the title", () => {
    const { file, cacheHome } = writeSummaryFixture([userMessage("fix the build")]);
    assert.equal(resolveTitleIsolated(cacheHome, file), "fix the build");
  });

  it("joins array text blocks with a single space and skips non-text blocks", () => {
    const { file, cacheHome } = writeSummaryFixture([
      userMessage([
        { type: "toolCall", name: "bash", arguments: {} },
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ]);
    assert.equal(resolveTitleIsolated(cacheHome, file), "hello world");
  });

  it("skips empty text entries and non-user messages until a usable user message", () => {
    const { file, cacheHome } = writeSummaryFixture([
      userMessage(""),
      userMessage([{ type: "text", text: "   " }], "m2"),
      userMessage(42, "m3"),
      assistantMessage("assistant reply"),
      { type: "message", id: "m5", parentId: null, message: { role: "user" } },
      { type: "message", id: "m6", parentId: null, text: "flat message" },
      userMessage("actual first message", "m7"),
    ]);
    assert.equal(resolveTitleIsolated(cacheHome, file), "actual first message");
  });

  it("collapses consecutive whitespace including newlines into single spaces", () => {
    const { file, cacheHome } = writeSummaryFixture([
      userMessage([{ type: "text", text: "  fix\n\n   the\t" }, { type: "text", text: "\nbuild  " }]),
    ]);
    assert.equal(resolveTitleIsolated(cacheHome, file), "fix the build");
  });

  it("truncates to 80 code points counting surrogate pairs as one", () => {
    const { file, cacheHome } = writeSummaryFixture([userMessage("🙂".repeat(81) + "x")]);
    assert.equal(resolveTitleIsolated(cacheHome, file), "🙂".repeat(80));
  });

  it("keeps a title at or below 80 code points unchanged", () => {
    const exactlyEighty = "a".repeat(79) + "🙂";
    const { file, cacheHome } = writeSummaryFixture([userMessage(exactlyEighty)]);
    assert.equal(resolveTitleIsolated(cacheHome, file), exactlyEighty);
  });

  it("prefers the last session_info name over the first user message", () => {
    const { file, cacheHome } = writeSummaryFixture([
      sessionInfo("older name"),
      userMessage("first message"),
      sessionInfo("final name"),
    ]);
    assert.equal(resolveTitleIsolated(cacheHome, file), "final name");
  });

  it("falls back to the first user message after an explicit name clear", () => {
    const { file, cacheHome } = writeSummaryFixture([
      sessionInfo("cleared name"),
      userMessage("fallback after clear"),
      sessionInfo("  "),
    ]);
    assert.equal(resolveTitleIsolated(cacheHome, file), "fallback after clear");
  });

  it("lets a later session_info name replace a cached first-message title", () => {
    const { file, cacheHome } = writeSummaryFixture([userMessage("first message title")]);
    assert.equal(resolveTitleIsolated(cacheHome, file), "first message title");
    const cacheDirectory = join(cacheHome, "pi-mux", "history-titles");
    const [cached] = fs.readdirSync(cacheDirectory);
    assert.ok(cached);
    assert.equal(
      JSON.parse(fs.readFileSync(join(cacheDirectory, cached), "utf8")).title,
      "first message title",
    );
    fs.appendFileSync(file, JSON.stringify(sessionInfo("Named later")) + "\n");
    assert.equal(resolveTitleIsolated(cacheHome, file), "Named later");
    assert.equal(resolveTitleIsolated(cacheHome, file), "Named later");
  });
});
