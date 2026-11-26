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
  contextUsage: ContextUsage | undefined;
  sessionCostUsd: number;
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

export function sumSessionCostUsd(entries: readonly SessionEntry[]): number {
  let costUsd = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      const { message } = entry;
      if (message.role === "assistant" || message.role === "toolResult") {
        costUsd += message.usage?.cost.total ?? 0;
      }
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      costUsd += entry.usage?.cost.total ?? 0;
    }
  }
  return costUsd;
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
): string {
  const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const percent = contextUsage?.percent ?? null;
  const contextPercent = percent === null ? "?" : `${percent.toFixed(1)}%`;
  return `Context ${contextPercent} / ${formatTokens(contextWindow)}`;
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

function buildModelLine(width: number, data: FooterRenderData, theme: FooterTheme): string {
  const context = contextDisplay(data.contextUsage, data.model);
  const contextAndCost = `${context} · Session $${data.sessionCostUsd.toFixed(3)}`;
  const left = theme.fg("dim", visibleWidth(contextAndCost) <= width ? contextAndCost : context);
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
  const lines = buildSessionLines(width, data, theme);
  lines.push(buildModelLine(width, data, theme));
  const statuses = [...data.extensionStatuses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeStatusText(text))
    .join(" ");
  if (data.extensionStatuses.size > 0) {
    lines.push(theme.fg("dim", truncateToWidth(statuses, width, "...")));
  }
  return lines;
}

function buildSessionLines(width: number, data: FooterRenderData, theme: FooterTheme): string[] {
  const cwd = formatCwdForFooter(data.cwd, data.home);
  const branch = data.branch ? ` (${data.branch})` : "";
  const fields = formatAssignmentFields(data.assignments);
  if (data.sessionName) fields.push(`title: ${data.sessionName}`);

  const lines: string[] = [];
  const fieldGap = " ".repeat(MIN_LINE_PADDING);
  let line = cwd + branch;
  for (const field of fields) {
    const combined = line + fieldGap + field;
    if (visibleWidth(combined) <= width) {
      line = combined;
    } else {
      lines.push(line);
      line = field;
    }
  }

  const session = `session: ${data.sessionId}`;
  const sessionFits = visibleWidth(line) + MIN_LINE_PADDING + visibleWidth(session) <= width;
  if (!sessionFits) lines.push(line);

  const ellipsis = theme.fg("dim", "...");
  const renderedLines = lines.map((line) =>
    truncateToWidth(theme.fg("dim", line), width, ellipsis),
  );
  const lastLine = sessionFits ? rightAlignedLine(line, session, width) : session;
  const fittedLastLine = truncateToWidth(theme.fg("dim", lastLine), width, ellipsis);
  const padding = " ".repeat(width - visibleWidth(fittedLastLine));
  renderedLines.push(padding + fittedLastLine);
  return renderedLines;
}

function escapeAssignmentText(text: string): string {
  return text.replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function formatAssignmentFields(assignments: Assignments | undefined): string[] {
  if (!assignments) return [];

  const { worktrees, ticket } = assignments;
  const groups: string[] = [];
  if (worktrees.length > 0) {
    const names = worktrees.map((path) => escapeAssignmentText(basename(path) || path));
    groups.push(`worktree: ${names.join(", ")}`);
  }
  if (ticket) groups.push(`ticket: ${escapeAssignmentText(`${ticket.project}/${ticket.id}`)}`);
  return groups;
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

function getSessionEntryCount(
  sessionManager: ExtensionContext["sessionManager"],
): number | undefined {
  if (!("getEntryCount" in sessionManager) || typeof sessionManager.getEntryCount !== "function")
    return undefined;
  const count: unknown = sessionManager.getEntryCount();
  return typeof count === "number" ? count : undefined;
}

function getFooterRenderData(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  sessionCostUsd: number,
): FooterRenderData {
  const model = ctx.model;
  return {
    cwd: ctx.sessionManager.getCwd(),
    home: process.env.HOME || process.env.USERPROFILE,
    branch: footerData.getGitBranch(),
    sessionName: ctx.sessionManager.getSessionName(),
    sessionId: ctx.sessionManager.getSessionId(),
    contextUsage: ctx.getContextUsage(),
    sessionCostUsd,
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
    let cachedCost: { sessionId: string; entryCount: number | undefined; usd: number } | undefined;
    requestRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange(requestRender);
    return {
      dispose() {
        stop();
        unsubscribe();
      },
      invalidate() {},
      render(width) {
        const { sessionManager } = ctx;
        const currentSessionId = sessionManager.getSessionId();
        const entryCount = getSessionEntryCount(sessionManager);
        if (
          entryCount === undefined ||
          cachedCost?.sessionId !== currentSessionId ||
          cachedCost.entryCount !== entryCount
        ) {
          cachedCost = {
            sessionId: currentSessionId,
            entryCount,
            usd: sumSessionCostUsd(sessionManager.getEntries()),
          };
        }
        const footer = getFooterRenderData(ctx, footerData, cachedCost.usd);
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
      const previousFields = formatAssignmentFields(assignments).join("\n");
      assignments = next;
      if (formatAssignmentFields(next).join("\n") !== previousFields) requestRender?.();
    } finally {
      queryInFlight = false;
    }
  }
}
