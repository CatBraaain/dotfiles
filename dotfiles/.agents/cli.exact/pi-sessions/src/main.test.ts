import { afterAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main";

const tempHomes: string[] = [];

function createFixtureHome(): { homeDir: string; cwd: string } {
  const homeDir = mkdtempSync(join(tmpdir(), "pi-sessions-home-"));
  tempHomes.push(homeDir);
  const projectDir = join(homeDir, ".pi", "agent", "sessions", "--home-username-projects-demo--");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "2026-10-21T00-00-00-000Z_01a15c51-58c7-701d-9567-a445a2f76fa7.jsonl"),
    [
      '{"type":"session","version":3,"id":"01a15c51-58c7-701d-9567-a445a2f76fa7","timestamp":"2026-10-21T00:00:00.000Z","cwd":"/home/username/projects/demo"}',
      '{"type":"message","timestamp":"2026-10-21T00:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"search the worktree"}]}}',
      '{"type":"message","timestamp":"2026-10-21T00:02:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"looking"}]}}',
      '{"type":"message","timestamp":"2026-10-21T00:03:00.000Z","message":{"role":"toolResult","toolName":"bash","isError":false,"durationMs":100,"content":[{"type":"text","text":"ok"}]}}',
    ].join("\n") + "\n",
  );
  return { homeDir, cwd: "/home/username/projects/demo" };
}

afterAll(() => {
  for (const homeDir of tempHomes) rmSync(homeDir, { recursive: true, force: true });
});

describe("run", () => {
  it("prints usage and exits 1 without a subcommand", async () => {
    const { homeDir, cwd } = createFixtureHome();
    assert.equal(await run([], { cwd, homeDir }), 1);
    assert.equal(await run(["bogus"], { cwd, homeDir }), 1);
  });

  it("lists sessions as JSON with the documented fields", async () => {
    const { homeDir, cwd } = createFixtureHome();
    const lines = await captureStdout(() => run(["list", "--json"], { cwd, homeDir }));
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(row.id, "01a15c51-58c7-701d-9567-a445a2f76fa7");
    assert.equal(row.project, "--home-username-projects-demo--");
    assert.equal(row.started, "2026-10-21T00:00:00.000Z");
    assert.equal(typeof row.updated, "string");
    assert.equal(typeof row.sizeBytes, "number");
    assert.equal(row.title, "search the worktree");
  });

  it("searches fixture sessions in human-readable form", async () => {
    const { homeDir, cwd } = createFixtureHome();
    const lines = await captureStdout(() => run(["search", "worktree"], { cwd, homeDir }));
    assert.equal(
      lines[0],
      "01a15c51 --home-username-projects-demo-- message 2026-10-21 00:01:00 line 2",
    );
  });

  it("shows one JSON object with page metadata and reading records", async () => {
    const { homeDir, cwd } = createFixtureHome();
    const lines = await captureStdout(() => run(["show", "01a15c51", "--json"], { cwd, homeDir }));
    assert.equal(lines.length, 1);
    const page = JSON.parse(lines[0]!);
    assert.equal(page.sessionId, "01a15c51-58c7-701d-9567-a445a2f76fa7");
    assert.equal(page.total, 3);
    assert.equal(page.offset, 1);
    assert.equal(page.returned, 3);
    assert.equal(page.nextOffset, null);
    assert.deepEqual(
      page.records.map((record: { role: string }) => record.role),
      ["user", "assistant", "toolResult"],
    );
  });

  it("shows a session in human-readable form without hidden entries", async () => {
    const { homeDir, cwd } = createFixtureHome();
    const lines = await captureStdout(() => run(["show", "01a15c51"], { cwd, homeDir }));
    assert.equal(lines[0], "[1] user parent line 2");
    assert.equal(lines[1], "search the worktree");
    assert.equal(lines[3], "[2] assistant parent line 3");
    assert.equal(lines[4], "looking");
    assert.equal(lines[6], "[3] toolResult parent line 4");
    assert.equal(lines[7], "bash ok 100ms");
    assert.equal(lines[8], "ok");
    assert.equal(lines[10], "total: 3 offset: 1 returned: 3 nextOffset: null");
  });

  it("exits 1 when show matches no session", async () => {
    const { homeDir, cwd } = createFixtureHome();
    assert.equal(await run(["show", "ffffffff"], { cwd, homeDir }), 1);
  });

  it("exits 1 for an invalid date option", async () => {
    const { homeDir, cwd } = createFixtureHome();
    assert.equal(await run(["list", "--since", "2026/10/21"], { cwd, homeDir }), 1);
  });
});

async function captureStdout(action: () => Promise<number>): Promise<string[]> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: unknown) => {
    lines.push(...String(line).split("\n"));
  };
  try {
    const exitCode = await action();
    if (exitCode !== 0) throw new Error(`expected exit code 0, got ${exitCode}`);
    return lines;
  } finally {
    console.log = originalLog;
  }
}

function appendFixture(homeDir: string, entries: unknown[]): void {
  const path = join(
    homeDir,
    ".pi",
    "agent",
    "sessions",
    "--home-username-projects-demo--",
    "2026-10-21T00-00-00-000Z_01a15c51-58c7-701d-9567-a445a2f76fa7.jsonl",
  );
  appendFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

describe("reading and role options", () => {
  it("paginates full JSON records without missing or repeating content", async () => {
    const env = createFixtureHome();
    const text = "full text\n" + "x".repeat(2400);
    appendFixture(
      env.homeDir,
      Array.from({ length: 51 }, (_, index) => ({
        type: "message",
        message: { role: "user", content: `${text} ${index}` },
      })),
    );
    const first = JSON.parse(
      (await captureStdout(() => run(["show", "01a15c51", "--json"], env)))[0]!,
    );
    const second = JSON.parse(
      (
        await captureStdout(() =>
          run(["show", "01a15c51", "--json", "--offset", String(first.nextOffset)], env),
        )
      )[0]!,
    );
    assert.equal(first.total, 54);
    assert.equal(first.returned, 50);
    assert.equal(second.returned, 4);
    assert.equal(second.nextOffset, null);
    assert.equal(second.records[3].text, `${text} 50`);
    const indexes = [...first.records, ...second.records].map(
      (record: { index: number }) => record.index,
    );
    assert.deepEqual(
      indexes,
      Array.from({ length: 54 }, (_, index) => index + 1),
    );
  });

  it("combines role, query context, and pagination for parent and child records", async () => {
    const env = createFixtureHome();
    appendFixture(env.homeDir, [
      {
        type: "custom",
        customType: "agents.subagent-log",
        data: {
          agent: "junior",
          invocationId: "call-1",
          task: "task",
          events: [
            { type: "user.message", data: { content: "child user" } },
            { type: "assistant.message", data: { content: "needle child answer" } },
            { type: "tool.execution_complete", data: { output: "needle excluded" } },
          ],
        },
      },
      { type: "message", message: { role: "assistant", content: "after child" } },
    ]);
    const args = [
      "show",
      "01a15c51",
      "--json",
      "--role",
      "assistant",
      "--query",
      "needle",
      "--offset",
      "2",
      "--limit",
      "1",
    ];
    const page = JSON.parse((await captureStdout(() => run(args, env)))[0]!);
    assert.equal(page.total, 3);
    assert.equal(page.returned, 1);
    assert.equal(page.offset, 2);
    assert.equal(page.nextOffset, 3);
    assert.deepEqual(page.records[0], {
      index: 5,
      line: 5,
      role: "assistant",
      text: "needle child answer",
      source: "subagent",
      agent: "junior",
      invocationId: "call-1",
      eventIndex: 2,
    });
  });

  it("returns a structured empty page for query misses", async () => {
    const env = createFixtureHome();
    const page = JSON.parse(
      (
        await captureStdout(() => run(["show", "01a15c51", "--json", "--query", "MISSING"], env))
      )[0]!,
    );
    assert.deepEqual(page, {
      sessionId: "01a15c51-58c7-701d-9567-a445a2f76fa7",
      records: [],
      total: 0,
      offset: 1,
      returned: 0,
      nextOffset: null,
    });
  });

  it("returns an empty page beyond the selected offset", async () => {
    const env = createFixtureHome();
    const page = JSON.parse(
      (
        await captureStdout(() =>
          run(["show", "01a15c51", "--json", "--role", "user", "--offset", "2"], env),
        )
      )[0]!,
    );
    assert.equal(page.total, 1);
    assert.equal(page.returned, 0);
    assert.equal(page.nextOffset, null);
  });

  it("keeps rg regular expressions when filtering search by role", async () => {
    const env = createFixtureHome();
    const lines = await captureStdout(() =>
      run(["search", "(?i)WORKTREE", "--role", "user", "--json"], env),
    );
    const hit = JSON.parse(lines[0]!);
    assert.equal(lines.length, 1);
    assert.equal(hit.text, "search the worktree");
    assert.equal(hit.invocationId, null);
    assert.equal(hit.eventIndex, null);
  });

  it("limits search after filtering the role", async () => {
    const env = createFixtureHome();
    const lines = await captureStdout(() =>
      run(["search", "worktree|looking", "--role", "assistant", "--limit", "1", "--json"], env),
    );
    assert.equal(JSON.parse(lines[0]!).text, "looking");
    assert.equal(lines.length, 1);
  });

  for (const option of ["--offset", "--limit"]) {
    for (const value of ["0", "-1", "1.2", "NaN", "Infinity", "9007199254740992"]) {
      it(`rejects ${option}=${value} with usage on stderr`, async () => {
        const env = createFixtureHome();
        const errors: string[] = [];
        const originalError = console.error;
        console.error = (line: unknown) => {
          errors.push(String(line));
        };
        try {
          assert.equal(await run(["show", "01a15c51", option, value], env), 1);
          assert.match(errors.join("\n"), /usage: pi-sessions/);
        } finally {
          console.error = originalError;
        }
      });
    }
  }

  for (const args of [
    ["nonexistent"],
    ["show", "01a15c51", "--role", "toolResult"],
    ["search", "text", "--role", "system"],
    ["list", "--role", "user"],
    ["list", "--offset", "1"],
    ["search", "text", "--offset", "1"],
    ["search", "text", "--query", "x"],
    ["show", "01a15c51", "--role"],
    ["show", "01a15c51", "--query"],
    ["show", "01a15c51", "--offset"],
    ["show", "01a15c51", "--limit"],
    ["show", "01a15c51", "--offset", "--json"],
    ["show", "01a15c51", "--unknown"],
    ["show", "01a15c51", "extra"],
  ]) {
    it(`rejects unsupported arguments: ${args.join(" ")}`, async () => {
      assert.equal(await run(args, createFixtureHome()), 1);
    });
  }

  it("runs as a process with JSON output and exit code zero", () => {
    const env = createFixtureHome();
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "main.ts"),
        "show",
        "01a15c51",
        "--json",
        "--role",
        "user",
      ],
      { env: { ...process.env, HOME: env.homeDir } },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout.toString()).returned, 1);
    assert.equal(result.stderr.toString(), "");
  });

  it("returns exit code one and usage for invalid process arguments", () => {
    const env = createFixtureHome();
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "main.ts"), "show", "01a15c51", "--offset", "0"],
      { env: { ...process.env, HOME: env.homeDir } },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.toString(), "");
    assert.match(result.stderr.toString(), /usage: pi-sessions/);
  });
});

describe("project option regression", () => {
  it("accepts a full project directory name beginning with two hyphens", async () => {
    const env = createFixtureHome();
    const lines = await captureStdout(() =>
      run(["list", "--project", "--home-username-projects-demo--", "--json"], env),
    );
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).project, "--home-username-projects-demo--");
  });
});

describe("literal query option values", () => {
  it("accepts query text that is also an option name", async () => {
    const env = createFixtureHome();
    appendFixture(env.homeDir, [
      { type: "message", message: { role: "user", content: "explain --role usage" } },
    ]);
    const lines = await captureStdout(() =>
      run(["show", "01a15c51", "--query", "--role", "--json"], env),
    );
    const page = JSON.parse(lines[0]!);
    assert.ok(
      page.records.some((record: { text: string }) => record.text === "explain --role usage"),
    );
  });
});
