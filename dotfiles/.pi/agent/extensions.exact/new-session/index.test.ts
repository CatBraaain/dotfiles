import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import newSessionExtension, { NEW_SESSION_ALIAS, NEW_SESSION_COMMAND_NAME } from "./index";


interface CommandContext {
  newSession: (options: {
    parentSession?: string;
    setup?: unknown;
    withSession?: (ctx: { ui: { setEditorText: (text: string) => void } }) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
}

interface CommandDefinition {
  handler: (args: string, ctx: CommandContext) => Promise<void>;
}

interface CapturedCommands {
  commands: Map<string, CommandDefinition>;
}

function captureCommands(): CapturedCommands {
  const commands = new Map<string, CommandDefinition>();
  newSessionExtension({
    registerCommand: (name: string, definition: CommandDefinition) => {
      commands.set(name, definition);
    },
  } as never);
  return { commands };
}

interface CommandInvocation {
  newSessionOptions: {
    parentSession?: string;
    setup?: unknown;
    withSession?: unknown;
  };
  draftInEditor: string;
}

async function runCommand(
  captured: CapturedCommands,
  commandName: string,
  args: string,
): Promise<CommandInvocation> {
  let newSessionOptions: CommandInvocation["newSessionOptions"] = {};
  let draftInEditor = "";
  const command = captured.commands.get(commandName);
  assert.ok(command, `登録済みコマンドが見つからない: ${commandName}`);

  await command.handler(args, {
    newSession: async (options) => {
      newSessionOptions = options;
      if (options.withSession) {
        await options.withSession({
          ui: { setEditorText: (text) => (draftInEditor = text) },
        });
      }
      return { cancelled: false };
    },
  });

  return { newSessionOptions, draftInEditor };
}

describe("コマンド登録", () => {
  it("正式コマンドとして new-session を登録する", () => {
    const captured = captureCommands();
    assert.ok(captured.commands.has(NEW_SESSION_COMMAND_NAME));
  });

  it("短縮コマンドとして ns を登録する", () => {
    const captured = captureCommands();
    assert.ok(captured.commands.has(NEW_SESSION_ALIAS));
  });

  it("組み込みの new コマンドを登録しない", () => {
    const captured = captureCommands();
    assert.equal(captured.commands.has("new"), false);
  });

  it("正式コマンドと短縮コマンドだけを登録する", () => {
    const captured = captureCommands();
    assert.deepEqual([...captured.commands.keys()], [NEW_SESSION_COMMAND_NAME, NEW_SESSION_ALIAS]);
  });
});

describe("引数", () => {
  it("new-session の引数を新セッションの入力欄へ未送信ドラフトとして設定する", async () => {
    const captured = captureCommands();
    const invocation = await runCommand(captured, NEW_SESSION_COMMAND_NAME, "hi");
    assert.equal(invocation.draftInEditor, "hi");
  });

  it("ns の引数を新セッションの入力欄へ未送信ドラフトとして設定する", async () => {
    const captured = captureCommands();
    const invocation = await runCommand(captured, NEW_SESSION_ALIAS, "hi");
    assert.equal(invocation.draftInEditor, "hi");
  });

  it("引数の前後の空白をドラフトから除く", async () => {
    const captured = captureCommands();
    const invocation = await runCommand(captured, NEW_SESSION_COMMAND_NAME, "  hi  ");
    assert.equal(invocation.draftInEditor, "hi");
  });

  it("引数が空白だけなら入力欄を空のままにする", async () => {
    const captured = captureCommands();
    const invocation = await runCommand(captured, NEW_SESSION_COMMAND_NAME, "   ");
    assert.equal(invocation.draftInEditor, "");
  });

  it("引数が空なら入力欄を空のままにする", async () => {
    const captured = captureCommands();
    const invocation = await runCommand(captured, NEW_SESSION_COMMAND_NAME, "");
    assert.equal(invocation.draftInEditor, "");
  });
});

describe("新セッションのクリーン性", () => {
  it("parentSession を指定せずに新セッションを開始する", async () => {
    const captured = captureCommands();
    const invocation = await runCommand(captured, NEW_SESSION_COMMAND_NAME, "draft");
    assert.equal(invocation.newSessionOptions.parentSession, undefined);
  });

  it("setup を指定せずに新セッションを開始する", async () => {
    const captured = captureCommands();
    const invocation = await runCommand(captured, NEW_SESSION_COMMAND_NAME, "draft");
    assert.equal(invocation.newSessionOptions.setup, undefined);
  });
});
