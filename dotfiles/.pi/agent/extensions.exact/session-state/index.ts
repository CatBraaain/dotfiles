import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { subagentSessionDir } from "../agents/index.ts";
import { requestBackgroundBash, type BackgroundBashContext } from "../tools/background-bash.ts";
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
const MAX_NOTIFICATION_LENGTH = 200;
const PUBLICATION_STOPPED = Symbol.for("pi.session-state.publication-stopped");
const publicationProcess = process as NodeJS.Process & { [PUBLICATION_STOPPED]?: boolean };

export type { SessionState } from "./tmux.ts";

interface PublicationGeneration {
  controller: AbortController;
  initializationStarted: boolean;
  binding?: ManagedPaneBinding;
  state?: SessionState;
  title: string | null;
  sessionId: string;
  run: BashRunner;
  environment: Pick<NodeJS.ProcessEnv, "XDG_RUNTIME_DIR" | "TMUX" | "TMUX_PANE">;
  notify: (message: string) => void;
}

export default function sessionStateExtension(pi: ExtensionAPI): void {
  let publicationQueue: Promise<void> = Promise.resolve();
  let generation: PublicationGeneration | undefined;
  let isAgentRunActive = false;
  let isWaitingForApproval = false;

  function enqueuePublication(gen: PublicationGeneration, task: () => Promise<void>): void {
    publicationQueue = publicationQueue
      .then(() => {
        if (!publicationProcess[PUBLICATION_STOPPED]) return task();
      })
      .catch((error) => {
        if (!gen.controller.signal.aborted) gen.notify(errorMessage(error));
      });
  }

  function makeBashRunner(
    context: BackgroundBashContext,
    notify: (message: string) => void,
  ): BashRunner {
    return async function run(command) {
      const outcome = await requestBackgroundBash({
        id: "session-state-tmux",
        params: { command, timeout: TMUX_COMMAND_TIMEOUT_S },
        context,
      });
      if (outcome.status !== "completed") {
        publicationProcess[PUBLICATION_STOPPED] = true;
        const reason = outcome.status === "aborted" ? outcome.reason : outcome.error;
        (generation?.notify ?? notify)(
          `session state publication stopped: Bash completion is unknown (${outcome.status}): ${errorMessage(reason)}`,
        );
      }
      return outcome;
    };
  }

  function scheduleStatePublication(
    state: SessionState,
    title: string | null = generation?.title ?? null,
  ): void {
    const gen = generation;
    if (!gen || !gen.initializationStarted || (gen.state === state && gen.title === title)) return;
    gen.state = state;
    gen.title = title;
    const sessionId = gen.sessionId;
    enqueuePublication(gen, async () => {
      if (gen.controller.signal.aborted || !gen.binding) return;
      const outcome = await publishState(gen.run, gen.binding, sessionId, state, title);
      if (!publicationProcess[PUBLICATION_STOPPED] && !gen.controller.signal.aborted)
        reportPublicationOutcome(gen, outcome);
    });
  }

  pi.on("session_start", (_event, ctx) => {
    generation?.controller.abort();
    generation = undefined;
    isAgentRunActive = false;
    isWaitingForApproval = false;
    if (isSubagentSession(ctx)) return;
    const context = captureBashContext(ctx);
    const controller = new AbortController();
    const environment = {
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
    };
    const notify = makeNotifier(ctx);
    const gen: PublicationGeneration = {
      controller,
      initializationStarted: false,
      sessionId: ctx.sessionManager.getSessionId(),
      title: ctx.sessionManager.getSessionName() ?? null,
      run: makeBashRunner(context, notify),
      environment,
      notify,
    };
    generation = gen;
  });

  pi.on("resources_discover", () => {
    const gen = generation;
    if (!gen || gen.initializationStarted) return;
    gen.initializationStarted = true;
    enqueuePublication(gen, async () => {
      if (gen.controller.signal.aborted) return;
      const detection = await detectManagedPane(gen.run, gen.environment);
      if (publicationProcess[PUBLICATION_STOPPED] || gen.controller.signal.aborted) return;
      if (detection.status === "managed") gen.binding = detection.binding;
      if (detection.status === "failed")
        gen.notify(`cannot confirm managed tmux pane: ${detection.message}`);
      if (detection.status === "aborted") gen.notify("managed tmux pane check was interrupted");
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
    gen?.controller.abort();
    if (gen) {
      enqueuePublication(gen, async () => {
        if (!gen.binding) return;
        try {
          const outcome = await unsetStateOption(gen.run, gen.binding);
          if (publicationProcess[PUBLICATION_STOPPED]) return;
          if (outcome.status === "failed")
            gen.notify(`cannot clear session state option: ${outcome.message}`);
          if (outcome.status === "aborted") gen.notify("session state cleanup was interrupted");
        } catch (error) {
          gen.notify(`cannot clear session state option: ${errorMessage(error)}`);
        }
      });
    }
    await publicationQueue;
  });
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
