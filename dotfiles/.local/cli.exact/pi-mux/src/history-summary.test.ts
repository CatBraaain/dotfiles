import { describe, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { HistorySummaryCache, readSessionLastRun } from "./history-summary";

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

describe("latest run lookup", () => {
  const sessionId = "session";
  const knownRun = { atMs: 200, aborted: false };
  const header = { type: "session", id: sessionId };
  function runEntry(run: { atMs: number; aborted: boolean }) {
    return { type: "custom", customType: "pi-mux-last-run", data: { sessionId, ...run } };
  }

  it("retries a short read and returns the new final record", () => {
    const { file } = writeSummaryFixture([header, runEntry(knownRun)]);
    const newest = { atMs: 201, aborted: true };
    const originalReadSync = fs.readSync;
    let interrupted = false;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      if (!interrupted && Number(args[3]) > 1024 && args[4] === 0) {
        interrupted = true;
        fs.appendFileSync(file, JSON.stringify(runEntry(newest)) + "\n");
        return 0;
      }
      return Reflect.apply(originalReadSync, fs, args);
    });
    try {
      fs.appendFileSync(file, JSON.stringify(userMessage("z".repeat(2048))) + "\n");
      assert.deepEqual(readSessionLastRun(file, sessionId), newest);
      assert.equal(interrupted, true);
    } finally {
      read.mockRestore();
      fs.rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("excludes records before the scan window but reads a recent record in a large file", () => {
    const { file } = writeSummaryFixture([header, runEntry(knownRun)]);
    try {
      fs.truncateSync(file, 32 * 1024 * 1024);
      assert.equal(readSessionLastRun(file, sessionId), undefined);
      fs.appendFileSync(file, "\n" + JSON.stringify(runEntry(knownRun)) + "\n");
      assert.deepEqual(readSessionLastRun(file, sessionId), knownRun);
    } finally {
      fs.rmSync(dirname(file), { recursive: true, force: true });
    }
  });
});

describe("history summary read consistency", () => {
  it("re-resolves a file appended to during reverse title lookup and saves only the stable result", () => {
    const directory = join(temporaryRoot, randomUUID());
    const file = join(directory, "session.jsonl");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_info", name: "Before update" }),
        JSON.stringify({ type: "message", text: "x".repeat(1024 * 1024) }),
        JSON.stringify(assistantMessage("Last activity")),
        "",
      ].join("\n"),
    );
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(directory, "cache");
    const originalReadSync = fs.readSync;
    const originalSize = fs.statSync(file).size;
    let updated = false;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      const count: number = Reflect.apply(originalReadSync, fs, args);
      const position = Number(args[4]);
      const isReverseReadBeforeTail = position > 0 && position + count < originalSize;
      if (!updated && isReverseReadBeforeTail) {
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
      const expected = { title: "After update", mtime: Date.parse("2026-01-01T00:00:01.000Z") };
      assert.deepEqual(duringUpdate, expected);
      const cacheDirectory = join(directory, "cache", "pi-mux", "history-titles");
      const [cacheFile, ...otherCacheFiles] = fs.readdirSync(cacheDirectory);
      assert.ok(cacheFile);
      assert.deepEqual(otherCacheFiles, []);
      const { title, mtime } = JSON.parse(fs.readFileSync(join(cacheDirectory, cacheFile), "utf8"));
      assert.deepEqual({ title, mtime }, expected);
    } finally {
      read.mockRestore();
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("re-resolves the replacement when the path is swapped after the descriptor stat", () => {
    const directory = join(temporaryRoot, randomUUID());
    const file = join(directory, "session.jsonl");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(sessionInfo("Before replacement"))}\n`);
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(directory, "cache");
    const originalStatSync = fs.statSync;
    let replaced = false;
    const stat = spyOn(fs, "statSync").mockImplementation((...args: unknown[]) => {
      if (!replaced && args[0] === file) {
        const replacement = `${file}.replacement`;
        fs.writeFileSync(replacement, `${JSON.stringify(sessionInfo("After replacement"))}\n`);
        fs.renameSync(replacement, file);
        replaced = true;
      }
      return Reflect.apply(originalStatSync, fs, args);
    });
    try {
      const duringReplacement = new HistorySummaryCache().resolve(file);
      assert.equal(replaced, true);
      assert.deepEqual(duringReplacement, { title: "After replacement", mtime: null });
      stat.mockRestore();
      assert.deepEqual(new HistorySummaryCache().resolve(file), {
        title: "After replacement",
        mtime: null,
      });
    } finally {
      stat.mockRestore();
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
  it("reuses a cache entry whose fingerprint joins the five identity fields", () => {
    const { file, cacheHome } = writeSummaryFixture([sessionInfo("Title in file")]);
    const stat = fs.statSync(file, { bigint: true });
    const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    const cacheDirectory = join(cacheHome, "pi-mux", "history-titles");
    fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    const entry = join(cacheDirectory, `${createHash("sha256").update(file).digest("hex")}.json`);
    fs.writeFileSync(
      entry,
      `${JSON.stringify({
        version: 5,
        file,
        fingerprint,
        title: "Title from cache",
        btime: null,
        mtime: null,
        header: {
          id: "cached-session",
          cwd: "/tmp",
          btime: Date.parse("2026-01-01T00:00:00.000Z"),
        },
      })}\n`,
      { mode: 0o600 },
    );
    assert.equal(resolveTitleIsolated(cacheHome, file), "Title from cache");
    assert.equal(resolveTitleIsolated(cacheHome, file), "Title from cache");
  });
});

describe("history header prefix reads", () => {
  const header = {
    type: "session",
    id: "header-session",
    cwd: "/tmp/header-workspace",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  const expectedHeader = {
    id: header.id,
    cwd: header.cwd,
    btime: Date.parse(header.timestamp),
  };
  const emptyPaddedHeader = JSON.stringify({ ...header, padding: "" });
  const cwdPrefix = JSON.stringify({ type: header.type, id: header.id, cwd: "" }).slice(0, -2);
  const splitCwd = "/" + "x".repeat(1023 - Buffer.byteLength(cwdPrefix) - 1) + "🙂";
  const cases = [
    {
      name: "a header followed by a body",
      contents: JSON.stringify(header) + "\n{}\n",
      cwd: header.cwd,
    },
    {
      name: "a header at EOF without a newline",
      contents: JSON.stringify(header),
      cwd: header.cwd,
    },
    { name: "a CRLF header", contents: JSON.stringify(header) + "\r\n{}\n", cwd: header.cwd },
    {
      name: "UTF-8 split across the prefix boundary",
      contents: JSON.stringify({ ...header, cwd: splitCwd }) + "\n",
      cwd: splitCwd,
    },
    ...[1023, 1024, 1025, 65535, 65536, 65537].map((bytes) => ({
      name: `a ${bytes}-byte header`,
      contents:
        JSON.stringify({
          ...header,
          padding: "x".repeat(bytes - Buffer.byteLength(emptyPaddedHeader)),
        }) + "\n{}\n",
      cwd: bytes <= 65536 ? header.cwd : null,
    })),
    {
      name: "a malformed first line before a valid header",
      contents: "{broken\n" + JSON.stringify(header) + "\n",
      cwd: null,
    },
    {
      name: "an empty first line before a valid header",
      contents: "\n" + JSON.stringify(header) + "\n",
      cwd: null,
    },
    { name: "an empty file", contents: "", cwd: null },
  ];

  for (const testCase of cases) {
    it(`preserves header parsing for ${testCase.name}`, () => {
      const { file, cacheHome } = writeSummaryFixture([]);
      fs.writeFileSync(file, testCase.contents);
      const previous = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = cacheHome;
      try {
        const actual = new HistorySummaryCache().resolveHistory(file, () => true);
        if (testCase.cwd === null) assert.equal(actual, undefined);
        else {
          assert.deepEqual(actual?.header, { ...expectedHeader, cwd: testCase.cwd });
          assert.equal(actual?.size, Buffer.byteLength(testCase.contents));
          assert.equal(actual?.title, null);
          assert.equal(actual?.mtime, null);
        }
      } finally {
        if (previous === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = previous;
        fs.rmSync(join(file, ".."), { recursive: true, force: true });
      }
    });
  }

  it("reads only a small prefix when a short header is rejected by the cwd filter", () => {
    const { file, cacheHome } = writeSummaryFixture([header, userMessage("x".repeat(65536))]);
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheHome;
    const originalRead = fs.readSync;
    let bytesRead = 0;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      const count: number = Reflect.apply(originalRead, fs, args);
      bytesRead += count;
      return count;
    });
    try {
      const actual = new HistorySummaryCache().resolveHistory(file, () => false);
      assert.equal(actual, undefined);
      assert.ok(bytesRead > 0 && bytesRead <= 1024);
      assert.deepEqual(fs.readdirSync(join(cacheHome, "pi-mux", "history-titles")), []);
    } finally {
      read.mockRestore();
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      fs.rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("assembles a UTF-8 header across short reads without decoding partial characters", () => {
    const { file, cacheHome } = writeSummaryFixture([{ ...header, cwd: splitCwd }]);
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheHome;
    const originalRead = fs.readSync;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      args[3] = Math.min(Number(args[3]), 7);
      return Reflect.apply(originalRead, fs, args);
    });
    try {
      const actual = new HistorySummaryCache().resolveHistory(file, () => true);
      assert.deepEqual(actual?.header, { ...expectedHeader, cwd: splitCwd });
    } finally {
      read.mockRestore();
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      fs.rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });
});

describe("history reverse line boundaries", () => {
  const chunkBytes = 256 * 1024;
  const headerLine = JSON.stringify({
    type: "session",
    id: "boundary-session",
    cwd: "/tmp/boundary-workspace",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const title = "Boundary 🙂";
  const messageLine = JSON.stringify(userMessage("First message"));
  const titleLine = JSON.stringify(sessionInfo(title));
  const bytesBeforeTitle = Buffer.byteLength([headerLine, messageLine, ""].join("\n"));
  const bytesThroughMarkerPrefix = Buffer.byteLength(
    titleLine.slice(0, titleLine.indexOf("session_info") + 5),
  );
  const olderTitleLine = JSON.stringify(sessionInfo("Older title"));
  const emptyPaddedTitle = JSON.stringify({ type: "session_info", padding: "", name: title });
  const characterOffset = Buffer.from(emptyPaddedTitle).indexOf(Buffer.from("🙂"));
  const paddingBytes =
    chunkBytes - 1 - bytesBeforeTitle - Buffer.byteLength(olderTitleLine + "\n") - characterOffset;
  const splitTitleLine = JSON.stringify({
    type: "session_info",
    padding: "x".repeat(paddingBytes),
    name: title,
  });
  const laterMessageLine = JSON.stringify(assistantMessage("Later message"));
  const cases = [
    { name: "CRLF lines", contents: [messageLine, titleLine, ""].join("\r\n") },
    {
      name: "an escaped title entry type before a later message",
      contents: [
        messageLine,
        titleLine.replace("session_info", "\\u0073ession_info"),
        laterMessageLine,
      ].join("\n"),
      mtime: "2026-01-01T00:00:01.000Z",
    },
    {
      name: "a title entry type split across the reverse chunk boundary",
      contents: [
        messageLine,
        "x".repeat(chunkBytes - bytesBeforeTitle - bytesThroughMarkerPrefix - 1),
        titleLine,
        laterMessageLine,
      ].join("\n"),
      mtime: "2026-01-01T00:00:01.000Z",
    },
    { name: "empty lines", contents: ["", messageLine, "", titleLine, "", ""].join("\n") },
    {
      name: "a newline at the reverse chunk boundary",
      contents: [
        messageLine,
        titleLine,
        "x".repeat(chunkBytes - bytesBeforeTitle - Buffer.byteLength(titleLine + "\n")),
        "",
      ].join("\n"),
    },
    {
      name: "a title character split across the reverse chunk boundary",
      contents: [messageLine, olderTitleLine, splitTitleLine].join("\n"),
    },
  ];

  for (const testCase of cases) {
    it(`preserves the latest title and activity time with ${testCase.name}`, () => {
      const { file, cacheHome } = writeSummaryFixture([]);
      fs.writeFileSync(file, headerLine + "\n" + testCase.contents);
      const previous = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = cacheHome;
      try {
        const summaries = new HistorySummaryCache();
        const expected = { title, mtime: Date.parse(testCase.mtime ?? "2026-01-01T00:00:00.000Z") };
        assert.deepEqual(summaries.resolve(file), expected);
        assert.deepEqual(summaries.resolve(file), expected);
      } finally {
        if (previous === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = previous;
        fs.rmSync(join(file, ".."), { recursive: true, force: true });
      }
    });
  }
});

describe("history first user message fallback", () => {
  const chunkBytes = 256 * 1024;
  const header = {
    type: "session",
    id: "untitled",
    cwd: "/tmp",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  const longContent = "x".repeat(1024 * 1024);
  const lastActivityTimestamp = "2026-01-02T00:00:00.000Z";
  const readCases = [
    {
      name: "uses a single scan when there are no user messages",
      entries: [assistantMessage(longContent)],
      title: null,
      btime: null,
      extraReadBudgetBytes: 1024,
    },
    {
      name: "does not reread long user attachments after the first usable title",
      entries: [
        userMessage([]),
        userMessage("First usable title", "m2"),
        userMessage([{ type: "image", data: longContent }], "m3"),
      ],
      title: "First usable title",
      btime: Date.parse(header.timestamp),
      extraReadBudgetBytes: chunkBytes + 1024,
    },
    {
      name: "does not reread a long appended entry needed to find the latest activity time",
      entries: [userMessage("First usable title")],
      appendedRecord: {
        type: "message",
        timestamp: lastActivityTimestamp,
        message: { role: "assistant", content: longContent },
      },
      title: "First usable title",
      btime: Date.parse(header.timestamp),
      extraReadBudgetBytes: chunkBytes + 1024,
    },
  ];
  for (const testCase of readCases) {
    it(testCase.name, () => {
      const { file, cacheHome } = writeSummaryFixture([header, ...testCase.entries]);
      const previous = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = cacheHome;
      const originalReadSync = fs.readSync;
      let historyBytesRead = 0;
      const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
        const bytes: number = Reflect.apply(originalReadSync, fs, args);
        if (typeof args[4] === "number" && typeof args[3] === "number" && args[3] > 1024) {
          historyBytesRead += bytes;
        }
        return bytes;
      });
      try {
        const summaries = new HistorySummaryCache();
        summaries.resolveHistory(file);
        const appendedRecord = testCase.appendedRecord ?? {
          type: "compaction",
          timestamp: lastActivityTimestamp,
        };
        fs.appendFileSync(file, JSON.stringify(appendedRecord) + "\n");
        historyBytesRead = 0;
        const size = fs.statSync(file).size;
        const summary = summaries.resolveHistory(file);
        assert.deepEqual(
          { title: summary?.title, btime: summary?.btime, mtime: summary?.mtime },
          {
            title: testCase.title,
            btime: testCase.btime,
            mtime: Date.parse(lastActivityTimestamp),
          },
        );
        assert.ok(
          historyBytesRead <= size + testCase.extraReadBudgetBytes,
          `Scanned ${historyBytesRead} bytes for ${size} bytes of history`,
        );
        historyBytesRead = 0;
        assert.deepEqual(summaries.resolve(file), { title: testCase.title, mtime: summary?.mtime });
        assert.equal(historyBytesRead, 0);
      } finally {
        read.mockRestore();
        if (previous === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = previous;
        fs.rmSync(dirname(file), { recursive: true, force: true });
      }
    });
  }

  it("keeps user fallback when the only user marker is an escape split across chunks", () => {
    const first = JSON.stringify(header);
    const second = JSON.stringify(userMessage("First usable title", "m2"))
      .replace('"user"', '"\\u0075ser"')
      .replace("00:00:00.000Z", "00:00:02.000Z");
    const last = JSON.stringify(assistantMessage("Later activity"));
    const splitAfter = second.indexOf("\\u0075") + 1;
    const padding =
      chunkBytes - Buffer.byteLength(first) - Buffer.byteLength(second.slice(0, splitAfter)) - 2;
    const { file, cacheHome } = writeSummaryFixture([]);
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheHome;
    try {
      fs.writeFileSync(file, [first, "x".repeat(padding), second, last].join("\n"));
      const summary = new HistorySummaryCache().resolveHistory(file);
      assert.equal(summary?.title, "First usable title");
      assert.equal(summary?.btime, Date.parse("2026-01-01T00:00:02.000Z"));
      assert.equal(summary?.mtime, Date.parse("2026-01-01T00:00:01.000Z"));
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      fs.rmSync(dirname(file), { recursive: true, force: true });
    }
  });

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
      userMessage([
        { type: "text", text: "  fix\n\n   the\t" },
        { type: "text", text: "\nbuild  " },
      ]),
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
