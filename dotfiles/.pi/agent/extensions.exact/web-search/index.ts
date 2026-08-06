import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const BACKEND_COOLDOWN_MS = 30 * 60 * 1000;
export const __backendFailures = new Map<string, number>();

export const isAvailable = (backend: string) =>
  Date.now() - (__backendFailures.get(backend) ?? 0) >= BACKEND_COOLDOWN_MS;

export const markFailed = (backend: string) => {
  __backendFailures.set(backend, Date.now());
};

export const __resetBackendFailures = () => {
  __backendFailures.clear();
};

async function fetchText(
  url: string,
  signal?: AbortSignal,
  headers?: HeadersInit,
): Promise<string> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    signal,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

// ponytail: openserp 0.8.12 は markdown 出力で --limit を無視して常に10件返すため、実装側で先頭5件に切り詰める。openserp 修正後も5件以下になるだけで害なし。
function takeFirstEntries(markdown: string, limit: number): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let entriesSeen = 0;
  for (const line of lines) {
    if (/^### \d+\./.test(line)) {
      entriesSeen++;
      if (entriesSeen > limit) break;
    }
    kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

async function openserp(engine: string, query: string, signal?: AbortSignal) {
  const markdown = await run("openserp", ["search", engine, query, "--limit", "5", "--format", "markdown"], signal);
  return takeFirstEntries(markdown, 5);
}

async function searchMarkdownNew(query: string, signal?: AbortSignal) {
  return fetchText(`https://markdown.new/search/${encodeURIComponent(query)}?n=5`, signal);
}

export type BackendEntry = readonly [name: string, run: () => Promise<string>];

export function defaultSearchBackends(query: string, signal?: AbortSignal): BackendEntry[] {
  return [
    ["openserp(google)", () => openserp("google", query, signal)],
    ["openserp(duckduckgo)", () => openserp("duckduckgo", query, signal)],
    ["openserp(bing)", () => openserp("bing", query, signal)],
    ["markdown.new", () => searchMarkdownNew(query, signal)],
  ];
}

export async function searchOne(
  query: string,
  signal: AbortSignal | undefined,
  notify: (message: string) => void,
  backends: BackendEntry[] = defaultSearchBackends(query, signal),
): Promise<{ text: string; backend: string }> {
  const errors: string[] = [];

  for (const [name, search] of backends) {
    if (!isAvailable(name)) continue;
    try {
      const text = await search();
      if (text) return { text, backend: name };
      throw new Error("empty response");
    } catch (error) {
      markFailed(name);
      const message = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      notify(message);
    }
  }
  throw new Error(`All web search backends failed: ${errors.join("; ")}`);
}

async function trafilaturaFetch(url: string, signal?: AbortSignal) {
  return run("trafilatura", ["--URL", url, "--markdown"], signal);
}

async function jinaFetch(url: string, signal?: AbortSignal) {
  const headers: HeadersInit = { Accept: "text/markdown" };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  return fetchText(`https://r.jina.ai/${url}`, signal, headers);
}

async function dhrFetch(url: string, signal?: AbortSignal) {
  return fetchText(`https://md.dhr.wtf/?url=${encodeURIComponent(url)}`, signal);
}

export function defaultFetchBackends(url: string, signal?: AbortSignal): BackendEntry[] {
  return [
    ["trafilatura", () => trafilaturaFetch(url, signal)],
    ["Jina Reader", () => jinaFetch(url, signal)],
    ["md.dhr.wtf", () => dhrFetch(url, signal)],
  ];
}

export async function fetchOne(
  url: string,
  signal: AbortSignal | undefined,
  notify: (message: string) => void,
  backends: BackendEntry[] = defaultFetchBackends(url, signal),
): Promise<{ text: string; backend: string }> {
  const errors: string[] = [];

  for (const [name, fetcher] of backends) {
    try {
      const text = await fetcher();
      if (text) return { text, backend: name };
      throw new Error("empty response");
    } catch (error) {
      const message = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      notify(message);
    }
  }
  throw new Error(`All web fetch backends failed: ${errors.join("; ")}`);
}

export async function pageTitle(
  url: string,
  signal?: AbortSignal,
  fetcher: (url: string, signal?: AbortSignal) => Promise<string> = fetchText,
): Promise<string | null> {
  try {
    const html = await fetcher(url, signal);
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match?.[1]?.replace(/\s+/g, " ").trim() || null;
  } catch {
    return null;
  }
}

export function fetchResultLine(title: string | null, url: string): string {
  return title ? `${url} - ${title}` : url;
}

const searchParameters = Type.Object({
  query: Type.String({ description: "Single search query" }),
});
const fetchParameters = Type.Object({ url: Type.String({ description: "Absolute URL to fetch" }) });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with a single query.",
    parameters: searchParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { text, backend } = await searchOne(params.query, signal, (message) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      });
      return { content: [{ type: "text", text }], details: { backend } };
    },
    renderCall(_args, theme, context) {
      const label = context.state.backend ? `web_search - ${context.state.backend}` : "web_search";
      return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
    },
    renderResult(result, _options, _theme, context) {
      const backend = (result.details as { backend?: string } | undefined)?.backend;
      if (backend && context.state.backend !== backend) {
        context.state.backend = backend;
        queueMicrotask(() => context.invalidate());
      }
      return new Text(context.args.query, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a single URL as Markdown.",
    parameters: fetchParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { text, backend } = await fetchOne(params.url, signal, (message) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      });
      const title = await pageTitle(params.url, signal);
      return { content: [{ type: "text", text }], details: { title, backend } };
    },
    renderCall(_args, theme, context) {
      const label = context.state.backend ? `web_fetch - ${context.state.backend}` : "web_fetch";
      return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
    },
    renderResult(result, _options, _theme, context) {
      const details = result.details as { backend?: string; title?: string | null } | undefined;
      const backend = details?.backend;
      if (backend && context.state.backend !== backend) {
        context.state.backend = backend;
        queueMicrotask(() => context.invalidate());
      }
      return new Text(fetchResultLine(details?.title ?? null, context.args.url), 0, 0);
    },
  });
}
