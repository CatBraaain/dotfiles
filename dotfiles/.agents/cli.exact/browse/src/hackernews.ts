// Hacker News-only parsing and fetching: item URL detection, Algolia API
// retrieval (item + comment tree) and Markdown shaping.
import { PARSE_TIMEOUT_MS } from "./config";
import { htmlFragmentToMarkdown, unescapeEntities } from "./html";

export interface HackerNewsItemUrl {
  itemId: string;
  permalink: string;
}

export function parseHackerNewsUrl(rawUrl: string): HackerNewsItemUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "news.ycombinator.com" && hostname !== "www.news.ycombinator.com") {
    return undefined;
  }
  if (url.pathname !== "/item") return undefined;
  const itemId = url.searchParams.get("id") ?? undefined;
  if (!itemId || !/^\d+$/.test(itemId)) return undefined;
  return { itemId, permalink: `https://news.ycombinator.com/item?id=${itemId}` };
}

interface HnItem {
  id?: number;
  title?: string;
  author?: string;
  points?: number;
  url?: string;
  text?: string;
  children?: HnItem[];
}

function countComments(items: readonly HnItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.text) count += 1;
    count += countComments(item.children ?? []);
  }
  return count;
}

function renderCommentTree(
  items: readonly HnItem[],
  numbering: { next: number },
  depth: number,
  lines: string[],
): void {
  for (const item of items) {
    if (!item.text) {
      renderCommentTree(item.children ?? [], numbering, depth, lines);
      continue;
    }
    lines.push(
      `### ${numbering.next++}. ${item.author ?? "unknown"}`,
      "",
      indentQuote(htmlFragmentToMarkdown(unescapeEntities(item.text)), depth),
      "",
    );
    renderCommentTree(item.children ?? [], numbering, depth + 1, lines);
  }
}

function indentQuote(markdown: string, depth: number): string {
  if (depth <= 0) return markdown;
  const prefix = "> ".repeat(depth);
  return markdown
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

// Spec: Algolia API でタイトル・ポイント・コメントツリーを markdown で出力する。
export function renderHackerNewsMarkdown(item: HnItem, permalink: string): string {
  const lines = [`# ${item.title || `Hacker News item ${item.id ?? ""}`.trim()}`, ""];
  if (item.author) lines.push(`- Author: ${item.author}`);
  lines.push(`- URL: ${permalink}`);
  if (item.url) lines.push(`- Link: ${item.url}`);
  if (typeof item.points === "number") lines.push(`- Points: ${item.points}`);
  const commentCount = countComments(item.children ?? []);
  lines.push(`- Comments: ${commentCount}`);
  if (item.text) {
    lines.push("", "## Post", "", htmlFragmentToMarkdown(unescapeEntities(item.text)));
  }
  if (commentCount > 0) {
    lines.push("", `## Comments (${commentCount} retrieved)`, "");
    renderCommentTree(item.children ?? [], { next: 1 }, 0, lines);
  }
  return lines.join("\n").trim();
}

export async function fetchHackerNewsMarkdown(rawUrl: string): Promise<string> {
  const target = parseHackerNewsUrl(rawUrl);
  if (!target) throw new Error(`Not a supported Hacker News item URL: ${rawUrl}`);
  const response = await fetch(`https://hn.algolia.com/api/v1/items/${target.itemId}`, {
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HN Algolia API ${response.status} ${response.statusText}`);
  }
  const item = (await response.json()) as HnItem;
  return renderHackerNewsMarkdown(item, target.permalink);
}
