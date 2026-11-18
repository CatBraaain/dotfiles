import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { subagentSessionDir } from "../agents/index.ts";
import {
  detectManagedPane,
  publishState,
  unsetStateOption,
  type BashRunner,
  type ManagedPaneBinding,
  type PublicationOutcome,
  type SessionState,
} from "./tmux.ts";

const TMUX_COMMAND_TIMEOUT_MS = 1_000;
const LOCK_RETRY_INTERVAL_MS = 50;
const RECOVERY_RETRY_INTERVAL_MS = 1_000;
const MAX_NOTIFICATION_LENGTH = 200;
const PUBLICATION_PROCESS_KEY = Symbol.for("pi.session-state.publication-process");

interface ExecutionBoundary {
  settled: boolean;
  promise: Promise<void>;
}

interface PublicationProcess {
  queue: Promise<void>;
  execution?: ExecutionBoundary;
  controller?: AbortController;
}

const shared = globalThis as typeof globalThis & {
  [PUBLICATION_PROCESS_KEY]?: PublicationProcess;
};
const publicationProcess = (shared[PUBLICATION_PROCESS_KEY] ??= { queue: Promise.resolve() });

const PROBE_TAG = "DEBUG-pistateprobe-20261115";

function probe(kind: string, fields: Record<string, unknown> = {}): void {
  const record = {
    tag: PROBE_TAG,
    ts: new Date().toISOString(),
    pid: process.pid,
    kind,
    ...fields,
  };
  try {
    appendFileSync(
      process.env.PI_STATE_PROBE_LOG ?? "/tmp/work/dotfiles/state-probe/events.jsonl",
      `${JSON.stringify(record)}\n`,
    );
  } catch {}
}

function sha256Prefix(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
  } catch {
    return undefined;
  }
}

function probeLoadedVersion(): void {
  try {
    probe("loaded", {
      cwd: process.cwd(),
      url: import.meta.url,
      indexSha256: sha256Prefix(fileURLToPath(import.meta.url)),
      tmuxSha256: sha256Prefix(fileURLToPath(new URL("./tmux.ts", import.meta.url))),
      nodeVersion: process.version,
    });
  } catch {}
}

probeLoadedVersion();

export type { SessionState } from "./tmux.ts";

interface PublicationGeneration {
  controller: AbortController;
  initializationStarted: boolean;
  binding?: ManagedPaneBinding;
  state?: SessionState;
  lastPublished?: { state: SessionState; title: string | null };
  pending: number;
  recoveryNotified: boolean;
  title: string | null;
  sessionId: string;
  run: BashRunner;
  lastFailure: () => unknown;
  environment: Pick<NodeJS.ProcessEnv, "XDG_RUNTIME_DIR" | "TMUX" | "TMUX_PANE">;
  notify: (message: string) => void;
}

export default function sessionStateExtension(pi: ExtensionAPI): void {
  let generation: PublicationGeneration | undefined;
  let isAgentRunActive = false;
  let isWaitingForApproval = false;

  function identityFields(): { sessionId: string | undefined; pane: string | undefined } {
    return { sessionId: generation?.sessionId, pane: generation?.binding?.paneId };
  }

  function enqueuePublication(gen: PublicationGeneration, task: () => Promise<void>): void {
    publicationProcess.queue = publicationProcess.queue.then(task).catch((error) => {
      if (!gen.controller.signal.aborted) gen.notify(errorMessage(error));
    });
  }

  function scheduleStatePublication(
    state: SessionState,
    title: string | null = generation?.title ?? null,
  ): void {
    const gen = generation;
    if (!gen || !gen.initializationStarted) return;
    gen.state = state;
    gen.title = title;
    if (
      gen.pending === 0 &&
      gen.lastPublished?.state === state &&
      gen.lastPublished.title === title
    )
      return;
    const sessionId = gen.sessionId;
    probe("schedule", {
      sessionId,
      pane: gen.binding?.paneId,
      state,
      title,
      pending: gen.pending,
    });
    gen.pending++;
    enqueuePublication(gen, async () => {
      try {
        while (!gen.controller.signal.aborted && gen.binding) {
          if (!(await waitForPriorExecution(gen))) return;
          gen.lastPublished = undefined;
          const outcome = await publishState(gen.run, gen.binding, sessionId, state, title);
          probe("publish-outcome", {
            sessionId,
            pane: gen.binding?.paneId,
            state,
            status: outcome.status,
            ...(outcome.status === "failed" ? { message: outcome.message } : {}),
          });
          if (gen.controller.signal.aborted) return;
          const recovery = await recoveryRetry(gen, "session state publication");
          if (recovery === "aborted") return;
          if (recovery === "retry") continue;
          gen.recoveryNotified = false;
          if (outcome.status !== "busy") {
            if (outcome.status === "published") gen.lastPublished = { state, title };
            reportPublicationOutcome(gen, outcome);
            return;
          }
          if (!(await waitToRetry(gen, LOCK_RETRY_INTERVAL_MS))) return;
        }
      } finally {
        gen.pending--;
      }
    });
  }

  pi.on("session_start", (_event, ctx) => {
    publicationProcess.controller?.abort();
    generation = undefined;
    isAgentRunActive = false;
    isWaitingForApproval = false;
    if (isSubagentSession(ctx)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    publicationProcess.controller = controller;
    const environment = {
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
    };
    const runner = makeProcessRunner(pi, sessionId);
    generation = {
      controller,
      initializationStarted: false,
      pending: 0,
      recoveryNotified: false,
      sessionId: ctx.sessionManager.getSessionId(),
      title: ctx.sessionManager.getSessionName() ?? null,
      run: runner.run,
      lastFailure: runner.lastFailure,
      environment,
      notify: makeNotifier(ctx),
    };
  });

  pi.on("resources_discover", () => {
    const gen = generation;
    if (!gen || gen.initializationStarted) return;
    gen.initializationStarted = true;
    enqueuePublication(gen, async () => {
      while (!gen.controller.signal.aborted) {
        if (!(await waitForPriorExecution(gen))) return;
        const detection = await detectManagedPane(gen.run, gen.environment);
        if (gen.controller.signal.aborted) return;
        const recovery = await recoveryRetry(gen, "managed tmux pane detection");
        if (recovery === "aborted") return;
        if (recovery === "retry") continue;
        gen.recoveryNotified = false;
        if (detection.status === "managed") gen.binding = detection.binding;
        probe("pane-detection", { ...identityFields(), status: detection.status });
        if (detection.status === "failed")
          gen.notify(`cannot confirm managed tmux pane: ${detection.message}`);
        return;
      }
    });
    scheduleStatePublication("waiting-user");
  });

  pi.on("session_info_changed", (event) => {
    const gen = generation;
    if (!gen) return;
    const title = event.name ?? null;
    if (!gen.initializationStarted) {
      gen.title = title;
      return;
    }
    scheduleStatePublication(gen.state ?? "waiting-user", title);
  });

  pi.on("agent_start", () => {
    probe("agent_start", { ...identityFields(), waitingApproval: isWaitingForApproval });
    isAgentRunActive = true;
    if (!isWaitingForApproval) scheduleStatePublication("running");
  });
  pi.on("ui_prompt_start", () => {
    isWaitingForApproval = true;
    probe("ui_prompt_start", { ...identityFields(), waitingApproval: isWaitingForApproval });
    scheduleStatePublication("waiting-approval");
  });
  pi.on("ui_prompt_end", () => {
    isWaitingForApproval = false;
    probe("ui_prompt_end", { ...identityFields(), waitingApproval: isWaitingForApproval });
    scheduleStatePublication(isAgentRunActive ? "running" : "waiting-user");
  });
  pi.on("agent_settled", (event) => {
    probe("agent_settled", {
      ...identityFields(),
      aborted: event.aborted,
      waitingApproval: isWaitingForApproval,
    });
    isAgentRunActive = false;
    if (!isWaitingForApproval) scheduleStatePublication("waiting-user");
  });
  pi.on("session_shutdown", async () => {
    const gen = generation;
    generation = undefined;
    isAgentRunActive = false;
    isWaitingForApproval = false;
    if (!gen) return;
    gen.controller.abort();
    enqueuePublication(gen, async () => {
      if (!gen.binding) return;
      if (publicationProcess.execution && !publicationProcess.execution.settled) {
        probe("cleanup-skipped", {
          sessionId: gen.sessionId,
          pane: gen.binding?.paneId,
          reason: "prior-execution-unsettled",
        });
        gen.notify("cannot clear session state option: previous Bash execution is still running");
        return;
      }
      try {
        const outcome = await unsetStateOption(gen.run, gen.binding, gen.sessionId);
        probe("cleanup-outcome", {
          sessionId: gen.sessionId,
          pane: gen.binding?.paneId,
          status: outcome.status,
          ...(outcome.status === "failed" ? { message: outcome.message } : {}),
        });
        reportCleanupOutcome(gen, outcome);
      } catch (error) {
        probe("cleanup-outcome", {
          sessionId: gen.sessionId,
          pane: gen.binding?.paneId,
          status: "thrown",
          message: errorMessage(error),
        });
        gen.notify(`cannot clear session state option: ${errorMessage(error)}`);
      }
    });
    await publicationProcess.queue;
  });
}

async function recoveryRetry(
  gen: PublicationGeneration,
  operation: string,
): Promise<"proceed" | "retry" | "aborted"> {
  const failure = gen.lastFailure();
  if (failure === undefined) return "proceed";
  if (!gen.recoveryNotified) {
    gen.recoveryNotified = true;
    gen.notify(`${operation} interrupted: ${errorMessage(failure)}; retrying automatically`);
  }
  if (!(await waitForPriorExecution(gen))) return "aborted";
  return (await waitToRetry(gen, RECOVERY_RETRY_INTERVAL_MS)) ? "retry" : "aborted";
}

async function waitToRetry(gen: PublicationGeneration, milliseconds: number): Promise<boolean> {
  try {
    await delay(milliseconds, undefined, { signal: gen.controller.signal });
    return true;
  } catch (error) {
    if (!gen.controller.signal.aborted) throw error;
    return false;
  }
}

async function waitForPriorExecution(gen: PublicationGeneration): Promise<boolean> {
  const execution = publicationProcess.execution;
  if (execution && !execution.settled) {
    probe("wait-prior-execution", { sessionId: gen.sessionId, pane: gen.binding?.paneId });
    return executionSettledOrAborted(gen, execution.promise);
  }
  return !gen.controller.signal.aborted;
}

function executionSettledOrAborted(
  gen: PublicationGeneration,
  executionSettled: Promise<void>,
): Promise<boolean> {
  const signal = gen.controller.signal;
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    function onAbort(): void {
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    executionSettled.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(!signal.aborted);
    });
  });
}

function makeProcessRunner(
  pi: Pick<ExtensionAPI, "exec">,
  sessionId: string,
): {
  run: BashRunner;
  lastFailure: () => unknown;
} {
  let failure: unknown;
  let sequence = 0;
  async function run(command: string): Promise<ExecResult> {
    const execId = ++sequence;
    probe("process-request", { sessionId, execId, command });
    const completion = Promise.withResolvers<void>();
    const execution: ExecutionBoundary = { settled: false, promise: completion.promise };
    publicationProcess.execution = execution;
    failure = undefined;
    try {
      const result = await pi.exec("bash", ["-c", command], { timeout: TMUX_COMMAND_TIMEOUT_MS });
      if (result.killed || ("truncated" in result && result.truncated === true))
        failure = new Error(
          result.killed ? "Process interrupted or timed out" : "Process output truncated",
        );
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      execution.settled = true;
      completion.resolve();
      probe("process-settled", { sessionId, execId });
    }
  }
  function lastFailure(): unknown {
    return failure;
  }
  return { run, lastFailure };
}

function reportPublicationOutcome(gen: PublicationGeneration, outcome: PublicationOutcome): void {
  if (outcome.status === "failed") gen.notify(`cannot publish session state: ${outcome.message}`);
}

function reportCleanupOutcome(gen: PublicationGeneration, outcome: PublicationOutcome): void {
  if (outcome.status === "failed")
    gen.notify(`cannot clear session state option: ${outcome.message}`);
  if (outcome.status === "busy")
    gen.notify("cannot clear session state option: pi-mux lock is busy");
}

function makeNotifier(ctx: ExtensionContext): (message: string) => void {
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const notify = ui?.notify.bind(ui);
  return function report(message) {
    const summary = message.replace(/\s+/g, " ").slice(0, MAX_NOTIFICATION_LENGTH);
    if (notify) notify(`session-state: ${summary}`, "warning");
    else console.error(`[session-state] ${summary}`);
  };
}

function isSubagentSession(ctx: ExtensionContext): boolean {
  return (
    resolve(ctx.sessionManager.getSessionDir()) ===
    resolve(subagentSessionDir(ctx.sessionManager.getCwd()))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
