import { afterAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionFiles, type SessionFile } from "./sessions";
import { parseRgOutputLine, RgUnavailableError, runSearch } from "./search";

const tempRoots: string[] = [];

function createSessionTree(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-sessions-search-"));
  tempRoots.push(root);
  return root;
}

function writeSession(root: string, sessionId: string, lines: string[]): void {
  const projectDir = join(root, "--proj--");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `2026-10-21T00-00-00-000Z_${sessionId}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("runSearch", () => {
  it("finds hits with extracted text and entry metadata", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      '{"type":"session","id":"00000000-0000-0000-0000-000000000001","timestamp":"2026-10-21T00:00:00.000Z","cwd":"/tmp"}',
      '{"type":"message","timestamp":"2026-10-21T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"fix the worktree please"}]}}',
    ]);
    const files = listSessionFiles(root);

    const hits = await runSearch(files, "worktree");

    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, "00000000-0000-0000-0000-000000000001");
    assert.equal(hits[0].project, "--proj--");
    assert.equal(hits[0].line, 2);
    assert.equal(hits[0].entryType, "message");
    assert.equal(hits[0].timestamp, "2026-10-21T00:01:00.000Z");
    assert.equal(hits[0].text, "fix the worktree please");
  });

  it("returns an empty list when nothing matches", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      '{"type":"session","id":"00000000-0000-0000-0000-000000000001"}',
    ]);
    const files = listSessionFiles(root);

    assert.deepEqual(await runSearch(files, "no-such-token-anywhere"), []);
  });

  it("returns an empty list without spawning rg when there are no files", async () => {
    assert.deepEqual(await runSearch([], "query", { rgCommand: "pi-sessions-missing-rg" }), []);
  });

  it("stops rg early once the limit is reached", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      '{"type":"session","id":"00000000-0000-0000-0000-000000000001"}',
      userLineWithText("alpha worktree"),
      userLineWithText("beta worktree"),
    ]);
    const files = listSessionFiles(root);

    const hits = await runSearch(files, "worktree", { limit: 1 });

    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
  });

  it("throws RgUnavailableError when rg is not installed", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      '{"type":"session","id":"00000000-0000-0000-0000-000000000001"}',
    ]);
    const files = listSessionFiles(root);

    await assert.rejects(
      () => runSearch(files, "query", { rgCommand: "pi-sessions-missing-rg" }),
      RgUnavailableError,
    );
  });
});

function userLineWithText(text: string): string {
  return JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

describe("parseRgOutputLine", () => {
  const file: SessionFile = {
    project: "--proj--",
    sessionId: "00000000-0000-0000-0000-000000000001",
    startedAt: "2026-10-21T00:00:00.000Z",
    path: "/sessions/--proj--/a.jsonl",
  };
  const filesByPath = new Map([[file.path, file]]);

  it("parses a path, line number, and entry from an rg output line", () => {
    const hit = parseRgOutputLine(
      `${file.path}\u000012:${userLineWithText("hello worktree")}`,
      filesByPath,
    );
    assert.equal(hit?.line, 12);
    assert.equal(hit?.entryType, "message");
    assert.equal(hit?.text, "hello worktree");
  });

  it("extracts entry metadata from a truncated long line without JSON parsing", () => {
    const truncated = `{"type":"custom","customType":"agents.subagent-log","id":"x","timestamp":"2026-10-21T00:00:00.000Z","data":{"task":"read the image [... omitted end of long line`;
    const hit = parseRgOutputLine(`${file.path}\u00003:${truncated}`, filesByPath);
    assert.equal(hit?.entryType, "custom:agents.subagent-log");
    assert.equal(hit?.timestamp, "2026-10-21T00:00:00.000Z");
    assert.equal(hit?.text.includes("agents.subagent-log"), true);
  });

  it("returns null for an output line without a path separator", () => {
    assert.equal(parseRgOutputLine("not-an-rg-line", filesByPath), null);
  });
});

function inlineLog(invocationId: string, events: unknown[], task = "unrelated task"): string {
  return JSON.stringify({
    type: "custom",
    customType: "agents.subagent-log",
    timestamp: "2026-10-21T00:00:00.000Z",
    data: { agent: "junior", invocationId, task, events },
  });
}

describe("searching inline child events", () => {
  it("reports child rg signal termination as a CLI search failure", () => {
    const root = createSessionTree();
    const homeDir = join(root, "home");
    const sessionDir = join(homeDir, ".pi", "agent", "sessions", "--home-username-projects-demo--");
    const binDir = join(root, "bin");
    const sessionId = "00000000-0000-0000-0000-000000000001";
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(
      join(sessionDir, `2026-10-21T00-00-00-000Z_${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "custom",
        customType: "agents.subagent-log",
        data: {
          agent: "junior",
          invocationId: "call-signal",
          task: "unrelated task",
          events: [{ type: "assistant.message", data: { content: "needle answer" } }],
        },
      })}\n`,
    );
    const realRg = Bun.which("rg");
    assert.ok(realRg);
    const rgWrapper = join(binDir, "rg");
    writeFileSync(
      rgWrapper,
      `#!/bin/sh\ncase " $* " in\n  *" --with-filename "*) exec '${realRg}' "$@" ;;\n  *) kill -TERM $$ ;;\nesac\n`,
      { mode: 0o755 },
    );

    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "main.ts"),
        "search",
        "needle",
        "--role",
        "assistant",
        "--json",
      ],
      { env: { ...process.env, HOME: homeDir, PATH: `${binDir}:${process.env.PATH}` } },
    );

    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout.toString(), "");
    assert.match(result.stderr.toString(), /rg event search failed.*SIGTERM/);
  });

  it("returns each matching child event body instead of the task", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      userLineWithText("shared needle parent"),
      inlineLog(
        "call-first",
        [
          { type: "user.message", data: { content: "shared needle user" } },
          {
            type: "assistant.message",
            timestamp: "2026-10-21T01:00:00Z",
            data: { content: "shared needle answer" },
          },
          { type: "assistant.message", data: { content: "unrelated" } },
        ],
        "shared needle task",
      ),
      inlineLog("call-second", [
        { type: "assistant.reasoning", data: { content: "shared needle plan" } },
      ]),
    ]);
    const hits = await runSearch(listSessionFiles(root), "shared needle");
    assert.deepEqual(
      hits.map((hit) => [hit.line, hit.invocationId, hit.eventIndex, hit.text]),
      [
        [1, null, null, "shared needle parent"],
        [2, "call-first", 1, "shared needle user"],
        [2, "call-first", 2, "shared needle answer"],
        [3, "call-second", 1, "shared needle plan"],
      ],
    );
    assert.equal(hits[2]?.timestamp, "2026-10-21T01:00:00Z");
    assert.equal(hits[3]?.timestamp, "");
  });

  it("keeps task-only custom hits when no role is requested", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      inlineLog(
        "call-first",
        [{ type: "assistant.message", data: { content: "unrelated" } }],
        "needle task",
      ),
    ]);
    const hits = await runSearch(listSessionFiles(root), "needle");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.text, "subagent junior: needle task");
    assert.equal(hits[0]?.eventIndex, null);
  });

  it("does not treat a custom task as a user message under a role filter", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      inlineLog(
        "call-first",
        [{ type: "assistant.message", data: { content: "unrelated" } }],
        "needle task",
      ),
    ]);
    assert.deepEqual(await runSearch(listSessionFiles(root), "needle", { role: "user" }), []);
  });

  it("filters mixed parent and child roles before counting the limit", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      userLineWithText("needle excluded user"),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", content: "needle excluded tool" },
      }),
      inlineLog("call-a", [
        { type: "user.message", data: { content: "needle excluded child user" } },
        {
          type: "tool.execution_complete",
          data: { toolName: "bash", output: "needle excluded child tool" },
        },
        { type: "assistant.reasoning", data: { content: "needle plan" } },
        { type: "tool.execution_start", data: { toolName: "bash", input: { command: "needle" } } },
        { type: "assistant.message", data: { content: "needle answer" } },
      ]),
    ]);
    const hits = await runSearch(listSessionFiles(root), "needle", { role: "assistant", limit: 2 });
    assert.deepEqual(
      hits.map((hit) => [hit.eventIndex, hit.text]),
      [
        [3, "needle plan"],
        [4, 'bash\n{"command":"needle"}'],
      ],
    );
  });

  it("selects child user events and excludes assistant and tool events", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      inlineLog("call-a", [
        { type: "user.message", data: { content: "needle user" } },
        { type: "assistant.message", data: { content: "needle answer" } },
        { type: "tool.execution_complete", data: { output: "needle tool" } },
      ]),
    ]);
    const hits = await runSearch(listSessionFiles(root), "needle", { role: "user" });
    assert.deepEqual(
      hits.map((hit) => [hit.eventIndex, hit.text]),
      [[1, "needle user"]],
    );
  });

  it("uses rg-only regex syntax for child event matching", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      inlineLog("call-a", [
        { type: "assistant.message", data: { content: "NEEDLE 123" } },
        { type: "assistant.message", data: { content: "no match" } },
      ]),
    ]);
    const hits = await runSearch(listSessionFiles(root), "(?i)needle [0-9]+", {
      role: "assistant",
    });
    assert.equal(hits[0]?.text, "NEEDLE 123");
    assert.equal(hits.length, 1);
  });

  it("recovers child hits after column 100000 from the original entry", async () => {
    const root = createSessionTree();
    const log = inlineLog("call-long", [
      { type: "assistant.reasoning", data: { content: "x".repeat(130000) } },
      { type: "user.message", data: { content: "needle child user tail" } },
      { type: "assistant.message", data: { content: "needle child answer tail" } },
    ]);
    assert.ok(log.indexOf("needle") > 100000);
    writeSession(root, "00000000-0000-0000-0000-000000000001", [userLineWithText("parent"), log]);
    const files = listSessionFiles(root);
    const unfiltered = await runSearch(files, "needle");
    assert.deepEqual(
      unfiltered.map((hit) => [hit.line, hit.invocationId, hit.eventIndex, hit.text]),
      [
        [2, "call-long", 2, "needle child user tail"],
        [2, "call-long", 3, "needle child answer tail"],
      ],
    );
    const filtered = await runSearch(files, "needle", { role: "assistant", limit: 1 });
    assert.deepEqual(
      filtered.map((hit) => [hit.eventIndex, hit.text]),
      [[3, "needle child answer tail"]],
    );
  });

  it("recovers the role from a long parent line instead of its truncated fragment", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      JSON.stringify({
        type: "message",
        padding: "x".repeat(130000),
        message: { role: "assistant", content: "needle answer" },
      }),
      JSON.stringify({
        type: "message",
        padding: "y".repeat(130000),
        message: { role: "user", content: "needle user" },
      }),
    ]);
    const hits = await runSearch(listSessionFiles(root), "needle", { role: "user", limit: 1 });
    assert.equal(hits[0]?.text, "needle user");
    assert.equal(hits[0]?.line, 2);
  });

  it("retains the capped fallback for long non-custom entries without a role filter", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "head" + "x".repeat(130000) + "needle" },
      }),
    ]);
    const hits = await runSearch(listSessionFiles(root), "needle");
    assert.equal(hits[0]?.entryType, "message");
    assert.ok(hits[0]!.text.length <= 201);
    assert.ok(hits[0]!.text.startsWith('{"type":"message"'));
  });

  it("reports invalid regular expressions as errors", async () => {
    const root = createSessionTree();
    writeSession(root, "00000000-0000-0000-0000-000000000001", [userLineWithText("text")]);
    await assert.rejects(() => runSearch(listSessionFiles(root), "["), /rg failed/);
  });
});

describe("search process lifetime", () => {
  it("kills rg after the filtered hit limit instead of waiting for later output", async () => {
    const root = createSessionTree();
    const sessionId = "00000000-0000-0000-0000-000000000001";
    writeSession(root, sessionId, [userLineWithText("needle")]);
    const files = listSessionFiles(root);
    const executable = join(root, "fake-rg");
    const output = `${files[0]!.path}\u00001:${userLineWithText("needle")}`;
    writeFileSync(
      executable,
      `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(output)});\nawait new Promise((resolve) => setTimeout(resolve, 30000));\n`,
      { mode: 0o755 },
    );
    const started = performance.now();
    const hits = await runSearch(files, "needle", {
      limit: 1,
      role: "user",
      rgCommand: executable,
    });
    assert.equal(hits.length, 1);
    assert.ok(performance.now() - started < 2000);
  });
});
