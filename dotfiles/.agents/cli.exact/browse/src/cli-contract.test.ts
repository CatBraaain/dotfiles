import { afterAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LOCK_CONFLICT_EXIT_CODE, RESTART_LOCK_FILE } from "./config";
import { createWithLockHome, withLockMainPath } from "./fixtures/with-lock";

const project = join(import.meta.dir, "..");
const preload = join(import.meta.dir, "fixtures/cli-environment.ts");
const lockHome = createWithLockHome(mkdtempSync(join(tmpdir(), "browse-cli-home-")));
const noLockHome = mkdtempSync(join(tmpdir(), "browse-cli-no-lock-"));
const withLockPath = join(lockHome, ".agents", "cli", "with-lock");
const searchUsage = 'usage: browse search "<query>" [--lang <code>] [--json]\n';
const fetchUsage = "usage: browse fetch <url> [--json]\n";
const loginUsage = "usage: browse login twitter\n";
const displayUsage = "usage: browse display show\n       browse display hide\n";
const windowsPlatform = { BROWSE_FIXTURE_PLATFORM: "win32" };
const topLevelUsage = `${searchUsage}       browse fetch <url> [--json]
       browse login twitter
       browse server start
       browse server stop
       browse server restart
       browse display show
       browse display hide
`;

afterAll(() => {
  for (const home of [lockHome, noLockHome]) rmSync(home, { recursive: true, force: true });
});

interface CliFixtureOutput {
  backend?: string;
  fallbacks?: { backend: string }[];
}

function runCli(args: string[], extraEnv: Record<string, string> = {}, existingCookies?: string) {
  const root = mkdtempSync(join(tmpdir(), "browse-cli-contract-"));
  try {
    const cookiesDir = join(root, "pi", "web-search");
    const cookiesPath = join(cookiesDir, "twitter-cookies.json");
    if (existingCookies !== undefined) {
      mkdirSync(cookiesDir, { recursive: true });
      writeFileSync(cookiesPath, existingCookies);
    }
    const trace = join(root, "trace");
    const child = Bun.spawnSync([process.execPath, "--preload", preload, project, ...args], {
      env: {
        ...process.env,
        HOME: lockHome,
        XDG_CACHE_HOME: root,
        CAMOUFOX_HEADLESS: "1",
        BROWSE_FIXTURE_TRACE: trace,
        ...extraEnv,
      },
      timeout: 5000,
    });
    const events = existsSync(trace)
      ? readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return {
      code: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      cookies: existsSync(cookiesPath) ? readFileSync(cookiesPath, "utf8") : undefined,
      events,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("CLI argument contract", () => {
  it("prints the top-level usage to stdout and exits 0 for --help alone", () => {
    const result = runCli(["--help"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, topLevelUsage);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.events, []);
  });

  for (const args of [[], ["unknown"], ["--help", "extra"]]) {
    it(`rejects invalid top-level arguments: ${JSON.stringify(args)}`, () => {
      const result = runCli(args);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, topLevelUsage);
      assert.deepEqual(result.events, []);
    });
  }
  for (const [args, usage] of [
    [["search"], searchUsage],
    [["search", "one", "two"], searchUsage],
    [["search", "query", "--unknown"], searchUsage],
    [["search", "query", "--lang"], searchUsage],
    [["fetch"], fetchUsage],
    [["fetch", "https://example.com", "extra"], fetchUsage],
    [["fetch", "https://example.com", "--unknown"], fetchUsage],
  ] as const) {
    it(`rejects malformed arguments before any backend: ${args.join(" ")}`, () => {
      const result = runCli([...args]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, usage);
      assert.deepEqual(result.events, []);
    });
  }

  for (const query of ["-", "-query"]) {
    it(`treats ${query} as a positional argument rather than a flag`, () => {
      const result = runCli(["__locked", "search", query, "--json"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).query, query);
    });
  }

  it("takes a double-dash argument as the value immediately after --lang", () => {
    const result = runCli(["__locked", "search", "query", "--lang", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^\*\*Query:\*\*/);
    const begin = result.events.find((event) => event.event === "begin");
    assert.equal(new URL(begin.url).searchParams.get("hl"), "--json");
  });

  it("rejects nonabsolute fetch URLs with one error line", () => {
    const result = runCli(["fetch", "/relative"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "not an absolute URL: /relative\n");
    assert.deepEqual(result.events, []);
  });
});

describe("CLI output and failure contract", () => {
  for (const operation of ["search", "fetch"]) {
    const input = operation === "search" ? "query" : "https://example.com/article";
    it(`emits a single parseable JSON document for ${operation} --json`, () => {
      const result = runCli(["__locked", operation, input, "--json"]);
      assert.equal(result.code, 0, result.stderr);
      const json = JSON.parse(result.stdout);
      assert.equal(result.stderr, "");
      assert.equal(typeof json.tookMs, "number");
      if (operation === "search") {
        assert.equal(json.query, input);
        assert.equal(json.engine, "google");
        assert.equal(json.results[0].title, "Found");
      } else {
        assert.equal(json.url, input);
        assert.equal(json.title, "Article");
        assert.equal(json.body, "# Article\n\nBody");
        assert.equal(json.fallbacks[0].backend, "RSS");
      }
    });

    it(`emits markdown without --json for ${operation}`, () => {
      const result = runCli(["__locked", operation, input]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(
        result.stdout,
        operation === "search" ? /^\*\*Query:\*\*.*\n\n### 1\. Found/ : /^# Article\n\nBody\n$/,
      );
    });
  }

  it("prints all failed engines on one stderr line and exits 1", () => {
    const result = runCli(["__locked", "search", "query"], { BROWSE_FIXTURE_SCENARIO: "failure" });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^All web search backends failed: camoufox\+openserp\(google\): .*; camoufox\+openserp\(duckduckgo\): .*; camoufox\+openserp\(bing\): .*\n$/,
    );
    assert.equal(result.stderr.trim().split("\n").length, 1);
  });

  it("escapes multiline backend errors within the single stderr summary line", () => {
    const result = runCli(["__locked", "search", "query", "--json"], {
      BROWSE_FIXTURE_SCENARIO: "multiline-failure",
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.split(/[\r\n\u2028\u2029]/).length, 2, result.stderr);
    assert.match(result.stderr, /^All web search backends failed:/);
    assert.ok(
      result.stderr.includes(
        String.raw`render: unavailable\r\ncall log\nfirst frame\rsecond frame\u2028third frame\u2029last frame`,
      ),
      result.stderr,
    );
  });

  it("adds the recovery Hint on a second stderr line after multiline render aborts", () => {
    const result = runCli(["__locked", "search", "query"], { BROWSE_FIXTURE_SCENARIO: "abort" });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim().split("\n").length, 2);
    assert.match(result.stderr, /\nHint: .*transient.*server restart/);
  });

  it("prints a dedicated fetch failure on one stderr line with no JSON output", () => {
    const result = runCli(["fetch", "https://www.reddit.com/r/bun/comments/abc123/", "--json"], {
      BROWSE_FIXTURE_SCENARIO: "failure-fetch",
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "All web fetch backends failed: Reddit: Unable to fetch Reddit post abc123 (RSS 403)\n",
    );
  });

  it("reports startup timeout through the real CLI error handler", () => {
    const result = runCli(["server", "start"], { BROWSE_FIXTURE_SCENARIO: "start-timeout" });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "camoufox server not ready at fixture\n");
  });

  it("runs without exclusion when with-lock is not installed", () => {
    const result = runCli(["search", "query", "--json"], { HOME: noLockHome });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).engine, "google");
    assert.ok(!result.events.some((event) => event.command === withLockPath));
  });

  it.skipIf(process.platform !== "linux")(
    "restarts once through the public command without with-lock",
    () => {
      const result = runCli(["server", "restart"], { HOME: noLockHome });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.deepEqual(
        result.events.map(({ command, event }) => command ?? event),
        ["restart"],
      );
    },
  );

  for (const [action, directCall] of [
    ["stop", "pgrep"],
    ["restart", "restart"],
  ] as const) {
    it.skipIf(process.platform !== "linux")(
      `runs server ${action} directly when starting with-lock returns ENOENT`,
      () => {
        const result = runCli(["server", action], { BROWSE_FIXTURE_SCENARIO: "lock-spawn-enoent" });
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(
          result.events.map(({ command, event }) => command ?? event),
          [withLockPath, directCall],
        );
      },
    );
  }

  it.skipIf(process.platform !== "linux")(
    "drains the restart lock and every render slot through with-lock before restarting",
    () => {
      const result = runCli(["server", "restart"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      const lockCalls = result.events.filter((event) => event.command === withLockPath);
      assert.equal(lockCalls.length, 1);
      const lockArgs: string[] = lockCalls[0].args;
      assert.deepEqual(
        lockArgs.filter((arg) => arg.endsWith(".lock")).map((arg) => basename(arg)),
        [
          "browse-restart.lock",
          "browse-slot-0.lock",
          "browse-slot-1.lock",
          "browse-slot-2.lock",
          "browse-slot-3.lock",
        ],
      );
      assert.deepEqual(lockCalls[0].args.slice(-3), ["__locked", "server", "restart"]);
      assert.equal(result.events.filter((event) => event.event === "restart").length, 1);
    },
  );

  it("does not acquire a render slot for a Reddit fetch", () => {
    const result = runCli(["fetch", "https://www.reddit.com/r/bun/comments/abc123/", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).backend, "Reddit");
    assert.equal(result.events.filter((event) => event.command === withLockPath).length, 0);
  });
});

describe("Windows CLI contract", () => {
  for (const action of ["show", "hide"]) {
    it(`reports display ${action} as unsupported without touching VNC`, () => {
      const result = runCli(["display", action], windowsPlatform);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `browse display ${action} is not supported on Windows.\n`);
      assert.deepEqual(result.events, []);
    });
  }

  for (const cookies of [undefined, '{"auth_token":"fixture"}']) {
    it(`reports Twitter login as unsupported and ${cookies ? "preserves" : "does not create"} cookies`, () => {
      const result = runCli(["login", "twitter"], windowsPlatform, cookies);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "browse login twitter is not supported on Windows.\n");
      assert.deepEqual(result.events, []);
      assert.equal(result.cookies, cookies);
    });
  }

  for (const [args, usage] of [
    [["display"], displayUsage],
    [["display", "toggle"], displayUsage],
    [["display", "hide", "extra"], displayUsage],
    [["login"], loginUsage],
    [["login", "other"], loginUsage],
    [["login", "twitter", "extra"], loginUsage],
  ] as const) {
    it(`rejects malformed arguments: ${args.join(" ")}`, () => {
      const result = runCli([...args], windowsPlatform);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, usage);
      assert.deepEqual(result.events, []);
    });
  }

  for (const args of [
    ["search", "query", "--json"],
    ["fetch", "https://example.com/article", "--json"],
    ["__locked", "search", "query", "--json"],
  ]) {
    it(`renders with a per-process session and no lock: ${args.join(" ")}`, () => {
      const result = runCli(args, { ...windowsPlatform, BROWSE_SLOT: "0" });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      const render = result.events.find(({ event }) => event === "begin");
      assert.ok(render);
      const operation = args.includes("search") ? "search" : "fetch";
      assert.equal(render.session, `web-${operation}-${render.pid}`);
      assert.ok(!result.events.some(({ command }) => command === withLockPath));
    });
  }

  it("restarts once without with-lock", () => {
    const result = runCli(["server", "restart"], windowsPlatform);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(
      result.events.map(({ command, event }) => command ?? event),
      ["restart"],
    );
  });
});

describe("Non-Linux lock handling", () => {
  for (const args of [
    ["search", "query", "--json"],
    ["__locked", "search", "query", "--json"],
  ]) {
    it(`uses a PID-based render session without launching with-lock on macOS: ${args.join(" ")}`, () => {
      const result = runCli(args, { BROWSE_FIXTURE_PLATFORM: "darwin", BROWSE_SLOT: "0" });
      assert.equal(result.code, 0, result.stderr);
      const render = result.events.find(({ event }) => event === "begin");
      assert.ok(render);
      assert.equal(render.session, `web-search-${render.pid}`);
      assert.ok(!result.events.some(({ event }) => event === "spawnSync"));
    });
  }
});

describe("CLI server stop contract", () => {
  const port = "19378";
  const serverUrl = `ws://127.0.0.1:${port}/camoufox`;
  const windows = { ...windowsPlatform, CAMOUFOX_BASE_URL: serverUrl };

  it("stops the matching Windows server without starting another one", () => {
    const result = runCli(["server", "stop"], windows);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(
      result.events.map(({ event, command }) => command ?? event),
      ["find-windows-server", "stop-windows-process"],
    );
    assert.equal(result.events[0].port, port);
    const stoppedProcess = result.events[1];
    assert.equal(stoppedProcess.targetPid, 41001);
    assert.equal(stoppedProcess.identity, "fixture");
  });

  it("succeeds without starting a Windows server when none matches", () => {
    const result = runCli(["server", "stop"], { ...windows, BROWSE_FIXTURE_SCENARIO: "stop-none" });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      result.events.map(({ event }) => event),
      ["find-windows-server"],
    );
  });

  it("reports failure if Windows cannot confirm the server exited", () => {
    const result = runCli(["server", "stop"], {
      ...windows,
      BROWSE_FIXTURE_SCENARIO: "stop-failed",
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "Could not confirm the Windows Camoufox server exited\n");
    assert.ok(!result.events.some(({ command }) => command === withLockPath));
  });

  it("reports the shared process discovery error outside Linux and Windows", () => {
    const result = runCli(["server", "stop"], {
      BROWSE_FIXTURE_PLATFORM: "darwin",
      CAMOUFOX_BASE_URL: serverUrl,
    });
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "Camoufox process discovery is only supported on Linux and Windows\n",
    );
    assert.deepEqual(result.events, []);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture did not reach expected state");
    await Bun.sleep(10);
  }
}

describe.skipIf(process.platform !== "linux")("CLI four-slot coordination", () => {
  it("yields a just-acquired slot when the restart lock is held", () => {
    const result = runCli(["__locked", "search", "query", "--json"], {
      BROWSE_SLOT: "0",
      BROWSE_FIXTURE_SCENARIO: "restart-lock-held",
    });
    assert.equal(result.code, LOCK_CONFLICT_EXIT_CODE, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(result.events.length, 1);
    const [probe] = result.events;
    assert.equal(probe.command, withLockPath);
    const probeArgs: string[] = probe.args;
    assert.deepEqual(probeArgs.slice(0, 3), ["-n", "-E", String(LOCK_CONFLICT_EXIT_CODE)]);
    assert.equal(basename(probeArgs[3]!), RESTART_LOCK_FILE);
    assert.equal(probeArgs[4], "true");
  });

  it("renders when the restart-lock probe cannot be spawned", () => {
    const result = runCli(["__locked", "search", "query", "--json"], {
      BROWSE_SLOT: "0",
      BROWSE_FIXTURE_SCENARIO: "lock-spawn-enoent",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.events[0].command, withLockPath);
    assert.ok(result.events.some(({ event }) => event === "begin"));
  });

  it("shares four slots between public search and fetch commands and drains both before restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "browse-cli-slots-"));
    const trace = join(root, "trace");
    const gate = join(root, "release");
    const children: ReturnType<typeof Bun.spawn>[] = [];
    function events(): any[] {
      if (!existsSync(trace)) return [];
      return readFileSync(trace, "utf8")
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
    function launch(args: string[]) {
      const child = Bun.spawn([process.execPath, "--preload", preload, project, ...args], {
        env: {
          ...process.env,
          HOME: lockHome,
          XDG_CACHE_HOME: root,
          CAMOUFOX_HEADLESS: "1",
          BROWSE_FIXTURE_TRACE: trace,
          BROWSE_FIXTURE_GATE: gate,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      return child;
    }
    try {
      for (let index = 0; index < 2; index++) {
        launch(["search", `query${index}`, "--json"]);
        launch(["fetch", `https://example.com/article${index}`, "--json"]);
      }
      await waitUntil(() => events().filter((event) => event.event === "begin").length === 4);
      const started = events().filter((event) => event.event === "begin");
      assert.deepEqual(started.map((event) => event.slot).sort(), ["0", "1", "2", "3"]);
      assert.equal(started.filter((event) => event.session.startsWith("web-search-")).length, 2);
      assert.equal(started.filter((event) => event.session.startsWith("web-fetch-")).length, 2);
      launch(["fetch", "https://example.com/fifth", "--json"]);
      await waitUntil(() =>
        events().some(
          (event) =>
            event.command === withLockPath &&
            event.args[0] === "-w" &&
            event.args.includes("https://example.com/fifth"),
        ),
      );
      launch(["server", "restart"]);
      await waitUntil(() =>
        events().some(
          (event) =>
            event.command === withLockPath && event.args[0]?.endsWith("browse-restart.lock"),
        ),
      );
      await waitUntil(
        () =>
          Bun.spawnSync([
            process.execPath,
            withLockMainPath,
            "-n",
            "-E",
            "192",
            join(root, "pi/web-search/browse-restart.lock"),
            "true",
          ]).exitCode === 192,
      );
      await waitUntil(() =>
        events().some(
          (event) =>
            event.command === withLockPath &&
            event.args[0] === "-w" &&
            event.args[2]?.endsWith("browse-restart.lock"),
        ),
      );
      assert.equal(events().filter((event) => event.event === "begin").length, 4);
      assert.equal(events().filter((event) => event.event === "restart").length, 0);
      writeFileSync(gate, "release");
      const statuses = await Promise.all(children.map((child) => child.exited));
      const errors = await Promise.all(
        children.map((child) => new Response(child.stderr as ReadableStream<Uint8Array>).text()),
      );
      assert.deepEqual(statuses, [0, 0, 0, 0, 0, 0], errors.join("\n"));
      const outputs = await Promise.all(
        children
          .slice(0, 5)
          .map(
            (child) =>
              new Response(
                child.stdout as ReadableStream<Uint8Array>,
              ).json() as Promise<CliFixtureOutput>,
          ),
      );
      const fetchOutputs = outputs.filter((output) => output.backend);
      assert.equal(fetchOutputs.length, 3);
      for (const output of fetchOutputs) {
        assert.equal(output.backend, "camoufox+trafilatura");
        assert.equal(output.fallbacks?.[0]?.backend, "RSS");
      }
      const completed = events();
      const restartIndex = completed.findIndex((event) => event.event === "restart");
      assert.equal(completed.filter((event) => event.event === "begin").length, 5);
      assert.equal(
        completed.slice(0, restartIndex).filter((event) => event.event === "end").length,
        4,
      );
      assert.ok(
        restartIndex <
          completed.findIndex(
            (event) => event.event === "begin" && event.url === "https://example.com/fifth",
          ),
      );
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exited));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
