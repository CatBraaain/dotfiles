import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = join(import.meta.dir, "..");
const preload = join(import.meta.dir, "fixtures/cli-environment.ts");
const searchUsage = 'usage: browse search "<query>" [--lang <code>] [--json]\n';
const fetchUsage = "usage: browse fetch <url> [--json]\n";
const topLevelUsage = `${searchUsage}       browse fetch <url> [--json]
       browse login twitter
       browse server start
       browse server stop
       browse server restart
       browse display show
       browse display hide
`;

interface CliFixtureOutput {
  backend?: string;
  fallbacks?: { backend: string }[];
}

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "browse-cli-contract-"));
  try {
    const trace = join(root, "trace");
    const child = Bun.spawnSync([process.execPath, "--preload", preload, project, ...args], {
      env: {
        ...process.env,
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

  it("adds the recovery Hint on a second stderr line after render aborts", () => {
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

  it("runs without flock when that executable is unavailable", () => {
    const result = runCli(["search", "query", "--json"], { BROWSE_FIXTURE_SCENARIO: "no-flock" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).engine, "google");
  });

  it("restarts once through the public command when flock is unavailable", () => {
    const result = runCli(["server", "restart"], { BROWSE_FIXTURE_SCENARIO: "no-flock" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(result.events.filter((event) => event.event === "restart").length, 1);
    const flockCalls = result.events.filter((event) => event.command === "flock");
    assert.equal(flockCalls.length, 1);
    assert.ok(flockCalls[0].args[0].endsWith("browse-restart.lock"));
    assert.deepEqual(flockCalls[0].args.slice(-3), ["__locked", "server", "restart"]);
  });

  it("does not acquire a render slot for a Reddit fetch", () => {
    const result = runCli(["fetch", "https://www.reddit.com/r/bun/comments/abc123/", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).backend, "Reddit");
    assert.equal(result.events.filter((event) => event.command === "flock").length, 0);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture did not reach expected state");
    await Bun.sleep(10);
  }
}

describe.skipIf(process.platform === "win32")("CLI four-slot coordination", () => {
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
            event.command === "flock" &&
            event.args[0] === "-w" &&
            event.args.includes("https://example.com/fifth"),
        ),
      );
      launch(["server", "restart"]);
      await waitUntil(() =>
        events().some(
          (event) => event.command === "flock" && event.args[0]?.endsWith("browse-restart.lock"),
        ),
      );
      await waitUntil(
        () =>
          Bun.spawnSync([
            "flock",
            "-n",
            "-E",
            "192",
            join(root, "pi/web-search/browse-restart.lock"),
            "true",
          ]).exitCode === 192,
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
