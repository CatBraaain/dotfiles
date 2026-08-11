// Run: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import sessionSearchExtension, {
  DEFAULT_MESSAGE_LIMIT,
  extractMessages,
  filterSessions,
  getSession,
  listSessions,
  type SessionSource,
} from "./index";
import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";

type Test = { name: string; fn: () => Promise<void> | void };
const tests: Test[] = [];
let group = "";

function describe(name: string, fn: () => void): void {
  const previousGroup = group;
  group = name;
  fn();
  group = previousGroup;
}

function it(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    path: `/sessions/${overrides.id ?? "default"}.jsonl`,
    id: overrides.id ?? "default",
    cwd: overrides.cwd ?? "/home/user/projects/dotfiles",
    name: overrides.name,
    parentSessionPath: undefined,
    created: overrides.created ?? new Date("2026-08-10T12:00:00Z"),
    modified: overrides.modified ?? new Date("2026-08-10T12:00:00Z"),
    messageCount: overrides.messageCount ?? 2,
    firstMessage: overrides.firstMessage ?? "Implement the feature",
    allMessagesText: overrides.allMessagesText ?? "Implement the feature\nDone",
  };
}

function messageEntry(role: string, content: string, id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-10T12:00:00Z",
    message: { role, content, timestamp: Date.parse("2026-08-10T12:00:00Z") } as never,
  };
}

function source(
  sessions: SessionInfo[],
  entriesByPath: Record<string, SessionEntry[]>,
): SessionSource {
  return {
    listAll: async () => sessions,
    open: (path) => ({ getEntries: () => entriesByPath[path] ?? [] }),
  };
}

function renderedLines(component: { render(width: number): string[] }): string[] {
  return component.render(80).map((line) => line.trim());
}

function captureTools(source: SessionSource = testSource): Map<string, any> {
  const tools = new Map<string, any>();
  sessionSearchExtension(
    { registerTool: (tool: any) => tools.set(tool.name, tool) } as never,
    source,
  );
  return tools;
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

const recentSession = session({
  id: "recent",
  firstMessage: "Discuss the harness",
  allMessagesText: "Discuss the harness\nKatakana ハーネス",
});
const oldSession = session({
  id: "old",
  cwd: "/home/user/projects/other",
  created: new Date("2026-08-01T12:00:00Z"),
  firstMessage: "Unrelated work",
});
const entriesByPath = {
  [recentSession.path]: [
    messageEntry("user", "Discuss the harness", "1"),
    messageEntry("assistant", "The harness is ready", "2"),
    messageEntry("user", "A later question", "3"),
  ],
  [oldSession.path]: [messageEntry("user", "Unrelated work", "4")],
};
const testSource = source([recentSession, oldSession], entriesByPath);

describe("session_list", () => {
  it("returns every session when no filter is given", async () => {
    const sessions = await listSessions({}, testSource);
    assert.deepEqual(
      sessions.map((item) => item.id),
      ["recent", "old"],
    );
  });

  it("filters by cwd, since, until, and limit", () => {
    const filteredSessions = filterSessions([oldSession, recentSession], {
      cwd: "dotfiles",
      since: "2026-08-09",
      until: "2026-08-10",
      limit: 1,
    });
    assert.deepEqual(
      filteredSessions.map((item) => item.id),
      ["recent"],
    );
  });

  it("searches cwd, name, first message, and all message text case-insensitively", () => {
    const nameSession = session({
      id: "named",
      name: "Harness work",
      firstMessage: "Nothing else",
      allMessagesText: "Nothing else",
    });
    const matchedSessions = filterSessions([nameSession], { query: "harness" });
    assert.deepEqual(
      matchedSessions.map((item) => item.id),
      ["named"],
    );
  });

  it("matches hiragana and katakana as the same search text", () => {
    const matchedSessions = filterSessions([recentSession], { query: "はーねす" });
    assert.deepEqual(
      matchedSessions.map((item) => item.id),
      ["recent"],
    );
  });

  it("falls back to subsequence matching when substring matching has no result", () => {
    const matchedSessions = filterSessions([recentSession], { query: "hrns" });
    assert.deepEqual(
      matchedSessions.map((item) => item.id),
      ["recent"],
    );
  });

  it("returns an empty list when no session matches", async () => {
    const sessions = await listSessions({ query: "missing" }, testSource);
    assert.deepEqual(sessions, []);
  });

  it("uses twenty as the default result limit", () => {
    const sessions = Array.from({ length: 21 }, (_, index) =>
      session({ id: String(index), created: new Date(2026, 0, index + 1) }),
    );
    assert.equal(filterSessions(sessions, {}).length, 20);
  });
});

describe("session_get", () => {
  it("returns the first fifty messages by default", async () => {
    const entries = Array.from({ length: DEFAULT_MESSAGE_LIMIT + 1 }, (_, index) =>
      messageEntry("user", `message ${index}`, String(index)),
    );
    const longSession = session({
      id: "long",
      path: "/sessions/long.jsonl",
      messageCount: entries.length,
    });
    const result = await getSession(
      { id: "long" },
      source([longSession], { [longSession.path]: entries }),
    );
    assert.equal(result.messages.length, DEFAULT_MESSAGE_LIMIT);
    assert.equal(result.offset, 1);
    assert.equal(result.total, DEFAULT_MESSAGE_LIMIT + 1);
  });

  it("returns the requested one-based range", async () => {
    const result = await getSession({ id: "recent", offset: 2, limit: 1 }, testSource);
    assert.deepEqual(
      result.messages.map((message) => message.text),
      ["The harness is ready"],
    );
  });

  it("filters by role before applying offset and limit", async () => {
    const result = await getSession(
      { id: "recent", role: "user", offset: 2, limit: 1 },
      testSource,
    );
    assert.deepEqual(
      result.messages.map((message) => message.text),
      ["A later question"],
    );
  });

  it("returns messages around every query hit", async () => {
    const result = await getSession({ id: "recent", query: "harness" }, testSource);
    assert.deepEqual(
      result.messages.map((message) => message.text),
      ["Discuss the harness", "The harness is ready", "A later question"],
    );
  });

  it("uses subsequence matching for query mode when exact matching has no result", async () => {
    const result = await getSession({ id: "recent", query: "hrns" }, testSource);
    assert.equal(result.messages.length, 3);
  });

  it("returns no messages when a query has no hit", async () => {
    const result = await getSession({ id: "recent", query: "missing" }, testSource);
    assert.deepEqual(result.messages, []);
  });

  it("rejects an unknown session id", async () => {
    await assert.rejects(getSession({ id: "missing" }, testSource), /Session not found/);
  });

  it("extracts text from text arrays and bash execution messages", () => {
    const entries = [
      messageEntry("assistant", "plain", "1"),
      {
        type: "message",
        id: "2",
        parentId: null,
        timestamp: "now",
        message: { role: "bashExecution", command: "ls", output: "file" },
      } as never,
    ];
    assert.deepEqual(extractMessages(entries), [
      { role: "assistant", text: "plain" },
      { role: "bashExecution", text: "ls\nfile" },
    ]);
  });
});

describe("tool registration and rendering", () => {
  it("registers session_list and session_get only", () => {
    const tools = captureTools();
    assert.deepEqual([...tools.keys()], ["session_list", "session_get"]);
  });

  it("shows the session_list arguments in the call renderer", () => {
    const tool = captureTools().get("session_list");
    const identityTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    assert.deepEqual(
      renderedLines(tool.renderCall({ query: "harness", cwd: "dotfiles" }, identityTheme)),
      ['session_list query="harness" cwd="dotfiles"'],
    );
  });

  it("shows the session_get id and query in the call renderer", () => {
    const tool = captureTools().get("session_get");
    const identityTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    assert.deepEqual(
      renderedLines(tool.renderCall({ id: "recent", query: "harness" }, identityTheme)),
      ['session_get id="recent" query="harness"'],
    );
  });

  it("折りたたみ時は session_list の実行結果本文を表示しない", async () => {
    const tool = captureTools().get("session_list");
    const identityTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const result = await tool.execute("call", { query: "harness" });
    const collapsedLines = renderedLines(
      tool.renderResult(
        result,
        { expanded: false, isPartial: false },
        identityTheme,
        { isError: false },
      ),
    );
    assert.deepEqual(collapsedLines, ["1 sessions"]);

    const sessionGetTool = captureTools().get("session_get");
    const sessionGetResult = await sessionGetTool.execute("call", { id: "recent" });
    const sessionGetCollapsedLines = renderedLines(
      sessionGetTool.renderResult(
        sessionGetResult,
        { expanded: false, isPartial: false },
        identityTheme,
        { isError: false },
      ),
    );
    assert.deepEqual(sessionGetCollapsedLines, ["3 messages"]);
  });

  it("展開時は session_get の実行結果本文を表示する", async () => {
    const tool = captureTools().get("session_get");
    const identityTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const result = await tool.execute("call", { id: "recent" });
    const expandedLines = renderedLines(
      tool.renderResult(
        result,
        { expanded: true, isPartial: false },
        identityTheme,
        { isError: false },
      ),
    );
    assert.ok(expandedLines.some((line) => line.includes("[user] Discuss the harness")));
  });

  it("エラー時は折りたたみ状態でも error を表示する", async () => {
    const tool = captureTools().get("session_list");
    const identityTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const result = await tool.execute("call", {});
    const collapsedLines = renderedLines(
      tool.renderResult(
        result,
        { expanded: false, isPartial: false },
        identityTheme,
        { isError: true },
      ),
    );
    assert.deepEqual(collapsedLines, ["error"]);
  });
});

describe("tool execution results", () => {
  it("session_list returns id and all required session metadata", async () => {
    const tool = captureTools().get("session_list");
    const result = await tool.execute("call", { query: "harness" });
    const resultText = textOf(result);
    assert.match(resultText, /id: recent/);
    assert.match(resultText, /2026-08-10/);
    assert.match(resultText, /cwd: \/home\/user\/projects\/dotfiles/);
    assert.match(resultText, /firstMessage: Discuss the harness/);
    assert.match(resultText, /messages: 2/);
  });

  it("session_get returns a dated header and role-prefixed messages in chronological order", async () => {
    const tool = captureTools().get("session_get");
    const result = await tool.execute("call", { id: "recent" });
    const resultText = textOf(result);
    assert.match(resultText, /## 2026-08-10 \/home\/user\/projects\/dotfiles — recent/);
    assert.ok(
      resultText.indexOf("[user] Discuss the harness") <
        resultText.indexOf("[assistant] The harness is ready"),
    );
  });

  it("session_get returns hitなし without returning the full session for a miss", async () => {
    const tool = captureTools().get("session_get");
    const resultText = textOf(await tool.execute("call", { id: "recent", query: "missing" }));
    assert.equal(resultText, 'ヒットなし: "missing"');
  });

  it("session_get reports pagination for a long query result", async () => {
    const entries = Array.from({ length: DEFAULT_MESSAGE_LIMIT + 1 }, (_, index) =>
      messageEntry("user", `harness message ${index}`, String(index)),
    );
    const longSession = session({
      id: "query-long",
      path: "/sessions/query-long.jsonl",
      messageCount: entries.length,
    });
    const tool = captureTools(source([longSession], { [longSession.path]: entries })).get(
      "session_get",
    );
    const resultText = textOf(await tool.execute("call", { id: "query-long", query: "harness" }));
    assert.match(resultText, /全51件中 1〜50件を表示。続きは offset=51/);
  });

  it("session_get uses query mode when query and range parameters are both provided", async () => {
    const tool = captureTools().get("session_get");
    const resultText = textOf(
      await tool.execute("call", { id: "recent", query: "harness", offset: 2, limit: 1 }),
    );
    assert.match(resultText, /\[assistant\] The harness is ready/);
  });
});

let passed = 0;
const failures: string[] = [];
for (const test of tests) {
  try {
    await test.fn();
    passed++;
  } catch (error) {
    failures.push(
      `  ✗ ${test.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
