// @ts-nocheck

/**
 * web_search + web_fetch overrides.
 *
 * web_search: Jina Search → markdown.new → openserp CLI
 * web_fetch:  Jina Reader  → md.dhr.wtf    → crawl4ai CLI (crwl)
 *
 * s.jina.ai (search) requires JINA_API_KEY — skipped entirely without it.
 * r.jina.ai (reader) works unauthenticated; sends Bearer only if key is set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const JINA_KEY = process.env.JINA_API_KEY;
const FETCH_TIMEOUT_MS = 15_000;

interface SearchResult {
  text: string;
  backend: string;
}

// ── shared helpers ───────────────────────────────────────────────────

// fetch → text, with a hard timeout so a hung backend can't block forever.
async function fetchText(
  url: string,
  opts?: RequestInit,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const res = await fetch(url, { ...opts, signal: AbortSignal.any(signals) });
    if (!res.ok) return null;
    const t = await res.text();
    return t.trim() || null;
  } catch {
    return null;
  }
}

function jinaHeaders(accept: string): HeadersInit {
  const h: Record<string, string> = { Accept: accept };
  if (JINA_KEY) h.Authorization = `Bearer ${JINA_KEY}`;
  return h;
}

// Trim every result section (delimited by a `##` header) to its first 3 lines
// so the terminal stays readable. Generic over markdown.new + openserp output.
// maxLineChars caps long single lines (raw JSON blobs, unwrapped paragraphs) so
// a header-less or blob-shaped fallback can never dump the whole page.
function trimPerResult(text: string, maxLines = 3, maxLineChars = 300): string {
  const parts = text.split(/(?=^#{1,3}\s)/m);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const lines = p
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => (l.length > maxLineChars ? `${l.slice(0, maxLineChars)}…` : l));
      return lines.slice(0, maxLines).join("\n");
    })
    .join("\n\n");
}

// ── web_search backends ──────────────────────────────────────────────

// Jina Search returns JSON; reformat each result to title/url/snippet.
// s.jina.ai now returns { data: [...] } (array directly); older docs showed
// data.content. Accept both so a shape change can't silently dump raw JSON.
// Use `description` (the search snippet) — `content` is the full page and must
// never reach search output.
function formatJinaSearch(raw: string): string {
  try {
    const data = (JSON.parse(raw) as { data?: unknown })?.data;
    const items = Array.isArray(data) ? data : (data as { content?: unknown[] } | null)?.content;
    if (!Array.isArray(items)) return "";
    return items
      .map((it) => {
        const item = it as { title?: string; url?: string; description?: string };
        const title = `## ${item.title || item.url || "(no title)"}`;
        const url = item.url ? `\n${item.url}` : "";
        const body = (item.description || "").trim();
        return body ? `${title}${url}\n${body}` : `${title}${url}`;
      })
      .join("\n\n---\n\n");
  } catch {
    return "";
  }
}

// Jina Search API — https://s.jina.ai. Reads JINA_API_KEY if present.
async function jinaSearch(query: string, signal?: AbortSignal): Promise<string | null> {
  const raw = await fetchText(
    `https://s.jina.ai/?q=${encodeURIComponent(query)}`,
    { headers: jinaHeaders("application/json") },
    signal,
  );
  return raw ? formatJinaSearch(raw) : null;
}

// markdown.new — top N Google results via Serper.dev. Each result embeds the
// full page after a <!-- BEGIN MARKDOWN --> marker; for search we keep only the
// title/url metadata block, otherwise the page's internal ## / ### subheadings
// get treated as separate "results" by trimPerResult and the output explodes.
async function markdownNewSearch(query: string, signal?: AbortSignal): Promise<string | null> {
  const raw = await fetchText(
    `https://markdown.new/search/${encodeURIComponent(query)}?n=5`,
    undefined,
    signal,
  );
  if (!raw) return null;
  return raw
    .split(/(?=^## \d+\.\s)/m)
    .map((p) => p.split("<!-- BEGIN MARKDOWN")[0].trim())
    .filter(Boolean)
    .join("\n\n");
}

// openserp ecosia — no browser needed in --raw mode. Snippets only.
async function openSerpSearch(query: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "openserp",
      [
        "search",
        "ecosia",
        query,
        "--format",
        "markdown",
        "--limit",
        "10",
        "--raw",
        "--timeout",
        "20",
      ],
      { timeout: 25_000, maxBuffer: 512 * 1024, signal },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── web_fetch backends ───────────────────────────────────────────────

// Jina Reader API — URL → Markdown. https://r.jina.ai/<url>
const jinaReader = (url: string, signal?: AbortSignal) =>
  fetchText(`https://r.jina.ai/${url}`, { headers: jinaHeaders("text/markdown") }, signal);

// md.dhr.wtf (Markdowner) — URL → Markdown. ~5 req/min free.
const mdDhrWtf = (url: string, signal?: AbortSignal) =>
  fetchText(`https://md.dhr.wtf/?url=${encodeURIComponent(url)}`, undefined, signal);

// crawl4ai CLI (crwl) — local headless browser, Markdown output.
async function crawl4aiFetch(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("crwl", [url, "-o", "markdown", "-bc"], {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      signal,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── orchestration ────────────────────────────────────────────────────

async function searchOne(query: string, signal?: AbortSignal): Promise<SearchResult> {
  const jina = JINA_KEY ? await jinaSearch(query, signal) : null;
  if (jina) return { text: trimPerResult(jina), backend: "jina" };

  const mdNew = await markdownNewSearch(query, signal);
  if (mdNew)
    return { text: `*(via markdown.new)*\n\n${trimPerResult(mdNew)}`, backend: "markdown.new" };

  const os = await openSerpSearch(query, signal);
  if (os)
    return {
      text: `*(via openserp ecosia — snippets only)*\n\n${trimPerResult(os)}`,
      backend: "openserp",
    };

  throw new Error(`Search failed for "${query}": all backends unavailable`);
}

// Cap fetch output so the TUI stays readable. Keeps first N lines, truncates
// long single lines. Full content goes into details for manual expansion.
function trimFetchContent(text: string, maxLines = 50, maxLineChars = 500): string {
  const lines = text
    .split("\n")
    .map((l) => (l.length > maxLineChars ? `${l.slice(0, maxLineChars)}…` : l));
  const trimmed = lines.slice(0, maxLines).join("\n");
  return lines.length > maxLines ? `${trimmed}\n\n…(truncated)` : trimmed;
}

async function fetchOne(
  url: string,
  signal?: AbortSignal,
): Promise<SearchResult & { rawText: string }> {
  const jina = await jinaReader(url, signal);
  if (jina) return { text: trimFetchContent(jina), rawText: jina, backend: "jina-reader" };

  const md = await mdDhrWtf(url, signal);
  if (md)
    return {
      text: `*(via md.dhr.wtf)*\n\n${trimFetchContent(md)}`,
      rawText: md,
      backend: "md.dhr.wtf",
    };

  const cr = await crawl4aiFetch(url, signal);
  if (cr)
    return {
      text: `*(via crawl4ai)*\n\n${trimFetchContent(cr)}`,
      rawText: cr,
      backend: "crawl4ai",
    };

  throw new Error(`Fetch failed for ${url}: all backends unavailable`);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
    parameters: Type.Object({
      query: Type.String({ description: "Single search query" }),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description: "Multiple search queries for comprehensive coverage (2-4 recommended)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const queries: string[] = params.queries?.length ? params.queries : [params.query];
      const results = await Promise.all(queries.map((q) => searchOne(q, signal)));

      const text = results
        .map((r, i) =>
          queries.length > 1 ? `## Query ${i + 1}: ${queries[i]}\n\n${r.text}` : r.text,
        )
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text }],
        details: { queries, backends: results.map((r) => r.backend) },
      };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a single URL and return its content as Markdown. Use for reading a specific page the user gave or that search results pointed to.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to fetch" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { text, rawText, backend } = await fetchOne(params.url, signal);
      return {
        content: [{ type: "text", text }],
        details: { url: params.url, backend, rawContent: rawText },
      };
    },
  });
}
