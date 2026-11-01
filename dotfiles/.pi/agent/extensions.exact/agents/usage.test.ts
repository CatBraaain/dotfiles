import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { runUsage, scoreCandidates, parseUsageFacts, type ProviderUsageFacts } from "./usage.ts";
import { parseCronExpression } from "./cron.ts";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

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

describe("usage execution", () => {
  it("uses only the fixed CLI and arguments with signal and timeout", async () => {
    const controller = new AbortController();
    function execute(
      command: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: Callback,
    ) {
      assert.equal(command, "usage");
      assert.deepEqual(args, ["--json"]);
      assert.deepEqual(options, {
        encoding: "utf8",
        signal: controller.signal,
        timeout: 25_000,
        killSignal: "SIGKILL",
      });
      callback(null, "[]", "fixture warning");
    }
    assert.deepEqual(await runUsage(controller.signal, execute as unknown as typeof execFile), {
      exitCode: 0,
      stdout: "[]",
    });
  });

  it("maps a missing executable to exit 127", async () => {
    function execute(
      _command: string,
      _args: string[],
      _options: ExecFileOptionsWithStringEncoding,
      callback: Callback,
    ) {
      callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "", "");
    }
    assert.deepEqual(await runUsage(undefined, execute as unknown as typeof execFile), {
      exitCode: 127,
      stdout: "",
    });
  });

  it.each([0, 1, 2])(
    "preserves real stdout and exit %s separately from stderr on every call",
    async (code) => {
      const directory = mkdtempSync(join(tmpdir(), "agents-usage-test-"));
      const previousPath = process.env.PATH;
      try {
        writeFileSync(
          join(directory, "usage"),
          `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== '["--json"]') process.exit(2);
console.error("fixture diagnostic");
console.log("[]");
process.exit(${code});
`,
          { mode: 0o700 },
        );
        process.env.PATH = directory;
        for (let attempt = 0; attempt < 2; attempt++) {
          assert.deepEqual(await runUsage(), { exitCode: code, stdout: "[]\n" });
        }
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["abort", "timeout"])("rejects and kills the fixture process on %s", async (failure) => {
    const directory = mkdtempSync(join(tmpdir(), "agents-usage-cancel-"));
    const previousPath = process.env.PATH;
    const controller = new AbortController();
    let child: ReturnType<typeof execFile> | undefined;
    try {
      writeFileSync(
        join(directory, "usage"),
        `#!${process.execPath}
console.log("started");
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      process.env.PATH = directory;
      function execute(
        command: string,
        args: string[],
        options: ExecFileOptionsWithStringEncoding,
        callback: Callback,
      ) {
        child = execFile(
          command,
          args,
          { ...options, timeout: failure === "timeout" ? 100 : options.timeout },
          callback,
        );
        if (failure === "abort") child.stdout!.once("data", () => controller.abort());
        return child;
      }
      await assert.rejects(
        runUsage(controller.signal, execute as unknown as typeof execFile),
        failure === "abort" ? /abort/i : /killed|Command failed/i,
      );
      assert.equal(child?.killed, true);
    } finally {
      child?.kill("SIGKILL");
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
