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
import { parse as parseYaml } from "yaml";
import {
  bashExecFrom,
  DEFAULT_COOLDOWN_MS,
  evalWhen,
  isManualSelect,
  lastUserText,
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

export type Role = string;

export interface RoleDefinition {
  tier: string;
  tools: readonly string[];
  subagents: readonly Role[];
  systemPrompt: readonly string[];
}

export interface RoleConfig {
  default: Role;
  tiers: Record<string, readonly ModelCandidate[]>;
  roles: Record<Role, RoleDefinition>;
}

export interface ConfigLoadResult {
  config?: RoleConfig;
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

export function parseRoleConfig(source: string): ConfigLoadResult {
  try {
    const document = parseYaml(source) as unknown;
    if (!isRecord(document) || !isNonEmptyString(document.default) || !isRecord(document.roles)) {
      return { error: "default and roles are required" };
    }
    if (!isRecord(document.tiers)) return { error: "tiers are required" };

    const tiers: Record<string, readonly ModelCandidate[]> = {};
    for (const [tierName, rawCandidates] of Object.entries(document.tiers)) {
      const candidates = parseCandidates(rawCandidates, tierName);
      if (typeof candidates === "string") return { error: candidates };
      tiers[tierName] = candidates;
    }

    const roles: Record<Role, RoleDefinition> = {};
    for (const [name, rawDefinition] of Object.entries(document.roles)) {
      if (!isRecord(rawDefinition)) return { error: `role ${name} must be an object` };
      const { tier, tools, subagents, systemPrompt } = rawDefinition;
      if (!isNonEmptyString(tier)) return { error: `role ${name} has an invalid tier` };
      if (!(tier in tiers)) return { error: `role ${name} references undefined tier ${tier}` };
      if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
        return { error: `role ${name} has invalid tools` };
      }
      if (!Array.isArray(subagents) || !subagents.every((role) => typeof role === "string")) {
        return { error: `role ${name} has invalid subagents` };
      }
      if (
        !Array.isArray(systemPrompt) ||
        !systemPrompt.every((prompt) => typeof prompt === "string")
      ) {
        return { error: `role ${name} has an invalid systemPrompt` };
      }
      roles[name] = { tier, tools, subagents, systemPrompt };
    }

    if (!roles[document.default])
      return { error: `default role ${document.default} is not defined` };
    for (const [name, definition] of Object.entries(roles)) {
      const unknownSubagent = definition.subagents.find((role) => !roles[role]);
      if (unknownSubagent)
        return { error: `role ${name} delegates to undefined role ${unknownSubagent}` };
    }

    return { config: { default: document.default, tiers, roles } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function loadRoleConfig(
  configPath = join(getAgentDir(), "extensions", "role", "config.yaml"),
): ConfigLoadResult {
  if (!existsSync(configPath)) return { error: `config file not found: ${configPath}` };
  try {
    return parseRoleConfig(readFileSync(configPath, "utf8"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function initialRole(config: RoleConfig, requestedRole?: Role): Role {
  return requestedRole && config.roles[requestedRole] ? requestedRole : config.default;
}

export function isToolAllowed(role: Role, toolName: string, config: RoleConfig): boolean {
  if (toolName === "subagent") return true;
  const tools = config.roles[role]?.tools ?? [];
  return tools.includes("*") || tools.includes(toolName);
}

export function shouldBlockToolCall(role: Role, toolName: string, config: RoleConfig): boolean {
  return !isToolAllowed(role, toolName, config);
}

export function buildRoleSystemPromptAddendum(role: Role, config: RoleConfig): string {
  const prompts = (config.roles[role]?.systemPrompt ?? []).filter(Boolean);
  return prompts.length > 0 ? `\n\n${prompts.join("\n\n")}` : "";
}

export function canDelegate(fromRole: Role, toRole: Role, config: RoleConfig): boolean {
  return config.roles[fromRole]?.subagents.includes(toRole) ?? false;
}

export function childRole(fromRole: Role, toRole: Role, config: RoleConfig): Role | undefined {
  return canDelegate(fromRole, toRole, config) ? toRole : undefined;
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
  role: Role;
  manual: boolean;
  lastResent: string;
  cooldowns: Map<string, number>;
}

const ROUTING_STATE_KEY = "__piRoleRoutingState";

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

const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const SPINNER_INTERVAL_MS = 100;
const EXIT_STDIO_GRACE_MS = 100;

export function spinnerFrame(nowMs: number): string {
  const index = Math.floor(nowMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index < 0 ? index + SPINNER_FRAMES.length : index];
}

let tuiHandle: { requestRender: () => void } | undefined;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let pendingChildren = 0;

function startSpinnerTimer(): void {
  if (spinnerTimer !== undefined) return;
  spinnerTimer = setInterval(() => tuiHandle?.requestRender(), SPINNER_INTERVAL_MS);
}

function stopSpinnerTimerIfIdle(): void {
  if (pendingChildren <= 0 && spinnerTimer !== undefined) {
    clearInterval(spinnerTimer);
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
  role: Role;
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

interface RoleToolDetails {
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

type OnUpdateCallback = (partialResult: AgentToolResult<RoleToolDetails>) => void;

async function runChild(
  defaultCwd: string,
  task: string,
  role: Role,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<ChildRun> {
  // モデルは渡さない。子セッションが自分の role の tier から解決する。
  const args = ["--mode", "json", "-p", "--no-session", "--role", role, `Task: ${task}`];
  const childResult: ChildRun = {
    role,
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
    processHandle.on("error", () => {
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

function registerRoleWidget(
  ctx: ExtensionContext,
  currentRole: () => Role,
  isManual: () => boolean,
): void {
  ctx.ui.setWidget(
    "role",
    (ui, theme) => {
      tuiHandle = ui;
      return {
        render: () => {
          const suffix = isManual() ? " (manual)" : "";
          return [theme.fg("dim", `🤖 role: ${currentRole()}${suffix}`)];
        },
        invalidate: () => {},
      };
    },
    { placement: "aboveEditor" },
  );
}

export default function roleExtension(
  pi: ExtensionAPI,
  injectedConfig: ConfigLoadResult = loadRoleConfig(),
): void {
  const loadedConfig = injectedConfig;
  const config = loadedConfig.config;
  let currentRole = config?.default ?? "invalid";

  pi.registerFlag("role", { type: "string", description: "Role for a child session." });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn an isolated child pi process using a configured role.",
    parameters: Type.Object({
      task: Type.String({ description: "Task to delegate to the child process" }),
      role: Type.String({ description: "Configured child role name" }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory; defaults to the parent cwd" }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!config)
        return {
          content: [textPart(`Role configuration error: ${loadedConfig.error}`)],
          details: { results: [] },
          isError: true,
        };
      if (!params.task)
        return {
          content: [textPart("Invalid parameters. Provide a task.")],
          details: { results: [] },
        };
      if (!config.roles[params.role]) {
        return {
          content: [textPart(`Cannot delegate: role ${params.role} is not defined.`)],
          details: { results: [] },
          isError: true,
        };
      }
      if (!canDelegate(currentRole, params.role, config)) {
        return {
          content: [
            textPart(`Permission denied: role ${currentRole} cannot delegate to ${params.role}.`),
          ],
          details: { results: [] },
          isError: true,
        };
      }

      pendingChildren++;
      startSpinnerTimer();
      let result: ChildRun;
      try {
        result = await runChild(ctx.cwd, params.task, params.role, params.cwd, signal, onUpdate);
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
      return new Text(theme.fg("toolTitle", theme.bold(`subagent ${args.role ?? "..."}`)), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as RoleToolDetails | undefined;
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
      if (finalOutput) {
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
      }
      if (childResult.pending) {
        const waitingLine = `${spinnerFrame(Date.now())} ${childResult.role}`;
        container.addChild(new Text(theme.fg("muted", waitingLine), 0, 0));
      }
      return container;
    },
  });

  if (!config) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(`role configuration error: ${loadedConfig.error}`, "error");
    });
    return;
  }

  // ── model routing state ─────────────────────────────────────────────
  let manual = false; // user picked a model manually -> suspend auto-routing
  let switching = false; // our own setModel is in flight (NOT "manual")
  let lastResent = ""; // dedupe back-to-back resends of the same prompt
  let cooldowns = new Map<string, number>(); // modelKey -> expiry epoch ms

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
  // notifySwitch を false にすると切替時の `role model →` 通知を省く（429 フォールバックは
  // 「レート制限時のフォールバック」節の通知が専らを定めるため）。
  async function applyTierModel(
    role: Role,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    notifySwitch = true,
  ): Promise<string | null> {
    const tierName = config.roles[role]?.tier;
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
          ctx.ui.notify(`role model → ${model.provider}/${model.id}`, "info");
        return modelKey(model);
      }
      const failed = model;
      candidates = candidates.filter(
        (candidate) => !(candidate.provider === failed.provider && candidate.model === failed.id),
      );
    }
  }

  function notifyNoModel(role: Role, ctx: ExtensionContext, level: "warning" | "error"): void {
    const message = `no available model for role ${role}: tier ${config.roles[role].tier}`;
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

  function applyRoleTools(ctx: ExtensionContext, role: Role): void {
    const roleDefinition = config.roles[role];
    const activeTools = roleDefinition.tools.includes("*")
      ? pi.getAllTools().map((tool) => tool.name)
      : [...new Set([...roleDefinition.tools, "subagent"])];
    pi.setActiveTools(activeTools);
    registerRoleWidget(
      ctx,
      () => currentRole,
      () => manual,
    );
  }

  // ── session lifecycle ───────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload") {
      // 設定を読み込み直す。手動選択状態と cooldown は維持し、モデルは変更しない。
      const saved = takeSavedRoutingState();
      if (saved) {
        currentRole = config.roles[saved.role]
          ? saved.role
          : initialRole(config, pi.getFlag("role") as string | undefined);
        manual = saved.manual;
        lastResent = saved.lastResent;
        cooldowns = saved.cooldowns;
      }
      applyRoleTools(ctx, currentRole);
      return;
    }

    manual = false;
    lastResent = "";
    // /new は cooldown をすべて破棄する。セッション切替・分岐（resume/fork）は維持する。
    cooldowns =
      event.reason === "startup" || event.reason === "new"
        ? new Map()
        : (takeSavedRoutingState()?.cooldowns ?? new Map());
    currentRole = initialRole(config, pi.getFlag("role") as string | undefined);
    applyRoleTools(ctx, currentRole);
    const applied = await applyTierModel(currentRole, ctx);
    if (!applied) notifyNoModel(currentRole, ctx, "warning");
  });

  pi.on("session_shutdown", async () => {
    saveRoutingState({ role: currentRole, manual, lastResent, cooldowns });
  });

  // ── pre-prompt re-evaluation ────────────────────────────────────────

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || manual) return;
    const applied = await applyTierModel(currentRole, ctx, ctx.signal);
    if (applied) return;
    notifyNoModel(currentRole, ctx, "error");
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (event) => {
    const addendum = buildRoleSystemPromptAddendum(currentRole, config);
    return addendum ? { systemPrompt: event.systemPrompt + addendum } : undefined;
  });

  // ── manual selection tracking ───────────────────────────────────────

  pi.on("model_select", async (event) => {
    if (!isManualSelect(event.source, switching)) return;
    manual = true;
    tuiHandle?.requestRender();
  });

  // ── 429 detection + fallback ────────────────────────────────────────

  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status !== 429) return;
    const current = ctx.model;
    if (!current) return;

    const key = modelKey(current);
    const waitMs = parseRetryAfter(event.headers["retry-after"]) ?? DEFAULT_COOLDOWN_MS;
    recordCooldown(cooldowns, key, waitMs, Date.now());

    const switchedTo = await applyTierModel(currentRole, ctx, ctx.signal, false);
    if (!switchedTo) {
      if (ctx.hasUI) ctx.ui.notify(`rate limited on ${key}; no fallback available`, "error");
      return;
    }
    if (ctx.hasUI) ctx.ui.notify(`rate limited on ${key}; switched to ${switchedTo}`, "warning");
    const text = lastUserText(ctx.sessionManager.getBranch());
    if (text && text !== lastResent) {
      lastResent = text;
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  });

  // ── tool gating & role commands ─────────────────────────────────────

  pi.on("tool_call", async (event) => {
    if (shouldBlockToolCall(currentRole, event.toolName, config)) {
      return { block: true, reason: `role ${currentRole} cannot use ${event.toolName}` };
    }
  });

  for (const role of Object.keys(config.roles)) {
    pi.registerCommand(`role:${role}`, {
      description: `Switch the session role to ${role}.`,
      handler: async (args, ctx) => {
        currentRole = role;
        manual = false;
        applyRoleTools(ctx, currentRole);
        tuiHandle?.requestRender();
        const applied = await applyTierModel(currentRole, ctx);
        if (!applied) notifyNoModel(currentRole, ctx, "warning");
        const followUpMessage = args.trim();
        if (followUpMessage) pi.sendUserMessage(followUpMessage);
      },
    });
  }
}
