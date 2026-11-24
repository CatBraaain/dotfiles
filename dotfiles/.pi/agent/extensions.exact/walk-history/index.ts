import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findBackTarget } from "./core.ts";

export const BACK_SHORTCUT = "ctrl+up";
export const FORWARD_SHORTCUT = "ctrl+down";

export default function (pi: ExtensionAPI): void {
  const forwardTargets: string[] = [];
  // pi runs concurrent extension commands without queueing them, so rapid
  // keypresses must be serialized here to act one step at a time.
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = pending.then(task, task);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const waitIdle = async (ctx: ExtensionCommandContext) => {
    if (!ctx.isIdle()) {
      ctx.abort();
      await ctx.waitForIdle();
    }
  };

  const back = (ctx: ExtensionCommandContext): Promise<void> =>
    enqueue(async () => {
      const branchEntries = ctx.sessionManager.getBranch();
      const target = findBackTarget(branchEntries);
      if (!target) return;
      const abandonedLeafId = branchEntries.at(-1)?.id;
      await waitIdle(ctx);
      const result = await ctx.navigateTree(target.entryId, { summarize: false });
      if (result.cancelled) return;
      if (abandonedLeafId) forwardTargets.push(abandonedLeafId);
      ctx.ui.setEditorText(target.text);
    });

  const forward = (ctx: ExtensionCommandContext): Promise<void> =>
    enqueue(async () => {
      while (forwardTargets.length > 0) {
        const targetId = forwardTargets.pop() as string;
        if (!ctx.sessionManager.getEntry(targetId)) continue;
        const editorTextBefore = ctx.ui.getEditorText();
        await waitIdle(ctx);
        const result = await ctx.navigateTree(targetId, { summarize: false });
        if (result.cancelled) {
          forwardTargets.push(targetId);
          return;
        }
        // navigateTree writes the target user message's text into the editor;
        // /forward keeps the editor untouched, so restore what was there.
        if (ctx.ui.getEditorText() !== editorTextBefore) {
          ctx.ui.setEditorText(editorTextBefore);
        }
        return;
      }
    });

  const dispatchBack = () => pi.sendUserMessage("/back", { expandPromptTemplates: true });
  const dispatchForward = () => pi.sendUserMessage("/forward", { expandPromptTemplates: true });

  pi.registerCommand("back", {
    description:
      "Go back one user message: discard it and everything after it, restoring its text to the editor.",
    handler: (_args, ctx) => back(ctx),
  });
  pi.registerCommand("forward", {
    description: "Restore the conversation most recently discarded by /back.",
    handler: (_args, ctx) => forward(ctx),
  });
  pi.registerCommand("undo", {
    description: "Alias of /back.",
    handler: (_args, ctx) => back(ctx),
  });
  pi.registerCommand("redo", {
    description: "Alias of /forward.",
    handler: (_args, ctx) => forward(ctx),
  });
  pi.registerShortcut(BACK_SHORTCUT, {
    description: "Walk history back (same as /back).",
    handler: () => dispatchBack(),
  });
  pi.registerShortcut(FORWARD_SHORTCUT, {
    description: "Walk history forward (same as /forward).",
    handler: () => dispatchForward(),
  });
  pi.on("session_start", () => {
    forwardTargets.length = 0;
  });
}
