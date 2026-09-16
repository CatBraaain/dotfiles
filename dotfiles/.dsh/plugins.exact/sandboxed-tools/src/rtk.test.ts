import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MIN_SUPPORTED_RTK_MINOR,
  normalizeRtkRewrite,
  parseRtkSemver,
  resolveRtkBinary,
  RtkRewriter,
  type RtkLogger,
} from "./rtk";

function logger() {
  const warnings: unknown[][] = [];
  const infos: unknown[][] = [];
  const value: RtkLogger = {
    warn: (...args) => warnings.push(args),
    info: (...args) => infos.push(args),
  };
  return { value, warnings, infos };
}

type FakeExecution = (binaryPath: string, args: string[], timeoutMs: number) => string;

function rewriter(
  execute: FakeExecution,
  options: { binaryPath?: string | null; environment?: NodeJS.ProcessEnv } = {},
) {
  return new RtkRewriter(logger().value, {
    binaryPath: options.binaryPath === undefined ? "/bin/rtk" : options.binaryPath,
    execute,
    environment: options.environment,
  });
}

describe("rtk rewrite helper", () => {
  it("parses semver and normalizes blank rewrite output", () => {
    assert.deepEqual(parseRtkSemver("rtk 0.49.0"), [0, 49, 0]);
    assert.equal(parseRtkSemver("unknown"), null);
    assert.equal(normalizeRtkRewrite("  rtk git status  \n"), "rtk git status");
    assert.equal(normalizeRtkRewrite(" \n"), null);
  });

  it("uses a non-empty exit-0 rewrite", () => {
    const calls: string[][] = [];
    const value = rewriter((_path, args) => {
      calls.push(args);
      return args[0] === "--version" ? "rtk 0.49.0" : "rtk git status";
    });
    assert.equal(value.rewrite("git status"), "rtk git status");
    assert.deepEqual(calls, [["--version"], ["rewrite", "git status"]]);
  });

  it("resolves a symlinked rtk to the executable that must be bound", () => {
    const directory = mkdtempSync(join(tmpdir(), "sandboxed-tools-rtk-"));
    try {
      const targetDirectory = join(directory, "target");
      const linkDirectory = join(directory, "link");
      mkdirSync(targetDirectory);
      mkdirSync(linkDirectory);
      const target = join(targetDirectory, "rtk");
      const link = join(linkDirectory, "rtk");
      writeFileSync(target, "");
      symlinkSync(target, link);
      assert.equal(
        resolveRtkBinary(() => link),
        target,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses an exit-3 advisory rewrite", () => {
    const value = rewriter((_path, args) => {
      if (args[0] === "--version") return "rtk 0.49.0";
      throw Object.assign(new Error("advisory"), { status: 3, stdout: "rtk git diff" });
    });
    assert.equal(value.rewrite("git diff"), "rtk git diff");
  });

  it("passes through exit-1, blank, identical, and failed rewrites", () => {
    const cases: [string, FakeExecution][] = [
      [
        "exit-1",
        (_path, args) => {
          if (args[0] === "--version") return "rtk 0.49.0";
          throw Object.assign(new Error("no rewrite"), { status: 1, stdout: "" });
        },
      ],
      ["blank", (_path, args) => (args[0] === "--version" ? "rtk 0.49.0" : "  ")],
      ["identical", (_path, args) => (args[0] === "--version" ? "rtk 0.49.0" : "git status")],
      [
        "failed",
        (_path, args) => {
          if (args[0] === "--version") return "rtk 0.49.0";
          throw Object.assign(new Error("failed"), { status: 2 });
        },
      ],
    ];
    for (const [, execute] of cases)
      assert.equal(rewriter(execute).rewrite("git status"), "git status");
  });

  it("disables rewriting for missing, old, or unprobeable rtk", () => {
    const missing = rewriter(() => "", { binaryPath: null });
    assert.equal(missing.rewrite("git status"), "git status");

    const old = rewriter((_path, args) => {
      if (args[0] === "--version") return `rtk 0.${MIN_SUPPORTED_RTK_MINOR - 1}.0`;
      return "rtk git status";
    });
    assert.equal(old.rewrite("git status"), "git status");

    const probeTimeouts: number[] = [];
    const unprobeable = rewriter((_path, _args, timeoutMs) => {
      probeTimeouts.push(timeoutMs);
      throw new Error("probe timeout");
    });
    assert.equal(unprobeable.rewrite("git status"), "git status");
    assert.deepEqual(probeTimeouts, [2_000]);

    const rewriteTimeouts: number[] = [];
    const rewriteTimeout = rewriter((_path, args, timeoutMs) => {
      if (args[0] === "--version") return "rtk 0.49.0";
      rewriteTimeouts.push(timeoutMs);
      throw new Error("rewrite timeout");
    });
    assert.equal(rewriteTimeout.rewrite("git status"), "git status");
    assert.deepEqual(rewriteTimeouts, [2_000]);

    const unknown = rewriter((_path, args) =>
      args[0] === "--version" ? "development" : "rtk git status",
    );
    assert.equal(unknown.rewrite("git status"), "rtk git status");
  });

  it("skips already rewritten commands and RTK_DISABLED=1", () => {
    let rewriteCalls = 0;
    const execute: FakeExecution = (_path, args) => {
      if (args[0] === "--version") return "rtk 0.49.0";
      rewriteCalls += 1;
      return "rtk rewritten";
    };
    const disabled = rewriter(execute, { environment: { RTK_DISABLED: "1" } });
    assert.equal(disabled.rewrite("git status"), "git status");
    assert.equal(disabled.rewrite("rtk git status"), "rtk git status");
    assert.equal(rewriteCalls, 0);
  });
});
