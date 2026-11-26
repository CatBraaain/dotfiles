import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it } from "bun:test";
import { runUsage, scoreCandidates, parseUsageFacts, type ProviderUsageFacts } from "./usage.ts";
import { parseCronExpression } from "./cron.ts";

describe("candidate scores", () => {
  const now = new Date("2026-10-30T06:00:00Z");

  it("excludes a single candidate with a numeric zero", () => {
    const selected = scoreCandidates(
      [{ provider: "a", model: "m", settings: [{ multiply: 0 }] }],
      new Map(),
      {},
      now,
    );
    assert.deepEqual(selected, []);
  });

  it("applies scheduled zero without usage facts", () => {
    const selected = scoreCandidates(
      [{ provider: "a", model: "m" }],
      new Map(),
      { a: [{ cron: parseCronExpression("* 6-9 * * 1-5"), multiply: 0 }] },
      now,
    );
    assert.deepEqual(selected, []);
  });

  it("keeps an independently enabled duplicate with replacement settings", () => {
    const enabled = { provider: "a", model: "m", settings: [] };
    const selected = scoreCandidates(
      [{ provider: "a", model: "m" }, enabled],
      new Map(),
      { a: [{ multiply: 0 }] },
      now,
    );
    assert.deepEqual(selected, [enabled]);
  });
});

describe("usage facts parsing", () => {
  const resetAt = "2026-06-17T12:00:00+09:00";

  it("keeps short quota and long window facts per provider", () => {
    const facts = parseUsageFacts(
      JSON.stringify([
        { provider: "zai", short: 0, long: 50, longResetsAt: resetAt, longWindowMinutes: 300 },
        {
          provider: "commandcode",
          short: null,
          long: null,
          longResetsAt: null,
          longWindowMinutes: null,
        },
      ]),
    );
    const expected: Array<[string, ProviderUsageFacts]> = [
      ["zai", { short: 0, long: 50, longResetsAt: resetAt, longWindowMinutes: 300 }],
      ["commandcode", { short: null, long: null, longResetsAt: null, longWindowMinutes: null }],
    ];
    assert.deepEqual(facts, new Map(expected));
  });

  it.each(["2026-06-17T03:00:00Z", "2026-06-16T23:00:00-04:00", resetAt])(
    "accepts the explicit timezone offset in %s",
    (longResetsAt) => {
      const row = { provider: "zai", long: 50, longResetsAt, longWindowMinutes: 300 };
      const facts = parseUsageFacts(JSON.stringify([row]));
      assert.deepEqual(facts?.get("zai"), { long: 50, longResetsAt, longWindowMinutes: 300 });
    },
  );

  it("keeps a parseable expired reset as a valid fact", () => {
    const longResetsAt = "2000-01-01T00:00:00Z";
    const facts = parseUsageFacts(
      JSON.stringify([{ provider: "zai", long: 50, longResetsAt, longWindowMinutes: 300 }]),
    );
    assert.equal(facts?.get("zai")?.longResetsAt, longResetsAt);
  });

  it.each([null, 0, -1, "300", "Infinity"])(
    "rejects a missing or invalid duration %s",
    (duration) => {
      const row = { provider: "zai", long: 50, longResetsAt: resetAt, longWindowMinutes: duration };
      if (duration === null) delete (row as { longWindowMinutes?: unknown }).longWindowMinutes;
      assert.equal(parseUsageFacts(JSON.stringify([row])), null);
    },
  );

  it.each(["bad", "badZ", "2026-99-17T03:00:00Z", "2026-06-17T03:00:00", "2026-06-17"])(
    "rejects a non-offset or unparseable reset %s",
    (longResetsAt) => {
      const row = { provider: "zai", long: 50, longResetsAt, longWindowMinutes: 300 };
      assert.equal(parseUsageFacts(JSON.stringify([row])), null);
    },
  );

  it.each([
    "not json",
    "null",
    "{}",
    "[null]",
    "[[]]",
    '[{"provider":"","long":50,"longResetsAt":null,"longWindowMinutes":300}]',
    '[{"provider":"zai","long":"70","longResetsAt":null,"longWindowMinutes":300}]',
    '[{"provider":"zai","short":"0","long":50,"longResetsAt":null,"longWindowMinutes":300}]',
    '[{"provider":"zai","long":50,"longResetsAt":12,"longWindowMinutes":300}]',
    '[{"provider":"zai","long":50,"longWindowMinutes":300}]',
    '[{"provider":"zai","long":50,"longResetsAt":null,"longWindowMinutes":1e400}]',
    '[{"provider":"zai","long":50,"longResetsAt":null,"longWindowMinutes":-1e400}]',
    '[{"provider":"zai","long":1e400,"longResetsAt":null,"longWindowMinutes":300}]',
  ])("rejects malformed CLI output: %s", (stdout) => {
    assert.equal(parseUsageFacts(stdout), null);
  });
});

function createPi(exec: (...args: unknown[]) => Promise<unknown>) {
  return { exec } as unknown as Pick<ExtensionAPI, "exec">;
}

async function withPosixUsageFixture(
  script: string | undefined,
  testUsage: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "usage-path-"));
  const previousPath = process.env.PATH;
  try {
    if (script !== undefined) {
      await writeFile(join(cwd, "usage"), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    }
    process.env.PATH = ".";
    await testUsage(cwd);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(cwd, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("direct POSIX usage execution", () => {
  const pi = createPi(async () => assert.fail("must launch usage without pi.exec"));

  it.each([0, 1, 2, 127])("preserves stdout and exit %s", async (exitCode) => {
    await withPosixUsageFixture(
      `[ "$1" = --json ] && [ "$#" = 1 ] || exit 3; printf '[]'; printf diagnostic >&2; exit ${exitCode}`,
      async (cwd) => {
        assert.deepEqual(await runUsage(pi, undefined, { cwd }), { exitCode, stdout: "[]" });
      },
    );
  });

  it("returns command-not-found exit 127 for a missing CLI", async () => {
    await withPosixUsageFixture(undefined, async (cwd) => {
      assert.deepEqual(await runUsage(pi, undefined, { cwd }), { exitCode: 127, stdout: "" });
    });
  });

  it("does not report a missing CLI when the working directory is missing", async () => {
    await withPosixUsageFixture("exit 0", async (cwd) => {
      process.env.PATH = cwd;
      assert.deepEqual(await runUsage(pi, undefined, { cwd: join(cwd, "missing") }), {
        exitCode: 1,
        stdout: "",
      });
    });
  });

  it("preserves exit 1 if the CLI is removed after launch", async () => {
    await withPosixUsageFixture('/bin/rm "$0" && exit 1; exit 2', async (cwd) => {
      assert.deepEqual(await runUsage(pi, undefined, { cwd }), { exitCode: 1, stdout: "" });
      await assert.rejects(access(join(cwd, "usage")), { code: "ENOENT" });
    });
  });

  it("does not wait for descendants to close inherited output", async () => {
    await withPosixUsageFixture(
      "( /bin/sleep 2; printf done > descendant-done ) & printf '[]'",
      async (cwd) => {
        assert.deepEqual(await runUsage(pi, undefined, { cwd }), { exitCode: 0, stdout: "[]" });
        assert.equal(existsSync(join(cwd, "descendant-done")), false);
      },
    );
  });

  it("waits for the running CLI to exit on cancellation", async () => {
    await withPosixUsageFixture(
      `trap 'printf stopped > terminated; exit 0' TERM
printf ready > started
while :; do /bin/sleep 0.02; done`,
      async (cwd) => {
        const controller = new AbortController();
        const result = assert.rejects(runUsage(pi, controller.signal, { cwd }), {
          message: "cancelled",
        });
        try {
          const started = join(cwd, "started");
          const deadline = Date.now() + 2_000;
          while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(10);
          assert.ok(existsSync(started), "usage fixture did not start");
        } finally {
          controller.abort(new Error("cancelled"));
          await result;
        }
        await access(join(cwd, "terminated"));
      },
    );
  });
});

describe("Windows usage execution through pi.exec", () => {
  it("starts the installed Windows usage executable without Bash", async () => {
    const executable = join(homedir(), ".agents", "cli", "usage.exe");
    const controller = new AbortController();
    const pi = createPi(async (...args) => {
      assert.deepEqual(args, [
        executable,
        ["--json"],
        { signal: controller.signal, timeout: 25_000 },
      ]);
      return { code: 0, stdout: "[]", stderr: "", killed: false, truncated: false };
    });
    assert.deepEqual(await runUsage(pi, controller.signal, { platform: "win32" }), {
      exitCode: 0,
      stdout: "[]",
    });
  });

  it("reports ENOENT when the Windows executable is missing and pi.exec returns 1", async () => {
    const homeDir = join(tmpdir(), randomUUID());
    const pi = createPi(async () => ({
      code: 1,
      stdout: "",
      stderr: "spawn failed",
      killed: false,
      truncated: false,
    }));
    await assert.rejects(runUsage(pi, undefined, { platform: "win32", homeDir }), {
      code: "ENOENT",
    });
  });

  it("does not start a pre-aborted query", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    let calls = 0;
    const pi = createPi(async () => {
      calls++;
      throw new Error("must not start");
    });
    await assert.rejects(runUsage(pi, controller.signal, { platform: "win32" }), /cancelled/);
    assert.equal(calls, 0);
  });

  it("preserves abort reason when the process completes after cancellation", async () => {
    const controller = new AbortController();
    let complete!: (value: unknown) => void;
    const pi = createPi(() => new Promise((resolve) => (complete = resolve)));
    const pending = runUsage(pi, controller.signal, { platform: "win32" });
    controller.abort("cancelled");
    complete({ code: 0, stdout: "[]", stderr: "", killed: false, truncated: false });
    await assert.rejects(pending, /cancelled/);
  });

  it.each(["killed", "truncated"] as const)("rejects %s output", async (failure) => {
    const pi = createPi(async () => ({
      code: 0,
      stdout: "[]",
      stderr: "",
      killed: failure === "killed",
      truncated: failure === "truncated",
    }));
    await assert.rejects(runUsage(pi, undefined, { platform: "win32" }), /killed or truncated/);
  });

  it("propagates process execution errors", async () => {
    const pi = createPi(async () => {
      throw new Error("spawn failed");
    });
    await assert.rejects(runUsage(pi, undefined, { platform: "win32" }), /spawn failed/);
  });
});
