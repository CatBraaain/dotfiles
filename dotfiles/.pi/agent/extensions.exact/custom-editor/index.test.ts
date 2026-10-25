import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  EditorTheme,
  TUI,
} from "@earendil-works/pi-tui";
import { NoPromptHistoryEditor, NoTabCompletionWhenEmptyEditor } from "./core.ts";
import customEditor from "./index.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";

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
  return new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
}

// getSuggestions の呼び出しを記録し、補完を起動しない provider。
function createRecordingProvider(overrides: Partial<AutocompleteProvider> = {}): {
  provider: AutocompleteProvider;
  calls: { force: boolean }[];
} {
  const calls: { force: boolean }[] = [];
  const provider: AutocompleteProvider = {
    getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => {
      calls.push({ force: options.force ?? false });
      return null;
    },
    applyCompletion: (lines, cursorLine, cursorCol) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
    ...overrides,
  };
  return { provider, calls };
}

// slash 補完の候補1件を返し、確定時の applyCompletion 呼び出しを記録する provider。
function createSuggestionProvider(): {
  provider: AutocompleteProvider;
  calls: { force: boolean }[];
  applyCalls: number[];
} {
  const calls: { force: boolean }[] = [];
  const applyCalls: number[] = [];
  const item: AutocompleteItem = { value: "/skill:foo", label: "foo" };
  const provider: AutocompleteProvider = {
    getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => {
      calls.push({ force: options.force ?? false });
      return { prefix: "/sk", items: [item] };
    },
    applyCompletion: (lines, cursorLine, cursorCol, applied, prefix) => {
      applyCalls.push(1);
      const start = cursorCol - prefix.length;
      const updated = lines.map((line, i) =>
        i === cursorLine ? line.slice(0, start) + applied.value : line,
      );
      return {
        lines: updated,
        cursorLine,
        cursorCol: start + applied.value.length,
      };
    },
  };
  return { provider, calls, applyCalls };
}

// autocomplete の非同期リクエスト（debounce → provider呼び出し）の完了を待つ。
async function flushAutocomplete(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => unknown;

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

// factory をモック pi で起動し、session_start handler を捕捉する。
function captureSessionStartHandler(): SessionStartHandler {
  let handler: SessionStartHandler | undefined;
  const pi = {
    on: (event: string, registered: never) => {
      if (event === "session_start") handler = registered as SessionStartHandler;
      return () => {};
    },
  } as unknown as ExtensionAPI;
  customEditor(pi);
  assert.ok(handler, "session_start handler was not registered");
  return handler;
}

function createTuiContext(mode: string, factories: unknown[]): ExtensionContext {
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
    const editor = new NoPromptHistoryEditor(createTui(), createTheme(), createKeybindings());
    editor.addToHistory("previous prompt");
    editor.setText("hello");
    editor.handleInput(UP); // 行途中 → 行頭へ
    editor.handleInput(UP); // 行頭 → 履歴には飛ばない
    assert.equal(editor.getText(), "hello");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("does not restore history on down", () => {
    const editor = new NoPromptHistoryEditor(createTui(), createTheme(), createKeybindings());
    editor.addToHistory("previous prompt");
    editor.setText("hello");
    editor.handleInput(DOWN);
    assert.equal(editor.getText(), "hello");
  });

  it("keeps plain vertical cursor movement in a multi-line editor", () => {
    const editor = new NoPromptHistoryEditor(createTui(), createTheme(), createKeybindings());
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

describe("NoTabCompletionWhenEmptyEditor", () => {
  it("does not trigger completion on tab when the editor is empty", async () => {
    const editor = new NoTabCompletionWhenEmptyEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    // 本来発火する判定を明示して、ラッパーの false が効いていることを確認する。
    const { provider, calls } = createRecordingProvider({
      shouldTriggerFileCompletion: () => true,
    });
    editor.setAutocompleteProvider(provider);
    editor.handleInput(TAB);
    await flushAutocomplete();
    assert.equal(calls.length, 0);
  });

  it("triggers file path completion on tab when text is present", async () => {
    const editor = new NoTabCompletionWhenEmptyEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    const { provider, calls } = createRecordingProvider();
    editor.setAutocompleteProvider(provider);
    editor.setText("src/foo");
    editor.handleInput(TAB);
    await flushAutocomplete();
    const first = calls[0];
    assert.ok(first);
    assert.equal(first.force, true);
  });

  it("respects the provider rejection on tab when text is present", async () => {
    const editor = new NoTabCompletionWhenEmptyEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    const { provider, calls } = createRecordingProvider({
      shouldTriggerFileCompletion: () => false,
    });
    editor.setAutocompleteProvider(provider);
    editor.setText("src/foo");
    editor.handleInput(TAB);
    await flushAutocomplete();
    assert.equal(calls.length, 0);
  });

  it("still triggers slash command completion on tab", async () => {
    const editor = new NoTabCompletionWhenEmptyEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    const { provider, calls } = createRecordingProvider();
    editor.setAutocompleteProvider(provider);
    editor.setText("/sk");
    editor.handleInput(TAB);
    await flushAutocomplete();
    const first = calls[0];
    assert.ok(first);
    assert.equal(first.force, false);
  });

  it("keeps natural completion for @ trigger", async () => {
    const editor = new NoTabCompletionWhenEmptyEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    const { provider, calls } = createRecordingProvider();
    editor.setAutocompleteProvider(provider);
    editor.handleInput("@");
    editor.handleInput("f");
    await flushAutocomplete();
    const first = calls[0];
    assert.ok(first);
    assert.equal(first.force, false);
  });

  it("keeps natural completion for / trigger", async () => {
    const editor = new NoTabCompletionWhenEmptyEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    const { provider, calls } = createRecordingProvider();
    editor.setAutocompleteProvider(provider);
    editor.handleInput("/");
    await flushAutocomplete();
    assert.ok(calls.length >= 1);
  });

  it("keeps natural completion for # trigger", async () => {
    const editor = new NoTabCompletionWhenEmptyEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    const { provider, calls } = createRecordingProvider();
    editor.setAutocompleteProvider(provider);
    editor.handleInput("#");
    editor.handleInput("f");
    await flushAutocomplete();
    assert.ok(calls.length >= 1);
  });

  it("completes the selected suggestion on the second tab while the list is open", async () => {
    const editor = new NoTabCompletionWhenEmptyEditor(
      createTui(),
      createTheme(),
      createKeybindings(),
    );
    const { provider, calls, applyCalls } = createSuggestionProvider();
    editor.setAutocompleteProvider(provider);
    editor.setText("/sk");
    editor.handleInput(TAB);
    await flushAutocomplete();
    assert.equal(calls.length, 1);
    editor.handleInput(TAB);
    assert.equal(applyCalls.length, 1);
    assert.equal(editor.getText(), "/skill:foo");
  });
});

describe("customEditor extension", () => {
  it("registers a NoTabCompletionWhenEmptyEditor factory on session_start in tui mode", async () => {
    const handler = captureSessionStartHandler();
    const factories: unknown[] = [];
    await handler({}, createTuiContext("tui", factories));
    assert.equal(factories.length, 1);

    const factory = factories[0] as EditorFactory;
    const editor = factory(createTui(), createTheme(), createKeybindings());
    assert.ok(editor instanceof NoPromptHistoryEditor);
    assert.ok(editor instanceof NoTabCompletionWhenEmptyEditor);

    const { provider, calls } = createRecordingProvider({
      shouldTriggerFileCompletion: () => true,
    });
    const emptySuppressive = editor as NoTabCompletionWhenEmptyEditor;
    emptySuppressive.setAutocompleteProvider(provider);
    emptySuppressive.addToHistory("previous prompt");
    emptySuppressive.handleInput(TAB);
    await flushAutocomplete();
    assert.equal(calls.length, 0);
    emptySuppressive.handleInput(UP);
    emptySuppressive.handleInput(UP);
    assert.equal(emptySuppressive.getText(), "");
  });

  it("does not register an editor factory outside tui mode", async () => {
    const handler = captureSessionStartHandler();
    const factories: unknown[] = [];
    await handler({}, createTuiContext("rpc", factories));
    assert.equal(factories.length, 0);
  });
});
