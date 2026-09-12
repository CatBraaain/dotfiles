/**
 * dotfiles-handoff-session — port of the pi `handoff-session` extension to a
 * dsh host plugin.
 *
 * Registers the `handoff_session` tool. The agent calls it with `reason` (why
 * the current session ends) and `handoff` (the prompt auto-sent to the next
 * session). The tool asks the owner to confirm in the browser question UI; on
 * approval it creates a brand-new session (conversation history is NOT
 * carried over) and sends `handoff` as its first user message. On denial it
 * queues `no(<reason>)` as a follow-up user message in the current session.
 *
 * Framework types are structural subsets of the dsh interfaces
 * (`@deepseek-ai/dsh-tools` `ToolDefinition`, `@deepseek-ai/dsh-llm`
 * `UserMessage`, `@deepseek-ai/dsh-agent` `Agent`/`AgentRegistry`,
 * `@deepseek-ai/dsh-user-questions` `UserQuestionService`,
 * `@deepseek-ai/dsh-agent-presets` `AgentPresets`) so this package needs no
 * dependency installs; the loader resolves the framework from the profile
 * closure at runtime. The tool definition is a raw JSON Schema object instead
 * of a `defineTool` call for the same reason — `defineTool` only compiles the
 * author DSL into this shape and adds argument validation, which `execute`
 * performs itself.
 */
// tsconfig keeps `types: []` (zero-dependency build); declare the one global
// surface this plugin uses. Web Crypto's `randomUUID` is a global in every
// runtime dsh targets (Bun, Node >= 19).
declare const crypto: { randomUUID(): string };

export const name = "handoff-session";
export const inject = ["tools", "agents", "userQuestions"];

const TOOL_NAME = "handoff_session";
const PLUGIN_SOURCE = "dotfiles-handoff-session";
const CONFIRM_QUESTION_ID = "handoff-confirm";
const DENIAL_REASON_QUESTION_ID = "handoff-denial-reason";
const APPROVE_OPTION = "Yes, handoff";
const STAY_OPTION = "No, stay (reason next)";

const DESCRIPTION =
  "End the current session and move to a brand-new session after the owner confirms. " +
  "reason explains why the current session ends; handoff is the natural-language prompt " +
  "automatically sent as the first user message of the new session. " +
  "main agent は、収束ループを開始するとき、または senior によるレビューか実装が完了したときに " +
  "handoff_session を使う。handoff には目的、spec・work ファイルのパス、決定事項、" +
  "完了済みの作業と検証、未解決事項、次の phase の完了条件を含める。" +
  "オーナーの承認後は新しい main agent として再開し、次の phase を別の senior に委譲する。" +
  "確認UIで拒否された場合は、入力された理由を no(<理由>) として現在のagentへ返す。" +
  "収束条件を満たしたときは handoff_session を使わず、オーナーへ結果を報告する。";

/** Structural subset of a dsh text content block. */
interface TextBlock {
  type: "text";
  text: string;
}

/** Structural subset of the dsh-llm `UserMessage` (plugin-sourced). */
interface UserMessage {
  id: string;
  role: "user";
  content: TextBlock[];
  source: { kind: "plugin"; plugin: string };
}

/** Tool output value; must satisfy the JSON Schema in `output.schema`. */
type HandoffOutput =
  | { outcome: "handoff"; newSessionId: string }
  | { outcome: "stayed"; denialReason?: string };

/** Structural subset of the dsh-agent `Agent`. */
interface Agent {
  readonly options: { provider?: string; model?: string };
  readonly session: { readonly header: { cwd?: string; agentPreset?: string } };
  followup(message: UserMessage): void;
}

/** Scope context of a composing agent; only forwarded to `agentPresets.mount`. */
type AgentScopeContext = unknown;

/** Structural subset of the dsh-agent-presets `AgentPresets`. */
interface AgentPresets {
  resolve(id?: string): Promise<{ id: string }>;
  mount(agentCtx: AgentScopeContext, id?: string): Promise<unknown>;
}

/** Structural subset of the dsh-tools `ToolRunContext`. */
interface ToolRunContext {
  readonly agent?: Agent;
  readonly signal: AbortSignal;
}

/** Structural subset of the dsh-tools `ToolDefinition`. */
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: HandoffOutput): TextBlock[];
  };
  execute(args: unknown, exec: ToolRunContext): Promise<HandoffOutput>;
}

/** Structural subset of the dsh-tools `ToolRuntime` registry. */
interface ToolRegistry {
  register(definition: ToolDefinition): () => void;
}

/** Structural subset of the dsh-agent `AgentRegistry.create` options/result. */
interface AgentRegistry {
  create(options: {
    sessionId: string;
    signal?: AbortSignal;
    agentOptions?: { provider?: string; model?: string };
    meta?: { cwd?: string; agentPreset?: string };
    setup?(agentCtx: AgentScopeContext): void | Promise<void>;
  }): Promise<{ agent: Agent; dispose(): Promise<void> }>;
}

/** Structural subset of the dsh-user-questions `UserQuestionService`. */
interface UserQuestions {
  ask(request: {
    questions: {
      id: string;
      question: string;
      detail?: string;
      header?: string;
      options?: { label: string }[];
    }[];
    agent?: Agent;
    signal?: AbortSignal;
  }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>;
}

/** Disposer returned by effect bodies and by `register`. */
type Disposer = () => void;

/** Structural subset of the cordis `Context` used by this plugin. */
interface HandoffContext {
  tools: ToolRegistry;
  agents: AgentRegistry;
  userQuestions: UserQuestions;
  /** Optional service: absent in rosterless deployments (host-plane tools only). */
  get(service: "agentPresets"): AgentPresets | undefined;
  effect(execute: () => Generator<Disposer | Promise<void>, void, unknown>, label?: string): unknown;
}

export function apply(ctx: HandoffContext): void {
  ctx.effect(function* () {
    yield ctx.tools.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why the current session ends (non-empty)",
          },
          handoff: {
            type: "string",
            description:
              "Prompt to auto-send to the next agent: continuation goal, " +
              "approved spec paths, decisions, work state, open questions, done conditions",
          },
        },
        required: ["reason", "handoff"],
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: ["handoff", "stayed"] },
            newSessionId: { type: "string" },
            denialReason: { type: "string" },
          },
          required: ["outcome"],
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.outcome === "handoff"
                ? `Handoff complete. Brand-new session ${value.newSessionId} received the handoff prompt as its first user message. ` +
                  "Open the new session in the sidebar to continue; this session stays in the list as history."
                : "Handoff declined; staying in the current session.",
          },
        ],
      },
      execute: (args, exec) => executeHandoff(ctx, args, exec),
    });
  }, "handoff_session tool");
}

async function executeHandoff(
  ctx: HandoffContext,
  rawArgs: unknown,
  exec: ToolRunContext,
): Promise<HandoffOutput> {
  const args = rawArgs as { reason?: unknown; handoff?: unknown };
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  const handoff = typeof args.handoff === "string" ? args.handoff.trim() : "";
  if (!reason || !handoff) {
    throw new Error("Both reason and handoff must be non-empty strings.");
  }
  if (!exec.agent) {
    throw new Error("handoff_session requires an owning agent session.");
  }

  const answer = await ctx.userQuestions.ask({
    questions: [
      {
        id: CONFIRM_QUESTION_ID,
        header: "Handoff session",
        question: "End this session and move to a brand-new session?",
        detail: `Reason:\n${reason}\n\nPrompt for the next agent:\n${handoff}`,
        options: [{ label: APPROVE_OPTION }, { label: STAY_OPTION }],
      },
    ],
    agent: exec.agent,
    signal: exec.signal,
  });
  const selectedLabel = answer.answers
    .find((item) => item.id === CONFIRM_QUESTION_ID)
    ?.selected.at(0);
  if (selectedLabel !== APPROVE_OPTION) {
    return stayInCurrentSession(ctx, exec.agent, exec.signal, answer);
  }

  const newSessionId = `handoff-${crypto.randomUUID()}`;
  const { header } = exec.agent.session;
  // Mirror the canonical web creation path (SessionController.composeAgent):
  // resolve the preset first, then mount it in setup so the new session gets
  // the same tool/prompt composition. Undefined preset id resolves the default.
  const presets = ctx.get("agentPresets");
  let presetId: string | undefined;
  let setup: ((agentCtx: AgentScopeContext) => Promise<void>) | undefined;
  if (presets) {
    presetId = (await presets.resolve(header.agentPreset)).id;
    setup = async (agentCtx) => {
      await presets.mount(agentCtx, presetId);
    };
  }

  // Carry the current model route so the next agent continues on the same
  // provider/model instead of the deployment default.
  const { provider, model } = exec.agent.options;
  const handle = await ctx.agents.create({
    sessionId: newSessionId,
    signal: exec.signal,
    ...(provider === undefined && model === undefined
      ? {}
      : { agentOptions: { provider, model } }),
    meta: {
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(presetId === undefined ? {} : { agentPreset: presetId }),
    },
    setup,
  });
  // Successful followup is the commit point (webhook pattern): after it the
  // handoff happened and failures must not roll the new session back.
  handle.agent.followup(userMessage(handoff));
  return { outcome: "handoff", newSessionId };
}

async function stayInCurrentSession(
  ctx: HandoffContext,
  agent: Agent,
  signal: AbortSignal,
  confirmAnswer: { answers: { id: string; selected: string[]; custom?: string }[] },
): Promise<HandoffOutput> {
  const typedCustom = confirmAnswer.answers
    .find((item) => item.id === CONFIRM_QUESTION_ID)
    ?.custom?.trim();
  let denialReason = typedCustom ?? "";
  // The typed answer may already carry the reason; ask only when it does not.
  if (!denialReason) {
    try {
      const denialAnswer = await ctx.userQuestions.ask({
        questions: [
          {
            id: DENIAL_REASON_QUESTION_ID,
            header: "Handoff declined",
            question: "Optional reason for the agent (free text):",
          },
        ],
        agent,
        signal,
      });
      denialReason =
        denialAnswer.answers
          .find((item) => item.id === DENIAL_REASON_QUESTION_ID)
          ?.custom?.trim() ?? "";
    } catch {
      // Cancelled or unavailable input; pi parity falls back to an empty reason.
    }
  }
  agent.followup(userMessage(`no(${denialReason})`));
  return denialReason ? { outcome: "stayed", denialReason } : { outcome: "stayed" };
}

function userMessage(text: string): UserMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: PLUGIN_SOURCE },
  };
}
