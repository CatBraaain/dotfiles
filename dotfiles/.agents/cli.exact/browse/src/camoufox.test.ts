import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderClock, startLocalHttpProbe } from "./camoufox";
import { SLOT_COUNT, slotLockFile } from "./config";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Synchronous sleep standing in for the blocking flock wait for a restart.
const blockSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

describe("RenderClock", () => {
  it("does not abort while the actual render time stays within the budget", async () => {
    const clock = new RenderClock(
      500,
      () => false,
      () => {},
    );
    await sleep(50);
    assert.equal(clock.signal.aborted, false);
    clock.dispose();
  });

  it("aborts once the actual render time exceeds the budget", async () => {
    const clock = new RenderClock(
      50,
      () => false,
      () => {},
    );
    await sleep(150);
    assert.equal(clock.signal.aborted, true);
  });

  it("does not count restart waits against the render budget", async () => {
    // A restart is in flight for the first two probes (the awaitTurn check and
    // its re-check after waiting); each wait blocks longer than the budget.
    let probes = 0;
    const clock = new RenderClock(
      200,
      () => (probes += 1) <= 2,
      () => blockSync(250),
    );
    clock.awaitTurn(); // pauses, blocks 250ms for the restart, resumes
    await sleep(30);
    assert.equal(clock.signal.aborted, false);
    await sleep(220);
    assert.equal(clock.signal.aborted, true);
    clock.dispose();
  });

  it("disposes idempotently without aborting or resuming the retired signal", async () => {
    const clock = new RenderClock(
      20,
      () => true,
      () => {
        throw new Error("disposed clock waited");
      },
    );
    clock.dispose();
    clock.dispose();
    clock.awaitTurn();
    await sleep(60);
    assert.equal(clock.signal.aborted, false);
  });
});

interface Completion {
  stage: string;
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
      : spawn("flock", [join(root, slotLockFile(slot)), ...fixtureArgs], { env });
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

  it.skipIf(process.platform === "win32")(
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
