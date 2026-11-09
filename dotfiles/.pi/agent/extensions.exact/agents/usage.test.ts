import assert from "node:assert/strict";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBackgroundBash } from "../tools/background-bash.ts";
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

describe("usage execution through registered Bash", () => {
  const context = {} as ExtensionContext;

  it.each([0, 1, 2, 127])("preserves stdout and exit %s on every query", async (exitCode) => {
    const events = createEventBus();
    let calls = 0;
    const dispose = registerBackgroundBash(events, async (request) => {
      calls++;
      assert.deepEqual(request.params, { command: "usage --json 2>/dev/null", timeout: 25 });
      assert.equal(request.context, context);
      return {
        content: [],
        details: {},
        structuredContent: { output: "[]", exit_code: exitCode, truncated: false },
        isError: exitCode !== 0,
      };
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++)
        assert.deepEqual(await runUsage(events, context), { exitCode, stdout: "[]" });
      assert.equal(calls, 2);
    } finally {
      dispose();
    }
  });

  it("fails without an active background receiver", async () => {
    await assert.rejects(runUsage(createEventBus(), context), /No active background Bash receiver/);
  });

  it("preserves authorization rejection without another execution path", async () => {
    const events = createEventBus();
    const dispose = registerBackgroundBash(events, async () => {
      throw new Error("Command requires a reason");
    });
    try {
      await assert.rejects(runUsage(events, context), /Command requires a reason/);
    } finally {
      dispose();
    }
  });

  const invalidOutputs: Record<string, string | number | boolean>[] = [
    { output: "[]", exit_code: 0, truncated: true },
    { output: "[]" },
  ];
  it.each(invalidOutputs)("rejects truncated or malformed output %j", async (output) => {
    const events = createEventBus();
    const dispose = registerBackgroundBash(events, async () => ({
      content: [],
      details: {},
      structuredContent: output,
    }));
    try {
      await assert.rejects(runUsage(events, context), /invalid or truncated/);
    } finally {
      dispose();
    }
  });

  it("does not run Bash for an already aborted query", async () => {
    const events = createEventBus();
    const controller = new AbortController();
    controller.abort("cancelled");
    let calls = 0;
    const dispose = registerBackgroundBash(events, async () => {
      calls++;
      return { content: [], details: {} };
    });
    try {
      await assert.rejects(runUsage(events, context, controller.signal), /cancelled/);
      assert.equal(calls, 0);
    } finally {
      dispose();
    }
  });

  it("aborts an in-flight query and discards a late completion", async () => {
    const events = createEventBus();
    const controller = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const delayed = Promise.withResolvers<never>();
    const dispose = registerBackgroundBash(events, async (request) => {
      started.resolve(request.signal!);
      return delayed.promise;
    });
    try {
      const pending = runUsage(events, context, controller.signal);
      const signal = await started.promise;
      controller.abort("cancelled");
      await assert.rejects(pending, /cancelled/);
      assert.equal(signal.aborted, true);
    } finally {
      dispose();
      delayed.reject(new Error("late result"));
    }
  });
});
