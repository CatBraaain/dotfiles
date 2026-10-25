// 入力欄エディタのカスタマイズ。
// 詳細は ./SPEC.md。

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorTheme, TUI } from "@earendil-works/pi-tui";

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

export class NoTabCompletionWhenEmptyEditor extends NoPromptHistoryEditor {
  // pi-tui consults shouldTriggerFileCompletion only for tab-forced completion; see ./SPEC.md.
  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider({
      triggerCharacters: provider.triggerCharacters,
      getSuggestions: (lines, cursorLine, cursorCol, options) =>
        provider.getSuggestions(lines, cursorLine, cursorCol, options),
      applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
        provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
      shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => {
        if (this.isEmptyInput()) {
          return false;
        }
        return provider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    });
  }

  // Same criterion as pi-tui Editor.isEditorEmpty (private): a single empty line.
  private isEmptyInput(): boolean {
    const lines = this.getLines();
    return lines.length === 1 && lines[0] === "";
  }
}
