import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "bun:test";
import {
  createEventBus,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
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
  context: { model: undefined, modelRegistry: {} } as ExtensionContext,
};

describe("background Bash lifetime", () => {
  it("fails immediately when the runtime API is not registered", async () => {
    const outcome = await requestBackgroundBash(request);
    assert.equal(outcome.status, "unavailable");
  });

  it("retains the exact result including isError", async () => {
    const expected = { ...result, isError: true, structuredContent: { exit_code: 2 } };
    let calls = 0;
    const dispose = registerBackgroundBash(
      request.context,
      async () => {
        calls++;
        return expected;
      },
      () => {},
    );
    try {
      const outcome = await requestBackgroundBash(request);
      assert.equal(outcome.status, "completed");
      if (outcome.status === "completed") assert.strictEqual(outcome.result, expected);
      assert.equal(calls, 1);
    } finally {
      dispose();
    }
  });

  it("isolates runtimes even with the same session manager", async () => {
    const other = { ...request.context, modelRegistry: {} } as ExtensionContext;
    const dispose = registerBackgroundBash(
      request.context,
      async () => result,
      () => {},
    );
    try {
      assert.equal(
        (await requestBackgroundBash({ ...request, context: other })).status,
        "unavailable",
      );
      assert.equal((await requestBackgroundBash(request)).status, "completed");
    } finally {
      dispose();
    }
  });

  it("rejects an invalidated runtime before starting another execution", async () => {
    let active = true;
    let calls = 0;
    const dispose = registerBackgroundBash(
      request.context,
      async () => {
        calls++;
        return result;
      },
      () => {
        if (!active) throw new Error("stale runtime");
      },
    );
    try {
      const pending = requestBackgroundBash(request);
      active = false;
      assert.equal((await pending).status, "unavailable");
      assert.equal((await requestBackgroundBash(request)).status, "unavailable");
      assert.equal(calls, 0);
    } finally {
      dispose();
    }
  });

  it("rejects a stale context getter without rejecting its outcome promise", async () => {
    const context = {
      get modelRegistry(): object {
        throw new Error("stale context");
      },
      model: undefined,
    };
    assert.equal((await requestBackgroundBash({ ...request, context })).status, "unavailable");
  });

  it("preserves thrown errors as execution failures", async () => {
    const error = new Error("Bash failed");
    const dispose = registerBackgroundBash(
      request.context,
      async () => {
        throw error;
      },
      () => {},
    );
    try {
      assert.deepEqual(await requestBackgroundBash(request), { status: "failed", error });
    } finally {
      dispose();
    }
  });

  it("rejects invalid results", async () => {
    const dispose = registerBackgroundBash(
      request.context,
      async () => ({}) as AgentToolResult<unknown>,
      () => {},
    );
    try {
      const outcome = await requestBackgroundBash(request);
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed")
        assert.match(String(outcome.error), /Invalid background Bash result/);
    } finally {
      dispose();
    }
  });

  it("does not execute an already aborted request", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    let calls = 0;
    const dispose = registerBackgroundBash(
      request.context,
      async () => {
        calls++;
        return result;
      },
      () => {},
    );
    try {
      assert.deepEqual(await requestBackgroundBash({ ...request, signal: controller.signal }), {
        status: "aborted",
        reason: "cancelled",
      });
      assert.equal(calls, 0);
    } finally {
      dispose();
    }
  });

  for (const boundary of ["abort", "shutdown"] as const) {
    it(`settles once on ${boundary} and discards a late result`, async () => {
      const started = Promise.withResolvers<AbortSignal>();
      const delayed = Promise.withResolvers<AgentToolResult<unknown>>();
      const controller = new AbortController();
      const dispose = registerBackgroundBash(
        request.context,
        async (input) => {
          started.resolve(input.signal!);
          return delayed.promise;
        },
        () => {},
      );
      try {
        const pending = requestBackgroundBash({ ...request, signal: controller.signal });
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
          assert.equal((await requestBackgroundBash(request)).status, "unavailable");
          const replacement = registerBackgroundBash(
            request.context,
            async () => result,
            () => {},
          );
          try {
            assert.equal((await requestBackgroundBash(request)).status, "completed");
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

  it("adds setup time to the outer deadline while preserving the execution timeout", async () => {
    await withControlledClock(async (advance) => {
      const executionStarted = Promise.withResolvers<void>();
      const dispose = registerBackgroundBash(
        request.context,
        async (input) => {
          assert.equal(input.params.timeout, 0.1);
          advance(1_980);
          executionStarted.resolve();
          await new Promise((resolve) => setTimeout(resolve, 70));
          return result;
        },
        () => {},
      );
      try {
        const pending = requestBackgroundBash({
          ...request,
          params: { ...request.params, timeout: 0.1 },
        });
        await executionStarted.promise;
        advance(70);
        assert.equal((await pending).status, "completed");
      } finally {
        dispose();
      }
    });
  });

  it("fails and aborts only when the outer deadline is exceeded", async () => {
    await withControlledClock(async (advance) => {
      let signal: AbortSignal | undefined;
      const dispose = registerBackgroundBash(
        request.context,
        async (input) => {
          signal = input.signal;
          return new Promise(() => {});
        },
        () => {},
      );
      try {
        const pending = requestBackgroundBash({
          ...request,
          params: { ...request.params, timeout: 0.1 },
        });
        await Promise.resolve();
        advance(2_101);
        const outcome = await pending;
        assert.equal(outcome.status, "failed");
        assert.equal(signal?.aborted, true);
      } finally {
        dispose();
      }
    });
  });

  it("rearms large deadlines without timing out at the timer limit", async () => {
    await withControlledClock(async (advance, scheduledDelays) => {
      const delayed = Promise.withResolvers<AgentToolResult<unknown>>();
      const dispose = registerBackgroundBash(
        request.context,
        async () => delayed.promise,
        () => {},
      );
      try {
        const pending = requestBackgroundBash({
          ...request,
          params: { ...request.params, timeout: 2_147_483.647 },
        });
        await Promise.resolve();
        assert.equal(scheduledDelays[0], 2_147_483_647);
        advance(2_147_483_647);
        assert.equal(scheduledDelays[1], 2_000);
        delayed.resolve(result);
        assert.equal((await pending).status, "completed");
      } finally {
        dispose();
      }
    });
  });

  it.each([undefined, 0.01])(
    "keeps the default request deadline for timeout %s",
    async (timeout) => {
      const dispose = registerBackgroundBash(
        request.context,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return result;
        },
        () => {},
      );
      try {
        const outcome = await requestBackgroundBash({
          ...request,
          params: { ...request.params, timeout },
        });
        assert.equal(outcome.status, "completed");
      } finally {
        dispose();
      }
    },
  );

  it("allows an explicit timeout beyond the default request deadline", async () => {
    const dispose = registerBackgroundBash(
      request.context,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_050));
        return result;
      },
      () => {},
    );
    try {
      const outcome = await requestBackgroundBash({
        ...request,
        params: { ...request.params, timeout: 25 },
      });
      assert.equal(outcome.status, "completed");
    } finally {
      dispose();
    }
  });

  it("times out a receiver that never responds and aborts its execution", async () => {
    let signal: AbortSignal | undefined;
    const dispose = registerBackgroundBash(
      request.context,
      async (input) => {
        signal = input.signal;
        return new Promise(() => {});
      },
      () => {},
    );
    try {
      const outcome = await requestBackgroundBash(request);
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
      await withTools(`commands:\n  - echo:\n      - ${action}: []\n`, async ({ calls }) => {
        const outcome = await requestBackgroundBash(request);
        assert.equal(outcome.status, action === "allow" ? "completed" : "failed");
        assert.equal(calls.length, action === "allow" ? 1 : 0);
      });
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
        async ({ tools, emit }) => {
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
          assert.equal((await requestBackgroundBash(request)).status, "completed");
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
              (await requestBackgroundBash(request)).status,
              scope === "turn" ? "failed" : "completed",
            );
          }
        },
      );
    });
  }

  it("shares normal Bash session approval and keeps normal UI behavior", async () => {
    await withTools("commands:\n  - echo:\n      - ask: []\n", async ({ tools }) => {
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
      assert.equal((await requestBackgroundBash(request)).status, "completed");
      assert.equal(prompts, 1);
    });
  });

  it("rejects malformed arguments and model-selected policy or executor before execution", async () => {
    await withTools("commands:\n  - echo:\n      - allow: []\n", async ({ calls }) => {
      for (const params of [
        {},
        { command: 1 },
        { command: "echo test", timeout: "1" },
        { command: "echo test", executor: {} },
        { command: "echo test", approvalMode: "prompt" },
      ]) {
        const outcome = await requestBackgroundBash({
          ...request,
          params,
        } as typeof request);
        assert.equal(outcome.status, "failed");
      }
      assert.equal(calls.length, 0);
    });
  });

  it("invalidates the entrance and pending calls when the Tools runtime shuts down", async () => {
    await withTools("commands:\n  - echo:\n      - allow: []\n", async ({ emit }) => {
      assert.equal((await requestBackgroundBash(request)).status, "completed");
      await emit("session_shutdown");
      assert.equal((await requestBackgroundBash(request)).status, "unavailable");
    });
  });
});

type Fixture = {
  events: ExtensionAPI["events"];
  tools: Map<string, ToolDefinition>;
  calls: string[];
  emit(name: string): Promise<void>;
};

async function withControlledClock(
  test: (advance: (milliseconds: number) => void, scheduledDelays: number[]) => Promise<void>,
): Promise<void> {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { callback: () => void; dueAt: number }>();
  const scheduledDelays: number[] = [];
  Date.now = () => now;
  globalThis.setTimeout = ((callback: unknown, delay = 0) => {
    const timerId = nextTimerId++;
    scheduledDelays.push(delay);
    timers.set(timerId, { callback: callback as () => void, dueAt: now + delay });
    return timerId as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timerId: ReturnType<typeof setTimeout>) => {
    timers.delete(timerId as unknown as number);
  }) as typeof clearTimeout;
  function advance(milliseconds: number): void {
    const targetTime = now + milliseconds;
    while (true) {
      const nextTimer = [...timers.entries()].sort(
        (left, right) => left[1].dueAt - right[1].dueAt,
      )[0];
      if (!nextTimer || nextTimer[1].dueAt > targetTime) break;
      now = nextTimer[1].dueAt;
      timers.delete(nextTimer[0]);
      nextTimer[1].callback();
    }
    now = targetTime;
  }
  try {
    await test(advance, scheduledDelays);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

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
    getThinkingLevel() {
      return "off";
    },
    on(name: string, handler: () => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  async function emit(name: string): Promise<void> {
    for (const handler of handlers.get(name) ?? [])
      await (handler as (event: unknown, ctx: unknown) => unknown)({}, request.context);
  }
  try {
    toolsExtension(pi, configPath);
    await emit("session_start");
    await test({ events, tools, calls, emit });
  } finally {
    await emit("session_shutdown");
    events.clear();
    SandboxRunner.prototype.runTool = originalRun;
    rmSync(directory, { recursive: true, force: true });
  }
}
