import { afterEach, describe, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import assert from "node:assert/strict";
import {
  buildPrompt,
  dispatcherName,
  DispatchInventoryUnavailable,
  formatDispatchers,
  hasSession,
  parseDispatchArgs,
  parseWindowsDispatchInventory,
  planTick,
  run,
  sessionName,
  shQuote,
  sortDispatchers,
  type RunDeps,
  type TicketSnapshot,
} from "./dispatch";

describe("Windows dispatch inventory", () => {
  it("rejects a partial or duplicate result instead of reducing the tracked session count", () => {
    const session = { name: "handle_old", project: "a", ticketId: "20260626-123456", created: 17 };
    const inventory = (sessions: unknown[]) => JSON.stringify({ sessions });
    assert.deepEqual(parseWindowsDispatchInventory(inventory([session])), [session]);
    assert.throws(
      () => parseWindowsDispatchInventory(inventory([session, { name: "handle_other" }])),
      /Malformed/,
    );
    assert.throws(() => parseWindowsDispatchInventory(inventory([session, session])), /duplicate/);
    assert.throws(() => parseWindowsDispatchInventory("{}"), /Malformed/);
  });

  it("defers releasing capacity and launching until an authoritative inventory returns", async () => {
    const ticket = { id: "existing", status: "open", actionable: true };
    const candidate = { id: "candidate", status: "open", actionable: true };
    const trace: string[] = [];
    let snapshot = 0;
    await run({
      options: { max: 1 },
      async loadSnapshot() {
        if (snapshot >= 3)
          return [
            { ...ticket, status: "closed", actionable: false },
            { ...candidate, status: "closed", actionable: false },
          ];
        return [ticket, candidate];
      },
      async readPiSessions() {
        trace.push(`inventory ${snapshot}`);
        if (snapshot === 1) throw new DispatchInventoryUnavailable("inventory incomplete");
        if (snapshot === 0 || snapshot === 2) return new Map([["retained", ticket.id]]);
        return new Map();
      },
      launch(id) {
        trace.push(`launch ${id}`);
        return "new";
      },
      async sleepMs() {
        snapshot++;
      },
      log(line) {
        trace.push(line);
      },
    });
    assert.deepEqual(
      trace.filter((line) => /^(?:inventory|launch)/.test(line)),
      ["inventory 0", "inventory 1", "inventory incomplete", "inventory 2", "inventory 3"],
    );
    assert.ok(trace.includes("done existing status=closed"));
    assert.equal(
      trace.some((line) => line.startsWith("incomplete ")),
      false,
    );
  });
});

describe("sessionName", () => {
  it("prefixes the id and replaces dots with underscores", () => {
    assert.equal(sessionName("fix_", "20260920-120418"), "fix_20260920-120418");
    assert.equal(sessionName("fix_", "2026.09.20"), "fix_2026_09_20");
    assert.equal(sessionName("fix_", "alpha/2026.09.20", true), "fix_616c706861_2026_09_20");
    assert.notEqual(
      sessionName("fix_", "alpha/same", true),
      sessionName("fix_", "beta/same", true),
    );
    assert.notEqual(dispatcherName(null), dispatcherName("all"));
  });
});

function lockedDeps(
  owners: Record<string, string>,
  inspect: NonNullable<RunDeps["locked"]>["inspect"] = () => "absent",
): NonNullable<RunDeps["locked"]> {
  return {
    async findOwners(targets) {
      return {
        owners: new Map(
          targets.flatMap(({ project, ticketId }) => {
            const ownerId = owners[ticketId];
            return ownerId ? [[`${project}/${ticketId}`, { ownerId, file: "/tmp/old.jsonl" }]] : [];
          }),
        ),
        async isOwnerFileCurrent() {
          return true;
        },
      };
    },
    async readRevision() {
      return "revision";
    },
    inspect,
  };
}

describe("locked dispatch", () => {
  it("launches only known absent owners and shares one slot with open tickets", async () => {
    const launches: string[] = [];
    const logs: string[] = [];
    let live: [string, string] | undefined;
    let ticks = 0;
    await run({
      options: { max: 1, statuses: ["locked", "open"] },
      project: "demo",
      loadSnapshot: async () => [
        { id: "20261123-010001", status: "locked", actionable: false },
        { id: "20261123-010002", status: "locked", actionable: false },
        { id: "20261123-010003", status: "locked", actionable: false },
        { id: "20261123-010004-case", status: "locked", actionable: false },
        { id: "new", status: "open", actionable: true },
      ],
      locked: lockedDeps(
        {
          "20261123-010002": "alive",
          "20261123-010003": "unreadable",
          "20261123-010004-case": "prior-id",
        },
        (id) => (id === "alive" ? "present" : id === "unreadable" ? "unknown" : "absent"),
      ),
      log: (line) => logs.push(line),
      readPiSessions: () => (live ? new Map([live]) : new Map()),
      launch(id, name, prompt, assignment) {
        assert.equal(live, undefined);
        launches.push(id);
        live = [name, id];
        if (id === "20261123-010004-case") {
          assert.deepEqual(assignment, { project: "demo", ticketId: id, ownerId: "prior-id" });
          assert.match(prompt, /pi-mux open --detached/);
          assert.match(prompt, /\/tmp\/old\.jsonl/);
        } else {
          assert.equal(assignment, undefined);
          assert.match(prompt, /^ticket new /);
        }
        return name;
      },
      async sleepMs() {
        if (++ticks >= 2) live = undefined;
      },
    });
    assert.deepEqual(launches, ["20261123-010004-case", "new"]);
    assert.ok(logs.includes("skipped 20261123-010001: lock owner unknown"));
    assert.ok(logs.includes("skipped 20261123-010002: lock owner present"));
    assert.ok(logs.includes("skipped 20261123-010003: lock owner lookup unavailable"));
    assert.ok(
      logs.includes("incomplete 20261123-010004-case status=locked session exited without close"),
    );
  });

  it("retries a locked launch on a later tick without treating the rejected attempt as started", async () => {
    const id = "20261123-010000";
    let sleeps = 0;
    const launchAtSleepCounts: number[] = [];
    await run({
      options: { max: 1, statuses: ["locked"] },
      project: "demo",
      loadSnapshot: async () => [{ id, status: "locked", actionable: false }],
      readPiSessions: () => new Map(),
      locked: lockedDeps({ [id]: "old" }),
      log: () => {},
      launch: (_id, name) => {
        launchAtSleepCounts.push(sleeps);
        return sleeps === 0 ? { retry: "lock owner present" } : name;
      },
      async sleepMs() {
        assert.equal(++sleeps <= 2, true, "dispatcher did not finish");
      },
    });
    assert.deepEqual(launchAtSleepCounts, [0, 1]);
  });

  for (const staysBusy of [false, true]) {
    it(`rechecks a busy owner probe once when the lock ${staysBusy ? "stays busy" : "clears"}`, async () => {
      const id = "20261123-010000";
      let probes = 0;
      let launches = 0;
      let ticks = 0;
      await run({
        options: { max: 2, statuses: ["locked"] },
        project: "demo",
        loadSnapshot: async () => [{ id, status: "locked", actionable: false }],
        readPiSessions: () => (staysBusy && ticks < 3 ? new Map([["$9", "other"]]) : new Map()),
        locked: lockedDeps({ [id]: "old" }, () =>
          ++probes <= (staysBusy ? 2 : 1) ? "busy" : "absent",
        ),
        log: () => {},
        launch: (_id, name) => {
          launches++;
          return name;
        },
        async sleepMs() {
          assert.ok(++ticks <= 4);
        },
      });
      assert.equal(probes, 2);
      assert.equal(launches, staysBusy ? 0 : 1);
    });
  }

  it("probes outside the lock and rechecks manual sessions and capacity before launching", async () => {
    const first = "20261123-010001";
    const second = "20261123-010002";
    const launches: string[] = [];
    const probes: [number, string][] = [];
    const batches: [number, string[]][] = [];
    let live = new Map<string, string>();
    let holdingLock = false;
    let ticks = 0;
    const locked = lockedDeps({ [first]: first, [second]: second }, (id) => {
      assert.equal(holdingLock, false);
      probes.push([ticks, id]);
      if (id === first) live.set("$1", first);
      return "absent";
    });
    await run({
      options: { max: 1, statuses: ["locked"] },
      project: "demo",
      loadSnapshot: async () =>
        [first, second].map((id) => ({ id, status: "locked", actionable: false })),
      async withTickLock(tick) {
        holdingLock = true;
        try {
          return await tick();
        } finally {
          holdingLock = false;
        }
      },
      readPiSessions: () => live,
      locked: {
        ...locked,
        findOwners(targets) {
          assert.equal(holdingLock, false);
          batches.push([ticks, targets.map(({ ticketId }) => ticketId)]);
          return locked.findOwners(targets);
        },
      },
      log: () => {},
      launch(id) {
        assert.equal(holdingLock, true);
        assert.equal(
          ticks,
          2,
          "do not launch while the manually started session occupies the slot",
        );
        launches.push(id);
        return "$2";
      },
      async sleepMs() {
        assert.ok(++ticks <= 3, "dispatcher did not finish");
        if (ticks === 2) live = new Map();
      },
    });
    assert.deepEqual(batches, [
      [0, [first, second]],
      [0, [first, second]],
      [2, [second]],
      [2, [second]],
    ]);
    assert.deepEqual(probes, [
      [0, first],
      [0, second],
      [2, second],
    ]);
    assert.deepEqual(launches, [second]);
  });

  it("runs open tickets while the initial history read is pending without starting a second scan", async () => {
    const id = "20261123-010000";
    const open = "next";
    const { promise: releaseScan, resolve } = Promise.withResolvers<void>();
    const locked = lockedDeps({ [id]: "old" });
    const previousTickMs = process.env.TICKET_TEST_TICK_MS;
    process.env.TICKET_TEST_TICK_MS = "5";
    let scans = 0;
    let sleeps = 0;
    let launchedOpen = false;
    const launches: string[] = [];
    try {
      await run({
        options: { max: 1, statuses: ["open", "locked"] },
        project: "demo",
        loadSnapshot: async () => [
          { id, status: "locked", actionable: false },
          { id: open, status: launchedOpen ? "closed" : "open", actionable: !launchedOpen },
        ],
        readPiSessions: () => new Map(),
        locked: {
          ...locked,
          async findOwners(targets) {
            if (++scans === 1) await releaseScan;
            return locked.findOwners(targets);
          },
        },
        log: () => {},
        launch(ticketId, name) {
          launches.push(ticketId);
          if (ticketId === open) {
            assert.equal(scans, 1);
            launchedOpen = true;
            resolve();
          }
          return name;
        },
        async sleepMs() {
          assert.ok(++sleeps <= 2, "dispatcher did not finish");
        },
      });
    } finally {
      resolve();
      if (previousTickMs === undefined) delete process.env.TICKET_TEST_TICK_MS;
      else process.env.TICKET_TEST_TICK_MS = previousTickMs;
    }
    assert.deepEqual(launches, [open, id]);
    assert.equal(scans, 2);
  });

  it.each(["scan", "file"] as const)(
    "retries an unresolved history %s before launching",
    async (unresolved) => {
      const id = "20261123-010000";
      const locked = lockedDeps({ [id]: "old" });
      let holdingLock = false;
      let scans = 0;
      let validations = 0;
      let sleeps = 0;
      const logs: string[] = [];
      const launches: [string, number][] = [];
      await run({
        options: { max: 1, statuses: ["locked"] },
        project: "demo",
        loadSnapshot: async () => [{ id, status: "locked", actionable: false }],
        readPiSessions: () => new Map(),
        locked: {
          ...locked,
          async findOwners(targets) {
            assert.equal(holdingLock, false);
            if (++scans === 1 && unresolved === "scan")
              throw new Error("session changed while reading");
            return {
              ...(await locked.findOwners(targets)),
              async isOwnerFileCurrent() {
                assert.equal(holdingLock, true);
                return ++validations > 1 || unresolved === "scan";
              },
            };
          },
        },
        async withTickLock(tick) {
          holdingLock = true;
          try {
            return await tick();
          } finally {
            holdingLock = false;
          }
        },
        log: (line) => logs.push(line),
        launch(ticketId, name) {
          launches.push([ticketId, sleeps]);
          return name;
        },
        async sleepMs() {
          assert.ok(++sleeps <= 3, "dispatcher did not finish");
        },
      });
      assert.deepEqual(launches, [[id, 1]]);
      assert.equal(validations, unresolved === "scan" ? 1 : 2);
      const reason =
        unresolved === "scan"
          ? "lock history lookup unavailable"
          : "lock history changed before launch";
      assert.ok(logs.includes(`skipped ${id}: ${reason}`));
      assert.ok(logs.every((line) => !line.includes("lock owner unknown")));
    },
  );

  it("defers a newly locked ticket without consuming the open ticket's slot", async () => {
    const id = "20261123-010000";
    const launches: [number, string][] = [];
    let tickNumber = 0;
    let reads = 0;
    await run({
      options: { max: 1, statuses: ["open", "locked"] },
      project: "demo",
      async loadSnapshot() {
        const open = { id: "next", status: "open", actionable: true };
        return reads++ === 0 ? [open] : [{ id, status: "locked", actionable: false }, open];
      },
      readPiSessions: () => new Map(),
      locked: lockedDeps({ [id]: "old" }),
      log: () => {},
      launch: (ticketId, name) => {
        launches.push([tickNumber, ticketId]);
        return name;
      },
      async sleepMs() {
        assert.ok(++tickNumber <= 2);
      },
    });
    assert.deepEqual(launches, [
      [0, "next"],
      [1, id],
    ]);
  });

  it("bounds retries and groups repeated atomic launch diagnostics", async () => {
    const id = "20261123-010000";
    let sleeps = 0;
    const launches: string[] = [];
    const logs: string[] = [];
    await run({
      options: { max: 1, statuses: ["locked", "open"] },
      project: "demo",
      loadSnapshot: async () => [
        { id, status: "locked", actionable: false },
        { id: "next", status: "open", actionable: true },
      ],
      readPiSessions: () => new Map(),
      locked: lockedDeps({ [id]: "old" }),
      log: (line) => logs.push(line),
      launch: (ticketId, name) => {
        launches.push(ticketId);
        return ticketId === id ? { retry: "locked launch unavailable" } : name;
      },
      async sleepMs() {
        assert.equal(++sleeps <= 3, true, "dispatcher did not finish");
      },
    });
    assert.deepEqual(launches, [id, id, "next"]);
    assert.equal(
      logs.filter((line) => line === `skipped ${id}: locked launch unavailable`).length,
      1,
    );
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
    copyFileSync(join(import.meta.dir, "lock-history.ts"), join(sourceDir, "lock-history.ts"));
    copyFileSync(
      join(import.meta.dir, "windows-dispatch.ts"),
      join(sourceDir, "windows-dispatch.ts"),
    );
    copyFileSync(join(import.meta.dir, "../dispatch-prompt.md"), join(home, "dispatch-prompt.md"));
    copyFileSync(
      join(import.meta.dir, "../dispatch-locked-prompt.md"),
      join(home, "dispatch-locked-prompt.md"),
    );
    const script = `
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { run, startDispatcher } from ${JSON.stringify(join(sourceDir, "dispatch.ts"))};
const options = ${JSON.stringify(options)};
const asset = ${JSON.stringify(join(home, "dispatch-prompt.md"))};
let receivedPrompt;
const deps = {
  options,
  loadSnapshot: async () => [{ id: "a", status: "open", actionable: true }],
  log() {},
  readPiSessions() { return new Map(); },
  launch(id, name, prompt) {
    receivedPrompt = prompt;
    return name;
  },
  async sleepMs() {},
};
for (const text of ["first {{ TICKET_ID }}", "second {{ TICKET_ID }}"]) {
  writeFileSync(asset, text);
  await run(deps);
  assert.equal(receivedPrompt, text.replace("{{ TICKET_ID }}", "a"));
}
rmSync(asset);
await assert.rejects(run(deps), /ENOENT/);
await assert.rejects(startDispatcher({
  project: "sample", command: [],
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
  it("requires an explicit project and one ID for one", () => {
    const ticketId = "20260920-120418";
    assert.deepEqual(parseDispatchArgs(["one", "--project", "sample", ticketId]), {
      action: "one",
      project: "sample",
      ticketId,
    });

    for (const args of [
      ["one", ticketId],
      ["one", "--project", "sample"],
      ["one", "--project", "sample", ticketId, "extra"],
      ["one", "--project", "sample", ticketId, "--all"],
      ["one", "--project", "sample", ticketId, "--max", "1"],
      ["one", "-p", "sample", ticketId],
    ]) {
      assert.ok(parseDispatchArgs(args).error, JSON.stringify(args));
    }
  });

  it("treats explicit start and the omitted action as equivalent", () => {
    const implicitStart = parseDispatchArgs([]);
    const explicitStart = parseDispatchArgs(["start"]);
    assert.deepEqual(explicitStart, implicitStart);
    assert.equal(explicitStart.action, "start");
  });

  it("selects multiple statuses and rejects unsupported statuses or actions", () => {
    assert.deepEqual(
      parseDispatchArgs([
        "start",
        "--status",
        "locked",
        "--status",
        "open",
        "--status",
        "locked",
        "--max",
        "1",
      ]).options,
      { max: 1, statuses: ["locked", "open"] },
    );
    for (const args of [
      ["start", "--status"],
      ["start", "--status", "blocked"],
      ["stop", "--status", "open"],
      ["list", "--status", "locked"],
    ])
      assert.ok(parseDispatchArgs(args).error, JSON.stringify(args));
  });

  it("uses the max default without an explicit project", () => {
    assert.deepEqual(parseDispatchArgs([]).options, { max: 5 });
  });

  it("accepts project and all flags after stop", () => {
    assert.deepEqual(parseDispatchArgs(["stop"]), {
      action: "stop",
      project: undefined,
      all: false,
    });
    for (const flag of ["-p", "--project"]) {
      assert.deepEqual(parseDispatchArgs(["stop", flag, "w"]), {
        action: "stop",
        project: "w",
        all: false,
      });
    }
    for (const flag of ["-a", "--all"]) {
      assert.deepEqual(parseDispatchArgs(["stop", flag]), {
        action: "stop",
        project: undefined,
        all: true,
      });
      assert.equal(parseDispatchArgs([flag]).all, true);
      assert.equal(parseDispatchArgs(["start", flag, "-p", "../ignored"]).all, true);
    }
    for (const args of [
      ["stop", "w"],
      ["stop", "--max", "1"],
    ]) {
      assert.ok(parseDispatchArgs(args).error, JSON.stringify(args));
    }
  });

  it("accepts the max override and positional option termination", () => {
    const parsed = parseDispatchArgs(["--max", "3", "--"]);
    assert.deepEqual(parsed.options, { max: 3 });
  });

  it.each(["w", "other project", "quote's project", "start", "stop"])(
    "preserves the project %s for implicit and explicit start",
    (project) => {
      for (const args of [
        ["-p", project],
        ["--project", project],
        ["start", "-p", project],
        ["start", "--project", project],
      ]) {
        const parsed = parseDispatchArgs(args);
        assert.equal(parsed.project, project);
        assert.equal(parsed.action, "start");
        assert.equal(parsed.error, undefined);
      }
    },
  );

  it("accepts a project between options", () => {
    const parsed = parseDispatchArgs(["--max", "3", "-p", "other"]);
    assert.equal(parsed.project, "other");
    assert.equal(parsed.options?.max, 3);
  });

  it("rejects positionals and missing option values", () => {
    for (const args of [
      [""],
      ["start", ""],
      ["a"],
      ["a", "b"],
      ["--", "a"],
      ["start", "a"],
      ["-p"],
      ["--project"],
      ["--project", "--max", "1"],
      ["-p", "-p", "x"],
      ["--max"],
      ["--max", "--max", "1"],
    ]) {
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
      "--json",
      "--help",
      "--nope",
      "--interval",
      "--prefix",
    ]) {
      assert.equal(parseDispatchArgs([flag, "x"]).error, `unknown option: ${flag}`);
    }
  });

  it("parses the bare list action and rejects its arguments", () => {
    assert.deepEqual(parseDispatchArgs(["list"]), {
      action: "list",
      project: undefined,
      all: false,
    });
    assert.equal(parseDispatchArgs(["list", "-p", "w"]).error, "unknown option: -p");
    for (const args of [
      ["list", "--project", "w"],
      ["list", "-a"],
      ["list", "--max", "1"],
      ["list", "start"],
      ["list", "--"],
      ["list", ""],
    ]) {
      assert.ok(parseDispatchArgs(args).error, JSON.stringify(args));
    }
  });

  it("requires a positive integer max", () => {
    for (const max of ["0", "-1", "1.5", "Infinity", "NaN", ""]) {
      assert.equal(parseDispatchArgs(["--max", max]).error, "--max must be an integer >= 1");
    }
  });
});

describe("dispatch list", () => {
  it("sorts the global dispatcher first and projects alphabetically", () => {
    const sorted = sortDispatchers([
      { project: "beta", name: "b", created: 1 },
      { project: null, name: "g", created: 2 },
      { project: "alpha", name: "a", created: 3 },
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.project),
      [null, "alpha", "beta"],
    );
  });

  it("aligns columns and renders the global marker with local time", () => {
    const created = Math.floor(new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000);
    const formatted = formatDispatchers([
      { project: null, name: "ticket_dispatch_all", created },
      { project: "alpha", name: "ticket_dispatch_long_name", created },
    ]);
    assert.deepEqual(formatted.split("\n"), [
      "(all)  ticket_dispatch_all        2026-01-02 03:04:05",
      "alpha  ticket_dispatch_long_name  2026-01-02 03:04:05",
    ]);
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

  it.each(["closed", "cancelled", "blocked", "draft"])(
    "releases %s tickets and refills the free slot in the same tick",
    (status) => {
      const plan = planTick({
        ...base,
        tickets: [{ id: "a", status, actionable: false }, ...base.tickets.slice(1)],
        started: new Set(["a", "b"]),
        running: new Map([
          ["fix_a", "a"],
          ["fix_b", "b"],
        ]),
      });
      assert.deepEqual(plan.done, [{ id: "a", session: "fix_a", status }]);
      assert.deepEqual(plan.launches, ["c"]);
      assert.equal(plan.finished, false);
    },
  );

  it("does not restart incomplete or previously released tickets", () => {
    const plan = planTick({
      ...base,
      started: new Set(["a", "b", "c"]),
      running: new Map([["fix_c", "c"]]),
      hasSession: () => false,
    });
    assert.deepEqual(plan.incomplete, [{ id: "c", session: "fix_c", status: "open" }]);
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
      running: new Map([["fix_a", "a"]]),
    });
    assert.deepEqual(plan.launches, []);
    assert.equal(plan.finished, false);
  });

  it("does not launch more tickets when running sessions already exceed max", () => {
    const plan = planTick({
      ...base,
      running: new Map([
        ["fix_x", "x"],
        ["fix_y", "y"],
        ["fix_z", "z"],
      ]),
    });
    assert.deepEqual(plan.launches, []);
    assert.equal(plan.finished, false);
  });

  it("finishes when there are no actionable tickets or running sessions", () => {
    assert.equal(planTick({ ...base, tickets: [] }).finished, true);
  });

  it.each(["closed", "cancelled", "blocked", "draft"])(
    "prioritizes done for %s over a missing session",
    (status) => {
      const plan = planTick({
        ...base,
        tickets: [{ id: "a", status, actionable: false }],
        started: new Set(["a"]),
        running: new Map([["fix_a", "a"]]),
        hasSession: () => false,
      });
      assert.deepEqual(plan.done, [{ id: "a", session: "fix_a", status }]);
      assert.deepEqual(plan.incomplete, []);
      assert.equal(plan.finished, true);
    },
  );

  it("reports none when a running ticket disappeared from the snapshot", () => {
    const plan = planTick({
      ...base,
      tickets: [],
      started: new Set(["a"]),
      running: new Map([["fix_a", "a"]]),
      hasSession: () => false,
    });
    assert.deepEqual(plan.incomplete, [{ id: "a", session: "fix_a", status: null }]);
  });

  it("excludes tickets of skipped projects from launches", () => {
    const plan = planTick({
      ...base,
      tickets: [
        { id: "gone/a", status: "open", actionable: true },
        { id: "kept/b", status: "open", actionable: true },
      ],
      skipped: new Set(["gone"]),
      max: 5,
    });
    assert.deepEqual(plan.launches, ["kept/b"]);
    assert.equal(plan.finished, false);
  });
});

describe("dispatch all mode", () => {
  function runAll(home: string, socket: string, tickets: TicketSnapshot[]) {
    const script = `
import { run } from ${JSON.stringify(join(import.meta.dir, "dispatch.ts"))};
const events = [];
try {
  await run({
    options: { max: 5 },
    all: true,
    loadSnapshot: async () => ${JSON.stringify(tickets)},
    log: (line) => events.push(line),
    readPiSessions: () => new Map(),
    launch(id, name) {
      events.push("launch " + id);
      return name;
    },
    async sleepMs() {},
  });
  console.log(JSON.stringify({ events }));
} catch (error) {
  console.log(JSON.stringify({ events, error: String(error) }));
}
`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home, TICKET_TEST_TMUX_SOCKET: socket },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout)) as {
      events: string[];
      error?: string;
    };
  }

  it("skips a missing candidate cwd and launches the remaining projects", () => {
    const { home, socket } = fixture();
    mkdirSync(join(home, "projects", "present"), { recursive: true });
    const { events, error } = runAll(home, socket, [
      { id: "gone/first", status: "open", actionable: true },
      { id: "present/second", status: "open", actionable: true },
    ]);
    assert.equal(error, undefined);
    assert.deepEqual(events, [
      "dispatcher start max=5",
      `skipped gone: cwd not found: ${join(home, "projects", "gone")}`,
      "launch present/second",
      "launched present/second as handle_70726573656e74_second",
      `skipped gone: cwd not found: ${join(home, "projects", "gone")}`,
      "incomplete present/second status=open session exited without close",
      "dispatcher finished",
    ]);
  });

  it("still rejects non-directory candidate cwds", () => {
    const { home, socket } = fixture();
    mkdirSync(join(home, "projects"), { recursive: true });
    writeFileSync(join(home, "projects", "gone"), "not a directory");
    const { events, error } = runAll(home, socket, [
      { id: "gone/first", status: "open", actionable: true },
    ]);
    assert.match(error!, /not a directory/);
    assert.deepEqual(events, ["dispatcher start max=5"]);
  });
});

const fixtures: Array<{ home: string; socket: string }> = [];
const TEMP_ROOT = "/tmp/work/dotfiles/remove-dispatch-artifacts";
const CLI = join(import.meta.dir, "main.ts");

function fixture() {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const home = mkdtempSync(join(TEMP_ROOT, "ticket-dispatch-unit-"));
  const socket = join(home, "isolated.sock");
  fixtures.push({ home, socket });
  const store = join(home, ".agents", "tickets", basename(home));
  mkdirSync(store, { recursive: true });
  const options = parseDispatchArgs(["--max", "2"]).options!;
  return { home, store, options, socket };
}

function invoke(home: string, args: string[], socket = join(home, "isolated.sock")) {
  const command = process.env.TICKET_DISPATCH_BIN
    ? [process.env.TICKET_DISPATCH_BIN]
    : [process.execPath, CLI];
  const result = Bun.spawnSync([...command, "dispatch", ...args], {
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

async function waitStopped(
  home: string,
  socket: string,
  project: string | null = basename(home),
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const session = Bun.spawnSync([
      "tmux",
      "-S",
      socket,
      "has-session",
      "-t",
      `=${dispatcherName(project)}`,
    ]);
    if (session.exitCode !== 0) return;
    await Bun.sleep(10);
  }
  assert.fail("dispatcher did not finish");
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
  it.each(["closed", "blocked"])(
    "rescans and refills slots released by %s without restarting reopened tickets",
    async (releasedStatus) => {
      const { options } = fixture();
      let tickets: TicketSnapshot[] = [
        { id: "a", status: "open", actionable: true },
        { id: "b", status: "blocked", actionable: false },
      ];
      const events: string[] = [];
      let sleeps = 0;
      let scans = 0;
      const liveSessions = new Map<string, string>();
      await run({
        options,
        loadSnapshot: async () => {
          scans++;
          return tickets;
        },
        log: (line) => events.push(line),
        readPiSessions: () => liveSessions,
        launch: (id, name, prompt) => {
          assert.ok(prompt.startsWith(`ticket ${id} に対応する。`));
          assert.match(prompt, /user はticketを読んでいない前提で/);
          assert.doesNotMatch(prompt, /`closed` にするとセッションが終了する/);
          events.push(`start ${name}`);
          if (id !== "b") liveSessions.set(name, id);
          return name;
        },
        sleepMs: async (ms) => {
          assert.equal(ms, 3000);
          sleeps++;
          assert.ok(sleeps <= 3, "dispatcher did not finish");
          if (sleeps === 2) {
            tickets = [
              { id: "a", status: releasedStatus, actionable: false },
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
        "start handle_a",
        "launched a as handle_a",
        `done a status=${releasedStatus}`,
        "start handle_b",
        "launched b as handle_b",
        "start handle_c",
        "launched c as handle_c",
        "done c status=cancelled",
        "incomplete b status=open session exited without close",
        "dispatcher finished",
      ]);
    },
  );

  it("does not retry a launch rejected as a session-name collision", async () => {
    const { options } = fixture();
    const logs: string[] = [];
    let launches = 0;
    await run({
      options,
      loadSnapshot: async () => [{ id: "a", status: "open", actionable: true }],
      log: (line) => logs.push(line),
      readPiSessions: () => new Map(),
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
      loadSnapshot: async () => [{ id: "a", status: "closed", actionable: false }],
      log: (line) => events.push(line),
      readPiSessions: () => new Map([["existing_a", "a"]]),
      launch: () => {
        launches++;
        return false;
      },
      sleepMs: async () => {},
    });
    assert.equal(launches, 0);
    assert.deepEqual(events, [
      "dispatcher start max=2",
      "done a status=closed",
      "dispatcher finished",
    ]);
  });

  it("quotes prompt text without expansion and preserves trailing newlines", () => {
    const prompt = "a 'b' \"double\" $HOME `x` \\ {{ TICKET_ID }}\n\n";
    const result = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shQuote(prompt)}`]);
    assert.equal(result.exitCode, 0);
    assert.equal(new TextDecoder().decode(result.stdout), prompt);
  });
});

describe("dispatch CLI", () => {
  it("returns usage error 2 for invalid dispatch inputs", () => {
    const { home } = fixture();
    const invalid = [
      ["stop", "extra"],
      ["stop", "--max", "1"],
      ["a"],
      ["--", "a"],
      ["start", "a"],
      ["a", "b"],
      [""],
      ["start", ""],
      ["--max"],
      ["--max", "0"],
      ["--interval"],
      ["--prefix"],
      ["--template"],
      ["--socket", "x"],
      ["-p"],
      ["--project"],
      ["--max", "-p", "x"],
      ["stop", "--interval", "1"],
      ["stop", "--prefix", "x"],
      ["--json"],
    ];
    for (const args of invalid) {
      const result = invoke(home, args);
      assert.equal(result.code, 2, JSON.stringify(args));
      assert.match(result.stderr, /usage: ticket dispatch list/);
      assert.equal(result.stdout, "");
    }
  });

  it("rejects list arguments with the same usage status", () => {
    const { home } = fixture();
    for (const args of [
      ["list", "-p", "w"],
      ["list", "start"],
      ["list", "--"],
    ]) {
      const result = invoke(home, args);
      assert.equal(result.code, 2, JSON.stringify(args));
      assert.match(result.stderr, /usage: ticket dispatch list/);
      assert.equal(result.stdout, "");
    }
  });

  it.each(["missing", "file", "inaccessible"])(
    "rejects a %s target directory before starting a dispatcher",
    (kind) => {
      const { home, socket } = fixture();
      const directory = join(home, "projects", "target");
      mkdirSync(join(home, "projects"), { recursive: true });
      if (kind === "file") writeFileSync(directory, "not a directory");
      if (kind === "inaccessible") {
        mkdirSync(directory);
        chmodSync(directory, 0o600);
      }
      try {
        const result = invoke(home, ["-p", "target"]);
        assert.equal(result.code, 1, result.stderr);
        assert.match(result.stderr, /^I\/O error:/);
        assert.equal(result.stdout, "");
        assert.equal(existsSync(socket), false);
      } finally {
        if (kind === "inaccessible") chmodSync(directory, 0o700);
      }
    },
  );

  it.each(["", ".", "..", "../outside", "/tmp/target", "nested/target", "nested\\target"])(
    "rejects invalid project %j before accessing directories or starting tmux",
    (project) => {
      const { home, socket } = fixture();
      for (const args of [
        ["-p", project],
        ["start", "--project", project],
        ["stop", "-p", project],
      ]) {
        const result = invoke(home, args);
        assert.equal(result.code, 1, JSON.stringify(args));
        assert.equal(result.stderr, `invalid project: ${project}\n`);
        assert.equal(result.stdout, "");
        assert.equal(existsSync(socket), false);
      }
      assert.equal(existsSync(join(home, "projects")), false);
    },
  );

  it("returns code 1 when tmux cannot create the detached dispatcher session", () => {
    const { home } = fixture();
    const unavailableSocket = join(home, "missing-parent", "tmux.sock");
    const result = invoke(home, [], unavailableSocket);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^I\/O error: dispatcher start failed for ticket_dispatch_/);
    assert.equal(result.stdout, "");
  });

  it("returns after detached start and finishes an empty store without artifacts", async () => {
    const { home, socket } = fixture();
    const result = invoke(home, ["start"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `dispatcher started: ${dispatcherName(basename(home))}\n`);
    await waitStopped(home, socket);
    assert.equal(existsSync(join(home, "dispatch.log")), false);
    assert.equal(existsSync(join(home, "fix")), false);
  });

  it("accepts stop when this project's dispatcher is not running", () => {
    const { home } = fixture();
    const result = invoke(home, ["stop"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^dispatcher already stopped: ticket_dispatch_/);
    assert.equal(result.stderr, "");
  });

  it.each(["-p", "--project"])(
    "stops a missing named project without reading its store or changing cwd (%s)",
    (flag) => {
      const { home } = fixture();
      const result = invoke(home, ["stop", flag, "missing"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, `dispatcher already stopped: ${dispatcherName("missing")}\n`);
      assert.equal(result.stderr, "");
      assert.equal(existsSync(join(home, "projects")), false);
    },
  );

  it.each([false, true])(
    "keeps worker lifecycle or error messages on stdout (invalid=%s)",
    (invalid) => {
      const { home, socket, store } = fixture();
      if (invalid) writeFileSync(join(store, "broken.md"), "---\nstatus: unknown\n---\n");
      const server = Bun.spawnSync([
        "tmux",
        "-S",
        socket,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "anchor",
        "sleep 60",
      ]);
      assert.equal(server.exitCode, 0, new TextDecoder().decode(server.stderr));
      const result = Bun.spawnSync(
        [process.execPath, CLI, "__ticket_dispatch_worker", basename(home)],
        {
          cwd: home,
          env: { ...process.env, HOME: home, TICKET_TEST_TMUX_SOCKET: socket },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      assert.equal(result.exitCode, invalid ? 1 : 0, stderr);
      assert.match(stdout, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] dispatcher start max=5\n/);
      if (invalid) {
        assert.match(stdout, /\] invalid status "unknown"/);
        assert.match(stderr, /^invalid status "unknown"/);
      } else {
        assert.match(stdout, /\] dispatcher finished\n$/);
        assert.equal(stderr, "");
      }
      assert.equal(existsSync(join(home, "dispatch.log")), false);
      assert.equal(existsSync(join(home, "fix")), false);
    },
  );

  it("preserves existing log and prompt files", async () => {
    const { home, socket } = fixture();
    const log = join(home, "dispatch.log");
    const prompt = join(home, "fix", "prompt-a.txt");
    writeFileSync(log, "previous log\n");
    mkdirSync(join(home, "fix"));
    writeFileSync(prompt, "previous prompt\n");
    const result = invoke(home, []);
    assert.equal(result.code, 0, result.stderr);
    await waitStopped(home, socket);
    assert.equal(await Bun.file(log).text(), "previous log\n");
    assert.equal(await Bun.file(prompt).text(), "previous prompt\n");
  });

  it("ignores existing paths that previously held artifacts", async () => {
    const { home, socket } = fixture();
    mkdirSync(join(home, "dispatch.log"));
    writeFileSync(join(home, "fix"), "not a directory");
    const result = invoke(home, []);
    assert.equal(result.code, 0, result.stderr);
    await waitStopped(home, socket);
    assert.equal(await Bun.file(join(home, "fix")).text(), "not a directory");
  });
});

describe("dispatch snapshot validation", () => {
  it("uses existing ticket validation rather than silently skipping broken tickets", () => {
    const { home, store } = fixture();
    writeFileSync(join(store, "broken.md"), "---\nstatus: unknown\n---\n");
    const result = invoke(home, []);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^invalid status "unknown"/);
    assert.ok(!result.stderr.includes("I/O error"));
  });

  it("uses the existing missing-project error", () => {
    const { home, store } = fixture();
    rmSync(store, { recursive: true });
    const result = invoke(home, []);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^project not found:/);
    assert.ok(!result.stderr.includes("I/O error"));
  });
});

describe("global dispatch snapshot validation", () => {
  it.each(["-a", "--all"])(
    "finishes an empty global store without requiring project directories (%s)",
    async (flag) => {
      const { home, socket } = fixture();
      const result = invoke(home, [flag]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, `dispatcher started: ${dispatcherName(null)}\n`);
      const deadline = Date.now() + 5000;
      while (hasSession(socket, dispatcherName(null)) && Date.now() < deadline) await Bun.sleep(10);
      assert.equal(hasSession(socket, dispatcherName(null)), false);
      assert.equal(existsSync(join(home, "projects")), false);
    },
  );

  it("rejects a file as the global cwd for a selected locked ticket before creating a dispatcher", async () => {
    const { home, store, socket } = fixture();
    const id = "20261123-010001";
    const cwd = join(home, "projects", basename(home));
    writeFileSync(join(store, `${id}.md`), "---\nstatus: locked\n---\n");
    mkdirSync(join(home, "projects"));
    writeFileSync(cwd, "not a directory");

    const result = invoke(home, ["--all", "--status", "locked"]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stderr.trimEnd(), `I/O error: not a directory: ${cwd}`);
    assert.equal(existsSync(socket), false);

    const openOnly = invoke(home, ["--all"]);
    assert.equal(openOnly.code, 0, openOnly.stderr);
    await waitStopped(home, socket, null);
  });

  it.each(["missing", "invalid"])("fails before dispatching for a %s global store", (kind) => {
    const { home, store, socket } = fixture();
    if (kind === "missing") rmSync(join(home, ".agents", "tickets"), { recursive: true });
    else writeFileSync(join(store, "invalid.md"), "---\nstatus: unknown\n---\n");
    const result = invoke(home, ["--all"]);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      kind === "missing" ? /^ticket store not found:/ : /^invalid status/,
    );
    assert.equal(existsSync(socket), false);
  });
});

describe("dispatcher lock recovery", () => {
  it.each([
    { name: "global start", args: ["--all"], project: null },
    { name: "global stop", args: ["stop", "--all"], project: null },
    { name: "project start", args: [], project: "local" },
    { name: "project stop", args: ["stop"], project: "local" },
  ])(
    "recovers $name after a lock holder is killed during its snapshot read",
    async ({ args, project }) => {
      const { home, socket } = fixture();
      const holder = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
import { startDispatcher } from ${JSON.stringify(join(import.meta.dir, "dispatch.ts"))};
await startDispatcher({
  project: null,
  command: [],
  async loadSnapshot() {
    console.log("snapshot holds lock");
    await Bun.sleep(60000);
    return [];
  },
});
`,
        ],
        {
          cwd: home,
          env: { ...process.env, HOME: home, TICKET_TEST_TMUX_SOCKET: socket },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const ready = await holder.stdout.getReader().read();
        assert.equal(ready.done, false, "holder exited before acquiring the lock");
        assert.match(new TextDecoder().decode(ready.value), /snapshot holds lock/);
        holder.kill("SIGKILL");
        assert.notEqual(await holder.exited, 0);
        const recovered = invoke(home, [...args], socket);
        assert.equal(recovered.code, 0, recovered.stderr);
        assert.equal(recovered.stderr, "");
        assert.match(recovered.stdout, /dispatcher (started|already stopped):/);
        const name = dispatcherName(project === null ? null : basename(home));
        const deadline = Date.now() + 5000;
        while (hasSession(socket, name) && Date.now() < deadline) await Bun.sleep(10);
        assert.equal(hasSession(socket, name), false);
      } finally {
        holder.kill("SIGKILL");
        await holder.exited;
      }
    },
    15000,
  );
});
