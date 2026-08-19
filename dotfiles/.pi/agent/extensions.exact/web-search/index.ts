import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BACKEND_TIMEOUT_MS = 15_000;
export const SEARCH_RESULT_LIMIT = 10;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchText(
  url: string,
  signal?: AbortSignal,
  headers?: HeadersInit,
): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": BROWSER_USER_AGENT, ...headers },
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

function runWithStdin(
  command: string,
  args: string[],
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { signal, timeout: BACKEND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
    child.stdin.end(input);
  });
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

class AllBackendsFailedError extends Error {
  constructor(
    readonly operation: "web search" | "web fetch",
    readonly attempts: Attempt[],
  ) {
    super(
      `All ${operation} backends failed: ${attempts
        .filter((attempt) => !attempt.ok)
        .map((attempt) => `${attempt.backend}: ${attempt.error}`)
        .join("; ")}`,
    );
  }
}

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
    try {
      const text = await search();
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
  throw new AllBackendsFailedError("web search", attempts);
}

// Raw-fetch the URL and convert to Markdown via trafilatura stdin.
// Non-HTML bodies (text/plain etc.) are returned as-is without conversion.
async function fetchToMarkdown(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    headers: { "User-Agent": BROWSER_USER_AGENT },
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    ]),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) return body;
  return runWithStdin("trafilatura", ["--markdown"], body, signal);
}

async function trafilaturaFetch(url: string, signal?: AbortSignal) {
  return run("trafilatura", ["--URL", url, "--markdown"], signal);
}

async function jinaFetch(url: string, signal?: AbortSignal) {
  const headers: HeadersInit = { Accept: "text/markdown" };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  return fetchText(`https://r.jina.ai/${url}`, signal, headers);
}

export function defaultFetchBackends(url: string, signal?: AbortSignal): BackendEntry[] {
  return [
    ["trafilatura", () => trafilaturaFetch(url, signal)],
    ["fetch+trafilatura", () => fetchToMarkdown(url, signal)],
    ["Jina Reader", () => jinaFetch(url, signal)],
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
  throw new AllBackendsFailedError("web fetch", attempts);
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

type BackendRenderState = { attempts?: Attempt[] };
function attemptsForRender(result: { details?: unknown }, state?: BackendRenderState): Attempt[] {
  const details = result.details as { attempts?: Attempt[] } | undefined;
  if (details?.attempts && state) state.attempts = details.attempts;
  return details?.attempts ?? state?.attempts ?? [];
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
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        const { text, backend, attempts } = await searchOne(
          params.query,
          signal,
          undefined,
          params.lang,
        );
        return { content: [{ type: "text", text }], details: { backend, attempts } };
      } catch (error) {
        if (error instanceof AllBackendsFailedError) {
          onUpdate?.({ content: [], details: { attempts: error.attempts } });
        }
        throw error;
      }
    },
    renderCall(args, theme) {
      const langSuffix = args.lang ? ` [lang=${args.lang}]` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`web_search - "${args.query ?? ""}"${langSuffix}`)),
        0,
        0,
      );
    },
    renderResult(result, _options, _theme, context) {
      const attempts = attemptsForRender(result, context?.state as BackendRenderState | undefined);
      return new Text(formatBackendLines(attempts).join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a single URL as Markdown.",
    parameters: fetchParameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        const { text, backend, attempts } = await fetchOne(params.url, signal);
        const title = await pageTitle(params.url, signal);
        return { content: [{ type: "text", text }], details: { backend, attempts, title } };
      } catch (error) {
        if (error instanceof AllBackendsFailedError) {
          onUpdate?.({ content: [], details: { attempts: error.attempts } });
        }
        throw error;
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(`web_fetch - "${args.url ?? ""}"`)), 0, 0);
    },
    renderResult(result, _options, _theme, context) {
      const details = result.details as { title?: string | null } | undefined;
      const attempts = attemptsForRender(result, context?.state as BackendRenderState | undefined);
      return new Text(formatBackendLines(attempts, details?.title ?? null).join("\n"), 0, 0);
    },
  });
}
