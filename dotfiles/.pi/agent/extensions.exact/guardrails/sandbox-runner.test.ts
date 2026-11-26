import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_ENTRYPOINT } from "./bwrap-test-support.ts";
import { SandboxRunner, type ScopedExecution } from "./sandbox-runner.ts";
import { WorkerPool } from "./worker-pool.ts";

describe("scoped execution without bwrap", () => {
  it("runs the fixed command through the resident bash worker with its own cwd", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scoped-fallback-"));
    try {
      const buildArgs = (): string[] => assert.fail("Fallback must not construct bwrap mounts");
      const pool = new WorkerPool(directory, buildArgs, () => false);
      const runner = new SandboxRunner(directory, buildArgs, pool);
      const target = "fixture's result";
      const executor = { entrypoint: WORKER_ENTRYPOINT };
      const signal = new AbortController().signal;
      const calls: { tool: string; cwd: string | undefined }[] = [];
      const runTool = pool.runTool.bind(pool);
      pool.runTool = async (toolName, params, options) => {
        assert.equal(toolName, "bash");
        assert.equal(options.mode, "bash");
        assert.deepEqual(options.executor, executor);
        assert.equal(options.signal, signal);
        assert.equal(options.timeout, 60);
        calls.push({ tool: toolName, cwd: options.cwd });
        return runTool(toolName, params, options);
      };
      async function run(script: string, write = false): Promise<string> {
        const call: ScopedExecution = {
          executable: process.execPath,
          cwd: directory,
          args: ["-e", script, target],
          env: {},
          allowedCodes: [],
          write: write
            ? {
                paths: [join(directory, target)],
                directories: [directory],
                validate() {},
              }
            : undefined,
        };
        const result = await runner.runScopedExecution(call, [], signal, executor);
        return (result.details as { output: string }).output;
      }
      await run('Bun.write(process.argv[1], "fixture")', true);
      assert.equal(
        await run("process.stdout.write(await Bun.file(process.argv[1]).text())"),
        "fixture",
      );
      await run('require("node:fs").unlinkSync(process.argv[1])', true);
      assert.equal(existsSync(join(directory, target)), false);
      assert.deepEqual(
        calls.map((call) => call.cwd),
        [directory, directory, directory],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
