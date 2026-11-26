import assert from "node:assert/strict";
import { describe, it, spyOn } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realBwrapTest, WORKER_ENTRYPOINT } from "./bwrap-test-support.ts";
import { Guardrail } from "./guardrail.ts";
import { WorkerPool } from "./worker-pool.ts";

const REAL_WORKER = { entrypoint: WORKER_ENTRYPOINT };
const CANCEL_GRACE_MS = 1000;
const ALLOW_EVERYTHING = (directory: string) =>
  `read:\n  - allow: "*"\nwrite:\n  - allow: "${directory}"\ncommands:\n  - .*:\n      - allow: []\n`;

const FIXTURE_WORKER = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const controllers = new Map();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.cancel === true) {
    controllers.get(message.id)?.abort();
    continue;
  }
  const { id, request } = message;
  const { params } = request;
  const controller = new AbortController();
  controllers.set(id, controller);
  if (params.log) appendFileSync(params.log, params.label + "\\n");
  void (async () => {
    try {
      if (params.progress) send({ id, stderr: params.progress });
      if (params.staleId !== undefined)
        send({ id: params.staleId, ok: true, result: { content: [{ type: "text", text: "stale" }], details: {} } });
      if (params.sleepMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, params.sleepMs);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("cancelled by fixture"));
          }, { once: true });
        });
      }
      if (params.hang) await new Promise(() => {});
      if (params.garbage) {
        process.stdout.write("not json\\n");
        process.exit(1);
      }
      if (params.error) send({ id, ok: false, error: params.error });
      else {
        const result = { content: [{ type: "text", text: params.text ?? "ok" }], details: {
          request, cwd: process.cwd(), pid: process.pid, path: process.env.PATH,
          masked: await readMasked(params.masked), writeError: await writeBlocked(params.output),
        } };
        send({ id, ok: true, result });
        if (params.duplicate) send({ id, ok: true, result });
      }
      if (params.exitCode !== undefined) process.exit(params.exitCode);
    } catch (error) {
      send({ id, ok: false, error: String(error) });
    } finally {
      controllers.delete(id);
    }
  })();
}
function readMasked(path) {
  if (!path) return undefined;
  try { return readFileSync(path, "utf8"); } catch { return "masked"; }
}
function writeBlocked(path) {
  if (!path) return undefined;
  try { writeFileSync(path, "blocked"); return "written"; } catch (error) { return error.code; }
}
`;

type PoolFixture = {
  directory: string;
  entrypoint: string;
  pool: WorkerPool;
  spawnCount: () => number;
  buildCount: () => number;
};

type FixtureOptions = {
  sandboxed?: () => boolean;
  buildArgs?: (directory: string, call: number) => string[];
};

/** A pool whose workers are spawned directly; the fixture worker follows `params` instructions. */
function withFixtureWorker(
  test: (fixture: PoolFixture) => Promise<void>,
  options: FixtureOptions = {},
): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "worker-pool-"));
    const entrypoint = join(directory, "fixture-worker.ts");
    writeFileSync(entrypoint, FIXTURE_WORKER);
    let builds = 0;
    const pool = new WorkerPool(
      directory,
      () => {
        builds++;
        return options.buildArgs?.(directory, builds) ?? [];
      },
      options.sandboxed ?? (() => false),
    );
    const launch = spyOn(pool, "launchCommand").mockImplementation((path) => ({
      command: "bun",
      args: [path, "--worker"],
    }));
    try {
      await test({
        directory,
        entrypoint,
        pool,
        spawnCount: () => launch.mock.calls.length,
        buildCount: () => builds,
      });
    } finally {
      launch.mockRestore();
      pool.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** A real bwrap-backed pool configured by `config`; the fixture worker is available as an entrypoint. */
function withSandboxedPool(
  test: (fixture: PoolFixture & { policy: Guardrail }) => Promise<void>,
  config: (directory: string) => string = ALLOW_EVERYTHING,
): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "worker-pool-bwrap-"));
    const entrypoint = join(directory, "fixture-worker.ts");
    writeFileSync(entrypoint, FIXTURE_WORKER);
    const configPath = join(directory, "config.yaml");
    writeFileSync(configPath, config(directory));
    const policy = new Guardrail(directory, configPath);
    const buildArgs = spyOn(policy, "buildArgs");
    const pool = new WorkerPool(directory, (mode) => policy.buildArgs(mode));
    const launch = spyOn(pool, "launchCommand");
    try {
      await test({
        directory,
        entrypoint,
        pool,
        policy,
        spawnCount: () => launch.mock.calls.length,
        buildCount: () => buildArgs.mock.calls.length,
      });
    } finally {
      launch.mockRestore();
      buildArgs.mockRestore();
      pool.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function isRunning(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return false;
  }
}

/** Whether a process whose command line contains `marker` exists (namespace-local pids are not visible here). */
function isMarkerRunning(marker: string): boolean {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) return true;
    } catch {}
  }
  return false;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "fixture condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("WorkerPool reuse", () => {
  it(
    "reuses one worker across calls of the same kind",
    withFixtureWorker(async ({ entrypoint, pool, spawnCount, buildCount }) => {
      const first = await pool.runTool(
        "read",
        { text: "one" },
        { mode: "fs", executor: { entrypoint } },
      );
      const second = await pool.runTool(
        "ls",
        { text: "two" },
        { mode: "fs", executor: { entrypoint } },
      );
      assert.equal(textOf(first), "one");
      assert.equal(textOf(second), "two");
      assert.equal(spawnCount(), 1);
      assert.equal(buildCount(), 0, "non-sandboxed platforms must not build bwrap arguments");
    }),
  );

  it(
    "runs fs and bash tools on separate workers",
    withFixtureWorker(async ({ entrypoint, pool, spawnCount }) => {
      const fs = await pool.runTool("read", {}, { mode: "fs", executor: { entrypoint } });
      const bash = await pool.runTool("bash", {}, { mode: "bash", executor: { entrypoint } });
      assert.notEqual((fs.details as { pid: number }).pid, (bash.details as { pid: number }).pid);
      assert.equal(spawnCount(), 2);
    }),
  );

  it(
    "passes toolCallId, params, session, executor data, and cwd to the worker",
    withFixtureWorker(async ({ entrypoint, pool }) => {
      const session = { sessionId: "session-1" };
      const result = await pool.runTool(
        "read",
        { path: "/tmp/x" },
        {
          mode: "fs",
          executor: { entrypoint, data: { supportsImages: false } },
          session,
          toolCallId: "call-7",
          cwd: "/tmp",
        },
      );
      assert.deepEqual((result.details as { request: unknown }).request, {
        toolCallId: "call-7",
        params: { path: "/tmp/x" },
        session,
        executorData: { supportsImages: false },
        cwd: "/tmp",
      });
    }),
  );

  it(
    "replaces a worker whose bwrap arguments changed and lets the old one finish its requests",
    withFixtureWorker(
      async ({ entrypoint, pool, spawnCount }) => {
        const retiring = pool.runTool(
          "read",
          { sleepMs: 300 },
          { mode: "fs", executor: { entrypoint } },
        );
        const retiringPid = ((await (await retiring).details) as { pid: number }).pid;
        const second = await pool.runTool("read", {}, { mode: "fs", executor: { entrypoint } });
        assert.notEqual((second.details as { pid: number }).pid, retiringPid);
        assert.equal(spawnCount(), 2);
        await waitUntil(() => !isRunning(retiringPid));
      },
      { sandboxed: () => true, buildArgs: (_directory, call) => [`--call ${call}`] },
    ),
  );

  it(
    "rejects a call whose executor entrypoint is not an absolute path before starting a worker",
    withFixtureWorker(async ({ pool, spawnCount, buildCount }) => {
      for (const entrypoint of ["relative.ts", "", "/tmp/invalid\0.ts", undefined]) {
        await assert.rejects(
          pool.runTool("read", {}, { mode: "fs", executor: { entrypoint: entrypoint! } }),
          /absolute file path/,
        );
      }
      assert.equal(spawnCount(), 0);
      assert.equal(buildCount(), 0);
    }),
  );

  it(
    "never starts a worker for an already aborted request",
    withFixtureWorker(async ({ entrypoint, pool, spawnCount }) => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled before worker"));
      await assert.rejects(
        pool.runTool(
          "read",
          {},
          { mode: "fs", executor: { entrypoint }, signal: controller.signal },
        ),
        /cancelled before worker/,
      );
      assert.equal(spawnCount(), 0);
    }),
  );

  it(
    "hands concurrent requests to the worker without waiting for earlier ones",
    withFixtureWorker(async ({ directory, entrypoint, pool, spawnCount }) => {
      const log = join(directory, "arrivals.log");
      const requests = Array.from({ length: 6 }, (_, index) =>
        pool.runTool(
          "read",
          { sleepMs: 300, log, label: index },
          { mode: "fs", executor: { entrypoint } },
        ),
      );
      const arrivals = () => readFileSync(log, "utf8").trim().split("\n");
      await waitUntil(() => existsSync(log) && arrivals().length === 6);
      assert.deepEqual(arrivals(), ["0", "1", "2", "3", "4", "5"]);
      await Promise.all(requests);
      assert.equal(spawnCount(), 1);
    }),
  );

  it(
    "ends the worker on shutdown through stdin EOF",
    withFixtureWorker(async ({ entrypoint, pool }) => {
      const result = await pool.runTool("read", {}, { mode: "fs", executor: { entrypoint } });
      const pid = (result.details as { pid: number }).pid;
      pool.shutdown();
      await waitUntil(() => !isRunning(pid));
    }),
  );
});

describe("WorkerPool failure handling", () => {
  for (const [name, params, pattern] of [
    ["worker error response", { error: "fixture failed" }, /fixture failed/],
    ["garbage on stdout", { garbage: true }, /non-JSON/],
  ] as const) {
    it(
      `fails the call for a ${name}`,
      withFixtureWorker(async ({ entrypoint, pool }) => {
        await assert.rejects(
          pool.runTool("read", params, { mode: "fs", executor: { entrypoint } }),
          pattern,
        );
      }),
    );
  }

  it(
    "rejects the call when the worker exits before responding and starts a new one next",
    withFixtureWorker(async ({ directory, entrypoint, pool, spawnCount }) => {
      const missing = join(directory, "missing.ts");
      await assert.rejects(
        pool.runTool("read", {}, { mode: "fs", executor: { entrypoint: missing } }),
        /Module not found/,
      );
      assert.equal(spawnCount(), 1);
      const next = await pool.runTool("read", {}, { mode: "fs", executor: { entrypoint } });
      assert.equal(textOf(next), "ok");
      assert.equal(spawnCount(), 2, "the next call must start a worker again");
    }),
  );

  it(
    "returns the result when the worker exits only after responding and restarts it next",
    withFixtureWorker(async ({ entrypoint, pool, spawnCount }) => {
      const result = await pool.runTool(
        "read",
        { exitCode: 1 },
        { mode: "fs", executor: { entrypoint } },
      );
      assert.equal(textOf(result), "ok");
      await waitUntil(() => !existsSync(`/proc/${(result.details as { pid: number }).pid}`));
      const next = await pool.runTool("read", {}, { mode: "fs", executor: { entrypoint } });
      assert.equal(textOf(next), "ok");
      assert.equal(spawnCount(), 2);
    }),
  );

  it(
    "ignores responses for unknown or already settled ids",
    withFixtureWorker(async ({ entrypoint, pool }) => {
      const result = await pool.runTool(
        "read",
        { staleId: 999_999, duplicate: true },
        {
          mode: "fs",
          executor: { entrypoint },
        },
      );
      assert.equal(textOf(result), "ok");
      const next = await pool.runTool("read", {}, { mode: "fs", executor: { entrypoint } });
      assert.equal(textOf(next), "ok");
    }),
  );
});

describe("WorkerPool cancellation", () => {
  it(
    "rejects a cancelled request with the abort reason and keeps the worker for other requests",
    withFixtureWorker(async ({ entrypoint, pool, spawnCount }) => {
      const controller = new AbortController();
      const pending = pool.runTool(
        "read",
        { sleepMs: 10_000 },
        {
          mode: "fs",
          executor: { entrypoint },
          signal: controller.signal,
        },
      );
      controller.abort(new Error("stop waiting"));
      await assert.rejects(pending, /stop waiting/);
      const next = await pool.runTool("read", {}, { mode: "fs", executor: { entrypoint } });
      assert.equal(textOf(next), "ok");
      assert.equal(spawnCount(), 1);
    }),
  );

  it(
    "terminates a worker that does not answer a cancellation and fails its other requests",
    withFixtureWorker(async ({ entrypoint, pool, spawnCount }) => {
      const controller = new AbortController();
      const stuck = pool.runTool(
        "read",
        { hang: true },
        {
          mode: "fs",
          executor: { entrypoint },
          signal: controller.signal,
        },
      );
      const bystander = pool.runTool(
        "read",
        { hang: true },
        { mode: "fs", executor: { entrypoint } },
      );
      const startedAt = Date.now();
      controller.abort(new Error("stop the stuck request"));
      await assert.rejects(stuck, /stop the stuck request/);
      await assert.rejects(bystander, /did not answer the cancellation/);
      assert.ok(
        Date.now() - startedAt >= CANCEL_GRACE_MS - 50,
        "the grace period must elapse first",
      );
      const next = await pool.runTool("read", {}, { mode: "fs", executor: { entrypoint } });
      assert.equal(textOf(next), "ok");
      assert.equal(spawnCount(), 2);
    }),
  );

  it(
    "applies an outer timeout like a cancellation",
    withFixtureWorker(async ({ entrypoint, pool }) => {
      await assert.rejects(
        pool.runTool(
          "bash",
          { sleepMs: 10_000 },
          { mode: "bash", executor: { entrypoint }, timeout: 0.3 },
        ),
        /timeout:0.3/,
      );
    }),
  );

  it(
    "forwards stderr progress lines of the request",
    withFixtureWorker(async ({ entrypoint, pool }) => {
      const lines: string[] = [];
      await pool.runTool(
        "bash",
        { progress: "one", text: "done" },
        {
          mode: "bash",
          executor: { entrypoint },
          onStderrLine: (line) => lines.push(line),
        },
      );
      assert.deepEqual(lines, ["one"]);
    }),
  );
});

describe("WorkerPool behind bwrap", () => {
  realBwrapTest(
    "starts one worker with the configured mounts, cwd, and environment",
    withSandboxedPool(
      async ({ directory, entrypoint, pool, spawnCount, buildCount }) => {
        const masked = join(directory, "secret");
        const output = join(directory, "output");
        writeFileSync(masked, "never disclose");
        const result = await pool.runTool(
          "read",
          { masked, output },
          { mode: "fs", executor: { entrypoint } },
        );
        assert.equal(result.details.cwd, directory);
        assert.equal(result.details.path, process.env.PATH);
        assert.equal(result.details.masked, "masked");
        assert.equal(result.details.writeError, "EROFS");
        assert.equal(spawnCount(), 1);
        assert.equal(buildCount(), 1);
      },
      (directory) => `read:\n  - allow: "*"\n  - deny: "${directory}/secret"\n`,
    ),
  );

  realBwrapTest(
    "replaces the worker when a dynamic grant changes the bwrap arguments",
    withSandboxedPool(
      async ({ directory, pool, policy, spawnCount }) => {
        const target = join(directory, "requested");
        mkdirSync(target);
        const first = await pool.runTool(
          "bash",
          { command: "echo ok" },
          { mode: "bash", executor: REAL_WORKER },
        );
        assert.equal(textOf(first), "ok\n");
        const grant = await policy.requestWritePermission(target, "Test a synthetic fixture", {
          hasUI: true,
          ui: { confirm: async () => true },
        });
        assert.equal(grant.status, "granted");
        const second = await pool.runTool(
          "bash",
          { command: `echo ok > ${target}/file && echo written` },
          {
            mode: "bash",
            executor: REAL_WORKER,
          },
        );
        assert.equal(textOf(second), "written\n");
        assert.equal(spawnCount(), 2, "a grant must replace the bash worker");
      },
      (directory) =>
        `read:\n  - allow: "*"\nwrite:\n  - allow: "${directory}/allowed"\ncommands:\n  - .*:\n      - allow: []\n`,
    ),
  );

  realBwrapTest(
    "leaves no setsid process behind after a bash response",
    withSandboxedPool(async ({ directory, pool }) => {
      const marker = "setsid-fixture-sleep";
      const started = join(directory, "started");
      const detached = `setsid bash -c 'touch ${started}; exec -a ${marker} sleep 100' >/dev/null 2>&1 &`;
      const result = await pool.runTool(
        "bash",
        { command: `${detached} until [ -e ${started} ]; do :; done; echo done` },
        { mode: "bash", executor: REAL_WORKER },
      );
      assert.equal(textOf(result), "done\n");
      assert.equal(existsSync(started), true, "the detached process must have started");
      await waitUntil(() => !isMarkerRunning(marker));
    }),
  );

  realBwrapTest(
    "runs concurrent bash requests on one worker without killing each other",
    withSandboxedPool(async ({ pool, spawnCount }) => {
      const commands = ["sleep 0.4; echo first", "echo second", "sleep 0.2; echo third"];
      const results = await Promise.all(
        commands.map((command) =>
          pool.runTool("bash", { command }, { mode: "bash", executor: REAL_WORKER }),
        ),
      );
      assert.deepEqual(
        results.map((result) => textOf(result)),
        ["first\n", "second\n", "third\n"],
      );
      assert.equal(spawnCount(), 1);
    }),
  );

  realBwrapTest(
    "cancels a running bash command without leaving processes behind",
    withSandboxedPool(async ({ pool, spawnCount }) => {
      const marker = "cancelled-fixture-sleep";
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const pending = pool.runTool(
        "bash",
        {
          command: `setsid bash -c 'exec -a ${marker} sleep 100' >/dev/null 2>&1 & echo started >&2; wait`,
        },
        {
          mode: "bash",
          executor: REAL_WORKER,
          signal: controller.signal,
          onStderrLine: (line) => {
            if (line === "started") started.resolve();
          },
        },
      );
      await started.promise;
      controller.abort(new Error("stop the command"));
      await assert.rejects(pending, /stop the command/);
      await waitUntil(() => !isMarkerRunning(marker));
      assert.equal(spawnCount(), 1);
    }),
  );
});
