import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { parse } from "shell-quote";
import type { TUI } from "@earendil-works/pi-tui";
import { getTmuxPaths, PARENT_PI_ENV_KEYS } from "../pi-mux-bridge/shared.ts";
import {
  registerMainagentTool,
  buildTmuxCommand,
  validateInput,
  createApprovalDialog,
  dialogMaxRows,
  type ApprovalChoice,
  type ApprovalDialogHandle,
  type ApprovalTheme,
  type MainagentInput,
} from "./mainagent.ts";

type CustomDialogOptions = {
  overlay?: boolean;
  overlayOptions?: unknown;
};

type DialogFactory = (
  tui: TUI,
  theme: ApprovalTheme,
  keybindings: unknown,
  done: (choice: ApprovalChoice) => void,
) => ApprovalDialogHandle;

type ApprovalUI = {
  confirm(title: string, message: string): Promise<boolean>;
  custom?<T>(factory: DialogFactory, options?: CustomDialogOptions): Promise<T>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
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
const ANSWER_KEYS: Record<ApprovalAnswer, string> = {
  once: "1",
  turn: "2",
  session: "3",
  deny: "4",
};

const plainTheme: ApprovalTheme = { fg: (_token, text) => text, bold: (text) => text };
const dummyTui = { terminal: { rows: 40, columns: 120 }, requestRender() {} } as unknown as TUI;

type UiCalls = {
  dialogOptions: (CustomDialogOptions | undefined)[];
  components: ApprovalDialogHandle[];
  confirmCount: number;
  inputTitles: string[];
};

function approvalUi(answer: {
  dialog?: ApprovalAnswer | Promise<ApprovalAnswer>;
  confirm?: boolean;
  input?: string;
}): {
  ui: ApprovalUI;
  calls: UiCalls;
} {
  const calls: UiCalls = { dialogOptions: [], components: [], confirmCount: 0, inputTitles: [] };
  return {
    calls,
    ui: {
      async custom<T>(factory: DialogFactory, options?: CustomDialogOptions): Promise<T> {
        calls.dialogOptions.push(options);
        const done = Promise.withResolvers<T>();
        const component = factory(
          dummyTui,
          plainTheme,
          {},
          done.resolve as unknown as (choice: ApprovalChoice) => void,
        );
        calls.components.push(component);
        const answerValue = await answer.dialog!;
        component.handleInput(ANSWER_KEYS[answerValue]);
        return done.promise;
      },
      async confirm() {
        calls.confirmCount++;
        return answer.confirm ?? false;
      },
      async input(title: string) {
        calls.inputTitles.push(title);
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
    assert.equal(calls.dialogOptions.length, 2);
    assert.equal(executor.commands.length, 2);
  });

  it("Allow in this session はセッション内の再確認を省略する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "session" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.equal(calls.dialogOptions.length, 1);
    assert.equal(executor.commands.length, 3);
  });

  it("Allow in this turn は次のユーザー入力まで再確認を省略する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "turn" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.equal(calls.dialogOptions.length, 1);
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
    assert.equal(calls.dialogOptions.length, 1);
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
    const uiWithoutCustom: ApprovalUI = { confirm: ui.confirm, input: ui.input };
    const executor = recordingExecutor();
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(uiWithoutCustom, executor.executeTool, "/project", "rpc"),
    );
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(uiWithoutCustom, executor.executeTool, "/project", "rpc"),
    );
    assert.equal(calls.confirmCount, 2);
    assert.equal(executor.commands.length, 2);
  });

  it("TUI モードでも custom UI が無ければ confirm に置き換える", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ confirm: true });
    const uiWithoutCustom: ApprovalUI = { confirm: ui.confirm, input: ui.input };
    const executor = recordingExecutor();
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(uiWithoutCustom, executor.executeTool),
    );
    assert.equal(calls.confirmCount, 1);
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

  it("dialog は中央 overlay で開く", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ dialog: "once" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.deepEqual(calls.dialogOptions[0], {
      overlay: true,
      overlayOptions: { anchor: "center", width: "94%", maxHeight: "94%" },
    });
  });
});

describe("interrupted approval", () => {
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
      assert.equal(calls.dialogOptions.length, 2);
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
    assert.equal(calls.dialogOptions.length, 0);
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
    assert.equal(calls.dialogOptions.length, 2);
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
    assert.equal(calls.dialogOptions.length, 2);
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
    assert.equal(calls.dialogOptions.length, 1);
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
    assert.equal(calls.dialogOptions.length, 1);
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

describe("承認ダイアログ", () => {
  const WIDTH = 80;
  const DIALOG_CHROME_ROWS = 16;

  function dialogFor(
    prompt: string,
    options: { maxRows?: number; cwd?: string; signal?: AbortSignal } = {},
  ) {
    const choices: ApprovalChoice[] = [];
    const component = createApprovalDialog({
      prompt,
      cwd: options.cwd ?? "/repo",
      theme: plainTheme,
      getMaxRows: () => options.maxRows ?? 40,
      requestRender: () => {},
      done: (choice) => choices.push(choice),
      signal: options.signal,
    });
    return { component, choices };
  }

  it("prompt 全文・選択肢 1-4・cwd・ヒントを表示する", () => {
    const { component } = dialogFor("fix the failing build", { cwd: "/repo/sub" });
    const lines = component.render(WIDTH).join("\n");
    assert.ok(lines.includes("fix the failing build"));
    assert.ok(lines.includes("prompt:"));
    assert.ok(lines.includes("cwd: /repo/sub"));
    assert.ok(lines.includes("1. Allow once"));
    assert.ok(lines.includes("2. Allow in this turn"));
    assert.ok(lines.includes("3. Allow in this session"));
    assert.ok(lines.includes("4. No, deny (reason next)"));
    assert.ok(lines.includes("up/down scroll · 1-4 select · esc deny"));
    assert.equal(lines.includes("[1-"), false);
  });

  it("縦幅が足りない prompt は viewport 行に切り出して range を出す", () => {
    const prompt = Array.from({ length: 25 }, (_v, i) => `line ${i + 1}`).join("\n");
    const { component } = dialogFor(prompt, { maxRows: 40 });
    const lines = component.render(WIDTH);
    assert.equal(lines.length, DIALOG_CHROME_ROWS + 20);
    const joined = lines.join("\n");
    assert.ok(joined.includes("[1-20/25]"));
    assert.ok(joined.includes("line 1"));
    assert.equal(joined.includes("line 21"), false);
  });

  it("上下キーでスクロールし range が動く", () => {
    const prompt = Array.from({ length: 25 }, (_v, i) => `line ${i + 1}`).join("\n");
    const { component } = dialogFor(prompt, { maxRows: 40 });
    assert.ok(component.render(WIDTH).join("\n").includes("[1-20/25]"));
    component.handleInput("\x1b[A");
    assert.ok(component.render(WIDTH).join("\n").includes("[1-20/25]"));
    component.handleInput("\x1b[B");
    const scrolled = component.render(WIDTH).join("\n");
    assert.ok(scrolled.includes("[2-21/25]"));
    assert.ok(scrolled.includes("line 2"));
    component.handleInput("\x1b[H");
    assert.ok(component.render(WIDTH).join("\n").includes("[1-20/25]"));
  });

  it("数字キーで選択し、escape と 4 は deny、他のキーは無視する", () => {
    const { component, choices } = dialogFor("fix it");
    component.handleInput("x");
    component.handleInput("9");
    assert.deepEqual(choices, []);
    component.handleInput("1");
    assert.deepEqual(choices, [{ grant: "once" }]);
  });

  it("2, 3, 4, escape の回答を対応する結果に変換する", async () => {
    for (const [key, expected] of [
      ["2", { grant: "turn" }],
      ["3", { grant: "session" }],
      ["4", { denied: true }],
      ["\x1b", { denied: true }],
    ] as const) {
      const { component, choices } = dialogFor("fix it");
      component.handleInput(key);
      assert.deepEqual(choices, [expected], `key ${JSON.stringify(key)}`);
    }
  });

  it("1 度の回答の後は追加入力を無視する", () => {
    const { component, choices } = dialogFor("fix it");
    component.handleInput("1");
    component.handleInput("4");
    component.handleInput("\x1b");
    assert.deepEqual(choices, [{ grant: "once" }]);
  });

  it("wheel でスクロールする", () => {
    const prompt = Array.from({ length: 25 }, (_v, i) => `line ${i + 1}`).join("\n");
    const { component } = dialogFor(prompt, { maxRows: 40 });
    component.render(WIDTH);
    const outcome = component.handleMouse({
      type: "wheel",
      button: "none",
      x: 0,
      y: 0,
      screenX: 0,
      screenY: 0,
      width: WIDTH,
      height: 20,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 5,
    });
    assert.deepEqual(outcome, { handled: true });
    assert.ok(component.render(WIDTH).join("\n").includes("[6-25/25]"));
  });

  it("abort で閉じ、閉じた後の入力を無視する", () => {
    const controller = new AbortController();
    const { component, choices } = dialogFor("fix it", { signal: controller.signal });
    controller.abort();
    component.handleInput("1");
    assert.deepEqual(choices, [{ aborted: true }]);
  });

  it("dispose は未 abort でも安全に呼べる", () => {
    const controller = new AbortController();
    const { component, choices } = dialogFor("fix it", { signal: controller.signal });
    component.dispose();
    component.dispose();
    controller.abort();
    assert.deepEqual(choices, []);
  });

  it("dialogMaxRows はターミナル縦の 94% を下限付きで返す", () => {
    assert.equal(dialogMaxRows(40), 37);
    assert.equal(dialogMaxRows(100), 94);
    assert.equal(dialogMaxRows(4), 8);
  });
});
