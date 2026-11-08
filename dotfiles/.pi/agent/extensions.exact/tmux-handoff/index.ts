import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  consumeStartup,
  ensureTmuxDirectories,
  findExecutable,
  getTmuxPaths,
  handoff,
  inspectManagedPane,
  pidStartTime,
  publishConnection,
  removeProvisionalSession,
} from "./shared.ts";

export function isInteractiveCli(ctx: Pick<ExtensionContext, "mode">): boolean {
  if (ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY || !process.argv[1])
    return false;
  const packageDir = getPackageDir();
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  return realpathSync(process.argv[1]) === realpathSync(join(packageDir, metadata.bin.pi));
}

export default function tmuxHandoffExtension(pi: ExtensionAPI): void {
  let recordPath: string | undefined;
  let exitCleanup: (() => void) | undefined;

  function removeRecord(): void {
    if (recordPath) rmSync(recordPath, { force: true });
    recordPath = undefined;
    if (exitCleanup) process.off("exit", exitCleanup);
    exitCleanup = undefined;
  }

  pi.on("session_start", async (event, ctx) => {
    try {
      if (!isInteractiveCli(ctx)) return;
      const paths = getTmuxPaths();
      const isDedicatedSocket = process.env.TMUX?.startsWith(paths.socketPath + ",");
      if (event.reason !== "startup" && !isDedicatedSocket) return;
      const tmux = findExecutable("tmux");
      const pane = await inspectManagedPane(pi.exec, paths, tmux);
      if (process.env.PI_TMUX_HANDOFF && !pane)
        throw new Error("Handoff marker does not match the live tmux pane");
      if (pane) {
        ensureTmuxDirectories(paths);
        const startup = consumeStartup(paths, ctx.sessionManager.getSessionId());
        if (startup) ctx.ui.setEditorText(startup.editorText);
        recordPath = publishConnection(paths, {
          version: 1,
          instanceId: startup?.instanceId ?? randomUUID(),
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: ctx.sessionManager.getSessionFile() ?? null,
          ...pane,
          pidStartTime: pidStartTime(),
        });
        exitCleanup = removeRecord;
        process.once("exit", exitCleanup);
        if (startup?.provisionalSessionFile) {
          const path = startup.provisionalSessionFile;
          const sessionId = startup.sessionId;
          process.once("exit", () => {
            try {
              removeProvisionalSession(path, sessionId);
            } catch {
              process.stderr.write("tmux-handoff: provisional session cleanup failed\n");
            }
          });
        }
        return;
      }
      if (event.reason !== "startup") return;
      await ctx.ui.custom<never>(async (tui) => {
        tui.stop();
        try {
          if (typeof process.execve !== "function") throw new Error("Node.js execve is required");
          ensureTmuxDirectories(paths);
          return await handoff(pi, ctx, paths, tmux);
        } catch (error) {
          process.stderr.write(
            `tmux-handoff: ${error instanceof Error ? error.message : "handoff failed"}\n`,
          );
          process.exit(1);
        }
      });
    } catch (error) {
      await ctx.ui.custom<never>((tui) => {
        tui.stop();
        process.stderr.write(
          `tmux-handoff: ${error instanceof Error ? error.message : "startup failed"}\n`,
        );
        process.exit(1);
      });
    }
  });
  pi.on("session_shutdown", removeRecord);
}
