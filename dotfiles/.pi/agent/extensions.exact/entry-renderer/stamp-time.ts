import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function stampTime(timestamp: number | string | undefined): string {
  if (typeof timestamp !== "number" && typeof timestamp !== "string") return "";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function stampSuffix(line: string, stamp: string, width: number): string {
  if (stamp === "") return truncateToWidth(line, width);
  const stampWidth = visibleWidth(stamp);
  if (width < stampWidth + 2) return truncateToWidth(line, width);
  const contentWidth = Math.max(width - stampWidth - 1, 1);
  const content = truncateToWidth(line, contentWidth);
  const pad = Math.max(width - visibleWidth(content) - stampWidth, 1);
  return `${content}${" ".repeat(pad)}${stamp}`;
}
