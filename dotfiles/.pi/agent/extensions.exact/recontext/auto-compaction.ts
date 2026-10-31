import type {
  Api,
  Message,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSystemMessageText, hasApi } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import {
  createReplacement,
  matchMessageSources,
  replaceRequestMessages,
  type ProjectionManager,
} from "./projection.ts";

export const SUMMARY_INSTRUCTION =
  "次のエージェントが続きを理解できるよう、古い会話を要約せよ。この要約の後に、最新のやり取りが原文のまま続く。要約には、目的、決定事項、制約、現在の作業、未完了のタスクを含めよ。後続の原文から参照される対象と選択肢を明確にせよ。作業を続行せず、ツールを呼び出さず、引継ぎ要約だけを出力せよ。";
const CONTEXT_SAFETY_TOKENS = 4096;
const CHARACTERS_PER_TOKEN = 3.5;
const IMAGE_CHARACTERS = 4800;
const DEFAULT_THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const OUTPUT_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

export type CompactionOptions = Omit<SimpleStreamOptions, "toolChoice"> & {
  toolChoice?: unknown;
  reasoningEffort?: ModelThinkingLevel | "none";
  reasoningSummary?: unknown;
};

export interface CompactionCandidate {
  keptExchanges: number;
  targetIds: Set<string>;
  summaryContext: TranscriptContext;
  maxTokens: number;
}

export function requestFits(
  model: Model<Api>,
  context: TranscriptContext,
  options: CompactionOptions,
  simple = true,
): boolean {
  return (
    estimateInput(context.messages) +
      outputBudget(model, options, simple) +
      CONTEXT_SAFETY_TOKENS <=
    model.contextWindow
  );
}

export function compactionCandidates(
  manager: ProjectionManager,
  entries: ProjectedSessionEntry[],
  model: Model<Api>,
  context: TranscriptContext,
  options: CompactionOptions,
  simple = true,
): CompactionCandidate[] {
  const sources = matchMessageSources(context.messages, entries);
  const complete = completedExchanges(context.messages);
  const candidates: CompactionCandidate[] = [];
  for (let keptExchanges = 1; keptExchanges <= complete.length; keptExchanges++) {
    const cut = complete[complete.length - keptExchanges]!;
    const prefix = context.messages.slice(0, cut);
    if (!hasClosedTools(prefix)) continue;
    const targetIds = new Set(
      sources
        .slice(0, cut)
        .filter((entry) => entry !== undefined)
        .map((entry) => entry!.sourceEntry.id),
    );
    const hasAnchor = entries.some(
      ({ sourceEntry, messages }) =>
        targetIds.has(sourceEntry.id) &&
        messages.length > 0 &&
        (sourceEntry.type === "custom_message" ||
          (sourceEntry.type === "message" && sourceEntry.message.role === "user")),
    );
    if (!hasAnchor) continue;
    const emptyReplacement = createReplacement(manager, entries, targetIds, "");
    const summaryContext = {
      ...context,
      messages: [
        ...prefix,
        ...context.messages.slice(cut).filter((message) => message.role === "system"),
        { role: "user" as const, content: SUMMARY_INSTRUCTION, timestamp: Date.now() },
      ],
    };
    const compressed = replaceRequestMessages(context.messages, sources, emptyReplacement);
    const summaryRoom =
      model.contextWindow - estimateInput(summaryContext.messages) - CONTEXT_SAFETY_TOKENS;
    const normalRoom =
      model.contextWindow -
      estimateInput(compressed) -
      outputBudget(model, options, simple) -
      CONTEXT_SAFETY_TOKENS;
    const outputRoom = Math.floor(Math.min(model.maxTokens, summaryRoom, normalRoom));
    const extraThinking = thinkingExpansion(model, options, simple);
    const maxTokens = outputRoom >= model.maxTokens ? outputRoom : outputRoom - extraThinking;
    if (maxTokens < 1) continue;
    const summaryOptions = summaryRequestOptions(model, options, maxTokens, simple);
    if (
      outputBudget(model, summaryOptions, simple) > outputRoom ||
      !requestFits(model, summaryContext, summaryOptions, simple)
    )
      continue;
    candidates.push({ keptExchanges, targetIds, summaryContext, maxTokens });
  }
  return candidates;
}

export function summaryRequestOptions(
  model: Model<Api>,
  options: CompactionOptions,
  maxTokens: number,
  simple = true,
): CompactionOptions {
  if (model.api === "openai-responses" || model.api === "azure-openai-responses")
    maxTokens = Math.max(OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, maxTokens);
  const isolated = { ...options };
  delete isolated.onPayload;
  delete isolated.onResponse;
  delete isolated.onProviderStreamEvent;
  delete isolated.telemetry;
  const samplingParams = samplingParameters(model, options, simple);
  for (const field of OUTPUT_FIELDS) {
    if (field in samplingParams) samplingParams[field] = maxTokens;
  }
  return { ...isolated, maxTokens, samplingParams };
}

export function outputBudget(model: Model<Api>, options: CompactionOptions, simple = true): number {
  const parameters = samplingParameters(model, options, simple);
  let tokens = options.maxTokens ?? model.maxTokens;
  const thinking = thinkingExpansion(model, options, simple);
  if (thinking > 0) tokens = Math.min(model.maxTokens, tokens + thinking);
  if (model.api === "openai-responses" || model.api === "azure-openai-responses") {
    const omitsNamedCap =
      hasApi(model, "openai-responses") &&
      (model.compat?.supportsMaxOutputTokens === false ||
        (model.provider === "openai" &&
          model.baseUrl === "https://api.openai.com/v1" &&
          options.apiKey !== undefined &&
          !options.apiKey.startsWith("sk-")));
    if (omitsNamedCap) tokens = model.maxTokens;
    else
      tokens =
        options.maxTokens === 0
          ? model.maxTokens
          : Math.max(OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, tokens);
    if ("max_output_tokens" in parameters)
      tokens = samplingCap(parameters, "max_output_tokens", model.maxTokens);
  } else if (hasApi(model, "openai-completions")) {
    const field = completionOutputField(model);
    const caps = {
      ...((simple || options.maxTokens !== undefined) && tokens ? { [field]: tokens } : {}),
      ...Object.fromEntries(
        ["max_tokens", "max_completion_tokens"]
          .filter((key) => key in parameters)
          .map((key) => [key, parameters[key]]),
      ),
    };
    const values = Object.keys(caps).map((key) => samplingCap(caps, key, model.maxTokens));
    tokens = values.length > 0 ? Math.max(...values) : model.maxTokens;
  } else if (model.api === "openai-codex-responses") {
    tokens = model.maxTokens;
  } else if (
    ![
      "anthropic-messages",
      "bedrock-converse-stream",
      "google-generative-ai",
      "google-vertex",
      "mistral-conversations",
      "pi-messages",
    ].includes(model.api)
  ) {
    for (const field of OUTPUT_FIELDS) {
      if (field in parameters) tokens = Math.max(tokens, samplingCap(parameters, field, tokens));
    }
  }
  if (
    !Number.isFinite(tokens) ||
    tokens <= 0 ||
    !Number.isFinite(model.contextWindow) ||
    model.contextWindow <= 0
  )
    throw new Error("The model has no usable context or output budget");
  return Math.ceil(tokens);
}

function samplingParameters(model: Model<Api>, options: CompactionOptions, simple: boolean) {
  const rawLevel =
    options.reasoningEffort ??
    ((model.api === "openai-responses" || model.api === "azure-openai-responses") &&
    options.reasoningSummary
      ? "medium"
      : "off");
  const requested = simple ? (options.reasoning ?? "off") : rawLevel;
  const level = clampThinkingLevel(model, requested === "none" ? "off" : requested);
  return {
    ...model.samplingParams,
    ...model.samplingParamsByThinkingLevel?.[level],
    ...options.samplingParams,
  };
}

function samplingCap(parameters: Record<string, unknown>, field: string, fallback: number): number {
  const value = parameters[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error("The model has no usable context or output budget");
  return value;
}

function completionOutputField(model: Model<"openai-completions">) {
  if (model.compat?.maxTokensField) return model.compat.maxTokensField;
  const legacyProvider = [
    "deepseek",
    "moonshotai",
    "moonshotai-cn",
    "cloudflare-ai-gateway",
    "together",
    "nvidia",
    "ant-ling",
    "zai",
    "zai-coding-cn",
  ].includes(model.provider);
  const legacyUrl =
    model.baseUrl.toLowerCase().includes("deepseek.com") ||
    [
      "chutes.ai",
      "api.moonshot.",
      "gateway.ai.cloudflare.com",
      "api.together.ai",
      "api.together.xyz",
      "integrate.api.nvidia.com",
      "api.ant-ling.com",
      "api.z.ai",
      "open.bigmodel.cn",
    ].some((url) => model.baseUrl.includes(url));
  return legacyProvider || legacyUrl ? "max_tokens" : "max_completion_tokens";
}

export function estimateInput(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function thinkingExpansion(model: Model<Api>, options: CompactionOptions, simple: boolean): number {
  if (!simple || !options.reasoning) return 0;
  const legacyAnthropic =
    hasApi(model, "anthropic-messages") && model.compat?.forceAdaptiveThinking !== true;
  const labels = [model.id.toLowerCase(), model.name?.toLowerCase() ?? ""];
  const claude =
    labels.some(
      (label) => label.includes("anthropic.claude") || label.includes("anthropic/claude"),
    ) || labels[1]!.includes("claude");
  const normalized = labels.flatMap((label) => [label, label.replace(/[\s_.:]+/g, "-")]);
  const adaptive = [
    "opus-4-6",
    "opus-4-7",
    "opus-4-8",
    "opus-5",
    "sonnet-4-6",
    "sonnet-5",
    "haiku-5",
    "fable-5",
  ].some((name) => normalized.some((label) => label.includes(name)));
  const legacyBedrock = model.api === "bedrock-converse-stream" && claude && !adaptive;
  if (!legacyAnthropic && !legacyBedrock) return 0;
  return { ...DEFAULT_THINKING_BUDGETS, ...options.thinkingBudgets }[
    options.reasoning === "max" || options.reasoning === "xhigh" ? "high" : options.reasoning
  ];
}

function completedExchanges(messages: Message[]): number[] {
  const complete: number[] = [];
  let start: number | undefined;
  let lastConversation: Message | undefined;
  let span: Message[] = [];
  function finish(): void {
    if (
      start !== undefined &&
      lastConversation?.role === "assistant" &&
      lastConversation.stopReason === "stop" &&
      hasClosedTools(span)
    )
      complete.push(start);
  }
  for (const [index, message] of messages.entries()) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      finish();
      start = index;
      span = [];
    }
    span.push(message);
    lastConversation = message;
  }
  finish();
  return complete;
}

function hasClosedTools(messages: Message[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") pending.add(block.id);
      }
    }
    if (message.role === "toolResult" && !pending.delete(message.toolCallId)) return false;
    if (message.role === "user" && pending.size > 0) return false;
  }
  return pending.size === 0;
}

function estimateMessageTokens(message: Message): number {
  let characters = 0;
  if (message.role === "system") {
    characters = getSystemMessageText(message).length;
    if (message.toolsAdded?.length) characters += JSON.stringify(message.toolsAdded).length;
    if (message.toolsRemoved?.length) characters += JSON.stringify(message.toolsRemoved).length;
  } else if (typeof message.content === "string") {
    characters = message.content.length;
  } else {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          characters += block.text.length;
          break;
        case "thinking":
          characters += block.thinking.length;
          break;
        case "toolCall":
          characters += block.name.length + JSON.stringify(block.arguments).length;
          break;
        case "image":
          characters += IMAGE_CHARACTERS;
          break;
      }
    }
  }
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}
