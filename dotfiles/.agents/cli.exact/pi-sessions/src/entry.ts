export type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
};

export type Message = {
  role?: string;
  content?: string | ContentBlock[];
  sections?: Record<string, unknown>;
  toolName?: string;
  isError?: boolean;
  durationMs?: number;
};

export type SubagentEvent = {
  type: string;
  timestamp?: string;
  data?: {
    content?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    success?: boolean;
    durationMs?: number;
  };
};

export type SubagentLog = {
  agent?: string;
  agentId?: string;
  invocationId?: string;
  task?: string;
  events?: SubagentEvent[];
};

export type SessionEntry = {
  type: string;
  timestamp?: string;
  customType?: string;
  message?: Message;
  data?: unknown;
};

export const SUBAGENT_LOG_TYPE = "agents.subagent-log";

export function parseEntryLine(line: string): SessionEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const entry = parsed as SessionEntry;
  return typeof entry.type === "string" ? entry : null;
}

export function entryTypeLabel(entry: SessionEntry): string {
  if (entry.type === "custom" && typeof entry.customType === "string") {
    return `custom:${entry.customType}`;
  }
  return entry.type;
}

export function messageText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function messageThinking(content: Message["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? "")
    .join("\n");
}

export function extractEntryText(entry: SessionEntry): string {
  if (entry.type === "message") return extractMessageText(entry.message);
  if (entry.type === "custom") return extractCustomText(entry);
  return "";
}

function extractMessageText(message: Message | undefined): string {
  if (message === undefined) return "";
  if (message.role === "assistant") {
    const text = messageText(message.content);
    if (text !== "") return text;
    const thinking = messageThinking(message.content);
    if (thinking !== "") return thinking;
  }
  return textWithSectionsFallback(message);
}

function textWithSectionsFallback(message: Message): string {
  const text = messageText(message.content);
  if (text !== "") return text;
  const sectionValues = Object.values(message.sections ?? {});
  return sectionValues.filter((value): value is string => typeof value === "string").join("\n");
}

function extractCustomText(entry: SessionEntry): string {
  if (entry.customType === SUBAGENT_LOG_TYPE) {
    const log = asSubagentLog(entry.data);
    return `subagent ${log.agent ?? "unknown"}: ${log.task ?? ""}`;
  }
  const label = entry.customType ?? "custom";
  const dataJson = stringifyData(entry.data);
  return dataJson === "" ? label : `${label} ${dataJson}`;
}

function stringifyData(data: unknown): string {
  if (data === undefined) return "";
  return JSON.stringify(data) ?? "";
}

export function asSubagentLog(data: unknown): SubagentLog {
  if (typeof data !== "object" || data === null) return {};
  return data as SubagentLog;
}
