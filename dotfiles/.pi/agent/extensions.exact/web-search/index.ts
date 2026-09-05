import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BACKEND_TIMEOUT_MS = 15_000;
export const SEARCH_RESULT_LIMIT = 10;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// openserp launches nix Chrome, which fails with a SUID-sandbox error on non-NixOS
// hosts. When this wrapper (shipped beside the extension) exists, pass it via --browser-path.
const CHROME_NOSANDBOX_WRAPPER = fileURLToPath(
  new URL("./scripts/google-chrome-nosandbox", import.meta.url),
);

async function fetchText(
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
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
    child.stdin?.end(input);
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
    const markdown = await run(
      "openserp",
      openserpArgs(engine, query, lang, existsSync(CHROME_NOSANDBOX_WRAPPER)),
      signal,
    );
    return takeFirstEntries(markdown, SEARCH_RESULT_LIMIT);
  } catch (error) {
    throw openserpError(error);
  }
}

// SPEC: openserp への引数組み立て（言語ヒント・nosandbox ラッパー指定）。
export function openserpArgs(
  engine: string,
  query: string,
  lang: string | undefined,
  hasChromeNosandboxWrapper: boolean,
): string[] {
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
  if (hasChromeNosandboxWrapper) args.push("--browser-path", CHROME_NOSANDBOX_WRAPPER);
  return args;
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
    ["openserp(bing)", () => openserp("bing", query, signal, lang)],
    ["openserp(duckduckgo)", () => openserp("duckduckgo", query, signal, lang)],
    ["openserp(google)", () => openserp("google", query, signal, lang)],
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

async function trafilaturaFetch(url: string, signal?: AbortSignal) {
  return run("trafilatura", ["--URL", url, "--markdown"], signal);
}

// --- camofox+trafilatura backend (camofox-browser REST -> rendered DOM -> trafilatura) ---

const CAMOFOX_DEFAULT_BASE_URL = "http://127.0.0.1:9377";
const CAMOFOX_USER_ID = "pi";
const CAMOFOX_SESSION_KEY = "web-fetch";
const CAMOFOX_SERVER_PACKAGE = "@askjo/camofox-browser@1.14.0";
const CAMOFOX_HEALTH_POLL_INTERVAL_MS = 250;

// SPEC: 接続先は環境変数 CAMOFOX_BASE_URL で変更できる（既定はローカルホスト）。
export function camofoxBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.CAMOFOX_BASE_URL ?? CAMOFOX_DEFAULT_BASE_URL;
}

// SPEC: 起動時に拡張が設定する環境変数。利用者の設定を優先し、他の変数は引き継ぐ。
export function camofoxServerEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...env,
    CAMOFOX_BIND_HOST: env.CAMOFOX_BIND_HOST ?? "127.0.0.1",
    CAMOFOX_CRASH_REPORT_ENABLED: env.CAMOFOX_CRASH_REPORT_ENABLED ?? "false",
  };
}

export function buildCamofoxServerSpawn(): {
  command: string;
  args: string[];
  options: {
    env: Record<string, string | undefined>;
    detached: boolean;
    stdio: "ignore";
    shell: boolean;
  };
} {
  return {
    command: "npx",
    args: [CAMOFOX_SERVER_PACKAGE],
    options: {
      env: camofoxServerEnv(),
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    },
  };
}

// Detached spawn: the server is machine-scoped and outlives this pi process
// (SPEC: 起動したサーバープロセスは残るため、次のリクエストでは成功しうる)。
export function spawnCamofoxServer(): void {
  const { command, args, options } = buildCamofoxServerSpawn();
  const child = spawn(command, args, options);
  child.unref();
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

async function camofoxRequest(
  path: string,
  options: { method?: string; json?: unknown },
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(`${camofoxBaseUrl()}${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
    signal,
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(errorBody?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function camofoxHealthy(signal: AbortSignal, fetcher: typeof fetch): Promise<boolean> {
  try {
    return (await fetcher(`${camofoxBaseUrl()}/health`, { signal })).ok;
  } catch {
    return false;
  }
}

async function ensureCamofoxServer(
  signal: AbortSignal,
  spawnServer: () => void,
  fetcher: typeof fetch,
): Promise<void> {
  if (await camofoxHealthy(signal, fetcher)) return;
  spawnServer();
  while (!signal.aborted) {
    await delay(CAMOFOX_HEALTH_POLL_INTERVAL_MS, signal);
    if (await camofoxHealthy(signal, fetcher)) return;
  }
  throw new Error(`camofox server not ready at ${camofoxBaseUrl()}`);
}

export type CamofoxDeps = {
  fetcher?: typeof fetch;
  spawnServer?: () => void;
  toMarkdown?: (html: string, signal?: AbortSignal) => Promise<string>;
};

// SPEC: camofox+trafilatura バックエンド。HTTP 操作（サーバー起動待ちを含む）と
// trafilatura 変換の各段に 15秒を適用する。タブは成否に関わらず閉じる。
export async function camofoxFetch(
  url: string,
  signal?: AbortSignal,
  deps: CamofoxDeps = {},
): Promise<string> {
  const fetcher = deps.fetcher ?? fetch;
  const spawnServer = deps.spawnServer ?? spawnCamofoxServer;
  const toMarkdown =
    deps.toMarkdown ??
    ((html, convertSignal) => runWithStdin("trafilatura", ["--markdown"], html, convertSignal));
  const httpSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  ]);

  await ensureCamofoxServer(httpSignal, spawnServer, fetcher);
  const tab = (await camofoxRequest(
    "/tabs",
    { method: "POST", json: { userId: CAMOFOX_USER_ID, sessionKey: CAMOFOX_SESSION_KEY, url } },
    httpSignal,
    fetcher,
  )) as { tabId?: string };
  if (!tab.tabId) throw new Error("camofox server returned no tabId");

  // SPEC: タブは DOM取得後・変換前に閉じる。閉鎖失敗は結果に影響させない。
  let tabClosed = false;
  const closeTab = async (): Promise<void> => {
    tabClosed = true;
    await camofoxRequest(
      `/tabs/${encodeURIComponent(tab.tabId)}?userId=${encodeURIComponent(CAMOFOX_USER_ID)}`,
      { method: "DELETE" },
      AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(BACKEND_TIMEOUT_MS)]),
      fetcher,
    ).catch(() => {});
  };

  try {
    const evaluated = (await camofoxRequest(
      `/tabs/${encodeURIComponent(tab.tabId)}/evaluate`,
      {
        method: "POST",
        json: { userId: CAMOFOX_USER_ID, expression: "document.documentElement.outerHTML" },
      },
      httpSignal,
      fetcher,
    )) as { result?: unknown };
    if (typeof evaluated.result !== "string" || !evaluated.result) {
      throw new Error("evaluate returned no HTML");
    }
    await closeTab();
    return await toMarkdown(evaluated.result, signal);
  } finally {
    if (!tabClosed) await closeTab();
  }
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
  // Reddit のフィードは二重エンコード（&amp;amp; 等）のことがあるため安定するまで繰り返す
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

export async function fetchRedditMarkdown(
  rawUrl: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const url = parseRedditPostUrl(rawUrl);
  if (!url) throw new Error(`Not a supported Reddit post URL: ${rawUrl}`);
  const attemptSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  ]);
  const rssAttempt = await fetchRedditText(url.rssUrl, attemptSignal, fetcher);
  const feed = rssAttempt.ok ? parseRedditAtom(rssAttempt.body) : undefined;
  let embed: ReturnType<typeof parseRedditEmbed>;
  if (!feed) {
    const embedAttempt = await fetchRedditText(url.embedUrl, attemptSignal, fetcher);
    embed = embedAttempt.ok ? parseRedditEmbed(embedAttempt.body) : undefined;
  }
  let oembed: ReturnType<typeof parseRedditOEmbed>;
  if (!feed && !embed) {
    const oembedAttempt = await fetchRedditText(url.oembedUrl, attemptSignal, fetcher);
    oembed = oembedAttempt.ok ? parseRedditOEmbed(oembedAttempt.body) : undefined;
  }
  if (!feed && !embed && !oembed) {
    throw new Error(
      `Unable to fetch Reddit post ${url.postId} (RSS ${rssAttempt.status || rssAttempt.statusText})`,
    );
  }
  return renderRedditMarkdown(url, feed, embed, oembed);
}

export function defaultFetchBackends(url: string, signal?: AbortSignal): BackendEntry[] {
  if (parseRedditPostUrl(url)) {
    return [["Reddit", () => fetchRedditMarkdown(url, signal)]];
  }
  return [
    ["trafilatura", () => trafilaturaFetch(url, signal)],
    ["camofox+trafilatura", () => camofoxFetch(url, signal)],
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

export type WebToolOperations = {
  search: typeof searchOne;
  fetch: typeof fetchOne;
};

const defaultWebToolOperations: WebToolOperations = {
  search: searchOne,
  fetch: fetchOne,
};

class SerialTaskQueue {
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

const H1_TITLE = /^# (.+)$/m;
const NUMBERED_HEADING_TITLE = /^#{2,3} \d+\. (.+)$/m;

// SPEC: web_fetch のタイトルは取得済み本文（Markdown）の見出しからのみ取り出す。
// h1 に加えて `## <数字>. <タイトル>` / `### <数字>. <タイトル>` もタイトルとして扱う。
export function titleFromMarkdown(markdown: string): string | null {
  const match = H1_TITLE.exec(markdown) ?? NUMBERED_HEADING_TITLE.exec(markdown);
  return match?.[1]?.trim() || null;
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

export default function (
  pi: ExtensionAPI,
  operations: WebToolOperations = defaultWebToolOperations,
) {
  const searchQueue = new SerialTaskQueue();
  const fetchQueue = new SerialTaskQueue();

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with a single query.",
    parameters: searchParameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        const { text, backend, attempts } = await searchQueue.run(() =>
          operations.search(params.query, signal, undefined, params.lang),
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
        return await fetchQueue.run(async () => {
          const { text, backend, attempts } = await operations.fetch(params.url, signal);
          // SPEC: タイトルは取得済み本文（Markdown）の見出しからのみ取り出す
          const title = titleFromMarkdown(text);
          return { content: [{ type: "text", text }], details: { backend, attempts, title } };
        });
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
