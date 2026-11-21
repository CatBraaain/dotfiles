import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { partitionMessageOptions, messageOptions, type AgentMessage } from "./messages.ts";
import {
  getTmuxPaths,
  inspectManagedPane,
  launchToken,
  tmuxArgs,
  type Execute,
  type ManagedPaneIdentity,
  type TmuxPaths,
} from "./shared.ts";

const TMUX_TIMEOUT_MS = 1_000;
const MESSAGE_POLL_INTERVAL_MS = 2_000;

export function rejectSessionChange(ctx: ExtensionContext): { cancel: true } | undefined {
  if (ctx.mode !== "tui") return;
  ctx.ui.notify("Conversation ID is fixed. Use pi-mux new or pi-mux open <session-id>.", "error");
  return { cancel: true };
}

let messageTimer: ReturnType<typeof setInterval> | undefined;
let messageIdentity: ManagedPaneIdentity | undefined;
const injectedMessageNames = new Set<string>();
let lastMessageFailure: string | undefined;

export function stopMessageWatcher(): void {
  if (messageTimer !== undefined) {
    clearInterval(messageTimer);
    messageTimer = undefined;
  }
  messageIdentity = undefined;
  injectedMessageNames.clear();
  lastMessageFailure = undefined;
}

function startMessageWatcher(
  pi: Pick<ExtensionAPI, "exec" | "sendMessage">,
  ctx: ExtensionContext,
): void {
  stopMessageWatcher();
  if (ctx.mode !== "tui") return;
  if ((process.env.TMUX ?? "").split(",")[0] !== getTmuxPaths().socketPath) return;
  messageTimer = setInterval(() => {
    drainAgentMessages(pi, ctx).catch((error) => reportMessagePollFailure(error));
  }, MESSAGE_POLL_INTERVAL_MS);
}

function reportMessagePollFailure(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  if (
    /can't find pane|no such pane|no server running|error connecting to|no sessions/.test(reason)
  ) {
    stopMessageWatcher();
    return;
  }
  if (reason === lastMessageFailure) return;
  lastMessageFailure = reason;
  process.stderr.write(`pi-mux: message polling failed: ${reason}\n`);
}

export async function drainAgentMessages(
  pi: Pick<ExtensionAPI, "exec" | "sendMessage">,
  ctx: ExtensionContext,
): Promise<void> {
  const paths = getTmuxPaths();
  const execute = messageExecutor(pi, ctx);
  messageIdentity ??= await inspectManagedPane(execute, paths);
  if (!messageIdentity) {
    stopMessageWatcher();
    return;
  }
  const identity = messageIdentity;
  const listing = await execute(
    "tmux",
    tmuxArgs(paths, ["show-options", "-p", "-t", identity.pane]),
  );
  const { valid, invalid } = partitionMessageOptions(messageOptions(listing.stdout));
  for (const name of invalid) await unsetMessageOption(execute, paths, identity, name);
  for (const { name, message } of valid) {
    if (!injectedMessageNames.has(name)) {
      deliverAgentMessage(pi, name, message);
      injectedMessageNames.add(name);
    }
    await unsetMessageOption(execute, paths, identity, name);
  }
}

function deliverAgentMessage(
  pi: Pick<ExtensionAPI, "sendMessage">,
  optionName: string,
  message: AgentMessage,
): void {
  pi.sendMessage(
    {
      customType: "agent-message",
      content: `Message from pi session ${message.from} at ${message.at}:\n${message.text}`,
      display: true,
      details: { from: message.from, at: message.at, optionName },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

async function unsetMessageOption(
  execute: Execute,
  paths: TmuxPaths,
  identity: ManagedPaneIdentity,
  name: string,
): Promise<void> {
  await execute(
    "tmux",
    tmuxArgs(paths, [
      "if-shell",
      "-F",
      "-t",
      identity.pane,
      `#{&&:#{==:#{pid},${identity.serverPid}},#{==:#{pane_pid},${identity.pid}}}`,
      quote(["set-option", "-pu", "-t", identity.pane, name]),
    ]),
  );
}

export default function fixedSessionExtension(pi: ExtensionAPI): void {
  pi.on("session_before_switch", (_event, ctx) => rejectSessionChange(ctx));
  pi.on("session_before_fork", (_event, ctx) => rejectSessionChange(ctx));
  pi.on("session_start", (_event, ctx) => startMessageWatcher(pi, ctx));
  pi.on("session_shutdown", () => stopMessageWatcher());
  const startupCommand = process.env.PI_TMUX_STARTUP_COMMAND;
  let startupPending = true;
  let ready: { id: string; pane: string; serverPid: number; panePid: number } | undefined;
  if (process.env.PI_TMUX_STARTUP_MODE === "create")
    pi.on("resources_discover", async (_event, ctx) => publish(ctx, "accepted"));
  else if (startupCommand) {
    pi.registerCommand(startupCommand, { handler: async (_args, ctx) => publish(ctx, "ready") });
    pi.on("session_shutdown", async (_event, ctx) => confirmReady(ctx));
  } else {
    pi.on("resources_discover", async (_event, ctx) => {
      if ((process.env.TMUX ?? "").split(",")[0] !== getTmuxPaths().socketPath) return;
      await publish(ctx, "accepted");
    });
  }

  async function confirmReady(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") return;
    const execute = backgroundExecutor(pi, ctx);
    const paths = getTmuxPaths();
    if (!ready) {
      const identity = await inspectManagedPane(execute, paths);
      if (!identity) return;
      const { pane, pid } = identity;
      const published = await execute(
        "tmux",
        tmuxArgs(paths, ["display-message", "-p", "-t", pane, "#{@pi-tmux-session}"]),
      );
      if (!published.stdout.trim()) return;
      const metadata = JSON.parse(Buffer.from(published.stdout.trim(), "base64").toString("utf8"));
      const id = ctx.sessionManager.getSessionId();
      if (
        metadata?.id !== id ||
        metadata.pid !== pid ||
        metadata.token !== launchToken() ||
        (metadata.processPid !== undefined && metadata.processPid !== process.pid) ||
        metadata.startup !== "ready"
      )
        return;
      ready = { id, pane, serverPid: identity.serverPid, panePid: pid };
    }
    const { id, pane, serverPid, panePid } = ready;
    await execute(
      "tmux",
      tmuxArgs(paths, [
        "if-shell",
        "-F",
        "-t",
        pane,
        `#{&&:#{==:#{pid},${serverPid}},#{==:#{pane_pid},${panePid}}}`,
        quote(["set-option", "-gu", `@pi-mux-restoring-${id}`]),
      ]),
    );
  }

  async function publish(ctx: ExtensionContext, startup: "accepted" | "ready"): Promise<void> {
    if (ctx.mode !== "tui" || !startupPending) return;
    startupPending = false;
    let publishingReady = false;
    try {
      const execute = backgroundExecutor(pi, ctx);
      const paths = getTmuxPaths();
      const identity = await inspectManagedPane(execute, paths);
      const expectedId = process.env.PI_TMUX_SESSION_ID;
      const id = ctx.sessionManager.getSessionId();
      if (!identity || (expectedId !== undefined && id !== expectedId))
        throw new Error("pi-mux session identity or pane does not match the requested session");
      const { pane, pid } = identity;
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("pi-mux requires a persistent session");
      const metadata = Buffer.from(
        JSON.stringify({
          id,
          file: resolve(file),
          cwd: ctx.cwd,
          pid,
          startup,
          token: launchToken(),
          ...(pid === process.pid ? {} : { processPid: process.pid }),
        }),
      ).toString("base64");
      publishingReady = startup === "ready";
      await execute(
        "tmux",
        tmuxArgs(paths, ["set-option", "-p", "-t", pane, "@pi-tmux-session", metadata]),
      );
      if (startup === "ready") {
        ready = { id, pane, serverPid: identity.serverPid, panePid: identity.pid };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (publishingReady) {
        try {
          await confirmReady(ctx);
          if (ready) {
            process.stderr.write(
              `pi-mux: readiness confirmed after publication error: ${reason}\n`,
            );
            return;
          }
        } catch (verificationError) {
          const verificationReason =
            verificationError instanceof Error
              ? verificationError.message
              : String(verificationError);
          const warning = `Cannot confirm startup publication: ${reason}; ${verificationReason}`;
          process.stderr.write(`pi-mux: ${warning}\n`);
          ctx.ui.notify(warning, "warning");
          return;
        }
      }
      process.stderr.write(`pi-mux: ${reason}\n`);
      ctx.ui.notify(reason, "error");
      process.exitCode = 1;
      ctx.shutdown();
    }
  }
}

function backgroundExecutor(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionContext): Execute {
  return async function execute(command, args, options) {
    const result = await pi.exec(command, args, {
      cwd: ctx.cwd,
      timeout: options?.timeout ?? TMUX_TIMEOUT_MS,
    });
    if (result.killed || ("truncated" in result && result.truncated === true) || result.code !== 0)
      throw new Error(`pi-mux startup failed: ${result.stderr || result.stdout || result.code}`);
    return result;
  };
}

function messageExecutor(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionContext): Execute {
  return async function execute(command, args, options) {
    const result = await pi.exec(command, args, {
      cwd: ctx.cwd,
      timeout: options?.timeout ?? TMUX_TIMEOUT_MS,
    });
    if (result.killed || ("truncated" in result && result.truncated === true) || result.code !== 0)
      throw new Error(`tmux failed: ${result.stderr || result.stdout || result.code}`);
    return result;
  };
}
