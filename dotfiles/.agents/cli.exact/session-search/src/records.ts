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
  const page = new ReadingPageSelection(options);
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let nextRecordIndex = 1;
  try {
    for await (const line of lines) {
      lineNumber++;
      const entry = parseEntryLine(line);
      if (entry === null) continue;
      for (const record of iterateEntryRecords(entry, lineNumber, nextRecordIndex)) {
        page.add(record);
        nextRecordIndex++;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return page.finish(sessionId);
}

export function entryRecords(entry: SessionEntry, line: number, firstIndex = 1): ReadingRecord[] {
  return [...iterateEntryRecords(entry, line, firstIndex)];
}

function* iterateEntryRecords(
  entry: SessionEntry,
  line: number,
  firstIndex: number,
): Generator<ReadingRecord> {
  const parent = parentRecord(entry, line, firstIndex);
  if (parent !== null) {
    yield parent;
    return;
  }
  if (entry.type !== "custom" || entry.customType !== SUBAGENT_LOG_TYPE) return;

  const log = asSubagentLog(entry.data);
  let index = firstIndex;
  for (const [eventOffset, event] of (log.events ?? []).entries()) {
    const body = eventBody(event);
    if (body === null) continue;
    yield {
      ...body,
      index: index++,
      line,
      source: "subagent",
      agent: log.agent ?? null,
      invocationId: log.invocationId ?? null,
      eventIndex: eventOffset + 1,
    };
  }
}

export function selectReadingPage(
  sessionId: string,
  records: ReadingRecord[],
  options: PageOptions = {},
): ReadingPage {
  const page = new ReadingPageSelection(options);
  for (const record of records) page.add(record);
  return page.finish(sessionId);
}

class ReadingPageSelection {
  private readonly records: ReadingRecord[] = [];
  private readonly pendingBeforeHit: ReadingRecord[] = [];
  private readonly offset: number;
  private readonly limit: number;
  private remainingAfterHit = 0;
  private total = 0;

  constructor(private readonly options: PageOptions) {
    this.offset = options.offset ?? 1;
    this.limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  }

  add(record: ReadingRecord): void {
    const { role, query } = this.options;
    if (role !== undefined && record.role !== role) return;
    if (query === undefined) {
      this.select(record);
    } else if (record.text.includes(query)) {
      for (const previous of this.pendingBeforeHit) this.select(previous);
      this.pendingBeforeHit.length = 0;
      this.select(record);
      this.remainingAfterHit = QUERY_CONTEXT_RECORDS;
    } else if (this.remainingAfterHit > 0) {
      this.select(record);
      this.remainingAfterHit--;
    } else {
      if (this.pendingBeforeHit.length === QUERY_CONTEXT_RECORDS) this.pendingBeforeHit.shift();
      this.pendingBeforeHit.push(record);
    }
  }

  finish(sessionId: string): ReadingPage {
    const returned = this.records.length;
    const nextOffset = this.offset + returned;
    return {
      sessionId,
      records: this.records,
      total: this.total,
      offset: this.offset,
      returned,
      nextOffset: nextOffset <= this.total ? nextOffset : null,
    };
  }

  private select(record: ReadingRecord): void {
    this.total++;
    if (this.total >= this.offset && this.records.length < this.limit) this.records.push(record);
  }
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
