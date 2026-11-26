import { dirname, resolve } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { quote } from "shell-quote";
import { Type, type Static } from "typebox";
import { getTmuxPaths, PARENT_PI_ENV_KEYS, type TmuxPaths } from "../pi-mux-bridge/shared.ts";
import { resultText } from "../shared/tool-text.ts";
import { buildWindowsCliInvocation } from "../tools/cli.ts";
import { showAgentApproval, type ApprovalField } from "./agent-approval.ts";

type BashResponse = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

const MAIN_AGENT_NAME = "main";

const CREATE_QUESTION = "Allow creating a new main-agent session?";
const SEND_QUESTION = "Allow sending a message to another session?";
const ALLOW_OPTIONS = [
  { label: "Allow once", grant: "once" },
  { label: "Allow in this turn", grant: "turn" },
  { label: "Allow in this session", grant: "session" },
] as const;
const DENY_OPTION_LABEL = "No, deny (reason next)";
const EXPIRED_TURN_APPROVAL = "Turn approval expired. Request approval again.";
const parameters = Type.Object({
  message: Type.String({
    description:
      "Text delivered to the target session. Without session-id it becomes the initial prompt of a new session.",
  }),
  "session-id": Type.Optional(
    Type.String({
      description:
        "Session ID to send the message to. Omit to create a new independent main-agent session.",
    }),
  ),
  wait: Type.Optional(
    Type.Number({
      description:
        "Seconds to wait until the recipient consumes the message. Only valid with session-id.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory of the new session. Only valid without session-id. Relative paths resolve from the current working directory, which is also the default.",
    }),
  ),
});

export type AgentInput = Static<typeof parameters>;

const outputSchema = Type.Object({
  status: Type.Union([
    Type.Literal("created"),
    Type.Literal("delivered"),
    Type.Literal("denied"),
    Type.Literal("error"),
  ]),
  error: Type.Optional(Type.String()),
});

type CreateAction = { kind: "create"; message: string; cwd: string; cwdSpecified: boolean };
type SendAction = { kind: "send"; sessionId: string; message: string; wait?: number };
type AgentAction = CreateAction | SendAction;

export function validateInput(input: AgentInput): string | undefined {
  if (input.message.trim() === "") return "agent message must not be empty";
  if (input.message.includes("\0")) return "agent message cannot contain NUL";
  const sessionId = input["session-id"];
  if (sessionId !== undefined) {
    if (sessionId.trim() === "") return "agent session-id must not be empty";
    if (sessionId.includes("\0")) return "agent session-id cannot contain NUL";
    if (input.cwd !== undefined) return "agent cwd is only valid when creating a session";
  } else if (input.wait !== undefined) {
    return "agent wait is only valid with session-id";
  }
  if (input.cwd?.includes("\0")) return "agent cwd cannot contain NUL";
  if (input.wait !== undefined && (!Number.isInteger(input.wait) || input.wait <= 0))
    return "agent wait must be a positive integer number of seconds";
  return undefined;
}

function toAction(input: AgentInput, sessionCwd: string): AgentAction {
  const sessionId = input["session-id"];
  if (sessionId !== undefined)
    return { kind: "send", sessionId, message: input.message, wait: input.wait };
  return {
    kind: "create",
    message: input.message,
    cwd: resolve(sessionCwd, input.cwd ?? "."),
    cwdSpecified: input.cwd !== undefined,
  };
}

export function buildCreateCommand(
  input: { message: string; cwd: string },
  paths?: TmuxPaths,
  platform = process.platform,
): string {
  const clearParent = `unset ${PARENT_PI_ENV_KEYS.join(" ")}`;
  if (platform === "win32") {
    const invocation = buildWindowsCliInvocation("pi-mux.exe", [
      "new",
      "--detached",
      "--cwd",
      input.cwd,
      input.message,
    ]);
    return `${clearParent} && ${invocation}`;
  }
  const piScript = [
    clearParent,
    `export XDG_RUNTIME_DIR=${quote([dirname((paths ?? getTmuxPaths()).directory)])}`,
    `cd -- ${quote([input.cwd])} && exec ${quote(["pi-mux", "new", "--detached", input.message])}`,
  ].join("\n");
  return quote(["bash", "-lc", piScript]);
}

export function buildSendCommand(
  input: { sessionId: string; message: string; wait?: number },
  paths?: TmuxPaths,
  platform = process.platform,
): string {
  const cliArguments = [
    "send",
    ...(input.wait === undefined ? [] : ["--wait", String(input.wait)]),
    input.sessionId,
    input.message,
  ];
  if (platform === "win32") return buildWindowsCliInvocation("pi-mux.exe", cliArguments);
  const piScript = [
    `export XDG_RUNTIME_DIR=${quote([dirname((paths ?? getTmuxPaths()).directory)])}`,
    `exec ${quote(["pi-mux", ...cliArguments])}`,
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

function actionResult(
  action: AgentAction,
  outcome: BashResponse,
): AgentToolResult<{ bash: BashResponse["result"]; status: "created" | "delivered" | "error" }> {
  const bash = outcome.result;
  const envelope = bash.structuredContent as { exit_code?: number } | undefined;
  const text = resultText(bash);
  if (
    outcome.isError ||
    bash.isError ||
    (envelope?.exit_code !== undefined && envelope.exit_code !== 0) ||
    (action.kind === "create" && !/^Pi session \S+/m.test(text))
  ) {
    const error = `agent ${action.kind} failed:\n${text}`;
    return {
      content: [{ type: "text", text: error }],
      details: { bash, status: "error" },
      isError: true,
      structuredContent: { status: "error", error },
    };
  }
  const status = action.kind === "create" ? "created" : "delivered";
  const message =
    action.kind === "create"
      ? `Created an independent main-agent session.\n${text}`
      : action.wait === undefined
        ? `Sent the message to session ${action.sessionId} without waiting for consumption.`
        : `Session ${action.sessionId} consumed the message.`;
  return {
    content: [{ type: "text", text: message }],
    details: { bash, status },
    structuredContent: { status },
  };
}

export function registerAgentTool(pi: ExtensionAPI): void {
  const sessionApprovals = new Set<AgentAction["kind"]>();
  const turnApprovals = new Set<AgentAction["kind"]>();
  let turnGeneration = 0;

  function expireTurnApproval(): void {
    turnApprovals.clear();
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
    action: AgentAction,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalDecision> {
    const generation = turnGeneration;
    const isCreate = action.kind === "create";
    const question = isCreate ? CREATE_QUESTION : SEND_QUESTION;
    const fields: ApprovalField[] = isCreate
      ? [
          { label: "message", text: action.message },
          ...(action.cwdSpecified ? [{ label: "cwd", text: action.cwd }] : []),
        ]
      : [
          { label: "message", text: action.message },
          { label: "session-id", text: action.sessionId },
          ...(action.wait === undefined ? [] : [{ label: "wait", text: `${action.wait} seconds` }]),
        ];
    const details = fields.map((field) => `${field.label}: ${field.text}`).join("\n");
    const useCustomDialog = context.mode === "tui" && typeof context.ui.custom === "function";
    if (!useCustomDialog && typeof context.ui.select !== "function") {
      const confirmed = await context.ui.confirm(question, details, { signal });
      signal?.throwIfAborted();
      if (confirmed) return { grant: "once" };
    } else {
      const scope = isCreate ? "session creation" : "message sending";
      const title = `${question}\nTurn and session approvals apply to ${scope} only.`;
      const options = [...ALLOW_OPTIONS.map((option) => option.label), DENY_OPTION_LABEL];
      const selected = useCustomDialog
        ? await showAgentApproval(context.ui, title, fields, options, signal)
        : await context.ui.select(`${title}\n${details}`, options, { signal });
      signal?.throwIfAborted();
      const choice = ALLOW_OPTIONS.find((option) => option.label === selected);
      if (choice) {
        if (choice.grant === "turn") {
          if (generation !== turnGeneration) return { denied: EXPIRED_TURN_APPROVAL };
          turnApprovals.add(action.kind);
        } else if (choice.grant === "session") {
          sessionApprovals.add(action.kind);
        }
        return { grant: choice.grant };
      }
    }
    const reason = (
      await context.ui.input?.("Denied. Optional reason for the agent:", undefined, { signal })
    )?.trim();
    signal?.throwIfAborted();
    return {
      denied: reason ? `agent denied by user: ${reason}` : "agent denied by user",
    };
  }

  const tool: ToolDefinition<typeof parameters> & { reachesTools(): string[] } = {
    name: "agent",
    label: "Agent",
    description:
      "エージェントのセッションにメッセージを送るか、新しいセッションを作成する。" +
      " `newagent` の依頼では `session-id` を省略し、独立した main エージェントの pi セッションを別の tmux ウィンドウで起動する。起動先には自動接続しない。" +
      " 初回の `message` には、新しいセッションで担当作業を実行するよう書く。ユーザーの承認を引用する場合も、`newagent` の使用やセッション起動の指示は転送しない。" +
      " 新規作成時に返すのはセッション情報のみ。完了を待ったり、新しいセッションと対話したり、結果を回収したりしない。" +
      " `session-id` を指定すると、稼働中のセッションにメッセージを送る。`wait` を指定すると、相手の pi がメッセージを取り込むまで待てる。" +
      " 対話形式の承認が必要。",
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
          `agent is restricted to the main agent (current agent: ${process.env.PI_AGENT_NAME ?? "unknown"})`,
        );
      signal?.throwIfAborted();
      const action = toAction(input, ctx.cwd);

      if (!sessionApprovals.has(action.kind) && !turnApprovals.has(action.kind)) {
        if (!ctx.hasUI || !ctx.ui) throw new Error("agent requires interactive approval");
        const decision = await requestApproval(ctx, action, signal);
        if ("denied" in decision) return deniedResult(decision.denied);
      }

      signal?.throwIfAborted();
      const command =
        action.kind === "create" ? buildCreateCommand(action) : buildSendCommand(action);
      const bash = await ctx.executeTool("bash", { command }, { signal });
      return actionResult(action, signal?.aborted ? { ...bash, isError: true } : bash);
    },
  };
  pi.registerTool(tool);
}
