import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

export const DEFAULT_SESSION_LIST_LIMIT = 20;
export const DEFAULT_MESSAGE_LIMIT = 50;
export const SEARCH_CONTEXT_RADIUS = 2;

export type SessionListInput = Static<typeof sessionListParameters>;
export type SessionGetInput = Static<typeof sessionGetParameters>;
export type SessionMessage = {
  readonly role: string;
  readonly text: string;
};

export type SessionSource = {
  readonly listAll: () => Promise<SessionInfo[]>;
  readonly open: (path: string) => SessionReader;
};

export type SessionReader = {
  readonly getEntries: () => SessionEntry[];
};

const defaultSessionSource: SessionSource = {
  listAll: () => SessionManager.listAll(),
  open: (path) => SessionManager.open(path),
};

const sessionListParameters = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Keyword to search across session metadata and messages" }),
  ),
  cwd: Type.Optional(Type.String({ description: "Partial project path filter" })),
  since: Type.Optional(
    Type.String({ description: "Include sessions created on or after this ISO date" }),
  ),
  until: Type.Optional(
    Type.String({ description: "Include sessions created on or before this ISO date" }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Maximum number of sessions to return (default: 20)" }),
  ),
});

const sessionGetParameters = Type.Object({
  id: Type.String({ description: "Session id returned by session_list" }),
  query: Type.Optional(Type.String({ description: "Search within this session's messages" })),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based message offset" })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Maximum messages to return (default: 50)" }),
  ),
  role: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("assistant")], {
      description: "Restrict messages before applying offset and limit",
    }),
  ),
});

function normalizeForSearch(text: string): string {
  return Array.from(text.toLocaleLowerCase())
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 0x30a1 && codePoint <= 0x30f6
        ? String.fromCodePoint(codePoint - 0x60)
        : character;
    })
    .join("");
}

function includesKeyword(text: string, query: string): boolean {
  return normalizeForSearch(text).includes(normalizeForSearch(query));
}

function isSubsequence(query: string, text: string): boolean {
  const normalizedQuery = normalizeForSearch(query);
  const normalizedText = normalizeForSearch(text);
  let queryIndex = 0;
  for (const character of normalizedText) {
    if (character === normalizedQuery[queryIndex]) queryIndex++;
    if (queryIndex === normalizedQuery.length) return true;
  }
  return normalizedQuery.length === 0;
}

function matchesQuery(session: SessionInfo, query: string): boolean {
  const searchableText = [
    session.cwd,
    session.name ?? "",
    session.firstMessage,
    session.allMessagesText,
  ].join("\n");
  return includesKeyword(searchableText, query);
}

function matchesFuzzyQuery(session: SessionInfo, query: string): boolean {
  const searchableText = [
    session.cwd,
    session.name ?? "",
    session.firstMessage,
    session.allMessagesText,
  ].join("\n");
  return isSubsequence(query, searchableText);
}

function searchSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
  const exactMatches = sessions.filter((session) => matchesQuery(session, query));
  return exactMatches.length > 0
    ? exactMatches
    : sessions.filter((session) => matchesFuzzyQuery(session, query));
}

function parseDateBoundary(value: string | undefined, endOfDay: boolean): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid ISO date: ${value}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return parsed;
  return Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
}

function sortNewestFirst(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((left, right) => right.created.getTime() - left.created.getTime());
}

function sessionMatchesFilters(session: SessionInfo, input: SessionListInput): boolean {
  const since = parseDateBoundary(input.since, false);
  const until = parseDateBoundary(input.until, true);
  const createdAt = session.created.getTime();
  if (input.cwd && !session.cwd.includes(input.cwd)) return false;
  if (since !== undefined && createdAt < since) return false;
  if (until !== undefined && createdAt > until) return false;
  return true;
}

export function filterSessions(sessions: SessionInfo[], input: SessionListInput): SessionInfo[] {
  const filteredByMetadata = sessions.filter((session) => sessionMatchesFilters(session, input));
  const matchingSessions = input.query
    ? searchSessions(filteredByMetadata, input.query)
    : filteredByMetadata;
  return sortNewestFirst(matchingSessions).slice(0, input.limit ?? DEFAULT_SESSION_LIST_LIMIT);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.thinking === "string") return record.thinking;
      if (record.type === "toolCall") {
        const name = typeof record.name === "string" ? record.name : "toolCall";
        return `${name} ${JSON.stringify(record.arguments ?? {})}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageToText(message: Record<string, unknown>): string {
  if (message.role === "bashExecution") {
    return [message.command, message.output]
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }
  return contentToText(message.content);
}

export function extractMessages(entries: SessionEntry[]): SessionMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = entry.message as unknown as Record<string, unknown>;
    return [{ role: String(message.role), text: messageToText(message) }];
  });
}

function formatSession(session: SessionInfo): string {
  const name = session.name ? ` — "${session.name}"` : "";
  return [
    `## ${session.created.toISOString().slice(0, 10)}${name}`,
    `id: ${session.id}`,
    `cwd: ${session.cwd}`,
    `firstMessage: ${session.firstMessage}`,
    `messages: ${session.messageCount}`,
  ].join("\n");
}

export async function listSessions(
  input: SessionListInput,
  source: SessionSource = defaultSessionSource,
): Promise<SessionInfo[]> {
  const sessions = await source.listAll();
  const filteredSessions = filterSessions(sessions, input);
  return filteredSessions;
}

function searchMessageIndexes(messages: SessionMessage[], query: string): number[] {
  const exactMatches = messages.flatMap((message, index) =>
    includesKeyword(message.text, query) ? [index] : [],
  );
  if (exactMatches.length > 0) return exactMatches;
  return messages.flatMap((message, index) => (isSubsequence(query, message.text) ? [index] : []));
}

function selectMessages(
  messages: SessionMessage[],
  input: SessionGetInput,
): { selected: SessionMessage[]; total: number; offset: number } {
  const roleFilteredMessages = input.role
    ? messages.filter((message) => message.role === input.role)
    : messages;

  if (input.query) {
    const hitIndexes = searchMessageIndexes(roleFilteredMessages, input.query);
    const selectedIndexes = new Set<number>();
    for (const hitIndex of hitIndexes) {
      const firstContextIndex = Math.max(0, hitIndex - SEARCH_CONTEXT_RADIUS);
      const lastContextIndex = Math.min(
        roleFilteredMessages.length - 1,
        hitIndex + SEARCH_CONTEXT_RADIUS,
      );
      for (let index = firstContextIndex; index <= lastContextIndex; index++)
        selectedIndexes.add(index);
    }
    const matchingMessages = [...selectedIndexes]
      .sort((left, right) => left - right)
      .map((index) => roleFilteredMessages[index]!);
    return {
      selected: matchingMessages.slice(0, DEFAULT_MESSAGE_LIMIT),
      total: matchingMessages.length,
      offset: 1,
    };
  }

  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_MESSAGE_LIMIT;
  const startIndex = offset - 1;
  return {
    selected: roleFilteredMessages.slice(startIndex, startIndex + limit),
    total: roleFilteredMessages.length,
    offset,
  };
}

function formatMessages(messages: SessionMessage[]): string {
  return messages.map((message) => `[${message.role}] ${message.text}`).join("\n");
}

export async function getSession(
  input: SessionGetInput,
  source: SessionSource = defaultSessionSource,
): Promise<{
  session: SessionInfo;
  messages: SessionMessage[];
  total: number;
  offset: number;
  isQuery: boolean;
}> {
  const sessions = await source.listAll();
  const session = sessions.find((candidate) => candidate.id === input.id);
  if (!session) throw new Error(`Session not found: ${input.id}`);
  const allMessages = extractMessages(source.open(session.path).getEntries());
  const selection = selectMessages(allMessages, input);
  return {
    session,
    messages: selection.selected,
    total: selection.total,
    offset: selection.offset,
    isQuery: Boolean(input.query),
  };
}

function formatGetResult(
  result: Awaited<ReturnType<typeof getSession>>,
  input: SessionGetInput,
): string {
  if (input.query && result.messages.length === 0) return `ヒットなし: "${input.query}"`;
  const header = `## ${result.session.created.toISOString().slice(0, 10)} ${result.session.cwd} — ${result.session.id}`;
  const hasMore = result.offset - 1 + result.messages.length < result.total;
  const pagination = hasMore
    ? `\n全${result.total}件中 ${result.offset}〜${result.offset + result.messages.length - 1}件を表示。続きは offset=${result.offset + result.messages.length}`
    : "";
  return `${header}\n${formatMessages(result.messages)}${pagination}`;
}

function renderInput(
  toolName: string,
  input: Record<string, unknown>,
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
): Text {
  const visibleArguments = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return new Text(
    theme.fg(
      "toolTitle",
      theme.bold(`${toolName}${visibleArguments ? ` ${visibleArguments}` : ""}`),
    ),
    0,
    0,
  );
}

function renderToolResult(
  result: { content: Array<{ type: string; text?: string }> },
  collapsedText: string,
  expanded: boolean,
  isError: boolean,
  theme: { fg: (color: string, text: string) => string },
 ): Text {
  const output = result.content.find((item) => item.type === "text")?.text ?? "";
  if (!expanded) {
    const status = isError ? "error" : collapsedText;
    const color = isError ? "error" : "muted";
    return new Text(theme.fg(color, status), 0, 0);
  }
  return new Text(theme.fg(isError ? "error" : "toolOutput", output), 0, 0);
}

export default function sessionSearchExtension(
  pi: ExtensionAPI,
  source: SessionSource = defaultSessionSource,
): void {
  pi.registerTool({
    name: "session_list",
    label: "Session List",
    description: "Find past pi sessions by keyword and optional project or date filters.",
    parameters: sessionListParameters,
    async execute(_toolCallId, params) {
      const sessions = await listSessions(params, source);
      return {
        content: [{ type: "text" as const, text: sessions.map(formatSession).join("\n\n") }],
        details: { count: sessions.length },
      };
    },
    renderCall(args, theme) {
      return renderInput("session_list", args, theme);
    },
    renderResult(result, { expanded }, theme, context) {
      const count = (result.details as { count?: number } | undefined)?.count ?? 0;
      return renderToolResult(result, `${count} sessions`, expanded, context.isError, theme);
    },
  });

  pi.registerTool({
    name: "session_get",
    label: "Session Get",
    description: "Open matching messages from one past pi session by id.",
    parameters: sessionGetParameters,
    async execute(_toolCallId, params) {
      const result = await getSession(params, source);
      return {
        content: [{ type: "text" as const, text: formatGetResult(result, params) }],
        details: { id: params.id, total: result.total },
      };
    },
    renderCall(args, theme) {
      return renderInput("session_get", args, theme);
    },
    renderResult(result, { expanded }, theme, context) {
      const total = (result.details as { total?: number } | undefined)?.total ?? 0;
      return renderToolResult(result, `${total} messages`, expanded, context.isError, theme);
    },
  });
}
