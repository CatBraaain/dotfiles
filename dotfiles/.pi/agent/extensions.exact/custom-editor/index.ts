// pi の入力欄エディタを CustomEditor 継承の実装へ差し替える拡張。
// 詳細は ./SPEC.md。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NoTabCompletionWhenEmptyEditor } from "./core.ts";

export default function customEditor(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new NoTabCompletionWhenEmptyEditor(tui, theme, keybindings),
    );
  });
}
