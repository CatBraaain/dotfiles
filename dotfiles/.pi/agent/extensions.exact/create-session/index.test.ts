import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { parse } from "shell-quote";
import { attachCommand, getTmuxPaths, PARENT_PI_ENV_KEYS } from "../tmux-handoff/shared.ts";
import createSessionExtension, {
  autoWindowName,
  buildTmuxCommand,
  validateInput,
  type CreateSessionInput,
} from "./index";

type ApprovalUI = {
  confirm(title: string, message: string): Promise<boolean>;
  select?(title: string, options: string[]): Promise<string | undefined>;
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

function captureTool(
  handlers?: CapturedHandlers,
  now = () => new Date("2026-10-24T10:30:45"),
): any {
  const tools: any[] = [];
  createSessionExtension(
    {
      registerTool: (tool: any) => tools.push(tool),
      on: (event: string, handler: (event: any, context?: any) => unknown) =>
        handlers?.set(event, handler),
    } as any,
    { now },
  );
  assert.equal(tools.length, 1);
  return tools[0];
}

function bashOutcome(exitCode = 0, output = "") {
  return {
    isError: exitCode !== 0,
    result: {
      content: [{ type: "text", text: output }],
      isError: exitCode !== 0,
      structuredContent: { output, exit_code: exitCode, truncated: false },
    },
  };
}

type UiCalls = { selectTitles: string[]; confirmCount: number; inputTitles: string[] };

function approvalUi(answer: {
  select?: string | Promise<string>;
  confirm?: boolean;
  input?: string;
}): {
  ui: ApprovalUI;
  calls: UiCalls;
} {
  const calls: UiCalls = { selectTitles: [], confirmCount: 0, inputTitles: [] };
  return {
    calls,
    ui: {
      async select(title: string) {
        calls.selectTitles.push(title);
        const answerValue = answer.select;
        return typeof answerValue === "string" ? answerValue : await answerValue;
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

function mockContext(ui: ApprovalUI, executeTool: ExecuteTool, cwd = "/project"): any {
  return { cwd, hasUI: true, ui, executeTool };
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

const request: CreateSessionInput = { initialRequest: "fix the failing build" };

const previousAgentName = process.env.PI_AGENT_NAME;
beforeAll(() => {
  process.env.PI_AGENT_NAME = "main";
});
afterAll(() => {
  if (previousAgentName === undefined) delete process.env.PI_AGENT_NAME;
  else process.env.PI_AGENT_NAME = previousAgentName;
});

describe("入力の検証", () => {
  it("空白の initialRequest を拒否する", () => {
    assert.match(validateInput({ initialRequest: "  " })!, /initialRequest must not be empty/);
  });

  it("NUL を含む initialRequest を拒否する", () => {
    assert.match(validateInput({ initialRequest: "a\0b" })!, /cannot contain NUL/);
  });

  it("空白の name を拒否する", () => {
    assert.match(validateInput({ initialRequest: "x", name: " " })!, /name must not be blank/);
  });

  it("tmux ターゲット区切りの : と . を含む name を拒否する", () => {
    assert.match(validateInput({ initialRequest: "x", name: "a:b" })!, /cannot contain/);
    assert.match(validateInput({ initialRequest: "x", name: "a.b" })!, /cannot contain/);
  });

  it("正常な入力を通す", () => {
    assert.equal(validateInput({ initialRequest: "x", name: "main-1", cwd: "/tmp" }), undefined);
  });
});

describe("ウィンドウ名の自動採番", () => {
  it("main-HHMMSS 形式で採番する", () => {
    assert.equal(autoWindowName(new Date("2026-10-24T09:05:07")), "main-090507");
  });
});

describe("dedicated tmux commands", () => {
  it("uses shared socket and config paths for every tmux operation", () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: "/isolated runtime" });
    const command = buildTmuxCommand(
      { initialRequest: "fix it", cwd: "/repo", name: "main-1030" },
      paths,
    );
    const tokens = parse(command);
    const tmuxIndices = tokens.flatMap((token, index) => (token === "tmux" ? [index] : []));
    assert.equal(tmuxIndices.length, 3);
    for (const index of tmuxIndices)
      assert.deepEqual(tokens.slice(index + 1, index + 5), [
        "-S",
        paths.socketPath,
        "-f",
        paths.configPath,
      ]);
    assert.equal(command.includes("TMUX_TMPDIR"), false);
    assert.equal(command.includes("_keeper"), false);
  });

  it("creates a detached session or a detached window in the exact pi session", () => {
    const command = buildTmuxCommand({ initialRequest: "x", cwd: "/r", name: "w" });
    const tokens = parse(command);
    const sessionIndex = tokens.indexOf("new-session");
    const windowIndex = tokens.indexOf("new-window");
    const probeIndex = tokens.indexOf("has-session");
    assert.deepEqual(tokens.slice(probeIndex + 1, probeIndex + 3), ["-t", "=pi"]);
    assert.deepEqual(tokens.slice(sessionIndex + 1, sessionIndex + 6), [
      "-d",
      "-s",
      "pi",
      "-n",
      "w",
    ]);
    assert.deepEqual(tokens.slice(windowIndex + 1, windowIndex + 6), [
      "-d",
      "-t",
      "=pi:",
      "-n",
      "w",
    ]);
    assert.equal(tokens.includes("attach-session"), false);
    assert.equal(tokens.includes("switch-client"), false);
    assert.match(command, /^mkdir -p -m 700 -- /);
  });

  it("removes parent pi state without replacing the new PTY environment", () => {
    const paths = getTmuxPaths({ XDG_RUNTIME_DIR: "/isolated runtime" });
    const command = buildTmuxCommand({ initialRequest: "x", cwd: "/r", name: "w" }, paths);
    const tokens = parse(command);
    const script = tokens[tokens.indexOf("bash") + 2] as string;
    const paneTokens = parse(script);
    const unsetIndex = paneTokens.indexOf("unset");
    assert.deepEqual(paneTokens.slice(unsetIndex + 1, unsetIndex + 1 + PARENT_PI_ENV_KEYS.length), [
      ...PARENT_PI_ENV_KEYS,
    ]);
    assert.ok(paneTokens.includes("XDG_RUNTIME_DIR=/isolated runtime"));
    assert.equal(script.includes("unset TMUX"), false);
    assert.equal(script.includes("unset TERM"), false);
    assert.deepEqual(paneTokens.slice(paneTokens.indexOf("exec")), [
      "exec",
      "pi",
      "--agent",
      "main",
      "--",
      "x",
    ]);
  });

  for (const initialRequest of [
    "fix it",
    'it\'s $(x) `y` "z"',
    "--session option-like\nnext line",
  ]) {
    it(`preserves a literal request argument: ${JSON.stringify(initialRequest)}`, () => {
      const cwd = "/dir with space/quote's\nnext line";
      const command = buildTmuxCommand({ initialRequest, cwd, name: "w" });
      const outer = spawnSync("bash", [
        "-c",
        [
          "mkdir() { :; }",
          'tmux() { if [ "$5" = has-session ]; then return 1; fi; printf \'%s\\0\' "$@"; }',
          command,
        ].join("\n"),
      ]);
      assert.equal(outer.status, 0, String(outer.stderr));
      const tmuxArguments = outer.stdout.toString().split("\0").slice(0, -1);
      const script = tmuxArguments.at(-1)!;
      const paneTokens = parse(script);
      assert.deepEqual(
        paneTokens.slice(paneTokens.indexOf("cd") + 1, paneTokens.indexOf("cd") + 3),
        ["--", cwd],
      );
      const piCommand = script.slice(script.indexOf("exec ") + "exec ".length);
      const expanded = spawnSync("bash", ["-c", `set -- ${piCommand}\nprintf '%s\\0' "$@"`]);
      assert.equal(expanded.status, 0, String(expanded.stderr));
      const piArguments = expanded.stdout.toString().split("\0").slice(0, -1);
      assert.deepEqual(piArguments, ["pi", "--agent", "main", "--", initialRequest]);
    });
  }
});

describe("ツールの登録", () => {
  it("create_detached_session として登録し、bash に到達する", () => {
    const tool = captureTool();
    assert.equal(tool.name, "create_detached_session");
    assert.deepEqual(tool.reachesTools(), ["bash"]);
  });
});

describe("承認", () => {
  it("Allow once はその呼び出しだけを許可し、次の呼び出しは再度確認する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ select: "Allow once" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.equal(calls.selectTitles.length, 2);
    assert.equal(executor.commands.length, 2);
  });

  it("Allow in this session はセッション内の再確認を省略する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ select: "Allow in this session" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.equal(calls.selectTitles.length, 1);
    assert.equal(executor.commands.length, 3);
  });

  it("Allow in this turn は次のユーザー入力まで再確認を省略する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ select: "Allow in this turn" });
    const executor = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, executor.executeTool));
    assert.equal(calls.selectTitles.length, 1);
    assert.equal(executor.commands.length, 2);
  });

  it("Deny は理由なしで実行を中止する", async () => {
    const tool = captureTool();
    const { ui, calls } = approvalUi({ select: "No, deny (reason next)" });
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
    assert.equal(calls.selectTitles.length, 1);
  });

  it("Deny の理由入力を結果に含める", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "No, deny (reason next)", input: "too many sessions" });
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

  it("選択UIがない場合は confirm に置き換えて1回限りで許可する", async () => {
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
    await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(uiWithoutSelect, executor.executeTool),
    );
    assert.equal(calls.confirmCount, 2);
    assert.equal(executor.commands.length, 2);
  });

  it("UI を持たない環境では承認できず fail-closed になる", async () => {
    const tool = captureTool();
    const executor = recordingExecutor();
    const context = {
      cwd: "/project",
      hasUI: false,
      executeTool: executor.executeTool,
    };
    await assert.rejects(
      async () => tool.execute("t", request, undefined, undefined, context),
      /requires interactive approval/,
    );
    assert.equal(executor.commands.length, 0);
  });
});

describe("interrupted approval", () => {
  for (const answer of ["Allow once", "Allow in this turn", "Allow in this session"]) {
    it(`does not execute or retain approval after aborting ${answer}`, async () => {
      const tool = captureTool();
      const controller = new AbortController();
      const pendingAnswer = Promise.withResolvers<string>();
      const { ui, calls } = approvalUi({ select: pendingAnswer.promise });
      const executor = recordingExecutor();
      const context = mockContext(ui, executor.executeTool);
      const pending = tool.execute("t", request, controller.signal, undefined, context);
      controller.abort();
      pendingAnswer.resolve(answer);
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(executor.commands.length, 0);
      await tool.execute("t", request, undefined, undefined, context);
      assert.equal(calls.selectTitles.length, 2);
      assert.equal(executor.commands.length, 1);
    });
  }

  it("does not call bash when aborted between approval and execution", async () => {
    const tool = captureTool();
    const controller = new AbortController();
    const executor = recordingExecutor();
    const ui: ApprovalUI = {
      async confirm() {
        return false;
      },
      async select() {
        queueMicrotask(() => queueMicrotask(() => controller.abort()));
        return "Allow once";
      },
    };
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
    const { ui, calls } = approvalUi({ select: "Allow once" });
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
    assert.equal(calls.selectTitles.length, 0);
    assert.equal(executor.commands.length, 0);
  });

  it("passes cancellation to the approval dialog and registered bash", async () => {
    const tool = captureTool();
    const controller = new AbortController();
    const signals: unknown[] = [];
    const context = mockContext(
      {
        confirm: async () => false,
        select: async (_title: string, _options: string[], options?: { signal?: AbortSignal }) => {
          signals.push(options?.signal);
          return "Allow once";
        },
      } as ApprovalUI,
      async (_name: string, _args: unknown, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        return bashOutcome();
      },
    );
    await tool.execute("t", request, controller.signal, undefined, context);
    assert.deepEqual(signals, [controller.signal, controller.signal]);
  });
});

describe("turn 承認の失効", () => {
  it("input イベントで turn 承認が失効し、次の呼び出しは再確認する", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const { ui, calls } = approvalUi({ select: "Allow in this turn" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool);
    await tool.execute("t", request, undefined, undefined, context);
    await handlers.get("input")!({ source: "interactive" });
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selectTitles.length, 2);
  });

  it("ユーザーの message_start で turn 承認が失効する", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const { ui, calls } = approvalUi({ select: "Allow in this turn" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool);
    await tool.execute("t", request, undefined, undefined, context);
    await handlers.get("message_start")!({ message: { role: "user" } });
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selectTitles.length, 2);
  });

  it("assistant と toolResult のメッセージでは失効しない", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const { ui, calls } = approvalUi({ select: "Allow in this turn" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool);
    await tool.execute("t", request, undefined, undefined, context);
    await handlers.get("message_start")!({ message: { role: "assistant" } });
    await handlers.get("message_start")!({ message: { role: "toolResult" } });
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selectTitles.length, 1);
  });

  it("session 承認は input イベントの後も有効である", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const { ui, calls } = approvalUi({ select: "Allow in this session" });
    const executor = recordingExecutor();
    const context = mockContext(ui, executor.executeTool);
    await tool.execute("t", request, undefined, undefined, context);
    await handlers.get("input")!({ source: "interactive" });
    await tool.execute("t", request, undefined, undefined, context);
    assert.equal(calls.selectTitles.length, 1);
  });

  it("ダイアログ表示中に失効した turn 回答を拒否する", async () => {
    const handlers: CapturedHandlers = new Map();
    const tool = captureTool(handlers);
    const answer = Promise.withResolvers<string>();
    const { ui } = approvalUi({ select: answer.promise });
    const executor = recordingExecutor();
    const pending = tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    await handlers.get("input")!({ source: "interactive" });
    answer.resolve("Allow in this turn");
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
      const { ui } = approvalUi({ select: "Allow once" });
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
      const { ui } = approvalUi({ select: "Allow once" });
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
  it("登録済み bash を1回だけ呼び、構築したコマンドを渡す", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "Allow once" });
    const executor = recordingExecutor();
    const result = await tool.execute(
      "t",
      { initialRequest: "fix it", cwd: "/repo", name: "main-1" },
      undefined,
      undefined,
      mockContext(ui, executor.executeTool),
    );
    assert.equal(executor.commands.length, 1);
    assert.ok(executor.commands[0]!.includes(getTmuxPaths().socketPath));
    assert.match(executor.commands[0]!, /pi --agent main/);
    assert.equal(result.structuredContent.status, "created");
    assert.equal(result.structuredContent.window, "main-1");
    const reconnect = attachCommand({
      socketPath: getTmuxPaths().socketPath,
      tmuxSessionId: "=pi",
    });
    assert.ok(result.content[0].text.includes(reconnect));
  });

  it("cwd 省略時は ctx.cwd を使い、name 省略時は自動採番する", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "Allow once" });
    const executor = recordingExecutor();
    const result = await tool.execute(
      "t",
      { initialRequest: "fix it" },
      undefined,
      undefined,
      mockContext(ui, executor.executeTool, "/from/ctx"),
    );
    assert.ok(executor.commands[0]!.includes("cd -- /from/ctx"));
    assert.equal(result.structuredContent.window, "main-103045");
  });

  it("相対 cwd を ctx.cwd 基準で絶対パスに解決する", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "Allow once" });
    const executor = recordingExecutor();
    await tool.execute(
      "t",
      { initialRequest: "fix it", cwd: "sub/dir" },
      undefined,
      undefined,
      mockContext(ui, executor.executeTool, "/base/cwd"),
    );
    assert.ok(
      executor.commands[0]!.includes("cd -- /base/cwd/sub/dir"),
      `resolved cwd missing: ${executor.commands[0]}`,
    );
  });

  it("reports command errors without requiring a prestarted service", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "Allow once" });
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
    assert.match(result.content[0].text, /tmux command failed/);
    assert.equal(result.content[0].text.includes("systemctl"), false);
  });

  it("uses the bash registered in each execution context", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "Allow in this session" });
    const first = recordingExecutor();
    const second = recordingExecutor();
    await tool.execute("t", request, undefined, undefined, mockContext(ui, first.executeTool));
    await tool.execute("t", request, undefined, undefined, mockContext(ui, second.executeTool));
    assert.equal(first.commands.length, 1);
    assert.equal(second.commands.length, 1);
  });

  it("tmux コマンドの失敗をエラーとして返す", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "Allow once" });
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
    const { ui } = approvalUi({ select: "Allow once" });
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
