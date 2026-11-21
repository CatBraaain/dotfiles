import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import walkHistoryExtension from "./index.ts";

function userEntry(id: string, parentId: string | null, content: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content, timestamp: 0 },
  } as SessionEntry;
}

function assistantEntry(id: string, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 },
  } as SessionEntry;
}

interface CaptureOptions {
  branchEntries?: SessionEntry[];
  allEntries?: SessionEntry[];
  allEntriesAfterNavigate?: SessionEntry[];
  idle?: boolean;
  navigateCancelled?: boolean;
}

interface CapturedCalls {
  runCommand: (name: string) => Promise<void>;
  runShortcut: (shortcut: string) => Promise<void>;
  fireSessionStart: () => void;
  setNavigateCancelled: (cancelled: boolean) => void;
  setEditorText: (text: string) => void;
  editorValue: () => string;
  sendUserMessageCalls: Array<{ text: string; options: unknown }>;
  aborted: () => boolean;
  waitedForIdle: () => number;
  navigateTreeCalls: Array<{ entryId: string; options: unknown }>;
  callLog: string[];
  editorTexts: string[];
  notifications: string[];
  dialogCalls: string[];
}

// factory をモック pi と ctx で起動し、コマンド・ショートカットの handler と各 API 呼び出しを捕捉する。
// navigateTree は user発言を対象にするとその発言を含まないブランチへ、それ以外は対象を含むブランチへ
// 移るという pi 本体のセマンティクスを模倣し、連続操作のテストを成立させる。
function captureWalkHistory(options?: CaptureOptions): CapturedCalls {
  const registeredCommands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const registeredShortcuts = new Map<string, (ctx: unknown) => Promise<void>>();
  const sessionStartHandlers: Array<() => void> = [];
  const sendUserMessageCalls: Array<{ text: string; options: unknown }> = [];
  const navigateTreeCalls: Array<{ entryId: string; options: unknown }> = [];
  const editorTexts: string[] = [];
  const notifications: string[] = [];
  const dialogCalls: string[] = [];
  const callLog: string[] = [];
  let aborted = false;
  let waitForIdleCount = 0;
  let navigateCancelled = options?.navigateCancelled ?? false;
  let editorText = "";

  const state = {
    branch: [...(options?.branchEntries ?? [])],
    all: options?.allEntries ?? options?.branchEntries ?? [],
  };

  walkHistoryExtension({
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      registeredCommands.set(name, def.handler);
    },
    registerShortcut: (
      shortcut: string,
      def: { handler: (ctx: unknown) => Promise<void> },
    ) => {
      registeredShortcuts.set(shortcut, def.handler);
    },
    sendUserMessage: (text: string, sendOptions: unknown) => {
      sendUserMessageCalls.push({ text, options: sendOptions });
    },
    on: (event: string, handler: () => void) => {
      if (event === "session_start") sessionStartHandlers.push(handler);
    },
  } as never);

  const ctx = {
    sessionManager: {
      getBranch: () => state.branch,
      getEntries: () => state.all,
      getEntry: (id: string) => state.all.find((entry) => entry.id === id),
    },
    isIdle: () => options?.idle ?? true,
    abort: () => {
      aborted = true;
      callLog.push("abort");
    },
    waitForIdle: () => {
      waitForIdleCount += 1;
      callLog.push("waitForIdle");
      return Promise.resolve();
    },
    navigateTree: (targetId: string, navigateOptions: unknown) => {
      callLog.push("navigateTree");
      navigateTreeCalls.push({ entryId: targetId, options: navigateOptions });
      const targetIndex = state.branch.findIndex((entry) => entry.id === targetId);
      if (targetIndex >= 0) {
        const target = state.branch[targetIndex];
        if (target) {
          const isUserTarget = target.type === "message" && target.message.role === "user";
          state.branch = state.branch.slice(0, isUserTarget ? targetIndex : targetIndex + 1);
          // pi 本体は user発言への navigate でそのテキストをエディタへ復元するため、それを模倣する
          if (isUserTarget) {
            const content = (target as typeof target & { message: { role: "user"; content: string | Array<{ type: string; text?: string }> } }).message.content;
            const text =
              typeof content === "string"
                ? content
                : content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text ?? "")
                    .join("");
            editorText = text;
          }
        }
      }
      if (options?.allEntriesAfterNavigate) state.all = options.allEntriesAfterNavigate;
      return Promise.resolve({ cancelled: navigateCancelled });
    },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      setEditorText: (text: string) => {
        editorText = text;
        editorTexts.push(text);
      },
      getEditorText: () => editorText,
      confirm: () => {
        dialogCalls.push("confirm");
        return Promise.resolve(true);
      },
      select: () => {
        dialogCalls.push("select");
        return Promise.resolve(undefined);
      },
    },
  };

  return {
    async runCommand(name: string) {
      const handler = registeredCommands.get(name);
      assert.ok(handler, `/${name} command is not registered`);
      await handler("", ctx);
    },
    async runShortcut(shortcut: string) {
      const handler = registeredShortcuts.get(shortcut);
      assert.ok(handler, `${shortcut} shortcut is not registered`);
      await handler(ctx);
    },
    fireSessionStart() {
      for (const handler of sessionStartHandlers) handler();
    },
    setNavigateCancelled(cancelled: boolean) {
      navigateCancelled = cancelled;
    },
    setEditorText(text: string) {
      editorText = text;
    },
    editorValue: () => editorText,
    sendUserMessageCalls,
    aborted: () => aborted,
    waitedForIdle: () => waitForIdleCount,
    navigateTreeCalls,
    callLog,
    editorTexts,
    notifications,
    dialogCalls,
  };
}

describe("コマンドとショートカットの登録", () => {
  it("back・forward・undo・redo コマンドと ctrl+up・ctrl+down ショートカットが登録される", () => {
    const registeredCommands: string[] = [];
    const registeredShortcuts: string[] = [];
    walkHistoryExtension({
      registerCommand: (name: string) => {
        registeredCommands.push(name);
      },
      registerShortcut: (shortcut: string) => {
        registeredShortcuts.push(shortcut);
      },
      on: () => {},
    } as never);
    assert.deepEqual(registeredCommands, ["back", "forward", "undo", "redo"]);
    assert.deepEqual(registeredShortcuts, ["ctrl+up", "ctrl+down"]);
  });
});

describe("back", () => {
  it("最後の user 発言の entry を summarize:false で navigateTree し、確認ダイアログを表示せず即座に戻す", async () => {
    const capture = captureWalkHistory({
      branchEntries: [
        userEntry("u1", null, "はじめ"),
        userEntry("u2", "a1", "やり直したい"),
        assistantEntry("a2", "u2"),
      ],
    });

    await capture.runCommand("back");

    assert.deepEqual(capture.navigateTreeCalls, [{ entryId: "u2", options: { summarize: false } }]);
    assert.deepEqual(capture.dialogCalls, []);
  });

  it("取り消した発言のテキストでエディタを置き換える", async () => {
    const capture = captureWalkHistory({
      branchEntries: [userEntry("u2", "a1", "やり直したい"), assistantEntry("a2", "u2")],
    });

    await capture.runCommand("back");

    assert.equal(capture.editorValue(), "やり直したい");
  });

  it("idle のときは abort せず、turn 進行中は abort して idle を待ってから navigateTree する", async () => {
    const idleCapture = captureWalkHistory({
      branchEntries: [userEntry("u1", null, "はじめ")],
    });
    await idleCapture.runCommand("back");
    assert.equal(idleCapture.aborted(), false);
    assert.equal(idleCapture.waitedForIdle(), 0);

    const busyCapture = captureWalkHistory({
      idle: false,
      branchEntries: [userEntry("u1", null, "はじめ")],
    });
    await busyCapture.runCommand("back");
    assert.equal(busyCapture.aborted(), true);
    assert.deepEqual(busyCapture.callLog, ["abort", "waitForIdle", "navigateTree"]);
  });

  it("user 発言がないブランチでは、戻れないことを通知し会話を変えない", async () => {
    const capture = captureWalkHistory({ branchEntries: [assistantEntry("a1", null)] });

    await capture.runCommand("back");

    assert.equal(capture.notifications.length, 1);
    assert.deepEqual(capture.navigateTreeCalls, []);
    assert.deepEqual(capture.editorTexts, []);
  });

  it("空のブランチでは、戻れないことを通知し会話を変えない", async () => {
    const capture = captureWalkHistory();

    await capture.runCommand("back");

    assert.equal(capture.notifications.length, 1);
    assert.deepEqual(capture.navigateTreeCalls, []);
  });

  it("navigateTree がキャンセルされたとき、エディタを置き換えず forward 対象にも積まない", async () => {
    const capture = captureWalkHistory({
      navigateCancelled: true,
      branchEntries: [userEntry("u1", null, "はじめ")],
    });

    await capture.runCommand("back");
    await capture.runCommand("forward");

    assert.deepEqual(capture.editorTexts, []);
    assert.equal(capture.notifications.length, 1);
    assert.equal(capture.navigateTreeCalls.length, 1);
  });
});

describe("undo・redo エイリアス", () => {
  it("/undo は /back と同じ対象へ戻す", async () => {
    const capture = captureWalkHistory({
      branchEntries: [
        userEntry("u1", null, "はじめ"),
        userEntry("u2", "a1", "やり直したい"),
        assistantEntry("a2", "u2"),
      ],
    });

    await capture.runCommand("undo");

    assert.deepEqual(capture.navigateTreeCalls, [{ entryId: "u2", options: { summarize: false } }]);
    assert.equal(capture.editorValue(), "やり直したい");
  });

  it("/redo は /forward と同じ対象へ戻す", async () => {
    const capture = captureWalkHistory({
      branchEntries: [
        userEntry("u1", null, "はじめ"),
        userEntry("u2", "a1", "やり直したい"),
        assistantEntry("a2", "u2"),
      ],
    });

    await capture.runCommand("back");
    await capture.runCommand("redo");

    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u2", "a2"]);
  });
});

describe("forward", () => {
  it("back の後に放棄した末端の entry へ戻り、エディタを変更しない", async () => {
    const capture = captureWalkHistory({
      branchEntries: [
        userEntry("u1", null, "はじめ"),
        userEntry("u2", "a1", "やり直したい"),
        assistantEntry("a2", "u2"),
      ],
    });

    await capture.runCommand("back");
    await capture.runCommand("forward");

    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u2", "a2"]);
    assert.equal(capture.editorValue(), "やり直したい");
  });

  it("連続 back の後の連続 forward は、後から back した順に戻る(LIFO)", async () => {
    const capture = captureWalkHistory({
      branchEntries: [
        userEntry("u1", null, "はじめ"),
        assistantEntry("a1", "u1"),
        userEntry("u2", "a1", "やり直したい"),
        assistantEntry("a2", "u2"),
      ],
    });

    await capture.runCommand("back");
    await capture.runCommand("back");
    await capture.runCommand("forward");
    await capture.runCommand("forward");

    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), [
      "u2",
      "u1",
      "a1",
      "a2",
    ]);
  });

  it("back していないときは、戻れないことを通知し会話を変えない", async () => {
    const capture = captureWalkHistory({
      branchEntries: [userEntry("u1", null, "はじめ"), assistantEntry("a1", "u1")],
    });

    await capture.runCommand("forward");

    assert.equal(capture.notifications.length, 1);
    assert.deepEqual(capture.navigateTreeCalls, []);
  });

  it("放棄した対象がセッションから消えているときは飛ばし、戻せる対象がなければ通知する", async () => {
    const capture = captureWalkHistory({
      branchEntries: [userEntry("u1", null, "はじめ"), assistantEntry("a1", "u1")],
      allEntriesAfterNavigate: [],
    });

    await capture.runCommand("back");
    await capture.runCommand("forward");

    assert.equal(capture.notifications.length, 1);
    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u1"]);
  });

  it("放棄した対象の一部が消えているときは、残っている対象へ戻す", async () => {
    const capture = captureWalkHistory({
      branchEntries: [
        userEntry("u1", null, "はじめ"),
        assistantEntry("a1", "u1"),
        userEntry("u2", "a1", "やり直したい"),
        assistantEntry("a2", "u2"),
      ],
      allEntriesAfterNavigate: [userEntry("u1", null, "はじめ"), assistantEntry("a2", "u2")],
    });

    await capture.runCommand("back");
    await capture.runCommand("back");
    await capture.runCommand("forward");

    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u2", "u1", "a2"]);
  });

  it("session_start を迎えると forward 対象が消え、戻れないことを通知する", async () => {
    const capture = captureWalkHistory({
      branchEntries: [userEntry("u1", null, "はじめ"), assistantEntry("a1", "u1")],
    });

    await capture.runCommand("back");
    capture.fireSessionStart();
    await capture.runCommand("forward");

    assert.equal(capture.notifications.length, 1);
    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u1"]);
  });

  it("戻る先が user発言のときも、エディタの内容を変えない", async () => {
    const capture = captureWalkHistory({
      branchEntries: [
        userEntry("u1", null, "はじめ"),
        assistantEntry("a1", "u1"),
        userEntry("u2", "a1", "やり直したい"),
      ],
    });

    await capture.runCommand("back");
    capture.setEditorText("手直しした");
    await capture.runCommand("forward");

    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u2", "u2"]);
    assert.equal(capture.editorValue(), "手直しした");
  });

  it("navigateTree がキャンセルされた forward は対象を積み戻し、再実行で同じ対象へ戻せる", async () => {
    const capture = captureWalkHistory({
      branchEntries: [userEntry("u1", null, "はじめ"), assistantEntry("a1", "u1")],
    });

    await capture.runCommand("back");
    capture.setNavigateCancelled(true);
    await capture.runCommand("forward");
    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u1", "a1"]);
    assert.equal(capture.notifications.length, 0);

    capture.setNavigateCancelled(false);
    await capture.runCommand("forward");
    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u1", "a1", "a1"]);
  });
});

describe("ショートカット", () => {
  it("ctrl+up で /back コマンドを発火する", async () => {
    const capture = captureWalkHistory({
      branchEntries: [userEntry("u1", null, "はじめ")],
    });

    await capture.runShortcut("ctrl+up");

    assert.deepEqual(capture.sendUserMessageCalls, [
      { text: "/back", options: { expandPromptTemplates: true } },
    ]);
    // ショートカット自体は会話を直接変更しない。コマンド経由で変更する
    assert.deepEqual(capture.navigateTreeCalls, []);
    assert.deepEqual(capture.editorTexts, []);
  });

  it("ctrl+down で /forward コマンドを発火する", async () => {
    const capture = captureWalkHistory({
      branchEntries: [userEntry("u1", null, "はじめ")],
    });

    await capture.runShortcut("ctrl+down");

    assert.deepEqual(capture.sendUserMessageCalls, [
      { text: "/forward", options: { expandPromptTemplates: true } },
    ]);
  });
});

describe("直列化", () => {
  it("同時に実行した2回の back が同じ対象に重ねて飛ばず、順に1発言ずつ遡る", async () => {
    const capture = captureWalkHistory({
      branchEntries: [
        userEntry("u1", null, "はじめ"),
        userEntry("u2", "a1", "やり直したい"),
        assistantEntry("a2", "u2"),
      ],
    });

    await Promise.all([capture.runCommand("back"), capture.runCommand("back")]);

    assert.deepEqual(capture.navigateTreeCalls.map((call) => call.entryId), ["u2", "u1"]);
    assert.deepEqual(capture.editorTexts, ["やり直したい", "はじめ"]);
  });
});
