import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";

async function fetchText(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const resp = await fetch(url, { headers: opts.headers, signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

// --- search ---

async function searchJina(query: string, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = {};
  if (process.env.JINA_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.JINA_API_KEY}`;
  }
  return fetchText(`https://s.jina.ai/${encodeURIComponent(query)}`, {
    headers,
    timeoutMs: 30_000,
    signal,
  });
}

async function searchOpenSERP(query: string, signal?: AbortSignal): Promise<string> {
  if (!process.env.OPENSERP_API_KEY) {
    throw new Error("OPENSERP_API_KEY not set");
  }
  const url = `https://api.openserp.org/v1/google/search?text=${encodeURIComponent(query)}&limit=10&lang=EN`;
  return fetchText(url, {
    headers: { Authorization: `Bearer ${process.env.OPENSERP_API_KEY}` },
    timeoutMs: 15_000,
    signal,
  });
}

async function doSearch(query: string, signal?: AbortSignal): Promise<string> {
  try {
    return await searchJina(query, signal);
  } catch {
    return searchOpenSERP(query, signal);
  }
}

// --- fetch ---

async function fetchJina(url: string, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = { Accept: "text/markdown" };
  if (process.env.JINA_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.JINA_API_KEY}`;
  }
  return fetchText(`https://r.jina.ai/${url}`, {
    headers,
    timeoutMs: 30_000,
    signal,
  });
}

async function fetchMarkdownNew(url: string, signal?: AbortSignal): Promise<string> {
  const encoded = encodeURIComponent(url);
  return fetchText(`https://markdown.new/${encoded}`, {
    headers: { Accept: "text/markdown" },
    timeoutMs: 30_000,
    signal,
  });
}

function fetchCrawl4ai(url: string): string {
  return execFileSync("crwl", [url, "-o", "markdown"], {
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function doFetch(url: string, signal?: AbortSignal): Promise<string> {
  try {
    return await fetchJina(url, signal);
  } catch { /* fall through */ }
  try {
    return await fetchMarkdownNew(url, signal);
  } catch { /* fall through */ }
  return fetchCrawl4ai(url);
}

// --- extension ---

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Jina (20 RPM, no auth) with fallback to OpenSERP (requires OPENSERP_API_KEY). For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query for broader coverage.",
    promptSnippet:
      "Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Single search query" })),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description: "Multiple queries for broader coverage (preferred)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const queryList =
        params.queries && params.queries.length > 0
          ? params.queries
          : params.query
            ? [params.query]
            : [];

      if (queryList.length === 0) {
        return {
          content: [{ type: "text", text: "No query provided." }],
          details: { error: "no_query" },
        };
      }

      const results: string[] = [];
      for (const q of queryList) {
        try {
          const r = await doSearch(q, signal);
          results.push(`## Query: "${q}"\n\n${r}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`## Query: "${q}"\n\nError: ${msg}`);
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n\n---\n\n") }],
        details: { queryCount: queryList.length },
      };
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Extract readable content from URL(s) as Markdown. Fallback: Jina Reader (20 RPM) → markdown.new (500 RPD) → crawl4ai. Supports YouTube, GitHub repos, and local video files via Jina Reader.",
    promptSnippet:
      "Fetch readable content from URL(s) as Markdown.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
      urls: Type.Optional(
        Type.Array(Type.String(), { description: "Multiple URLs to fetch" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const urlList =
        params.urls && params.urls.length > 0
          ? params.urls
          : params.url
            ? [params.url]
            : [];

      if (urlList.length === 0) {
        return {
          content: [{ type: "text", text: "No URL provided." }],
          details: { error: "no_url" },
        };
      }

      const results: string[] = [];
      for (const url of urlList) {
        try {
          results.push(await doFetch(url, signal));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`Error fetching ${url}: ${msg}`);
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n\n---\n\n") }],
        details: { urlCount: urlList.length },
      };
    },
  });
};
