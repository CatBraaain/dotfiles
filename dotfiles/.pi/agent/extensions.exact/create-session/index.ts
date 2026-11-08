import { dirname, resolve } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { Type, type Static } from "typebox";
import { resultText, truncateText } from "../shared/tool-text.ts";
import {
  attachCommand,
  getTmuxPaths,
  PARENT_PI_ENV_KEYS,
  tmuxArgs,
  type TmuxPaths,
} from "../tmux-handoff/shared.ts";

export const TMUX_SESSION_NAME = "pi";
const MAIN_AGENT_NAME = "main";
const REQUEST_PREVIEW_LIMIT = 80;

const ALLOW_ONCE_OPTION = "Allow once";
const ALLOW_TURN_OPTION = "Allow in this turn";
const ALLOW_SESSION_OPTION = "Allow in this session";
const DENY_OPTION = "No, deny (reason next)";
const EXPIRED_TURN_APPROVAL = "Turn approval expired. Request approval again.";
const parameters = Type.Object({
  initialRequest: Type.String({
    description: "Initial request the new main-agent session executes immediately.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory of the new session; defaults to the current cwd.",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "tmux window name; defaults to an automatic name (main-HHMMSS)." }),
  ),
});

export type CreateSessionInput = Static<typeof parameters>;
type BashOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

const outputSchema = Type.Object({
  status: Type.Union([Type.Literal("created"), Type.Literal("denied"), Type.Literal("error")]),
  window: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});

type ApprovalDialogOptions = { signal?: AbortSignal };
type ApprovalUI = {
  confirm(title: string, message: string, options?: ApprovalDialogOptions): Promise<boolean>;
  select?(
    title: string,
    options: string[],
    dialogOptions?: ApprovalDialogOptions,
  ): Promise<string | undefined>;
  input?(
    title: string,
    placeholder?: string,
    options?: ApprovalDialogOptions,
  ): Promise<string | undefined>;
};

export type CreateSessionOptions = { now?: () => Date };

export function validateInput(input: CreateSessionInput): string | undefined {
  if (input.initialRequest.trim() === "")
    return "create_detached_session initialRequest must not be empty";
  if (input.initialRequest.includes("\0"))
    return "create_detached_session initialRequest cannot contain NUL";
  if (input.cwd !== undefined && input.cwd.includes("\0"))
    return "create_detached_session cwd cannot contain NUL";
  if (input.name === undefined) return undefined;
  if (input.name.includes("\0")) return "create_detached_session name cannot contain NUL";
  if (input.name.trim() === "") return "create_detached_session name must not be blank";
  if (/[.:]/.test(input.name)) return 'create_detached_session name cannot contain ":" or "."';
  return undefined;
}

export function autoWindowName(now: Date): string {
  function twoDigits(value: number): string {
    return String(value).padStart(2, "0");
  }
  return `main-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;
}

export function buildTmuxCommand(
  input: { initialRequest: string; cwd: string; name: string },
  paths: TmuxPaths = getTmuxPaths(),
): string {
  const piScript = [
    `unset ${PARENT_PI_ENV_KEYS.join(" ")}`,
    `export XDG_RUNTIME_DIR=${quote([dirname(paths.directory)])}`,
    `cd -- ${quote([input.cwd])} && exec ${quote([
      "pi",
      "--agent",
      MAIN_AGENT_NAME,
      "--",
      input.initialRequest,
    ])}`,
  ].join("\n");
  const windowArgs = ["-n", input.name, "--", "bash", "-lc", piScript];
  const hasSession = quote([
    "tmux",
    ...tmuxArgs(paths, ["has-session", "-t", `=${TMUX_SESSION_NAME}`]),
  ]);
  const newWindow = quote([
    "tmux",
    ...tmuxArgs(paths, ["new-window", "-d", "-t", `=${TMUX_SESSION_NAME}:`, ...windowArgs]),
  ]);
  const newSession = quote([
    "tmux",
    ...tmuxArgs(paths, ["new-session", "-d", "-s", TMUX_SESSION_NAME, ...windowArgs]),
  ]);
  return [
    `${quote(["mkdir", "-p", "-m", "700", "--", paths.directory])} || exit`,
    `if ${hasSession} 2>/dev/null; then`,
    `  ${newWindow}`,
    "else",
    `  ${newSession}`,
    "fi",
  ].join("\n");
}

function deniedResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {},
    isError: true,
    structuredContent: { status: "denied" as const, error: message },
  };
}

function sessionResult(
  outcome: BashOutcome,
  windowName: string,
  paths: TmuxPaths,
): AgentToolResult<{ bash: BashOutcome["result"] }> {
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
    const error = `create_detached_session tmux command failed:\n${text}`;
    return {
      content: [{ type: "text", text: error }],
      details,
      isError: true,
      structuredContent: { status: "error", window: windowName, error },
    };
  }
  const reconnect = attachCommand({
    socketPath: paths.socketPath,
    tmuxSessionId: `=${TMUX_SESSION_NAME}`,
  });
  const message = `Created tmux window "${TMUX_SESSION_NAME}:${windowName}" running an independent main-agent session.\nAttach with: ${reconnect}`;
  return {
    content: [{ type: "text", text: message }],
    details,
    structuredContent: { status: "created", window: windowName },
  };
}

export default function createSessionExtension(
  pi: ExtensionAPI,
  options: CreateSessionOptions = {},
): void {
  const now = options.now ?? (() => new Date());
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
    input: CreateSessionInput,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalDecision> {
    const ui = context.ui as ApprovalUI;
    const details = [
      `initial request: ${truncateText(input.initialRequest, REQUEST_PREVIEW_LIMIT)}`,
      input.cwd === undefined ? undefined : `cwd: ${input.cwd}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const question = "Allow creating a new main-agent session?";
    const generation = turnGeneration;
    if (ui.select) {
      const selected = await ui.select(
        `${question}\n${details}`,
        [ALLOW_ONCE_OPTION, ALLOW_TURN_OPTION, ALLOW_SESSION_OPTION, DENY_OPTION],
        { signal },
      );
      signal?.throwIfAborted();
      if (selected === ALLOW_TURN_OPTION) {
        if (generation !== turnGeneration) return { denied: EXPIRED_TURN_APPROVAL };
        turnApproved = true;
        return { grant: "turn" };
      }
      if (selected === ALLOW_SESSION_OPTION) {
        sessionApproved = true;
        return { grant: "session" };
      }
      if (selected === ALLOW_ONCE_OPTION) return { grant: "once" };
    } else {
      const confirmed = await ui.confirm(question, details, { signal });
      signal?.throwIfAborted();
      if (confirmed) return { grant: "once" };
    }
    const reason = (
      await ui.input?.("Denied. Optional reason for the agent:", undefined, { signal })
    )?.trim();
    signal?.throwIfAborted();
    return {
      denied: reason
        ? `create_detached_session denied by user: ${reason}`
        : "create_detached_session denied by user",
    };
  }

  const tool: ToolDefinition<typeof parameters> & { reachesTools(): string[] } = {
    name: "create_detached_session",
    label: "Create Detached Session",
    description:
      "Create a detached, independent main-agent pi session in a tmux window and start it with an initial request. Returns only the session information; the tool does not wait for, converse with, or collect results. The user takes over the session via tmux attach. Requires interactive approval.",
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
          `create_detached_session is restricted to the main agent (current agent: ${process.env.PI_AGENT_NAME ?? "unknown"})`,
        );
      signal?.throwIfAborted();

      if (!sessionApproved && !turnApproved) {
        if (!ctx.hasUI || !ctx.ui)
          throw new Error("create_detached_session requires interactive approval");
        const decision = await requestApproval(ctx, input, signal);
        if ("denied" in decision) return deniedResult(decision.denied);
      }

      signal?.throwIfAborted();
      const windowName = input.name?.trim() || autoWindowName(now());
      const sessionCwd = input.cwd === undefined ? resolve(ctx.cwd) : resolve(ctx.cwd, input.cwd);
      const paths = getTmuxPaths();
      const command = buildTmuxCommand(
        { initialRequest: input.initialRequest, cwd: sessionCwd, name: windowName },
        paths,
      );
      const bash = await ctx.executeTool("bash", { command }, { signal });
      return sessionResult(bash, windowName, paths);
    },
  };
  pi.registerTool(tool);
}
