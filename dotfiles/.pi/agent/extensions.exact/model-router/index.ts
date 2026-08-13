// model-router — dynamic model routing with cooldown-aware fallback.
//
// Reads rules from ~/.pi/agent/extensions/model-router/config.yaml:
//   rules:
//     - provider: zai
//       model: glm-5.2
//       when: 'h=$(date -u +%H); [ "$h" -ge 06 ] && [ "$h" -lt 10 ]'
//     - provider: zai
//       model: glm-5.1
//
// A rule is a candidate only when: its `when` bash command exits 0 (or is
// omitted), the model exists in the registry, and it is not in rate-limit
// cooldown. The first matching candidate wins.
//
// Non-429 retries are left to pi's provider retry policy; this extension only
// drives model selection plus 429 cooldown/fallback.
//
// Routing decisions live in dependency-injected pure functions
// (pickCandidate / recordCooldown / isCoolingDown / isManualSelect /
// decideFallback / lastUserText) so the spec is testable without the pi runtime. The pi-bound
// side is a thin glue layer: it wires those functions to real bash exec /
// model registry / UI, and owns the mutable session state.

import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface Rule {
  provider: string;
  model: string;
  when?: string;
}

interface Config {
  rules: Rule[];
}

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const WHEN_TIMEOUT_MS = 5_000;

export function modelKey(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

export function isValidRule(r: unknown): r is Rule {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.provider === "string" &&
    typeof o.model === "string" &&
    (o.when === undefined || typeof o.when === "string")
  );
}

// Parse Retry-After: integer seconds ("120") or HTTP-date. Returns ms duration or null.
export function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const s = value.trim();
  if (/^\d+$/.test(s)) {
    const sec = parseInt(s, 10);
    return Number.isFinite(sec) ? Math.max(0, sec * 1000) : null;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : Math.max(0, ms - Date.now());
}

export function extractUserText(entry: SessionMessageEntry): string | null {
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(
    (p): p is TextContent =>
      typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
  );
  const joined = texts.map((p) => p.text).join("\n");
  return joined || null;
}

export interface LoadResult {
  rules: Rule[]; // [] disables routing (missing/broken/invalid config)
  invalid: unknown[]; // raw entries rejected by isValidRule, surfaced to the user
}

// Load + validate rules from a YAML file. Any invalid rule halts routing
// (rules: [] = disabled) rather than silently applying a partial chain; the
// bad entries are collected so the caller can surface them. Missing/empty/
// broken file -> empty result.
export function loadConfigFromPath(path: string): LoadResult {
  if (!existsSync(path)) return { rules: [], invalid: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const cfg = parseYaml(raw) as Partial<Config> | null;
    if (!cfg || !Array.isArray(cfg.rules)) return { rules: [], invalid: [] };
    const rules: Rule[] = [];
    const invalid: unknown[] = [];
    for (const r of cfg.rules) {
      if (isValidRule(r)) rules.push(r);
      else invalid.push(r);
    }
    // 不正ルールがあれば部分適用せず停止（rules: [] = ルーティング無効化）。
    return { rules: invalid.length > 0 ? [] : rules, invalid };
  } catch (err) {
    console.warn("[model-router] failed to load config:", err);
    return { rules: [], invalid: [] };
  }
}

// ── routing core (pure, dependency-injected) ─────────────────────────
//
// These functions carry every routing decision. `now` is passed in (not read
// from Date.now()) so cooldown math is deterministic in tests.

// True if `key` is still cooling down at `now`. Lazily evicts expired entries
// so a stale cooldown never silently blocks a model forever.
export function isCoolingDown(key: string, cooldowns: Map<string, number>, now: number): boolean {
  const exp = cooldowns.get(key);
  if (!exp) return false;
  if (now >= exp) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

// Put `key` in the rate-limit doghouse until now + ms.
export function recordCooldown(
  cooldowns: Map<string, number>,
  key: string,
  ms: number,
  now: number,
): void {
  cooldowns.set(key, now + ms);
}

// The first rule (top-to-bottom) whose model exists in the registry, is not
// cooling down, and whose `when` passes. find + evalWhen + now are injected so
// this needs neither pi nor bash to test.
export async function pickCandidate<M extends { provider: string; id: string }>(
  rules: Rule[],
  cooldowns: Map<string, number>,
  find: (provider: string, id: string) => M | undefined,
  evalWhen: (when: string | undefined) => Promise<boolean>,
  now: number,
): Promise<M | null> {
  for (const rule of rules) {
    const model = find(rule.provider, rule.model);
    if (!model) continue;
    if (isCoolingDown(modelKey(model), cooldowns, now)) continue;
    if (!(await evalWhen(rule.when))) continue;
    return model;
  }
  return null;
}

// `when` コマンドの実行器。bashExecFrom(createLocalBashOperations()) が pi の
// local shell backend（pi.exec の実体）に繋いだ本物の実装で、factory もテストも
// 同じ道を通る。
export interface WhenExec {
  (
    command: string,
    opts: { timeout?: number; signal?: AbortSignal },
  ): Promise<{
    exitCode: number | null;
  }>;
}

// pi の BashOperations を WhenExec に適合させる。onData は破棄、cwd は固定
// （when コマンドは cwd 非依存のものだけ使う前提）。
export function bashExecFrom(ops: BashOperations, cwd = process.cwd()): WhenExec {
  return (command, opts) =>
    ops.exec(command, cwd, {
      onData: () => {},
      timeout: opts.timeout,
      signal: opts.signal,
    });
}

// `when` runs through pi's local shell. Omitted/blank -> always true;
// exit 0 -> true; any non-zero exit or failure -> false.
export async function evalWhen(
  when: string | undefined,
  exec: WhenExec,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!when || when.trim() === "") return true;
  try {
    const { exitCode } = await exec(when, { timeout: timeoutMs, signal });
    return exitCode === 0;
  } catch {
    return false;
  }
}

// A model_select event suspends auto-routing only when it is a genuine user
// pick — not our own setModel in flight (switching), nor a session restore.
export function isManualSelect(source: string | undefined, switching: boolean): boolean {
  return !switching && (source === "set" || source === "cycle");
}

export function requiresSwitchConfirmation(sessionStartReason: string | undefined): boolean {
  return sessionStartReason !== "startup";
}

// What to do after a 429: `confirm` asks before switching (user is in manual
// mode), `error` means no fallback exists, `switch` is auto mode.
export type FallbackAction<M extends { provider: string; id: string }> =
  | { kind: "error" }
  | { kind: "confirm"; model: M }
  | { kind: "switch"; model: M };

export function decideFallback<M extends { provider: string; id: string }>(
  manual: boolean,
  next: M | null,
): FallbackAction<M> {
  if (!next) return { kind: "error" };
  return manual ? { kind: "confirm", model: next } : { kind: "switch", model: next };
}

// Most recent user message text in a branch, or null if there is none.
// This is what gets resent after a 429 fallback switch.
export function lastUserText(branch: SessionEntry[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message.role === "user") {
      const text = extractUserText(entry as SessionMessageEntry);
      if (text !== null) return text;
    }
  }
  return null;
}

// ── pi extension (thin glue over the pure core) ──────────────────────

export default async function (pi: ExtensionAPI) {
  // Dynamic import keeps `@earendil-works/pi-coding-agent` out of the
  // module-level import graph so unit tests can load this file without the
  // pi package installed. getAgentDir() is resolved once at factory time.
  const { getAgentDir, createLocalBashOperations } =
    await import("@earendil-works/pi-coding-agent");
  const configPath = join(getAgentDir(), "extensions", "model-router", "config.yaml");

  let rules: Rule[] = [];
  let manual = false; // user picked a model manually -> suspend auto-routing
  let switching = false; // our own setModel is in flight (NOT "manual")
  const cooldowns = new Map<string, number>(); // modelKey -> expiry epoch ms
  let lastResent = ""; // dedupe back-to-back resends of the same prompt

  const bashExec = bashExecFrom(createLocalBashOperations());
  const runWhen = (when: string | undefined, signal?: AbortSignal) =>
    evalWhen(when, bashExec, WHEN_TIMEOUT_MS, signal);

  async function pickFor(ctx: ExtensionContext, signal?: AbortSignal): Promise<Model<Api> | null> {
    return pickCandidate(
      rules,
      cooldowns,
      (p, i) => ctx.modelRegistry.find(p, i),
      (w) => runWhen(w, signal),
      Date.now(),
    );
  }

  async function switchTo(model: Model<Api>): Promise<boolean> {
    switching = true;
    try {
      return await pi.setModel(model);
    } finally {
      switching = false;
    }
  }

  async function evaluateAndMaybeSwitch(
    ctx: ExtensionContext,
    signal?: AbortSignal,
    confirmSwitch = true,
  ): Promise<void> {
    if (manual || rules.length === 0) return;
    const candidate = await pickFor(ctx, signal);
    if (!candidate) return;
    const current = ctx.model;
    if (current && modelKey(current) === modelKey(candidate)) return;

    if (confirmSwitch && ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "model-router",
        `Switch ${current ? `${current.provider}/${current.id} \u2192 ` : ""}${candidate.provider}/${candidate.id}?`,
      );
      if (!ok) {
        // Cancel keeps the current model and suspends auto-routing (manual mode).
        manual = true;
        ctx.ui.setStatus("model-router", "manual");
        return;
      }
    }
    const ok = await switchTo(candidate);
    if (ok) {
      if (ctx.hasUI)
        ctx.ui.notify(`model-router \u2192 ${candidate.provider}/${candidate.id}`, "info");
    } else if (ctx.hasUI) {
      ctx.ui.notify(`No API key for ${candidate.provider}/${candidate.id}`, "warning");
    }
  }

  async function resendLastUserMessage(ctx: ExtensionContext): Promise<void> {
    const text = lastUserText(ctx.sessionManager.getBranch());
    if (!text || text === lastResent) return;
    lastResent = text;
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  }

  // ── session lifecycle ──────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    const { rules: loaded, invalid } = loadConfigFromPath(configPath);
    rules = loaded;
    if (invalid.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`[model-router] ${invalid.length} invalid rule(s); routing disabled`, "error");
    }
    manual = false;
    lastResent = "";
    cooldowns.clear();
    if (ctx.hasUI) ctx.ui.setStatus("model-router", undefined);
    await evaluateAndMaybeSwitch(ctx, undefined, requiresSwitchConfirmation(event.reason));
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Re-evaluate just before each prompt (e.g. busytime end).
    // ponytail: `when` runs once per prompt; cache it only if bash cost shows up.
    await evaluateAndMaybeSwitch(ctx, ctx.signal);
  });

  // ── manual selection tracking ──────────────────────────────────────

  pi.on("model_select", async (event, ctx) => {
    if (!isManualSelect(event.source, switching)) return;
    manual = true;
    if (ctx.hasUI) ctx.ui.setStatus("model-router", "manual");
  });

  // ── 429 detection + fallback ───────────────────────────────────────

  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status !== 429) return;
    const current = ctx.model;
    if (!current) return;

    const key = modelKey(current);
    const ra = event.headers["retry-after"];
    const ms = parseRetryAfter(ra) ?? DEFAULT_COOLDOWN_MS;
    recordCooldown(cooldowns, key, ms, Date.now());

    // ponytail: after_provider_response fires before the body stream is
    // consumed, so we cannot parse the body for a retry hint here.
    // Retry-After header only; fall back to DEFAULT_COOLDOWN_MS otherwise.
    // Add body parsing only if a provider embeds the wait solely in the body.

    const action = decideFallback(manual, await pickFor(ctx, ctx.signal));
    switch (action.kind) {
      case "error":
        if (ctx.hasUI) ctx.ui.notify(`Rate limited on ${key}; no fallback available`, "error");
        return;
      case "confirm":
        if (!ctx.hasUI) return;
        if (
          await ctx.ui.confirm(
            "model-router",
            `Rate limited on ${key}. Switch to ${action.model.provider}/${action.model.id} and retry?`,
          )
        ) {
          await switchTo(action.model);
          await resendLastUserMessage(ctx);
        }
        return;
      case "switch":
        await switchTo(action.model);
        await resendLastUserMessage(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Rate limited on ${key}; switched to ${action.model.provider}/${action.model.id}`,
            "warning",
          );
        }
        return;
    }
  });
}
