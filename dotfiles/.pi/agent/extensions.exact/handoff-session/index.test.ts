import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import handoffSessionExtension, { HANDOFF_SESSION_COMMAND_NAME } from "./index";

interface ToolDefinition {
  name: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: { reason?: unknown; handoff?: unknown },
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

interface CommandDefinition {
  handler: (args: string, ctx: CommandContextMock) => Promise<void>;
}

interface SentUserMessage {
  content: string;
  options: { deliverAs?: string; expandPromptTemplates?: boolean };
}

interface CapturedExtension {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandDefinition>;
  sentUserMessages: SentUserMessage[];
}

function captureExtension(): CapturedExtension {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const sentUserMessages: SentUserMessage[] = [];
  handoffSessionExtension({
    registerTool: (definition: ToolDefinition) => {
      tools.set(definition.name, definition);
    },
    registerCommand: (name: string, definition: CommandDefinition) => {
      commands.set(name, definition);
    },
    sendUserMessage: (content: string, options: SentUserMessage["options"]) => {
      sentUserMessages.push({ content, options });
    },
  } as never);
  return { tools, commands, sentUserMessages };
}

async function runTool(
  captured: CapturedExtension,
  params: { reason?: unknown; handoff?: unknown },
): Promise<{ text: string; isError?: boolean }> {
  const result = await captured.tools.get("handoff_session")!.execute("tool-1", params);
  return { text: result.content.map((part) => part.text).join(""), isError: result.isError };
}

describe("登録", () => {
  it("handoff_session ツールと内部コマンドを1つずつ登録する", () => {
    const captured = captureExtension();
    assert.deepEqual([...captured.tools.keys()], ["handoff_session"]);
    assert.deepEqual([...captured.commands.keys()], [HANDOFF_SESSION_COMMAND_NAME]);
  });

  it("ツールに日本語の誘導文 promptGuidelines を1件持つ", () => {
    const captured = captureExtension();
    const guidelines = captured.tools.get("handoff_session")!.promptGuidelines;
    assert.equal(guidelines?.length, 1);
    assert.match(guidelines![0]!, /handoff_session を使う/);
  });
});

describe("ツールの入力検証", () => {
  const invalidCases: { title: string; params: { reason?: unknown; handoff?: unknown } }[] = [
    { title: "reason と handoff の両方が欠落する", params: {} },
    { title: "reason が欠落する", params: { handoff: "next" } },
    { title: "handoff が欠落する", params: { reason: "done" } },
    { title: "reason が文字列でない", params: { reason: 1, handoff: "next" } },
    { title: "handoff が文字列でない", params: { reason: "done", handoff: null } },
    { title: "reason が空文字列", params: { reason: "", handoff: "next" } },
    { title: "handoff が空文字列", params: { reason: "done", handoff: "" } },
    { title: "reason が空白だけ", params: { reason: "  ", handoff: "next" } },
    { title: "handoff が空白だけ", params: { reason: "done", handoff: " \n " } },
  ];

  for (const { title, params } of invalidCases) {
    it(`${title}とき、エラーを返しセッション移行を予約しない`, async () => {
      const captured = captureExtension();
      const result = await runTool(captured, params);
      assert.equal(result.isError, true);
      assert.deepEqual(captured.sentUserMessages, []);
    });
  }
});

describe("ツールの移行予約", () => {
  it("有効な入力のとき、エラーでない応答を返す", async () => {
    const captured = captureExtension();
    const result = await runTool(captured, {
      reason: "context full",
      handoff: "continue the work",
    });
    assert.equal(result.isError, undefined);
  });

  it("有効な入力のとき、followUp でプロンプトテンプレート展開つきのユーザーメッセージを1件予約する", async () => {
    const captured = captureExtension();
    await runTool(captured, { reason: "done", handoff: "next" });
    assert.equal(captured.sentUserMessages.length, 1);
    const sent = captured.sentUserMessages[0]!;
    assert.equal(sent.options.deliverAs, "followUp");
    assert.equal(sent.options.expandPromptTemplates, true);
  });

  it("reason と handoff を符号化して内部コマンド引数へ渡す", async () => {
    const captured = captureExtension();
    await runTool(captured, {
      reason: "phase 1 done",
      handoff: "continue with spec at /tmp/a b.md",
    });
    const sent = captured.sentUserMessages[0]!;
    assert.ok(sent.content.startsWith(`/${HANDOFF_SESSION_COMMAND_NAME} `));
    const commandArgs = sent.content.slice(`/${HANDOFF_SESSION_COMMAND_NAME} `.length);
    const [encodedReason, ...encodedHandoff] = commandArgs.split(" ");
    assert.equal(decodeURIComponent(encodedReason!), "phase 1 done");
    assert.equal(
      decodeURIComponent(encodedHandoff!.join(" ")),
      "continue with spec at /tmp/a b.md",
    );
  });

  it("前後の空白を trim して渡す", async () => {
    const captured = captureExtension();
    await runTool(captured, { reason: "  done  ", handoff: "\n next prompt \t" });
    const commandArgs = captured.sentUserMessages[0]!.content.slice(
      `/${HANDOFF_SESSION_COMMAND_NAME} `.length,
    );
    const [encodedReason, ...encodedHandoff] = commandArgs.split(" ");
    assert.equal(decodeURIComponent(encodedReason!), "done");
    assert.equal(decodeURIComponent(encodedHandoff!.join(" ")), "next prompt");
  });
});

interface CommandContextMock {
  hasUI: boolean;
  ui: {
    confirm: (title: string, message: string) => Promise<boolean>;
    notify: (message: string, level: string) => void;
  };
  newSession: (options: {
    parentSession?: string;
    setup?: unknown;
    withSession?: (ctx: {
      sendUserMessage: (text: string) => Promise<void>;
      ui: { notify: (message: string, level: string) => void };
    }) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
}

interface CommandInvocation {
  confirmCalls: number;
  confirmMessage: string;
  newSessionCalls: number;
  newSessionOptionsList: CommandContextMock["newSession"] extends (options: infer O) => unknown
    ? O[]
    : never[];
  sentToNewSession: string[];
  notifies: { message: string; level: string }[];
}

async function runCommand(
  captured: CapturedExtension,
  args: string,
  overrides: {
    approved?: boolean;
    hasUI?: boolean;
    newSessionError?: Error;
    sendError?: Error;
  } = {},
): Promise<CommandInvocation> {
  const approved = overrides.approved ?? true;
  const hasUI = overrides.hasUI ?? true;
  const invocation: CommandInvocation = {
    confirmCalls: 0,
    confirmMessage: "",
    newSessionCalls: 0,
    newSessionOptionsList: [],
    sentToNewSession: [],
    notifies: [],
  };
  const command = captured.commands.get(HANDOFF_SESSION_COMMAND_NAME);
  assert.ok(command);
  const ctx: CommandContextMock = {
    hasUI,
    ui: {
      confirm: async (_title: string, message: string) => {
        invocation.confirmCalls++;
        invocation.confirmMessage = message;
        return approved;
      },
      notify: (message: string, level: string) => {
        invocation.notifies.push({ message, level });
      },
    },
    newSession: async (options) => {
      invocation.newSessionCalls++;
      invocation.newSessionOptionsList.push(options);
      if (overrides.newSessionError) throw overrides.newSessionError;
      if (options.withSession) {
        await options.withSession({
          sendUserMessage: async (text: string) => {
            if (overrides.sendError) throw overrides.sendError;
            invocation.sentToNewSession.push(text);
          },
          ui: {
            notify: (message: string, level: string) => {
              invocation.notifies.push({ message, level });
            },
          },
        });
      }
      return { cancelled: false };
    },
  };
  await command.handler(args, ctx);
  return invocation;
}

function encodeArgs(reason: string, handoff: string): string {
  return `${encodeURIComponent(reason)} ${encodeURIComponent(handoff)}`;
}

describe("コマンドの入力検証", () => {
  it("ペイロードが解読できないとき、エラー表示し newSession を呼ばない", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, "not-a-payload");
    assert.equal(invocation.newSessionCalls, 0);
    assert.equal(invocation.notifies.filter((n) => n.level === "error").length, 1);
  });

  it("ペイロードの値が空になるとき、エラー表示し newSession を呼ばない", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, encodeArgs("  ", "next"));
    assert.equal(invocation.newSessionCalls, 0);
    assert.equal(invocation.notifies.filter((n) => n.level === "error").length, 1);
  });
});

describe("確認ダイアログ", () => {
  it("対話UIを利用できないとき、エラー表示し newSession を呼ばない", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, encodeArgs("done", "next"), { hasUI: false });
    assert.equal(invocation.confirmCalls, 0);
    assert.equal(invocation.newSessionCalls, 0);
    assert.equal(invocation.notifies.filter((n) => n.level === "error").length, 1);
  });

  it("reason と handoff をダイアログに表示する", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, encodeArgs("phase done", "next steps"));
    assert.equal(invocation.confirmCalls, 1);
    assert.ok(invocation.confirmMessage.includes("phase done"));
    assert.ok(invocation.confirmMessage.includes("next steps"));
  });

  it("オーナーが拒否したとき、newSession を呼ばず現在のセッションを維持する", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, encodeArgs("done", "next"), { approved: false });
    assert.equal(invocation.newSessionCalls, 0);
  });
});

describe("セッション移行", () => {
  it("承認されたとき、parentSession と setup を指定せずに新セッションを開始する", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, encodeArgs("done", "next"));
    assert.equal(invocation.newSessionCalls, 1);
    const options = invocation.newSessionOptionsList[0]!;
    assert.equal(options.parentSession, undefined);
    assert.equal(options.setup, undefined);
  });

  it("新セッション開始後、handoff を内容を変えずに初回プロンプトとして送信する", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, encodeArgs("done", "continue the work"));
    assert.deepEqual(invocation.sentToNewSession, ["continue the work"]);
  });

  it("初回プロンプトの送信に失敗したとき、新セッション側でエラー表示する", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, encodeArgs("done", "next"), {
      sendError: new Error("no model"),
    });
    assert.equal(invocation.newSessionCalls, 1);
    const errors = invocation.notifies.filter((n) => n.level === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.message.includes("no model"));
  });

  it("セッション移行が拒否されたとき、エラー表示し現在のセッションを維持する", async () => {
    const captured = captureExtension();
    // withSession は newSession が cancelled を返すときは実行されない想定のため、
    // cancelled を返すモックで withSession を渡さない
    const command = captured.commands.get(HANDOFF_SESSION_COMMAND_NAME)!;
    const notifies: { message: string; level: string }[] = [];
    await command.handler(encodeArgs("done", "next"), {
      hasUI: true,
      ui: {
        confirm: async () => true,
        notify: (message: string, level: string) => notifies.push({ message, level }),
      },
      newSession: async () => ({ cancelled: true }),
    } as unknown as CommandContextMock);
    assert.equal(notifies.filter((n) => n.level === "error").length, 1);
  });

  it("セッション移行が失敗したとき、エラー表示し現在のセッションを維持する", async () => {
    const captured = captureExtension();
    const invocation = await runCommand(captured, encodeArgs("done", "next"), {
      newSessionError: new Error("switch failed"),
    });
    assert.equal(invocation.newSessionCalls, 1);
    const errors = invocation.notifies.filter((n) => n.level === "error");
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.message.includes("switch failed"));
  });
});
