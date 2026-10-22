import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { entryRecords, selectReadingPage } from "./records";
import {
  excerpt,
  formatBytes,
  formatListRow,
  formatSearchHit,
  formatReadingRecord,
  formatReadingPage,
  formatTimestamp,
  toSingleLine,
  truncateText,
} from "./render";
import type { SearchHit } from "./search";
import type { SessionStat } from "./sessions";

describe("toSingleLine", () => {
  it("collapses line breaks into spaces and trims edges", () => {
    assert.equal(toSingleLine("\nfirst\nsecond\r\n"), "first second");
  });
});

describe("truncateText", () => {
  it("keeps short text as-is", () => {
    assert.equal(truncateText("short", 10), "short");
  });

  it("appends an ellipsis when text exceeds the limit", () => {
    assert.equal(truncateText("abcdef", 3), "abc…");
  });
});

describe("excerpt", () => {
  it("collapses and truncates in one step", () => {
    assert.equal(excerpt("first\nsecond\nthird", 11), "first secon…");
  });
});

describe("formatTimestamp", () => {
  it("formats an ISO timestamp as date and seconds", () => {
    assert.equal(formatTimestamp("2026-10-21T02:39:06.704Z"), "2026-10-21 02:39:06");
  });

  it("returns an empty string for a missing timestamp", () => {
    assert.equal(formatTimestamp(""), "");
  });
});

describe("formatBytes", () => {
  it("formats each magnitude with one decimal", () => {
    assert.equal(formatBytes(932), "932B");
    assert.equal(formatBytes(2048), "2.0K");
    assert.equal(formatBytes(3 * 1024 ** 2), "3.0M");
    assert.equal(formatBytes(2.5 * 1024 ** 3), "2.5G");
  });
});

describe("formatSearchHit", () => {
  it("renders a header line with id, project, type, time, line and an excerpt", () => {
    const hit: SearchHit = {
      sessionId: "01a15c51-58c7-701d-9567-a445a2f76fa7",
      project: "--home-username-projects-dotfiles--",
      path: "/sessions/a.jsonl",
      line: 12,
      entryType: "message",
      timestamp: "2026-10-21T02:38:45.892Z",
      text: "fix the worktree",
      invocationId: null,
      eventIndex: null,
    };
    const rendered = formatSearchHit(hit);
    assert.match(
      rendered,
      /^01a15c51 --home-username-projects-dotfiles-- message 2026-10-21 02:38:45 line 12\n  fix the worktree$/,
    );
  });
});

describe("formatReadingPage", () => {
  it("renders full multiline text with parent index and line provenance", () => {
    const text = "start\n" + "x".repeat(2500) + "\nend";
    const record = entryRecords(
      { type: "message", message: { role: "user", content: text } },
      10,
      3,
    )[0]!;
    assert.equal(formatReadingRecord(record), `[3] user parent line 10\n${text}`);
  });

  it("renders child agent and invocation provenance", () => {
    const record = entryRecords(
      {
        type: "custom",
        customType: "agents.subagent-log",
        data: {
          agent: "junior",
          invocationId: "call-a",
          events: [{ type: "assistant.message", data: { content: "answer" } }],
        },
      },
      20,
      4,
    )[0]!;
    assert.equal(
      formatReadingRecord(record),
      "[4] assistant subagent junior invocationId=call-a eventIndex=1 line 20\nanswer",
    );
  });

  it("renders page totals and continuation", () => {
    const records = [1, 2].map(
      (index) =>
        entryRecords(
          { type: "message", message: { role: "user", content: String(index) } },
          index,
          index,
        )[0]!,
    );
    const page = selectReadingPage("id", records, { limit: 1 });
    assert.match(formatReadingPage(page), /total: 2 offset: 1 returned: 1 nextOffset: 2$/);
  });

  it("renders no matches for an empty query result", () => {
    const page = selectReadingPage("id", [], { query: "missing" });
    assert.equal(
      formatReadingPage(page, "missing"),
      "no matches\n\ntotal: 0 offset: 1 returned: 0 nextOffset: null",
    );
  });

  it("renders no records at this offset for an empty unfiltered page", () => {
    const page = selectReadingPage("id", [], { offset: 3 });
    assert.equal(
      formatReadingPage(page),
      "no records at this offset\n\ntotal: 0 offset: 3 returned: 0 nextOffset: null",
    );
  });

  it("renders no records at this offset for an exhausted nonempty query result", () => {
    const records = entryRecords(
      { type: "message", message: { role: "user", content: "match" } },
      1,
    );
    const page = selectReadingPage("id", records, { query: "match", offset: 2 });
    assert.match(formatReadingPage(page, "match"), /^no records at this offset/);
  });
});

describe("formatListRow", () => {
  it("renders id, project, updated, size, and title", () => {
    const stat: SessionStat = {
      project: "--proj--",
      sessionId: "01a15c51-58c7-701d-9567-a445a2f76fa7",
      startedAt: "2026-10-21T02:36:37.448Z",
      path: "/sessions/a.jsonl",
      updatedAt: new Date("2026-10-21T04:10:00.000Z"),
      sizeBytes: 2048,
    };
    assert.equal(
      formatListRow(stat, "fix the bug"),
      "01a15c51 --proj-- 2026-10-21 04:10:00 2.0K fix the bug",
    );
  });
});
