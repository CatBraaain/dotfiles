import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";

export const SEARCH_RESULT_LIMIT = 10;

// SPEC: 段階ごとの最大待ち時間（§タイムアウト）。
export const SERVER_WAIT_TIMEOUT_MS = 15_000;
export const RENDER_TIMEOUT_MS = 30_000;
export const PARSE_TIMEOUT_MS = 15_000;
export const CONVERT_TIMEOUT_MS = 15_000;
export const REDDIT_TIMEOUT_MS = 15_000;

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

// --- camofox-browser server (rendering) ---

const CAMOFOX_DEFAULT_BASE_URL = "http://127.0.0.1:9377";
const CAMOFOX_USER_ID = "pi";
const CAMOFOX_FETCH_SESSION_KEY = "web-fetch";
const CAMOFOX_SEARCH_SESSION_KEY = "web-search";
const CAMOFOX_SERVER_PACKAGE = "@askjo/camofox-browser@1.14.0";
const SERVER_HEALTH_POLL_INTERVAL_MS = 250;

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

// --- openserp server (SERP parsing) ---

const OPENSERP_DEFAULT_BASE_URL = "http://127.0.0.1:7000";

// SPEC: 接続先と起動アドレス・ポートは環境変数 OPENSERP_BASE_URL で変更できる。
export function openserpBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.OPENSERP_BASE_URL ?? OPENSERP_DEFAULT_BASE_URL;
}

export function buildOpenserpServerSpawn(): {
  command: string;
  args: string[];
  options: { detached: boolean; stdio: "ignore"; shell: boolean };
} {
  const { hostname, port } = new URL(openserpBaseUrl());
  return {
    command: "openserp",
    args: ["serve", "-a", hostname, "-p", port, "--quiet"],
    options: { detached: true, stdio: "ignore", shell: process.platform === "win32" },
  };
}

export function spawnOpenserpServer(): void {
  const { command, args, options } = buildOpenserpServerSpawn();
  const child = spawn(command, args, options);
  child.unref();
}

// --- shared server bootstrap (health check -> background spawn -> wait) ---

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

// Prefer the camofox error body ("{"error": "..."}") over the bare status.
async function responseDetail(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return typeof body?.error === "string" && body.error
    ? body.error
    : `${response.status} ${response.statusText}`;
}

async function ensureServer(
  baseUrl: string,
  healthPath: string,
  serverName: string,
  signal: AbortSignal,
  spawnServer: () => void,
  fetcher: typeof fetch,
): Promise<void> {
  if (await serverHealthy(baseUrl, healthPath, signal, fetcher)) return;
  spawnServer();
  while (!signal.aborted) {
    await delay(SERVER_HEALTH_POLL_INTERVAL_MS, signal);
    if (await serverHealthy(baseUrl, healthPath, signal, fetcher)) return;
  }
  throw new Error(`${serverName} server not ready at ${baseUrl}`);
}

export type ServerDeps = {
  fetcher?: typeof fetch;
  spawnCamofox?: () => void;
  spawnOpenserp?: () => void;
};

// SPEC: §camofox による描画。タブ生成・ナビゲーション・描画済み DOM の取得に
// 30秒を適用する。タブは成否に関わらず閉じ、閉鎖失敗は結果に影響させない。
// エラーには "render:" 段階ラベルを付ける（§表示 のエラー例）。
export async function camofoxRender(
  url: string,
  sessionKey: string,
  signal?: AbortSignal,
  deps: ServerDeps = {},
): Promise<string> {
  const fetcher = deps.fetcher ?? fetch;
  const spawnServer = deps.spawnCamofox ?? spawnCamofoxServer;
  const waitSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS),
  ]);

  await ensureServer(camofoxBaseUrl(), "/health", "camofox", waitSignal, spawnServer, fetcher);

  const renderSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(RENDER_TIMEOUT_MS),
  ]);
  const renderError = (error: unknown): Error =>
    new Error(`render: ${error instanceof Error ? error.message : String(error)}`);

  const tabResponse = await serverRequest(
    camofoxBaseUrl(),
    "/tabs",
    {
      method: "POST",
      json: { userId: CAMOFOX_USER_ID, sessionKey, url },
    },
    renderSignal,
    fetcher,
  ).catch(renderError);
  if (tabResponse instanceof Error) throw tabResponse;
  if (!tabResponse.ok) throw renderError(await responseDetail(tabResponse));
  const tab = (await tabResponse.json().catch(() => undefined)) as { tabId?: string } | undefined;
  if (!tab?.tabId) throw renderError("camofox server returned no tabId");

  let tabClosed = false;
  const closeTab = async (): Promise<void> => {
    tabClosed = true;
    await fetcher(
      `${camofoxBaseUrl()}/tabs/${encodeURIComponent(tab.tabId!)}?userId=${encodeURIComponent(CAMOFOX_USER_ID)}`,
      {
        method: "DELETE",
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS),
        ]),
      },
    ).catch(() => {});
  };

  try {
    // SPEC: networkidle とハイドレーションの完了を待つ。SPA の検索結果など
    // JS で後から差し込まれるコンテンツは、ナビゲーション直後の DOM に無い。
    // 待ち失敗（ready: false）は続行する。
    const waitResponse = await serverRequest(
      camofoxBaseUrl(),
      `/tabs/${encodeURIComponent(tab.tabId)}/wait`,
      { method: "POST", json: { userId: CAMOFOX_USER_ID, waitForNetwork: true } },
      renderSignal,
      fetcher,
    ).catch(renderError);
    if (waitResponse instanceof Error) throw waitResponse;
    if (!waitResponse.ok) throw renderError(await responseDetail(waitResponse));

    const evaluatedResponse = await serverRequest(
      camofoxBaseUrl(),
      `/tabs/${encodeURIComponent(tab.tabId)}/evaluate`,
      {
        method: "POST",
        json: {
          userId: CAMOFOX_USER_ID,
          expression: "document.documentElement.outerHTML",
        },
      },
      renderSignal,
      fetcher,
    ).catch(renderError);
    if (evaluatedResponse instanceof Error) throw evaluatedResponse;
    if (!evaluatedResponse.ok) throw renderError(await responseDetail(evaluatedResponse));
    const evaluated = (await evaluatedResponse.json().catch(() => undefined)) as
      | {
          result?: unknown;
        }
      | undefined;
    if (typeof evaluated?.result !== "string" || !evaluated.result) {
      throw renderError("evaluate returned no HTML");
    }
    await closeTab();
    return evaluated.result;
  } finally {
    if (!tabClosed) await closeTab();
  }
}

// --- search backend: SERP URL -> camofox render -> openserp parse ---

export type SearchEngine = "bing" | "duckduckgo" | "google";

// Locale parameter values follow openserp's engine URL builders
// (bing/url.go mkt, duckduckgo/url.go kl, google/url.go hl+gl).
const BING_MARKET_BY_LANGUAGE: Record<string, string> = {
  en: "en-US",
  de: "de-DE",
  ru: "ru-RU",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
  pt: "pt-BR",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  nl: "nl-NL",
  pl: "pl-PL",
  tr: "tr-TR",
  ar: "ar-SA",
};

const DUCKDUCKGO_KL_BY_LANGUAGE: Record<string, string> = {
  en: "us-en",
  de: "de-de",
  fr: "fr-fr",
  es: "es-es",
  it: "it-it",
  nl: "nl-nl",
  pt: "pt-pt",
  ru: "ru-ru",
  pl: "pl-pl",
  cs: "cz-cs",
  sk: "sk-sk",
  hu: "hu-hu",
  ro: "ro-ro",
  da: "dk-da",
  sv: "se-sv",
  no: "no-no",
  fi: "fi-fi",
  tr: "tr-tr",
  el: "gr-el",
  he: "il-he",
  ar: "xa-ar",
  zh: "cn-zh",
  ja: "jp-ja",
  ko: "kr-ko",
};

const GOOGLE_COUNTRY_BY_LANGUAGE: Record<string, string> = {
  en: "us",
  pt: "br",
  zh: "cn",
  ja: "jp",
  ko: "kr",
};

const SERP_BASE_URL: Record<SearchEngine, string> = {
  bing: "https://www.bing.com/search",
  duckduckgo: "https://duckduckgo.com/",
  google: "https://www.google.com/search",
};

// SPEC: §camofox+openserp バックエンド。クエリを URL エンコードし、lang 指定時は
// 各エンジンの言語パラメータへ反映する（値のない lang は指定なしとして扱う）。
export function serpUrl(engine: SearchEngine, query: string, lang?: string): string {
  const params = new URLSearchParams({ q: query });
  const language = lang?.toLowerCase();
  if (language) {
    if (engine === "bing") {
      const market = BING_MARKET_BY_LANGUAGE[language];
      if (market) params.set("mkt", market);
    } else if (engine === "duckduckgo") {
      const kl = DUCKDUCKGO_KL_BY_LANGUAGE[language];
      if (kl) params.set("kl", kl);
    } else {
      params.set("hl", language);
      const gl = GOOGLE_COUNTRY_BY_LANGUAGE[language];
      if (gl) params.set("gl", gl);
    }
  }
  const base = SERP_BASE_URL[engine];
  return `${base}${base.includes("?") ? "&" : "?"}${params}`;
}

// SPEC: HTML を openserp の POST /<engine>/parse?format=markdown へ送る。
// パース要求の往復には 15秒、CAPTCHA・チャレンジ・空結果は 4xx エラーとして
// 次のエンジンへのフォールバック材料になる。エラーには "parse:" を付ける。
export async function openserpParse(
  engine: SearchEngine,
  html: string,
  signal?: AbortSignal,
  deps: ServerDeps = {},
): Promise<string> {
  const fetcher = deps.fetcher ?? fetch;
  const spawnServer = deps.spawnOpenserp ?? spawnOpenserpServer;
  const waitSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS),
  ]);

  await ensureServer(openserpBaseUrl(), "/ready", "openserp", waitSignal, spawnServer, fetcher);

  const parseSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(PARSE_TIMEOUT_MS),
  ]);
  const response = await fetcher(`${openserpBaseUrl()}/${engine}/parse?format=markdown`, {
    method: "POST",
    headers: { "Content-Type": "text/html" },
    body: html,
    signal: parseSignal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | {
          message?: unknown;
        }
      | undefined;
    const detail =
      typeof body?.message === "string" && body.message
        ? body.message
        : `${response.status} ${response.statusText}`;
    throw new Error(`parse: ${detail}`);
  }
  const markdown = await response.text();
  if (!markdown.trim()) throw new Error("parse: empty response");
  return markdown;
}

// SPEC: §camofox+openserp バックエンド。SERP URL 構築 → camofox 描画 → openserp
// パース → 先頭から最大10件（### <数字>. 見出し単位）。
export async function camofoxOpenserpSearch(
  engine: SearchEngine,
  query: string,
  signal?: AbortSignal,
  lang?: string,
  deps: ServerDeps = {},
): Promise<string> {
  const html = await camofoxRender(
    serpUrl(engine, query, lang),
    CAMOFOX_SEARCH_SESSION_KEY,
    signal,
    deps,
  );
  const markdown = await openserpParse(engine, html, signal, deps);
  return takeFirstEntries(markdown, SEARCH_RESULT_LIMIT);
}

// --- fetch backend: camofox render -> trafilatura ---

// SPEC: §チャレンジページ検出。構造シグナルで判定し、ロケール依存の文言は使わない。
export function detectChallengePage(html: string): boolean {
  if (/cdn-cgi\/challenge-platform\//.test(html)) return true;
  if (/id="challenge-(?:running|form|stage|error-text)"/.test(html)) return true;
  if (/<title[^>]*>\s*Just a moment\.\.\.\s*<\/title>/i.test(html)) return true;
  return /\bcf-turnstile\b/.test(html);
}

export type CamofoxDeps = ServerDeps & {
  toMarkdown?: (html: string, signal?: AbortSignal) => Promise<string>;
};

// SPEC: §camofox+trafilatura バックエンド。描画と trafilatura 変換の各段に
// それぞれのタイムアウトを適用する。
export async function camofoxFetch(
  url: string,
  signal?: AbortSignal,
  deps: CamofoxDeps = {},
): Promise<string> {
  const toMarkdown =
    deps.toMarkdown ??
    ((html, convertSignal) => runWithStdin("trafilatura", ["--markdown"], html, convertSignal));
  const html = await camofoxRender(url, CAMOFOX_FETCH_SESSION_KEY, signal, deps);
  // SPEC: §チャレンジページ検出。変換前に描画済み HTML を判定する。
  if (detectChallengePage(html)) throw new Error("challenge detected");
  return toMarkdown(html, signal);
}

// --- backend chain shared by both tools ---

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
  deps: ServerDeps = {},
): BackendEntry[] {
  return (["google", "duckduckgo", "bing"] as const).map((engine) => [
    `camofox+openserp(${engine})`,
    () => camofoxOpenserpSearch(engine, query, signal, lang, deps),
  ]);
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
      // SPEC: 空（空白・改行のみを含む）の本文も失敗として扱う
      if (!text.trim()) throw new Error("empty response");
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
    AbortSignal.timeout(REDDIT_TIMEOUT_MS),
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

// SPEC: §web_fetch のバックエンド。Reddit 投稿パーマリンクは Reddit のみ、
// その他は camofox+trafilatura のみ。
export function defaultFetchBackends(
  url: string,
  signal?: AbortSignal,
  deps: CamofoxDeps = {},
): BackendEntry[] {
  if (parseRedditPostUrl(url)) {
    return [["Reddit", () => fetchRedditMarkdown(url, signal)]];
  }
  return [["camofox+trafilatura", () => camofoxFetch(url, signal, deps)]];
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
      // SPEC: 空（空白・改行のみを含む）の本文も失敗として扱う
      if (!text.trim()) throw new Error("empty response");
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
      description: "Language hint reflected in the search engine locale (e.g. EN, DE, JA).",
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
