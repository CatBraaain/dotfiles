import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { executeGuardedTool, type GuardedToolRequest } from "./execute.ts";
import { Guardrail } from "./guardrail.ts";
import { WorkerPool } from "./worker-pool.ts";

describe.skipIf(process.platform !== "linux")("guarded execution boundary", () => {
  it("awaits approval before executing the requested tool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guarded-execute-"));
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(
        config,
        `read:\n  - ask: ${directory}\ncommands:\n  - file:\n      - allow: []\n`,
      );
      const guardrail = new Guardrail(directory, config);
      const pool = new WorkerPool(directory, (mode) => guardrail.buildArgs(mode));
      const dialog = Promise.withResolvers<boolean>();
      const shown = Promise.withResolvers<void>();
      let executions = 0;
      pool.runTool = async (_name, params, options) => {
        executions++;
        assert.deepEqual(options.executor, { entrypoint: join(directory, "fixture.ts") });
        assert.equal(options.mode, "fs");
        assert.deepEqual(params, { path: join(directory, "input.txt") });
        return { content: [], details: {} };
      };
      const request = {
        toolName: "read",
        executor: { entrypoint: join(directory, "fixture.ts") },
        params: { path: join(directory, "input.txt") },
        context: {
          hasUI: true,
          ui: {
            confirm: async () => {
              shown.resolve();
              return dialog.promise;
            },
          },
        },
      } as unknown as GuardedToolRequest;
      const pending = executeGuardedTool(guardrail, pool, directory, request);
      await shown.promise;
      assert.equal(executions, 0);
      dialog.resolve(true);
      await pending;
      assert.equal(executions, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not execute the worker after cancellation while approval is pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guarded-abort-"));
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(config, `read:\n  - ask: ${directory}\n`);
      const guardrail = new Guardrail(directory, config);
      const pool = new WorkerPool(directory, (mode) => guardrail.buildArgs(mode));
      const dialog = Promise.withResolvers<boolean>();
      const shown = Promise.withResolvers<void>();
      const controller = new AbortController();
      let executions = 0;
      pool.runTool = async () => {
        executions++;
        return { content: [], details: {} };
      };
      const request = {
        toolName: "read",
        params: { path: join(directory, "input.txt") },
        executor: { entrypoint: join(directory, "fixture.ts") },
        signal: controller.signal,
        context: {
          hasUI: true,
          ui: {
            confirm: async () => {
              shown.resolve();
              return dialog.promise;
            },
          },
        },
      } as unknown as GuardedToolRequest;
      const pending = executeGuardedTool(guardrail, pool, directory, request);
      await shown.promise;
      controller.abort(new Error("cancelled in dialog"));
      dialog.resolve(true);
      await assert.rejects(pending, /cancelled in dialog/);
      assert.equal(executions, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not start the worker after approval is denied", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guarded-denied-"));
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(config, `read:\n  - ask: ${directory}\n`);
      const guardrail = new Guardrail(directory, config);
      const pool = new WorkerPool(directory, (mode) => guardrail.buildArgs(mode));
      let executions = 0;
      pool.runTool = async () => {
        executions++;
        return { content: [], details: {} };
      };
      const request = {
        toolName: "read",
        params: { path: join(directory, "input.txt") },
        executor: { entrypoint: join(directory, "fixture.ts") },
        context: { hasUI: true, ui: { confirm: async () => false } },
      } as unknown as GuardedToolRequest;
      await assert.rejects(
        executeGuardedTool(guardrail, pool, directory, request),
        /Access denied by user/,
      );
      assert.equal(executions, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported tool instead of treating it as a read operation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guarded-name-"));
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(config, "read: []\n");
      const guardrail = new Guardrail(directory, config);
      const pool = new WorkerPool(directory, (mode) => guardrail.buildArgs(mode));
      const request = {
        toolName: "unknown",
        params: {},
        executor: { entrypoint: join(directory, "fixture.ts") },
      } as GuardedToolRequest;
      await assert.rejects(
        executeGuardedTool(guardrail, pool, directory, request),
        /Unsupported guarded tool: unknown/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires an executor descriptor for every call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guarded-executor-"));
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(config, 'read:\n  - allow: "*"\n');
      const guardrail = new Guardrail(directory, config);
      let builds = 0;
      const pool = new WorkerPool(directory, () => {
        builds++;
        return [];
      });
      const request = {
        toolName: "read",
        params: { path: join(directory, "input.txt") },
        executor: undefined,
        context: { hasUI: false },
      } as unknown as GuardedToolRequest;
      await assert.rejects(
        executeGuardedTool(guardrail, pool, directory, request),
        /absolute file path/,
      );
      assert.equal(builds, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
