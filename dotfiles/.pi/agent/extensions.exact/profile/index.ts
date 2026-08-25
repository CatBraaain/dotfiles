import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
  createLocalBashOperations,
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spinnerFrame } from "../titlebar/index.ts";
import { parse as parseYaml } from "yaml";
import {
  bashExecFrom,
  DEFAULT_COOLDOWN_MS,
  evalWhen,
  isManualSelect,
  isRateLimitedError,
  modelKey,
  parseRetryAfter,
  pickCandidate,
  recordCooldown,
  WHEN_TIMEOUT_MS,
  type ModelCandidate,
} from "./routing.ts";
import {
  formatToolCall,
  formatToolResultSummary,
  type ToolResultLike,
  type ToolTheme,
} from "../shared/tool-format.ts";

export type Profile = string;

export interface ProfileDefinition {
  tier: string;
  tools: readonly string[];
  subagents: readonly Profile[];
  systemPrompt: readonly string[];
}

export interface ProfileConfig {
  default: Profile;
  tiers: Record<string, readonly ModelCandidate[]>;
  profiles: Record<Profile, ProfileDefinition>;
}

export interface ConfigLoadResult {
  config?: ProfileConfig;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// tier の候補配列 1 件分を検証する。不正ならエラーメッセージを返す。
function parseCandidates(raw: unknown, tierName: string): ModelCandidate[] | string {
  if (!Array.isArray(raw)) return `tier ${tierName} must be an array of candidates`;
  const candidates: ModelCandidate[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return `tier ${tierName} candidate must be an object`;
    const { provider, model, when } = entry;
    if (!isNonEmptyString(provider) || !isNonEmptyString(model)) {
      return `tier ${tierName} candidate needs provider and model strings`;
    }
    if (when !== undefined && typeof when !== "string") {
      return `tier ${tierName} candidate has an invalid when`;
    }
    candidates.push(when === undefined ? { provider, model } : { provider, model, when });
  }
  return candidates;
}

export function parseProfileConfig(source: string): ConfigLoadResult {
  try {
    const document = parseYaml(source) as unknown;
    if (
      !isRecord(document) ||
      !isNonEmptyString(document.default) ||
      !isRecord(document.profiles)
    ) {
      return { error: "default and profiles are required" };
    }
    if (!isRecord(document.tiers)) return { error: "tiers are required" };

    const tiers: Record<string, readonly ModelCandidate[]> = {};
    for (const [tierName, rawCandidates] of Object.entries(document.tiers)) {
      const candidates = parseCandidates(rawCandidates, tierName);
      if (typeof candidates === "string") return { error: candidates };
      tiers[tierName] = candidates;
    }

    const profiles: Record<Profile, ProfileDefinition> = {};
    for (const [name, rawDefinition] of Object.entries(document.profiles)) {
      if (!isRecord(rawDefinition)) return { error: `profile ${name} must be an object` };
      const { tier, tools, subagents, systemPrompt } = rawDefinition;
      if (!isNonEmptyString(tier)) return { error: `profile ${name} has an invalid tier` };
      if (!(tier in tiers)) return { error: `profile ${name} references undefined tier ${tier}` };
      if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
        return { error: `profile ${name} has invalid tools` };
      }
      if (!Array.isArray(subagents) || !subagents.every((profile) => typeof profile === "string")) {
        return { error: `profile ${name} has invalid subagents` };
      }
      if (
        !Array.isArray(systemPrompt) ||
        !systemPrompt.every((prompt) => typeof prompt === "string")
      ) {
        return { error: `profile ${name} has an invalid systemPrompt` };
      }
      profiles[name] = { tier, tools, subagents, systemPrompt };
    }

    if (!profiles[document.default])
      return { error: `default profile ${document.default} is not defined` };
    for (const [name, definition] of Object.entries(profiles)) {
      const unknownSubagent = definition.subagents.find((profile) => !profiles[profile]);
      if (unknownSubagent)
        return { error: `profile ${name} delegates to undefined profile ${unknownSubagent}` };
    }

    return { config: { default: document.default, tiers, profiles } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function loadProfileConfig(
  configPath = join(getAgentDir(), "extensions", "profile", "config.yaml"),
): ConfigLoadResult {
  if (!existsSync(configPath)) return { error: `config file not found: ${configPath}` };
  try {
    return parseProfileConfig(readFileSync(configPath, "utf8"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function initialProfile(config: ProfileConfig, requestedProfile?: Profile): Profile {
  return requestedProfile && config.profiles[requestedProfile] ? requestedProfile : config.default;
}

export function isToolAllowed(profile: Profile, toolName: string, config: ProfileConfig): boolean {
  if (toolName === "subagent") return true;
  const tools = config.profiles[profile]?.tools ?? [];
  return tools.includes("*") || tools.includes(toolName);
}

export function shouldBlockToolCall(
  profile: Profile,
  toolName: string,
  config: ProfileConfig,
): boolean {
  return !isToolAllowed(profile, toolName, config);
}

export function buildProfileSystemPromptAddendum(profile: Profile, config: ProfileConfig): string {
  const prompts = (config.profiles[profile]?.systemPrompt ?? []).filter(Boolean);
  return prompts.length > 0 ? `\n\n${prompts.join("\n\n")}` : "";
}

export function canDelegate(
  fromProfile: Profile,
  toProfile: Profile,
  config: ProfileConfig,
): boolean {
  return config.profiles[fromProfile]?.subagents.includes(toProfile) ?? false;
}

export function childProfile(
  fromProfile: Profile,
  toProfile: Profile,
  config: ProfileConfig,
): Profile | undefined {
  return canDelegate(fromProfile, toProfile, config) ? toProfile : undefined;
}

export const __spawn: { current: typeof spawn } = { current: spawn };

export const __abortTimer: {
  set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
} = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timer) => clearTimeout(timer),
};

// /reload で拡張インスタンスが再生成されても手動選択状態と cooldown を維持するため、
// session_shutdown 時に globalThis へ退避し、次インスタンスの session_start で復元する。
interface SavedRoutingState {
  profile: Profile;
  manual: boolean;
  cooldowns: Map<string, number>;
}

const ROUTING_STATE_KEY = "__piProfileRoutingState";

function saveRoutingState(state: SavedRoutingState): void {
  (globalThis as Record<string, unknown>)[ROUTING_STATE_KEY] = state;
}

function takeSavedRoutingState(): SavedRoutingState | undefined {
  return (globalThis as Record<string, unknown>)[ROUTING_STATE_KEY] as
    | SavedRoutingState
    | undefined;
}

export function __resetRoutingState(): void {
  delete (globalThis as Record<string, unknown>)[ROUTING_STATE_KEY];
}

const SPINNER_INTERVAL_MS = 100;
const EXIT_STDIO_GRACE_MS = 100;

export const __spinnerTimers: {
  set: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clear: (timer: ReturnType<typeof setInterval>) => void;
  now: () => number;
} = {
  set: (callback, intervalMs) => setInterval(callback, intervalMs),
  clear: (timer) => clearInterval(timer),
  now: () => Date.now(),
};

let tuiHandle: { requestRender: () => void } | undefined;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let pendingChildren = 0;

function startSpinnerTimer(): void {
  if (spinnerTimer !== undefined) return;
  spinnerTimer = __spinnerTimers.set(() => tuiHandle?.requestRender(), SPINNER_INTERVAL_MS);
}

function stopSpinnerTimerIfIdle(): void {
  if (pendingChildren <= 0 && spinnerTimer !== undefined) {
    __spinnerTimers.clear(spinnerTimer);
    spinnerTimer = undefined;
  }
}

interface ChildAction {
  toolCallId?: string;
  name: string;
  args: Record<string, unknown>;
  startedAt?: number;
  endedAt?: number;
  result?: ToolResultLike;
  isError?: boolean;
}

interface ChildRun {
  profile: Profile;
  task: string;
  cwd: string;
  pending: boolean;
  exitCode: number;
  messages: Message[];
  actions: ChildAction[];
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
}

interface ProfileToolDetails {
  results: ChildRun[];
}

function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function getFinalOutput(messages: Message[]): string {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function isFailedResult(result: ChildRun): boolean {
  // exit 0 でも最終アシスタント出力が空なら、モデル未割当等の静かな失敗として扱う
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    getFinalOutput(result.messages) === ""
  );
}

function getResultOutput(result: ChildRun): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executableName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executableName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

type OnUpdateCallback = (partialResult: AgentToolResult<ProfileToolDetails>) => void;

async function runChild(
  defaultCwd: string,
  task: string,
  profile: Profile,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<ChildRun> {
  // モデルは渡さない。子セッションが自分の profile の tier から解決する。
  const args = ["--mode", "json", "-p", "--no-session", "--profile", profile, `Task: ${task}`];
  const childResult: ChildRun = {
    profile,
    task,
    cwd: cwd ?? defaultCwd,
    pending: true,
    exitCode: 0,
    messages: [],
    actions: [],
    stderr: "",
  };
  let wasAborted = false;

  const emitUpdate = () => {
    onUpdate?.({
      content: [textPart(getFinalOutput(childResult.messages) || "(running...)")],
      details: { results: [childResult] },
    });
  };

  emitUpdate();

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const processHandle = __spawn.current(invocation.command, invocation.args, {
      cwd: childResult.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    let processExitCode: number | null | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdleTimer = () => {
      if (idleTimer !== undefined) {
        __abortTimer.clear(idleTimer);
        idleTimer = undefined;
      }
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", killChild);
      if (abortTimer !== undefined) {
        __abortTimer.clear(abortTimer);
        abortTimer = undefined;
      }
      clearIdleTimer();
      processHandle.stdout?.destroy();
      processHandle.stderr?.destroy();
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "message_end" && event.message) {
        const message = event.message as Message;
        childResult.messages.push(message);
        if (message.role === "assistant") {
          if (message.stopReason) childResult.stopReason = message.stopReason;
          if (message.errorMessage) childResult.errorMessage = message.errorMessage;
        }
        emitUpdate();
      }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        childResult.actions.push({
          toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          name: event.toolName,
          args: isRecord(event.args) ? event.args : {},
          startedAt: Date.now(),
        });
        emitUpdate();
      }
      if (event.type === "tool_execution_update") emitUpdate();
      if (event.type === "tool_execution_end") {
        const action = childResult.actions.find(
          (candidate) =>
            candidate.toolCallId !== undefined && candidate.toolCallId === event.toolCallId,
        );
        if (action) {
          action.endedAt = Date.now();
          action.result = isRecord(event.result) ? event.result : undefined;
          action.isError = event.isError === true;
        }
        emitUpdate();
      }
      if (event.type === "tool_result_end" && event.message) {
        childResult.messages.push(event.message as Message);
        emitUpdate();
      }
    };

    // ponytail: 孫プロセスが stdout の fd を握ると close が永久に来ない。
    // pi 本体の waitForChildProcess と同じく、exit 後は stdio が 0.1 秒静穏になった時点で確定する
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (buffer.trim()) processLine(buffer);
      if (code === null && !wasAborted) {
        childResult.stopReason = "killed";
        childResult.errorMessage = "Child process was killed by a signal";
      }
      resolve(code ?? 1);
    };

    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = __abortTimer.set(() => {
        idleTimer = undefined;
        if (processExitCode !== undefined) finalize(processExitCode);
      }, EXIT_STDIO_GRACE_MS);
    };

    const killChild = () => {
      if (wasAborted) return;
      wasAborted = true;
      processHandle.kill("SIGTERM");
      abortTimer = __abortTimer.set(() => {
        if (!settled) processHandle.kill("SIGKILL");
      }, 5000);
    };

    processHandle.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
      if (processExitCode !== undefined && !settled) armIdleTimer();
    });
    processHandle.stderr.on("data", (data) => {
      childResult.stderr += data.toString();
      if (processExitCode !== undefined && !settled) armIdleTimer();
    });
    processHandle.on("exit", (code) => {
      processExitCode = code;
      if (!settled) armIdleTimer();
    });
    processHandle.on("close", (code) => {
      finalize(code);
    });
    processHandle.on("error", (error) => {
      childResult.errorMessage = error.message;
      finalize(1);
    });

    if (signal?.aborted) killChild();
    else signal?.addEventListener("abort", killChild, { once: true });
  });

  childResult.exitCode = exitCode;
  childResult.pending = false;
  if (wasAborted) {
    childResult.stopReason = "aborted";
    childResult.errorMessage = "Subagent was aborted";
  }
  return childResult;
}

function registerProfileWidget(
  ctx: ExtensionContext,
  currentProfile: () => Profile,
  isManual: () => boolean,
): void {
  ctx.ui.setWidget(
    "profile",
    (ui, theme) => {
      tuiHandle = ui;
      return {
        render: () => {
          const suffix = isManual() ? " (manual)" : "";
          return [theme.fg("dim", `🤖 profile: ${currentProfile()}${suffix}`)];
        },
        invalidate: () => {},
      };
    },
    { placement: "aboveEditor" },
  );
}

export default function profileExtension(
  pi: ExtensionAPI,
  injectedConfig: ConfigLoadResult = loadProfileConfig(),
): void {
  const loadedConfig = injectedConfig;
  const config = loadedConfig.config;
  let currentProfile = config?.default ?? "invalid";

  pi.registerFlag("profile", { type: "string", description: "Profile for a child session." });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn an isolated child pi process using a configured profile.",
    parameters: Type.Object({
      task: Type.String({ description: "Task to delegate to the child process" }),
      profile: Type.String({ description: "Configured child profile name" }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory; defaults to the parent cwd" }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!config)
        return {
          content: [textPart(`Profile configuration error: ${loadedConfig.error}`)],
          details: { results: [] },
          isError: true,
        };
      if (!params.task)
        return {
          content: [textPart("Invalid parameters. Provide a task.")],
          details: { results: [] },
        };
      if (!config.profiles[params.profile]) {
        return {
          content: [textPart(`Cannot delegate: profile ${params.profile} is not defined.`)],
          details: { results: [] },
          isError: true,
        };
      }
      if (!canDelegate(currentProfile, params.profile, config)) {
        return {
          content: [
            textPart(
              `Permission denied: profile ${currentProfile} cannot delegate to ${params.profile}.`,
            ),
          ],
          details: { results: [] },
          isError: true,
        };
      }

      pendingChildren++;
      startSpinnerTimer();
      let result: ChildRun;
      try {
        result = await runChild(ctx.cwd, params.task, params.profile, params.cwd, signal, onUpdate);
      } finally {
        pendingChildren--;
        stopSpinnerTimerIfIdle();
      }
      if (isFailedResult(result)) {
        return {
          content: [textPart(`Child ${result.stopReason || "failed"}: ${getResultOutput(result)}`)],
          details: { results: [result] },
          isError: true,
        };
      }
      return {
        content: [textPart(getFinalOutput(result.messages) || "(no output)")],
        details: { results: [result] },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(`subagent ${args.profile ?? "..."}`)), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as ProfileToolDetails | undefined;
      const childResult = details?.results[0];
      if (!childResult) {
        const fallback = result.content[0];
        return new Text(fallback?.type === "text" ? fallback.text : "(no output)", 0, 0);
      }

      const actions = childResult.actions;
      const finalOutput = getFinalOutput(childResult.messages);
      const childCwd = childResult.cwd ?? process.cwd();
      const toolTheme: ToolTheme = { fg: theme.fg.bind(theme), bold: theme.bold.bind(theme) };
      const container = new Container();
      container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
      container.addChild(new Text(theme.fg("dim", childResult.task), 0, 0));
      if (actions.length > 0) {
        container.addChild(new Text(theme.fg("muted", "─── Actions ───"), 0, 0));
        for (const action of actions) {
          const callText = formatToolCall(action.name, action.args, childCwd, toolTheme);
          container.addChild(new Text(`${theme.fg("muted", "→ ")}${callText}`, 0, 0));
          const durationMs =
            action.startedAt !== undefined && action.endedAt !== undefined
              ? action.endedAt - action.startedAt
              : undefined;
          const summary =
            action.result !== undefined
              ? formatToolResultSummary(
                  action.name,
                  action.args,
                  action.result,
                  { isError: action.isError, durationMs },
                  toolTheme,
                )
              : undefined;
          if (summary !== undefined) container.addChild(new Text(`  ${summary}`, 0, 0));
        }
      }
      if (finalOutput && !options.isPartial) {
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
      }
      if (childResult.pending) {
        container.addChild({
          render: () =>
            childResult.pending
              ? [theme.fg("muted", `${spinnerFrame(__spinnerTimers.now())} ${childResult.profile}`)]
              : [],
          invalidate: () => {},
        });
      }
      return container;
    },
  });

  if (!config) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(`profile configuration error: ${loadedConfig.error}`, "error");
    });
    return;
  }

  // ── model routing state ─────────────────────────────────────────────
  let manual = false; // user picked a model manually -> suspend auto-routing
  let switching = false; // our own setModel is in flight (NOT "manual")
  let cooldowns = new Map<string, number>(); // modelKey -> expiry epoch ms
  let httpRateLimitAwaitingMessage: { modelKey: string; fallbackSucceeded: boolean } | undefined;

  const bashExec = bashExecFrom(createLocalBashOperations());
  const runWhen = (when: string | undefined, signal?: AbortSignal) =>
    evalWhen(when, bashExec, WHEN_TIMEOUT_MS, signal);

  async function switchTo(model: Model<Api>): Promise<boolean> {
    switching = true;
    try {
      return await pi.setModel(model);
    } finally {
      switching = false;
    }
  }

  // tier の候補を先頭から適用する。レジストリ不在・cooldown・when 不成立の候補は
  // pickCandidate が飛ばし、適用に失敗した候補（API キー欠如等）は除外して次候補へ
  // 進む。現在のモデルと同じ候補なら切り替えない。全候補不成立なら null。
  // notifySwitch を false にすると切替時の `profile model →` 通知を省く（429 フォールバックは
  // 「レート制限時のフォールバック」節の通知が専らを定めるため）。
  async function applyTierModel(
    profile: Profile,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    notifySwitch = true,
  ): Promise<string | null> {
    const tierName = config.profiles[profile]?.tier;
    if (!tierName) return null;
    let candidates = config.tiers[tierName] ?? [];
    for (;;) {
      const model = await pickCandidate(
        candidates,
        cooldowns,
        (provider, id) => ctx.modelRegistry.find(provider, id),
        (when) => runWhen(when, signal),
        Date.now(),
      );
      if (!model) return null;
      if (ctx.model && ctx.model.provider === model.provider && ctx.model.id === model.id) {
        return modelKey(model);
      }
      if (await switchTo(model)) {
        if (notifySwitch && ctx.hasUI)
          ctx.ui.notify(`profile model → ${model.provider}/${model.id}`, "info");
        return modelKey(model);
      }
      const failed = model;
      candidates = candidates.filter(
        (candidate) => !(candidate.provider === failed.provider && candidate.model === failed.id),
      );
    }
  }

  function notifyNoModel(
    profile: Profile,
    ctx: ExtensionContext,
    level: "warning" | "error",
  ): void {
    const message = `no available model for profile ${profile}: tier ${config.profiles[profile].tier}`;
    if (!ctx.hasUI) {
      // UI のない子プロセスでは通知が見えないまま終わるため、stderr と終了コードで伝える
      if (level === "error") {
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    ctx.ui.notify(message, level);
  }

  function applyProfileTools(ctx: ExtensionContext, profile: Profile): void {
    const profileDefinition = config.profiles[profile];
    const activeTools = profileDefinition.tools.includes("*")
      ? pi.getAllTools().map((tool) => tool.name)
      : [...new Set([...profileDefinition.tools, "subagent"])];
    pi.setActiveTools(activeTools);
    registerProfileWidget(
      ctx,
      () => currentProfile,
      () => manual,
    );
  }

  // ── session lifecycle ───────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload") {
      // 設定を読み込み直す。手動選択状態と cooldown は維持し、モデルは変更しない。
      const saved = takeSavedRoutingState();
      if (saved) {
        currentProfile = config.profiles[saved.profile]
          ? saved.profile
          : initialProfile(config, pi.getFlag("profile") as string | undefined);
        manual = saved.manual;
        cooldowns = saved.cooldowns;
      }
      applyProfileTools(ctx, currentProfile);
      return;
    }

    manual = false;
    // /new は cooldown をすべて破棄する。セッション切替・分岐（resume/fork）は維持する。
    cooldowns =
      event.reason === "startup" || event.reason === "new"
        ? new Map()
        : (takeSavedRoutingState()?.cooldowns ?? new Map());
    currentProfile = initialProfile(config, pi.getFlag("profile") as string | undefined);
    applyProfileTools(ctx, currentProfile);
    const applied = await applyTierModel(currentProfile, ctx);
    if (!applied) notifyNoModel(currentProfile, ctx, "warning");
  });

  pi.on("session_shutdown", async () => {
    saveRoutingState({ profile: currentProfile, manual, cooldowns });
  });

  // ── pre-prompt re-evaluation ────────────────────────────────────────

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || manual) return;
    const applied = await applyTierModel(currentProfile, ctx, ctx.signal);
    if (applied) return;
    notifyNoModel(currentProfile, ctx, "error");
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (event) => {
    const addendum = buildProfileSystemPromptAddendum(currentProfile, config);
    return addendum ? { systemPrompt: event.systemPrompt + addendum } : undefined;
  });

  // ── manual selection tracking ───────────────────────────────────────

  pi.on("model_select", async (event) => {
    if (!isManualSelect(event.source, switching)) return;
    manual = true;
    tuiHandle?.requestRender();
  });

  // ── 429 detection + fallback ────────────────────────────────────────

  async function fallbackAfterRateLimit(
    rateLimitedModelKey: string,
    cooldownMs: number,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    recordCooldown(cooldowns, rateLimitedModelKey, cooldownMs, Date.now());

    const switchedTo = await applyTierModel(currentProfile, ctx, ctx.signal, false);
    if (!switchedTo) {
      if (ctx.hasUI)
        ctx.ui.notify(`rate limited on ${rateLimitedModelKey}; no fallback available`, "error");
      return false;
    }
    if (ctx.hasUI)
      ctx.ui.notify(`rate limited on ${rateLimitedModelKey}; switched to ${switchedTo}`, "warning");
    return true;
  }

  function makeRetryableRateLimitMessage(message: Message): Message {
    const errorMessage = message.errorMessage ?? "provider request failed";
    return { ...message, errorMessage: `429 fallback available: ${errorMessage}` };
  }

  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status !== 429 || !ctx.model) return;

    const rateLimitedModelKey = modelKey(ctx.model);
    const cooldownMs = parseRetryAfter(event.headers["retry-after"]) ?? DEFAULT_COOLDOWN_MS;
    const fallbackSucceeded = await fallbackAfterRateLimit(rateLimitedModelKey, cooldownMs, ctx);
    httpRateLimitAwaitingMessage = { modelKey: rateLimitedModelKey, fallbackSucceeded };
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;

    const rateLimitedModelKey = modelKey({ provider: message.provider, id: message.model });
    if (httpRateLimitAwaitingMessage?.modelKey === rateLimitedModelKey) {
      const { fallbackSucceeded } = httpRateLimitAwaitingMessage;
      httpRateLimitAwaitingMessage = undefined;
      if (!fallbackSucceeded) return;
      return { message: makeRetryableRateLimitMessage(message) };
    }
    if (!isRateLimitedError(message.errorMessage)) return;

    const fallbackSucceeded = await fallbackAfterRateLimit(
      rateLimitedModelKey,
      DEFAULT_COOLDOWN_MS,
      ctx,
    );
    if (fallbackSucceeded) return { message: makeRetryableRateLimitMessage(message) };
  });

  // ── tool gating & profile commands ─────────────────────────────────────

  pi.on("tool_call", async (event) => {
    if (shouldBlockToolCall(currentProfile, event.toolName, config)) {
      return { block: true, reason: `profile ${currentProfile} cannot use ${event.toolName}` };
    }
  });

  for (const profile of Object.keys(config.profiles)) {
    pi.registerCommand(`profile:${profile}`, {
      description: `Switch the session profile to ${profile}.`,
      handler: async (args, ctx) => {
        currentProfile = profile;
        manual = false;
        applyProfileTools(ctx, currentProfile);
        tuiHandle?.requestRender();
        const applied = await applyTierModel(currentProfile, ctx);
        if (!applied) notifyNoModel(currentProfile, ctx, "warning");
        const followUpMessage = args.trim();
        if (followUpMessage) pi.sendUserMessage(followUpMessage);
      },
    });
  }
}
