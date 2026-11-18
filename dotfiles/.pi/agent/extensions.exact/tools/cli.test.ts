import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { runCliViaBash } from "./cli.ts";

function frame(stdout = "", stderr = "", code = 0): string {
  return [
    "PI_CLI_V1:" + code,
    Buffer.from(stdout).toString("base64"),
    Buffer.from(stderr).toString("base64"),
    "PI_CLI_END",
    "",
  ].join("\n");
}

function response(output: string, overrides: Record<string, unknown> = {}) {
  return {
    toolCall: { type: "toolCall" as const, id: "nested", name: "bash", arguments: {} },
    isError: false,
    result: {
      content: [{ type: "text" as const, text: output }],
      details: {},
      structuredContent: { output, truncated: false, exit_code: 0, ...overrides },
    },
  };
}

const params = { executable: "/cli", args: [] };

describe("runCliViaBash CLI input", () => {
  it("uses only the requested timeout and keeps cwd inside the authorized command", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const context = {
      async executeTool(name: string, args: unknown) {
        assert.equal(name, "bash");
        calls.push(args as Record<string, unknown>);
        return response(frame());
      },
    };
    const first = await runCliViaBash({ context, params: { ...params, cwd: "/tmp/a'\nb" } });
    assert.equal(first.status, "completed");
    assert.deepEqual(Object.keys(calls[0]!), ["command"]);
    assert.ok(String(calls[0]!.command).includes("cd -- '/tmp/a'\\''\nb' || exit"));
    await runCliViaBash({ context, params: { ...params, timeout: 300 } });
    assert.equal(calls[1]!.timeout, 300);
    assert.equal(String(calls[1]!.command).includes("cd --"), false);
  });

  for (const unsafe of [
    { executable: "/bad\0path", args: [] },
    { executable: "/cli", args: ["bad\0arg"] },
    { executable: "/cli", args: [], cwd: "/bad\0cwd" },
  ]) {
    it("rejects NUL bytes before invoking Bash: " + JSON.stringify(unsafe), async () => {
      let calls = 0;
      const context = {
        async executeTool() {
          calls++;
          return response(frame());
        },
      };
      const outcome = await runCliViaBash({ context, params: unsafe });
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") assert.match(String(outcome.error), /NUL/);
      assert.equal(calls, 0);
    });
  }

  it("does not invoke Bash for an already aborted signal", async () => {
    let calls = 0;
    const context = {
      async executeTool() {
        calls++;
        return response(frame());
      },
    };
    const reason = new Error("cancelled");
    const outcome = await runCliViaBash({ context, params, signal: AbortSignal.abort(reason) });
    assert.equal(outcome.status, "aborted");
    if (outcome.status === "aborted") assert.strictEqual(outcome.reason, reason);
    assert.equal(calls, 0);
  });

  it("preserves a thrown context error without retry or fallback", async () => {
    let calls = 0;
    const error = new Error("Expired context");
    const context = {
      async executeTool(): Promise<never> {
        calls++;
        throw error;
      },
    };
    const outcome = await runCliViaBash({ context, params });
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.strictEqual(outcome.error, error);
    assert.equal(calls, 1);
  });

  for (const output of [
    "PI_CLI_V1:256\n\n\nPI_CLI_END\n",
    "PI_CLI_V1:0\n====\n\nPI_CLI_END\n",
    "PI_CLI_V1:0\n",
    frame() + "extra",
  ]) {
    it(
      "retains the original response for a malformed frame: " + JSON.stringify(output),
      async () => {
        const original = response(output);
        const context = {
          async executeTool() {
            return original;
          },
        };
        const outcome = await runCliViaBash({ context, params });
        assert.equal(outcome.status, "failed");
        if (outcome.status === "failed") {
          assert.match(String(outcome.error), /invalid|Invalid/);
          assert.strictEqual(outcome.result, original.result);
          assert.equal(outcome.isError, false);
        }
      },
    );
  }

  for (const overrides of [
    { output: undefined },
    { truncated: undefined },
    { exit_code: undefined },
  ]) {
    it("fails closed for missing structured fields: " + Object.keys(overrides)[0], async () => {
      const context = {
        async executeTool() {
          return response(frame(), overrides);
        },
      };
      const outcome = await runCliViaBash({ context, params });
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") assert.match(String(outcome.error), /invalid structured/);
    });
  }

  for (const location of ["outer", "inner", "exit"] as const) {
    it("retains the failed Bash response for " + location + " failure", async () => {
      const original = response(frame(), location === "exit" ? { exit_code: 2 } : {});
      original.isError = location === "outer";
      const result = { ...original.result, isError: location === "inner" };
      const context = {
        async executeTool() {
          return { ...original, result };
        },
      };
      const outcome = await runCliViaBash({ context, params });
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") {
        assert.strictEqual(outcome.result, result);
        assert.equal(outcome.isError, original.isError);
      }
    });
  }

  it("returns nonzero CLI exit codes without treating them as Bash failure", async () => {
    const original = response(frame(" \nvalue\n\n", "error\n\n", 23));
    const context = {
      async executeTool() {
        return original;
      },
    };
    const outcome = await runCliViaBash({ context, params });
    assert.equal(outcome.status, "completed");
    if (outcome.status === "completed") {
      assert.deepEqual(outcome.cli, { stdout: " \nvalue\n\n", stderr: "error\n\n", code: 23 });
      assert.strictEqual(outcome.result, original.result);
    }
  });

  it("forwards cancellation and timeout during recovery and stops before the next chunk", async () => {
    const controller = new AbortController();
    const output = frame("x".repeat(800_000));
    const cancelled = response(output.slice(0, 524_288));
    let calls = 0;
    const context = {
      async executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }) {
        assert.equal(name, "bash");
        assert.equal(options?.signal, controller.signal);
        assert.equal((args as { timeout: number }).timeout, 300);
        calls++;
        if (calls === 1)
          return response("partial", { truncated: true, full_output_path: "/tmp/output" });
        if (calls === 2) return response(String(output.length));
        controller.abort("cancelled");
        return cancelled;
      },
    };
    const outcome = await runCliViaBash({
      context,
      params: { ...params, timeout: 300 },
      signal: controller.signal,
    });
    assert.equal(outcome.status, "aborted");
    if (outcome.status === "aborted") {
      assert.equal(outcome.reason, "cancelled");
      assert.strictEqual(outcome.result, cancelled.result);
    }
    assert.equal(calls, 3);
  });

  it("recovers complete output without a timeout or rerunning the CLI and retains the first response", async () => {
    const output = frame("x".repeat(800_000));
    const original = response("partial", { truncated: true, full_output_path: "/tmp/output" });
    let calls = 0;
    const context = {
      async executeTool(_name: string, args: unknown) {
        assert.equal(Object.hasOwn(args as object, "timeout"), false);
        calls++;
        if (calls === 1) return original;
        assert.doesNotMatch((args as { command: string }).command, /PI_CLI_V1/);
        if (calls === 2) return response(String(output.length));
        return response(output.slice((calls - 3) * 524_288, (calls - 2) * 524_288));
      },
    };
    const outcome = await runCliViaBash({ context, params });
    assert.equal(outcome.status, "completed");
    if (outcome.status === "completed") {
      assert.equal(outcome.cli?.stdout, "x".repeat(800_000));
      assert.strictEqual(outcome.result, original.result);
    }
    assert.equal(calls, 2 + Math.ceil(output.length / 524_288));
  });

  for (const failure of ["response", "throw"] as const) {
    it("retains the correct response when recovery fails with " + failure, async () => {
      const original = response("partial", { truncated: true, full_output_path: "/tmp/output" });
      const failed = { ...response("denied"), isError: true };
      const error = new Error("context expired");
      let calls = 0;
      const context = {
        async executeTool() {
          calls++;
          if (calls === 1) return original;
          if (calls === 2) return response("100");
          if (failure === "throw") throw error;
          return failed;
        },
      };
      const outcome = await runCliViaBash({ context, params });
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") {
        assert.strictEqual(
          outcome.result,
          failure === "response" ? failed.result : original.result,
        );
        assert.equal(outcome.isError, failure === "response");
        if (failure === "throw") assert.strictEqual(outcome.error, error);
      }
      assert.equal(calls, 3);
    });
  }
});
