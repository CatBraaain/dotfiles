import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { parse } from "shell-quote";
import { getTmuxPaths, PARENT_PI_ENV_KEYS } from "../pi-mux-bridge/shared.ts";
import {
  registerMainagentTool,
  buildTmuxCommand,
  validateInput,
  type MainagentInput,
} from "./mainagent.ts";

type DialogOptions = { signal?: AbortSignal };

type ApprovalUI = {
  confirm(title: string, message: string, options?: DialogOptions): Promise<boolean>;
  select?(
    title: string,
    options: string[],
    dialogOptions?: DialogOptions,
  ): Promise<string | undefined>;
  input?(title: string, placeholder?: string, options?: DialogOptions): Promise<string | undefined>;
};

type ExecuteTool = (
  name: string,
  args: unknown,
) => Promise<{
  isError: boolean;
  result: {
    content: { type: string; text: string }[];
    isError: boolean;
    structuredContent: unknown;
  };
}>;

type CapturedHandlers = Map<string, (event: any, context?: any) => unknown>;

function captureTool(handlers?: CapturedHandlers): any {
  const tools: any[] = [];
  registerMainagentTool({
    registerTool: (tool: any) => tools.push(tool),
    on: (event: string, handler: (event: any, context?: any) => unknown) =>
      handlers?.set(event, handler),
  } as any);
  assert.equal(tools.length, 1);
  return tools[0];
}

function bashOutcome(
  exitCode = 0,
  output = "Pi session fixture-id\nAttach with: tmux -S fixture.sock attach-session -t $7",
) {
  return {
    isError: exitCode !== 0,
    result: {
      content: [{ type: "text", text: output }],
      isError: exitCode !== 0,
      structuredContent: { output, exit_code: exitCode, truncated: false },
    },
  };
}

type ApprovalAnswer = "once" | "turn" | "session" | "deny";
const ANSWER_LABELS: Record<ApprovalAnswer, string> = {
  once: "Allow once",
  turn: "Allow in this turn",
  session: "Allow in this session",
  deny: "No, deny (reason next)",
};

type UiCalls = {
  selections: { title: string; options: string[]; signal?: AbortSignal }[];
  confirmations: { title: string; message: string; signal?: AbortSignal }[];
  inputTitles: string[];
  inputSignals: (AbortSignal | undefined)[];
};

function approvalUi(answer: {
  dialog?: ApprovalAnswer | Promise<ApprovalAnswer | undefined>;
  confirm?: boolean;
  input?: string | Promise<string | undefined>;
}): {
  ui: ApprovalUI;
  calls: UiCalls;
} {
  const calls: UiCalls = { selections: [], confirmations: [], inputTitles: [], inputSignals: [] };
  return {
    calls,
    ui: {
      async select(title, options, dialogOptions) {
        calls.selections.push({ title, options, signal: dialogOptions?.signal });
        const selected = await answer.dialog;
        return selected === undefined ? undefined : ANSWER_LABELS[selected];
      },
      async confirm(title, message, options) {
        calls.confirmations.push({ title, message, signal: options?.signal });
        return answer.confirm ?? false;
      },
      async input(title, _placeholder, options) {
        calls.inputTitles.push(title);
        calls.inputSignals.push(options?.signal);
        return answer.input;
      },
    },
  };
}

function mockContext(
  ui: ApprovalUI,
  executeTool: ExecuteTool,
  cwd = "/project",
  mode: "tui" | "rpc" = "tui",
): any {
  return { cwd, hasUI: true, mode, ui, executeTool };
}

const recordingExecutor = (): { executeTool: ExecuteTool; commands: string[] } => {
  const commands: string[] = [];
  return {
    commands,
    async executeTool(name: string, args: unknown) {
      assert.equal(name, "bash");
      commands.push((args as { command: string }).command);
      return bashOutcome();
    },
  };
};

function withAgentName(
  name: string | undefined,
  test: () => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    const previous = process.env.PI_AGENT_NAME;
    if (name === undefined) delete process.env.PI_AGENT_NAME;
    else process.env.PI_AGENT_NAME = name;
    try {
      await test();
    } finally {
      if (previous === undefined) delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = previous;
    }
  };
}

const request: MainagentInput = { prompt: "fix the failing build" };

const previousAgentName = process.env.PI_AGENT_NAME;
beforeAll(() => {
  process.env.PI_AGENT_NAME = "main";
});
afterAll(() => {
  if (previousAgentName === undefined) delete process.env.PI_AGENT_NAME;
  else process.env.PI_AGENT_NAME = previousAgentName;
});

describe("入力の検証", () => {
  it("空白の prompt を拒否する", () => {
    assert.match(validateInput({ prompt: "  " })!, /prompt must not be empty/);
  });

  it("NUL を含む prompt を拒否する", () => {
    assert.match(validateInput({ prompt: "a\0b" })!, /cannot contain NUL/);
  });

  it("rejects a working directory containing NUL", () => {
    assert.match(validateInput({ prompt: "x", cwd: "/a\0b" })!, /cwd cannot contain NUL/);
  });

  it("accepts a prompt and working directory", () => {
    assert.equal(validateInput({ prompt: "x", cwd: "/tmp" }), undefined);
  });
});

describe("common independent startup command", () => {
  it("uses the dedicated runtime and common CLI without calling tmux directly", () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: "/isolated runtime" });
    const command = buildTmuxCommand({ prompt: "fix it", cwd: "/repo" }, paths);
    const tokens = parse(command);
    assert.deepEqual(tokens.slice(0, 2), ["bash", "-lc"]);
    const script = tokens[2] as string;
    const inner = parse(script);
    assert.ok(inner.includes("XDG_RUNTIME_DIR=/isolated runtime"));
    assert.deepEqual(inner.slice(inner.indexOf("exec")), [
      "exec",
      "pi-mux",
      "new",
      "--detached",
      "fix it",
    ]);
    assert.equal(inner.includes("tmux"), false);
    assert.equal(inner.includes("attach-session"), false);
    assert.equal(command.includes("TMUX_TMPDIR"), false);
  });

  it("removes parent conversation state before entering the shared launcher", () => {
    const command = buildTmuxCommand({ prompt: "x", cwd: "/r" });
    const script = parse(command)[2] as string;
    const tokens = parse(script);
    assert.deepEqual(tokens.slice(1, 1 + PARENT_PI_ENV_KEYS.length), [...PARENT_PI_ENV_KEYS]);
    assert.equal(script.includes("unset TERM"), false);
  });

  for (const prompt of [
    "fix it",
    'it\'s $(x) `y` "z"',
    "--session option-like\nnext line",
    "--detached",
    "--",
    "@/file with spaces.txt",
  ]) {
    it(`preserves a literal prompt argument: ${JSON.stringify(prompt)}`, () => {
      const cwd = "/dir with space/quote's\nnext line";
      const command = buildTmuxCommand({ prompt, cwd });
      const decoded = spawnSync("bash", ["-c", `bash() { printf '%s' "$2"; }\n${command}`]);
      assert.equal(decoded.status, 0, String(decoded.stderr));
      const script = decoded.stdout.toString();
      const tokens = parse(script);
      assert.deepEqual(tokens.slice(tokens.indexOf("cd") + 1, tokens.indexOf("cd") + 3), [
        "--",
        cwd,
      ]);
      const invocation = script.slice(script.indexOf("exec ") + "exec ".length);
      const expanded = spawnSync("bash", ["-c", `set -- ${invocation}\nprintf '%s\\0' "$@"`]);
      assert.equal(expanded.status, 0, String(expanded.stderr));
      const argumentsPassed = expanded.stdout.toString().split("\0").slice(0, -1);
      assert.deepEqual(argumentsPassed, ["pi-mux", "new", "--detached", prompt]);
    });
  }
});

describe("ツールの登録", () => {
  it("mainagent として登録し、bash に到達する", () => {
    const tool = captureTool();
    assert.equal(tool.name, "mainagent");
    assert.deepEqual(tool.reachesTools(), ["bash"]);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["cwd", "prompt"]);
    assert.deepEqual(Object.keys(tool.outputSchema.properties).sort(), ["error", "status"]);
  });
});

describe("承認", () => {
  it("Allow once はその呼び出しだけを許可し、次の呼び出しは再度確認する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.equal(calls.selections.length, 2);
    assert.equal(executor.commands.length, 2);
  });

  it("Allow in this session はセッション内の再確認を省略する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "session" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.equal(calls.selections.length, 1);
    assert.equal(executor.commands.length, 3);
  });

  it("Allow in this turn は次のユーザー入力まで再確認を省略する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "turn" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.equal(calls.selections.length, 1);
    assert.equal(executor.commands.length, 2);
  });

  it("Deny は理由なしで実行を中止する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "deny" });
    const executor = recordingExecutor();
    const result = await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "denied");
    assert.match(result.content[0].text, /denied by user/);
    assert.equal(executor.commands.length, 0);
    assert.equal(calls.selections.length, 1);
  });

  it("Deny の理由入力を結果に含める", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "deny", input: "too many sessions" });
    const executor = recordingExecutor();
    const result = await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    assert.match(result.content[0].text, /denied by user: too many sessions/);
    assert.equal(executor.commands.length, 0);
  });

  it("confirm ダイアログの許可は1回限りで、次の呼び出しは再度確認する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ confirm: true });
    const uiWithoutSelect: ApprovalUI = { confirm: ui.confirm, input: ui.input };
    const executor = recordingExecutor();
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(uiWithoutSelect, executor.executeTool, "/project", "rpc"),
    );
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(uiWithoutSelect, executor.executeTool, "/project", "rpc"),
    );
    assert.equal(calls.confirmations.length, 2);
    assert.equal(executor.commands.length, 2);
  });

  it("uses confirm when select is unavailable in TUI mode", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ confirm: true });
    const uiWithoutSelect: ApprovalUI = { confirm: ui.confirm, input: ui.input };
    const executor = recordingExecutor();
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(uiWithoutSelect, executor.executeTool),
    );
    assert.equal(calls.confirmations.length, 1);
    assert.equal(executor.commands.length, 1);
  });

  it("UI を持たない環境では承認できず fail-closed になる", async () => {
    const tool = captureTool();
    const executor = recordingExecutor();
    const context = {
      cwd: "/project",
      hasUI: false,
      mode: "tui",
      executeTool: executor.executeTool,
    };
    await assert.rejects(
      async () => tool.execute("t", request, undefined, undefined, context),
      /requires interactive approval/,
    );
    assert.equal(executor.commands.length, 0);
  });

  it("uses the standard select with the four approval labels and cancellation signal", async () => {
    const tool = captureTool();
    const controller = new AbortController();
    const { ui, calls } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    await tool.execute(
      "t",
      request,
      controller.signal,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    assert.deepEqual(calls.selections, [
      {
        title: "Allow creating a new main-agent session?\nprompt: fix the failing build",
        options: [
          "Allow once",
          "Allow in this turn",
          "Allow in this session",
          "No, deny (reason next)",
        ],
        signal: controller.signal,
      },
    ]);
    assert.equal(calls.confirmations.length, 0);
  });

  it("offers the four approval choices in RPC mode", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "session" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool, "/project", "rpc");
    await tool.execute("t", request, undefined, undefined, context);
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selections.length, 1);
    assert.equal(calls.confirmations.length, 0);
    assert.equal(executor.commands.length, 2);
  });

  it("shows the specified resolved cwd and an 80-character preview", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    const prompt = "x".repeat(80) + "\nnot in the preview";
    await tool.execute(
      "t",
      { prompt, cwd: "sub/dir" },
      undefined,
      undefined,
      mockContext(ui, executor.executeTool, "/repo"),
    );
    assert.equal(
      calls.selections[0]?.title,
      `Allow creating a new main-agent session?\nprompt: ${"x".repeat(80)}\ncwd: /repo/sub/dir`,
    );
    const script = parse(executor.commands[0]!)[2] as string;
    const tokens = parse(script);
    assert.equal(tokens.at(-1), prompt);
  });

  it("treats selection cancellation as denial and requests an optional reason", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({});
    const executor = recordingExecutor();
    const result = await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    assert.deepEqual(result.structuredContent, {
      status: "denied",
      error: "mainagent denied by user",
    });
    assert.deepEqual(calls.inputTitles, ["Denied. Optional reason for the agent:"]);
    assert.equal(executor.commands.length, 0);
  });

  it("does not require a reason input dialog for denial", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "deny" });
    const executor = recordingExecutor();
    const result = await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext({ confirm: ui.confirm, select: ui.select }, executor.executeTool),
    );
    assert.equal(result.structuredContent.status, "denied");
    assert.equal(executor.commands.length, 0);
  });

  for (const reason of ["", "   ", undefined]) {
    it(`treats an empty or cancelled reason as no reason: ${JSON.stringify(reason)}`, async () => {
      const tool = captureTool();
      const { ui } = approvalUi({ dialog: "deny", input: reason });
      const executor = recordingExecutor();
      const result = await tool.execute(
        "t",
        request,
        undefined,
        undefined,
        mockContext(ui, executor.executeTool),
      );
      assert.equal(result.structuredContent.error, "mainagent denied by user");
      assert.equal(executor.commands.length, 0);
    });
  }

  it("does not retain a denied choice for the next invocation", async () => {
    const tool = captureTool();
    const executor = recordingExecutor();
    const denied = approvalUi({ dialog: "deny" });
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(denied.ui, executor.executeTool),
    );
    const allowed = approvalUi({ dialog: "once" });
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(allowed.ui, executor.executeTool),
    );
    assert.equal(allowed.calls.selections.length, 1);
    assert.equal(executor.commands.length, 1);
  });
});

describe("interrupted approval", () => {
  it("passes cancellation to the reason input and stops an aborted denial", async () => {
    const tool = captureTool();
    const controller = new AbortController();
    const pendingReason = Promise.withResolvers<string | undefined>();
    const { ui, calls } = approvalUi({ dialog: "deny", input: pendingReason.promise });
    const executor = recordingExecutor();
    const reasonStarted = Promise.withResolvers<void>();
    const context = mockContext(
      {
        ...ui,
        async input(title, placeholder, options) {
          const pending = ui.input!(title, placeholder, options);
          reasonStarted.resolve();
          return pending;
        },
      },
      executor.executeTool,
    );
    const pending = tool.execute("t", request, controller.signal, undefined, context);
    await reasonStarted.promise;
    controller.abort();
    pendingReason.resolve("reason after abort");
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(calls.inputSignals, [controller.signal]);
    assert.equal(executor.commands.length, 0);
  });

  it("passes cancellation to the confirm fallback without executing", async () => {
    const tool = captureTool();
    const controller = new AbortController();
    const { ui, calls } = approvalUi({ confirm: true });
    const executor = recordingExecutor();
    const context = mockContext(
      {
        async confirm(title, message, options) {
          const pending = ui.confirm(title, message, options);
          controller.abort();
          return pending;
        },
      },
      executor.executeTool,
    );
    await assert.rejects(tool.execute("t", request, controller.signal, undefined, context), {
      name: "AbortError",
    });
    assert.equal(calls.confirmations[0]?.signal, controller.signal);
    assert.equal(executor.commands.length, 0);
  });

  for (const answer of ["once", "turn", "session"] as const) {
    it(`does not execute or retain approval after aborting ${answer}`, async () => {
      const tool = captureTool();
      const controller = new AbortController();
      const pendingAnswer = Promise.withResolvers<ApprovalAnswer>();
      const { ui, calls } = approvalUi({ dialog: pendingAnswer.promise });
      const executor = recordingExecutor();
      const context = mockContext(ui, executor.executeTool);
      const pending = tool.execute("t", request, controller.signal, undefined, context);
      controller.abort();
      pendingAnswer.resolve(answer);
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(executor.commands.length, 0);
      await tool.execute("t", request, undefined, undefined, context);
      assert.equal(calls.selections.length, 2);
      assert.equal(executor.commands.length, 1);
    });
  }

  it("does not call bash when aborted between approval and execution", async () => {
    const tool = captureTool();
    const controller = new AbortController();
    const executor = recordingExecutor();
    const { ui } = approvalUi({
      dialog: new Promise<ApprovalAnswer>((resolve) => {
        queueMicrotask(() => {
          controller.abort();
          resolve("once");
        });
      }),
    });
    await assert.rejects(
      tool.execute(
        "t",
        request,
        controller.signal,
        undefined,
        mockContext(ui, executor.executeTool),
      ),
      { name: "AbortError" },
    );
    assert.equal(executor.commands.length, 0);
  });

  it("does not show approval or execute when already aborted", async () => {
    const tool = captureTool();
    const controller = new AbortController();
    controller.abort();
    const { ui, calls } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    await assert.rejects(
      tool.execute(
        "t",
        request,
        controller.signal,
        undefined,
        mockContext(ui, executor.executeTool),
      ),
      { name: "AbortError" },
    );
    assert.equal(calls.selections.length, 0);
    assert.equal(executor.commands.length, 0);
  });

  it("passes cancellation to the registered bash", async () => {
    const tool = captureTool();
    const controller = new AbortController();
    const signals: unknown[] = [];
    const { ui } = approvalUi({ dialog: "once" });
    const context = mockContext(
      ui,
      async (_name: string, _args: unknown, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        return bashOutcome();
      },
    );
    await tool.execute("t", request, controller.signal, undefined, context);
    assert.deepEqual(signals, [controller.signal]);
  });
});

describe("turn 承認の失効", () => {
  it("input イベントで turn 承認が失効し、次の呼び出しは再確認する", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const { ui, calls } = approvalUi({ dialog: "turn" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool);
    await tool.execute("t", request, undefined, undefined, context);
    await handlers.get("input")!({ source: "interactive" });
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selections.length, 2);
  });

  it("ユーザーの message_start で turn 承認が失効する", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const { ui, calls } = approvalUi({ dialog: "turn" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool);
    await tool.execute("t", request, undefined, undefined, context);
    await handlers.get("message_start")!({ message: { role: "user" } });
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selections.length, 2);
  });

  it("assistant と toolResult のメッセージでは失効しない", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const { ui, calls } = approvalUi({ dialog: "turn" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool);
    await tool.execute("t", request, undefined, undefined, context);
    await handlers.get("message_start")!({ message: { role: "assistant" } });
    await handlers.get("message_start")!({ message: { role: "toolResult" } });
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selections.length, 1);
  });

  it("session 承認は input イベントの後も有効である", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const { ui, calls } = approvalUi({ dialog: "session" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool);
    await tool.execute("t", request, undefined, undefined, context);
    await handlers.get("input")!({ source: "interactive" });
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selections.length, 1);
  });

  it("ダイアログ表示中に失効した turn 回答を拒否する", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const answer = Promise.withResolvers<ApprovalAnswer>();
    const { ui } = approvalUi({ dialog: answer.promise });
    const executor = recordingExecutor();
    const pending = tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    await handlers.get("input")!({ source: "interactive" });
    answer.resolve("turn");
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Turn approval expired/);
    assert.equal(executor.commands.length, 0);
  });
});

describe("呼び出し元の制限", () => {
  it(
    "main 以外の agent からの呼び出しを拒否する",
    withAgentName("senior", async () => {
      const tool = captureTool();
      const { ui } = approvalUi({ dialog: "once" });
      const executor = recordingExecutor();
      await assert.rejects(
        async () =>
          tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool)),
        /restricted to the main agent/,
      );
      assert.equal(executor.commands.length, 0);
    }),
  );

  it(
    "agent 名が未設定の環境でも拒否する",
    withAgentName(undefined, async () => {
      const tool = captureTool();
      const { ui } = approvalUi({ dialog: "once" });
      const executor = recordingExecutor();
      await assert.rejects(
        async () =>
          tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool)),
        /restricted to the main agent/,
      );
    }),
  );
});

describe("実行", () => {
  it("calls the registered bash once and keeps the CLI identity and connection guidance", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    const result = await tool.execute(
      "t",
      { prompt: "fix it", cwd: "/repo" },
      undefined,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    assert.equal(executor.commands.length, 1);
    const script = parse(executor.commands[0]!)[2] as string;
    assert.ok(script.includes("pi-mux new --detached"));
    assert.ok(script.includes("XDG_RUNTIME_DIR="));
    assert.equal(result.structuredContent.status, "created");
    assert.deepEqual(result.structuredContent, { status: "created" });
    assert.equal(result.content[0].text.includes("window"), false);
    assert.ok(result.content[0].text.includes("Pi session fixture-id"));
    assert.ok(
      result.content[0].text.includes("Attach with: tmux -S fixture.sock attach-session -t $7"),
    );
  });

  it("passes an exact --detached prompt through the registered bash", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    const input = { prompt: "--detached" };
    assert.equal(validateInput(input), undefined);
    const result = await tool.execute(
      "t",
      input,
      undefined,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    assert.equal(executor.commands.length, 1);
    const script = parse(executor.commands[0]!)[2] as string;
    const tokens = parse(script);
    assert.deepEqual(tokens.slice(tokens.indexOf("exec")), [
      "exec",
      "pi-mux",
      "new",
      "--detached",
      "--detached",
    ]);
    assert.deepEqual(result.structuredContent, { status: "created" });
  });

  it("uses ctx.cwd when cwd is omitted without generating a window name", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    const result = await tool.execute(
      "t",
      { prompt: "fix it" },
      undefined,
      undefined,
      mockContext(ui, executor.executeTool, "/from/ctx"),
    );
    assert.ok((parse(executor.commands[0]!)[2] as string).includes("cd -- /from/ctx"));
    assert.deepEqual(result.structuredContent, { status: "created" });
    assert.equal(Object.hasOwn(result.structuredContent, "window"), false);
  });

  it("相対 cwd を ctx.cwd 基準で絶対パスに解決する", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    await tool.execute(
      "t",
      { prompt: "fix it", cwd: "sub/dir" },
      undefined,
      undefined,
      mockContext(ui, executor.executeTool, "/base/cwd"),
    );
    assert.ok(
      (parse(executor.commands[0]!)[2] as string).includes("cd -- /base/cwd/sub/dir"),
      `resolved cwd missing: ${executor.commands[0]}`,
    );
  });

  it("reports command errors without requiring a prestarted service", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "once" });
    const executeTool: ExecuteTool = async () => bashOutcome(94, "tmux failed");
    const result = await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executeTool),
    );
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "error");
    assert.equal(Object.hasOwn(result.structuredContent, "window"), false);
    assert.match(result.content[0].text, /tmux command failed/);
    assert.equal(result.content[0].text.includes("systemctl"), false);
  });

  it("uses the bash registered in each execution context", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "session" });
    const first = recordingExecutor();
    const second = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, first.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, second.executeTool));
    assert.equal(first.commands.length, 1);
    assert.equal(second.commands.length, 1);
  });

  it("tmux コマンドの失敗をエラーとして返す", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "once" });
    const executeTool: ExecuteTool = async () => bashOutcome(1, "tmux: unknown command");
    const result = await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executeTool),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /tmux command failed/);
    assert.match(result.content[0].text, /tmux: unknown command/);
  });

  it("bash の拒否・失敗をエラーとして扱う", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ dialog: "once" });
    const executeTool: ExecuteTool = async () => ({
      isError: true,
      result: bashOutcome(0, "Command denied by user").result,
    });
    const result = await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executeTool),
    );
    assert.equal(result.isError, true);
  });
});
