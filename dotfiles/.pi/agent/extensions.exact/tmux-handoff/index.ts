import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getTmuxPaths, inspectManagedPane, tmuxArgs } from "./shared.ts";

const TMUX_TIMEOUT_MS = 5_000;

export function rejectSessionChange(ctx: ExtensionContext): { cancel: true } | undefined {
  if (ctx.mode !== "tui") return;
  ctx.ui.notify("Conversation ID is fixed. Use pimux new or pimux open <session-id>.", "error");
  return { cancel: true };
}

export default function fixedSessionExtension(pi: ExtensionAPI): void {
  pi.on("session_before_switch", (_event, ctx) => rejectSessionChange(ctx));
  pi.on("session_before_fork", (_event, ctx) => rejectSessionChange(ctx));
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      const paths = getTmuxPaths();
      const pane = await inspectManagedPane(pi.exec, paths);
      const expectedId = process.env.PI_TMUX_SESSION_ID;
      const id = ctx.sessionManager.getSessionId();
      if (expectedId && (!pane || id !== expectedId))
        throw new Error("pimux session identity or pane does not match the requested session");
      if (!pane) return;
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("pimux requires a persistent session");
      const metadata = Buffer.from(
        JSON.stringify({ id, file: resolve(file), cwd: ctx.cwd, pid: process.pid }),
      ).toString("base64");
      const result = await pi.exec(
        "tmux",
        tmuxArgs(paths, ["set-option", "-p", "-t", pane, "@pi-tmux-session", metadata]),
        { timeout: TMUX_TIMEOUT_MS },
      );
      if (result.code !== 0 || result.killed || ("truncated" in result && result.truncated))
        throw new Error(`Cannot publish pimux session: ${result.stderr.trim()}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`pimux: ${reason}\n`);
      ctx.ui.notify(reason, "error");
      process.exitCode = 1;
      ctx.shutdown();
    }
  });
}
