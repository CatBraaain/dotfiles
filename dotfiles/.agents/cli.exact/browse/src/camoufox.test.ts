import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderClock, startLocalHttpProbe } from "./camoufox";
import { CAMOUFOX_DEFAULT_BASE_URL, SLOT_COUNT, slotLockFile } from "./config";
import { withLockMainPath } from "./fixtures/with-lock";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("RenderClock", () => {
  it("does not abort while the render time stays within the budget", async () => {
    const clock = new RenderClock(500);
    await sleep(50);
    assert.equal(clock.signal.aborted, false);
    clock.dispose();
  });

  it("aborts once the render time exceeds the budget", async () => {
    const clock = new RenderClock(50);
    await sleep(150);
    assert.equal(clock.signal.aborted, true);
  });

  it("disposes idempotently without aborting the retired signal", async () => {
    const clock = new RenderClock(20);
    clock.dispose();
    clock.dispose();
    await sleep(60);
    assert.equal(clock.signal.aborted, false);
  });
});

interface Completion {
  stage: string;
  responsive?: boolean;
  reachedProbe?: boolean;
  healthDeadlines: number[];
  renderBudgets: number[];
  polling: number[];
  idleOptions: unknown[];
  virtualNow: number;
  idleTimedOutAt?: number;
  pageReadsAt: number[];
  healthStages: {
    stage: string;
    signalIndex: number;
    startedAt: number;
    finishedAt: number;
    aborted: boolean;
  }[];
  html?: string;
  error?: string;
  renders: number;
  commands: string[];
  pendingAfterRender: number[];
  deadlinesFired: number;
  aborted: boolean[];
}

function launchRender(root: string, scenario: string, slot?: number, gated = false) {
  const env = { ...process.env, XDG_CACHE_HOME: root, BROWSE_FIXTURE_GATE: gated ? "1" : "0" };
  const fixtureArgs = [
    process.execPath,
    join(import.meta.dir, "fixtures/render-lifecycle.ts"),
    scenario,
  ];
  const child =
    slot === undefined
      ? spawn(fixtureArgs[0]!, fixtureArgs.slice(1), { env })
      : spawn(
          process.execPath,
          [withLockMainPath, join(root, slotLockFile(slot)), ...fixtureArgs],
          { env },
        );
  let stdout = "";
  let stderr = "";
  let complete!: (message: Completion) => void;
  const ready = new Promise<Completion>((resolve) => {
    complete = resolve;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const line = stdout.split("\n")[0];
    if (stdout.includes("\n") && line) complete(JSON.parse(line));
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; messages: Completion[] }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (stderr) reject(new Error(stderr));
      else
        resolve({
          code,
          messages: stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((message) => message.stage !== "started"),
        });
    });
  });
  return { ready, exited, child };
}

describe("Playwright render paths", () => {
  it.skipIf(process.platform !== "linux")(
    "writes the Playwright CLI config in a fresh cache when Camoufox is already healthy",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "browse-fresh-cache-"));
      try {
        const cache = join(root, "new-cache");
        const { code, messages } = await launchRender(cache, "fresh-cache").exited;
        assert.equal(code, 0, messages[0]?.error ?? "Fixture did not render");
        assert.deepEqual(messages[0]?.commands, ["close", "open", "run-code", "close"]);
        const config = JSON.parse(
          readFileSync(join(cache, "pi", "web-search", "playwright-cli.config.json"), "utf8"),
        );
        assert.equal(
          config.browser.remoteEndpoint,
          process.env.CAMOUFOX_BASE_URL ?? CAMOUFOX_DEFAULT_BASE_URL,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  for (const platform of ["windows", "linux"]) {
    it(`uses the installed Playwright core without launching the CLI on ${platform}`, async () => {
      const root = mkdtempSync(join(tmpdir(), `browse-${platform}-direct-`));
      try {
        const { code, messages } = await launchRender(root, `${platform}-direct`).exited;
        assert.equal(code, 0, messages[0]?.error ?? "Fixture did not render");
        assert.equal(messages[0]?.html, "<html>Direct fixture</html>");
        assert.deepEqual(messages[0]?.commands, []);
        const config = JSON.parse(
          readFileSync(join(root, "pi", "web-search", "playwright-cli.config.json"), "utf8"),
        );
        assert.equal(
          config.browser.remoteEndpoint,
          process.env.CAMOUFOX_BASE_URL ?? CAMOUFOX_DEFAULT_BASE_URL,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("uses the CLI when its wrapper has no resolvable Playwright core", async () => {
    const root = mkdtempSync(join(tmpdir(), "browse-linux-wrapper-"));
    try {
      const { code, messages } = await launchRender(root, "linux-wrapper").exited;
      assert.equal(code, 0, messages[0]?.error ?? "Fixture did not render");
      assert.equal(messages[0]?.html, "<html>ready</html>");
      assert.deepEqual(messages[0]?.commands, ["close", "open", "run-code", "close"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the URL literally to the package bin when Playwright settings are overridden", async () => {
    const root = mkdtempSync(join(tmpdir(), "browse-windows-cli-"));
    try {
      const { code, messages } = await launchRender(root, "windows-npm").exited;
      assert.equal(code, 0, messages[0]?.error ?? "Fixture did not render");
      assert.equal(messages[0]?.html, "<html>Windows npm fixture</html>");
      assert.deepEqual(messages[0]?.commands, ["close", "open", "run-code", "close"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("camoufoxRender deadline lifecycle", () => {
  for (const scenario of [
    "success",
    "open-error",
    "parse-error",
    "close-error",
    "retry-success",
    "retry-error",
  ]) {
    it(`releases deadlines and closes pages after ${scenario}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "browse-render-"));
      try {
        const { code, messages } = await launchRender(root, scenario).exited;
        const [completed, exited] = messages;
        assert.ok(completed);
        assert.ok(exited);
        const failed = ["open-error", "parse-error", "retry-error"].includes(scenario);
        assert.equal(code, failed ? 1 : 0);
        assert.equal(completed.renders, scenario.startsWith("retry-") ? 2 : 1);
        assert.deepEqual(completed.pendingAfterRender, Array(completed.renders).fill(0));
        assert.equal(
          completed.commands.filter((command) => command === "close").length,
          completed.renders * 2,
        );
        assert.equal(completed.commands.at(-1), "close");
        assert.equal(exited.deadlinesFired, 0);
        assert.deepEqual(exited.aborted, Array(completed.renders).fill(false));
        if (!failed) assert.equal(completed.html, "<html>ready</html>");
        else
          assert.match(
            completed.error!,
            scenario === "retry-error" ? /All web fetch backends failed/ : /render:/,
          );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("still aborts active work and closes its page at the deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "browse-render-"));
    try {
      const { code, messages } = await launchRender(root, "timeout").exited;
      assert.equal(code, 1);
      assert.match(messages[0]!.error!, /render: aborted/);
      assert.deepEqual(messages[0]!.commands, ["close", "open", "close"]);
      assert.deepEqual(messages[0]!.pendingAfterRender, [0]);
      assert.equal(messages[1]!.deadlinesFired, 1);
      assert.deepEqual(messages[1]!.aborted, [true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")(
    "hands a completed child's slot to a queued render without waiting for its deadline",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "browse-slots-"));
      try {
        assert.equal(SLOT_COUNT, 4);
        const first = launchRender(root, "success", 0, true);
        const second = launchRender(root, "success", 1, true);
        await Promise.all([first.ready, second.ready]);
        const queued = launchRender(root, "success", 0);
        const waiting = await Promise.race([
          queued.ready.then(() => false),
          sleep(40).then(() => true),
        ]);
        first.child.stdin.end("release");
        second.child.stdin.end("release");
        assert.equal(waiting, true);
        const results = await Promise.all([first.exited, second.exited, queued.exited]);
        for (const result of results) {
          assert.equal(result.code, 0);
          assert.deepEqual(result.messages[0]!.pendingAfterRender, [0]);
          assert.equal(result.messages[1]!.deadlinesFired, 0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("startLocalHttpProbe", () => {
  it("serves its url until closed", async () => {
    const probe = await startLocalHttpProbe();
    const response = await fetch(probe.url);
    assert.equal(response.ok, true);
    await probe.close();
    await assert.rejects(() => fetch(probe.url));
  });
});

describe("functional health and challenge deadlines", () => {
  for (const scenario of ["health-good", "health-websocket-down", "health-open-timeout"]) {
    it(`checks local HTTP navigation rather than accepting websocket health alone: ${scenario}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "browse-health-"));
      try {
        const { code, messages } = await launchRender(root, scenario).exited;
        const report = messages[0]!;
        assert.equal(code, 0);
        assert.equal(report.responsive, scenario === "health-good");
        assert.equal(report.reachedProbe, scenario === "health-good");
        assert.equal(report.healthDeadlines[0], 5000);
        assert.ok(report.healthDeadlines.every((ms) => ms > 0 && ms <= 5000));
        assert.deepEqual(
          report.commands,
          scenario === "health-websocket-down" ? [] : ["close", "open", "close"],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const scenario of ["challenge-detected", "challenge-poll"]) {
    it(`executes the generated challenge polling program: ${scenario}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "browse-challenge-"));
      try {
        const { code, messages } = await launchRender(root, scenario).exited;
        const report = messages[0]!;
        assert.equal(code, scenario === "challenge-detected" ? 1 : 0);
        assert.deepEqual(report.idleOptions, [{ timeout: 5000 }]);
        assert.deepEqual(report.polling, scenario === "challenge-detected" ? [] : [250, 250]);
        assert.deepEqual(report.renderBudgets, [30000]);
        assert.ok(report.healthDeadlines.every((ms) => ms === 15000));
        if (scenario === "challenge-detected")
          assert.match(report.error!, /render: challenge detected/);
        else assert.equal(report.html, "<html>ready</html>");
        assert.deepEqual(report.commands, ["close", "open", "run-code", "close"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("shared health and challenge timeout boundaries", () => {
  for (const scenario of ["health-budget-success", "health-budget-exhausted"]) {
    it(`shares a five-second budget across websocket, close and open: ${scenario}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "browse-health-budget-"));
      try {
        const { code, messages } = await launchRender(root, scenario).exited;
        const report = messages[0]!;
        const succeeded = scenario === "health-budget-success";
        assert.equal(code, 0);
        assert.equal(report.responsive, succeeded);
        assert.equal(report.reachedProbe, succeeded);
        assert.deepEqual(
          report.healthDeadlines,
          succeeded ? [5000, 4000, 3000, 500] : [5000, 4000, 3000, 1],
        );
        assert.deepEqual(
          report.healthStages.map(({ stage, signalIndex }) => [stage, signalIndex]),
          [
            ["websocket", 0],
            ["initial-close", 1],
            ["open", 2],
            ["final-close", 3],
          ],
        );
        assert.deepEqual(
          report.healthStages.map(({ startedAt, finishedAt }) => [startedAt, finishedAt]),
          succeeded
            ? [
                [0, 1000],
                [1000, 2000],
                [2000, 4500],
                [4500, 4900],
              ]
            : [
                [0, 1000],
                [1000, 2000],
                [2000, 5000],
                [5000, 5000],
              ],
        );
        assert.deepEqual(
          report.healthStages.map(({ aborted }) => aborted),
          succeeded ? [false, false, false, false] : [false, false, true, false],
        );
        assert.equal(report.virtualNow, succeeded ? 4900 : 5000);
        assert.deepEqual(report.commands, ["close", "open", "close"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("polls through the five-second networkidle timeout and returns the final DOM", async () => {
    const root = mkdtempSync(join(tmpdir(), "browse-challenge-timeout-"));
    try {
      const { code, messages } = await launchRender(root, "challenge-timeout").exited;
      const report = messages[0]!;
      assert.equal(code, 0);
      assert.equal(report.html, "<html>ready</html>");
      assert.equal(report.virtualNow, 5000);
      assert.equal(report.idleTimedOutAt, 5000);
      assert.deepEqual(report.idleOptions, [{ timeout: 5000 }]);
      assert.deepEqual(report.polling, Array(20).fill(250));
      assert.deepEqual(
        report.pageReadsAt,
        Array.from({ length: 21 }, (_, index) => index * 250),
      );
      assert.deepEqual(report.renderBudgets, [30000]);
      assert.deepEqual(report.commands, ["close", "open", "run-code", "close"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
