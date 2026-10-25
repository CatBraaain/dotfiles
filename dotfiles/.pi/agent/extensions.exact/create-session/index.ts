import { resolve } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { Type, type Static } from "typebox";
import { resultText, truncateText } from "../shared/tool-text.ts";

export const TMUX_SESSION_NAME = "pi";
export const TMUX_KEEPER_SESSION_NAME = "_keeper";
const SERVER_UNAVAILABLE_EXIT_CODE = 94;
const MAIN_AGENT_NAME = "main";
const REQUEST_PREVIEW_LIMIT = 80;

const ALLOW_ONCE_OPTION = "Allow once";
const ALLOW_SESSION_OPTION = "Allow in this session";
const ALLOW_TURN_OPTION = "Allow in this turn";
const DENY_OPTION = "No, deny (reason next)";
const EXPIRED_TURN_APPROVAL = "Turn approval expired. Request approval again.";
const SERVER_UNAVAILABLE_MESSAGE = `tmux server is not running: keeper session "${TMUX_KEEPER_SESSION_NAME}" not found. Start the tmux-server systemd user service (systemctl --user enable --now tmux-server.service).`;

const TMUX_TMPDIR_ASSIGNMENT = 'TMUX_TMPDIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"';

const parameters = Type.Object({
  initialRequest: Type.String({
    description: "Initial request the new main-agent session executes immediately.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory of the new session; defaults to the current cwd." }),
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

type ApprovalUI = {
  confirm(title: string, message: string): Promise<boolean>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
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

export function buildTmuxCommand(input: {
  initialRequest: string;
  cwd: string;
  name: string;
}): string {
  const piScript = `cd -- ${quote([input.cwd])} && ${quote([
    "pi",
    "--agent",
    MAIN_AGENT_NAME,
    "--",
    input.initialRequest,
  ])}`;
  const windowCommand = `bash -lc ${quote([piScript])}`;
  const windowName = quote([input.name]);
  return [
    `${TMUX_TMPDIR_ASSIGNMENT} tmux has-session -t ${TMUX_KEEPER_SESSION_NAME} 2>/dev/null || exit ${SERVER_UNAVAILABLE_EXIT_CODE}`,
    `if ${TMUX_TMPDIR_ASSIGNMENT} tmux has-session -t ${TMUX_SESSION_NAME} 2>/dev/null; then`,
    `  ${TMUX_TMPDIR_ASSIGNMENT} tmux new-window -d -t ${TMUX_SESSION_NAME}: -n ${windowName} -- ${windowCommand}`,
    `else`,
    `  ${TMUX_TMPDIR_ASSIGNMENT} tmux new-session -d -s ${TMUX_SESSION_NAME} -n ${windowName} -- ${windowCommand}`,
    `fi`,
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
): AgentToolResult<{ bash: BashOutcome["result"] }> {
  const bash = outcome.result;
  const envelope = bash.structuredContent as
    | { output?: unknown; exit_code?: number; truncated?: boolean }
    | undefined;
  const text = resultText(bash);
  const details = { bash };
  if (outcome.isError || bash.isError || (envelope?.exit_code !== undefined && envelope.exit_code !== 0)) {
    const error =
      envelope?.exit_code === SERVER_UNAVAILABLE_EXIT_CODE
        ? SERVER_UNAVAILABLE_MESSAGE
        : `create_detached_session tmux command failed:\n${text}`;
    return {
      content: [{ type: "text", text: error }],
      details,
      isError: true,
      structuredContent: { status: "error", window: windowName, error },
    };
  }
  const message = `Created tmux window "${TMUX_SESSION_NAME}:${windowName}" running an independent main-agent session.\nAttach with: tmux attach -t ${TMUX_SESSION_NAME}`;
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
      const selected = await ui.select(`${question}\n${details}`, [
        ALLOW_ONCE_OPTION,
        ALLOW_SESSION_OPTION,
        ALLOW_TURN_OPTION,
        DENY_OPTION,
      ]);
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
    } else if (await ui.confirm(question, details)) {
      return { grant: "once" };
    }
    const reason = (await ui.input?.("Denied. Optional reason for the agent:"))?.trim();
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
      "Create a detached, independent main-agent pi session in a tmux window and start it with an initial request. Returns only the session information; the tool does not wait for, converse with, or collect results. The user takes over the session via tmux attach. Requires interactive approval and the tmux-server systemd user service.",
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
        const decision = await requestApproval(ctx, input);
        if ("denied" in decision) return deniedResult(decision.denied);
      }

      const windowName = input.name?.trim() || autoWindowName(now());
      const sessionCwd =
        input.cwd === undefined ? resolve(ctx.cwd) : resolve(ctx.cwd, input.cwd);
      const command = buildTmuxCommand({
        initialRequest: input.initialRequest,
        cwd: sessionCwd,
        name: windowName,
      });
      const bash = await ctx.executeTool("bash", { command }, { signal });
      return sessionResult(bash, windowName);
    },
  };
  pi.registerTool(tool);
}
