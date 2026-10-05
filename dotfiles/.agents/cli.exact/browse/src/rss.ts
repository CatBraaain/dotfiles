// Generic RSS/Atom/RDF feed support: parse a directly requested feed URL and
// shape entries as Markdown. A non-feed response (typically HTML) fails the
// backend so the pipeline falls through to camoufox.
import { PARSE_TIMEOUT_MS } from "./config";
import { htmlFragmentToMarkdown, unescapeEntities } from "./html";

export const FEED_ENTRY_LIMIT = 20;

export interface FeedEntry {
  title?: string;
  author?: string;
  published?: string;
  link: string;
  bodyMarkdown: string;
}

export interface Feed {
  title?: string;
  entries: FeedEntry[];
}

// A feed response has its root element tag near the top; HTML documents don't.
export function looksLikeFeed(xml: string): boolean {
  const head = xml.slice(0, 2000).toLowerCase();
  return /<rss[\s>]/.test(head) || /<feed[\s>]/.test(head) || /<rdf:rdf[\s>]/.test(head);
}

// Tag text that may be wrapped in CDATA (common in RSS description/title).
function xmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(raw);
  const text = cdata ? cdata[1]! : unescapeEntities(raw);
  return text.trim() || undefined;
}

function entryLink(entryXml: string): string {
  const atomHref =
    /<link\b[^>]*rel="alternate"[^>]*href="([^"]*)"/i.exec(entryXml)?.[1] ??
    /<link\b[^>]*href="([^"]*)"/i.exec(entryXml)?.[1];
  return (atomHref ?? xmlText(entryXml, "link") ?? "").trim();
}

// Atom nests the author name (<author><name>Alice</name></author>), RSS keeps
// it flat (<author>...  </author> / <dc:creator>Bob</dc:creator>).
function entryAuthor(entryXml: string): string | undefined {
  const authorBlock = /<author\b[^>]*>([\s\S]*?)<\/author>/i.exec(entryXml)?.[1];
  if (authorBlock) {
    const name = xmlText(authorBlock, "name") ?? authorBlock.replace(/<[^>]*>/g, "").trim();
    if (name) return name;
  }
  return xmlText(entryXml, "dc:creator");
}

function parseEntryXml(entryXml: string): FeedEntry | undefined {
  const title = xmlText(entryXml, "title");
  const body =
    xmlText(entryXml, "description") ??
    xmlText(entryXml, "content:encoded") ??
    xmlText(entryXml, "content") ??
    xmlText(entryXml, "summary");
  const link = entryLink(entryXml);
  if (!title && !body && !link) return undefined;
  return {
    title,
    author: entryAuthor(entryXml),
    published:
      xmlText(entryXml, "published") ??
      xmlText(entryXml, "updated") ??
      xmlText(entryXml, "pubDate") ??
      xmlText(entryXml, "date"),
    link,
    bodyMarkdown: body ? htmlFragmentToMarkdown(body) : "",
  };
}

function parseEntries(xml: string, tag: "item" | "entry"): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const match of xml.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "g"))) {
    const entry = parseEntryXml(match[0] ?? "");
    if (entry) entries.push(entry);
  }
  return entries;
}

// Atom entries nest inside <feed>, so scope each entry block to its own XML to
// keep feed-level tags out of entry parsing. The feed-level <title> comes
// before the first <item>/<entry>.
export function parseFeed(xml: string): Feed | undefined {
  if (!looksLikeFeed(xml)) return undefined;
  const firstEntry = xml.search(/<(item|entry)\b/i);
  const head = firstEntry === -1 ? xml : xml.slice(0, firstEntry);
  const entries = [...parseEntries(xml, "entry"), ...parseEntries(xml, "item")];
  return { title: xmlText(head, "title"), entries: entries.slice(0, FEED_ENTRY_LIMIT) };
}

// Spec: フィードとして成立すれば記事情報を markdown で出力する。エントリは
// 最大 20 件。
export function renderFeedMarkdown(rawUrl: string, feed: Feed): string {
  const lines = [`# ${feed.title || "Feed"}`, "", `- URL: ${rawUrl}`, ""];
  lines.push(`## Entries (${feed.entries.length} retrieved)`, "");
  for (const [index, entry] of feed.entries.entries()) {
    lines.push(`### ${index + 1}. ${entry.title ?? "(no title)"}`, "");
    if (entry.author) lines.push(`- Author: ${entry.author}`, "");
    if (entry.published) lines.push(`- Published: ${entry.published}`, "");
    if (entry.link) lines.push(`- Link: ${entry.link}`, "");
    if (entry.bodyMarkdown) lines.push(entry.bodyMarkdown, "");
  }
  return lines.join("\n").trim();
}

export async function fetchFeedMarkdown(rawUrl: string): Promise<string> {
  const response = await fetch(rawUrl, {
    signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
    },
  });
  if (!response.ok) throw new Error(`feed ${response.status} ${response.statusText}`);
  const feed = parseFeed(await response.text());
  if (!feed || feed.entries.length === 0) {
    throw new Error("response is not a feed (no RSS/Atom entries)");
  }
  return renderFeedMarkdown(rawUrl, feed);
}
