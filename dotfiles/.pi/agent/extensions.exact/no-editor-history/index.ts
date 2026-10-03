// 入力欄の up/down によるプロンプト履歴ブラウズを無効化する拡張。
// 詳細は ./SPEC.md。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NoPromptHistoryEditor } from "./core.ts";

export default function noEditorHistory(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new NoPromptHistoryEditor(tui, theme, keybindings),
    );
  });
}
