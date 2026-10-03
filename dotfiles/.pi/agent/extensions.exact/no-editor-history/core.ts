// 入力欄の up/down によるプロンプト履歴ブラウズを無効化したエディタ。
// 詳細は ./SPEC.md。

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

/**
 * Editor that never records submitted prompts for up/down history navigation.
 *
 * pi-tui Editor embeds prompt-history navigation in its up/down cursor
 * handlers. Keeping the history empty makes up/down behave as plain cursor
 * movement (the line-start jump on the first line stays intact).
 */
export class NoPromptHistoryEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.addToHistory = () => {};
  }
}
