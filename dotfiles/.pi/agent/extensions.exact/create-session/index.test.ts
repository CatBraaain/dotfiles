import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { parse } from "shell-quote";
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

type ExecuteTool = (name: string, args: unknown) => Promise<{
  isError: boolean;
  result: { content: { type: string; text: string }[]; isError: boolean; structuredContent: unknown };
}>;

type CapturedHandlers = Map<string, (event: any, context?: any) => unknown>;

function captureTool(handlers?: CapturedHandlers, now = () => new Date("2026-10-24T10:30:45")): any {
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

function approvalUi(answer: { select?: string | Promise<string>; confirm?: boolean; input?: string }): {
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

function withAgentName(name: string | undefined, test: () => Promise<void> | void): () => Promise<void> {
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

describe("tmux コマンドの構築", () => {
  it("keeper 確認・new-window・new-session フォールバックを1コマンドにまとめる", () => {
    const command = buildTmuxCommand({ initialRequest: "fix it", cwd: "/repo", name: "main-1030" });
    const lines = command.split("\n");
    assert.equal(lines.length, 6);
    assert.match(lines[0]!, /tmux has-session -t _keeper/);
    assert.match(lines[0]!, /\|\| exit 94/);
    assert.match(lines[1]!, /tmux has-session -t pi/);
    assert.match(lines[2]!, /tmux new-window -d -t pi: -n main-1030 -- bash -lc /);
    assert.match(lines[3]!, /^else$/);
    assert.match(lines[4]!, /tmux new-session -d -s pi -n main-1030 -- bash -lc /);
    assert.match(lines[5]!, /^fi$/);
  });

  it("全 tmux 呼び出しに TMUX_TMPDIR を前置する", () => {
    const command = buildTmuxCommand({ initialRequest: "x", cwd: "/r", name: "w" });
    const tmuxLines = command.split("\n").filter((line) => line.includes("tmux "));
    assert.equal(tmuxLines.length, 4);
    for (const line of tmuxLines)
      assert.match(line, /TMUX_TMPDIR="\$\{XDG_RUNTIME_DIR:-\/run\/user\/\$\(id -u\)\}" tmux/);
  });

  it("初期依頼を1つの引用付き引数として pi に渡す", () => {
    const command = buildTmuxCommand({ initialRequest: "fix it", cwd: "/repo", name: "w" });
    assert.ok(
      command.includes(`bash -lc "cd -- /repo && pi --agent main -- 'fix it'"`),
      `window command is a single quoted word: ${command}`,
    );
  });

  it("引用文字とコマンド置換を含む初期依頼が、展開されずに1引数として残る", () => {
    const initialRequest = "it's $(x) \"z\"";
    const command = buildTmuxCommand({ initialRequest, cwd: "/dir with space", name: "w" });
    const windowLine = command.split("\n").find((line) => line.includes("new-window"))!;
    const bashArgument = parse(windowLine).at(-1) as string;
    const piArguments = parse(bashArgument).filter((token) => typeof token === "string");
    assert.equal(piArguments.at(-1), initialRequest);
  });

  it("バッククォートを含む初期依頼もシェルとして妥当な1コマンドになる", () => {
    const command = buildTmuxCommand({
      initialRequest: "it's $(x) `y` \"z\"",
      cwd: "/dir with space",
      name: "w",
    });
    const syntax = spawnSync("bash", ["-n", "-c", command]);
    assert.equal(syntax.status, 0, `bash -n failed: ${syntax.stderr}`);
  });
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
    assert.match(executor.commands[0]!, /tmux has-session -t _keeper/);
    assert.match(executor.commands[0]!, /pi --agent main/);
    assert.equal(result.structuredContent.status, "created");
    assert.equal(result.structuredContent.window, "main-1");
    assert.match(result.content[0].text, /tmux attach -t pi/);
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

  it("keeper がいない終了コード94をサーバー未起動の案内に変える", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "Allow once" });
    const executeTool: ExecuteTool = async () => bashOutcome(94, "no server");
    const result = await tool.execute(
      "t",
      request,
      undefined,
      undefined,
      mockContext(ui, executeTool),
    );
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "error");
    assert.match(result.content[0].text, /tmux server is not running/);
    assert.match(result.content[0].text, /systemctl --user enable --now tmux-server/);
  });

  it("tmux コマンドの失敗をエラーとして返す", async () => {
    const tool = captureTool();
    const { ui } = approvalUi({ select: "Allow once" });
    const executeTool: ExecuteTool = async () =>
      bashOutcome(1, "tmux: unknown command");
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
