import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { subagentSessionDir } from "../agents/index.ts";
import {
  requestBackgroundBash,
  type BackgroundBashContext,
  type TrackedBackgroundBashOutcome,
} from "../tools/background-bash.ts";
import {
  detectManagedPane,
  publishState,
  unsetStateOption,
  type BashRunner,
  type ManagedPaneBinding,
  type PublicationOutcome,
  type SessionState,
} from "./tmux.ts";

const TMUX_COMMAND_TIMEOUT_S = 1;
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
  lastOutcome: () => TrackedBackgroundBashOutcome | undefined;
  environment: Pick<NodeJS.ProcessEnv, "XDG_RUNTIME_DIR" | "TMUX" | "TMUX_PANE">;
  notify: (message: string) => void;
}

export default function sessionStateExtension(pi: ExtensionAPI): void {
  let generation: PublicationGeneration | undefined;
  let isAgentRunActive = false;
  let isWaitingForApproval = false;

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
    gen.pending++;
    enqueuePublication(gen, async () => {
      try {
        while (!gen.controller.signal.aborted && gen.binding) {
          if (!(await waitForPriorExecution(gen))) return;
          gen.lastPublished = undefined;
          const outcome = await publishState(gen.run, gen.binding, sessionId, state, title);
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
    const context = captureBashContext(ctx);
    const controller = new AbortController();
    publicationProcess.controller = controller;
    const environment = {
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
    };
    const runner = makeBashRunner(context);
    generation = {
      controller,
      initializationStarted: false,
      pending: 0,
      recoveryNotified: false,
      sessionId: ctx.sessionManager.getSessionId(),
      title: ctx.sessionManager.getSessionName() ?? null,
      run: runner.run,
      lastOutcome: runner.lastOutcome,
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
        if (detection.status === "failed")
          gen.notify(`cannot confirm managed tmux pane: ${detection.message}`);
        if (detection.status === "aborted") gen.notify("managed tmux pane check was interrupted");
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
    isAgentRunActive = true;
    if (!isWaitingForApproval) scheduleStatePublication("running");
  });
  pi.on("ui_prompt_start", () => {
    isWaitingForApproval = true;
    scheduleStatePublication("waiting-approval");
  });
  pi.on("ui_prompt_end", () => {
    isWaitingForApproval = false;
    scheduleStatePublication(isAgentRunActive ? "running" : "waiting-user");
  });
  pi.on("agent_settled", () => {
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
        gen.notify("cannot clear session state option: previous Bash execution is still running");
        return;
      }
      try {
        const outcome = await unsetStateOption(gen.run, gen.binding, gen.sessionId);
        reportCleanupOutcome(gen, outcome);
      } catch (error) {
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
  const raw = gen.lastOutcome();
  if (!raw || raw.status === "completed") return "proceed";
  if (!gen.recoveryNotified) {
    gen.recoveryNotified = true;
    const reason = raw.status === "aborted" ? raw.reason : raw.error;
    gen.notify(
      `${operation} interrupted (${raw.status}): ${errorMessage(reason)}; retrying automatically`,
    );
  }
  if (!(await executionSettledOrAborted(gen, raw.executionSettled))) return "aborted";
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
  if (execution && !execution.settled) return executionSettledOrAborted(gen, execution.promise);
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

function makeBashRunner(context: BackgroundBashContext): {
  run: BashRunner;
  lastOutcome: () => TrackedBackgroundBashOutcome | undefined;
} {
  let lastOutcome: TrackedBackgroundBashOutcome | undefined;
  async function run(command: string): Promise<TrackedBackgroundBashOutcome> {
    const completion = Promise.withResolvers<void>();
    const execution: ExecutionBoundary = { settled: false, promise: completion.promise };
    publicationProcess.execution = execution;
    const outcome = await requestBackgroundBash({
      id: "session-state-tmux",
      params: { command, timeout: TMUX_COMMAND_TIMEOUT_S },
      context,
    });
    outcome.executionSettled.then(() => {
      execution.settled = true;
      completion.resolve();
    });
    lastOutcome = outcome;
    return outcome;
  }
  function getLastOutcome(): TrackedBackgroundBashOutcome | undefined {
    return lastOutcome;
  }
  return { run, lastOutcome: getLastOutcome };
}

function captureBashContext(ctx: ExtensionContext): BackgroundBashContext {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    modelRegistry: ctx.modelRegistry,
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
  };
}

function reportPublicationOutcome(gen: PublicationGeneration, outcome: PublicationOutcome): void {
  if (outcome.status === "failed") gen.notify(`cannot publish session state: ${outcome.message}`);
  if (outcome.status === "aborted") gen.notify("session state publication was interrupted");
}

function reportCleanupOutcome(gen: PublicationGeneration, outcome: PublicationOutcome): void {
  if (outcome.status === "failed")
    gen.notify(`cannot clear session state option: ${outcome.message}`);
  if (outcome.status === "aborted") gen.notify("session state cleanup was interrupted");
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
