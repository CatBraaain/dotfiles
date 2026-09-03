import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import asideExtension from "./index";


interface SentMessage {
  message: { customType: string; content: string; display: boolean };
  options: { triggerTurn?: boolean; deliverAs?: string };
}

interface CapturedExtension {
  registeredCommandNames: string[];
  runAside: (args: string) => Promise<void>;
  sentMessages: SentMessage[];
}

// factory をモック pi で起動し、/aside の handler と sendMessage 呼び出しを捕捉する。
function captureAsideExtension(): CapturedExtension {
  const registeredCommandNames: string[] = [];
  const commands = new Map<string, (args: string) => Promise<void>>();
  const sentMessages: SentMessage[] = [];

  asideExtension({
    registerCommand: (name: string, def: { handler: (args: string) => Promise<void> }) => {
      registeredCommandNames.push(name);
      commands.set(name, def.handler);
    },
    sendMessage: (
      message: { customType: string; content: string; display: boolean },
      options: { triggerTurn?: boolean; deliverAs?: string },
    ) => {
      sentMessages.push({ message, options });
    },
  } as never);

  return {
    registeredCommandNames,
    async runAside(args: string) {
      await commands.get("aside")?.(args);
    },
    sentMessages,
  };
}

describe("コマンドの登録", () => {
  it("/aside という名前のコマンドが1つだけ登録される", () => {
    const extension = captureAsideExtension();
    assert.deepEqual(extension.registeredCommandNames, ["aside"]);
  });
});

describe("履歴への追記", () => {
  it("/aside 認証完成 は、認証完成 をメッセージ本文として履歴に append する", async () => {
    const extension = captureAsideExtension();
    await extension.runAside("認証完成");

    const appendedContent = extension.sentMessages[0]?.message.content;
    assert.equal(appendedContent, "認証完成");
  });
  it("/aside （テキストなし）は、空テキストをメッセージ本文として履歴に append する", async () => {
    const extension = captureAsideExtension();
    await extension.runAside("");

    const appendedContent = extension.sentMessages[0]?.message.content;
    assert.equal(appendedContent, "");
  });
});

describe("AI 応答の抑制", () => {
  it("/aside を打つと、deliverAs に nextTurn を渡して sendMessage する", async () => {
    const extension = captureAsideExtension();
    await extension.runAside("認証完成");

    const deliveryMode = extension.sentMessages[0]?.options.deliverAs;
    assert.equal(deliveryMode, "nextTurn");
  });
  it("/aside を打つと、triggerTurn を指定せずに sendMessage する", async () => {
    const extension = captureAsideExtension();
    await extension.runAside("認証完成");

    const triggeredTurn = extension.sentMessages[0]?.options.triggerTurn;
    assert.equal(triggeredTurn, undefined);
  });
});

describe("メッセージの永続性", () => {
  it("append したメッセージは customType aside のメッセージとして1回 sendMessage される", async () => {
    const extension = captureAsideExtension();
    await extension.runAside("認証完成");

    const sentMessage = extension.sentMessages[0];
    assert.equal(extension.sentMessages.length, 1);
    assert.equal(sentMessage?.message.customType, "aside");
  });
  it("append したメッセージはセッション画面に表示される（display が true）", async () => {
    const extension = captureAsideExtension();
    await extension.runAside("認証完成");

    const isDisplayed = extension.sentMessages[0]?.message.display;
    assert.equal(isDisplayed, true);
  });
});

describe("複数 append の順序", () => {
  it("/aside A → /aside B は、A・B の順でメッセージが append される", async () => {
    const extension = captureAsideExtension();
    await extension.runAside("A");
    await extension.runAside("B");

    const appendedOrder = extension.sentMessages.map((call) => call.message.content);
    assert.deepEqual(appendedOrder, ["A", "B"]);
  });
});
