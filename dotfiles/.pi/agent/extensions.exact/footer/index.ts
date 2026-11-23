import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { basename, relative, resolve, sep, isAbsolute } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const MIN_LINE_PADDING = 2;
const ASSIGNMENT_POLL_INTERVAL_MS = 5000;
const ASSIGNMENT_QUERY_TIMEOUT_MS = 5000;
const SESSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const AssignmentSchema = Type.Object({
  worktrees: Type.Array(Type.String({ minLength: 1 })),
  ticket: Type.Union([
    Type.Object({ project: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
    Type.Null(),
  ]),
});

type Assignments = Static<typeof AssignmentSchema>;

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  latestCacheHitRate: number | undefined;
}

export interface FooterModel {
  provider: string;
  id: string;
  reasoning: boolean;
  contextWindow: number;
}

export interface FooterRenderData {
  cwd: string;
  home: string | undefined;
  branch: string | null;
  sessionName: string | undefined;
  sessionId: string;
  usage: UsageSummary;
  contextUsage: ContextUsage | undefined;
  model: FooterModel | undefined;
  thinkingLevel: string | undefined;
  availableProviderCount: number;
  extensionStatuses: ReadonlyMap<string, string>;
  assignments?: Assignments;
}

export type FooterTheme = Pick<Theme, "fg">;

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

export function collectUsageSummary(entries: readonly SessionEntry[]): UsageSummary {
  const totals = emptyUsageTotals();
  let latestCacheHitRate: number | undefined;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      addUsage(totals, entry.message.usage);
      const latestPromptTokens =
        entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
      latestCacheHitRate =
        latestPromptTokens > 0
          ? (entry.message.usage.cacheRead / latestPromptTokens) * 100
          : undefined;
      continue;
    }

    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      addUsage(totals, entry.message.usage);
      continue;
    }

    if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsage(totals, entry.usage);
    }
  }

  return { totals, latestCacheHitRate };
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function rightAlignedLine(left: string, right: string, width: number): string {
  let availableLeft = left;
  if (visibleWidth(availableLeft) > width) {
    availableLeft = truncateToWidth(availableLeft, width, "...");
  }

  const leftWidth = visibleWidth(availableLeft);
  const availableForRight = width - leftWidth - MIN_LINE_PADDING;
  if (availableForRight <= 0) return availableLeft;

  const availableRight = truncateToWidth(right, availableForRight, "");
  const padding = " ".repeat(
    Math.max(MIN_LINE_PADDING, width - leftWidth - visibleWidth(availableRight)),
  );
  return availableLeft + padding + availableRight;
}

function contextDisplay(
  contextUsage: FooterRenderData["contextUsage"],
  model: FooterModel | undefined,
  theme: FooterTheme,
): string {
  const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const percent = contextUsage?.percent ?? null;
  const contextPercent = percent === null ? "?" : percent.toFixed(1);
  const display =
    contextPercent === "?"
      ? `?/${formatTokens(contextWindow)}`
      : `${contextPercent}%/${formatTokens(contextWindow)}`;
  return theme.fg("dim", display);
}

function modelDisplay(
  model: FooterModel | undefined,
  thinkingLevel: string | undefined,
  availableProviderCount: number,
  leftWidth: number,
  width: number,
): string {
  if (!model) return "no-model";

  const level = thinkingLevel || "off";
  const modelName = model.reasoning
    ? `${model.id} • ${level === "off" ? "thinking off" : level}`
    : model.id;
  const providerName = `(${model.provider}) ${modelName}`;
  const providerFits = leftWidth + MIN_LINE_PADDING + visibleWidth(providerName) <= width;
  return availableProviderCount > 1 && providerFits ? providerName : modelName;
}

function buildStatsLine(width: number, data: FooterRenderData, theme: FooterTheme): string {
  const { totals, latestCacheHitRate } = data.usage;
  const dimParts: string[] = [
    `↑${formatTokens(totals.input)}`,
    `↓${formatTokens(totals.output)}`,
    `R${formatTokens(totals.cacheRead)}`,
    `W${formatTokens(totals.cacheWrite)}`,
    `CH${(latestCacheHitRate ?? 0).toFixed(1)}%`,
    `$${totals.cost.toFixed(3)}`,
  ];

  const leftParts = dimParts.map((part) => theme.fg("dim", part));
  leftParts.push(contextDisplay(data.contextUsage, data.model, theme));
  const left = leftParts.join(" ");
  const right = theme.fg(
    "dim",
    modelDisplay(
      data.model,
      data.thinkingLevel,
      data.availableProviderCount,
      visibleWidth(left),
      width,
    ),
  );
  return rightAlignedLine(left, right, width);
}

export function buildFooterLines(
  width: number,
  data: FooterRenderData,
  theme: FooterTheme,
): string[] {
  const cwd = formatCwdForFooter(data.cwd, data.home);
  const branch = data.branch ? ` (${data.branch})` : "";
  const sessionName = data.sessionName ? ` • ${data.sessionName}` : "";
  const location = theme.fg("dim", `${cwd}${branch}${sessionName}`);
  const session = theme.fg("dim", `session: ${data.sessionId}`);

  const lines = [rightAlignedLine(location, session, width), buildStatsLine(width, data, theme)];
  const statuses = [...data.extensionStatuses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeStatusText(text))
    .join(" ");
  if (data.extensionStatuses.size > 0) {
    lines.push(theme.fg("dim", truncateToWidth(statuses, width, "...")));
  }
  if (data.assignments) {
    const assignments = formatAssignments(data.assignments);
    if (assignments) lines.push(theme.fg("dim", truncateToWidth(assignments, width, "...")));
  }
  return lines;
}

function escapeAssignmentText(text: string): string {
  return text.replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function formatAssignments({ worktrees, ticket }: Assignments): string {
  const groups: string[] = [];
  if (worktrees.length > 0) {
    const names = worktrees.map((path) => escapeAssignmentText(basename(path) || path));
    groups.push(`worktree: ${names.join(", ")}`);
  }
  if (ticket) groups.push(`ticket: ${escapeAssignmentText(`${ticket.project}/${ticket.id}`)}`);
  return groups.join("  ");
}

async function loadAssignments(
  pi: ExtensionAPI,
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
): Promise<Assignments | undefined> {
  try {
    const result = await pi.exec("pi-mux", ["metadata", sessionId], {
      cwd,
      signal,
      timeout: ASSIGNMENT_QUERY_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.killed || ("truncated" in result && result.truncated === true))
      return undefined;

    const response: unknown = JSON.parse(result.stdout);
    if (!Value.Check(AssignmentSchema, response)) return undefined;
    if (!response.worktrees.every((path) => isAbsolute(path) && !path.includes("\0")))
      return undefined;
    return response;
  } catch {
    return undefined;
  }
}

function getFooterRenderData(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
): FooterRenderData {
  const model = ctx.model;
  return {
    cwd: ctx.sessionManager.getCwd(),
    home: process.env.HOME || process.env.USERPROFILE,
    branch: footerData.getGitBranch(),
    sessionName: ctx.sessionManager.getSessionName(),
    sessionId: ctx.sessionManager.getSessionId(),
    usage: collectUsageSummary(ctx.sessionManager.getEntries()),
    contextUsage: ctx.getContextUsage(),
    model: model
      ? {
          provider: model.provider,
          id: model.id,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
        }
      : undefined,
    thinkingLevel: ctx.thinkingLevel,
    availableProviderCount: footerData.getAvailableProviderCount(),
    extensionStatuses: footerData.getExtensionStatuses(),
  };
}

export default function footerExtension(pi: ExtensionAPI): void {
  let stopPolling: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    stopPolling?.();
    stopPolling = ctx.mode === "tui" ? installFooter(pi, ctx) : undefined;
  });

  pi.on("session_shutdown", () => {
    stopPolling?.();
    stopPolling = undefined;
  });
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext): () => void {
  const sessionId = ctx.sessionManager.getSessionId();
  const controller = new AbortController();
  let assignments: Assignments | undefined;
  let requestRender: (() => void) | undefined;
  let queryInFlight = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  ctx.ui.setFooter((tui, theme, footerData) => {
    requestRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange(requestRender);
    return {
      dispose() {
        stop();
        unsubscribe();
      },
      invalidate() {},
      render(width) {
        const footer = getFooterRenderData(ctx, footerData);
        if (footer.sessionId === sessionId) footer.assignments = assignments;
        return buildFooterLines(width, footer, theme);
      },
    };
  });

  if (ctx.sessionManager.getSessionFile() && SESSION_ID_PATTERN.test(sessionId)) {
    void refresh();
    pollTimer = setInterval(() => void refresh(), ASSIGNMENT_POLL_INTERVAL_MS);
  }
  return stop;

  function stop(): void {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
    controller.abort();
    requestRender = undefined;
  }

  async function refresh(): Promise<void> {
    if (queryInFlight || controller.signal.aborted) return;
    queryInFlight = true;
    try {
      const next = await loadAssignments(pi, sessionId, ctx.cwd, controller.signal);
      if (!next || controller.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId)
        return;
      const previousLine = assignments ? formatAssignments(assignments) : "";
      assignments = next;
      if (formatAssignments(next) !== previousLine) requestRender?.();
    } finally {
      queryInFlight = false;
    }
  }
}
