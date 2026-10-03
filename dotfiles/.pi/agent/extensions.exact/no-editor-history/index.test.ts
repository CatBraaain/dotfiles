import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { NoPromptHistoryEditor } from "./core.ts";
import noEditorHistory from "./index.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";

// pi-tui Editor.handleInput はグローバル keybindings を参照するため、テスト用に設定する。
setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));

function createTui(): TUI {
  return { requestRender() {}, terminal: { rows: 24 } } as unknown as TUI;
}

function createTheme(): EditorTheme {
  return {
    borderColor: (text) => text,
    selectList: {} as EditorTheme["selectList"],
  };
}

function createKeybindings(): KeybindingsManager {
  // editor が実行時に使うのは matches / getKeys のみのため、pi-tui の manager で足りる。
  return new TuiKeybindingsManager(
    TUI_KEYBINDINGS,
  ) as unknown as KeybindingsManager;
}

type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => unknown;

type SessionStartHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<void> | void;

// factory をモック pi で起動し、session_start handler を捕捉する。
function captureSessionStartHandler(): SessionStartHandler {
  let handler: SessionStartHandler | undefined;
  const pi = {
    on: (event: string, registered: never) => {
      if (event === "session_start")
        handler = registered as SessionStartHandler;
      return () => {};
    },
  } as unknown as ExtensionAPI;
  noEditorHistory(pi);
  assert.ok(handler, "session_start handler was not registered");
  return handler;
}

function createTuiContext(
  mode: string,
  factories: unknown[],
): ExtensionContext {
  return {
    mode,
    ui: {
      setEditorComponent: (factory: EditorFactory) => {
        factories.push(factory);
      },
    },
  } as unknown as ExtensionContext;
}

describe("plain Editor (pi-tui)", () => {
  it("loads prompt history on the second up press (control)", () => {
    const editor = new Editor(createTui(), createTheme());
    editor.addToHistory("previous prompt");
    editor.setText("hello");
    editor.handleInput(UP); // 行途中 → 行頭へ
    editor.handleInput(UP); // 行頭 → 履歴ブラウズ
    assert.equal(editor.getText(), "previous prompt");
  });
});

describe("NoPromptHistoryEditor", () => {
  it("does not load prompt history on up", () => {
    const editor = new NoPromptHistoryEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    editor.addToHistory("previous prompt");
    editor.setText("hello");
    editor.handleInput(UP); // 行途中 → 行頭へ
    editor.handleInput(UP); // 行頭 → 履歴には飛ばない
    assert.equal(editor.getText(), "hello");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("does not restore history on down", () => {
    const editor = new NoPromptHistoryEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    editor.addToHistory("previous prompt");
    editor.setText("hello");
    editor.handleInput(DOWN);
    assert.equal(editor.getText(), "hello");
  });

  it("keeps plain vertical cursor movement in a multi-line editor", () => {
    const editor = new NoPromptHistoryEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    editor.render(80);
    editor.setText("abc\ndef");
    assert.equal(editor.getCursor().line, 1);
    editor.handleInput(UP);
    assert.equal(editor.getCursor().line, 0);
    editor.handleInput(DOWN);
    assert.equal(editor.getCursor().line, 1);
    assert.equal(editor.getText(), "abc\ndef");
  });
});

describe("noEditorHistory extension", () => {
  it("registers a NoPromptHistoryEditor factory on session_start in tui mode", async () => {
    const handler = captureSessionStartHandler();
    const factories: unknown[] = [];
    await handler({}, createTuiContext("tui", factories));
    assert.equal(factories.length, 1);

    const factory = factories[0] as EditorFactory;
    const editor = factory(createTui(), createTheme(), createKeybindings());
    assert.ok(editor instanceof NoPromptHistoryEditor);

    const historyFree = editor as NoPromptHistoryEditor;
    historyFree.addToHistory("previous prompt");
    historyFree.setText("hello");
    historyFree.handleInput(UP);
    historyFree.handleInput(UP);
    assert.equal(historyFree.getText(), "hello");
  });

  it("does not register an editor factory outside tui mode", async () => {
    const handler = captureSessionStartHandler();
    const factories: unknown[] = [];
    await handler({}, createTuiContext("rpc", factories));
    assert.equal(factories.length, 0);
  });
});
