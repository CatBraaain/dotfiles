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
function trimPerResult(text: string, maxLines = 3): string {
  const parts = text.split(/(?=^#{1,3}\s)/m);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const lines = p.split("\n").filter((l) => l.trim());
      return lines.slice(0, maxLines).join("\n");
    })
    .join("\n\n");
}

// ── web_search backends ──────────────────────────────────────────────

interface JinaSearchItem {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
}
interface JinaSearchResponse {
  data?: { content?: JinaSearchItem[] };
}

// Jina Search returns JSON; reformat each result to title/url/snippet.
function formatJinaSearch(raw: string): string {
  try {
    const items = (JSON.parse(raw) as JinaSearchResponse)?.data?.content;
    if (!Array.isArray(items)) return raw;
    return items
      .map((it) => {
        const title = `## ${it.title || it.url || "(no title)"}`;
        const url = it.url ? `\n${it.url}` : "";
        const body = (it.content || it.description || "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 1)
          .join("\n");
        return `${title}${url}\n${body}`;
      })
      .join("\n\n---\n\n");
  } catch {
    return raw;
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

// markdown.new — top N Google results via Serper.dev, each as Markdown.
const markdownNewSearch = (query: string, signal?: AbortSignal) =>
  fetchText(`https://markdown.new/search/${encodeURIComponent(query)}?n=5`, undefined, signal);

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

async function fetchOne(url: string, signal?: AbortSignal): Promise<SearchResult> {
  const jina = await jinaReader(url, signal);
  if (jina) return { text: jina, backend: "jina-reader" };

  const md = await mdDhrWtf(url, signal);
  if (md) return { text: `*(via md.dhr.wtf)*\n\n${md}`, backend: "md.dhr.wtf" };

  const cr = await crawl4aiFetch(url, signal);
  if (cr) return { text: `*(via crawl4ai)*\n\n${cr}`, backend: "crawl4ai" };

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
      const { text, backend } = await fetchOne(params.url, signal);
      return {
        content: [{ type: "text", text }],
        details: { url: params.url, backend },
      };
    },
  });
}
