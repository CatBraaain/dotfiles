/**
 * dotfiles-dsh-web-search — host providers for the dsh web seam (`ctx.web`).
 *
 * Registers a camoufox + openserp search provider (id `camoufox-openserp`)
 * and a camoufox + trafilatura fetch provider (id `camoufox-trafilatura`).
 * Ported from the pi `web-search` extension; the behavior contract is SPEC.md.
 *
 * `run_build.sh` bundles this entry: relative imports are inlined and only
 * the script's explicit bare-specifier externals stay external. The camoufox
 * server (`server.mjs`) ships in the package root, outside the bundle.
 */
import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";
import type { Context } from "@deepseek-ai/cordis";
import {
  type ChildProcess,
  type SpawnOptions,
  execFile,
  spawn,
} from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SEARCH_RESULT_LIMIT = 10;

// SPEC §"常駐サーバー" / timeouts: server launch wait and per-stage limits.
export const SERVER_WAIT_TIMEOUT_MS = 15_000;
export const RENDER_TIMEOUT_MS = 30_000;
export const PARSE_TIMEOUT_MS = 15_000;
export const CONVERT_TIMEOUT_MS = 15_000;
export const REDDIT_TIMEOUT_MS = 15_000;
export const STACKOVERFLOW_TIMEOUT_MS = 15_000;

// Package root: src in development, dist after `run_build.sh` — both sit one
// level below the root that carries server.mjs.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CAMOUFOX_SEARCH_SESSION_KEY = "web-search";
const CAMOUFOX_FETCH_SESSION_KEY = "web-fetch";
const SERVER_HEALTH_POLL_INTERVAL_MS = 250;
const WEBSOCKET_HEALTH_TIMEOUT_MS = 1_000;
const SERVER_PROBE_TIMEOUT_MS = 1_000;

// --- plugin entry ---

export const name = "dsh-web-search";
export const inject = ["web"];

export interface WebSearchPluginConfig {
  readonly camoufoxBaseUrl?: string;
  readonly openserpBaseUrl?: string;
}

export const Config = z.object({
  camoufoxBaseUrl: z.string(),
  openserpBaseUrl: z.string(),
});

export const CAMOUFOX_DEFAULT_BASE_URL = "ws://127.0.0.1:9378/camoufox";
export const OPENSERP_DEFAULT_BASE_URL = "http://127.0.0.1:7000";

export interface ServerEndpoints {
  readonly camoufoxBaseUrl: string;
  readonly openserpBaseUrl: string;
}

// SPEC §"設定": priority is config value > environment variable > default.
export function resolveEndpoints(
  config: WebSearchPluginConfig,
  env: Record<string, string | undefined> = process.env,
): ServerEndpoints {
  return {
    camoufoxBaseUrl:
      config.camoufoxBaseUrl ?? env.CAMOUFOX_BASE_URL ?? CAMOUFOX_DEFAULT_BASE_URL,
    openserpBaseUrl:
      config.openserpBaseUrl ?? env.OPENSERP_BASE_URL ?? OPENSERP_DEFAULT_BASE_URL,
  };
}

export type ApplyDeps = {
  /** Prime hook override for tests; default `primeServers`. */
  prime?: (endpoints: ServerEndpoints, deps?: PrimeServerDeps) => Promise<void>;
};

// SPEC §"提供する plugin": register both providers, then fire-and-forget the
// resident-server priming (SPEC §"常駐サーバー" apply row).
export function apply(
  ctx: Context,
  config: WebSearchPluginConfig = {},
  deps: ApplyDeps = {},
): void {
  const endpoints = resolveEndpoints(config);
  ctx.web.registerSearchProvider(new CamoufoxOpenserpSearchProvider(endpoints));
  ctx.web.registerFetchProvider(new CamoufoxTrafilaturaFetchProvider(endpoints));
  void (deps.prime ?? primeServers)(endpoints);
}

// --- providers (contract layer) ---

export const SEARCH_PROVIDER_ID = "camoufox-openserp";
export const FETCH_PROVIDER_ID = "camoufox-trafilatura";

export type ProviderDeps = {
  /** Override for the local availability check used by `available()`. */
  prerequisitesMet?: () => boolean;
  /** Override for the whole search backend chain (tests). */
  search?: (query: string, signal?: AbortSignal) => Promise<WebSearchSource[]>;
  /** Override for the whole fetch backend chain (tests). */
  fetch?: (url: string, signal?: AbortSignal) => Promise<string>;
};

// Convert any backend-chain failure into the seam's WebError. The
// AllBackendsFailedError message (per-engine failure lines, kill hint) is
// carried over verbatim; `cause` keeps the original attempts for inspection.
export function toWebError(error: unknown): WebError {
  if (error instanceof WebError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WebError(message, "WEB_PROVIDER_ERROR", { cause: error });
}

export class CamoufoxOpenserpSearchProvider implements WebSearchProvider {
  readonly id = SEARCH_PROVIDER_ID;
  private readonly queue = new SerialTaskQueue();

  constructor(
    private readonly endpoints: ServerEndpoints,
    private readonly deps: ProviderDeps = {},
  ) {}

  // SPEC §"search provider": PATH binaries + camoufox executable, no network.
  available(): boolean {
    return (this.deps.prerequisitesMet ?? hostPrerequisitesMet)();
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const runSearch =
      this.deps.search ??
      (async (query: string, searchSignal?: AbortSignal) =>
        (await searchOne(query, this.endpoints, searchSignal)).sources);
    try {
      // SPEC §"同種リクエストの直列化": searches run one at a time.
      const sources = await this.queue.run(() => runSearch(request.query, signal));
      // SPEC §"search provider": cap to maxResults, or 10 when unspecified.
      const limit = request.maxResults ?? SEARCH_RESULT_LIMIT;
      return { sources: sources.slice(0, limit), truncated: false };
    } catch (error) {
      throw toWebError(error);
    }
  }
}

export class CamoufoxTrafilaturaFetchProvider implements WebFetchProvider {
  readonly id = FETCH_PROVIDER_ID;
  private readonly queue = new SerialTaskQueue();

  constructor(
    private readonly endpoints: ServerEndpoints,
    private readonly deps: ProviderDeps = {},
  ) {}

  // SPEC §"fetch provider": same condition as the search provider.
  available(): boolean {
    return (this.deps.prerequisitesMet ?? hostPrerequisitesMet)();
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const runFetch =
      this.deps.fetch ??
      (async (url: string, fetchSignal?: AbortSignal) =>
        (await fetchOne(url, this.endpoints.camoufoxBaseUrl, fetchSignal)).markdown);
    try {
      // SPEC §"同種リクエストの直列化": fetches run one at a time.
      const markdown = await this.queue.run(() => runFetch(request.url, signal));
      return {
        url: normalizedFetchUrl(request.url),
        statusCode: 200,
        body: { kind: "text", content: markdown },
        truncated: false,
      };
    } catch (error) {
      throw toWebError(error);
    }
  }
}

// SPEC §"fetch provider": the result URL is the input URL, or the route's
// normalized URL (Reddit/StackOverflow permalinks).
export function normalizedFetchUrl(rawUrl: string): string {
  return (
    parseRedditPostUrl(rawUrl)?.permalink ??
    parseStackOverflowQuestionUrl(rawUrl)?.permalink ??
    rawUrl
  );
}

// --- local availability check (SPEC §"search provider" available()) ---

export const REQUIRED_BINARIES = ["bun", "openserp", "playwright-cli"] as const;

// SPEC §"search provider": camoufox browser executable location (env override,
// default ~/.cache/camoufox/camoufox-bin).
export function camoufoxExecutablePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CAMOUFOX_EXECUTABLE_PATH ?? join(homedir(), ".cache", "camoufox", "camoufox-bin");
}

// Locate a binary by scanning PATH directories locally; no subprocess, no
// network. Windows resolves through PATHEXT extension candidates.
export function binaryOnPath(
  binaryName: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const pathDirectories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidateNames =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((ext) => `${binaryName}${ext.toLowerCase()}`)
      : [binaryName];
  return pathDirectories.some((directory) =>
    candidateNames.some((candidate) => {
      try {
        accessSync(join(directory, candidate), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

export function hostPrerequisitesMet(
  env: Record<string, string | undefined> = process.env,
  deps: { binaryOnPath?: typeof binaryOnPath; fileExists?: (path: string) => boolean } = {},
): boolean {
  const findBinary = deps.binaryOnPath ?? binaryOnPath;
  const fileExists = deps.fileExists ?? existsSync;
  return (
    REQUIRED_BINARIES.every((binaryName) => findBinary(binaryName, env)) &&
    fileExists(camoufoxExecutablePath(env))
  );
}

// --- backend chain shared by both providers ---

export type Attempt =
  | { readonly backend: string; readonly ok: true; readonly durationMs?: number }
  | {
      readonly backend: string;
      readonly ok: false;
      readonly error: string;
      readonly durationMs?: number;
    };

// SPEC §"search provider" / §"fetch provider": the all-failed error message
// carries one failure line per backend, plus the kill hint on render aborts.
export class AllBackendsFailedError extends Error {
  constructor(
    readonly operation: "web search" | "web fetch",
    readonly attempts: Attempt[],
  ) {
    super(
      `All ${operation} backends failed: ${attempts
        .filter((attempt) => !attempt.ok)
        .map((attempt) => `${attempt.backend}: ${attempt.error}`)
        .join("; ")}${renderAbortHint(attempts)}`,
    );
  }
}

// A render-stage abort means every camoufox render timed out while the server
// health check (websocket handshake) still passed: the camoufox server's
// browser process is likely hung. Surface the manual recovery so an agent can
// fix the environment unaided (the server respawns automatically after a kill).
function renderAbortHint(attempts: Attempt[]): string {
  const renderAborted = attempts.some(
    (attempt) =>
      !attempt.ok && attempt.error.startsWith("render:") && /aborted/i.test(attempt.error),
  );
  return renderAborted
    ? `\nHint: renders aborted while the servers looked healthy, so the camoufox server is likely hung. Kill it to recover (it respawns automatically on the next request): pkill -f "bun server.mjs"`
    : "";
}

export type BackendEntry<T> = readonly [name: string, run: () => Promise<T>];

// Run backends in order, record an Attempt each, and return the first
// non-empty payload. A whitespace-only / zero-length payload counts as a
// failure of that backend (SPEC: empty results fall through to the next one).
async function tryBackends<T>(
  operation: "web search" | "web fetch",
  backends: readonly BackendEntry<T>[],
  isEmpty: (payload: T) => boolean,
): Promise<{ payload: T; backend: string; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];

  for (const [name, run] of backends) {
    const startedAt = Date.now();
    try {
      const payload = await run();
      if (isEmpty(payload)) throw new Error("empty response");
      attempts.push({ backend: name, ok: true, durationMs: Date.now() - startedAt });
      return { payload, backend: name, attempts };
    } catch (error) {
      attempts.push({
        backend: name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    }
  }
  throw new AllBackendsFailedError(operation, attempts);
}

export interface SearchOutcome {
  readonly sources: WebSearchSource[];
  readonly backend: string;
  readonly attempts: Attempt[];
}

export interface FetchOutcome {
  readonly markdown: string;
  readonly backend: string;
  readonly attempts: Attempt[];
}

export async function searchOne(
  query: string,
  endpoints: ServerEndpoints,
  signal?: AbortSignal,
  backends: readonly BackendEntry<WebSearchSource[]>[] = defaultSearchBackends(
    query,
    endpoints,
    signal,
  ),
): Promise<SearchOutcome> {
  const { payload, backend, attempts } = await tryBackends(
    "web search",
    backends,
    (sources) => sources.length === 0,
  );
  return { sources: payload, backend, attempts };
}

export async function fetchOne(
  url: string,
  camoufoxBaseUrl: string,
  signal?: AbortSignal,
  backends: readonly BackendEntry<string>[] = defaultFetchBackends(
    url,
    camoufoxBaseUrl,
    signal,
  ),
): Promise<FetchOutcome> {
  const { payload, backend, attempts } = await tryBackends(
    "web fetch",
    backends,
    (markdown) => !markdown.trim(),
  );
  return { markdown: payload, backend, attempts };
}

// --- search backend: SERP URL -> camoufox render -> openserp parse ---

export type SearchEngine = "bing" | "duckduckgo" | "google";

const SERP_BASE_URL: Record<SearchEngine, string> = {
  bing: "https://www.bing.com/search",
  duckduckgo: "https://duckduckgo.com/",
  google: "https://www.google.com/search",
};

// SPEC §"search provider": the query goes into the `q` parameter. No language
// hint — the seam's WebSearchRequest has no lang field.
export function serpUrl(engine: SearchEngine, query: string): string {
  const base = SERP_BASE_URL[engine];
  const params = new URLSearchParams({ q: query });
  return `${base}${base.includes("?") ? "&" : "?"}${params}`;
}

// One entry of openserp's JSON response (POST /<engine>/parse?format=json)
// `results[]`. Missing fields arrive as undefined and are dropped on mapping.
export interface OpenserpSearchResult {
  rank?: number;
  type?: string;
  title?: string;
  url?: string;
  display_url?: string;
  snippet?: string;
}

// Map openserp results to seam sources: rank-ascending order, URL required
// (entries without one are unusable as citation sources and dropped), title
// and snippet omitted when blank — the seam forbids inventing them.
export function toSearchSources(results: readonly OpenserpSearchResult[]): WebSearchSource[] {
  const ranked = [...results].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const sources: WebSearchSource[] = [];
  for (const entry of ranked) {
    const url = entry.url?.trim();
    if (!url) continue;
    const title = entry.title?.trim();
    const snippet = entry.snippet?.trim();
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return sources;
}

// SPEC §"search provider": send the rendered HTML to openserp
// POST /<engine>/parse?format=json and take `results[]` back. A 15s round
// trip; CAPTCHA/challenge/empty outcomes arrive as 4xx errors and become the
// next engine's fallback material. Empty results also fail the backend.
export async function openserpParse(
  engine: SearchEngine,
  html: string,
  baseUrl: string,
  signal?: AbortSignal,
  deps: ServerDeps = {},
): Promise<OpenserpSearchResult[]> {
  const fetcher = deps.fetcher ?? fetch;
  const spawnOpenserp = deps.spawnOpenserp ?? spawnOpenserpServer;
  const waitSignal = withTimeout(signal, SERVER_WAIT_TIMEOUT_MS);

  await ensureOpenserpServer(baseUrl, waitSignal, () => spawnOpenserp(baseUrl), fetcher);

  const response = await fetcher(`${baseUrl}/${engine}/parse?format=json`, {
    method: "POST",
    headers: { "Content-Type": "text/html" },
    body: html,
    signal: withTimeout(signal, PARSE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`parse: ${await responseDetail(response)}`);
  }
  let payload: { results?: OpenserpSearchResult[] };
  try {
    payload = JSON.parse(await response.text()) as { results?: OpenserpSearchResult[] };
  } catch {
    throw new Error("parse: response is not valid JSON");
  }
  const results = payload.results ?? [];
  if (results.length === 0) throw new Error("parse: empty response");
  return results;
}

export type SearchDeps = CamoufoxServerDeps & ServerDeps;

// SPEC §"search provider": SERP URL -> camoufox render -> openserp parse ->
// rank-sorted sources. Engines are tried google -> duckduckgo -> bing by the
// backend chain above; the first engine with results wins.
export async function camoufoxOpenserpSearch(
  engine: SearchEngine,
  query: string,
  endpoints: ServerEndpoints,
  signal?: AbortSignal,
  deps: SearchDeps = {},
): Promise<WebSearchSource[]> {
  const html = await camoufoxRender(
    serpUrl(engine, query),
    CAMOUFOX_SEARCH_SESSION_KEY,
    endpoints.camoufoxBaseUrl,
    signal,
    deps,
  );
  const results = await openserpParse(
    engine,
    html,
    endpoints.openserpBaseUrl,
    signal,
    deps,
  );
  return toSearchSources(results);
}

export function defaultSearchBackends(
  query: string,
  endpoints: ServerEndpoints,
  signal?: AbortSignal,
  deps: SearchDeps = {},
): BackendEntry<WebSearchSource[]>[] {
  return (["google", "duckduckgo", "bing"] as const).map((engine) => [
    `camoufox+openserp(${engine})`,
    () => camoufoxOpenserpSearch(engine, query, endpoints, signal, deps),
  ]);
}

// --- fetch backend: camoufox render -> trafilatura ---

export type CamoufoxFetchDeps = CamoufoxServerDeps & {
  toMarkdown?: (html: string, signal?: AbortSignal) => Promise<string>;
};

// SPEC §"fetch provider": render and conversion each carry their own timeout;
// challenge pages fail at the render stage.
export async function camoufoxFetch(
  url: string,
  camoufoxBaseUrl: string,
  signal?: AbortSignal,
  deps: CamoufoxFetchDeps = {},
): Promise<string> {
  const toMarkdown =
    deps.toMarkdown ??
    ((html, convertSignal) => runWithStdin("trafilatura", ["--markdown"], html, convertSignal));
  const html = await camoufoxRender(url, CAMOUFOX_FETCH_SESSION_KEY, camoufoxBaseUrl, signal, deps);
  return toMarkdown(html, signal);
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
      { signal, timeout: CONVERT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(input);
  });
}

// SPEC §"fetch provider": Reddit posts go to the Reddit route only,
// StackOverflow questions to the StackOverflow route only, everything else to
// camoufox+trafilatura only — the URL fixes one route.
export function defaultFetchBackends(
  url: string,
  camoufoxBaseUrl: string,
  signal?: AbortSignal,
  deps: CamoufoxFetchDeps = {},
): BackendEntry<string>[] {
  if (parseRedditPostUrl(url)) {
    return [["Reddit", () => fetchRedditMarkdown(url, signal)]];
  }
  if (parseStackOverflowQuestionUrl(url)) {
    return [["StackOverflow", () => fetchStackOverflowMarkdown(url, signal)]];
  }
  return [["camoufox+trafilatura", () => camoufoxFetch(url, camoufoxBaseUrl, signal, deps)]];
}

// --- Reddit backend (post permalink -> Atom feed, embed/oEmbed fallback) ---

const REDDIT_USER_AGENT = "Mozilla/5.0 (compatible; pi-web-search/1.0)";

export interface RedditPostUrl {
  postId: string;
  permalink: string;
  rssUrl: string;
  embedUrl: string;
  oembedUrl: string;
}

export function parseRedditPostUrl(rawUrl: string): RedditPostUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "reddit.com" && !hostname.endsWith(".reddit.com")) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length < 4 ||
    parts[0]?.toLowerCase() !== "r" ||
    parts[2]?.toLowerCase() !== "comments"
  ) {
    return undefined;
  }
  const subreddit = parts[1];
  const postId = parts[3]?.toLowerCase();
  if (!subreddit || !postId || !/^[a-z0-9]+$/.test(postId)) return undefined;
  const slug = parts[4] && parts[4] !== ".rss" ? parts[4] : undefined;
  const rootPath = `/r/${subreddit}/comments/${postId}/${slug ? `${slug}/` : ""}`;
  const permalink = `https://www.reddit.com${rootPath}`;
  const oembedUrl = new URL("https://www.reddit.com/oembed");
  oembedUrl.searchParams.set("url", permalink);
  return {
    postId,
    permalink,
    rssUrl: `${permalink}.rss?limit=500&sort=top`,
    embedUrl: `https://embed.reddit.com${rootPath}?ref_source=embed&ref=share&embed=true`,
    oembedUrl: oembedUrl.toString(),
  };
}

function unescapeEntities(text: string): string {
  // Reddit feeds sometimes double-encode (&amp;amp; etc.), so loop until stable
  let previous = "";
  let current = text;
  while (current !== previous) {
    previous = current;
    current = current
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&(?:#x([0-9a-f]+)|#(\d+));/gi, (_, hex, dec) =>
        String.fromCodePoint(Number.parseInt(hex ?? dec, hex ? 16 : 10)),
      );
  }
  return current;
}

// Reddit's Atom content carries Markdown syntax (**bold**, # heading, * list)
// inside plain HTML tags (<p>, <blockquote>, <a>). Convert tags to Markdown and
// leave the existing Markdown syntax untouched.
function htmlFragmentToMarkdown(fragment: string): string {
  let text = fragment.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const quoted = htmlFragmentToMarkdown(inner).replace(/^/gm, "> ");
    return `\n\n${quoted}\n\n`;
  });
  text = text
    .replace(
      /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, label) => `[${label.trim()}](${href})`,
    )
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*>/gi, (_, src) => `![](${src})`)
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)>/gi, "*")
    .replace(/<(?:del|s|strike)\b[^>]*>/gi, "~~")
    .replace(/<\/(?:del|s|strike)>/gi, "~~")
    .replace(/<(?:code|kbd)\b[^>]*>/gi, "`")
    .replace(/<\/(?:code|kbd)>/gi, "`")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(li|p|div|h[1-6]|ul|ol|pre|tr)>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface RedditEntry {
  id: string;
  title: string;
  author?: string;
  bodyMarkdown: string;
  permalink: string;
  updated?: string;
}

export interface RedditFeed {
  post: RedditEntry;
  comments: RedditEntry[];
}

function atomText(entryXml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(entryXml);
  return match?.[1]?.trim() || undefined;
}

function cleanAuthor(name: string | undefined): string | undefined {
  return name?.replace(/^\/u\//, "u/");
}

export function parseRedditAtom(xml: string): RedditFeed | undefined {
  const entries: RedditEntry[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entryXml = match[1] ?? "";
    const id = atomText(entryXml, "id");
    if (!id || (!id.startsWith("t3_") && !id.startsWith("t1_"))) continue;
    const linkHref = /<link\b[^>]*href="([^"]*)"/.exec(entryXml)?.[1];
    entries.push({
      id,
      title: unescapeEntities(atomText(entryXml, "title") ?? "Untitled"),
      author: cleanAuthor(atomText(entryXml, "name")),
      bodyMarkdown: htmlFragmentToMarkdown(unescapeEntities(atomText(entryXml, "content") ?? "")),
      permalink: linkHref ?? "",
      updated: atomText(entryXml, "updated"),
    });
  }
  const post = entries.find((entry) => entry.id.startsWith("t3_"));
  if (!post) return undefined;
  return { post, comments: entries.filter((entry) => entry.id.startsWith("t1_")) };
}

export function parseRedditEmbed(
  html: string,
): { title?: string; displayedCommentCount?: number } | undefined {
  const title = /id="embed-title"[^>]*>([^<]+)/.exec(html)?.[1]?.trim() || undefined;
  const countText = /(\d[\d,]*)\s+comments?/i.exec(html)?.[1];
  const displayedCommentCount =
    countText === undefined ? undefined : Number.parseInt(countText.replaceAll(",", ""), 10);
  if (!title && displayedCommentCount === undefined) return undefined;
  return { title, displayedCommentCount };
}

export function parseRedditOEmbed(json: string): { title?: string } | undefined {
  try {
    const value = JSON.parse(json) as { title?: unknown };
    const title =
      typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined;
    return title ? { title } : undefined;
  } catch {
    return undefined;
  }
}

interface RedditFetchAttempt {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

async function fetchRedditText(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<RedditFetchAttempt> {
  try {
    const response = await fetcher(url, {
      signal,
      headers: {
        Accept:
          "application/atom+xml, application/xml, application/json, text/html;q=0.9, */*;q=0.1",
        "User-Agent": REDDIT_USER_AGENT,
      },
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : String(error),
      body: "",
    };
  }
}

function renderRedditMarkdown(
  url: RedditPostUrl,
  feed: RedditFeed | undefined,
  embed: { title?: string; displayedCommentCount?: number } | undefined,
  oembed: { title?: string } | undefined,
): string {
  const post = feed?.post;
  const title = post?.title ?? embed?.title ?? oembed?.title ?? `Reddit post ${url.postId}`;
  const comments = feed?.comments ?? [];
  const displayed = embed?.displayedCommentCount;
  const lines = [
    `# ${title}`,
    "",
    `- Author: ${post?.author ?? "unknown"}`,
    `- Permalink: ${post?.permalink || url.permalink}`,
  ];
  if (post?.updated) lines.push(`- Updated: ${post.updated}`);
  if (feed) {
    const count =
      displayed === undefined
        ? `${comments.length} fetched`
        : `${comments.length} fetched / ${displayed} displayed`;
    lines.push(`- Comments: ${count}`);
  } else {
    lines.push(
      `- Comments: unavailable${displayed === undefined ? "" : ` (Reddit displays ${displayed})`}`,
    );
  }
  lines.push(
    "",
    "## Post",
    "",
    post?.bodyMarkdown || "(post body unavailable from accessible Reddit endpoints)",
  );
  if (feed) {
    // RSS has no score or reply hierarchy. Use another source such as old.reddit JSON
    // if a threaded view is needed.
    lines.push(
      "",
      `## Comments (${comments.length} retrieved)`,
      "",
      "Scores and reply hierarchy are not exposed by Reddit RSS.",
      "",
    );
    for (const [index, comment] of comments.entries()) {
      lines.push(
        `### ${index + 1}. ${comment.author ?? "unknown"}`,
        "",
        comment.bodyMarkdown || "(no comment body)",
        "",
      );
    }
  }
  return lines.join("\n").trim();
}

// SPEC §"fetch provider" Reddit route: Atom feed -> embed -> oEmbed, one
// 15-second budget per request.
export async function fetchRedditMarkdown(
  rawUrl: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = parseRedditPostUrl(rawUrl);
  if (!url) throw new Error(`Not a supported Reddit post URL: ${rawUrl}`);
  const attemptSignal = (): AbortSignal => withTimeout(signal, REDDIT_TIMEOUT_MS);
  const rssAttempt = await fetchRedditText(url.rssUrl, attemptSignal(), fetcher);
  const feed = rssAttempt.ok ? parseRedditAtom(rssAttempt.body) : undefined;
  let embed: ReturnType<typeof parseRedditEmbed>;
  if (!feed) {
    const embedAttempt = await fetchRedditText(url.embedUrl, attemptSignal(), fetcher);
    embed = embedAttempt.ok ? parseRedditEmbed(embedAttempt.body) : undefined;
  }
  let oembed: ReturnType<typeof parseRedditOEmbed>;
  if (!feed && !embed) {
    const oembedAttempt = await fetchRedditText(url.oembedUrl, attemptSignal(), fetcher);
    oembed = oembedAttempt.ok ? parseRedditOEmbed(oembedAttempt.body) : undefined;
  }
  if (!feed && !embed && !oembed) {
    throw new Error(
      `Unable to fetch Reddit post ${url.postId} (RSS ${rssAttempt.status || rssAttempt.statusText})`,
    );
  }
  return renderRedditMarkdown(url, feed, embed, oembed);
}

// --- StackOverflow backend: SE API -> question feed (SPEC §"fetch provider") ---

const SE_API_BASE_URL = "https://api.stackexchange.com/2.3";
export const STACKOVERFLOW_MAX_ANSWERS = 500;

export interface StackOverflowQuestionUrl {
  questionId: string;
  permalink: string;
  feedUrl: string;
}

export function parseStackOverflowQuestionUrl(
  rawUrl: string,
): StackOverflowQuestionUrl | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "stackoverflow.com" && hostname !== "www.stackoverflow.com") return undefined;
  const questionId = /^\/questions\/(\d+)(?:\/[^/]+)?\/?$/.exec(url.pathname)?.[1];
  if (!questionId) return undefined;
  return {
    questionId,
    permalink: `https://stackoverflow.com/questions/${questionId}`,
    feedUrl: `https://stackoverflow.com/feeds/question/${questionId}`,
  };
}

interface SeApiResponse {
  items?: {
    title?: string;
    body?: string;
    score?: number;
    answer_count?: number;
    tags?: string[];
    is_accepted?: boolean;
    owner?: { display_name?: string };
  }[];
  has_more?: boolean;
  backoff?: number;
}

export interface StackOverflowQuestion {
  title: string;
  author?: string;
  score?: number;
  answerCount?: number;
  tags?: string[];
  bodyMarkdown: string;
}

export interface StackOverflowAnswer {
  author?: string;
  score?: number;
  accepted: boolean;
  bodyMarkdown: string;
}

export interface StackOverflowFeedEntry {
  title: string;
  author?: string;
  bodyMarkdown: string;
  link: string;
}

async function fetchStackExchangeApi(
  path: string,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch,
): Promise<SeApiResponse> {
  const response = await fetcher(`${SE_API_BASE_URL}${path}`, {
    signal: withTimeout(signal, STACKOVERFLOW_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => undefined)) as SeApiResponse | undefined;
  if (!response.ok || json === undefined) {
    throw new Error(`SE API ${response.status} ${response.statusText}`);
  }
  return json;
}

async function fetchStackOverflowFromApi(
  url: StackOverflowQuestionUrl,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch,
): Promise<{ question: StackOverflowQuestion; answers: StackOverflowAnswer[] }> {
  // Honor a `backoff` response by waiting that many seconds before the next
  // request (SE API etiquette).
  const request = async (path: string): Promise<SeApiResponse> => {
    const response = await fetchStackExchangeApi(path, signal, fetcher);
    if (typeof response.backoff === "number" && response.backoff > 0) {
      await delay(response.backoff * 1000, signal ?? new AbortController().signal);
    }
    return response;
  };

  const questionItem = (
    await request(`/questions/${url.questionId}?site=stackoverflow&filter=withbody`)
  ).items?.[0];
  if (!questionItem?.body) {
    throw new Error(`SE API returned no question ${url.questionId}`);
  }

  const answers: StackOverflowAnswer[] = [];
  // Page through answers vote-ordered while `has_more`, up to 500 total.
  for (let page = 1; answers.length < STACKOVERFLOW_MAX_ANSWERS; page++) {
    const answerResponse = await request(
      `/questions/${url.questionId}/answers?site=stackoverflow&filter=withbody&order=desc&sort=votes&pagesize=100&page=${page}`,
    );
    for (const item of answerResponse.items ?? []) {
      answers.push({
        author: item.owner?.display_name,
        score: typeof item.score === "number" ? item.score : undefined,
        accepted: item.is_accepted === true,
        bodyMarkdown: htmlFragmentToMarkdown(item.body ?? ""),
      });
    }
    if (!answerResponse.has_more) break;
  }

  return {
    question: {
      // SE API titles arrive HTML-escaped; decode them
      title: unescapeEntities(questionItem.title ?? `StackOverflow question ${url.questionId}`),
      author: questionItem.owner?.display_name,
      score: typeof questionItem.score === "number" ? questionItem.score : undefined,
      answerCount:
        typeof questionItem.answer_count === "number" ? questionItem.answer_count : undefined,
      tags: questionItem.tags,
      bodyMarkdown: htmlFragmentToMarkdown(questionItem.body),
    },
    answers: answers.slice(0, STACKOVERFLOW_MAX_ANSWERS),
  };
}

export function parseStackOverflowAtom(xml: string): StackOverflowFeedEntry[] {
  const entries: StackOverflowFeedEntry[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entryXml = match[1] ?? "";
    const body = atomText(entryXml, "summary") ?? atomText(entryXml, "content");
    if (!body) continue;
    entries.push({
      title: unescapeEntities(atomText(entryXml, "title") ?? "Untitled"),
      author: atomText(entryXml, "name") || undefined,
      bodyMarkdown: htmlFragmentToMarkdown(unescapeEntities(body)),
      link: /<link\b[^>]*href="([^"]*)"/.exec(entryXml)?.[1] ?? "",
    });
  }
  return entries;
}

function answerHeading(index: number, answer: StackOverflowAnswer): string {
  const parts: string[] = [];
  if (answer.accepted) parts.push("accepted");
  if (typeof answer.score === "number") parts.push(`score ${answer.score}`);
  return `### ${index + 1}. ${answer.author ?? "unknown"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function renderStackOverflowMarkdown(
  url: StackOverflowQuestionUrl,
  apiResult: { question: StackOverflowQuestion; answers: StackOverflowAnswer[] } | undefined,
  feed: StackOverflowFeedEntry[] | undefined,
): string {
  const question = apiResult?.question;
  const feedPost = feed?.[0];
  const title = question?.title ?? feedPost?.title ?? `StackOverflow question ${url.questionId}`;
  const answers: StackOverflowAnswer[] =
    apiResult?.answers ??
    (feed ?? []).slice(1).map((entry) => ({
      author: entry.author,
      score: undefined,
      accepted: false,
      bodyMarkdown: entry.bodyMarkdown,
    }));

  const lines = [
    `# ${title}`,
    "",
    `- Author: ${question?.author ?? feedPost?.author ?? "unknown"}`,
    `- Permalink: ${url.permalink}`,
  ];
  if (question) {
    lines.push(`- Score: ${question.score ?? "unknown"}`);
    lines.push(
      `- Answers: ${answers.length} retrieved${typeof question.answerCount === "number" ? ` / ${question.answerCount} total` : ""}`,
    );
    if (question.tags?.length) lines.push(`- Tags: ${question.tags.join(", ")}`);
  } else {
    // Feed route: score, accepted state, and vote order are unavailable.
    lines.push("", "Note: score, accepted and vote order are unavailable from the question feed.");
  }
  lines.push(
    "",
    "## Question",
    "",
    question?.bodyMarkdown || feedPost?.bodyMarkdown || "(question body unavailable)",
  );
  lines.push("", `## Answers (${answers.length} retrieved)`, "");
  for (const [index, answer] of answers.entries()) {
    lines.push(answerHeading(index, answer), "", answer.bodyMarkdown || "(no answer body)", "");
  }
  return lines.join("\n").trim();
}

// SPEC §"fetch provider" StackOverflow route: StackExchange API first, the
// question feed as fallback; each request gets its own 15-second budget.
export async function fetchStackOverflowMarkdown(
  rawUrl: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = parseStackOverflowQuestionUrl(rawUrl);
  if (!url) throw new Error(`Not a supported StackOverflow question URL: ${rawUrl}`);

  let apiResult: Awaited<ReturnType<typeof fetchStackOverflowFromApi>> | undefined;
  try {
    apiResult = await fetchStackOverflowFromApi(url, signal, fetcher);
  } catch {
    apiResult = undefined;
  }

  let feed: StackOverflowFeedEntry[] | undefined;
  if (!apiResult) {
    try {
      const response = await fetcher(url.feedUrl, {
        signal: withTimeout(signal, STACKOVERFLOW_TIMEOUT_MS),
        headers: { Accept: "application/atom+xml, application/xml, */*" },
      });
      if (response.ok) {
        const entries = parseStackOverflowAtom(await response.text());
        if (entries.length > 0) feed = entries;
      }
    } catch {
      feed = undefined;
    }
  }

  if (!apiResult && !feed) {
    throw new Error(`Unable to fetch StackOverflow question ${url.questionId}`);
  }
  return renderStackOverflowMarkdown(url, apiResult, feed);
}

// --- camoufox rendering ---

// SPEC §"チャレンジページ検出" (fetch §): structural signals only, no
// locale-dependent wording. Beyond the Cloudflare set, Google serves two fixed
// bot pages detected through openserp-derived structural signals:
// - CAPTCHA / sorry pages (google/selectors.go CaptchaPage; the result widget's
//   data-sitekey / recaptcha also appear on normal pages, so they are excluded)
// - soft block (google/search_raw.go isGoogleSoftBlockDocument: no result
//   block div.tF2Cxc / [data-hveid], plus the noscript JS retry link)
export const CHALLENGE_SIGNALS: readonly RegExp[] = [
  /cdn-cgi\/challenge-platform\//,
  /id="challenge-(?:running|form|stage|error-text)"/,
  /<title[^>]*>\s*Just a moment\.\.\.\s*<\/title>/i,
  /\bcf-turnstile\b/,
  /<form[^>]*\bid="captcha-form"/,
  /<form[^>]*\baction="[^"]*\/sorry\//,
  /<body[^>]*\bonload="[^"]*captcha/i,
  /^(?![\s\S]*(?:class="tF2Cxc"|data-hveid=))[\s\S]*httpservice\/retry\/enablejs/,
];

export function detectChallengePage(html: string): boolean {
  return CHALLENGE_SIGNALS.some((signal) => signal.test(html));
}

const CHALLENGE_POLL_INTERVAL_MS = 250;
const NETWORK_IDLE_WAIT_MS = 5_000;

// Wait for networkidle while polling the rendered DOM for challenge pages;
// whichever comes first ends the wait (SPEC §"fetch provider": detection makes
// the backend fail).
export function challengeWaitSnippet(): string {
  const signals = CHALLENGE_SIGNALS.map((signal) => [signal.source, signal.flags]);
  return `async page => {
  const challengeSignals = ${JSON.stringify(signals)}.map(([source, flags]) => new RegExp(source, flags));
  const grab = () => page.evaluate(() => document.documentElement.outerHTML);
  let settled = false;
  const idle = page.waitForLoadState('networkidle', { timeout: ${NETWORK_IDLE_WAIT_MS} }).catch(() => {}).then(() => { settled = true; });
  const deadline = Date.now() + ${NETWORK_IDLE_WAIT_MS};
  while (!settled && Date.now() < deadline) {
    const html = await grab();
    if (challengeSignals.some((signal) => signal.test(html))) return { mode: 'challenge', html };
    await page.waitForTimeout(${CHALLENGE_POLL_INTERVAL_MS});
  }
  await idle;
  return { mode: 'settled', html: await grab() };
}`;
}

// SPEC §"camoufox による描画": playwright-cli's stdout for `run-code` puts the
// return value as a one-line JSON literal after the "### Result" line (full
// stdout even for large pages). `mode === "challenge"` means the rendered DOM
// is a challenge page.
export function parseRenderedPage(output: string): string {
  const lines = output.split("\n");
  const resultIndex = lines.indexOf("### Result");
  const literal = resultIndex === -1 ? undefined : lines[resultIndex + 1];
  if (!literal || (!literal.startsWith('"') && !literal.startsWith("{"))) {
    throw new Error("playwright-cli run-code output has no result");
  }
  const { mode, html } = JSON.parse(literal) as { mode?: string; html?: string };
  if (mode === "challenge") throw new Error("challenge detected");
  if (typeof html !== "string" || !html) {
    throw new Error("playwright-cli run-code returned no HTML");
  }
  return html;
}

// playwright-cli picks its connect target from the config's remoteEndpoint, so
// keep the package-root config in sync with the resolved base URL.
export function playwrightCliConfigPath(packageRoot: string = PACKAGE_ROOT): string {
  return `${packageRoot}/playwright-cli.config.json`;
}

export function playwrightCliConfigJson(baseUrl: string): string {
  return `${JSON.stringify({ browser: { browserName: "firefox", remoteEndpoint: baseUrl } }, null, 2)}\n`;
}

export function syncPlaywrightCliConfig(
  packageRoot: string = PACKAGE_ROOT,
  baseUrl: string = CAMOUFOX_DEFAULT_BASE_URL,
): void {
  try {
    writeFileSync(playwrightCliConfigPath(packageRoot), playwrightCliConfigJson(baseUrl));
  } catch {
    // Keep going with the existing config when the write fails (same content
    // for the default endpoint).
  }
}

export function buildPlaywrightCliEnv(
  base: Record<string, string | undefined> = process.env,
  configPath: string = playwrightCliConfigPath(),
): Record<string, string | undefined> {
  return { ...base, PLAYWRIGHT_MCP_CONFIG: configPath };
}

export function buildPlaywrightCliArgs(sessionKey: string, args: readonly string[]): string[] {
  return [`-s=${sessionKey}`, ...args];
}

export function defaultRunPlaywrightCli(
  sessionKey: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "playwright-cli",
      buildPlaywrightCliArgs(sessionKey, args),
      {
        signal,
        maxBuffer: 64 * 1024 * 1024,
        env: buildPlaywrightCliEnv(),
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export type CamoufoxServerDeps = {
  probeServer?: (signal: AbortSignal) => Promise<boolean>;
  spawnCamoufox?: () => void;
  runCli?: (sessionKey: string, args: string[], signal: AbortSignal) => Promise<string>;
  syncConfig?: () => void;
};

// SPEC §"camoufox による描画": 30s for open, navigation, and DOM retrieval.
// The page is closed regardless of outcome; close failures do not affect the
// result. Errors carry the "render:" stage label.
export async function camoufoxRender(
  url: string,
  sessionKey: string,
  camoufoxBaseUrl: string,
  signal?: AbortSignal,
  deps: CamoufoxServerDeps = {},
): Promise<string> {
  const probe =
    deps.probeServer ??
    ((probeSignal: AbortSignal) => camoufoxServerHealthy(camoufoxBaseUrl, probeSignal));
  const spawnServer = deps.spawnCamoufox ?? (() => spawnCamoufoxServer(camoufoxBaseUrl));
  const runCli = deps.runCli ?? defaultRunPlaywrightCli;
  const syncConfig = deps.syncConfig ?? (() => syncPlaywrightCliConfig(PACKAGE_ROOT, camoufoxBaseUrl));

  const waitSignal = withTimeout(signal, SERVER_WAIT_TIMEOUT_MS);
  await ensureCamoufoxServer(camoufoxBaseUrl, probe, spawnServer, waitSignal);
  // SPEC: reflect the connect target (resolved CAMOUFOX_BASE_URL) in the
  // playwright-cli config before rendering.
  syncConfig();

  const renderSignal = withTimeout(signal, RENDER_TIMEOUT_MS);
  const renderError = (error: unknown): Error =>
    new Error(`render: ${error instanceof Error ? error.message : String(error)}`);

  const closePage = async (): Promise<void> => {
    await runCli(sessionKey, ["close"], withTimeout(signal, SERVER_WAIT_TIMEOUT_MS)).catch(
      () => {},
    );
  };

  try {
    // Each request is independent. Close a leftover session (from a previous
    // failed close) before open so cookies and page state do not carry over
    // (close failures ignored).
    await closePage();
    await runCli(sessionKey, ["open", url], renderSignal).catch((error: unknown) => {
      throw renderError(error);
    });

    // Wait for networkidle + hydration: SPA search results inject content via
    // JS after navigation. Poll for challenge pages in parallel and fail fast
    // on detection.
    const output = await runCli(sessionKey, ["run-code", challengeWaitSnippet()], renderSignal).catch(
      (error: unknown) => {
        throw renderError(error);
      },
    );
    let html: string;
    try {
      html = parseRenderedPage(output);
    } catch (error) {
      throw renderError(error);
    }
    return html;
  } finally {
    // SPEC: close the page regardless of outcome; close failures do not
    // affect the result.
    await closePage();
  }
}

// --- resident servers: health check -> detached spawn -> wait ---

// SPEC §"常駐サーバー": the camoufox server log is appended across starts at
// <XDG_CACHE_HOME:-~/.cache>/pi/web-search/camoufox-server.log (shared with the
// pi extension: both talk to the same single machine-scoped server).
export function camoufoxServerLogPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const cacheDir = env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheDir, "pi", "web-search", "camoufox-server.log");
}

// Health = a websocket connection can be established. Capped at
// WEBSOCKET_HEALTH_TIMEOUT_MS so a half-open socket cannot stall the loop.
export function camoufoxServerHealthy(baseUrl: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(baseUrl);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WEBSOCKET_HEALTH_TIMEOUT_MS);
    socket.addEventListener("open", () => finish(true));
    socket.addEventListener("error", () => finish(false));
    signal.addEventListener("abort", () => finish(false), { once: true });
  });
}

// SPEC §"常駐サーバー": launch command is `bun server.mjs` in the package root.
// The resolved base URL is passed through the child environment so server.mjs
// (which decides its listen address from CAMOUFOX_BASE_URL) always listens
// where this plugin connects, also when the URL came from plugin config.
export function buildCamoufoxServerSpawn(
  baseUrl: string,
  packageRoot: string = PACKAGE_ROOT,
): {
  command: string;
  args: string[];
  options: {
    cwd: string;
    detached: boolean;
    stdio: "ignore";
    shell: boolean;
    env: Record<string, string | undefined>;
  };
} {
  return {
    command: "bun",
    args: ["server.mjs"],
    options: {
      cwd: packageRoot,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
      env: { ...process.env, CAMOUFOX_BASE_URL: baseUrl },
    },
  };
}

export type CamoufoxSpawnDeps = {
  /** Detached-spawn override for tests; default `spawnDetachedServer`. */
  spawnServer?: typeof spawnDetachedServer;
};

export function spawnCamoufoxServer(baseUrl: string, deps: CamoufoxSpawnDeps = {}): void {
  const spawnServer = deps.spawnServer ?? spawnDetachedServer;
  const { command, args, options } = buildCamoufoxServerSpawn(baseUrl);
  try {
    const logPath = camoufoxServerLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "a");
    try {
      // The child keeps its own dup of the fd, so close ours right away.
      spawnServer(command, args, { ...options, stdio: ["ignore", logFd, logFd] });
    } finally {
      closeSync(logFd);
    }
  } catch {
    // Unwritable log path: keep the previous behavior (discard server output).
    spawnServer(command, args, options);
  }
}

// SPEC §"常駐サーバー": openserp is launched `serve` on the base URL's host and
// port.
export function buildOpenserpServerSpawn(baseUrl: string): {
  command: string;
  args: string[];
  options: { detached: boolean; stdio: "ignore"; shell: boolean };
} {
  const { hostname, port } = new URL(baseUrl);
  return {
    command: "openserp",
    args: ["serve", "-a", hostname, "-p", port, "--quiet"],
    options: { detached: true, stdio: "ignore", shell: process.platform === "win32" },
  };
}

export function spawnOpenserpServer(baseUrl: string): void {
  const { command, args, options } = buildOpenserpServerSpawn(baseUrl);
  spawnDetachedServer(command, args, options);
}

// Detached spawn: the server is machine-scoped and outlives this dsh process
// (SPEC: a spawned server stays up, so the next request can succeed; a server
// another process — e.g. pi — already started is reused as-is). Spawn errors
// (e.g. binary missing from PATH) are swallowed: without an "error" listener
// Node rethrows them as an uncaughtException that kills the host, while the
// health-check loop reports them as a backend failure instead.
export function spawnDetachedServer(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, options);
  child.on("error", () => {});
  child.unref();
  return child;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function serverRequest(
  baseUrl: string,
  path: string,
  options: { method?: string; json?: unknown },
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Response> {
  return fetcher(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.json === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
    signal,
  });
}

async function serverHealthy(
  baseUrl: string,
  path: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<boolean> {
  try {
    return (await serverRequest(baseUrl, path, {}, signal, fetcher)).ok;
  } catch {
    return false;
  }
}

// Prefer the openserp error body ("{"message": "..."}") over the bare status.
async function responseDetail(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
  return typeof body?.message === "string" && body.message
    ? body.message
    : `${response.status} ${response.statusText}`;
}

export type ServerDeps = {
  fetcher?: typeof fetch;
  spawnOpenserp?: (baseUrl: string) => void;
};

// SPEC §"常駐サーバー": probe first; spawn only when unhealthy (an existing
// server — e.g. started by pi — is reused), then poll until healthy. The
// 15-second cap comes from the caller's signal (SERVER_WAIT_TIMEOUT_MS).
async function ensureOpenserpServer(
  baseUrl: string,
  signal: AbortSignal,
  spawnServer: () => void,
  fetcher: typeof fetch,
): Promise<void> {
  if (await serverHealthy(baseUrl, "/ready", signal, fetcher)) return;
  spawnServer();
  while (!signal.aborted) {
    await delay(SERVER_HEALTH_POLL_INTERVAL_MS, signal);
    if (await serverHealthy(baseUrl, "/ready", signal, fetcher)) return;
  }
  throw new Error(`openserp server not ready at ${baseUrl}`);
}

async function ensureCamoufoxServer(
  baseUrl: string,
  probe: (signal: AbortSignal) => Promise<boolean>,
  spawnServer: () => void,
  signal: AbortSignal,
): Promise<void> {
  if (await probe(signal)) return;
  spawnServer();
  while (!signal.aborted) {
    await delay(SERVER_HEALTH_POLL_INTERVAL_MS, signal);
    if (await probe(signal)) return;
  }
  throw new Error(`camoufox server not ready at ${baseUrl}`);
}

export type PrimeServerDeps = {
  fetcher?: typeof fetch;
  spawnOpenserp?: (baseUrl: string) => void;
  probeCamoufox?: (baseUrl: string, signal: AbortSignal) => Promise<boolean>;
  spawnCamoufox?: (baseUrl: string) => void;
};

// SPEC §"常駐サーバー" apply row: probe both servers and detached-spawn the
// unhealthy ones. Fire-and-forget — priming failures never affect startup or
// later tool runs (the next request retries the spawn).
export async function primeServers(
  endpoints: ServerEndpoints,
  deps: PrimeServerDeps = {},
): Promise<void> {
  const fetcher = deps.fetcher ?? fetch;
  const spawnOpenserp = deps.spawnOpenserp ?? spawnOpenserpServer;
  const probeCamoufox =
    deps.probeCamoufox ??
    ((baseUrl: string, signal: AbortSignal) => camoufoxServerHealthy(baseUrl, signal));
  const spawnCamoufox = deps.spawnCamoufox ?? spawnCamoufoxServer;

  // Each server is independent; one side's failure must not block the other.
  try {
    if (
      !(await serverHealthy(
        endpoints.openserpBaseUrl,
        "/ready",
        AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS),
        fetcher,
      ))
    ) {
      spawnOpenserp(endpoints.openserpBaseUrl);
    }
  } catch {
    // Priming failures resolve silently.
  }
  try {
    if (!(await probeCamoufox(endpoints.camoufoxBaseUrl, AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS)))) {
      spawnCamoufox(endpoints.camoufoxBaseUrl);
    }
  } catch {
    // Priming failures resolve silently.
  }
}

// --- serialization ---

// Runs tasks one at a time in call order. Each task awaits the previous
// task's completion promise; the finally releases the next task even on
// error. One instance per capability kind, so search and fetch stay parallel
// to each other (SPEC §"同種リクエストの直列化").
export class SerialTaskQueue {
  private previousTask = Promise.resolve();

  async run<Result>(task: () => Promise<Result>): Promise<Result> {
    const taskBefore = this.previousTask;
    let completeCurrentTask!: () => void;
    this.previousTask = new Promise((resolve) => {
      completeCurrentTask = resolve;
    });

    await taskBefore;
    try {
      return await task();
    } finally {
      completeCurrentTask();
    }
  }
}
