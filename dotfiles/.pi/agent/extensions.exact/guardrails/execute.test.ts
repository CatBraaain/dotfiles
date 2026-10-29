import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { executeGuardedTool, type GuardedToolRequest } from "./execute.ts";
import { Guardrail } from "./guardrail.ts";
import { SandboxRunner } from "./sandbox-runner.ts";

describe("guarded execution boundary", () => {
  it("awaits approval before executing the requested tool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guarded-execute-"));
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(config, `read:\n  - ask: ${directory}\n`);
      const guardrail = new Guardrail(directory, config);
      const runner = new SandboxRunner(directory, (mode) => guardrail.buildArgs(mode));
      const dialog = Promise.withResolvers<boolean>();
      const shown = Promise.withResolvers<void>();
      let executions = 0;
      runner.runTool = async () => {
        executions++;
        return { content: [], details: {} };
      };
      const request = {
        toolName: "read",
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
      const pending = executeGuardedTool(guardrail, runner, directory, request);
      await shown.promise;
      assert.equal(executions, 0);
      dialog.resolve(true);
      await pending;
      assert.equal(executions, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not execute after a cancellation while approval is pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guarded-abort-"));
    try {
      const config = join(directory, "config.yaml");
      writeFileSync(config, `read:\n  - ask: ${directory}\n`);
      const guardrail = new Guardrail(directory, config);
      const runner = new SandboxRunner(directory, (mode) => guardrail.buildArgs(mode));
      const dialog = Promise.withResolvers<boolean>();
      const shown = Promise.withResolvers<void>();
      const controller = new AbortController();
      let executions = 0;
      runner.runTool = async () => {
        executions++;
        return { content: [], details: {} };
      };
      const request = {
        toolName: "read",
        params: { path: join(directory, "input.txt") },
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
      const pending = executeGuardedTool(guardrail, runner, directory, request);
      await shown.promise;
      controller.abort(new Error("cancelled in dialog"));
      dialog.resolve(true);
      await assert.rejects(pending, /cancelled in dialog/);
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
      const runner = new SandboxRunner(directory, (mode) => guardrail.buildArgs(mode));
      const request = { toolName: "unknown", params: {} } as GuardedToolRequest;
      await assert.rejects(
        executeGuardedTool(guardrail, runner, directory, request),
        /Unsupported guarded tool: unknown/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
