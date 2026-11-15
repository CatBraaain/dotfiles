import { dirname, resolve } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { Type, type Static } from "typebox";
import { resultText } from "../shared/tool-text.ts";
import { showMainagentApproval } from "./mainagent-approval.ts";
import { getTmuxPaths, PARENT_PI_ENV_KEYS, type TmuxPaths } from "../pi-mux-bridge/shared.ts";
const MAIN_AGENT_NAME = "main";

const QUESTION = "Allow creating a new main-agent session?";
const ALLOW_OPTIONS = [
  { label: "Allow once", grant: "once" },
  { label: "Allow in this turn", grant: "turn" },
  { label: "Allow in this session", grant: "session" },
] as const;
const DENY_OPTION_LABEL = "No, deny (reason next)";
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
    const details = [
      `prompt: ${input.prompt}`,
      ...(input.cwd === undefined ? [] : [`cwd: ${sessionCwd}`]),
    ].join("\n");
    const useCustomDialog = context.mode === "tui" && typeof context.ui.custom === "function";
    if (!useCustomDialog && typeof context.ui.select !== "function") {
      const confirmed = await context.ui.confirm(QUESTION, details, { signal });
      signal?.throwIfAborted();
      if (confirmed) return { grant: "once" };
    } else {
      const options = [...ALLOW_OPTIONS.map((option) => option.label), DENY_OPTION_LABEL];
      const selected = useCustomDialog
        ? await showMainagentApproval(context.ui, QUESTION, details, options, signal)
        : await context.ui.select(`${QUESTION}\n${details}`, options, { signal });
      signal?.throwIfAborted();
      const choice = ALLOW_OPTIONS.find((option) => option.label === selected);
      if (choice) {
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
