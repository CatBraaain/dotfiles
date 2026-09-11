import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import undoExtension from "./index.ts";

interface CapturedCalls {
  runUndo: () => Promise<void>;
  aborted: () => boolean;
  waitedForIdle: () => number;
  navigateTreeCalls: Array<{ entryId: string; options: unknown }>;
  callLog: string[];
  editorTexts: string[];
  notifications: string[];
  dialogCalls: string[];
}

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

// factory をモック pi と ctx で起動し、/undo の handler と各 API 呼び出しを捕捉する。
function captureUndoExtension(
  options?: { idle?: boolean; navigateCancelled?: boolean; branchEntries?: SessionEntry[] },
): CapturedCalls {
  const registeredCommands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const navigateTreeCalls: Array<{ entryId: string; options: unknown }> = [];
  const editorTexts: string[] = [];
  const notifications: string[] = [];
  const dialogCalls: string[] = [];
  const callLog: string[] = [];
  let aborted = false;
  let waitForIdleCount = 0;

  undoExtension({
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      registeredCommands.set(name, def.handler);
    },
  } as never);

  const ctx = {
    sessionManager: {
      getBranch: () => options?.branchEntries ?? [],
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
    navigateTree: (entryId: string, navigateOptions: unknown) => {
      callLog.push("navigateTree");
      navigateTreeCalls.push({ entryId, options: navigateOptions });
      return Promise.resolve({ cancelled: options?.navigateCancelled ?? false });
    },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      setEditorText: (text: string) => {
        editorTexts.push(text);
      },
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
    async runUndo() {
      const handler = registeredCommands.get("undo");
      assert.ok(handler, "/undo command is not registered");
      await handler("", ctx);
    },
    aborted: () => aborted,
    waitedForIdle: () => waitForIdleCount,
    navigateTreeCalls,
    callLog,
    editorTexts,
    notifications,
    dialogCalls,
  };
}

describe("コマンドの登録", () => {
  it("undo という名前のコマンドが登録される", () => {
    const registeredNames: string[] = [];
    undoExtension({
      registerCommand: (name: string) => {
        registeredNames.push(name);
      },
    } as never);
    assert.deepEqual(registeredNames, ["undo"]);
  });
});

describe("巻き戻し", () => {
  it("最後の user 発言の entry を summarize:false で navigateTree し、確認ダイアログを表示せず即座に戻す", async () => {
    const capture = captureUndoExtension({
      branchEntries: [assistantEntry("a2", "u2"), userEntry("u2", "a1", "やり直したい"), userEntry("u1", null, "はじめ")],
    });

    await capture.runUndo();

    assert.deepEqual(capture.navigateTreeCalls, [{ entryId: "u2", options: { summarize: false } }]);
    assert.deepEqual(capture.dialogCalls, []);
  });

  it("取り消した発言のテキストでエディタを置き換える", async () => {
    const capture = captureUndoExtension({
      branchEntries: [assistantEntry("a2", "u2"), userEntry("u2", "a1", "やり直したい")],
    });

    await capture.runUndo();

    assert.deepEqual(capture.editorTexts, ["やり直したい"]);
  });

  it("user 発言が会話の最初の1件のみのとき、その発言を navigateTree してエディタに復元する", async () => {
    const capture = captureUndoExtension({ branchEntries: [userEntry("u1", null, "はじめ")] });

    await capture.runUndo();

    assert.deepEqual(capture.navigateTreeCalls, [{ entryId: "u1", options: { summarize: false } }]);
    assert.deepEqual(capture.editorTexts, ["はじめ"]);
  });
});

describe("turn 進行中の巻き戻し", () => {
  it("turn を中断して idle を待ってから navigateTree する", async () => {
    const capture = captureUndoExtension({
      idle: false,
      branchEntries: [userEntry("u1", null, "はじめ")],
    });

    await capture.runUndo();

    assert.equal(capture.aborted(), true);
    assert.deepEqual(capture.callLog, ["abort", "waitForIdle", "navigateTree"]);
  });

  it("idle のときは abort しない", async () => {
    const capture = captureUndoExtension({
      idle: true,
      branchEntries: [userEntry("u1", null, "はじめ")],
    });

    await capture.runUndo();

    assert.equal(capture.aborted(), false);
    assert.equal(capture.waitedForIdle(), 0);
  });
});

describe("巻き戻せないとき", () => {
  it("user 発言がないブランチでは、戻せないことを通知し会話を変えない", async () => {
    const capture = captureUndoExtension({ branchEntries: [assistantEntry("a1", null)] });

    await capture.runUndo();

    assert.equal(capture.notifications.length, 1);
    assert.deepEqual(capture.navigateTreeCalls, []);
    assert.deepEqual(capture.editorTexts, []);
  });

  it("空のブランチでは、戻せないことを通知し会話を変えない", async () => {
    const capture = captureUndoExtension();

    await capture.runUndo();

    assert.equal(capture.notifications.length, 1);
    assert.deepEqual(capture.navigateTreeCalls, []);
  });
});

describe("ナビゲーションのキャンセル", () => {
  it("navigateTree がキャンセルされたとき、エディタを置き換えない", async () => {
    const capture = captureUndoExtension({
      navigateCancelled: true,
      branchEntries: [userEntry("u1", null, "はじめ")],
    });

    await capture.runUndo();

    assert.deepEqual(capture.editorTexts, []);
  });
});
