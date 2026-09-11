import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findUndoTarget } from "./core.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("undo", {
    description:
      "Discard the last user message and everything after it, restoring its text to the editor.",
    handler: async (_args, ctx) => {
      const target = findUndoTarget(ctx.sessionManager.getBranch());
      if (!target) {
        ctx.ui.notify("Nothing to undo: the active branch has no user message.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.abort();
        await ctx.waitForIdle();
      }
      const result = await ctx.navigateTree(target.entryId, { summarize: false });
      if (result.cancelled) return;
      ctx.ui.setEditorText(target.text);
    },
  });
}
