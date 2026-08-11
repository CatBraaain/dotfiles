// 実行: bun --install=auto run index.test.ts
//
// new-session 拡張機能の振る舞いを検証する。
// 出典: ./SPEC.md。各 it のタイトルが要件仕様。
// 決定関数は ./index.ts の純粋関数を直接叩き、
// ツール execute と /new-session コマンドは factory をモック起動して検証する。
import assert from "node:assert/strict";
import newSessionExtension, {
  CONFIRM_DIALOG_BODY,
  CONFIRM_DIALOG_TITLE,
  NEW_SESSION_COMMAND_NAME,
  NEW_SESSION_TOOL_NAME,
  __resetPendingKickoff,
  buildAgentResultText,
  consumePendingKickoff,
  decideOnApproval,
  newSessionKickoff,
  normalizeFirstMessage,
  requestNewSession,
} from "./index";
import type { NewSessionInput, NewSessionKickoff } from "./index";

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
let group = "";

function describe(name: string, fn: () => void): void {
  const previousGroup = group;
  group = name;
  fn();
  group = previousGroup;
}

function it(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

interface Captured {
  readonly tools: Map<string, ToolDef>;
  readonly commands: Map<string, CommandDef>;
  readonly events: Set<string>;
  readonly sentMessages: { content: string; deliverAs?: string }[];
}

interface ToolDef {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: NewSessionInput,
    signal: undefined,
    onUpdate: unknown,
    ctx: ToolCtx,
  ) => Promise<ToolResult>;
}

interface CommandDef {
  handler: (args: string | undefined, ctx: CommandCtx) => Promise<void>;
}

interface ToolCtx {
  hasUI: boolean;
  ui: {
    confirm: (title: string, message: string) => Promise<boolean>;
    notify: (message: string, type?: string) => void;
  };
}

interface CommandCtx {
  ui: { notify: (message: string, type?: string) => void };
  newSession: (options: {
    parentSession?: string;
    setup?: unknown;
    withSession?: (ctx: { ui: { setEditorText: (text: string) => void } }) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: { approved: boolean; kickoff?: NewSessionKickoff };
}

function capture(): Captured {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, CommandDef>();
  const events = new Set<string>();
  const sentMessages: { content: string; deliverAs?: string }[] = [];
  newSessionExtension({
    on: (event: string) => events.add(event),
    registerTool: (tool: ToolDef) => tools.set(tool.name, tool),
    registerCommand: (name: string, def: CommandDef) => commands.set(name, def),
    sendUserMessage: (content: string, options?: { deliverAs?: string }) =>
      sentMessages.push({ content, deliverAs: options?.deliverAs }),
  } as never);
  return { tools, commands, events, sentMessages };
}

interface ToolInvocation {
  result: ToolResult;
  confirmTitle: string;
  confirmMessage: string;
  notified: string[];
}

async function invokeTool(
  captured: Captured,
  params: NewSessionInput,
  confirmResult: boolean,
): Promise<ToolInvocation> {
  let confirmTitle = "";
  let confirmMessage = "";
  const notified: string[] = [];
  const tool = captured.tools.get(NEW_SESSION_TOOL_NAME)!;
  const result = (await tool.execute(params, params, undefined, undefined, {
    hasUI: true,
    ui: {
      confirm: async (title, message) => {
        confirmTitle = title;
        confirmMessage = message;
        return confirmResult;
      },
      notify: (message) => notified.push(message),
    },
  })) as ToolResult;
  return { result, confirmTitle, confirmMessage, notified };
}

interface CommandInvocation {
  newSessionOptions: {
    parentSession?: string;
    setup?: unknown;
    withSession?: unknown;
  };
  draftInEditor: string;
  notified: string[];
  cancelled: boolean;
}

async function runCommand(
  captured: Captured,
  options: { newSessionCancelled?: boolean; args?: string } = {},
): Promise<CommandInvocation> {
  let newSessionOptions: CommandInvocation["newSessionOptions"] = {};
  let draftInEditor = "";
  const notified: string[] = [];
  const command = captured.commands.get(NEW_SESSION_COMMAND_NAME)!;
  await command.handler(options.args, {
    ui: { notify: (message) => notified.push(message) },
    newSession: async (opts) => {
      newSessionOptions = opts;
      if (opts.withSession) {
        await opts.withSession({ ui: { setEditorText: (text) => (draftInEditor = text) } });
      }
      return { cancelled: options.newSessionCancelled ?? false };
    },
  });
  return { newSessionOptions, draftInEditor, notified, cancelled: false };
}

describe("ツール一覧", () => {
  it("new_session という名前のツールを1つ登録する", () => {
    const captured = capture();
    assert.ok(captured.tools.has(NEW_SESSION_TOOL_NAME));
    assert.equal(captured.tools.size, 1);
  });

  it("new_session ツールは任意の firstMessage パラメータをとる", () => {
    const captured = capture();
    const tool = captured.tools.get(NEW_SESSION_TOOL_NAME)!;
    assert.ok("firstMessage" in (tool.parameters.properties ?? {}));
  });
});

describe("実行の流れ", () => {
  it("エージェントが new_session を呼ぶと、オーナーへ確認ダイアログを出す", async () => {
    __resetPendingKickoff();
    const captured = capture();
    const invocation = await invokeTool(captured, {}, false);
    assert.equal(invocation.confirmTitle, CONFIRM_DIALOG_TITLE);
    assert.equal(invocation.confirmMessage, CONFIRM_DIALOG_BODY);
  });

  it("承認すると、ツールが予約したコマンド経由で新セッションへの切り替えが行われる", async () => {
    __resetPendingKickoff();
    const captured = capture();
    await invokeTool(captured, { firstMessage: "開幕メッセージ" }, true);
    const queuedCommandName = captured.sentMessages[0]?.content.slice(1);
    // ツールが予約したコマンドは、切替を行うために登録されたコマンドと一致する
    assert.ok(captured.commands.has(queuedCommandName));
    const switchResult = await runCommand(captured);
    assert.equal(switchResult.draftInEditor, "開幕メッセージ");
  });

  it("拒否すると、新セッションへの切り替えを予約せず現行セッションのままにする", async () => {
    __resetPendingKickoff();
    const captured = capture();
    await invokeTool(captured, { firstMessage: "無視される" }, false);
    assert.deepEqual(captured.sentMessages, []);
    assert.equal(consumePendingKickoff().kind, "empty");
  });
});

describe("確認ダイアログ", () => {
  it("タイトルは 'Start a new session?' である", () => {
    assert.equal(CONFIRM_DIALOG_TITLE, "Start a new session?");
  });

  it("本文は 'The agent is about to start a new session. Proceed?' である", () => {
    assert.equal(CONFIRM_DIALOG_BODY, "The agent is about to start a new session. Proceed?");
  });

  it("ツールは確認ダイアログをこのタイトルと本文で表示する", async () => {
    __resetPendingKickoff();
    const captured = capture();
    const invocation = await invokeTool(captured, {}, true);
    assert.equal(invocation.confirmTitle, "Start a new session?");
    assert.equal(invocation.confirmMessage, "The agent is about to start a new session. Proceed?");
  });
});

describe("応答と結果", () => {
  it("承認したとき、結果は新セッションへの切り替えを示し、エージェントへ伝える", async () => {
    __resetPendingKickoff();
    const captured = capture();
    const invocation = await invokeTool(captured, {}, true);
    const expectedKickoff: NewSessionKickoff = { kind: "empty" };
    assert.equal(invocation.result.details.approved, true);
    assert.deepEqual(invocation.result.details.kickoff, expectedKickoff);
    assert.equal(
      invocation.result.content[0].text,
      buildAgentResultText({ kind: "proceed" }, expectedKickoff),
    );
  });

  it("拒否したとき、結果は拒否をエージェントへ知らせ、現行セッションのまま継続する", async () => {
    __resetPendingKickoff();
    const captured = capture();
    const invocation = await invokeTool(captured, {}, false);
    assert.equal(invocation.result.details.approved, false);
    assert.equal(
      invocation.result.content[0].text,
      buildAgentResultText({ kind: "rejected" }, { kind: "empty" }),
    );
    assert.deepEqual(captured.sentMessages, []);
  });

  it("decideOnApproval は承認を proceed、拒否を rejected に分ける", () => {
    assert.deepEqual(decideOnApproval(true), { kind: "proceed" });
    assert.deepEqual(decideOnApproval(false), { kind: "rejected" });
  });

  it("buildAgentResultText は拒否のとき、現行セッションのまま継続することを伝える", () => {
    const rejectionText = buildAgentResultText({ kind: "rejected" }, { kind: "empty" });
    assert.ok(rejectionText.includes("rejected"));
    assert.ok(rejectionText.includes("current session"));
  });

  it("buildAgentResultText は承認かつメッセージなしのとき、空セッションで開くことを伝える", () => {
    const emptyApprovalText = buildAgentResultText({ kind: "proceed" }, { kind: "empty" });
    assert.ok(emptyApprovalText.includes("approved"));
    assert.ok(emptyApprovalText.includes("empty"));
  });

  it("buildAgentResultText は承認かつメッセージありのとき、そのメッセージを添えて開くことを伝える", () => {
    const messageApprovalText = buildAgentResultText(
      { kind: "proceed" },
      { kind: "draft-first-message", message: "次はこれ" },
    );
    assert.ok(messageApprovalText.includes("approved"));
    assert.ok(messageApprovalText.includes("次はこれ"));
  });
});

describe("承認時の新セッション初期状態", () => {
  it("最初のメッセージがあるとき、新セッションの入力欄にドラフトとして設定される", async () => {
    __resetPendingKickoff();
    const captured = capture();
    await invokeTool(captured, { firstMessage: "新しい話題" }, true);
    const command = await runCommand(captured);
    assert.equal(command.draftInEditor, "新しい話題");
  });

  it("最初のメッセージがないとき、新セッションは空のセッションとして開く", async () => {
    __resetPendingKickoff();
    const captured = capture();
    await invokeTool(captured, {}, true);
    const command = await runCommand(captured);
    assert.equal(command.draftInEditor, "");
  });

  it("空白のみの firstMessage はメッセージなし扱いになり、空のセッションとして開く", async () => {
    __resetPendingKickoff();
    const captured = capture();
    await invokeTool(captured, { firstMessage: "   " }, true);
    const command = await runCommand(captured);
    assert.equal(command.draftInEditor, "");
  });

  it("newSessionKickoff は最初のメッセージの有無でドラフトか空かを決める", () => {
    assert.deepEqual(newSessionKickoff(undefined), { kind: "empty" });
    assert.deepEqual(newSessionKickoff("こんにちは"), {
      kind: "draft-first-message",
      message: "こんにちは",
    });
  });

  it("normalizeFirstMessage は前後の空白を詰め、空白のみはなし扱いにする", () => {
    assert.equal(normalizeFirstMessage(undefined), undefined);
    assert.equal(normalizeFirstMessage(""), undefined);
    assert.equal(normalizeFirstMessage("   "), undefined);
    assert.equal(normalizeFirstMessage("  hello  "), "hello");
  });
});

describe("前セッションからの引き継ぎ", () => {
  it("新セッションは setup を持たず、前セッションのエントリをコピーしない", async () => {
    __resetPendingKickoff();
    const captured = capture();
    await invokeTool(captured, { firstMessage: "foo" }, true);
    const command = await runCommand(captured);
    assert.equal(command.newSessionOptions.setup, undefined);
  });

  it("新セッションは parentSession をリンクせず、前セッションのファイルパスを引き継がない", async () => {
    __resetPendingKickoff();
    const captured = capture();
    await invokeTool(captured, {}, true);
    const command = await runCommand(captured);
    assert.equal(command.newSessionOptions.parentSession, undefined);
  });

  it("新セッションの withSession は最初のメッセージを入力欄へ設定し、それ以外は何も引き継がない", async () => {
    __resetPendingKickoff();
    const captured = capture();
    await invokeTool(captured, { firstMessage: "carry nothing but this" }, true);
    const command = await runCommand(captured);
    assert.equal(command.draftInEditor, "carry nothing but this");
    assert.equal(command.newSessionOptions.setup, undefined);
    assert.equal(command.newSessionOptions.parentSession, undefined);
  });

  it("requestNewSession / consumePendingKickoff は kickoff を受け渡し、消費後にクリアする", () => {
    __resetPendingKickoff();
    requestNewSession({ kind: "draft-first-message", message: "x" }, () => {});
    assert.deepEqual(consumePendingKickoff(), { kind: "draft-first-message", message: "x" });
    assert.deepEqual(consumePendingKickoff(), { kind: "empty" });
    __resetPendingKickoff();
  });
});

describe("ユーザーの prompt command", () => {
  it("/new-session の引数を新セッションの入力欄へドラフトとして設定する", async () => {
    __resetPendingKickoff();
    const captured = capture();
    const command = await runCommand(captured, { args: "hi" });
    assert.equal(command.draftInEditor, "hi");
  });

  it("/new-session の引数が空白だけなら空のセッションとして開く", async () => {
    __resetPendingKickoff();
    const captured = capture();
    const command = await runCommand(captured, { args: "   " });
    assert.equal(command.draftInEditor, "");
  });

  it("ユーザーコマンドの引数は保留中のツール入力より優先される", async () => {
    __resetPendingKickoff();
    requestNewSession({ kind: "draft-first-message", message: "tool message" }, () => {});
    const captured = capture();
    const command = await runCommand(captured, { args: "user message" });
    assert.equal(command.draftInEditor, "user message");
    __resetPendingKickoff();
  });
});

describe("エージェント提案とユーザー直接操作の違い", () => {
  it("エージェントが new_session ツールを呼ぶと、毎回確認ダイアログが表示される", async () => {
    __resetPendingKickoff();
    const captured = capture();
    const firstApproval = await invokeTool(captured, {}, true);
    const secondApproval = await invokeTool(captured, { firstMessage: "again" }, true);
    assert.ok(firstApproval.confirmTitle.length > 0);
    assert.ok(secondApproval.confirmTitle.length > 0);
  });

  it("この拡張は session_before_switch をフックせず、ユーザー直接の /new 入力に確認ダイアログを出さない", () => {
    const captured = capture();
    assert.equal(captured.events.has("session_before_switch"), false);
  });

  it("この拡張は /new コマンドを登録せず、pi 組み込みの /new 動作を変更しない", () => {
    const captured = capture();
    assert.equal(captured.commands.has("new"), false);
  });
});

let passed = 0;
const failures: string[] = [];
for (const test of tests) {
  try {
    await test.fn();
    passed++;
  } catch (error) {
    failures.push(
      `  ✗ ${test.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
