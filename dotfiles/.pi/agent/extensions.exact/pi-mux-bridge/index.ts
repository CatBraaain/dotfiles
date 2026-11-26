import { resolve } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { quote } from "shell-quote";
import { partitionMessageOptions, messageOptions, type AgentMessage } from "./messages.ts";
import { registerLegacyDraftRecovery } from "./first-input-handoff.ts";
import { recordDispatchTicket, recordViewReceipt, viewOptions } from "./session-metadata.ts";
import { registerSessionState } from "./session-state.ts";
import {
  dedicatedSocketPath,
  stateCommandArgs,
  type ManagedPaneBinding,
} from "./session-state-tmux.ts";
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
const MESSAGE_POLL_ERROR_ENTRY = "pi-mux-poll-error";
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
  saveDiagnostics: boolean,
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
      reportedFailures.clear();
    } catch (error) {
      if (generation === messageWatcherGeneration)
        reportMessagePollFailure(error, reportedFailures);
    } finally {
      polling = false;
    }
  }, MESSAGE_POLL_INTERVAL_MS);

  function reportMessagePollFailure(error: unknown, seen: Set<string>): void {
    if (error instanceof MessagePollCommandError && error.isPaneMissing) {
      stopMessageWatcher();
      return;
    }
    const pollError = error instanceof MessagePollError ? error : undefined;
    const diagnostic = pollError?.message ?? "message handling";
    const key = pollError?.key ?? diagnostic;
    if (seen.has(key)) return;
    seen.add(key);
    publishMessagePollFailure(pi, ctx, diagnostic, saveDiagnostics);
  }
}

function formatMessagePollError(timestamp: string, diagnostic: string): string {
  return `${timestamp} pi-mux: message polling failed: ${diagnostic}`;
}

function canSaveMessagePollDiagnostics(version: string): boolean {
  const release = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  if (!release) return false;
  const major = Number(release[1]);
  const minor = Number(release[2]);
  // Pi 1.5.0 first rolls back the session entry on write failure: https://github.com/earendil-works/pi/pull/11486
  return major > 1 || (major === 1 && minor >= 5);
}

function publishMessagePollFailure(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: ExtensionContext,
  diagnostic: string,
  saveDiagnostics: boolean,
): void {
  if (saveDiagnostics) {
    try {
      pi.appendEntry(MESSAGE_POLL_ERROR_ENTRY, diagnostic);
      return;
    } catch {
      ctx.ui.notify(
        `${formatMessagePollError(new Date().toISOString(), diagnostic)} (not saved)`,
        "warning",
      );
      return;
    }
  }
  ctx.ui.notify(formatMessagePollError(new Date().toISOString(), diagnostic), "warning");
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
    throw new MessagePollError("tmux show-options: incomplete pane option listing");
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

export default function fixedSessionExtension(pi: ExtensionAPI, version = sdk.VERSION): void {
  const saveDiagnostics = canSaveMessagePollDiagnostics(version);
  pi.registerEntryRenderer(MESSAGE_POLL_ERROR_ENTRY, ({ data, timestamp }) => {
    if (typeof data !== "string" || !data || /[^ -~]/.test(data)) return;
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) return;
    return new Text(formatMessagePollError(new Date(time).toISOString(), data), 0, 0);
  });
  pi.on("session_before_switch", (_event, ctx) => rejectSessionChange(ctx));
  pi.on("session_before_fork", (_event, ctx) => rejectSessionChange(ctx));
  let hasReloaded = false;
  pi.on("session_start", (event, ctx) => {
    hasReloaded ||= event?.reason === "reload";
    startMessageWatcher(pi, ctx, saveDiagnostics);
    if (ctx.mode === "tui") recordDispatchTicket(pi, ctx.sessionManager, process.env);
  });
  const reloadMode = captureInteractiveMode();
  let reloadProof: ReloadProof | undefined;
  let detachReloadPublisher: (() => void) | undefined;
  let isShuttingDown = false;
  let isDetachingForReload = false;
  let startupPublication: Promise<void> | undefined;
  const isCreate = process.env.PI_TMUX_STARTUP_MODE === "create";
  const startupCommand = isCreate ? undefined : process.env.PI_TMUX_STARTUP_COMMAND;
  const acceptRoute = isCreate ? "create" : "external";
  pi.on("session_shutdown", async (event, ctx) => {
    isShuttingDown = true;
    isDetachingForReload = event?.reason === "reload";
    stopMessageWatcher();
    reloadMode?.stop();
    detachReloadPublisher?.();
    if (!isDetachingForReload && reloadProof) finishReloadProof(reloadProof);
    if (startupPublication) await startupPublication;
    else if (isDetachingForReload && !hasReloaded && !startupCommand) await deferAcceptance(ctx);
  });
  const recoverDraft = startupCommand ? registerLegacyDraftRecovery(pi) : undefined;
  let ready: { id: string; pane: string; serverPid: number; panePid: number } | undefined;
  if (startupCommand) {
    pi.registerCommand(startupCommand, {
      handler: async (_args, ctx) => {
        if (isDetachingForReload && !startupPublication) {
          const request = startupRequestKey(startupCommand, launchToken());
          if (request) Reflect.set(globalThis, DEFERRED_STARTUP, request);
          return;
        }
        await startStartupPublication(ctx, "ready");
      },
    });
    pi.on("session_shutdown", async (_event, ctx) => confirmReady(ctx));
  }
  pi.on("resources_discover", async (event, ctx) => {
    if (isShuttingDown || ctx.mode !== "tui") return;
    if (event?.reason === "reload") {
      hasReloaded = true;
      reloadMode?.stop();
      const proof = currentReloadProof();
      if (proof && matchesReloadContext(proof, ctx)) {
        reloadProof = proof;
        startReloadPublisher();
      } else if (proof) {
        reloadDiagnostic("the reloaded context does not match the observed launch");
      }
      const token = process.env.PI_TMUX_LAUNCH_TOKEN;
      const request = startupCommand && token && startupRequestKey(startupCommand, token);
      if (request && Reflect.get(globalThis, DEFERRED_STARTUP) === request) {
        Reflect.deleteProperty(globalThis, DEFERRED_STARTUP);
        await startStartupPublication(ctx, "ready");
      } else if (!startupCommand && token) {
        const acceptance: DeferredAcceptance | undefined = Reflect.get(
          globalThis,
          DEFERRED_ACCEPTANCE,
        );
        if (acceptance && acceptance.key === startupRequestKey(acceptRoute, token)) {
          Reflect.deleteProperty(globalThis, DEFERRED_ACCEPTANCE);
          await startStartupPublication(ctx, "accepted", acceptance);
        }
      }
      return;
    }
    if (isCreate || (!startupCommand && isDedicatedSocket()))
      await startStartupPublication(ctx, "accepted");
  });
  registerSessionState(pi);

  async function deferAcceptance(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") return;
    try {
      if (!isDedicatedSocket()) return;
      const key = startupRequestKey(acceptRoute, launchToken());
      if (!key) return;
      const identity = await inspectManagedPane(backgroundExecutor(pi, ctx), getTmuxPaths());
      const file = ctx.sessionManager.getSessionFile();
      if (!identity || !file) return;
      const acceptance: DeferredAcceptance = {
        key,
        identity,
        id: ctx.sessionManager.getSessionId(),
        file: resolve(file),
        cwd: ctx.cwd,
      };
      Reflect.set(globalThis, DEFERRED_ACCEPTANCE, acceptance);
    } catch {
      process.stderr.write("pi-mux: cannot verify the pane for deferred startup acceptance\n");
    }
  }

  async function currentReady(ctx: ExtensionContext): Promise<typeof ready> {
    if (ctx.mode !== "tui") return;
    if (ready) return ready;
    const execute = backgroundExecutor(pi, ctx);
    const paths = getTmuxPaths();
    const identity = await inspectManagedPane(execute, paths);
    if (!identity) return;
    const { pane, pid } = identity;
    const published = await readStartupMetadata(execute, paths, pane);
    if (!published) return;
    const metadata = JSON.parse(Buffer.from(published, "base64").toString("utf8"));
    const id = ctx.sessionManager.getSessionId();
    const token = process.env.PI_TMUX_LAUNCH_TOKEN;
    if (
      !token ||
      metadata?.id !== id ||
      metadata.pid !== pid ||
      metadata.token !== token ||
      (metadata.processPid ?? pid) !== process.pid ||
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

  function startStartupPublication(
    ctx: ExtensionContext,
    startup: "accepted" | "ready",
    acceptance?: DeferredAcceptance,
  ): Promise<void> | undefined {
    if (isShuttingDown || startupPublication || ctx.mode !== "tui") return;
    startupPublication = publishStartup();
    return startupPublication;

    async function publishStartup(): Promise<void> {
      if (startup === "ready" && hasReloaded && (await currentReady(ctx))) return;
      await publish(ctx, startup, acceptance);
      if (startup === "ready" && ready?.id === ctx.sessionManager.getSessionId())
        recoverDraft?.(ctx);
    }
  }

  async function publish(
    ctx: ExtensionContext,
    startup: "accepted" | "ready",
    acceptance?: DeferredAcceptance,
  ): Promise<void> {
    let publishingReady = false;
    let verifyingAcceptance = acceptance !== undefined;
    try {
      const execute = backgroundExecutor(pi, ctx);
      const paths = getTmuxPaths();
      if (acceptance && (await readStartupMetadata(execute, paths, acceptance.identity.pane)))
        return;
      const identity = await inspectManagedPane(execute, paths);
      const expectedId = process.env.PI_TMUX_SESSION_ID;
      const id = ctx.sessionManager.getSessionId();
      if (!identity || (expectedId !== undefined && id !== expectedId)) {
        if (acceptance) return;
        throw new Error("pi-mux session identity or pane does not match the requested session");
      }
      const { pane, pid, serverPid } = identity;
      const file = ctx.sessionManager.getSessionFile();
      if (!file) {
        if (acceptance) return;
        throw new Error("pi-mux requires a persistent session");
      }
      const sessionFile = resolve(file);
      const cwd = ctx.cwd;
      const existingToken = process.env.PI_TMUX_LAUNCH_TOKEN;
      if (
        acceptance &&
        (!existingToken ||
          startupRequestKey(acceptRoute, existingToken) !== acceptance.key ||
          id !== acceptance.id ||
          cwd !== acceptance.cwd ||
          sessionFile !== acceptance.file ||
          pane !== acceptance.identity.pane ||
          pid !== acceptance.identity.pid ||
          serverPid !== acceptance.identity.serverPid)
      )
        return;
      verifyingAcceptance = false;
      const token = launchToken();
      if (!isShuttingDown && !hasReloaded) {
        try {
          reloadProof = prepareReloadProof(reloadMode?.take(), ctx, sessionFile, identity, token);
        } catch (error) {
          reloadDiagnostic(`cannot install the input wait observer: ${String(error)}`);
        }
      }
      const metadata = Buffer.from(
        JSON.stringify({
          id,
          file: sessionFile,
          cwd,
          pid,
          startup,
          token,
          ...(process.env.PI_TMUX_STARTUP_MODE === "warm" ? { warm: true } : {}),
          ...(pid === process.pid ? {} : { processPid: process.pid }),
          ...(reloadProof ? { reloadReadiness: "pending" } : {}),
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
      startReloadPublisher();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (verifyingAcceptance) {
        process.stderr.write(`pi-mux: cannot verify deferred startup acceptance: ${reason}\n`);
        return;
      }
      if (publishingReady) {
        try {
          await confirmReady(ctx);
          if (ready) {
            startReloadPublisher();
            process.stderr.write(
              `pi-mux: readiness confirmed after publication error: ${reason}\n`,
            );
            return;
          }
        } catch (verificationError) {
          if (reloadProof) finishReloadProof(reloadProof);
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
      if (reloadProof) finishReloadProof(reloadProof);
      process.stderr.write(`pi-mux: ${reason}\n`);
      ctx.ui.notify(reason, "error");
      process.exitCode = 1;
      ctx.shutdown();
    }
  }

  function startReloadPublisher(): void {
    if (
      !reloadProof ||
      isShuttingDown ||
      detachReloadPublisher ||
      reloadProof.controller.signal.aborted
    )
      return;
    detachReloadPublisher = attachReloadPublisher(reloadProof, pi);
    void reloadProof.publish?.();
  }
}

type ReloadProof = {
  id: string;
  file: string;
  cwd: string;
  source: ManagedPaneBinding;
  observed: boolean;
  publishing: boolean;
  controller: AbortController;
  stopWaiting: () => void;
  publish?: () => Promise<void>;
};

type DeferredAcceptance = {
  key: string;
  identity: ManagedPaneIdentity;
  id: string;
  file: string;
  cwd: string;
};

const DEFERRED_ACCEPTANCE = Symbol.for("pi-mux-bridge.deferred-acceptance");
const DEFERRED_STARTUP = Symbol.for("pi-mux-bridge.deferred-startup");
const RELOAD_PROOF = Symbol.for("pi-mux-bridge.reload-proof");
const VERIFIED_SDK_VERSIONS = new Set(["1.4.0", "1.6.1"]);
const INITIAL_RELOAD_PUBLICATION_RETRY_DELAY_MS = 1_000;
const MAX_RELOAD_PUBLICATION_RETRY_DELAY_MS = 30_000;
const STARTUP_INPUT_DRAINED_ACK = "PI_MUX_STARTUP_INPUT_DRAINED";
const SESSION_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const LAUNCH_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function startupRequestKey(command: string, token: string): string | undefined {
  const { TMUX, TMUX_PANE, PI_TMUX_SESSION_ID } = process.env;
  if (!TMUX || !TMUX_PANE) return;
  return JSON.stringify([TMUX, TMUX_PANE, PI_TMUX_SESSION_ID, token, command]);
}

async function readStartupMetadata(
  execute: Execute,
  paths: TmuxPaths,
  pane: string,
): Promise<string> {
  const result = await execute(
    "tmux",
    tmuxArgs(paths, ["display-message", "-p", "-t", pane, "#{@pi-tmux-session}"]),
  );
  return result.stdout.trim();
}

function isDedicatedSocket(): boolean {
  return (process.env.TMUX ?? "").split(",")[0] === dedicatedSocketPath();
}

function currentReloadProof(): ReloadProof | undefined {
  const prototype = sdk.InteractiveMode?.prototype;
  return prototype && Reflect.get(prototype, RELOAD_PROOF);
}

function captureInteractiveMode() {
  const prototype = sdk.InteractiveMode?.prototype;
  if (!prototype || !VERIFIED_SDK_VERSIONS.has(sdk.VERSION) || currentReloadProof()) return;
  const run = prototype.run;
  if (typeof run !== "function" || typeof prototype.getUserInput !== "function") return;
  try {
    if (!process.env.TMUX || !isDedicatedSocket()) return;
  } catch (error) {
    reloadDiagnostic(String(error));
    return;
  }
  let getMode: (() => InteractiveMode) | undefined;
  if (!Reflect.set(prototype, "run", captureRun)) return;
  return { stop, take };

  function captureRun(this: InteractiveMode): Promise<void> {
    stop();
    getMode = () => this;
    return run.call(this);
  }

  function stop(): void {
    getMode = undefined;
    if (prototype.run === captureRun) prototype.run = run;
  }

  function take(): InteractiveMode | undefined {
    const mode = getMode?.();
    stop();
    return mode;
  }
}

function matchesReloadContext(proof: ReloadProof, ctx: ExtensionContext): boolean {
  const file = ctx.sessionManager.getSessionFile();
  return (
    !!file &&
    proof.id === ctx.sessionManager.getSessionId() &&
    proof.file === resolve(file) &&
    proof.cwd === ctx.cwd &&
    isDedicatedSocket() &&
    proof.source.socketPath === dedicatedSocketPath() &&
    proof.source.paneId === process.env.TMUX_PANE &&
    proof.source.token === process.env.PI_TMUX_LAUNCH_TOKEN
  );
}

function finishReloadProof(proof: ReloadProof): void {
  proof.controller.abort();
  delete proof.publish;
  proof.stopWaiting();
  if (currentReloadProof() === proof)
    Reflect.deleteProperty(sdk.InteractiveMode.prototype, RELOAD_PROOF);
}

// Pi has no extension event after CLI prompts; observe the editor wait in run(): https://github.com/earendil-works/pi/blob/v1.6.1/packages/coding-agent/src/modes/interactive/interactive-mode.ts
function prepareReloadProof(
  mode: InteractiveMode | undefined,
  ctx: ExtensionContext,
  file: string,
  { pane, serverPid, pid }: ManagedPaneIdentity,
  token: string,
): ReloadProof | undefined {
  if (!mode || !hasObservableEditorWait(mode)) {
    reloadDiagnostic(`cannot verify the input wait in pi ${sdk.VERSION ?? "unknown"}`);
    return;
  }
  const id = ctx.sessionManager.getSessionId();
  if (
    !SESSION_ID.test(id) ||
    !LAUNCH_TOKEN.test(token) ||
    !/^%\d+$/.test(pane) ||
    !Number.isSafeInteger(serverPid) ||
    serverPid <= 0 ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    mode["sessionManager"] !== ctx.sessionManager ||
    Object.hasOwn(mode, "getUserInput") ||
    currentReloadProof()
  ) {
    reloadDiagnostic("cannot verify the launch identity");
    return;
  }

  const getUserInput = mode.getUserInput;
  const proof: ReloadProof = {
    id,
    file,
    cwd: ctx.cwd,
    source: { socketPath: dedicatedSocketPath(), serverPid, paneId: pane, pid: process.pid, token },
    observed: false,
    publishing: false,
    controller: new AbortController(),
    stopWaiting,
  };
  if (!Reflect.set(mode, "getUserInput", observeEditorWait)) {
    reloadDiagnostic("cannot install the input wait observer");
    return;
  }
  if (!Reflect.set(sdk.InteractiveMode.prototype, RELOAD_PROOF, proof)) {
    stopWaiting();
    reloadDiagnostic("cannot retain the input wait observer");
    return;
  }
  return proof;

  function stopWaiting(): void {
    if (mode!.getUserInput === observeEditorWait) Reflect.deleteProperty(mode!, "getUserInput");
  }

  function observeEditorWait(this: InteractiveMode): Promise<string> {
    if (this !== mode || proof.controller.signal.aborted) return getUserInput.call(this);
    if (!hasObservableEditorWait(this)) {
      finishReloadProof(proof);
      reloadDiagnostic(`cannot verify the input queue in pi ${sdk.VERSION}`);
      return getUserInput.call(this);
    }
    const manager = this["sessionManager"];
    const file = manager.getSessionFile();
    if (
      manager.getSessionId() !== proof.id ||
      !file ||
      resolve(file) !== proof.file ||
      manager.getCwd() !== proof.cwd
    ) {
      finishReloadProof(proof);
      reloadDiagnostic("input wait no longer matches the launch session");
      return getUserInput.call(this);
    }
    const isQueueEmpty = this["pendingUserInputs"].length === 0;
    const before = this["onInputCallback"];
    const input = getUserInput.call(this);
    const after = this["onInputCallback"];
    if (isQueueEmpty && typeof after === "function" && after !== before) {
      proof.observed = true;
      stopWaiting();
      void proof.publish?.();
    }
    return input;
  }
}

function hasObservableEditorWait(mode: InteractiveMode): boolean {
  return (
    typeof mode.getUserInput === "function" &&
    Array.isArray(mode["pendingUserInputs"]) &&
    "onInputCallback" in mode
  );
}

function attachReloadPublisher(proof: ReloadProof, pi: Pick<ExtensionAPI, "exec">): () => void {
  const args = stateCommandArgs(proof.source, proof.id, ["--startup-input-drained"]);
  const signal = proof.controller.signal;
  let retryDelayMs = INITIAL_RELOAD_PUBLICATION_RETRY_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  proof.publish = publish;
  return () => {
    if (isAttached()) delete proof.publish;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  function isAttached(): boolean {
    return proof.publish === publish;
  }

  async function publish(): Promise<void> {
    if (
      !proof.observed ||
      proof.publishing ||
      retryTimer !== undefined ||
      signal.aborted ||
      !isAttached()
    )
      return;
    proof.publishing = true;
    try {
      const wasPublished = await sendProof();
      if (signal.aborted) return;
      if (wasPublished) finishReloadProof(proof);
      else if (isAttached()) {
        retryTimer = setTimeout(retry, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RELOAD_PUBLICATION_RETRY_DELAY_MS);
      }
    } finally {
      proof.publishing = false;
      if (!isAttached() && !signal.aborted) void proof.publish?.();
    }
  }

  async function sendProof(): Promise<boolean> {
    try {
      // Windows must finish transport cleanup; SDK cancellation kills the CLI: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/exec.ts
      const options =
        process.platform === "win32" ? undefined : { timeout: TMUX_TIMEOUT_MS, signal };
      const result = await pi.exec("pi-mux", args, options);
      return (
        !result.killed &&
        !("truncated" in result && result.truncated) &&
        result.code === 0 &&
        result.stdout.replace(/\r?\n$/, "") === STARTUP_INPUT_DRAINED_ACK
      );
    } catch {
      return false;
    }
  }

  function retry(): void {
    retryTimer = undefined;
    void publish();
  }
}

function reloadDiagnostic(reason: string): void {
  process.stderr.write(`pi-mux: reload readiness not published: ${reason}\n`);
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

class MessagePollError extends Error {
  constructor(
    message: string,
    readonly key = message,
  ) {
    super(message);
  }
}

class MessagePollCommandError extends MessagePollError {
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
    super(`tmux ${operation} elapsed=${elapsedMs}ms ${status}`, `${operation} ${status}`);
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
