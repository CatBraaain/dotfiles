import { dirname, resolve } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { Type, type Static } from "typebox";
import {
  matchesKey,
  Text,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { resultText } from "../shared/tool-text.ts";
import { getTmuxPaths, PARENT_PI_ENV_KEYS, type TmuxPaths } from "../pi-mux-bridge/shared.ts";
const MAIN_AGENT_NAME = "main";

const QUESTION = "Allow creating a new main-agent session?";
const ALLOW_OPTIONS = [
  { label: "Allow once", grant: "once" },
  { label: "Allow in this turn", grant: "turn" },
  { label: "Allow in this session", grant: "session" },
] as const;
const DENY_OPTION_LABEL = "No, deny (reason next)";
const DIALOG_HINT = "up/down scroll · 1-4 select · esc deny";
const PROMPT_LABEL = "prompt:";
const CWD_LABEL = "cwd:";

const DIALOG_CHROME_ROWS = 16;
const MIN_PROMPT_VIEWPORT_ROWS = 3;
const MAX_PROMPT_VIEWPORT_ROWS = 20;
const OVERLAY_MAX_HEIGHT_RATIO = 0.94;
const MIN_DIALOG_ROWS = 8;
const EXPIRED_TURN_APPROVAL = "Turn approval expired. Request approval again.";
const parameters = Type.Object({
  prompt: Type.String({
    description: "Prompt the new main-agent session executes immediately.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory of the new session; defaults to the current cwd.",
    }),
  ),
});

export type MainagentInput = Static<typeof parameters>;
type BashOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

const outputSchema = Type.Object({
  status: Type.Union([Type.Literal("created"), Type.Literal("denied"), Type.Literal("error")]),
  error: Type.Optional(Type.String()),
});

export type ApprovalChoice =
  | { grant: "once" | "turn" | "session" }
  | { denied: true }
  | { aborted: true };

export interface ApprovalTheme {
  fg: (token: "accent" | "dim", text: string) => string;
  bold: (text: string) => string;
}

export interface ApprovalDialogOptions {
  prompt: string;
  cwd: string;
  theme: ApprovalTheme;
  getMaxRows: () => number;
  requestRender: () => void;
  done: (choice: ApprovalChoice) => void;
  signal?: AbortSignal;
}

export function dialogMaxRows(terminalRows: number): number {
  return Math.max(MIN_DIALOG_ROWS, Math.floor(terminalRows * OVERLAY_MAX_HEIGHT_RATIO));
}

export function validateInput(input: MainagentInput): string | undefined {
  if (input.prompt.trim() === "") return "mainagent prompt must not be empty";
  if (input.prompt.includes("\0")) return "mainagent prompt cannot contain NUL";
  if (input.cwd !== undefined && input.cwd.includes("\0"))
    return "mainagent cwd cannot contain NUL";
  return undefined;
}

export function buildTmuxCommand(
  input: { prompt: string; cwd: string },
  paths: TmuxPaths = getTmuxPaths(),
): string {
  const piScript = [
    `unset ${PARENT_PI_ENV_KEYS.join(" ")}`,
    `export XDG_RUNTIME_DIR=${quote([dirname(paths.directory)])}`,
    `cd -- ${quote([input.cwd])} && exec ${quote(["pi-mux", "new", "--detached", input.prompt])}`,
  ].join("\n");
  return quote(["bash", "-lc", piScript]);
}

export type ApprovalDialogHandle = Component & {
  dispose(): void;
  handleInput(data: string): void;
  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined;
};

export function createApprovalDialog(options: ApprovalDialogOptions): ApprovalDialogHandle {
  const { prompt, cwd, theme, getMaxRows, requestRender, done, signal } = options;
  const content = new Text(prompt, 1, 0);
  let scrollTop = 0;
  let contentLineCount = 0;
  let viewportRows = MIN_PROMPT_VIEWPORT_ROWS;
  let closed = false;

  const onAbort = () => finish({ aborted: true });
  signal?.addEventListener("abort", onAbort, { once: true });

  function dispose(): void {
    signal?.removeEventListener("abort", onAbort);
  }

  function finish(choice: ApprovalChoice): void {
    if (closed) return;
    closed = true;
    dispose();
    done(choice);
  }

  function scroll(lines: number): void {
    const maxScrollTop = Math.max(0, contentLineCount - viewportRows);
    const next = Math.min(Math.max(0, scrollTop + lines), maxScrollTop);
    if (next === scrollTop) return;
    scrollTop = next;
    requestRender();
  }

  return {
    render(width: number): string[] {
      const bodyLines = content.render(width);
      contentLineCount = bodyLines.length;
      viewportRows = Math.max(
        MIN_PROMPT_VIEWPORT_ROWS,
        Math.min(MAX_PROMPT_VIEWPORT_ROWS, getMaxRows() - DIALOG_CHROME_ROWS),
      );
      const maxScrollTop = Math.max(0, contentLineCount - viewportRows);
      scrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop);
      const visible = bodyLines.slice(scrollTop, scrollTop + viewportRows);
      const range =
        maxScrollTop > 0
          ? ` [${scrollTop + 1}-${scrollTop + visible.length}/${contentLineCount}]`
          : "";
      const separator = theme.fg("dim", "─".repeat(width));
      const choiceLines = [
        ...ALLOW_OPTIONS.map((option, index) => `${index + 1}. ${option.label}`),
        `${ALLOW_OPTIONS.length + 1}. ${DENY_OPTION_LABEL}`,
      ];
      return [
        separator,
        "",
        truncateToWidth(theme.fg("accent", theme.bold(QUESTION)), width),
        "",
        truncateToWidth(theme.fg("dim", `${PROMPT_LABEL}${range}`), width),
        ...visible.map((line) => truncateToWidth(line, width)),
        "",
        truncateToWidth(theme.fg("dim", `${CWD_LABEL} ${cwd}`), width),
        "",
        ...choiceLines.map((line) => truncateToWidth(line, width)),
        "",
        truncateToWidth(theme.fg("dim", DIALOG_HINT), width),
        "",
        separator,
      ];
    },
    invalidate(): void {
      content.invalidate();
    },
    dispose,
    handleInput(data: string): void {
      if (matchesKey(data, "escape")) {
        finish({ denied: true });
        return;
      }
      if (matchesKey(data, "up")) {
        scroll(-1);
        return;
      }
      if (matchesKey(data, "down")) {
        scroll(1);
        return;
      }
      if (matchesKey(data, "pageUp")) {
        scroll(-viewportRows);
        return;
      }
      if (matchesKey(data, "pageDown")) {
        scroll(viewportRows);
        return;
      }
      if (matchesKey(data, "home")) {
        scroll(-Number.MAX_SAFE_INTEGER);
        return;
      }
      if (matchesKey(data, "end")) {
        scroll(Number.MAX_SAFE_INTEGER);
        return;
      }
      const choiceIndex = Number.parseInt(data, 10);
      if (!Number.isInteger(choiceIndex)) return;
      if (choiceIndex === ALLOW_OPTIONS.length + 1) {
        finish({ denied: true });
        return;
      }
      const allowOption = choiceIndex >= 1 ? ALLOW_OPTIONS[choiceIndex - 1] : undefined;
      if (allowOption) finish({ grant: allowOption.grant });
    },
    handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
      if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
      scroll(event.wheelDelta);
      return { handled: true };
    },
  };
}

function deniedResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {},
    isError: true,
    structuredContent: { status: "denied" as const, error: message },
  };
}

function sessionResult(outcome: BashOutcome): AgentToolResult<{ bash: BashOutcome["result"] }> {
  const bash = outcome.result;
  const envelope = bash.structuredContent as
    | { output?: unknown; exit_code?: number; truncated?: boolean }
    | undefined;
  const text = resultText(bash);
  const details = { bash };
  if (
    outcome.isError ||
    bash.isError ||
    (envelope?.exit_code !== undefined && envelope.exit_code !== 0)
  ) {
    const error = `mainagent tmux command failed:\n${text}`;
    return {
      content: [{ type: "text", text: error }],
      details,
      isError: true,
      structuredContent: { status: "error", error },
    };
  }
  const message = `Created an independent main-agent session.\n${text}`;
  return {
    content: [{ type: "text", text: message }],
    details,
    structuredContent: { status: "created" },
  };
}

export function registerMainagentTool(pi: ExtensionAPI): void {
  let sessionApproved = false;
  let turnApproved = false;
  let turnGeneration = 0;

  function expireTurnApproval(): void {
    turnApproved = false;
    turnGeneration++;
  }

  pi.on("input", () => {
    expireTurnApproval();
    return { action: "continue" };
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "user") expireTurnApproval();
  });

  type ApprovalDecision = { grant: "once" | "session" | "turn" } | { denied: string };

  async function requestApproval(
    context: ExtensionToolContext,
    input: MainagentInput,
    sessionCwd: string,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalDecision> {
    const generation = turnGeneration;
    if (context.mode !== "tui" || typeof context.ui.custom !== "function") {
      const confirmed = await context.ui.confirm(
        QUESTION,
        `${PROMPT_LABEL} ${input.prompt}\n${CWD_LABEL} ${sessionCwd}`,
        { signal },
      );
      signal?.throwIfAborted();
      if (confirmed) return { grant: "once" };
    } else {
      const choice = await context.ui.custom<ApprovalChoice>(
        (tui, theme, _keybindings, done) =>
          createApprovalDialog({
            prompt: input.prompt,
            cwd: sessionCwd,
            theme,
            getMaxRows: () => dialogMaxRows(tui.terminal.rows),
            requestRender: () => tui.requestRender(),
            done,
            signal,
          }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "94%", maxHeight: "94%" },
        },
      );
      signal?.throwIfAborted();
      if ("grant" in choice) {
        if (choice.grant === "turn") {
          if (generation !== turnGeneration) return { denied: EXPIRED_TURN_APPROVAL };
          turnApproved = true;
          return { grant: "turn" };
        }
        if (choice.grant === "session") {
          sessionApproved = true;
          return { grant: "session" };
        }
        return { grant: "once" };
      }
    }
    const reason = (
      await context.ui.input?.("Denied. Optional reason for the agent:", undefined, { signal })
    )?.trim();
    signal?.throwIfAborted();
    return {
      denied: reason ? `mainagent denied by user: ${reason}` : "mainagent denied by user",
    };
  }

  const tool: ToolDefinition<typeof parameters> & { reachesTools(): string[] } = {
    name: "mainagent",
    label: "Main Agent",
    description:
      "Create a detached, independent main-agent pi session in a tmux window and start it with the given prompt. Returns only the session information; the tool does not wait for, converse with, or collect results. The user takes over the session via tmux attach. Requires interactive approval.",
    parameters,
    outputSchema,
    reachesTools() {
      return ["bash"];
    },
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const validationError = validateInput(input);
      if (validationError !== undefined) throw new Error(validationError);
      if (process.env.PI_AGENT_NAME !== MAIN_AGENT_NAME)
        throw new Error(
          `mainagent is restricted to the main agent (current agent: ${process.env.PI_AGENT_NAME ?? "unknown"})`,
        );
      signal?.throwIfAborted();
      const sessionCwd = input.cwd === undefined ? resolve(ctx.cwd) : resolve(ctx.cwd, input.cwd);

      if (!sessionApproved && !turnApproved) {
        if (!ctx.hasUI || !ctx.ui) throw new Error("mainagent requires interactive approval");
        const decision = await requestApproval(ctx, input, sessionCwd, signal);
        if ("denied" in decision) return deniedResult(decision.denied);
      }

      signal?.throwIfAborted();
      const paths = getTmuxPaths();
      const command = buildTmuxCommand({ prompt: input.prompt, cwd: sessionCwd }, paths);
      const bash = await ctx.executeTool("bash", { command }, { signal });
      return sessionResult(bash);
    },
  };
  pi.registerTool(tool);
}
