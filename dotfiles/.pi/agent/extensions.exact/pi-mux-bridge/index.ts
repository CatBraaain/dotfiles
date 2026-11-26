import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { partitionMessageOptions, messageOptions, type AgentMessage } from "./messages.ts";
import { registerLegacyDraftRecovery } from "./first-input-handoff.ts";
import { recordDispatchTicket, recordViewReceipt, viewOptions } from "./session-metadata.ts";
import { registerSessionState } from "./session-state.ts";
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
const TMUX_SUBCOMMAND_INDEX = 4;
const PANE_MISSING_REASON =
  /^(?:(?:tmux|psmux|ERROR):[ \t]*)?(?:(?:can't find pane|no such pane)(?::[^\r\n]*)?|no sessions)$/;
const PANE_IDENTITY_MARKER = "pi-mux-rx:";
const PANE_IDENTITY_FORMAT = `${PANE_IDENTITY_MARKER}#{pid},#{pane_id},#{pane_pid}`;
const PANE_IDENTITY_LINE = /^pi-mux-rx:\d+,%\d+,\d+$/;

export function rejectSessionChange(ctx: ExtensionContext): { cancel: true } | undefined {
  if (ctx.mode !== "tui") return;
  ctx.ui.notify("Conversation ID is fixed. Use pi-mux new or pi-mux open <session-id>.", "error");
  return { cancel: true };
}

let messageTimer: ReturnType<typeof setInterval> | undefined;
let messageWatcherGeneration = 0;
let messageIdentity: ManagedPaneIdentity | undefined;
const injectedMessageNames = new Set<string>();
const consumedViewOptions = new Set<string>();

export function stopMessageWatcher(): void {
  messageWatcherGeneration++;
  if (messageTimer !== undefined) {
    clearInterval(messageTimer);
    messageTimer = undefined;
  }
  messageIdentity = undefined;
  injectedMessageNames.clear();
  consumedViewOptions.clear();
}

function startMessageWatcher(
  pi: Pick<ExtensionAPI, "exec" | "sendMessage" | "appendEntry">,
  ctx: ExtensionContext,
): void {
  stopMessageWatcher();
  if (ctx.mode !== "tui") return;
  if ((process.env.TMUX ?? "").split(",")[0] !== getTmuxPaths().socketPath) return;
  const generation = messageWatcherGeneration;
  const reportedFailures = new Set<string>();
  let polling = false;
  messageTimer = setInterval(async () => {
    if (polling || generation !== messageWatcherGeneration) return;
    polling = true;
    try {
      await drainAgentMessages(pi, ctx);
    } catch (error) {
      if (generation === messageWatcherGeneration)
        reportMessagePollFailure(error, reportedFailures);
    } finally {
      polling = false;
    }
  }, MESSAGE_POLL_INTERVAL_MS);
}

function reportMessagePollFailure(error: unknown, reportedFailures: Set<string>): void {
  const commandError = error instanceof MessagePollCommandError ? error : undefined;
  if (commandError?.isPaneMissing) {
    stopMessageWatcher();
    return;
  }
  const key = commandError?.key ?? "message handling";
  if (reportedFailures.has(key)) return;
  reportedFailures.add(key);
  process.stderr.write(`pi-mux: message polling failed: ${commandError?.message ?? key}\n`);
}

export async function drainAgentMessages(
  pi: Pick<ExtensionAPI, "exec" | "sendMessage" | "appendEntry">,
  ctx: ExtensionContext,
): Promise<void> {
  const generation = messageWatcherGeneration;
  function isCurrentWatcher(): boolean {
    return generation === messageWatcherGeneration;
  }

  const paths = getTmuxPaths();
  const execute = messageExecutor(pi, ctx);
  let identity = messageIdentity;
  if (!identity) {
    identity = await inspectManagedPane(execute, paths);
    if (!isCurrentWatcher()) return;
    if (!identity) {
      stopMessageWatcher();
      return;
    }
    messageIdentity = identity;
  }
  const listing = await readMessageOptions(execute, paths, identity);
  if (!isCurrentWatcher()) return;
  if (listing === undefined) {
    stopMessageWatcher();
    return;
  }
  let firstOptionFailure: { error: unknown } | undefined;
  for (const { name, encoded } of viewOptions(listing)) {
    await handleOption(async () => {
      if (!consumedViewOptions.has(name)) {
        recordViewReceipt(pi, ctx.sessionManager, encoded);
        if (!isCurrentWatcher()) return;
        consumedViewOptions.add(name);
      }
      await unsetMessageOption(execute, paths, identity, name);
      if (!isCurrentWatcher()) return;
      consumedViewOptions.delete(name);
    });
    if (!isCurrentWatcher()) return;
  }
  const { valid, invalid } = partitionMessageOptions(messageOptions(listing));
  for (const name of invalid) {
    await handleOption(() => unsetMessageOption(execute, paths, identity, name));
    if (!isCurrentWatcher()) return;
  }
  for (const { name, message } of valid) {
    await handleOption(async () => {
      if (!injectedMessageNames.has(name)) {
        deliverAgentMessage(pi, name, message);
        if (!isCurrentWatcher()) return;
        injectedMessageNames.add(name);
      }
      await unsetMessageOption(execute, paths, identity, name);
    });
    if (!isCurrentWatcher()) return;
  }
  if (firstOptionFailure) throw firstOptionFailure.error;

  async function handleOption(handle: () => Promise<void>): Promise<void> {
    try {
      await handle();
    } catch (error) {
      if (error instanceof MessagePollCommandError && error.isPaneMissing) throw error;
      firstOptionFailure ??= { error };
    }
  }
}

async function readMessageOptions(
  execute: MessageExecute,
  paths: TmuxPaths,
  { pane, pid, serverPid }: ManagedPaneIdentity,
): Promise<string | undefined> {
  const identityQuery = `${quote(["display-message", "-p", "-t", pane])} "${PANE_IDENTITY_FORMAT}"`;
  const optionQuery = quote(["show-options", "-p", "-t", pane]);
  const commandList = [identityQuery, optionQuery, identityQuery].join(" ; ");
  // psmux needs the literal condition to forward the list without a separate format request: https://github.com/psmux/psmux/blob/v3.4.0/src/main.rs#L4782-L4824
  const wrapper = process.platform === "win32" ? ["if-shell", "1"] : ["if-shell", "-F", "1"];
  const { stdout } = await execute(
    "tmux",
    tmuxArgs(paths, [...wrapper, commandList]),
    undefined,
    "show-options",
  );
  const [before = "", ...options] = stdout.trimEnd().split(/\r?\n/);
  const after = options.pop();
  const hasInitialIdentity = PANE_IDENTITY_LINE.test(before);
  const missingReason = hasInitialIdentity && options.length === 0 ? after : before;
  if (options.length === 0 && missingReason && PANE_MISSING_REASON.test(missingReason))
    return undefined;
  if (!hasInitialIdentity || !after || !PANE_IDENTITY_LINE.test(after)) {
    throw new Error("Incomplete pane option listing");
  }
  const expected = `${PANE_IDENTITY_MARKER}${serverPid},${pane},${pid}`;
  if (before !== expected || after !== expected) return undefined;
  return options.join("\n");
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
  // psmux keeps the backslash before @ in unquoted option names: https://github.com/psmux/psmux/blob/v3.4.0/src/commands.rs#L883-L938
  const option = quote([name]).replace(/^\\@/, "@");
  await execute(
    "tmux",
    tmuxArgs(paths, [
      "if-shell",
      "-F",
      "-t",
      identity.pane,
      `#{&&:#{==:#{pid},${identity.serverPid}},#{==:#{pane_pid},${identity.pid}}}`,
      `${quote(["set-option", "-pu", "-t", identity.pane])} ${option}`,
    ]),
  );
}

export default function fixedSessionExtension(pi: ExtensionAPI): void {
  pi.on("session_before_switch", (_event, ctx) => rejectSessionChange(ctx));
  pi.on("session_before_fork", (_event, ctx) => rejectSessionChange(ctx));
  pi.on("session_start", (_event, ctx) => {
    startMessageWatcher(pi, ctx);
    if (ctx.mode === "tui") recordDispatchTicket(pi, ctx.sessionManager, process.env);
  });
  pi.on("session_shutdown", () => stopMessageWatcher());
  const startupCommand = process.env.PI_TMUX_STARTUP_COMMAND;
  let startupPending = true;
  let ready: { id: string; pane: string; serverPid: number; panePid: number } | undefined;
  if (process.env.PI_TMUX_STARTUP_MODE === "create")
    pi.on("resources_discover", async (_event, ctx) => publish(ctx, "accepted"));
  else if (startupCommand) {
    const recoverDraft = registerLegacyDraftRecovery(pi);
    pi.registerCommand(startupCommand, {
      handler: async (_args, ctx) => {
        await publish(ctx, "ready");
        if (ready?.id === ctx.sessionManager.getSessionId()) recoverDraft(ctx);
      },
    });
    pi.on("session_shutdown", async (_event, ctx) => confirmReady(ctx));
  } else {
    pi.on("resources_discover", async (_event, ctx) => {
      if ((process.env.TMUX ?? "").split(",")[0] !== getTmuxPaths().socketPath) return;
      await publish(ctx, "accepted");
    });
  }

  registerSessionState(pi);

  async function currentReady(ctx: ExtensionContext): Promise<typeof ready> {
    if (ctx.mode !== "tui") return;
    if (ready) return ready;
    const execute = backgroundExecutor(pi, ctx);
    const paths = getTmuxPaths();
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
    return ready;
  }

  async function confirmReady(ctx: ExtensionContext): Promise<void> {
    const identity = await currentReady(ctx);
    if (!identity) return;
    const { id, pane, serverPid, panePid } = identity;
    await backgroundExecutor(pi, ctx)(
      "tmux",
      tmuxArgs(getTmuxPaths(), [
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
          ...(process.env.PI_TMUX_STARTUP_MODE === "warm" ? { warm: true } : {}),
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

type MessageExecResult = Awaited<ReturnType<Execute>> & { truncated?: boolean };
type MessageExecute = (
  ...args: [...Parameters<Execute>, operationName?: string]
) => Promise<MessageExecResult>;

class MessagePollCommandError extends Error {
  readonly key: string;
  readonly isPaneMissing: boolean;

  constructor(
    operation: string,
    elapsedMs: number,
    result?: MessageExecResult,
    rejection?: unknown,
  ) {
    const truncated = result?.truncated === true;
    const timeout =
      !result || (result.killed && truncated) ? "unknown" : result.killed ? "yes" : "no";
    const execCode =
      result?.killed && result.code === 0 && result.truncated === undefined
        ? "unknown"
        : (result?.code ?? "unknown");
    const truncation = result ? (truncated ? "yes" : "no") : "unknown";
    const status = `exec_code=${execCode} timeout=${timeout} truncated=${truncation}`;
    super(`tmux ${operation} elapsed=${elapsedMs}ms ${status}`);
    this.key = `${operation} ${status}`;
    const reason = result
      ? result.stderr || result.stdout
      : rejection instanceof Error
        ? rejection.message
        : String(rejection);
    this.isPaneMissing = PANE_MISSING_REASON.test(reason.trim());
  }
}

function messageExecutor(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionContext): MessageExecute {
  return async function execute(command, args, options, operationName) {
    const operation = operationName ?? args[TMUX_SUBCOMMAND_INDEX] ?? "unknown";
    const startedMs = performance.now();
    let result: MessageExecResult;
    try {
      result = await pi.exec(command, args, {
        cwd: ctx.cwd,
        timeout: options?.timeout ?? TMUX_TIMEOUT_MS,
      });
    } catch (error) {
      throw new MessagePollCommandError(
        operation,
        Math.round(performance.now() - startedMs),
        undefined,
        error,
      );
    }
    if (result.killed || result.truncated === true || result.code !== 0)
      throw new MessagePollCommandError(
        operation,
        Math.round(performance.now() - startedMs),
        result,
      );
    return result;
  };
}
