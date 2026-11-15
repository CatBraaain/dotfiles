import { afterEach, describe, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import assert from "node:assert/strict";
import {
  buildPrompt,
  parseDispatchArgs,
  planTick,
  run,
  sessionName,
  shQuote,
  type TicketSnapshot,
} from "./dispatch";

describe("sessionName", () => {
  it("prefixes the id and replaces dots with underscores", () => {
    assert.equal(sessionName("fix_", "20260920-120418"), "fix_20260920-120418");
    assert.equal(sessionName("fix_", "2026.09.20"), "fix_2026_09_20");
  });
});

describe("buildPrompt", () => {
  it("replaces every ticket ID placeholder literally", () => {
    const prompt = buildPrompt("[{{ TICKET_ID }}, {{ TICKET_ID }}]", "t1");
    assert.equal(prompt, "[t1, t1]");
  });

  it("preserves replacement syntax, quotes, newlines, and placeholder text inside the ID", () => {
    const id = '{{ TICKET_ID }}$&$`$\' "double"\\\n';
    const prompt = buildPrompt("[{{ TICKET_ID }}]", id);
    assert.equal(prompt, `[${id}]`);
  });

  it("preserves fixed text and any trailing newlines", () => {
    for (const ending of ["", "\n", "\n\n\n"]) {
      const prompt = buildPrompt(`fixed {{ TICKET_ID }} ${ending}`, "t1");
      assert.equal(prompt, `fixed t1 ${ending}`);
    }
  });
});

describe("fixed prompt asset", () => {
  it("reads the asset for each run and rejects missing assets before work begins", () => {
    const { home, options, socket } = fixture();
    const sourceDir = join(home, "src");
    mkdirSync(sourceDir);
    copyFileSync(join(import.meta.dir, "dispatch.ts"), join(sourceDir, "dispatch.ts"));
    copyFileSync(join(import.meta.dir, "../dispatch-prompt.md"), join(home, "dispatch-prompt.md"));
    const script = `
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { run, startDispatcher } from ${JSON.stringify(join(sourceDir, "dispatch.ts"))};
const options = ${JSON.stringify(options)};
const asset = ${JSON.stringify(join(home, "dispatch-prompt.md"))};
const deps = {
  options,
  loadSnapshot: async () => [{ id: "a", status: "open", actionable: true }],
  log() {},
  hasSession() { return false; },
  killSession() {},
  launch() {},
  async sleepMs() {},
};
for (const text of ["first {{ TICKET_ID }}", "second {{ TICKET_ID }}"]) {
  writeFileSync(asset, text);
  await run(deps);
  assert.equal(readFileSync(options.fixDir + "/prompt-a.txt", "utf8"), text.replace("{{ TICKET_ID }}", "a"));
}
rmSync(asset);
await assert.rejects(run(deps), /ENOENT/);
await assert.rejects(startDispatcher({
  project: "sample", options, command: [],
  loadSnapshot: async () => assert.fail("asset failure must precede ticket reads"),
}), /ENOENT/);
`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, TICKET_TEST_TMUX_SOCKET: socket },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  });

  it("rejects --template in internal worker arguments", () => {
    const result = Bun.spawnSync(
      [process.execPath, CLI, "__ticket_dispatch_worker", "sample", "--template", "external.txt"],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    assert.equal(result.exitCode, 2);
    assert.match(new TextDecoder().decode(result.stderr), /unknown option: --template/);
  });
});

describe("parseDispatchArgs", () => {
  it("treats explicit start and the omitted action as equivalent", () => {
    const implicitStart = parseDispatchArgs(["w"]);
    const explicitStart = parseDispatchArgs(["start", "w"]);
    assert.deepEqual(explicitStart, implicitStart);
    assert.equal(explicitStart.action, "start");
  });

  it("defaults the work directory to the process cwd", () => {
    assert.deepEqual(parseDispatchArgs([]).options, {
      fixDir: join(process.cwd(), "fix"),
      log: join(process.cwd(), "dispatch.log"),
      max: 5,
      prefix: "fix_",
      interval: 30,
    });
    assert.deepEqual(parseDispatchArgs(["start"]), parseDispatchArgs([]));
  });

  it("uses the given work directory and three option defaults", () => {
    assert.deepEqual(parseDispatchArgs(["w"]).options, {
      fixDir: "w/fix",
      log: "w/dispatch.log",
      max: 5,
      prefix: "fix_",
      interval: 30,
    });
  });

  it("rejects arguments after stop", () => {
    assert.equal(parseDispatchArgs(["stop", "w"]).error, "stop accepts no arguments");
    assert.deepEqual(parseDispatchArgs(["stop"]), { action: "stop" });
  });

  it("accepts the three overrides and positional option termination", () => {
    const parsed = parseDispatchArgs([
      "--max",
      "3",
      "--interval",
      "0.2",
      "--prefix",
      "t_",
      "--",
      "w",
    ]);
    assert.deepEqual(parsed.options, {
      fixDir: "w/fix",
      log: "w/dispatch.log",
      max: 3,
      prefix: "t_",
      interval: 0.2,
    });
  });

  it("rejects invalid work directory arguments and missing option values", () => {
    for (const args of [[""], ["a", "b"], ["w", "--max"], ["w", "--interval", "--prefix", "x"]]) {
      assert.equal(parseDispatchArgs(args).options, undefined, JSON.stringify(args));
    }
  });

  it("rejects removed and unknown flags", () => {
    for (const flag of [
      "--template",
      "--store",
      "--cwd",
      "--work",
      "--queue",
      "--fix-dir",
      "--log",
      "--socket",
      "--project",
      "--json",
      "--help",
      "--nope",
    ]) {
      assert.equal(parseDispatchArgs(["w", flag, "x"]).error, `unknown option: ${flag}`);
    }
  });

  it("requires a positive integer max and a positive finite interval", () => {
    for (const max of ["0", "-1", "1.5", "Infinity", "NaN", ""]) {
      assert.equal(parseDispatchArgs(["w", "--max", max]).error, "--max must be an integer >= 1");
    }
    for (const interval of ["0", "-1", "Infinity", "NaN", ""]) {
      assert.equal(
        parseDispatchArgs(["w", "--interval", interval]).error,
        "--interval must be a number > 0",
      );
    }
  });
});

describe("planTick", () => {
  const base = {
    tickets: [
      { id: "a", status: "open", actionable: true },
      { id: "b", status: "open", actionable: true },
      { id: "c", status: "open", actionable: true },
    ],
    started: new Set<string>(),
    running: new Map<string, string>(),
    max: 2,
    hasSession: () => true,
  };

  it("launches the oldest actionable tickets up to max", () => {
    const plan = planTick(base);
    assert.deepEqual(plan.launches, ["a", "b"]);
    assert.equal(plan.finished, false);
  });

  it("releases finished tickets and refills the free slot in the same tick", () => {
    const plan = planTick({
      ...base,
      tickets: [{ id: "a", status: "cancelled", actionable: false }, ...base.tickets.slice(1)],
      started: new Set(["a", "b"]),
      running: new Map([
        ["a", "fix_a"],
        ["b", "fix_b"],
      ]),
    });
    assert.deepEqual(plan.done, [{ id: "a", name: "fix_a", status: "cancelled" }]);
    assert.deepEqual(plan.launches, ["c"]);
    assert.equal(plan.finished, false);
  });

  it("does not restart incomplete or previously released tickets", () => {
    const plan = planTick({
      ...base,
      started: new Set(["a", "b", "c"]),
      running: new Map([["c", "fix_c"]]),
      hasSession: () => false,
    });
    assert.deepEqual(plan.incomplete, [{ id: "c", name: "fix_c", status: "open" }]);
    assert.deepEqual(plan.launches, []);
    assert.equal(plan.finished, true);
  });

  it("uses actionable rather than status alone and keeps monitoring a running session", () => {
    const plan = planTick({
      ...base,
      tickets: [
        { id: "a", status: "open", actionable: true },
        { id: "b", status: "blocked", actionable: false },
        { id: "c", status: "open", actionable: false },
        { id: "d", status: "draft", actionable: false },
      ],
      started: new Set(["a"]),
      running: new Map([["a", "fix_a"]]),
    });
    assert.deepEqual(plan.launches, []);
    assert.equal(plan.finished, false);
  });

  it("does not launch more tickets when running sessions already exceed max", () => {
    const plan = planTick({
      ...base,
      running: new Map([
        ["x", "fix_x"],
        ["y", "fix_y"],
        ["z", "fix_z"],
      ]),
    });
    assert.deepEqual(plan.launches, []);
    assert.equal(plan.finished, false);
  });

  it("finishes when there are no actionable tickets or running sessions", () => {
    assert.equal(planTick({ ...base, tickets: [] }).finished, true);
  });

  it("prioritizes done over a missing session", () => {
    const plan = planTick({
      ...base,
      tickets: [{ id: "a", status: "closed", actionable: false }],
      started: new Set(["a"]),
      running: new Map([["a", "fix_a"]]),
      hasSession: () => false,
    });
    assert.deepEqual(plan.done, [{ id: "a", name: "fix_a", status: "closed" }]);
    assert.deepEqual(plan.incomplete, []);
    assert.equal(plan.finished, true);
  });

  it("reports none when a running ticket disappeared from the snapshot", () => {
    const plan = planTick({
      ...base,
      tickets: [],
      started: new Set(["a"]),
      running: new Map([["a", "fix_a"]]),
      hasSession: () => false,
    });
    assert.deepEqual(plan.incomplete, [{ id: "a", name: "fix_a", status: null }]);
  });
});

const fixtures: Array<{ home: string; socket: string }> = [];
const TEMP_ROOT = "/tmp/work/dotfiles";
const CLI = join(import.meta.dir, "main.ts");

function fixture() {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const home = mkdtempSync(join(TEMP_ROOT, "ticket-dispatch-unit-"));
  const socket = join(home, "isolated.sock");
  fixtures.push({ home, socket });
  const store = join(home, ".agents", "tickets", basename(home));
  mkdirSync(store, { recursive: true });
  const options = parseDispatchArgs([home, "--interval", "0.25", "--max", "2"]).options!;
  return { home, store, options, socket };
}

function invoke(home: string, args: string[], socket = join(home, "isolated.sock")) {
  const result = Bun.spawnSync([process.execPath, CLI, "dispatch", ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, TICKET_TEST_TMUX_SOCKET: socket },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function waitForLog(path: string, expected: RegExp): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const log = readFileSync(path, "utf8");
      if (expected.test(log)) return log;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error(`log did not match ${expected}: ${path}`);
}

afterEach(() => {
  for (const { home, socket } of fixtures.splice(0)) {
    Bun.spawnSync(["tmux", "-S", socket, "kill-server"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    rmSync(home, { recursive: true, force: true });
  }
});

describe("dispatch execution", () => {
  it("rescans for additions and dependency release after waiting with no new targets", async () => {
    const { home, options } = fixture();
    let tickets: TicketSnapshot[] = [
      { id: "a", status: "open", actionable: true },
      { id: "b", status: "blocked", actionable: false },
    ];
    const events: string[] = [];
    let sleeps = 0;
    let scans = 0;
    await run({
      options,
      loadSnapshot: async () => {
        scans++;
        return tickets;
      },
      log: (line) => events.push(line),
      hasSession: (name) => name !== "fix_b",
      killSession: (name) => events.push(`kill ${name}`),
      launch: (id, name, promptFile) => {
        assert.equal(promptFile, join(home, "fix", `prompt-${id}.txt`));
        const prompt = readFileSync(promptFile, "utf8");
        assert.ok(prompt.startsWith(`ticket ${id} に対応する。`));
        assert.match(prompt, /user はticketを読んでいない前提で/);
        events.push(`start ${name}`);
      },
      sleepMs: async (ms) => {
        assert.equal(ms, 250);
        sleeps++;
        assert.ok(sleeps <= 3, "dispatcher did not finish");
        if (sleeps === 2) {
          tickets = [
            { id: "a", status: "closed", actionable: false },
            { id: "b", status: "open", actionable: true },
            { id: "c", status: "open", actionable: true },
          ];
        } else if (sleeps === 3) {
          tickets = [
            { id: "a", status: "open", actionable: true },
            { id: "b", status: "open", actionable: true },
            { id: "c", status: "cancelled", actionable: false },
          ];
        }
      },
    });
    assert.equal(scans, 4);
    assert.deepEqual(events, [
      "dispatcher start max=2",
      "start fix_a",
      "launched a as fix_a",
      "done a status=closed",
      "kill fix_a",
      "start fix_b",
      "launched b as fix_b",
      "start fix_c",
      "launched c as fix_c",
      "done c status=cancelled",
      "kill fix_c",
      "incomplete b status=open session exited without close",
      "dispatcher finished",
    ]);
  });

  it("does not retry or kill a launch rejected as a session-name collision", async () => {
    const { options } = fixture();
    const logs: string[] = [];
    let launches = 0;
    await run({
      options,
      loadSnapshot: async () => [{ id: "a", status: "open", actionable: true }],
      log: (line) => logs.push(line),
      hasSession: () => true,
      killSession: () => assert.fail("a rejected launch must not be killed"),
      launch: () => {
        launches++;
        return false;
      },
      sleepMs: async () => {},
    });
    assert.equal(launches, 1);
    assert.deepEqual(logs, ["dispatcher start max=2", "dispatcher finished"]);
  });

  it("tracks inherited tickets as started and releases them when done", async () => {
    const { options } = fixture();
    const events: string[] = [];
    let launches = 0;
    await run({
      options,
      initialRunning: new Map([["a", "existing_a"]]),
      loadSnapshot: async () => [{ id: "a", status: "closed", actionable: false }],
      log: (line) => events.push(line),
      hasSession: () => true,
      launch: () => {
        launches++;
      },
      killSession: (name) => events.push(`kill ${name}`),
      sleepMs: async () => {},
    });
    assert.equal(launches, 0);
    assert.deepEqual(events, [
      "dispatcher start max=2",
      "done a status=closed",
      "kill existing_a",
      "dispatcher finished",
    ]);
  });

  it("quotes prompt paths containing single quotes without shell expansion", () => {
    const path = "a 'b' $HOME `x`";
    const result = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shQuote(path)}`]);
    assert.equal(result.exitCode, 0);
    assert.equal(new TextDecoder().decode(result.stdout), path);
  });
});

describe("dispatch CLI", () => {
  it("returns usage error 2 for invalid dispatch inputs", () => {
    const { home } = fixture();
    const invalid = [
      ["stop", "extra"],
      ["stop", "--max", "1"],
      ["a", "b"],
      [home, "--max"],
      [home, "--max", "0"],
      [home, "--interval", "NaN"],
      [home, "--interval", "0"],
      [home, "--template"],
      [home, "--socket", "x"],
      [home, "--project", "x"],
      [home, "--json"],
    ];
    for (const args of invalid) {
      const result = invoke(home, args);
      assert.equal(result.code, 2, JSON.stringify(args));
      assert.match(result.stderr, /usage: ticket dispatch \[<work-dir>\]/);
      assert.equal(result.stdout, "");
    }
  });

  it("returns code 1 when tmux cannot create the detached dispatcher session", () => {
    const { home } = fixture();
    const unavailableSocket = join(home, "missing-parent", "tmux.sock");
    const result = invoke(home, [home], unavailableSocket);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^I\/O error: dispatcher start failed for ticket_dispatch_/);
    assert.equal(result.stdout, "");
  });

  it("returns after detached start and logs completion for an empty store", async () => {
    const { home, options } = fixture();
    writeFileSync(options.log, "previous log\n");
    const result = invoke(home, ["start", home, "--interval", "0.01"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^dispatcher started: ticket_dispatch_.* log=/);
    const log = await waitForLog(options.log, /dispatcher finished/);
    assert.match(
      log,
      /^previous log\n\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] dispatcher start max=5\n/,
    );
    assert.match(log, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] dispatcher finished\n$/);
  });

  it("accepts stop when this project's dispatcher is not running", () => {
    const { home } = fixture();
    const result = invoke(home, ["stop"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^dispatcher already stopped: ticket_dispatch_/);
    assert.equal(result.stderr, "");
  });

  for (const failedPath of ["log", "fixDir"] as const) {
    it(`returns I/O error 1 when ${failedPath} access fails`, () => {
      const { home, options } = fixture();
      if (failedPath === "log") mkdirSync(options.log);
      else if (failedPath === "fixDir") writeFileSync(options.fixDir, "not a directory");
      const result = invoke(home, [home]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /^I\/O error: /);
      assert.ok(!result.stderr.includes("usage:"));
    });
  }

  it("reports prompt write failures in the dispatcher log after start succeeds", async () => {
    const { home, options, store } = fixture();
    mkdirSync(join(options.fixDir, "prompt-a.txt"), { recursive: true });
    writeFileSync(join(store, "a.md"), "---\nstatus: open\n---\n");
    const result = invoke(home, [home, "--interval", "0.01"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^dispatcher started:/);
    const log = await waitForLog(options.log, /EISDIR|illegal operation on a directory/);
    assert.match(log, /prompt-a\.txt/);
  });
});

describe("dispatch snapshot validation", () => {
  it("uses existing ticket validation rather than silently skipping broken tickets", () => {
    const { home, store } = fixture();
    writeFileSync(join(store, "broken.md"), "---\nstatus: unknown\n---\n");
    const result = invoke(home, [home]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^invalid status "unknown"/);
    assert.ok(!result.stderr.includes("I/O error"));
  });

  it("uses the existing missing-project error", () => {
    const { home, store } = fixture();
    rmSync(store, { recursive: true });
    const result = invoke(home, [home]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^project not found:/);
    assert.ok(!result.stderr.includes("I/O error"));
  });
});
