import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, spyOn } from "bun:test";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { parse, quote } from "shell-quote";
import { rewriteBashCommand } from "./rtk.ts";

type RewriteContext = Pick<ExtensionToolContext, "executeTool">;

let previousDisabled: string | undefined;
beforeEach(() => {
  previousDisabled = process.env.RTK_DISABLED;
  delete process.env.RTK_DISABLED;
});
afterEach(() => {
  if (previousDisabled === undefined) delete process.env.RTK_DISABLED;
  else process.env.RTK_DISABLED = previousDisabled;
});

describe("RTK command rewriting", () => {
  for (const exitCode of [0, 3]) {
    it(`adopts trimmed stdout for exit code ${exitCode}`, async () => {
      const context = contextWithOutput(
        { output: "  rtk git status\n", exit_code: exitCode, truncated: false },
        exitCode !== 0,
      );
      assert.equal(await rewriteBashCommand("git status", context), "rtk git status");
    });
  }

  for (const [label, output] of [
    ["no equivalent", { output: "rtk git status", exit_code: 1, truncated: false }],
    ["CLI failure", { output: "rtk git status", exit_code: 2, truncated: false }],
    ["missing CLI", { output: "", exit_code: 127, truncated: false }],
    ["empty stdout", { output: " \n\t", exit_code: 0, truncated: false }],
    ["missing structured output", undefined],
    ["null output", null],
    ["string output", "rtk git status"],
    ["array output", []],
    ["missing stdout", { exit_code: 0, truncated: false }],
    ["non-string stdout", { output: 123, exit_code: 0, truncated: false }],
    ["non-numeric exit code", { output: "rtk git status", exit_code: "0", truncated: false }],
    ["missing truncation flag", { output: "rtk git status", exit_code: 0 }],
    ["truncated stdout", { output: "rtk git status", exit_code: 0, truncated: true }],
  ] as const) {
    it(`keeps the original command on ${label}`, async () => {
      const context = contextWithOutput(output);
      assert.equal(await rewriteBashCommand("git status", context), "git status");
    });
  }

  it("does not adopt a failed tool result with a successful exit code", async () => {
    const context = contextWithOutput(
      { output: "rtk git status", exit_code: 0, truncated: false },
      true,
    );
    assert.equal(await rewriteBashCommand("git status", context), "git status");
  });

  it("passes shell syntax as one quoted argument and discards stderr", async () => {
    const command = "git log --format='%s'\nprintf 日本語; $(touch /tmp/unwanted) | cat >out";
    const controller = new AbortController();
    const calls: unknown[] = [];
    const context: RewriteContext = {
      async executeTool(name, args, options) {
        calls.push({ name, args, signal: options?.signal });
        return contextWithOutput(undefined).executeTool(name, args, options);
      },
    };
    assert.equal(await rewriteBashCommand(command, context, controller.signal), command);
    const expectedCommand = `${quote(["rtk", "rewrite", command])} 2>/dev/null`;
    assert.deepEqual(calls, [
      {
        name: "bash",
        args: { command: expectedCommand, timeout: 2 },
        signal: controller.signal,
      },
    ]);
    const tokens = parse(expectedCommand);
    assert.deepEqual(tokens.slice(0, 3), ["rtk", "rewrite", command]);
    assert.deepEqual(tokens.slice(3), ["2", { op: ">" }, "/dev/null"]);
  });

  for (const command of ["", " \n\t", "rtk git status", "rtk rewrite 'git status'"]) {
    it(`does not call Bash for excluded input ${JSON.stringify(command)}`, async () => {
      const context: RewriteContext = {
        async executeTool() {
          assert.fail("excluded commands must not start a nested Bash");
        },
      };
      assert.equal(await rewriteBashCommand(command, context), command);
    });
  }

  it("does not call Bash when RTK is disabled", async () => {
    process.env.RTK_DISABLED = "1";
    const context: RewriteContext = {
      async executeTool() {
        assert.fail("disabled RTK must not start a nested Bash");
      },
    };
    assert.equal(await rewriteBashCommand("git status", context), "git status");
  });

  it("keeps the original command when the registered tool API is unavailable", async () => {
    assert.equal(await rewriteBashCommand("git status", {} as RewriteContext), "git status");
  });

  it("does not call Bash when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const context: RewriteContext = {
      async executeTool() {
        assert.fail("an aborted rewrite must not start a nested Bash");
      },
    };
    assert.equal(await rewriteBashCommand("git status", context, controller.signal), "git status");
  });

  it("does not adopt a successful result after cancellation", async () => {
    const controller = new AbortController();
    const context: RewriteContext = {
      async executeTool(name, args, options) {
        controller.abort();
        return contextWithOutput({
          output: "rtk git status",
          exit_code: 0,
          truncated: false,
        }).executeTool(name, args, options);
      },
    };
    assert.equal(await rewriteBashCommand("git status", context, controller.signal), "git status");
  });

  it("warns and keeps the original command on an unexpected API exception", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("unavailable runtime");
    const context: RewriteContext = {
      async executeTool() {
        throw failure;
      },
    };
    try {
      assert.equal(await rewriteBashCommand("git status", context), "git status");
      assert.equal(warning.mock.calls.length, 1);
      assert.strictEqual(warning.mock.calls[0]![1], failure);
    } finally {
      warning.mockRestore();
    }
  });
});

function contextWithOutput(structuredContent: unknown, isError = false): RewriteContext {
  return {
    async executeTool(name) {
      return {
        toolCall: {
          type: "toolCall",
          id: "rewrite",
          name,
          arguments: {},
        },
        result: {
          content: [{ type: "text", text: "not a rewrite: display text and status" }],
          details: {},
          structuredContent: structuredContent as AgentToolResult<unknown>["structuredContent"],
          isError,
        },
        isError,
      };
    },
  };
}
