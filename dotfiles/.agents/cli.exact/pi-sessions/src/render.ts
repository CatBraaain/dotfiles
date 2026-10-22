import type { ReadingPage, ReadingRecord } from "./records";
import type { SearchHit } from "./search";
import type { SessionStat } from "./sessions";

const SEARCH_EXCERPT_MAX_CHARS = 200;
const LIST_TITLE_MAX_CHARS = 80;

export function toSingleLine(text: string): string {
  return text.replaceAll("\r", " ").replaceAll("\n", " ").trim();
}

export function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function excerpt(text: string, maxChars: number): string {
  return truncateText(toSingleLine(text), maxChars);
}

export function formatTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace("T", " ").slice(0, 19);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

export function formatSearchHit(hit: SearchHit): string {
  const time = hit.timestamp === "" ? "" : ` ${formatTimestamp(hit.timestamp)}`;
  const header = `${hit.sessionId.slice(0, 8)} ${hit.project} ${hit.entryType}${time} line ${hit.line}`;
  return `${header}\n  ${excerpt(hit.text, SEARCH_EXCERPT_MAX_CHARS)}`;
}

export function formatReadingRecord(record: ReadingRecord): string {
  const source =
    record.source === "parent"
      ? "parent"
      : `subagent ${record.agent ?? "null"} invocationId=${record.invocationId ?? "null"} eventIndex=${record.eventIndex}`;
  return `[${record.index}] ${record.role} ${source} line ${record.line}\n${record.text}`;
}

export function formatReadingPage(page: ReadingPage, query?: string): string {
  const rendered = page.records.map(formatReadingRecord);
  if (page.records.length === 0) {
    rendered.push(
      query !== undefined && page.total === 0 ? "no matches" : "no records at this offset",
    );
  }
  rendered.push(
    `total: ${page.total} offset: ${page.offset} returned: ${page.returned} nextOffset: ${page.nextOffset}`,
  );
  return rendered.join("\n\n");
}

export function formatListRow(stat: SessionStat, title: string): string {
  const id = stat.sessionId.slice(0, 8);
  const updated = formatTimestamp(stat.updatedAt.toISOString());
  return `${id} ${stat.project} ${updated} ${formatBytes(stat.sizeBytes)} ${excerpt(title, LIST_TITLE_MAX_CHARS)}`;
}
