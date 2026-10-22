import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  asSubagentLog,
  messageText,
  parseEntryLine,
  SUBAGENT_LOG_TYPE,
  type Message,
  type SessionEntry,
  type SubagentEvent,
} from "./entry";

export type RoleFilter = "user" | "assistant";
export type ReadingRecord = {
  index: number;
  line: number;
  role: RoleFilter | "toolResult";
  text: string;
  source: "parent" | "subagent";
  agent: string | null;
  invocationId: string | null;
  eventIndex: number | null;
};

export type PageOptions = {
  role?: RoleFilter;
  query?: string;
  offset?: number;
  limit?: number;
};

export type ReadingPage = {
  sessionId: string;
  records: ReadingRecord[];
  total: number;
  offset: number;
  returned: number;
  nextOffset: number | null;
};

const DEFAULT_PAGE_LIMIT = 50;
const QUERY_CONTEXT_RECORDS = 2;

export async function loadReadingPage(
  path: string,
  sessionId: string,
  options: PageOptions = {},
): Promise<ReadingPage> {
  const records: ReadingRecord[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      const entry = parseEntryLine(line);
      if (entry === null) continue;
      const additions = entryRecords(entry, lineNumber, records.length + 1);
      for (const record of additions) records.push(record);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return selectReadingPage(sessionId, records, options);
}

export function entryRecords(entry: SessionEntry, line: number, firstIndex = 1): ReadingRecord[] {
  const parent = parentRecord(entry, line, firstIndex);
  if (parent !== null) return [parent];
  if (entry.type !== "custom" || entry.customType !== SUBAGENT_LOG_TYPE) return [];

  const log = asSubagentLog(entry.data);
  const records: ReadingRecord[] = [];
  for (const [eventOffset, event] of (log.events ?? []).entries()) {
    const body = eventBody(event);
    if (body === null) continue;
    records.push({
      ...body,
      index: firstIndex + records.length,
      line,
      source: "subagent",
      agent: log.agent ?? null,
      invocationId: log.invocationId ?? null,
      eventIndex: eventOffset + 1,
    });
  }
  return records;
}

export function selectReadingPage(
  sessionId: string,
  records: ReadingRecord[],
  options: PageOptions = {},
): ReadingPage {
  const roleRecords = records.filter(
    (record) => options.role === undefined || record.role === options.role,
  );
  const selected =
    options.query === undefined ? roleRecords : queryContext(roleRecords, options.query);
  const offset = options.offset ?? 1;
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const pageRecords = selected.slice(offset - 1, offset - 1 + limit);
  const nextOffset = offset + pageRecords.length;
  return {
    sessionId,
    records: pageRecords,
    total: selected.length,
    offset,
    returned: pageRecords.length,
    nextOffset: nextOffset <= selected.length ? nextOffset : null,
  };
}

function queryContext(records: ReadingRecord[], query: string): ReadingRecord[] {
  const selected = new Set<number>();
  records.forEach((record, position) => {
    if (!record.text.includes(query)) return;
    const first = Math.max(0, position - QUERY_CONTEXT_RECORDS);
    const last = Math.min(records.length - 1, position + QUERY_CONTEXT_RECORDS);
    for (let neighbor = first; neighbor <= last; neighbor++) selected.add(neighbor);
  });
  return records.filter((_, position) => selected.has(position));
}

function parentRecord(entry: SessionEntry, line: number, index: number): ReadingRecord | null {
  if (entry.type !== "message" || entry.message === undefined) return null;
  const message = entry.message;
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  const text =
    role === "assistant"
      ? assistantText(message.content)
      : role === "toolResult"
        ? toolResultText(message)
        : messageText(message.content);
  return {
    index,
    line,
    role,
    text,
    source: "parent",
    agent: null,
    invocationId: null,
    eventIndex: null,
  };
}

function assistantText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return block.thinking ?? "";
      if (block.type === "toolCall")
        return [block.name, fullText(block.arguments)].filter(Boolean).join(" ");
      return "";
    })
    .join("\n");
}

function toolResultText(message: Message): string {
  const status = message.isError === undefined ? "" : message.isError ? "error" : "ok";
  const duration = message.durationMs === undefined ? "" : `${message.durationMs}ms`;
  const header = [message.toolName, status, duration].filter(Boolean).join(" ");
  return [header, messageText(message.content)].filter((text) => text !== "").join("\n");
}

function eventBody(event: SubagentEvent): Pick<ReadingRecord, "role" | "text"> | null {
  const body = event.data;
  if (event.type === "user.message") return { role: "user", text: body?.content ?? "" };
  if (event.type === "assistant.message" || event.type === "assistant.reasoning") {
    return { role: "assistant", text: body?.content ?? "" };
  }
  if (event.type === "tool.execution_start") {
    return {
      role: "assistant",
      text: [body?.toolName, fullText(body?.input)].filter(Boolean).join("\n"),
    };
  }
  if (event.type === "tool.execution_complete") {
    const status = body?.success === undefined ? "" : body.success ? "ok" : "error";
    const duration = body?.durationMs === undefined ? "" : `${body.durationMs}ms`;
    const header = [body?.toolName, status, duration].filter(Boolean).join(" ");
    return {
      role: "toolResult",
      text: [header, fullText(body?.output)].filter(Boolean).join("\n"),
    };
  }
  return null;
}

function fullText(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}
