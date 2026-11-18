import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  it("keeps the reset instant and window duration per provider", () => {
    const facts = parseUsageFacts(
      JSON.stringify([
        { provider: "zai", long: 50, longResetsAt: resetAt, longWindowMinutes: 300 },
        { provider: "commandcode", long: null, longResetsAt: null, longWindowMinutes: null },
      ]),
    );
    const expected: Array<[string, ProviderUsageFacts]> = [
      ["zai", { long: 50, longResetsAt: resetAt, longWindowMinutes: 300 }],
      ["commandcode", { long: null, longResetsAt: null, longWindowMinutes: null }],
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
    '[{"provider":"zai","long":50,"longResetsAt":12,"longWindowMinutes":300}]',
    '[{"provider":"zai","long":50,"longWindowMinutes":300}]',
    '[{"provider":"zai","long":50,"longResetsAt":null,"longWindowMinutes":1e400}]',
    '[{"provider":"zai","long":50,"longResetsAt":null,"longWindowMinutes":-1e400}]',
    '[{"provider":"zai","long":1e400,"longResetsAt":null,"longWindowMinutes":300}]',
  ])("rejects malformed CLI output: %s", (stdout) => {
    assert.equal(parseUsageFacts(stdout), null);
  });
});

describe("usage execution through pi.exec", () => {
  function createPi(exec: (...args: unknown[]) => Promise<unknown>) {
    return { exec } as unknown as Pick<ExtensionAPI, "exec">;
  }

  it.each([0, 1, 2, 127])("preserves stdout and exit %s", async (exitCode) => {
    let received: unknown[] = [];
    const pi = createPi(async (...args) => {
      received = args;
      return {
        code: exitCode,
        stdout: "[]",
        stderr: "diagnostic",
        killed: false,
        truncated: false,
      };
    });
    const controller = new AbortController();
    assert.deepEqual(await runUsage(pi, controller.signal), { exitCode, stdout: "[]" });
    assert.deepEqual(received, [
      "bash",
      ["-c", "exec usage --json"],
      { signal: controller.signal, timeout: 25_000 },
    ]);
  });

  it("keeps command-not-found exit 127 for a missing usage CLI", async () => {
    const pi = createPi(async (command, args) => {
      assert.equal(command, "bash");
      const result = spawnSync("/bin/bash", args as string[], {
        encoding: "utf8",
        env: { ...process.env, PATH: "/missing-usage-fixture" },
      });
      assert.ifError(result.error);
      return { code: result.status, stdout: result.stdout, stderr: result.stderr, killed: false };
    });
    assert.deepEqual(await runUsage(pi), { exitCode: 127, stdout: "" });
  });

  it("does not start a pre-aborted query", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    let calls = 0;
    const pi = createPi(async () => {
      calls++;
      throw new Error("must not start");
    });
    await assert.rejects(runUsage(pi, controller.signal), /cancelled/);
    assert.equal(calls, 0);
  });

  it("preserves abort reason when the process completes after cancellation", async () => {
    const controller = new AbortController();
    let complete!: (value: unknown) => void;
    const pi = createPi(() => new Promise((resolve) => (complete = resolve)));
    const pending = runUsage(pi, controller.signal);
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
    await assert.rejects(runUsage(pi), /killed or truncated/);
  });

  it("propagates process execution errors", async () => {
    const pi = createPi(async () => {
      throw new Error("spawn failed");
    });
    await assert.rejects(runUsage(pi), /spawn failed/);
  });
});
