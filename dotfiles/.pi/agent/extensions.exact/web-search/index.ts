import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BACKEND_COOLDOWN_MS = 30 * 60 * 1000;
export const BACKEND_TIMEOUT_MS = 15_000;
export const SEARCH_RESULT_LIMIT = 10;
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
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    ]),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    signal,
    timeout: BACKEND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

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

export function openserpError(error: unknown): Error {
  const stderr = (error as { stderr?: string })?.stderr ?? "";
  const errorDetail = stderr
    .split("\n")
    .findLast((line) => line.startsWith("Error:"))
    ?.replace(/^Error:\s*/, "")
    .trim();
  return new Error(errorDetail ?? (error instanceof Error ? error.message : String(error)));
}

async function openserp(engine: string, query: string, signal?: AbortSignal, lang?: string) {
  try {
    const args = [
      "search",
      engine,
      query,
      "--limit",
      String(SEARCH_RESULT_LIMIT),
      "--format",
      "markdown",
    ];
    if (lang) args.push("--lang", lang);
    const markdown = await run("openserp", args, signal);
    return takeFirstEntries(markdown, SEARCH_RESULT_LIMIT);
  } catch (error) {
    throw openserpError(error);
  }
}

async function searchMarkdownNew(query: string, signal?: AbortSignal) {
  return fetchText(
    `https://markdown.new/search/${encodeURIComponent(query)}?n=${SEARCH_RESULT_LIMIT}`,
    signal,
  );
}

export type Attempt =
  | { readonly backend: string; readonly ok: true }
  | { readonly backend: string; readonly ok: false; readonly error: string };

export type BackendEntry = readonly [name: string, run: () => Promise<string>];

export function defaultSearchBackends(
  query: string,
  signal?: AbortSignal,
  lang?: string,
): BackendEntry[] {
  return [
    ["openserp(google)", () => openserp("google", query, signal, lang)],
    ["openserp(duckduckgo)", () => openserp("duckduckgo", query, signal, lang)],
    ["openserp(bing)", () => openserp("bing", query, signal, lang)],
    ["markdown.new", () => searchMarkdownNew(query, signal)],
  ];
}

export async function searchOne(
  query: string,
  signal: AbortSignal | undefined,
  backends?: BackendEntry[],
  lang?: string,
): Promise<{ text: string; backend: string; attempts: Attempt[] }> {
  const resolvedBackends = backends ?? defaultSearchBackends(query, signal, lang);
  const attempts: Attempt[] = [];

  for (const [name, search] of resolvedBackends) {
    if (!isAvailable(name)) continue;
    try {
      const text = await search();
      if (!text) throw new Error("empty response");
      attempts.push({ backend: name, ok: true });
      return { text, backend: name, attempts };
    } catch (error) {
      markFailed(name);
      attempts.push({
        backend: name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error(
    `All web search backends failed: ${attempts
      .filter((a) => !a.ok)
      .map((a) => `${a.backend}: ${a.error}`)
      .join("; ")}`,
  );
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
  backends: BackendEntry[] = defaultFetchBackends(url, signal),
): Promise<{ text: string; backend: string; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];

  for (const [name, fetcher] of backends) {
    try {
      const text = await fetcher();
      if (!text) throw new Error("empty response");
      attempts.push({ backend: name, ok: true });
      return { text, backend: name, attempts };
    } catch (error) {
      attempts.push({
        backend: name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error(
    `All web fetch backends failed: ${attempts
      .filter((a) => !a.ok)
      .map((a) => `${a.backend}: ${a.error}`)
      .join("; ")}`,
  );
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

export function formatBackendLine(attempt: Attempt, successTitle?: string | null): string {
  if (!attempt.ok) return `✗ ${attempt.backend} - "${attempt.error}"`;
  return successTitle ? `✓ ${attempt.backend} - "${successTitle}"` : `✓ ${attempt.backend}`;
}

export function formatBackendLines(
  attempts: readonly Attempt[],
  successTitle: string | null = null,
): string[] {
  return attempts.map((attempt, index) => {
    const isFinalSuccess = attempt.ok && index === attempts.length - 1;
    return formatBackendLine(attempt, isFinalSuccess ? successTitle : null);
  });
}

const searchParameters = Type.Object({
  query: Type.String({ description: "Single search query" }),
  lang: Type.Optional(
    Type.String({
      description: "Language hint passed to openserp (e.g. EN, DE, JA). Ignored by markdown.new.",
    }),
  ),
});
const fetchParameters = Type.Object({ url: Type.String({ description: "Absolute URL to fetch" }) });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with a single query.",
    parameters: searchParameters,
    async execute(_toolCallId, params, signal) {
      const { text, backend, attempts } = await searchOne(
        params.query,
        signal,
        undefined,
        params.lang,
      );
      return { content: [{ type: "text", text }], details: { backend, attempts } };
    },
    renderCall(args, theme) {
      const langSuffix = args.lang ? ` [lang=${args.lang}]` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`web_search - "${args.query ?? ""}"${langSuffix}`)),
        0,
        0,
      );
    },
    renderResult(result) {
      const attempts = (result.details as { attempts?: Attempt[] } | undefined)?.attempts ?? [];
      return new Text(formatBackendLines(attempts).join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a single URL as Markdown.",
    parameters: fetchParameters,
    async execute(_toolCallId, params, signal) {
      const { text, backend, attempts } = await fetchOne(params.url, signal);
      const title = await pageTitle(params.url, signal);
      return { content: [{ type: "text", text }], details: { backend, attempts, title } };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(`web_fetch - "${args.url ?? ""}"`)), 0, 0);
    },
    renderResult(result) {
      const details = result.details as { attempts?: Attempt[]; title?: string | null } | undefined;
      return new Text(
        formatBackendLines(details?.attempts ?? [], details?.title ?? null).join("\n"),
        0,
        0,
      );
    },
  });
}
