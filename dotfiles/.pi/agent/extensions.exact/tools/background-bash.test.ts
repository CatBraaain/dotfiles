import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "bun:test";
import {
  createEventBus,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SandboxRunner } from "../guardrails/sandbox-runner.ts";
import toolsExtension from "./index.ts";
import { registerBackgroundBash, requestBackgroundBash } from "./background-bash.ts";

const result: AgentToolResult<unknown> = { content: [{ type: "text", text: "done" }], details: {} };
const request = {
  id: "background",
  params: { command: "echo test" },
  context: { model: undefined },
};

describe("background Bash lifetime", () => {
  it("fails immediately when no receiver synchronously claims the request", async () => {
    const events = createEventBus();
    const outcome = await requestBackgroundBash(events, request);
    assert.equal(outcome.status, "unavailable");
  });

  it("rejects a late asynchronous claim", async () => {
    const events = createEventBus();
    let lateClaim: unknown;
    events.on("tools:execute-bash", async (data) => {
      await setImmediate();
      lateClaim = (data as { claim(): unknown }).claim();
    });
    assert.equal((await requestBackgroundBash(events, request)).status, "unavailable");
    await setImmediate();
    assert.equal(lateClaim, undefined);
  });

  it("allows only one receiver and retains the exact result including isError", async () => {
    const events = createEventBus();
    const expected = { ...result, isError: true, structuredContent: { exit_code: 2 } };
    let calls = 0;
    const first = registerBackgroundBash(events, async () => {
      calls++;
      return expected;
    });
    const second = registerBackgroundBash(events, async () => {
      calls++;
      return result;
    });
    try {
      const outcome = await requestBackgroundBash(events, request);
      assert.equal(outcome.status, "completed");
      if (outcome.status === "completed") assert.strictEqual(outcome.result, expected);
      assert.equal(calls, 1);
    } finally {
      first();
      second();
    }
  });

  it("preserves thrown errors as execution failures", async () => {
    const events = createEventBus();
    const error = new Error("Bash failed");
    const dispose = registerBackgroundBash(events, async () => {
      throw error;
    });
    try {
      assert.deepEqual(await requestBackgroundBash(events, request), { status: "failed", error });
    } finally {
      dispose();
    }
  });

  it("rejects invalid results", async () => {
    const events = createEventBus();
    const dispose = registerBackgroundBash(events, async () => ({}) as AgentToolResult<unknown>);
    try {
      const outcome = await requestBackgroundBash(events, request);
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed")
        assert.match(String(outcome.error), /Invalid background Bash result/);
    } finally {
      dispose();
    }
  });

  it("does not execute an already aborted request", async () => {
    const events = createEventBus();
    const controller = new AbortController();
    controller.abort("cancelled");
    let calls = 0;
    const dispose = registerBackgroundBash(events, async () => {
      calls++;
      return result;
    });
    try {
      assert.deepEqual(
        await requestBackgroundBash(events, { ...request, signal: controller.signal }),
        { status: "aborted", reason: "cancelled" },
      );
      assert.equal(calls, 0);
    } finally {
      dispose();
    }
  });

  for (const boundary of ["abort", "shutdown"] as const) {
    it(`settles once on ${boundary} and discards a late result`, async () => {
      const events = createEventBus();
      const started = Promise.withResolvers<AbortSignal>();
      const delayed = Promise.withResolvers<AgentToolResult<unknown>>();
      const controller = new AbortController();
      const dispose = registerBackgroundBash(events, async (input) => {
        started.resolve(input.signal!);
        return delayed.promise;
      });
      try {
        const pending = requestBackgroundBash(events, { ...request, signal: controller.signal });
        const executionSignal = await started.promise;
        if (boundary === "abort") controller.abort("cancelled");
        else dispose();
        const outcome = await pending;
        assert.equal(outcome.status, boundary === "abort" ? "aborted" : "unavailable");
        assert.equal(executionSignal.aborted, true);
        delayed.resolve(result);
        await setImmediate();
        assert.strictEqual(await pending, outcome);
        if (boundary === "shutdown") {
          assert.equal((await requestBackgroundBash(events, request)).status, "unavailable");
          const replacement = registerBackgroundBash(events, async () => result);
          try {
            assert.equal((await requestBackgroundBash(events, request)).status, "completed");
          } finally {
            replacement();
          }
        }
      } finally {
        dispose();
        delayed.resolve(result);
      }
    });
  }

  it("times out a receiver that never responds and aborts its execution", async () => {
    const events = createEventBus();
    let signal: AbortSignal | undefined;
    const dispose = registerBackgroundBash(events, async (input) => {
      signal = input.signal;
      return new Promise(() => {});
    });
    try {
      const outcome = await requestBackgroundBash(events, request);
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") assert.match(String(outcome.error), /timed out/);
      assert.equal(signal?.aborted, true);
    } finally {
      dispose();
    }
  });
});

describe("background Bash shares registered authorization", () => {
  for (const action of ["allow", "deny", "ask", "ask_with_reason"] as const) {
    it(`uses ${action} without opening background UI`, async () => {
      await withTools(
        `commands:\n  - echo:\n      - ${action}: []\n`,
        async ({ events, calls }) => {
          const outcome = await requestBackgroundBash(events, request);
          assert.equal(outcome.status, action === "allow" ? "completed" : "failed");
          assert.equal(calls.length, action === "allow" ? 1 : 0);
        },
      );
    });
  }

  for (const [answer, scope] of [
    ["Allow once", "once"],
    ["Allow in this turn", "turn"],
    ["Allow in this session", "session"],
  ] as const) {
    it(`shares ask_permission ${scope} approval with the registered Bash`, async () => {
      await withTools(
        "commands:\n  - echo:\n      - ask_with_reason: []\n",
        async ({ events, tools, emit }) => {
          const context = {
            hasUI: true,
            ui: { select: async () => answer },
          } as unknown as ExtensionToolContext;
          await tools
            .get("ask_permission")!
            .execute(
              "grant",
              { command: "echo test", reason: "test" },
              undefined,
              undefined,
              context,
            );
          assert.equal((await requestBackgroundBash(events, request)).status, "completed");
          const normal = tools.get("bash")!;
          if (scope === "once") {
            await assert.rejects(
              normal.execute("consumed", request.params, undefined, undefined, {
                hasUI: false,
              } as ExtensionToolContext),
              /requires a reason/,
            );
          } else {
            await normal.execute("shared", request.params, undefined, undefined, {
              hasUI: false,
            } as ExtensionToolContext);
            await emit("input");
            assert.equal(
              (await requestBackgroundBash(events, request)).status,
              scope === "turn" ? "failed" : "completed",
            );
          }
        },
      );
    });
  }

  it("shares normal Bash session approval and keeps normal UI behavior", async () => {
    await withTools("commands:\n  - echo:\n      - ask: []\n", async ({ events, tools }) => {
      let prompts = 0;
      const context = {
        hasUI: true,
        ui: {
          select: async () => {
            prompts++;
            return "Allow in this session";
          },
        },
      } as unknown as ExtensionToolContext;
      await tools.get("bash")!.execute("normal", request.params, undefined, undefined, context);
      assert.equal((await requestBackgroundBash(events, request)).status, "completed");
      assert.equal(prompts, 1);
    });
  });

  it("rejects malformed arguments and model-selected policy or executor before execution", async () => {
    await withTools("commands:\n  - echo:\n      - allow: []\n", async ({ events, calls }) => {
      for (const params of [
        {},
        { command: 1 },
        { command: "echo test", timeout: "1" },
        { command: "echo test", executor: {} },
        { command: "echo test", approvalMode: "prompt" },
      ]) {
        const outcome = await requestBackgroundBash(events, {
          ...request,
          params,
        } as typeof request);
        assert.equal(outcome.status, "failed");
      }
      assert.equal(calls.length, 0);
    });
  });

  it("invalidates the entrance and pending calls when the Tools runtime shuts down", async () => {
    await withTools("commands:\n  - echo:\n      - allow: []\n", async ({ events, emit }) => {
      assert.equal((await requestBackgroundBash(events, request)).status, "completed");
      await emit("session_shutdown");
      assert.equal((await requestBackgroundBash(events, request)).status, "unavailable");
    });
  });
});

type Fixture = {
  events: ExtensionAPI["events"];
  tools: Map<string, ToolDefinition>;
  calls: string[];
  emit(name: string): Promise<void>;
};

async function withTools(config: string, test: (fixture: Fixture) => Promise<void>): Promise<void> {
  mkdirSync("/tmp/work/dotfiles", { recursive: true });
  const directory = mkdtempSync("/tmp/work/dotfiles/background-bash-");
  const configPath = join(directory, "guardrails.yaml");
  writeFileSync(configPath, config);
  const events = createEventBus();
  const handlers = new Map<string, (() => unknown)[]>();
  const tools = new Map<string, ToolDefinition>();
  const calls: string[] = [];
  const originalRun = SandboxRunner.prototype.runTool;
  SandboxRunner.prototype.runTool = async (name, params, options) => {
    assert.equal(name, "bash");
    assert.equal(options.mode, "bash");
    assert.equal(options.executor, undefined);
    calls.push((params as { command: string }).command);
    return result;
  };
  const pi = {
    events,
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: () => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  async function emit(name: string): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler();
  }
  try {
    toolsExtension(pi, configPath);
    await test({ events, tools, calls, emit });
  } finally {
    await emit("session_shutdown");
    events.clear();
    SandboxRunner.prototype.runTool = originalRun;
    rmSync(directory, { recursive: true, force: true });
  }
}
