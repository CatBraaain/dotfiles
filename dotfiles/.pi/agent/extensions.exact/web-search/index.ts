import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type ChildProcess, type SpawnOptions, execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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



// --- camoufox server (rendering) ---

const CAMOUFOX_DEFAULT_BASE_URL = "ws://127.0.0.1:9378/camoufox";
const CAMOUFOX_SEARCH_SESSION_KEY = "web-search";
const CAMOUFOX_FETCH_SESSION_KEY = "web-fetch";
const SERVER_HEALTH_POLL_INTERVAL_MS = 250;
const WEBSOCKET_HEALTH_TIMEOUT_MS = 1_000;

// Directory of this extension: server.mjs and playwright-cli.config.json live here.
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

// SPEC: 接続先は環境変数 CAMOUFOX_BASE_URL で変更できる（既定はローカルホストの websocket）。
export function camoufoxBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.CAMOUFOX_BASE_URL ?? CAMOUFOX_DEFAULT_BASE_URL;
}

// SPEC: camoufox server のヘルスチェックは websocket 接続が成功するかで判定する。
// A connection attempt is capped at WEBSOCKET_HEALTH_TIMEOUT_MS so a half-open
// socket cannot stall the launch loop.
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

// SPEC: 起動コマンドは `bun server.mjs`（拡張ディレクトリ内）。
export function buildCamoufoxServerSpawn(
  extensionDir: string = EXTENSION_DIR,
): {
  command: string;
  args: string[];
  options: { cwd: string; detached: boolean; stdio: "ignore"; shell: boolean };
} {
  return {
    command: "bun",
    args: ["server.mjs"],
    options: {
      cwd: extensionDir,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    },
  };
}

// SPEC: server のログは ~/.cache/pi/web-search/camoufox-server.log へ追記する。
// spawn が detached だと server.mjs の出力を観測する手段がログしかなく、ハング
// 調査には過去の出力が必須のため。
export function camoufoxServerLogPath(env: Record<string, string | undefined> = process.env): string {
  const cacheDir = env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheDir, "pi", "web-search", "camoufox-server.log");
}

export function spawnCamoufoxServer(): void {
  const { command, args, options } = buildCamoufoxServerSpawn();
  try {
    const logPath = camoufoxServerLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "a");
    try {
      // The child keeps its own dup of the fd, so close ours right away.
      spawnDetachedServer(command, args, { ...options, stdio: ["ignore", logFd, logFd] });
    } finally {
      closeSync(logFd);
    }
  } catch {
    // Unwritable log path: keep the previous behavior (discard server output).
    spawnDetachedServer(command, args, options);
  }
}

// SPEC: §camoufox による描画。server に接続した playwright-cli セッションで
// 描画するため、CLI には拡張ディレクトリ内の config（remoteEndpoint 指定）を渡す。
export function playwrightCliConfigPath(extensionDir: string = EXTENSION_DIR): string {
  return `${extensionDir}/playwright-cli.config.json`;
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

// SPEC: §camoufox による描画。`playwright-cli run-code` の stdout は "### Result" 行に
// 続いて戻り値の JSON 文字列リテラルが 1 行で出る（大きなページでも stdout 全量）。
// challenge モードは描画済み DOM がチャレンジページであることを示す。
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
  spawnDetachedServer(command, args, options);
}

// --- shared server bootstrap (health check -> background spawn -> wait) ---

// Detached spawn: the server is machine-scoped and outlives this pi process
// (SPEC: 起動したサーバープロセスは残るため、次のリクエストでは成功しうる)。
// Swallow spawn errors (e.g. binary missing from PATH): without an "error"
// listener Node rethrows them as an uncaughtException that kills pi, while
// the health-check loop should report them as a backend failure instead
// (SPEC: 起動コマンドの実行に失敗した場合もバックエンドの失敗として扱う)。
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

async function ensureOpenserpServer(
  signal: AbortSignal,
  spawnServer: () => void,
  fetcher: typeof fetch,
): Promise<void> {
  const baseUrl = openserpBaseUrl();
  if (await serverHealthy(baseUrl, "/ready", signal, fetcher)) return;
  spawnServer();
  while (!signal.aborted) {
    await delay(SERVER_HEALTH_POLL_INTERVAL_MS, signal);
    if (await serverHealthy(baseUrl, "/ready", signal, fetcher)) return;
  }
  throw new Error(`openserp server not ready at ${baseUrl}`);
}

async function ensureCamoufoxServer(
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
  throw new Error(`camoufox server not ready at ${camoufoxBaseUrl()}`);
}

// セッション開始時の先行起動で、ヘルスチェック1回ごとにかけるタイムアウト。
// 応答しないサーバーがあると spawn の投入が後ろへずれるため短く抑える。
const SERVER_PROBE_TIMEOUT_MS = 1_000;

export type PrimeServerDeps = {
  fetcher?: typeof fetch;
  spawnOpenserp?: () => void;
  probeCamoufox?: (signal: AbortSignal) => Promise<boolean>;
  spawnCamoufox?: () => void;
};

// SPEC: §常駐サーバー §セッション開始時の先行起動。セッション開始のたびに
// 各サーバーのヘルスチェックを行い、成功しないサーバーをバックグラウンドで
// 起動する。起動の完了は待たないため、先行起動で何が起きても解決する
//（先行起動の成否は後続のツール実行に影響させない）。
export async function primeServers(deps: PrimeServerDeps = {}): Promise<void> {
  const fetcher = deps.fetcher ?? fetch;
  const spawnOpenserp = deps.spawnOpenserp ?? spawnOpenserpServer;
  const probeCamoufox =
    deps.probeCamoufox ??
    ((signal: AbortSignal) => camoufoxServerHealthy(camoufoxBaseUrl(), signal));
  const spawnCamoufox = deps.spawnCamoufox ?? spawnCamoufoxServer;

  // 各サーバーは独立に扱い、一方の失敗は他方の先行起動を妨げない。
  try {
    if (
      !(await serverHealthy(
        openserpBaseUrl(),
        "/ready",
        AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS),
        fetcher,
      ))
    ) {
      spawnOpenserp();
    }
  } catch {
    // 先行起動の失敗は pi の起動・ツール実行のいずれにも影響しない。
  }
  try {
    if (!(await probeCamoufox(AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS)))) {
      spawnCamoufox();
    }
  } catch {
    // 先行起動の失敗は pi の起動・ツール実行のいずれにも影響しない。
  }
}

export type ServerDeps = {
  fetcher?: typeof fetch;
  spawnOpenserp?: () => void;
};

// camoufox server 側の注入可能な依存。openserp とは別系統のため
//（websocket ヘルスチェック + playwright-cli 実行）、ServerDeps とは分離する。
export type CamoufoxServerDeps = {
  probeServer?: (signal: AbortSignal) => Promise<boolean>;
  spawnCamoufox?: () => void;
  runCli?: (sessionKey: string, args: string[], signal: AbortSignal) => Promise<string>;
  syncConfig?: () => void;
};

// SPEC: §チャレンジページ検出。構造シグナルで判定し、ロケール依存の文言は使わない。
// Cloudflare 分に加え、Google がボット要求に代わりに返す固定ページ2種を
// openserp の判定に対応する構造シグナルで検知する:
// - CAPTCHA / sorry 固定ページ（google/selectors.go CaptchaPage より。result widget
//   の data-sitekey・recaptcha は通常ページにも現れるためシグナルにしない）
// - soft block（google/search_raw.go isGoogleSoftBlockDocument。結果ブロック
//   div.tF2Cxc・[data-hveid] を含まず、noscript の JS リトライリンクを含む）
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

// SPEC: §camoufox による描画。networkidle の待ちと並行して描画済み DOM を
// ポーリングし、チャレンジページ（§チャレンジページ検出）が見つかった時点で
// 早い方で待ちを切り上げる。networkidle が永遠に来ないページがあるため、
// 待ち自体にタイムアウトを設けて失敗を握りつぶす（待ち失敗は続行）。
const CHALLENGE_POLL_INTERVAL_MS = 250;
const NETWORK_IDLE_WAIT_MS = 5_000;

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

// SPEC: §camoufox による描画。playwright-cli は config の remoteEndpoint で接続先を
// 決めるため、CAMOUFOX_BASE_URL に合わせて拡張ディレクトリ内の config を最新化する。
export function playwrightCliConfigJson(baseUrl: string): string {
  return `${JSON.stringify({ browser: { browserName: "firefox", remoteEndpoint: baseUrl } }, null, 2)}\n`;
}

export function syncPlaywrightCliConfig(
  extensionDir: string = EXTENSION_DIR,
  baseUrl: string = camoufoxBaseUrl(),
): void {
  try {
    writeFileSync(playwrightCliConfigPath(extensionDir), playwrightCliConfigJson(baseUrl));
  } catch {
    // SPEC: 反映に失敗しても既存 config で続行する（既定の接続先なら同一内容）。
  }
}

// SPEC: §camoufox による描画。open・ナビゲーション・描画済み DOM の取得に
// 30秒を適用する。ページは成否に関わらず閉じ、閉鎖失敗は結果に影響させない。
// エラーには "render:" 段階ラベルを付ける（§表示 のエラー例）。
export async function camoufoxRender(
  url: string,
  sessionKey: string,
  signal?: AbortSignal,
  deps: CamoufoxServerDeps = {},
): Promise<string> {
  const probe =
    deps.probeServer ??
    ((probeSignal: AbortSignal) => camoufoxServerHealthy(camoufoxBaseUrl(), probeSignal));
  const spawnServer = deps.spawnCamoufox ?? spawnCamoufoxServer;
  const runCli = deps.runCli ?? defaultRunPlaywrightCli;
  const syncConfig = deps.syncConfig ?? syncPlaywrightCliConfig;

  const waitSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS),
  ]);
  await ensureCamoufoxServer(probe, spawnServer, waitSignal);
  // SPEC: 接続先（CAMOUFOX_BASE_URL）を playwright-cli の config に反映する。
  syncConfig();

  const renderSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(RENDER_TIMEOUT_MS),
  ]);
  const renderError = (error: unknown): Error =>
    new Error(`render: ${error instanceof Error ? error.message : String(error)}`);

  const closePage = async (): Promise<void> => {
    await runCli(
      sessionKey,
      ["close"],
      AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(SERVER_WAIT_TIMEOUT_MS),
      ]),
    ).catch(() => {});
  };

  try {
    // 各リクエストは独立。前回の閉鎖失敗で残ったセッションが cookie やページ状態を
    // 持ち越さないよう、open の前に残存セッションを閉じておく（失敗は無視）。
    await closePage();
    await runCli(sessionKey, ["open", url], renderSignal).catch((error: unknown) => {
      throw renderError(error);
    });

    // SPEC: networkidle とハイドレーションの完了を待つ。SPA の検索結果など
    // JS で後から差し込まれるコンテンツは、ナビゲーション直後の DOM に無い。
    // 待ちと並行してチャレンジページを判定し、検出時は待ちを切り上げて失敗にする。
    const output = await runCli(
      sessionKey,
      ["run-code", challengeWaitSnippet()],
      renderSignal,
    ).catch((error: unknown) => {
      throw renderError(error);
    });
    let html: string;
    try {
      html = parseRenderedPage(output);
    } catch (error) {
      throw renderError(error);
    }
    return html;
  } finally {
    // SPEC: ページを閉じる（成否に関わらず。閉鎖失敗は結果に影響させない）。
    await closePage();
  }
}

// --- search backend: SERP URL -> camoufox render -> openserp parse ---

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

// SPEC: §camoufox+openserp バックエンド。クエリを URL エンコードし、lang 指定時は
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

// openserp の JSON 応答（POST /<engine>/parse?format=json）の results[] 1件分。
// 存在しないフィールドは undefined で受け、生成時に省略する。
export interface OpenserpSearchResult {
  rank?: number;
  type?: string;
  title?: string;
  url?: string;
  display_url?: string;
  snippet?: string;
}

// SPEC: openserp の results[]（rank 順にソート）から検索結果エントリの
// Markdown を生成し、先頭 limit 件までを返す。エントリは
// `### <番号>. <タイトル>`、`**<表示URL>** - <type>`、スニペット、`-> <URL>` の
// 順のブロックで、欠損フィールドは省略する。openserp の応答テキストには
// 依存しない（構造化データから生成する）。
export function formatOpenserpResults(
  results: readonly OpenserpSearchResult[],
  limit: number = SEARCH_RESULT_LIMIT,
): string {
  const ranked = [...results].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return ranked
    .slice(0, limit)
    .map((entry, index) => {
      const title = entry.title?.trim() || entry.url?.trim() || "(no title)";
      const source = entry.display_url?.trim();
      const type = entry.type?.trim() || "organic";
      const url = entry.url?.trim();
      return [
        `### ${index + 1}. ${title}`,
        source ? `**${source}** - ${type}` : undefined,
        entry.snippet?.trim() || undefined,
        url ? `-> ${url}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
}

// SPEC: HTML を openserp の POST /<engine>/parse?format=json へ送り、
// 応答を JSON として受け取って results[] から検索結果エントリの Markdown を
// 生成する（openserp が付けるテキスト表現には依存しない）。
// パース要求の往復には 15秒、CAPTCHA・チャレンジ・空結果は 4xx エラーとして
// 次のエンジンへのフォールバック材料になる。エラーには "parse:" を付ける。
// results が空（検索結果ゼロ）の場合も空応答として失敗にする。
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

  await ensureOpenserpServer(waitSignal, spawnServer, fetcher);

  const parseSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(PARSE_TIMEOUT_MS),
  ]);
  const response = await fetcher(`${openserpBaseUrl()}/${engine}/parse?format=json`, {
    method: "POST",
    headers: { "Content-Type": "text/html" },
    body: html,
    signal: parseSignal,
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
  const markdown = formatOpenserpResults(payload.results ?? []);
  if (!markdown.trim()) throw new Error("parse: empty response");
  return markdown;
}

export type SearchDeps = CamoufoxServerDeps & ServerDeps;

// SPEC: §camoufox+openserp バックエンド。SERP URL 構築 → camoufox 描画 → openserp
// パース（最大10件のエントリ生成）→ 先頭に実測値のメタデータ行を付けて返す。
// メタデータ行は `**Query:** "<クエリ>" - **Engines:** <engine> - **Took:** <実測秒>` で、
// 値はすべて拡張が持つもの（引数とこの試行の所要時間）から生成する。
export async function camoufoxOpenserpSearch(
  engine: SearchEngine,
  query: string,
  signal?: AbortSignal,
  lang?: string,
  deps: SearchDeps = {},
): Promise<string> {
  const startedAt = Date.now();
  const html = await camoufoxRender(
    serpUrl(engine, query, lang),
    CAMOUFOX_SEARCH_SESSION_KEY,
    signal,
    deps,
  );
  const markdown = await openserpParse(engine, html, signal, deps);
  const tookSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  return `**Query:** ${JSON.stringify(query)} - **Engines:** ${engine} - **Took:** ${tookSeconds}s\n\n${markdown}`;
}

// --- fetch backend: camoufox render -> trafilatura ---

export type CamoufoxFetchDeps = CamoufoxServerDeps & {
  toMarkdown?: (html: string, signal?: AbortSignal) => Promise<string>;
};

// SPEC: §camoufox+trafilatura バックエンド。描画と trafilatura 変換の各段に
// それぞれのタイムアウトを適用する。
export async function camoufoxFetch(
  url: string,
  signal?: AbortSignal,
  deps: CamoufoxFetchDeps = {},
): Promise<string> {
  const toMarkdown =
    deps.toMarkdown ??
    ((html, convertSignal) => runWithStdin("trafilatura", ["--markdown"], html, convertSignal));
  // SPEC: §チャレンジページ検出。チャレンジページは描画段階で失敗になる。
  const html = await camoufoxRender(url, CAMOUFOX_FETCH_SESSION_KEY, signal, deps);
  return toMarkdown(html, signal);
}

// --- backend chain shared by both tools ---

export type Attempt =
  | { readonly backend: string; readonly ok: true; readonly durationMs?: number }
  | {
      readonly backend: string;
      readonly ok: false;
      readonly error: string;
      readonly durationMs?: number;
    };

class AllBackendsFailedError extends Error {
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

export type BackendEntry = readonly [name: string, run: () => Promise<string>];

export function defaultSearchBackends(
  query: string,
  signal?: AbortSignal,
  lang?: string,
  deps: SearchDeps = {},
): BackendEntry[] {
  return (["google", "duckduckgo", "bing"] as const).map((engine) => [
    `camoufox+openserp(${engine})`,
    () => camoufoxOpenserpSearch(engine, query, signal, lang, deps),
  ]);
}

function isCaptchaParseError(error: unknown): boolean {
  return error instanceof Error && error.message === "parse: captcha detected";
}

// SPEC: 描画段のチャレンジ検出（render: challenge detected）も、captcha と同じく
// 同一バックエンドの追加試行 1 回の対象にする。
function isChallengeRenderError(error: unknown): boolean {
  return error instanceof Error && error.message === "render: challenge detected";
}

// Run backends in order, record an Attempt each, and return the first
// non-empty payload. A whitespace-only / zero-length payload counts as a
// failure of that backend (SPEC: empty results fall through to the next one).
// A backend whose failure matches shouldRetry gets exactly one extra run of
// the same backend before moving on.
async function tryBackends(
  operation: "web search" | "web fetch",
  backends: readonly BackendEntry[],
  isEmpty: (payload: string) => boolean,
  shouldRetry?: (error: unknown) => boolean,
): Promise<{ payload: string; backend: string; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];

  for (const [name, run] of backends) {
    let retried = false;
    while (true) {
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
        if (retried || !shouldRetry?.(error)) break;
        retried = true;
      }
    }
  }
  throw new AllBackendsFailedError(operation, attempts);
}

export async function searchOne(
  query: string,
  signal: AbortSignal | undefined,
  backends?: BackendEntry[],
  lang?: string,
): Promise<{ text: string; backend: string; attempts: Attempt[] }> {
  const resolvedBackends = backends ?? defaultSearchBackends(query, signal, lang);
  const { payload, backend, attempts } = await tryBackends(
    "web search",
    resolvedBackends,
    (text) => !text.trim(),
    (error) =>
      !signal?.aborted && (isCaptchaParseError(error) || isChallengeRenderError(error)),
  );
  return { text: payload, backend, attempts };
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
  // SPEC: §タイムアウト。Reddit の各取得（フィード・埋め込み・oEmbed）は
  // 1要求ごとに15秒。前の要求で消費した時間は次の要求に引き継がない。
  const attemptSignal = (): AbortSignal =>
    AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(REDDIT_TIMEOUT_MS),
    ]);
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

// --- StackOverflow backend: SE API -> question feed (SPEC: §StackOverflow バックエンド) ---

const SE_API_BASE_URL = "https://api.stackexchange.com/2.3";
export const STACKOVERFLOW_TIMEOUT_MS = 15_000;
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
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(STACKOVERFLOW_TIMEOUT_MS),
    ]),
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
  // SPEC: レスポンスが backoff を含むときは、その秒数待ってから次のリクエストを送る
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
  // SPEC: has_more が true の間はページを進め、投票順で最大500件まで取得する
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
      // SE API の title は HTML エスケープされて返るためデコードする
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
    // SPEC: §StackOverflow バックエンドの出力表。フィード利用時の注記は3要素に絞る。
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
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(STACKOVERFLOW_TIMEOUT_MS),
        ]),
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

// SPEC: §web_fetch のバックエンド。Reddit 投稿パーマリンクは Reddit のみ、
// その他は camoufox+trafilatura のみ。
export function defaultFetchBackends(
  url: string,
  signal?: AbortSignal,
  deps: CamoufoxFetchDeps = {},
): BackendEntry[] {
  if (parseRedditPostUrl(url)) {
    return [["Reddit", () => fetchRedditMarkdown(url, signal)]];
  }
  // SPEC: §web_fetch のバックエンド。StackOverflow 質問パーマリンクは StackOverflow のみ。
  if (parseStackOverflowQuestionUrl(url)) {
    return [["StackOverflow", () => fetchStackOverflowMarkdown(url, signal)]];
  }
  return [["camoufox+trafilatura", () => camoufoxFetch(url, signal, deps)]];
}

export async function fetchOne(
  url: string,
  signal: AbortSignal | undefined,
  backends: BackendEntry[] = defaultFetchBackends(url, signal),
): Promise<{ text: string; backend: string; attempts: Attempt[] }> {
  const { payload, backend, attempts } = await tryBackends(
    "web fetch",
    backends,
    (text) => !text.trim(),
    (error) =>
      !signal?.aborted && (isCaptchaParseError(error) || isChallengeRenderError(error)),
  );
  return { text: payload, backend, attempts };
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
  const duration =
    attempt.durationMs === undefined ? "" : ` (${(attempt.durationMs / 1000).toFixed(1)}s)`;
  if (!attempt.ok) return `✗ ${attempt.backend} - "${attempt.error}"${duration}`;
  return successTitle
    ? `✓ ${attempt.backend} - "${successTitle}"${duration}`
    : `✓ ${attempt.backend}${duration}`;
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
  prime: (deps?: PrimeServerDeps) => Promise<void> = primeServers,
) {
  const searchQueue = new SerialTaskQueue();
  const fetchQueue = new SerialTaskQueue();

  // SPEC: §常駐サーバー §セッション開始時の先行起動。完了は待たない。
  pi.on("session_start", () => {
    void prime();
  });

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
