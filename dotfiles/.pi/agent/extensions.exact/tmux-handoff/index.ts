import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { requestBackgroundBash } from "../tools/background-bash.ts";
import { getTmuxPaths, inspectManagedPane, tmuxArgs, type Execute } from "./shared.ts";

const TMUX_TIMEOUT_S = 1;

export function rejectSessionChange(ctx: ExtensionContext): { cancel: true } | undefined {
  if (ctx.mode !== "tui") return;
  ctx.ui.notify("Conversation ID is fixed. Use pi-mux new or pi-mux open <session-id>.", "error");
  return { cancel: true };
}

export default function fixedSessionExtension(pi: ExtensionAPI): void {
  pi.on("session_before_switch", (_event, ctx) => rejectSessionChange(ctx));
  pi.on("session_before_fork", (_event, ctx) => rejectSessionChange(ctx));
  const startupCommand = process.env.PI_TMUX_STARTUP_COMMAND;
  let startupPending = true;
  if (process.env.PI_TMUX_STARTUP_MODE === "create")
    pi.on("resources_discover", async (_event, ctx) => publish(ctx, "accepted"));
  else if (startupCommand)
    pi.registerCommand(startupCommand, { handler: async (_args, ctx) => publish(ctx, "ready") });

  async function publish(ctx: ExtensionContext, startup: "accepted" | "ready"): Promise<void> {
    if (ctx.mode !== "tui" || !startupPending) return;
    startupPending = false;
    try {
      const execute = backgroundExecutor(ctx);
      const paths = getTmuxPaths();
      const pane = await inspectManagedPane(execute, paths);
      const expectedId = process.env.PI_TMUX_SESSION_ID;
      const id = ctx.sessionManager.getSessionId();
      if (!expectedId || !pane || id !== expectedId)
        throw new Error("pi-mux session identity or pane does not match the requested session");
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("pi-mux requires a persistent session");
      const metadata = Buffer.from(
        JSON.stringify({ id, file: resolve(file), cwd: ctx.cwd, pid: process.pid, startup }),
      ).toString("base64");
      await execute(
        "tmux",
        tmuxArgs(paths, ["set-option", "-p", "-t", pane, "@pi-tmux-session", metadata]),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`pi-mux: ${reason}\n`);
      ctx.ui.notify(reason, "error");
      process.exitCode = 1;
      ctx.shutdown();
    }
  }
}

function backgroundExecutor(ctx: ExtensionContext): Execute {
  return async function execute(command, args) {
    const outcome = await requestBackgroundBash({
      id: "tmux-handoff-startup",
      params: { command: quote([command, ...args]), timeout: TMUX_TIMEOUT_S },
      context: ctx,
    });
    if (outcome.status !== "completed") {
      const reason = outcome.status === "aborted" ? outcome.reason : outcome.error;
      throw new Error(`Cannot execute pi-mux startup Bash (${outcome.status}): ${String(reason)}`);
    }
    const stdout = outcome.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (outcome.result.isError) throw new Error(`pi-mux startup Bash failed: ${stdout}`);
    return { stdout, stderr: "", code: 0, killed: false };
  };
}
