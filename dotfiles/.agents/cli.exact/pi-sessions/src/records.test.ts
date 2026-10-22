import { afterAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry, SubagentEvent } from "./entry";
import { entryRecords, loadReadingPage, selectReadingPage, type ReadingRecord } from "./records";

function parentEntry(role: string, text: string): SessionEntry {
  return { type: "message", message: { role, content: text } };
}

function numberedRecords(count: number): ReadingRecord[] {
  return Array.from(
    { length: count },
    (_, offset) =>
      entryRecords(parentEntry("user", `record ${offset + 1}`), offset + 2, offset + 1)[0]!,
  );
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("entryRecords", () => {
  it("keeps full parent text and nullable parent provenance", () => {
    const text = "first\n" + "x".repeat(2001) + "\nlast";
    assert.deepEqual(entryRecords(parentEntry("user", text), 3, 7), [
      {
        index: 7,
        line: 3,
        role: "user",
        text,
        source: "parent",
        agent: null,
        invocationId: null,
        eventIndex: null,
      },
    ]);
  });

  it("keeps assistant text, reasoning, and full tool arguments in saved order", () => {
    const args = { command: "x".repeat(1000) };
    const entry: SessionEntry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan\nnext" },
          { type: "text", text: "answer" },
          { type: "toolCall", name: "bash", arguments: args },
          { type: "text", text: "after" },
        ],
      },
    };
    assert.equal(
      entryRecords(entry, 1)[0]?.text,
      `plan\nnext\nanswer\nbash ${JSON.stringify(args)}\nafter`,
    );
  });

  it("includes tool result status, recorded duration, and full output", () => {
    const output = "output\n" + "z".repeat(1000);
    const entry: SessionEntry = {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        isError: true,
        durationMs: 1357,
        content: output,
      },
    };
    assert.equal(entryRecords(entry, 2)[0]?.text, `read error 1357ms\n${output}`);
  });

  it("does not invent tool result status, duration, or output", () => {
    const entry: SessionEntry = {
      type: "message",
      message: { role: "toolResult", toolName: "read" },
    };
    assert.equal(entryRecords(entry, 2)[0]?.text, "read");
  });

  it("expands all known child events with their original event positions", () => {
    const events: SubagentEvent[] = [
      { type: "unknown" },
      { type: "user.message", data: { content: "child task" } },
      { type: "assistant.reasoning", data: { content: "child plan" } },
      { type: "assistant.message", data: { content: "child answer" } },
      { type: "tool.execution_start", data: { toolName: "bash", input: { command: "pwd" } } },
      {
        type: "tool.execution_complete",
        data: {
          toolName: "bash",
          success: false,
          output: { content: [{ type: "text", text: "failed" }] },
        },
      },
    ];
    const entry: SessionEntry = {
      type: "custom",
      customType: "agents.subagent-log",
      data: { agent: "junior", invocationId: "call-a", events },
    };
    const records = entryRecords(entry, 10, 3);
    assert.deepEqual(
      records.map((record) => record.role),
      ["user", "assistant", "assistant", "assistant", "toolResult"],
    );
    assert.deepEqual(
      records.map((record) => record.text),
      [
        "child task",
        "child plan",
        "child answer",
        'bash\n{"command":"pwd"}',
        'bash error\n{"content":[{"type":"text","text":"failed"}]}',
      ],
    );
    assert.deepEqual(
      records.map((record) => [
        record.index,
        record.line,
        record.source,
        record.agent,
        record.invocationId,
        record.eventIndex,
      ]),
      [
        [3, 10, "subagent", "junior", "call-a", 2],
        [4, 10, "subagent", "junior", "call-a", 3],
        [5, 10, "subagent", "junior", "call-a", 4],
        [6, 10, "subagent", "junior", "call-a", 5],
        [7, 10, "subagent", "junior", "call-a", 6],
      ],
    );
  });

  it("does not invent absent child output or status", () => {
    const entry: SessionEntry = {
      type: "custom",
      customType: "agents.subagent-log",
      data: { events: [{ type: "tool.execution_complete", data: { toolName: "read" } }] },
    };
    assert.equal(entryRecords(entry, 1)[0]?.text, "read");
  });

  it("excludes headers, system, model changes, and other custom entries", () => {
    const excluded: SessionEntry[] = [
      { type: "session" },
      parentEntry("system", "hidden"),
      { type: "model_change" },
      { type: "thinking_level_change" },
      { type: "custom", customType: "pi-stamp" },
    ];
    assert.deepEqual(
      excluded.flatMap((entry) => entryRecords(entry, 1)),
      [],
    );
  });
});

describe("selectReadingPage", () => {
  it("returns 50 records by default and gives the next offset", () => {
    const page = selectReadingPage("session", numberedRecords(53));
    assert.equal(page.total, 53);
    assert.equal(page.offset, 1);
    assert.equal(page.returned, 50);
    assert.equal(page.nextOffset, 51);
    assert.deepEqual(
      page.records.map((record) => record.index),
      Array.from({ length: 50 }, (_, offset) => offset + 1),
    );
  });

  it("returns every record once when reading all pages", () => {
    const records = numberedRecords(103);
    const received: ReadingRecord[] = [];
    let offset: number | null = 1;
    while (offset !== null) {
      const page = selectReadingPage("session", records, { offset });
      received.push(...page.records);
      offset = page.nextOffset;
    }
    assert.deepEqual(received, records);
  });

  it("returns the last record without a next offset", () => {
    const page = selectReadingPage("session", numberedRecords(51), { offset: 51, limit: 1 });
    assert.equal(page.records[0]?.index, 51);
    assert.equal(page.returned, 1);
    assert.equal(page.nextOffset, null);
  });

  it("returns an empty page beyond the selected records", () => {
    const page = selectReadingPage("session", numberedRecords(51), { offset: 52 });
    assert.deepEqual(page, {
      sessionId: "session",
      records: [],
      total: 51,
      offset: 52,
      returned: 0,
      nextOffset: null,
    });
  });

  it("returns the same page shape for an empty session", () => {
    assert.deepEqual(selectReadingPage("session", []), {
      sessionId: "session",
      records: [],
      total: 0,
      offset: 1,
      returned: 0,
      nextOffset: null,
    });
  });

  it("includes two neighbors on both sides of a hit", () => {
    const records = numberedRecords(15);
    records[9]!.text = "needle";
    const page = selectReadingPage("session", records, { query: "needle" });
    assert.deepEqual(
      page.records.map((record) => record.index),
      [8, 9, 10, 11, 12],
    );
  });

  it("clips context at the first and last records", () => {
    const records = numberedRecords(10);
    records[0]!.text = "needle";
    records[9]!.text = "needle";
    const page = selectReadingPage("session", records, { query: "needle" });
    assert.deepEqual(
      page.records.map((record) => record.index),
      [1, 2, 3, 8, 9, 10],
    );
  });

  it("deduplicates overlapping context in saved order", () => {
    const records = numberedRecords(10);
    records[3]!.text = "needle";
    records[5]!.text = "needle";
    const page = selectReadingPage("session", records, { query: "needle" });
    assert.deepEqual(
      page.records.map((record) => record.index),
      [2, 3, 4, 5, 6, 7, 8],
    );
  });

  it("uses a case-sensitive literal query rather than a regular expression", () => {
    const records = numberedRecords(10);
    records[0]!.text = "A.B";
    records[9]!.text = "axb a.b";
    const page = selectReadingPage("session", records, { query: "A.B" });
    assert.deepEqual(
      page.records.map((record) => record.index),
      [1, 2, 3],
    );
    assert.equal(selectReadingPage("session", records, { query: "A.*B" }).total, 0);
  });

  it("filters role before query context and then applies pagination", () => {
    const records = numberedRecords(15);
    records.forEach((record) => {
      record.role = record.index % 2 === 0 ? "assistant" : "user";
    });
    records[7]!.text = "needle";
    records[0]!.text = "needle";
    const page = selectReadingPage("session", records, {
      role: "assistant",
      query: "needle",
      offset: 2,
      limit: 2,
    });
    assert.deepEqual(
      page.records.map((record) => record.index),
      [6, 8],
    );
    assert.equal(page.total, 5);
    assert.equal(page.nextOffset, 4);
  });

  it("returns zero matches with a null next offset", () => {
    const page = selectReadingPage("session", numberedRecords(10), { query: "not found" });
    assert.equal(page.total, 0);
    assert.deepEqual(page.records, []);
    assert.equal(page.nextOffset, null);
  });
});

describe("loadReadingPage", () => {
  it("keeps parent and repeated agent invocations at their saved positions", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sessions-records-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "session" }),
        JSON.stringify(parentEntry("user", "shared needle")),
        "broken json",
        JSON.stringify({
          type: "custom",
          customType: "agents.subagent-log",
          data: {
            agent: "junior",
            invocationId: "first",
            events: [
              {
                type: "assistant.message",
                timestamp: "2099-01-01",
                data: { content: "shared needle" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "custom",
          customType: "agents.subagent-log",
          data: {
            agent: "junior",
            invocationId: "second",
            events: [
              { type: "user.message", data: { content: "second task" } },
              {
                type: "assistant.message",
                timestamp: "2000-01-01",
                data: { content: "second answer" },
              },
            ],
          },
        }),
        JSON.stringify(parentEntry("assistant", "parent after")),
      ].join("\n"),
    );
    const page = await loadReadingPage(path, "session", { query: "shared needle" });
    assert.deepEqual(
      page.records.map((record) => [
        record.index,
        record.line,
        record.invocationId,
        record.eventIndex,
      ]),
      [
        [1, 2, null, null],
        [2, 4, "first", 1],
        [3, 5, "second", 1],
        [4, 5, "second", 2],
      ],
    );
    assert.equal(page.total, 4);
  });
});

describe("full tool arguments", () => {
  it("keeps whitespace in recorded string arguments", () => {
    const entry: SessionEntry = {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: "  command  " }],
      },
    };
    assert.equal(entryRecords(entry, 1)[0]?.text, "bash   command  ");
  });
});
