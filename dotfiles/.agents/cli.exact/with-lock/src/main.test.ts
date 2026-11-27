import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "main.ts");
const READY_TIMEOUT_MS = 5000;
const TEST_TIMEOUT_MS = 10_000;
const DEFAULT_HOLDER_HOLD_SECONDS = 3;
const MIN_WAIT_ONE_SECOND_MS = 990;
const MAX_WAIT_ONE_SECOND_MS = 3000;
const READY_MARKER_ENV = "READY_MARKER";

interface Fixture {
  dir: string;
  lockName: string;
  marker: string;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Holder = ReturnType<typeof Bun.spawn>;

describe.skipIf(process.platform !== "linux")("with-lock", () => {
  it(
    "-n exits with the default conflict code without running the command while the lock is held",
    async () => {
      const fixture = makeFixture();
      const holder = await startHolder(fixture);
      try {
        const result = await runCli(["-n", fixture.lockName, "echo", "ran"]);

        assert.equal(result.exitCode, 1);
        assert.equal(result.stdout, "");
      } finally {
        await stopHolder(holder);
        removeFixture(fixture);
      }
    },
    TEST_TIMEOUT_MS,
  );

  for (const code of [0, 75, 255]) {
    it(
      `-n -E ${code} exits with the given conflict code`,
      async () => {
        const fixture = makeFixture();
        const holder = await startHolder(fixture);
        try {
          const result = await runCli(["-n", "-E", String(code), fixture.lockName, "echo", "ran"]);

          assert.equal(result.exitCode, code);
          assert.equal(result.stdout, "");
        } finally {
          await stopHolder(holder);
          removeFixture(fixture);
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "-w 1 gives up with the conflict code after about one second",
    async () => {
      const fixture = makeFixture();
      const holder = await startHolder(fixture);
      try {
        const startedAt = Date.now();
        const result = await runCli(["-w", "1", fixture.lockName, "echo", "ran"]);
        const elapsedMs = Date.now() - startedAt;

        assert.equal(result.exitCode, 1);
        assert.equal(result.stdout, "");
        assert.ok(elapsedMs >= MIN_WAIT_ONE_SECOND_MS, `elapsed ${elapsedMs}ms`);
        assert.ok(elapsedMs < MAX_WAIT_ONE_SECOND_MS, `elapsed ${elapsedMs}ms`);
      } finally {
        await stopHolder(holder);
        removeFixture(fixture);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases the lock when the holder is killed, so the next -n acquires it at once",
    async () => {
      const fixture = makeFixture();
      const holder = await startHolder(fixture);
      holder.kill("SIGKILL");
      await holder.exited;
      try {
        const result = await runCli(["-n", fixture.lockName, "echo", "ran"]);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, "ran\n");
      } finally {
        removeFixture(fixture);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it("exits with 0 when the command succeeds", async () => {
    const fixture = makeFixture();
    try {
      const result = await runCli([fixture.lockName, "true"]);

      assert.equal(result.exitCode, 0);
    } finally {
      removeFixture(fixture);
    }
  });

  it("exits with the command's exit code", async () => {
    const fixture = makeFixture();
    try {
      const result = await runCli([fixture.lockName, "sh", "-c", "exit 7"]);

      assert.equal(result.exitCode, 7);
    } finally {
      removeFixture(fixture);
    }
  });

  it("exits with 143 when the command is terminated by SIGTERM", async () => {
    const fixture = makeFixture();
    try {
      const result = await runCli([fixture.lockName, "sh", "-c", 'kill -TERM "$$"']);

      assert.equal(result.exitCode, 143);
    } finally {
      removeFixture(fixture);
    }
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(
      `forwards ${signal} to the command and holds the lock until the command exits`,
      async () => {
        const fixture = makeFixture();
        const receivedMarker = join(fixture.dir, "signal-received");
        const script = `
          import { writeFileSync } from "node:fs";
          const [signal, readyMarker, receivedMarker] = process.argv.slice(1);
          process.once(signal, () => writeFileSync(receivedMarker, ""));
          writeFileSync(readyMarker, "");
          await new Response(Bun.stdin.stream()).text();
        `;
        const holder = Bun.spawn({
          cmd: [
            process.execPath,
            CLI,
            fixture.lockName,
            process.execPath,
            "-e",
            script,
            signal,
            fixture.marker,
            receivedMarker,
          ],
          stdin: "pipe",
          stdout: "ignore",
          stderr: "inherit",
          timeout: TEST_TIMEOUT_MS,
        });
        try {
          await waitForFile(fixture.marker);
          holder.kill(signal);
          await waitForFile(receivedMarker);

          const contender = await runCli(["-n", fixture.lockName, "echo", "ran"]);
          assert.equal(contender.exitCode, 1);
          assert.equal(contender.stdout, "");
        } finally {
          holder.stdin.end();
          await holder.exited;
          removeFixture(fixture);
        }

        const next = await runCli(["-n", fixture.lockName, "true"]);
        assert.equal(next.exitCode, 0);
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "does not wait for a different lock name",
    async () => {
      const fixture = makeFixture();
      const holder = await startHolder(fixture);
      try {
        const otherLockName = join(fixture.dir, "other.lock");
        const result = await runCli(["-n", otherLockName, "echo", "ran"]);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, "ran\n");
      } finally {
        await stopHolder(holder);
        removeFixture(fixture);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "waits for the same lock name and runs once the holder releases it",
    async () => {
      const fixture = makeFixture();
      await startHolder(fixture, 1);
      try {
        const result = await runCli([fixture.lockName, "echo", "ran"]);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, "ran\n");
      } finally {
        removeFixture(fixture);
      }
    },
    TEST_TIMEOUT_MS,
  );

  const usageErrorCases = [
    { args: [], label: "no arguments" },
    { args: ["name"], label: "lock name without a command" },
    { args: ["-x", "name", "true"], label: "unknown flag" },
    { args: ["-w"], label: "-w without a value" },
    { args: ["-w", "abc", "name", "true"], label: "non-numeric -w" },
    { args: ["-w", "-1", "name", "true"], label: "negative -w" },
    { args: ["-w", "", "name", "true"], label: "empty -w" },
    { args: ["-w", " \t", "name", "true"], label: "whitespace-only -w" },
    { args: ["-E", "1.5", "name", "true"], label: "non-integer -E" },
    { args: ["-E", "256", "name", "true"], label: "out-of-range -E" },
  ];

  for (const { args, label } of usageErrorCases) {
    it(`exits with 2 and prints the usage: ${label}`, async () => {
      const result = await runCli(args);

      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /^with-lock: .+\nusage: with-lock /);
    });
  }

  it("exits with 2 and prints the reason when the command cannot start", async () => {
    const result = await runCli(["name", "with-lock-no-such-command"]);

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /^with-lock: .*with-lock-no-such-command/);
  });

  it("accepts -- between the lock name and the command", async () => {
    const result = await runCli(["name", "--", "echo", "ran"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ran\n");
  });

  it("runs a command whose name starts with - when it follows --", async () => {
    const fixture = makeFixture();
    try {
      const scriptPath = join(fixture.dir, "-ran");
      writeFileSync(scriptPath, "#!/bin/sh\necho ran\n", { mode: 0o755 });
      const path = `${fixture.dir}:${process.env.PATH ?? ""}`;
      const result = await runCli([fixture.lockName, "--", "-ran"], { PATH: path });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "ran\n");
    } finally {
      removeFixture(fixture);
    }
  });
});

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "with-lock-"));
  return { dir, lockName: join(dir, "test.lock"), marker: join(dir, "ready") };
}

function removeFixture(fixture: Fixture): void {
  rmSync(fixture.dir, { recursive: true, force: true });
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

function startHolder(fixture: Fixture, holdSeconds = DEFAULT_HOLDER_HOLD_SECONDS): Promise<Holder> {
  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      CLI,
      fixture.lockName,
      "sh",
      "-c",
      `touch "$${READY_MARKER_ENV}"; exec sleep ${holdSeconds}`,
    ],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, [READY_MARKER_ENV]: fixture.marker },
  });
  return waitForFile(fixture.marker).then(() => holder);
}

async function stopHolder(holder: Holder): Promise<void> {
  holder.kill("SIGTERM");
  await holder.exited;
}

function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${path}`));
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  });
}
