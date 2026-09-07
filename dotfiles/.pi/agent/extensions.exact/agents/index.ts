import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model } from "@earendil-works/pi-ai";
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
  modelSupportsImages,
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

export type Agent = string;

export interface AgentDefinition {
  tier: string;
  tools: readonly string[];
  subagents: readonly Agent[];
  systemPrompt: readonly string[];
}

export interface AgentConfig {
  default: Agent;
  tiers: Record<string, readonly ModelCandidate[]>;
  agents: Record<Agent, AgentDefinition>;
}

export interface ConfigLoadResult {
  config?: AgentConfig;
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

export function parseAgentConfig(source: string): ConfigLoadResult {
  try {
    const document = parseYaml(source) as unknown;
    if (!isRecord(document) || !isNonEmptyString(document.default) || !isRecord(document.agents)) {
      return { error: "default and agents are required" };
    }
    if (!isRecord(document.tiers)) return { error: "tiers are required" };

    const tiers: Record<string, readonly ModelCandidate[]> = {};
    for (const [tierName, rawCandidates] of Object.entries(document.tiers)) {
      const candidates = parseCandidates(rawCandidates, tierName);
      if (typeof candidates === "string") return { error: candidates };
      tiers[tierName] = candidates;
    }

    const agents: Record<Agent, AgentDefinition> = {};
    for (const [name, rawDefinition] of Object.entries(document.agents)) {
      if (!isRecord(rawDefinition)) return { error: `agent ${name} must be an object` };
      const { tier, tools, subagents, systemPrompt } = rawDefinition;
      if (!isNonEmptyString(tier)) return { error: `agent ${name} has an invalid tier` };
      if (!(tier in tiers)) return { error: `agent ${name} references undefined tier ${tier}` };
      if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
        return { error: `agent ${name} has invalid tools` };
      }
      if (!Array.isArray(subagents) || !subagents.every((agent) => typeof agent === "string")) {
        return { error: `agent ${name} has invalid subagents` };
      }
      if (
        !Array.isArray(systemPrompt) ||
        !systemPrompt.every((prompt) => typeof prompt === "string")
      ) {
        return { error: `agent ${name} has an invalid systemPrompt` };
      }
      agents[name] = { tier, tools, subagents, systemPrompt };
    }

    if (!agents[document.default])
      return { error: `default agent ${document.default} is not defined` };
    for (const [name, definition] of Object.entries(agents)) {
      const unknownSubagent = definition.subagents.find((agent) => !agents[agent]);
      if (unknownSubagent)
        return { error: `agent ${name} delegates to undefined agent ${unknownSubagent}` };
    }

    const visualAgent = agents.visual_agent;
    if (!visualAgent) return { error: "visual_agent agent is required" };
    if (visualAgent.tier !== "vision") {
      return { error: "agent visual_agent must use the vision tier" };
    }
    const allowsReadImage = (tools: readonly string[]): boolean =>
      tools.includes("*") || tools.includes("read_image");
    for (const [name, definition] of Object.entries(agents)) {
      for (const entry of definition.tools) {
        if (!entry.startsWith("!")) continue;
        const negatedTool = entry.slice(1);
        if (negatedTool === "") {
          return { error: `agent ${name} has a bare "!" negation` };
        }
        if (negatedTool !== "*" && definition.tools.includes(negatedTool)) {
          return { error: `agent ${name} both allows and negates tool ${negatedTool}` };
        }
      }
      if (name === "visual_agent") {
        if (!allowsReadImage(definition.tools)) {
          return { error: "agent visual_agent must allow read_image" };
        }
      } else if (allowsReadImage(definition.tools) && !definition.tools.includes("!read_image")) {
        return { error: `agent ${name} must exclude read_image via "!read_image"` };
      }
      if (name === "main" || name === "senior") {
        if (!definition.subagents.includes("visual_agent")) {
          return { error: `agent ${name} must delegate to visual_agent` };
        }
      }
      if (name === "junior" && definition.subagents.includes("visual_agent")) {
        return { error: "agent junior must not delegate to visual_agent" };
      }
    }

    return { config: { default: document.default, tiers, agents } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function loadAgentConfig(
  configPath = join(getAgentDir(), "extensions", "agents", "config.yaml"),
): ConfigLoadResult {
  if (!existsSync(configPath)) return { error: `config file not found: ${configPath}` };
  try {
    return parseAgentConfig(readFileSync(configPath, "utf8"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function initialAgent(config: AgentConfig, requestedAgent?: Agent): Agent {
  return requestedAgent && config.agents[requestedAgent] ? requestedAgent : config.default;
}

export function isToolAllowed(agent: Agent, toolName: string, config: AgentConfig): boolean {
  if (toolName === "subagent") return true;
  const tools = config.agents[agent]?.tools ?? [];
  if (tools.includes(`!${toolName}`)) return false;
  return tools.includes("*") || tools.includes(toolName);
}

export function shouldBlockToolCall(agent: Agent, toolName: string, config: AgentConfig): boolean {
  return !isToolAllowed(agent, toolName, config);
}

export function buildAgentSystemPromptAddendum(agent: Agent, config: AgentConfig): string {
  const prompts = (config.agents[agent]?.systemPrompt ?? []).filter(Boolean);
  return prompts.length > 0 ? `\n\n${prompts.join("\n\n")}` : "";
}

export function canDelegate(fromAgent: Agent, toAgent: Agent, config: AgentConfig): boolean {
  return config.agents[fromAgent]?.subagents.includes(toAgent) ?? false;
}

export function childAgent(
  fromAgent: Agent,
  toAgent: Agent,
  config: AgentConfig,
): Agent | undefined {
  return canDelegate(fromAgent, toAgent, config) ? toAgent : undefined;
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
  agent: Agent;
  manual: boolean;
  cooldowns: Map<string, number>;
}

const ROUTING_STATE_KEY = "__piAgentRoutingState";

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
const UPDATE_THROTTLE_MS = 150;

// 添付画像を visual_agent 子セッションへ渡すための一時ファイル。親セッションのモデルへ
// 画像を送らず、子が read_image で読める形にする。子の起動が終わったら削除する。
function saveAttachedImages(
  images: ImageContent[],
): Array<{ path: string; cleanup: () => void }> {
  const saved: Array<{ path: string; cleanup: () => void }> = [];
  try {
    const directory = mkdtempSync(join(tmpdir(), "pi-attached-images-"));
    images.forEach((image, index) => {
      const extension = image.mimeType.startsWith("image/")
        ? `.${image.mimeType.slice("image/".length).split(";")[0] || "png"}`
        : ".png";
      const imagePath = join(directory, `image-${index + 1}${extension}`);
      writeFileSync(imagePath, Buffer.from(image.data, "base64"), { mode: 0o600 });
      saved.push({
        path: imagePath,
        cleanup: () => {
          try {
            unlinkSync(imagePath);
          } catch {
            // 削除できないファイルは放置する
          }
        },
      });
    });
  } catch {
    // 一時ディレクトリを作れない場合は空を返し、子セッションを起動しない
  }
  return saved;
}

// SPEC「レート制限（429）時のフォールバック」: フォールバック済みであることを示す置換文言。
// 元のエラー文言は含めない。quota・課金系の文言（insufficient_quota 等）が残ったまま
// 再試行されると、pi 本体（pi-ai の isRetryableAssistantError）がそのメッセージを再試行
// 不可と判定してターンがエラー終了するためである。文言は pi-ai の RETRYABLE パターン
// （"429"、"rate limit"）に一致し、NON_RETRYABLE パターンには一致しない。
const RATE_LIMIT_FALLBACK_APPLIED_MESSAGE =
  "429 rate limit error; already switched to a fallback model";

export const __spinnerTimers: {
  set: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clear: (timer: ReturnType<typeof setInterval>) => void;
  now: () => number;
} = {
  set: (callback, intervalMs) => setInterval(callback, intervalMs),
  clear: (timer) => clearInterval(timer),
  now: () => Date.now(),
};

// テストが onUpdate のスロットリング用タイマーを差し替える出口。本番は標準の
// setTimeout / Date.now を使う。
export const __updateTimers: {
  set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
  now: () => number;
} = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timer) => clearTimeout(timer),
  now: () => Date.now(),
};

// onUpdate はレンダリングを同期実行する重処理になり得る。stdout の data ハンドラから
// 直接呼ぶと、子が bash 等で大量の tool_execution_update を流したときに親のイベント
// ループがレンダリングで占有され、stdout の読み取りが止まる。子 pi（--mode json）は
// stdout のバックプレッシャーで agent loop を止めるため、親が読み続けることが子の
// 進行条件になる。そこで表示更新を UPDATE_THROTTLE_MS に1回までに間引き、data
// ハンドラの処理（イベントの受領・記録）だけを軽量に保つ。窓内の連続したイベントは
// 最新状態に併合され、flush で即座に送出する。
export function createThrottledEmitter(emit: () => void): {
  call: () => void;
  flush: () => void;
} {
  let lastSentAt = -Infinity;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = (): void => {
    if (!pending) return;
    pending = false;
    if (timer !== undefined) {
      __updateTimers.clear(timer);
      timer = undefined;
    }
    lastSentAt = __updateTimers.now();
    emit();
  };

  return {
    call(): void {
      if (pending) return;
      const delay = UPDATE_THROTTLE_MS - (__updateTimers.now() - lastSentAt);
      pending = true;
      if (delay <= 0) {
        send();
        return;
      }
      timer = __updateTimers.set(() => {
        timer = undefined;
        send();
      }, delay);
    },
    flush(): void {
      send();
    },
  };
}

let tuiHandle: { requestRender: () => void } | undefined;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let pendingChildren = 0;

const MAX_CONCURRENT_CHILDREN = 2;
let runningChildren = 0;
const childWaiters: Array<() => void> = [];

// 同時実行数の上限（SPEC.md「同時実行数の制限」）。tryAcquireChildSlot は同期で取得を
// 試み、上限に達している場合は waitChildSlot で空きが出るまで待機する。待機中に
// abort されたら false を返す。即時取得を await なしで済ませるのは、execute の呼び出し
// 直後に子プロセスが起動する同期性を既存の振る舞いとして維持するためである。
function tryAcquireChildSlot(): boolean {
  if (runningChildren < MAX_CONCURRENT_CHILDREN) {
    runningChildren++;
    return true;
  }
  return false;
}

function waitChildSlot(signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const wake = () => {
      signal?.removeEventListener("abort", onAbort);
      runningChildren++;
      resolve(true);
    };
    const onAbort = () => {
      const index = childWaiters.indexOf(wake);
      if (index !== -1) childWaiters.splice(index, 1);
      resolve(false);
    };
    childWaiters.push(wake);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseChildSlot(): void {
  runningChildren--;
  childWaiters.shift()?.();
}

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
  agent: Agent;
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

interface AgentToolDetails {
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

type OnUpdateCallback = (partialResult: AgentToolResult<AgentToolDetails>) => void;

const SUBAGENT_SESSION_DIR_NAME = "subagent-sessions";
const SUBAGENT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SUBAGENT_SESSION_NAME_MAX_CHARS = 30;

// 子セッションは ~/.pi/agent/subagent-sessions へ隔離保存する。main の sessions/ を汚染
// せず、`pi --session-dir <dir> -r` で事後調査できる。
export function subagentSessionDir(): string {
  return join(getAgentDir(), SUBAGENT_SESSION_DIR_NAME);
}

// セッション一覧での識別用の表示名。agent 名 + task 先頭1行の切り詰め。
export function sessionNameFor(agent: Agent, task: string): string {
  const firstLine = (task.split("\n", 1)[0] ?? "").trim();
  const chars = Array.from(firstLine);
  const summary =
    chars.length > SUBAGENT_SESSION_NAME_MAX_CHARS
      ? `${chars.slice(0, SUBAGENT_SESSION_NAME_MAX_CHARS).join("")}…`
      : chars.join("");
  return summary ? `${agent}: ${summary}` : agent;
}

export function childInvocationArgs(agent: Agent, task: string): string[] {
  return [
    "--mode",
    "json",
    "-p",
    "--agent",
    agent,
    "--session-dir",
    subagentSessionDir(),
    "--name",
    sessionNameFor(agent, task),
    `Task: ${task}`,
  ];
}

// 30日超の古い子セッションを削除する。放置で無限に増えるのを防ぐ。
export function cleanupOldSubagentSessions(dir: string, now = Date.now()): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const filePath = join(dir, entry);
    try {
      const stats = statSync(filePath);
      if (stats.isFile() && now - stats.mtimeMs > SUBAGENT_SESSION_MAX_AGE_MS) {
        unlinkSync(filePath);
        removed++;
      }
    } catch {
      // 読めない・消せないファイルは飛ばす
    }
  }
  return removed;
}

// テストが拡張ロード時の fs 操作を差し替えられる出口。本番は node:fs と本ファイルの
// 実装をそのまま使う。
export const __fs: {
  current: {
    mkdirSync: typeof mkdirSync;
    cleanupOldSubagentSessions: typeof cleanupOldSubagentSessions;
  };
} = {
  current: { mkdirSync, cleanupOldSubagentSessions },
};

async function runChild(
  defaultCwd: string,
  task: string,
  agent: Agent,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<ChildRun> {
  // モデルは渡さない。子セッションが指定された agent の tier から解決する。
  // セッションは --no-session にせず隔離先へ保存し、事後調査できるようにする。
  const args = childInvocationArgs(agent, task);
  const childResult: ChildRun = {
    agent,
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

  const throttledEmit = createThrottledEmitter(emitUpdate);

  emitUpdate();

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const processHandle = __spawn.current(invocation.command, invocation.args, {
      cwd: childResult.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // 子セッションの拡張（sandboxed-tools の read_image など）が active agent を知るため。
      // pi の ExtensionContext に agent フィールドはないため、環境変数で伝える。
      env: { ...process.env, PI_AGENT_NAME: agent },
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
        throttledEmit.call();
      }
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        childResult.actions.push({
          toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          name: event.toolName,
          args: isRecord(event.args) ? event.args : {},
          startedAt: Date.now(),
        });
        throttledEmit.call();
      }
      if (event.type === "tool_execution_update") throttledEmit.call();
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
        throttledEmit.call();
      }
      if (event.type === "tool_result_end" && event.message) {
        childResult.messages.push(event.message as Message);
        throttledEmit.call();
      }
    };

    // A grandchild holding stdout's fd would otherwise prevent close indefinitely.
    // Like pi's waitForChildProcess, settle after stdio is quiet for 0.1 seconds after exit.
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
  throttledEmit.flush();
  return childResult;
}

function registerAgentWidget(
  ctx: ExtensionContext,
  currentAgent: () => Agent,
  isManual: () => boolean,
): void {
  ctx.ui.setWidget(
    "agent",
    (ui, theme) => {
      tuiHandle = ui;
      return {
        render: () => {
          const suffix = isManual() ? " (manual)" : "";
          return [theme.fg("dim", `🤖 agent: ${currentAgent()}${suffix}`)];
        },
        invalidate: () => {},
      };
    },
    { placement: "aboveEditor" },
  );
}

export default function agentsExtension(
  pi: ExtensionAPI,
  injectedConfig: ConfigLoadResult = loadAgentConfig(),
): void {
  // 子セッションの保存先を用意し、古いものを掃除する
  try {
    const sessionDir = subagentSessionDir();
    __fs.current.mkdirSync(sessionDir, { recursive: true });
    __fs.current.cleanupOldSubagentSessions(sessionDir);
  } catch {
    // 保存先が用意できなくても subagent 実行は続ける
  }
  const loadedConfig = injectedConfig;
  const config = loadedConfig.config;
  let currentAgent = config?.default ?? "invalid";

  pi.registerFlag("agent", { type: "string", description: "Agent for a child session." });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn an isolated child pi process using a configured agent.",
    parameters: Type.Object({
      task: Type.String({ description: "Task to delegate to the child process" }),
      agent: Type.String({ description: "Configured child agent name" }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory; defaults to the parent cwd" }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!config)
        return {
          content: [textPart(`Agent configuration error: ${loadedConfig.error}`)],
          details: { results: [] },
          isError: true,
        };
      if (!params.task)
        return {
          content: [textPart("Invalid parameters. Provide a task.")],
          details: { results: [] },
        };
      if (!config.agents[params.agent]) {
        return {
          content: [textPart(`Cannot delegate: agent ${params.agent} is not defined.`)],
          details: { results: [] },
          isError: true,
        };
      }
      if (!canDelegate(currentAgent, params.agent, config)) {
        return {
          content: [
            textPart(
              `Permission denied: agent ${currentAgent} cannot delegate to ${params.agent}.`,
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
        if (!tryAcquireChildSlot()) {
          onUpdate?.({
            content: [textPart("(waiting for a free subagent slot...)")],
            details: { results: [] },
          });
          if (!(await waitChildSlot(signal))) {
            return {
              content: [textPart("Subagent was aborted while waiting for a free slot.")],
              details: { results: [] },
              isError: true,
            };
          }
        }
        try {
          result = await runChild(ctx.cwd, params.task, params.agent, params.cwd, signal, onUpdate);
        } finally {
          releaseChildSlot();
        }
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
      return new Text(theme.fg("toolTitle", theme.bold(`subagent ${args.agent ?? "..."}`)), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as AgentToolDetails | undefined;
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
      container.addChild(new Text(theme.fg("muted", "┌─── Task ──────"), 0, 0));
      container.addChild(new Text(theme.fg("text", childResult.task), 0, 0));
      container.addChild(new Text(theme.fg("muted", "└───────────────"), 0, 0));
      if (actions.length > 0) {
        container.addChild(
          new Text(theme.fg("muted", "┌─── Actions ───"), 0, 0),
        );
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
        container.addChild(new Text(theme.fg("muted", "└───────────────"), 0, 0));
      }
      if (finalOutput && !options.isPartial) {
        container.addChild(
          new Text(theme.fg("muted", "┌─── Output ────"), 0, 0),
        );
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
        container.addChild(new Text(theme.fg("muted", "└───────────────"), 0, 0));
      }
      if (childResult.pending) {
        container.addChild({
          render: () =>
            childResult.pending
              ? [theme.fg("muted", `${spinnerFrame(__spinnerTimers.now())} ${childResult.agent}`)]
              : [],
          invalidate: () => {},
        });
      }
      return container;
    },
  });

  if (!config) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(`agent configuration error: ${loadedConfig.error}`, "error");
    });
    // SPEC「設定の検証」: 設定が無効でも画像添付はモデルへ送らず Vision 入力を作らない
    // エラーを返す。read_image は PI_AGENT_NAME が設定されないため常に拒否される。
    pi.on("input", async (event, ctx) => {
      if (!event.images || event.images.length === 0) return;
      const message =
        "image input is not available: the agent configuration is invalid; use visual_agent";
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else {
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
      return { action: "handled" };
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

  // SPEC「tier によるモデル選択」: main は画像入力非対応モデルだけ、visual_agent は
  // 画像入力対応モデルだけを候補として受け付ける。判定は model.input（pi-ai の Model 型）
  // に基づく。他の agent への制約は spec が定めないため適用しない。
  function imageRequirementFor(agent: Agent): "required" | "forbidden" | undefined {
    if (!config?.agents[agent]) return undefined;
    if (agent === "visual_agent") return "required";
    if (agent === "main") return "forbidden";
    return undefined;
  }

  // tier の候補を先頭から適用する。レジストリ不在・cooldown・when 不成立・画像能力
  // 不適合の候補は pickCandidate が飛ばし、適用に失敗した候補（API キー欠如等）は除外
  // して次候補へ進む。現在のモデルと同じ候補なら切り替えない。全候補不成立なら null。
  // notifySwitch を false にすると切替時の `agent model →` 通知を省く（429 フォールバックは
  // 「レート制限時のフォールバック」節の通知が専らを定めるため）。
  async function applyTierModel(
    agent: Agent,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    notifySwitch = true,
  ): Promise<string | null> {
    const tierName = config?.agents[agent]?.tier;
    if (!tierName) return null;
    const imageRequirement = imageRequirementFor(agent);
    let candidates = config?.tiers[tierName] ?? [];
    for (;;) {
      const model = await pickCandidate(
        candidates,
        cooldowns,
        (provider, id) => ctx.modelRegistry.find(provider, id),
        (when) => runWhen(when, signal),
        Date.now(),
        imageRequirement,
      );
      if (!model) return null;
      if (ctx.model && ctx.model.provider === model.provider && ctx.model.id === model.id) {
        return modelKey(model);
      }
      if (await switchTo(model)) {
        if (notifySwitch && ctx.hasUI)
          ctx.ui.notify(`agent model → ${model.provider}/${model.id}`, "info");
        return modelKey(model);
      }
      const failed = model;
      candidates = candidates.filter(
        (candidate) => !(candidate.provider === failed.provider && candidate.model === failed.id),
      );
    }
  }

  function notifyNoModel(agent: Agent, ctx: ExtensionContext, level: "warning" | "error"): void {
    const tier = config?.agents[agent]?.tier ?? "unknown";
    const message = `no available model for agent ${agent}: tier ${tier}`;
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

  function applyAgentTools(ctx: ExtensionContext, agent: Agent): void {
    const agentDefinition = config?.agents[agent];
    if (!agentDefinition) return;
    // 親セッション自身の active agent も sandboxed-tools の read_image などへ伝える。
    process.env.PI_AGENT_NAME = agent;
    const excluded = new Set(
      agentDefinition.tools.filter((tool) => tool.startsWith("!")).map((tool) => tool.slice(1)),
    );
    const included = agentDefinition.tools.filter(
      (tool) => tool !== "*" && !tool.startsWith("!"),
    );
    const activeTools = agentDefinition.tools.includes("*")
      ? pi.getAllTools().map((tool) => tool.name).filter((tool) => !excluded.has(tool))
      : [...new Set([...included, "subagent"])].filter((tool) => !excluded.has(tool));
    pi.setActiveTools(activeTools);
    registerAgentWidget(
      ctx,
      () => currentAgent,
      () => manual,
    );
  }

  // ── session lifecycle ───────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload") {
      // 設定を読み込み直す。手動選択状態と cooldown は維持し、モデルは変更しない。
      const saved = takeSavedRoutingState();
      if (saved) {
        currentAgent = config.agents[saved.agent]
          ? saved.agent
          : initialAgent(config, pi.getFlag("agent") as string | undefined);
        manual = saved.manual;
        cooldowns = saved.cooldowns;
      }
      applyAgentTools(ctx, currentAgent);
      return;
    }

    manual = false;
    // /new は cooldown をすべて破棄する。セッション切替・分岐（resume/fork）は維持する。
    cooldowns =
      event.reason === "startup" || event.reason === "new"
        ? new Map()
        : (takeSavedRoutingState()?.cooldowns ?? new Map());
    currentAgent = initialAgent(config, pi.getFlag("agent") as string | undefined);
    applyAgentTools(ctx, currentAgent);
    const applied = await applyTierModel(currentAgent, ctx);
    if (!applied) notifyNoModel(currentAgent, ctx, "warning");
  });

  pi.on("session_shutdown", async () => {
    saveRoutingState({ agent: currentAgent, manual, cooldowns });
  });

  // ── pre-prompt re-evaluation ────────────────────────────────────────

  pi.on("input", async (event, ctx) => {
    // 画像添付を親セッションのモデルへ送らない。main / senior は依頼文ごと visual_agent
    // 子セッションへ委譲し、親のターンは handled で止める。報告は通知で返る。
    if (event.images && event.images.length > 0) return routeImageInput(event, ctx);
    if (event.source === "extension" || manual) return;
    const applied = await applyTierModel(currentAgent, ctx, ctx.signal);
    if (applied) return;
    notifyNoModel(currentAgent, ctx, "error");
    return { action: "handled" };
  });

  // SPEC「画像入力を使う agent」: チャット貼り付けと CLI @file の画像の振り分け。
  // visual_agent は画像対応モデルのときだけそのまま送る。main / senior は visual_agent
  // 子セッションへ委譲し、junior は依頼元への報告を促す。その他・設定無効時は画像を送らない。
  function routeImageInput(
    event: { text?: string; images?: ImageContent[]; source?: string },
    ctx: ExtensionContext,
  ): { action: "continue" } | { action: "handled" } {
    if (!config) {
      notifyImageUnavailable(ctx);
      return { action: "handled" };
    }
    if (currentAgent === "visual_agent") {
      if (ctx.model && !modelSupportsImages(ctx.model as { input?: readonly string[] })) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "image input is not available: the current model does not support images",
            "error",
          );
        } else {
          process.stderr.write("image input is not available: model does not support images\n");
        }
        return { action: "handled" };
      }
      return { action: "continue" };
    }
    if (canDelegate(currentAgent, "visual_agent", config)) {
      void delegateImageToVisualAgent(event, ctx).catch(() => {});
      return { action: "handled" };
    }
    notifyImageUnavailable(ctx);
    return { action: "handled" };
  }

  function notifyImageUnavailable(ctx: ExtensionContext): void {
    const juniorGuidance =
      currentAgent === "junior"
        ? " Report to the caller that visual confirmation by visual_agent is needed."
        : " Delegate to visual_agent to handle the image.";
    const message = `image input is not available for agent ${currentAgent}.${juniorGuidance}`;
    if (!ctx.hasUI) {
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }
    ctx.ui.notify(message, "warning");
  }

  async function delegateImageToVisualAgent(
    event: { text?: string; images?: ImageContent[] },
    ctx: ExtensionContext,
  ): Promise<void> {
    const saved = saveAttachedImages(event.images ?? []);
    const paths = saved.map((file) => file.path);
    const request = (event.text ?? "").trim();
    const task =
      `The owner attached ${paths.length} image(s) with the following request. Read each image with read_image and complete it.` +
      `\n\nRequest:\n${request || "(none)"}\n\nImages:\n${paths.join("\n")}`;
    try {
      const child = await runChild(ctx.cwd, task, "visual_agent", undefined, ctx.signal, undefined);
      if (isFailedResult(child)) {
        const reason = getResultOutput(child);
        const message = `visual_agent delegation failed: ${reason}`;
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else process.stderr.write(`${message}\n`);
      } else {
        const report = getFinalOutput(child.messages).trim() || "finished without output.";
        if (ctx.hasUI) ctx.ui.notify(`visual_agent: ${report}`, "info");
        else process.stderr.write(`visual_agent: ${report}\n`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`visual_agent delegation failed: ${reason}`, "error");
      else process.stderr.write(`visual_agent delegation failed: ${reason}\n`);
    } finally {
      for (const file of saved) file.cleanup();
    }
  }

  pi.on("before_agent_start", async (event) => {
    const addendum = buildAgentSystemPromptAddendum(currentAgent, config);
    return addendum ? { systemPrompt: event.systemPrompt + addendum } : undefined;
  });

  // ── manual selection tracking ───────────────────────────────────────

  // SPEC「画像入力を使う agent」: main は画像入力非対応モデルだけ、visual_agent は
  // vision tier の画像対応候補だけを /model で受け付ける。違反はエラー通知して
  // 直前のモデルへ戻し、手動状態にしない。
  pi.on("model_select", async (event, ctx) => {
    if (!isManualSelect(event.source, switching)) return;
    const requirement = event.model ? imageRequirementFor(currentAgent) : undefined;
    if (requirement !== undefined) {
      const supportsImages = modelSupportsImages(event.model as { input?: readonly string[] });
      const disallowed =
        requirement === "forbidden"
          ? supportsImages && currentAgent === "main"
          : !supportsImages || !isVisionTierCandidate(event.model);
      if (disallowed) {
        if (event.previousModel) await switchTo(event.previousModel as Model<Api>);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `model ${event.model.provider}/${event.model.id} is not allowed for agent ${currentAgent}` +
              (requirement === "forbidden"
                ? ": main uses text-only models; image input is handled by visual_agent"
                : ": visual_agent uses image-capable vision tier models"),
            "error",
          );
        }
        return;
      }
    }
    manual = true;
    tuiHandle?.requestRender();
  });

  function isVisionTierCandidate(model: { provider: string; id: string }): boolean {
    const candidates = config?.tiers.vision ?? [];
    return candidates.some(
      (candidate) => candidate.provider === model.provider && candidate.model === model.id,
    );
  }

  // ── 429 detection + fallback ────────────────────────────────────────

  async function fallbackAfterRateLimit(
    rateLimitedModelKey: string,
    cooldownMs: number,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    recordCooldown(cooldowns, rateLimitedModelKey, cooldownMs, Date.now());

    const switchedTo = await applyTierModel(currentAgent, ctx, ctx.signal, false);
    if (switchedTo) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `rate limited on ${rateLimitedModelKey}; switched to ${switchedTo}`,
          "warning",
        );
      return true;
    }
    return false;
  }

  // SPEC「レート制限（429）時のフォールバック」: 次候補がない場合の error 通知。元の
  // エラー文言とユーザーによるメッセージ再送の案内を含める。フォールバックの可否は
  // after_provider_response（HTTP 429）の時点でも決まるが、元のエラー文言は最終
  // assistant メッセージにしか現れないため、通知は message_end で行う。
  function notifyNoFallback(
    rateLimitedModelKey: string,
    errorMessage: string | undefined,
    ctx: ExtensionContext,
  ): void {
    if (!ctx.hasUI) return;
    const originalError = errorMessage ? `\n${errorMessage}` : "";
    ctx.ui.notify(
      `rate limited on ${rateLimitedModelKey}; no fallback available${originalError}\nResend your message to retry.`,
      "error",
    );
  }

  function makeFallbackAppliedMessage(message: AssistantMessage): AssistantMessage {
    return { ...message, errorMessage: RATE_LIMIT_FALLBACK_APPLIED_MESSAGE };
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
      if (!fallbackSucceeded) {
        notifyNoFallback(rateLimitedModelKey, message.errorMessage, ctx);
        return;
      }
      return { message: makeFallbackAppliedMessage(message) };
    }
    if (!isRateLimitedError(message.errorMessage)) return;

    const fallbackSucceeded = await fallbackAfterRateLimit(
      rateLimitedModelKey,
      DEFAULT_COOLDOWN_MS,
      ctx,
    );
    if (fallbackSucceeded) return { message: makeFallbackAppliedMessage(message) };
    notifyNoFallback(rateLimitedModelKey, message.errorMessage, ctx);
  });

  // ── tool gating & agent commands ─────────────────────────────────────

  pi.on("tool_call", async (event) => {
    if (shouldBlockToolCall(currentAgent, event.toolName, config)) {
      return { block: true, reason: `agent ${currentAgent} cannot use ${event.toolName}` };
    }
  });

  for (const agent of Object.keys(config.agents)) {
    pi.registerCommand(`agent:${agent}`, {
      description: `Switch the session agent to ${agent}.`,
      handler: async (args, ctx) => {
        currentAgent = agent;
        manual = false;
        applyAgentTools(ctx, currentAgent);
        tuiHandle?.requestRender();
        const applied = await applyTierModel(currentAgent, ctx);
        if (!applied) notifyNoModel(currentAgent, ctx, "warning");
        const followUpMessage = args.trim();
        if (followUpMessage) pi.sendUserMessage(followUpMessage);
      },
    });
  }
}
