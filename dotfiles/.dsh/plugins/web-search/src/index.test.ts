// Tests for dotfiles-dsh-web-search. Describes follow the SPEC.md section
// order: 設定 -> search provider -> fetch provider -> 常駐サーバー ->
// 同種リクエストの直列化 -> 提供する plugin.
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebError } from "@deepseek-ai/dsh-web";
import type { WebFetchProvider, WebSearchProvider, WebSearchSource } from "@deepseek-ai/dsh-web";
import {
  AllBackendsFailedError,
  apply,
  binaryOnPath,
  buildCamoufoxServerSpawn,
  buildOpenserpServerSpawn,
  buildPlaywrightCliArgs,
  buildPlaywrightCliEnv,
  CAMOUFOX_DEFAULT_BASE_URL,
  camoufoxExecutablePath,
  camoufoxFetch,
  camoufoxOpenserpSearch,
  camoufoxRender,
  camoufoxServerHealthy,
  camoufoxServerLogPath,
  CHALLENGE_SIGNALS,
  challengeWaitSnippet,
  CONVERT_TIMEOUT_MS,
  Config,
  defaultFetchBackends,
  defaultSearchBackends,
  detectChallengePage,
  fetchOne,
  fetchRedditMarkdown,
  fetchStackOverflowMarkdown,
  FETCH_PROVIDER_ID,
  CamoufoxOpenserpSearchProvider,
  CamoufoxTrafilaturaFetchProvider,
  hostPrerequisitesMet,
  inject,
  name,
  normalizedFetchUrl,
  openserpParse,
  OPENSERP_DEFAULT_BASE_URL,
  PARSE_TIMEOUT_MS,
  parseRedditAtom,
  parseRedditEmbed,
  parseRedditOEmbed,
  parseRedditPostUrl,
  parseRenderedPage,
  parseStackOverflowAtom,
  parseStackOverflowQuestionUrl,
  playwrightCliConfigJson,
  playwrightCliConfigPath,
  primeServers,
  REDDIT_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  resolveEndpoints,
  searchOne,
  SEARCH_PROVIDER_ID,
  SERVER_WAIT_TIMEOUT_MS,
  serpUrl,
  spawnCamoufoxServer,
  spawnDetachedServer,
  STACKOVERFLOW_TIMEOUT_MS,
  syncPlaywrightCliConfig,
  toSearchSources,
  toWebError,
  type Attempt,
  type BackendEntry,
  type OpenserpSearchResult,
  type ServerEndpoints,
} from "./index.ts";

const endpoints: ServerEndpoints = resolveEndpoints({});
type MockSources = { url: string }[];

function createDeferred<Result>() {
  let resolve!: (value: Result | PromiseLike<Result>) => void;
  const promise = new Promise<Result>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// durationMs varies with real execution time, so drop it before comparing.
function withoutDurationMs(attempt: Attempt): object {
  const { durationMs: _durationMs, ...rest } = attempt;
  return rest;
}

function searchBackend(
  sourceName: string,
  sources: MockSources = [{ url: `https://${sourceName}/` }],
): BackendEntry<WebSearchSource[]> {
  return [sourceName, async () => sources.map((source) => ({ url: source.url }))];
}

function okFetchBackend(sourceName: string, markdown = `text from ${sourceName}`): BackendEntry<string> {
  return [sourceName, async () => markdown];
}

function failBackend<T>(sourceName: string, message = `${sourceName} error`): BackendEntry<T> {
  return [
    sourceName,
    async () => {
      throw new Error(message);
    },
  ];
}

// --- SPEC §"設定" ---

describe("設定（resolveEndpoints・Config）", () => {
  it("config 値が環境変数と既定値に優先する", () => {
    const resolved = resolveEndpoints(
      { camoufoxBaseUrl: "ws://cfg:1/x", openserpBaseUrl: "http://cfg:2" },
      { CAMOUFOX_BASE_URL: "ws://env:1/x", OPENSERP_BASE_URL: "http://env:2" },
    );
    assert.deepEqual(resolved, {
      camoufoxBaseUrl: "ws://cfg:1/x",
      openserpBaseUrl: "http://cfg:2",
    });
  });

  it("config 未指定の項目は環境変数 CAMOUFOX_BASE_URL / OPENSERP_BASE_URL にフォールバックする", () => {
    const resolved = resolveEndpoints(
      { camoufoxBaseUrl: "ws://cfg:1/x" },
      { CAMOUFOX_BASE_URL: "ws://env:1/x", OPENSERP_BASE_URL: "http://env:2" },
    );
    assert.deepEqual(resolved, {
      camoufoxBaseUrl: "ws://cfg:1/x",
      openserpBaseUrl: "http://env:2",
    });
  });

  it("config・環境変数とも未指定なら既定値（ws://127.0.0.1:9378/camoufox・http://127.0.0.1:7000）を使う", () => {
    assert.deepEqual(resolveEndpoints({}, {}), {
      camoufoxBaseUrl: CAMOUFOX_DEFAULT_BASE_URL,
      openserpBaseUrl: OPENSERP_DEFAULT_BASE_URL,
    });
  });

  it("Config は camoufoxBaseUrl と openserpBaseUrl の2項目を受け付ける", () => {
    assert.deepEqual(Config({ camoufoxBaseUrl: "ws://a/x", openserpBaseUrl: "http://b" }), {
      camoufoxBaseUrl: "ws://a/x",
      openserpBaseUrl: "http://b",
    });
    assert.deepEqual(Config({}), {});
  });
});

// --- SPEC §"search provider" ---

describe("SERP URL 構築（serpUrl）", () => {
  it("クエリを q パラメータへ URL エンコードする", () => {
    assert.equal(serpUrl("google", "pi coding agent"), "https://www.google.com/search?q=pi+coding+agent");
    assert.equal(serpUrl("duckduckgo", "a&b=c"), "https://duckduckgo.com/?q=a%26b%3Dc");
    assert.equal(serpUrl("bing", "x"), "https://www.bing.com/search?q=x");
  });

  it("言語パラメータ（hl・gl・mkt・kl）を付けない（言語ヒントは非対応）", () => {
    for (const engine of ["google", "duckduckgo", "bing"] as const) {
      const url = serpUrl(engine, "query");
      assert.ok(!/[?&](hl|gl|mkt|kl)=/.test(url), `${engine}: ${url}`);
    }
  });
});

describe("openserp results の sources 変換（toSearchSources）", () => {
  it("rank 昇順にソートし、title・snippet を埋める", () => {
    const sources = toSearchSources([
      { rank: 3, url: "https://c/", title: "C", snippet: "sc" },
      { rank: 1, url: "https://a/", title: "A", snippet: "sa" },
      { rank: 2, url: "https://b/", title: "B" },
    ]);
    assert.deepEqual(sources, [
      { url: "https://a/", title: "A", snippet: "sa" },
      { url: "https://b/", title: "B" },
      { url: "https://c/", title: "C", snippet: "sc" },
    ]);
  });

  it("url のないエントリは結果に含めない", () => {
    assert.deepEqual(
      toSearchSources([
        { rank: 1, title: "no url" },
        { rank: 2, url: "https://a/" },
      ]),
      [{ url: "https://a/" }],
    );
  });

  it("title・snippet が空白なら省略する（値を捏造しない）", () => {
    assert.deepEqual(
      toSearchSources([{ rank: 1, url: "https://a/", title: "  ", snippet: "" }]),
      [{ url: "https://a/" }],
    );
  });
});

// --- mock fetchers (openserp) ---

const networkError = Symbol("network-error");

type OpenserpCall = {
  method: string;
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

interface OpenserpRoute {
  method: string;
  pattern: RegExp;
  status?: number;
  statusText?: string;
  body?: unknown;
  respond?: () => unknown;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createMockServerFetcher(baseUrl: string) {
  return (routes: OpenserpRoute[], calls: OpenserpCall[]): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace(baseUrl, "");
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({
        method,
        path,
        body: init?.body === undefined ? undefined : tryParseJson(String(init.body)),
        signal: init?.signal as AbortSignal | undefined,
        headers: (init?.headers as Record<string, string> | undefined) ?? undefined,
      });
      const route = routes.find(
        (candidate) => candidate.method === method && candidate.pattern.test(path),
      );
      if (!route) throw new Error(`unexpected request: ${method} ${path}`);
      const body = route.respond ? route.respond() : route.body;
      if (body === networkError) throw new TypeError("fetch failed");
      const status = route.status ?? 200;
      return {
        ok: status < 400,
        status,
        statusText: route.statusText ?? "OK",
        json: async () => (status < 400 ? body : { error: route.body, message: route.body }),
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      } as unknown as Response;
    }) as unknown as typeof fetch;
}

const mockOpenserpFetcher = createMockServerFetcher(OPENSERP_DEFAULT_BASE_URL);

describe("openserp パース（openserpParse）", () => {
  it("ready を確認してから HTML を POST /<engine>/parse?format=json へ送り、results を返す", async () => {
    const calls: OpenserpCall[] = [];
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        {
          method: "POST",
          pattern: /^\/google\/parse\?format=json$/,
          body: { results: [{ rank: 1, url: "https://a/", title: "Example" }] },
        },
      ],
      calls,
    );

    const results = await openserpParse(
      "google",
      "<html>serp</html>",
      OPENSERP_DEFAULT_BASE_URL,
      undefined,
      { fetcher, spawnOpenserp: () => {} },
    );

    assert.deepEqual<OpenserpSearchResult[]>(results, [
      { rank: 1, url: "https://a/", title: "Example" },
    ]);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      ["GET /ready", "POST /google/parse?format=json"],
    );
    const parseCall = calls[1]!;
    assert.equal(parseCall.headers?.["Content-Type"], "text/html");
    assert.equal(parseCall.body, "<html>serp</html>");
  });

  it("サーバーが応答しないときは起動して準備を待つ", async () => {
    const calls: OpenserpCall[] = [];
    let readyChecks = 0;
    const fetcher = mockOpenserpFetcher(
      [
        {
          method: "GET",
          pattern: /^\/ready$/,
          respond: () => (++readyChecks <= 1 ? networkError : { status: "ready" }),
        },
        {
          method: "POST",
          pattern: /^\/duckduckgo\/parse\?format=json$/,
          body: { results: [{ rank: 1, title: "Example" }] },
        },
      ],
      calls,
    );
    const spawns: string[] = [];

    await openserpParse(
      "duckduckgo",
      "<html>serp</html>",
      OPENSERP_DEFAULT_BASE_URL,
      undefined,
      {
        fetcher,
        spawnOpenserp: (baseUrl) => spawns.push(baseUrl),
      },
    );

    assert.deepEqual(spawns, [OPENSERP_DEFAULT_BASE_URL]);
    assert.equal(readyChecks, 2);
  });

  it("ready 応答時はサーバーを起動しない（起動済みサーバーを再利用する）", async () => {
    const spawns: string[] = [];
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        {
          method: "POST",
          pattern: /^\/bing\/parse\?format=json$/,
          body: { results: [{ rank: 1, title: "Example" }] },
        },
      ],
      [],
    );

    await openserpParse("bing", "<html>serp</html>", OPENSERP_DEFAULT_BASE_URL, undefined, {
      fetcher,
      spawnOpenserp: (baseUrl) => spawns.push(baseUrl),
    });

    assert.deepEqual(spawns, []);
  });

  it("タイムアウト内にサーバーが準備できなければ例外を出す", async () => {
    const fetcher = mockOpenserpFetcher(
      [{ method: "GET", pattern: /^\/ready$/, respond: () => networkError }],
      [],
    );

    await assert.rejects(
      openserpParse("bing", "<html>serp</html>", OPENSERP_DEFAULT_BASE_URL, AbortSignal.timeout(50), {
        fetcher,
        spawnOpenserp: () => {},
      }),
      /openserp server not ready/,
    );
  });

  it("CAPTCHA 等 4xx エラーは 'parse: <メッセージ>' で失敗する", async () => {
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        {
          method: "POST",
          pattern: /^\/google\/parse\?format=json$/,
          status: 422,
          statusText: "Unprocessable Entity",
          body: "captcha detected",
        },
      ],
      [],
    );

    await assert.rejects(
      openserpParse("google", "<html>serp</html>", OPENSERP_DEFAULT_BASE_URL, undefined, {
        fetcher,
        spawnOpenserp: () => {},
      }),
      /parse: captcha detected/,
    );
  });

  it("results が空なら 'parse: empty response' で失敗する（空結果は次エンジンへのフォールバック材料）", async () => {
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        { method: "POST", pattern: /^\/bing\/parse\?format=json$/, body: { results: [] } },
      ],
      [],
    );

    await assert.rejects(
      openserpParse("bing", "<html>serp</html>", OPENSERP_DEFAULT_BASE_URL, undefined, {
        fetcher,
        spawnOpenserp: () => {},
      }),
      /parse: empty response/,
    );
  });

  it("応答が JSON でなければ 'parse: response is not valid JSON' で失敗する", async () => {
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        { method: "POST", pattern: /^\/bing\/parse\?format=json$/, body: "not json" },
      ],
      [],
    );

    await assert.rejects(
      openserpParse("bing", "<html>serp</html>", OPENSERP_DEFAULT_BASE_URL, undefined, {
        fetcher,
        spawnOpenserp: () => {},
      }),
      /parse: response is not valid JSON/,
    );
  });

  it("接続先は解決済み openserpBaseUrl を使う", async () => {
    const baseUrl = "http://127.0.0.1:7100";
    const fetcher = createMockServerFetcher(baseUrl)(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        {
          method: "POST",
          pattern: /^\/google\/parse\?format=json$/,
          body: { results: [{ rank: 1, url: "https://a/" }] },
        },
      ],
      [],
    );

    const results = await openserpParse("google", "<html>x</html>", baseUrl, undefined, {
      fetcher,
      spawnOpenserp: () => {},
    });

    assert.equal(results.length, 1);
  });
});

// --- mock playwright-cli ---

type CliCall = { sessionKey: string; args: string[]; signal?: AbortSignal };

// `playwright-cli run-code` stdout: a one-line JSON literal after "### Result".
function runCodeOutput(html: string, mode: "settled" | "challenge" = "settled"): string {
  return [
    "### Result",
    JSON.stringify({ mode, html }),
    "### Ran Playwright code",
    "```js",
    "await (async page => { ... })(page);",
    "```",
    "",
  ].join("\n");
}

type CliMockOptions = {
  health?: "ok" | "fail";
  openError?: Error;
  runCodeError?: Error;
  runCodeOutput?: string;
  runCodeHtml?: string;
  runCodeMode?: "settled" | "challenge";
  closeError?: Error;
};

function cliDeps(
  options: CliMockOptions,
  calls: CliCall[],
  spawns: { count: number } = { count: 0 },
) {
  return {
    probeServer: async () => options.health !== "fail",
    spawnCamoufox: () => {
      spawns.count++;
    },
    runCli: async (sessionKey: string, args: string[], signal: AbortSignal) => {
      calls.push({ sessionKey, args, signal });
      const command = args[0];
      if (command === "open") {
        if (options.openError) throw options.openError;
        return "opened";
      }
      if (command === "run-code") {
        if (options.runCodeError) throw options.runCodeError;
        if (options.runCodeOutput !== undefined) return options.runCodeOutput;
        return runCodeOutput(options.runCodeHtml ?? "", options.runCodeMode);
      }
      if (command === "close") {
        if (options.closeError) throw options.closeError;
        return "";
      }
      throw new Error(`unexpected cli command: ${args.join(" ")}`);
    },
  };
}

describe("camoufox による描画（camoufoxRender）", () => {
  it("web_search は web-search、web_fetch は web-fetch セッションで CLI を呼ぶ", async () => {
    const calls: CliCall[] = [];
    const deps = cliDeps({ health: "ok", runCodeHtml: "<html>x</html>" }, calls);

    await camoufoxRender("https://example.com/a", "web-search", CAMOUFOX_DEFAULT_BASE_URL, undefined, deps);
    await camoufoxRender("https://example.com/b", "web-fetch", CAMOUFOX_DEFAULT_BASE_URL, undefined, deps);

    const openSessions = calls
      .filter((call) => call.args[0] === "open")
      .map((call) => call.sessionKey);
    assert.deepEqual(openSessions, ["web-search", "web-fetch"]);
  });

  it("描画の前に playwright-cli config を接続先に合わせて更新する", async () => {
    const calls: CliCall[] = [];
    let synced = false;
    const deps = {
      ...cliDeps({ health: "ok", runCodeHtml: "<html>x</html>" }, calls),
      syncConfig: () => {
        synced = true;
      },
    };

    await camoufoxRender("https://example.com/", "web-fetch", CAMOUFOX_DEFAULT_BASE_URL, undefined, deps);

    assert.ok(synced);
    const firstCommand = calls[0]?.args[0];
    assert.notEqual(firstCommand, "open");
  });

  it("open の前に残存セッションを閉じ、cookie やページ状態を持ち越さない", async () => {
    const calls: CliCall[] = [];

    await camoufoxRender(
      "https://example.com/",
      "web-fetch",
      CAMOUFOX_DEFAULT_BASE_URL,
      undefined,
      cliDeps({ health: "ok", runCodeHtml: "<html>c</html>" }, calls),
    );

    assert.equal(calls[0]?.args[0], "close");
    assert.ok(calls.findIndex((call) => call.args[0] === "open") > 0);
  });

  it("描画失敗のエラーには render: 段階ラベルを付ける", async () => {
    const calls: CliCall[] = [];

    await assert.rejects(
      camoufoxRender(
        "https://example.com/",
        "web-search",
        CAMOUFOX_DEFAULT_BASE_URL,
        undefined,
        cliDeps({ health: "ok", openError: new Error("page.goto: Timeout") }, calls),
      ),
      /render: page\.goto: Timeout/,
    );
  });

  it("run-code には networkidle 待ちとチャレンジポーリングを同時に実行するスニペットを渡す", async () => {
    const calls: CliCall[] = [];

    await camoufoxRender(
      "https://example.com/",
      "web-fetch",
      CAMOUFOX_DEFAULT_BASE_URL,
      undefined,
      cliDeps({ health: "ok", runCodeHtml: "<html>r</html>" }, calls),
    );

    const runCodeCall = calls.find((call) => call.args[0] === "run-code");
    const snippet = runCodeCall?.args[1] ?? "";
    assert.match(snippet, /waitForLoadState\('networkidle', \{ timeout: 5000 \}\)/);
    assert.match(snippet, /waitForTimeout\(\d+\)/);
    assert.match(snippet, /mode: 'challenge'/);
    // Signals are embedded as source+flags so run-code can rebuild them
    assert.match(snippet, /challengeSignals = \[/);
    assert.equal([...snippet.matchAll(/new RegExp\(/g)].length, 1);
  });

  it("描画済み DOM がチャレンジページのとき render 失敗にする", async () => {
    const calls: CliCall[] = [];

    await assert.rejects(
      camoufoxRender(
        "https://example.com/",
        "web-fetch",
        CAMOUFOX_DEFAULT_BASE_URL,
        undefined,
        cliDeps(
          {
            health: "ok",
            runCodeHtml: "<html><head><title>Just a moment...</title></head></html>",
            runCodeMode: "challenge",
          },
          calls,
        ),
      ),
      /render: challenge detected/,
    );
    assert.equal(calls.at(-1)?.args[0], "close");
  });
});

describe("playwright-cli run-code 出力のパース（parseRenderedPage）", () => {
  it("### Result 行に続く JSON オブジェクトから settled の HTML を取り出す", () => {
    const output = `### Result\n${JSON.stringify({ mode: "settled", html: "<html>body</html>" })}\n### Ran Playwright code\n`;

    assert.equal(parseRenderedPage(output), "<html>body</html>");
  });

  it("エスケープされた改行や引用符を含む HTML を復元する", () => {
    const html = '<div class="a">\n</div>';
    const output = `### Result\n${JSON.stringify({ mode: "settled", html })}\n`;

    assert.equal(parseRenderedPage(output), html);
  });

  it("challenge モードは例外を出す", () => {
    const output = `### Result\n${JSON.stringify({ mode: "challenge", html: "<html>x</html>" })}\n`;

    assert.throws(() => parseRenderedPage(output), /challenge detected/);
  });

  it("Result がなければ例外を出す", () => {
    assert.throws(() => parseRenderedPage("### Ran Playwright code\n```js\nx\n```\n"), /no result/);
  });

  it("Result の次の行が文字列リテラルでなければ例外を出す", () => {
    assert.throws(() => parseRenderedPage("### Result\nundefined\n"), /no result/);
  });

  it("html が空なら例外を出す", () => {
    assert.throws(
      () => parseRenderedPage(`### Result\n${JSON.stringify({ mode: "settled", html: "" })}\n`),
      /no HTML/,
    );
  });
});

describe("チャレンジページ検出（detectChallengePage）", () => {
  it("Cloudflare の各構造シグナル（4種）を含む HTML をチャレンジページと判定する", () => {
    const cloudflarePages = [
      '<script src="https://example.com/cdn-cgi/challenge-platform/h/b/or.js"></script>',
      '<div id="challenge-running"><div id="challenge-stage">x</div></div>',
      "<html><head><title>Just a moment...</title></head></html>",
      '<div class="cf-turnstile" data-sitekey="k"></div>',
    ];
    for (const html of cloudflarePages) {
      assert.ok(detectChallengePage(html), `should detect: ${html.slice(0, 40)}`);
    }
  });

  it("Google CAPTCHA・sorry・soft block 固定ページ（4種）をチャレンジページと判定する", () => {
    const googlePages = [
      '<form id="captcha-form" action="/sorry/"></form>',
      '<form action="https://www.google.com/sorry/index"></form>',
      '<body onload="sf();captcha"></body>',
      '<noscript><a href="https://www.google.com/httpservice/retry/enablejs">click</a></noscript>',
    ];
    for (const html of googlePages) {
      assert.ok(detectChallengePage(html), `should detect: ${html.slice(0, 40)}`);
    }
  });

  it("通常ページと文言だけが似ているページはチャレンジページとしない", () => {
    const normalPages = [
      '<html><body>Just a moment... is a song title we discuss here.</body></html>',
      '<form action="/search"><input name="captcha-quiz"></form>',
      '<div class="result" data-hveid="1"><a href="/httpservice/retry/enablejs">docs</a></div>',
      '<div class="tF2Cxc">organic result</div>',
    ];
    for (const html of normalPages) {
      assert.ok(!detectChallengePage(html), `should NOT detect: ${html.slice(0, 40)}`);
    }
  });

  it("シグナルは run-code スニペットにも単一ソースで渡される", () => {
    const snippet = challengeWaitSnippet();
    for (const signal of CHALLENGE_SIGNALS) {
      assert.ok(snippet.includes(JSON.stringify(signal.source).slice(1, -1)), signal.source);
    }
  });
});

describe("camoufox+openserp 検索（camoufoxOpenserpSearch・searchOne）", () => {
  it("SERP URL を構築し web-search セッションで描画し、パース結果を rank 順の sources で返す", async () => {
    const calls: CliCall[] = [];
    const openserpCalls: OpenserpCall[] = [];
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        {
          method: "POST",
          pattern: /^\/google\/parse\?format=json$/,
          body: {
            results: [
              { rank: 2, url: "https://b/", title: "B" },
              { rank: 1, url: "https://a/", title: "A", snippet: "sa" },
            ],
          },
        },
      ],
      openserpCalls,
    );

    const sources = await camoufoxOpenserpSearch("google", "pi coding", endpoints, undefined, {
      ...cliDeps({ health: "ok", runCodeHtml: "<html>serp</html>" }, calls),
      fetcher,
      spawnOpenserp: () => {},
    });

    assert.deepEqual(sources, [
      { url: "https://a/", title: "A", snippet: "sa" },
      { url: "https://b/", title: "B" },
    ]);
    const openCall = calls.find((call) => call.args[0] === "open");
    assert.equal(openCall?.args[1], "https://www.google.com/search?q=pi+coding");
    assert.equal(openCall?.sessionKey, "web-search");
    assert.equal(openserpCalls[1]?.path, "/google/parse?format=json");
  });

  it("デフォルトのバックエンド順序は camoufox+openserp(google)→duckduckgo→bing", () => {
    const names = defaultSearchBackends("q", endpoints).map(([backendName]) => backendName);
    assert.deepEqual(names, [
      "camoufox+openserp(google)",
      "camoufox+openserp(duckduckgo)",
      "camoufox+openserp(bing)",
    ]);
  });

  it("失敗バックエンドを順に飛ばし、最初の成功バックエンドで sources とその名前を返す", async () => {
    const backends: BackendEntry<WebSearchSource[]>[] = [
      failBackend<WebSearchSource[]>("A"),
      failBackend<WebSearchSource[]>("B"),
      searchBackend("C"),
      searchBackend("D"),
    ];
    const result = await searchOne("query", endpoints, undefined, backends);

    assert.deepEqual(result.sources, [{ url: "https://C/" }]);
    assert.equal(result.backend, "C");
    assert.deepEqual(
      result.attempts.map(withoutDurationMs),
      [
        { backend: "A", ok: false, error: "A error" },
        { backend: "B", ok: false, error: "B error" },
        { backend: "C", ok: true },
      ],
    );
  });

  it("最初のエンジン（google）が成功したら後続エンジンは試行しない", async () => {
    const runCounts = new Map<string, number>();
    const backends: BackendEntry<WebSearchSource[]>[] = ["google-like", "ddg-like", "bing-like"].map(
      (backendName) => [
        backendName,
        async () => {
          runCounts.set(backendName, (runCounts.get(backendName) ?? 0) + 1);
          return [{ url: `https://${backendName}/` }];
        },
      ] satisfies BackendEntry<WebSearchSource[]>,
    );

    const result = await searchOne("query", endpoints, undefined, backends);

    assert.equal(result.backend, "google-like");
    assert.deepEqual([...runCounts.entries()], [["google-like", 1]]);
  });

  it("全バックエンドが失敗したら各エンジンの失敗行を含む例外を出す", async () => {
    const backends: BackendEntry<WebSearchSource[]>[] = [
      failBackend<WebSearchSource[]>("camoufox+openserp(google)", "render: challenge detected"),
      failBackend<WebSearchSource[]>("camoufox+openserp(duckduckgo)", "parse: empty response"),
      failBackend<WebSearchSource[]>("camoufox+openserp(bing)", "render: aborted"),
    ];

    await assert.rejects(searchOne("query", endpoints, undefined, backends), (error) => {
      assert.ok(error instanceof AllBackendsFailedError);
      assert.equal(error.operation, "web search");
      assert.match(
        error.message,
        /All web search backends failed: camoufox\+openserp\(google\): render: challenge detected; camoufox\+openserp\(duckduckgo\): parse: empty response; camoufox\+openserp\(bing\): render: aborted/,
      );
      return true;
    });
  });

  it("render abort での全滅には camoufox サーバーの kill 手順ヒント（pkill 行）を添える", async () => {
    const backends: BackendEntry<WebSearchSource[]>[] = [
      failBackend<WebSearchSource[]>("camoufox+openserp(google)", "render: The operation was aborted"),
      failBackend<WebSearchSource[]>("camoufox+openserp(duckduckgo)", "render: aborted due to timeout"),
    ];

    await assert.rejects(searchOne("query", endpoints, undefined, backends), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /pkill -f "bun server\.mjs"/);
      return true;
    });
  });

  it("render abort 以外の失敗にはヒントを添えない", async () => {
    const backends: BackendEntry<WebSearchSource[]>[] = [
      failBackend<WebSearchSource[]>("A", "render: challenge detected"),
      failBackend<WebSearchSource[]>("B", "parse: empty response"),
    ];

    await assert.rejects(searchOne("query", endpoints, undefined, backends), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("pkill"));
      return true;
    });
  });

  it("空の sources を返すバックエンドは失敗として次へフォールバックする", async () => {
    const backends: BackendEntry<WebSearchSource[]>[] = [
      searchBackend("empty", []),
      searchBackend("next", [{ url: "https://next/" }]),
    ];

    const result = await searchOne("query", endpoints, undefined, backends);

    assert.equal(result.backend, "next");
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.ok),
      [false, true],
    );
  });
});

describe("search provider（CamoufoxOpenserpSearchProvider）", () => {
  function sources(count: number): WebSearchSource[] {
    return Array.from({ length: count }, (_, index) => ({
      url: `https://example.com/${index + 1}`,
      title: `Result ${index + 1}`,
    }));
  }

  it("maxResults 指定ありでも全件を返し truncated false を返す（cap は seam の受け持ち）", async () => {
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, {
      search: async () => sources(5),
    });

    const result = await provider.search({ query: "q", maxResults: 2 });

    assert.deepEqual(result.sources, sources(5));
    assert.equal(result.truncated, false);
  });

  it("maxResults 指定なしでも全件を返す", async () => {
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, {
      search: async () => sources(12),
    });

    const result = await provider.search({ query: "q" });

    assert.deepEqual(result.sources, sources(12));
    assert.equal(result.truncated, false);
  });

  it("全エンジン失敗時は WEB_PROVIDER_ERROR の WebError で失敗し、メッセージに各エンジンの失敗行が含まれる", async () => {
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, {
      search: async (query, signal) => {
        const { sources } = await searchOne(query, endpoints, signal, [
          failBackend<WebSearchSource[]>("camoufox+openserp(google)", "render: challenge detected"),
          failBackend<WebSearchSource[]>("camoufox+openserp(duckduckgo)", "parse: empty response"),
          failBackend<WebSearchSource[]>("camoufox+openserp(bing)", "render: aborted"),
        ]);
        return sources;
      },
    });

    await assert.rejects(provider.search({ query: "q" }), (error) => {
      assert.ok(error instanceof WebError, `expected WebError, got ${error}`);
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.match(error.message, /camoufox\+openserp\(google\): render: challenge detected/);
      assert.match(error.message, /camoufox\+openserp\(duckduckgo\): parse: empty response/);
      assert.match(error.message, /camoufox\+openserp\(bing\): render: aborted/);
      assert.match(error.message, /pkill -f "bun server\.mjs"/);
      assert.ok(error.cause instanceof AllBackendsFailedError);
      return true;
    });
  });

  it("id は camoufox-openserp", () => {
    assert.equal(new CamoufoxOpenserpSearchProvider(endpoints).id, SEARCH_PROVIDER_ID);
    assert.equal(SEARCH_PROVIDER_ID, "camoufox-openserp");
  });

  it("available は前提チェック（3バイナリ＋camoufox 実行ファイル）に従う", () => {
    const unavailable = new CamoufoxOpenserpSearchProvider(endpoints, {
      prerequisitesMet: () => false,
    });
    assert.equal(unavailable.available(), false);

    const ready = new CamoufoxOpenserpSearchProvider(endpoints, { prerequisitesMet: () => true });
    assert.equal(ready.available(), true);
  });
});

describe("available() の前提チェック（hostPrerequisitesMet・binaryOnPath）", () => {
  it("bun・openserp・playwright-cli と camoufox 実行ファイルが揃ったとき true", () => {
    assert.equal(hostPrerequisitesMet({}, { binaryOnPath: () => true, fileExists: () => true }), true);
  });

  it("3バイナリのどれかが PATH になければ false", () => {
    for (const missing of ["bun", "openserp", "playwright-cli"]) {
      const met = hostPrerequisitesMet(
        {},
        { binaryOnPath: (binaryName) => binaryName !== missing, fileExists: () => true },
      );
      assert.equal(met, false, `missing ${missing}`);
    }
  });

  it("camoufox ブラウザ実行ファイルが存在しなければ false", () => {
    assert.equal(hostPrerequisitesMet({}, { binaryOnPath: () => true, fileExists: () => false }), false);
  });

  it("camoufox 実行ファイルは CAMOUFOX_EXECUTABLE_PATH、既定は ~/.cache/camoufox/camoufox-bin", () => {
    assert.equal(camoufoxExecutablePath({ CAMOUFOX_EXECUTABLE_PATH: "/opt/camoufox" }), "/opt/camoufox");
    assert.equal(
      camoufoxExecutablePath({}),
      join(homedir(), ".cache", "camoufox", "camoufox-bin"),
    );
  });

  it("binaryOnPath は PATH ディレクトリから実行可能ファイルを探す", () => {
    const directory = mkdtempSync(join(tmpdir(), "websearch-bin-"));
    try {
      const executablePath = join(directory, "mybin");
      writeFileSync(executablePath, "#!/bin/sh\n");
      chmodSync(executablePath, 0o755);
      const plainPath = join(directory, "plainbin");
      writeFileSync(plainPath, "data");
      chmodSync(plainPath, 0o644);

      assert.equal(binaryOnPath("mybin", { PATH: directory }), true);
      assert.equal(binaryOnPath("plainbin", { PATH: directory }), false);
      assert.equal(binaryOnPath("missing-bin", { PATH: directory }), false);
      assert.equal(binaryOnPath("mybin", { PATH: "/nonexistent-dir" }), false);
      assert.equal(binaryOnPath("mybin", {}), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// --- SPEC §"fetch provider" ---

describe("fetch の URL 分岐（defaultFetchBackends）", () => {
  it("Reddit 投稿パーマリンクのときバックエンドは Reddit のみでフォールバックしない", () => {
    const backends = defaultFetchBackends(
      "https://www.reddit.com/r/programming/comments/abc123/title/",
      CAMOUFOX_DEFAULT_BASE_URL,
    );
    assert.deepEqual(
      backends.map(([backendName]) => backendName),
      ["Reddit"],
    );
  });

  it("StackOverflow 質問パーマリンクのときバックエンドは StackOverflow のみ", () => {
    const backends = defaultFetchBackends(
      "https://stackoverflow.com/questions/231767/some-slug",
      CAMOUFOX_DEFAULT_BASE_URL,
    );
    assert.deepEqual(
      backends.map(([backendName]) => backendName),
      ["StackOverflow"],
    );
  });

  it("その他の URL では camoufox+trafilatura のみ", () => {
    const backends = defaultFetchBackends("https://example.com/page", CAMOUFOX_DEFAULT_BASE_URL);
    assert.deepEqual(
      backends.map(([backendName]) => backendName),
      ["camoufox+trafilatura"],
    );
  });
});

describe("camoufox+trafilatura バックエンド（camoufoxFetch・fetchOne）", () => {
  it("サーバーが既に応答するときは起動せず、close→open→描画待ち→close→変換の順で進む", async () => {
    const calls: CliCall[] = [];
    const spawns = { count: 0 };

    const markdown = await camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, {
      ...cliDeps({ health: "ok", runCodeHtml: "<html>body</html>" }, calls, spawns),
      toMarkdown: async (html: string) => `md:${html}`,
    });

    assert.equal(markdown, "md:<html>body</html>");
    assert.equal(spawns.count, 0);
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["close", "open", "run-code", "close"],
    );
    const openCall = calls.find((call) => call.args[0] === "open");
    assert.equal(openCall?.sessionKey, "web-fetch");
  });

  it("ヘルスチェックが失敗する間はサーバーを1回だけ起動し、成功したら処理を再開する", async () => {
    const calls: CliCall[] = [];
    const spawns = { count: 0 };
    let healthChecks = 0;

    const markdown = await camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, {
      ...cliDeps({ runCodeHtml: "<html>x</html>" }, calls, spawns),
      probeServer: async () => ++healthChecks > 2,
      toMarkdown: async (html: string) => `md:${html}`,
    });

    assert.equal(markdown, "md:<html>x</html>");
    assert.equal(spawns.count, 1);
    assert.equal(healthChecks, 3);
  });

  it("タイムアウト内にサーバーが準備できなければ例外を出す（15秒上限の超過）", async () => {
    const calls: CliCall[] = [];

    await assert.rejects(
      camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, AbortSignal.timeout(50), {
        ...cliDeps({ health: "fail" }, calls),
        toMarkdown: async () => "md",
      }),
      /camoufox server not ready/,
    );
    assert.equal(calls.length, 0);
  });

  it("描画（run-code）に失敗してもページを閉じる", async () => {
    const calls: CliCall[] = [];

    await assert.rejects(
      camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, {
        ...cliDeps({ health: "ok", runCodeError: new Error("evaluate failed") }, calls),
        toMarkdown: async () => "md",
      }),
      /render: evaluate failed/,
    );
    assert.equal(calls.at(-1)?.args[0], "close");
  });

  it("ページを閉じる失敗は変換結果に影響しない", async () => {
    const markdown = await camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, {
      ...cliDeps(
        { health: "ok", runCodeHtml: "<html>x</html>", closeError: new Error("close failed") },
        [],
      ),
      toMarkdown: async (html: string) => `md:${html}`,
    });

    assert.equal(markdown, "md:<html>x</html>");
  });

  it("チャレンジページの描画結果は render 失敗扱いにする（変換しない）", async () => {
    const calls: CliCall[] = [];
    let toMarkdownCalls = 0;

    await assert.rejects(
      camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, {
        ...cliDeps(
          {
            health: "ok",
            runCodeHtml: "<html><head><title>Just a moment...</title></head></html>",
            runCodeMode: "challenge",
          },
          calls,
        ),
        toMarkdown: async () => {
          toMarkdownCalls++;
          return "md";
        },
      }),
      /render: challenge detected/,
    );
    assert.equal(toMarkdownCalls, 0);
  });

  it("CLI 操作と trafilatura 変換は別々のシグナルを使う", async () => {
    const baseDeps = cliDeps({ health: "ok", runCodeHtml: "<html>x</html>" }, []);
    const cliSignals: AbortSignal[] = [];
    const convertSignals: AbortSignal[] = [];
    const deps = {
      ...baseDeps,
      runCli: async (sessionKey: string, args: string[], signal: AbortSignal) => {
        cliSignals.push(signal);
        return (baseDeps.runCli as NonNullable<typeof baseDeps.runCli>)(sessionKey, args, signal);
      },
      toMarkdown: async (_html: string, signal?: AbortSignal) => {
        convertSignals.push(signal!);
        return "md";
      },
    };

    await camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, deps);

    assert.equal(cliSignals.length, 4);
    assert.equal(convertSignals.length, 1);
    for (const convertSignal of convertSignals) {
      assert.ok(
        cliSignals.every((cliSignal) => cliSignal !== convertSignal),
        "convert signal must differ from every CLI signal",
      );
    }
  });

  it("起動待ちで失敗した次のリクエストは、応答するサーバーで再起動せず成功する", async () => {
    const calls: CliCall[] = [];
    const spawns = { count: 0 };

    await assert.rejects(
      camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, AbortSignal.timeout(50), {
        ...cliDeps({ health: "fail", runCodeHtml: "<html>x</html>" }, calls, spawns),
        toMarkdown: async () => "md",
      }),
      /camoufox server not ready/,
    );

    const markdown = await camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, {
      ...cliDeps({ health: "ok", runCodeHtml: "<html>x</html>" }, calls, spawns),
      toMarkdown: async () => "md",
    });

    assert.equal(markdown, "md");
    assert.equal(spawns.count, 1);
  });

  it("trafilatura 変換の失敗も backend の失敗として扱う", async () => {
    await assert.rejects(
      camoufoxFetch("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, {
        ...cliDeps({ health: "ok", runCodeHtml: "<html>x</html>" }, []),
        toMarkdown: async () => {
          throw new Error("trafilatura exited with 1");
        },
      }),
      /trafilatura exited with 1/,
    );
  });

  it("fetchOne は空・空白のみの本文を失敗として扱う", async () => {
    const backends: BackendEntry<string>[] = [okFetchBackend("blank", "  \n"), okFetchBackend("ok")];
    const result = await fetchOne("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, backends);
    assert.equal(result.backend, "ok");
    assert.equal(result.markdown, "text from ok");
  });

  it("fetchOne の全バックエンド失敗は各失敗行を含む例外になる", async () => {
    const backends: BackendEntry<string>[] = [
      failBackend<string>("camoufox+trafilatura", "render: aborted"),
    ];
    await assert.rejects(
      fetchOne("https://example.com/", CAMOUFOX_DEFAULT_BASE_URL, undefined, backends),
      (error) => {
        assert.ok(error instanceof AllBackendsFailedError);
        assert.equal(error.operation, "web fetch");
        assert.match(
          error.message,
          /All web fetch backends failed: camoufox\+trafilatura: render: aborted/,
        );
        assert.match(error.message, /pkill -f "bun server\.mjs"/);
        return true;
      },
    );
  });
});

describe("Reddit バックエンド", () => {
  const redditPostUrl = "https://www.reddit.com/r/programming/comments/abc123/test_post/";

  // Fixture matching Reddit Atom shape (content HTML-escaped, body has Markdown syntax)
  const redditAtomFixture = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '<category term="programming" label="r/programming"/>',
    "<entry>",
    "<id>t3_abc123</id>",
    "<title>Announcement: We&#39;ve Updated The Rules</title>",
    "<author><name>/u/SampleAuthor</name><uri>https://www.reddit.com/user/SampleAuthor</uri></author>",
    '<content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Hello &lt;a href=&quot;https://example.com/page/&quot;&gt;world&lt;/a&gt;.&lt;/p&gt; &lt;p&gt;&lt;blockquote&gt;&lt;p&gt;Quoted &amp;amp; cited&lt;/p&gt;&lt;/blockquote&gt;&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;</content>',
    "<updated>2026-05-23T13:54:37+00:00</updated>",
    '<link href="https://www.reddit.com/r/programming/comments/abc123/test_post/"/>',
    "</entry>",
    "<entry>",
    "<id>t1_def456</id>",
    "<title>/u/Commenter on Announcement: We&#39;ve Updated The Rules</title>",
    "<author><name>/u/Commenter</name></author>",
    '<content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;A &lt;em&gt;comment&lt;/em&gt; body.&lt;/p&gt;&lt;/div&gt;</content>',
    "<updated>2026-05-23T14:18:41+00:00</updated>",
    '<link href="https://www.reddit.com/r/programming/comments/abc123/test_post/def456/"/>',
    "</entry>",
    "</feed>",
  ].join("");

  type MockResponse = { status: number; statusText: string; body: string };

  function mockRedditFetcher(responses: Record<string, MockResponse>): typeof fetch {
    return (async (url: string) => {
      const response = responses[url];
      if (!response) throw new Error(`unexpected request: ${url}`);
      return {
        ok: response.status < 400,
        status: response.status,
        statusText: response.statusText,
        text: async () => response.body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  describe("Reddit URL 判定（parseRedditPostUrl）", () => {
    it("投稿パーマリンクから RSS・embed・oEmbed の各 URL を組み立てる", () => {
      const post = parseRedditPostUrl(redditPostUrl);
      assert.ok(post);
      assert.equal(post.postId, "abc123");
      assert.equal(post.permalink, redditPostUrl);
      assert.equal(post.rssUrl, `${redditPostUrl}.rss?limit=500&sort=top`);
      assert.match(
        post.embedUrl,
        /^https:\/\/embed\.reddit\.com\/r\/programming\/comments\/abc123\/test_post\/\?ref_source=embed/,
      );
      assert.match(post.oembedUrl, /reddit\.com\/oembed\?url=/);
    });

    it("www 省略・末尾スラッシュなしでも permalink を正規化する", () => {
      const post = parseRedditPostUrl("https://reddit.com/r/programming/comments/abc123");
      assert.ok(post);
      assert.equal(post.permalink, "https://www.reddit.com/r/programming/comments/abc123/");
    });

    it("対象ホストは reddit.com と *.reddit.com（old・np 等のサブドメインを含む）", () => {
      const hosts = ["reddit.com", "www.reddit.com", "old.reddit.com", "np.reddit.com"];
      for (const host of hosts) {
        const post = parseRedditPostUrl(`https://${host}/r/programming/comments/abc123/title/`);
        assert.ok(post, `host should be accepted: ${host}`);
        assert.equal(post.permalink, "https://www.reddit.com/r/programming/comments/abc123/title/");
      }
    });

    it("reddit.com 以外のホスト・サブレディット一覧・ユーザーページ・他サイトは対象外", () => {
      assert.equal(
        parseRedditPostUrl("https://notreddit.com/r/programming/comments/abc123/title/"),
        undefined,
      );
      assert.equal(parseRedditPostUrl("https://www.reddit.com/r/programming/"), undefined);
      assert.equal(parseRedditPostUrl("https://www.reddit.com/user/SampleAuthor"), undefined);
      assert.equal(parseRedditPostUrl("https://example.com/r/programming/comments/abc123/x/"), undefined);
    });
  });

  describe("Reddit Atom パース（parseRedditAtom）", () => {
    it("投稿（t3_）のタイトル・作者・更新時刻を取り出す", () => {
      const feed = parseRedditAtom(redditAtomFixture);
      assert.ok(feed);
      assert.equal(feed.post.title, "Announcement: We've Updated The Rules");
      assert.equal(feed.post.author, "u/SampleAuthor");
      assert.equal(feed.post.updated, "2026-05-23T13:54:37+00:00");
      assert.equal(feed.post.permalink, redditPostUrl);
    });

    it("投稿本文をリンクと引用を保った Markdown に変換する", () => {
      const feed = parseRedditAtom(redditAtomFixture);
      assert.ok(feed);
      assert.match(feed.post.bodyMarkdown, /\[world\]\(https:\/\/example\.com\/page\/\)/);
      assert.match(feed.post.bodyMarkdown, /^> Quoted & cited$/m);
    });

    it("コメント（t1_）を本文ごと列挙する", () => {
      const feed = parseRedditAtom(redditAtomFixture);
      assert.ok(feed);
      assert.equal(feed.comments.length, 1);
      assert.equal(feed.comments[0]?.author, "u/Commenter");
      assert.match(feed.comments[0]?.bodyMarkdown ?? "", /A \*comment\* body\./);
    });

    it("投稿エントリがないフィードは undefined", () => {
      assert.equal(parseRedditAtom('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), undefined);
    });
  });

  describe("Reddit フォールバックパース", () => {
    it("embed ページからタイトルと表示コメント数を取り出す", () => {
      assert.deepEqual(parseRedditEmbed('<a id="embed-title">Embed Title</a> 42 comments'), {
        title: "Embed Title",
        displayedCommentCount: 42,
      });
    });

    it("embed ページに有効な要素がなければ undefined", () => {
      assert.equal(parseRedditEmbed("<html><body>nothing</body></html>"), undefined);
    });

    it("oEmbed JSON からタイトルを取り出す", () => {
      assert.deepEqual(parseRedditOEmbed('{"title":"OEmbed Title"}'), { title: "OEmbed Title" });
      assert.equal(parseRedditOEmbed("{}"), undefined);
      assert.equal(parseRedditOEmbed("not json"), undefined);
    });
  });

  describe("fetchRedditMarkdown", () => {
    const post = parseRedditPostUrl(redditPostUrl)!;

    it("RSS・埋め込み・oEmbed の各要求は独立したタイムアウトシグナルを持つ", async () => {
      const signals: AbortSignal[] = [];
      const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return Promise.resolve(new Response("", { status: 429 }));
      }) as unknown as typeof fetch;

      await assert.rejects(fetchRedditMarkdown(redditPostUrl, undefined, fetcher));

      // SPEC: each Reddit request gets its own 15-second budget
      assert.equal(signals.length, 3);
      assert.ok(signals[0] !== signals[1] && signals[1] !== signals[2]);
      assert.ok(signals.every((signal) => !signal.aborted));
    });

    it("RSS 成功時は投稿本文とコメント一覧を返す", async () => {
      const markdown = await fetchRedditMarkdown(
        redditPostUrl,
        undefined,
        mockRedditFetcher({
          [post.rssUrl]: { status: 200, statusText: "OK", body: redditAtomFixture },
        }),
      );
      assert.match(markdown, /^# Announcement: We've Updated The Rules$/m);
      assert.match(markdown, /^- Updated: /m);
      assert.match(markdown, /^- Comments: 1 fetched$/m);
      assert.match(markdown, /^## Post$/m);
      assert.match(markdown, /^## Comments \(1 retrieved\)$/m);
      assert.match(markdown, /^### 1\. u\/Commenter$/m);
    });

    it("RSS が 429 のとき embed にフォールバックする", async () => {
      const markdown = await fetchRedditMarkdown(
        redditPostUrl,
        undefined,
        mockRedditFetcher({
          [post.rssUrl]: { status: 429, statusText: "Too Many Requests", body: "" },
          [post.embedUrl]: {
            status: 200,
            statusText: "OK",
            body: '<a id="embed-title">Embed Title</a> 42 comments',
          },
        }),
      );
      assert.match(markdown, /^# Embed Title$/m);
      assert.match(markdown, /^- Comments: unavailable \(Reddit displays 42\)$/m);
      assert.match(markdown, /post body unavailable/);
    });

    it("RSS も embed も失敗するとき oEmbed を試す", async () => {
      const markdown = await fetchRedditMarkdown(
        redditPostUrl,
        undefined,
        mockRedditFetcher({
          [post.rssUrl]: { status: 429, statusText: "Too Many Requests", body: "" },
          [post.embedUrl]: { status: 403, statusText: "Forbidden", body: "" },
          [post.oembedUrl]: { status: 200, statusText: "OK", body: '{"title":"OEmbed Title"}' },
        }),
      );
      assert.match(markdown, /^# OEmbed Title$/m);
    });

    it("全経路が失敗したら例外を出す", async () => {
      const allFailedFetcher = mockRedditFetcher({
        [post.rssUrl]: { status: 429, statusText: "Too Many Requests", body: "" },
        [post.embedUrl]: { status: 403, statusText: "Forbidden", body: "" },
        [post.oembedUrl]: { status: 404, statusText: "Not Found", body: "" },
      });
      await assert.rejects(
        fetchRedditMarkdown(redditPostUrl, undefined, allFailedFetcher),
        /Unable to fetch Reddit post abc123/,
      );
    });
  });
});

describe("StackOverflow バックエンド", () => {
  const stackOverflowQuestionUrl =
    "https://stackoverflow.com/questions/231767/what-does-the-yield-keyword-do-in-python";

  type SoRoute = { match: RegExp; status?: number; body: unknown };

  function soRouteFetcher(routes: SoRoute[], requests: string[] = []): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const route = routes.find((route) => route.match.test(url));
      if (!route) throw new Error(`unexpected request: ${url}`);
      const status = route.status ?? 200;
      return {
        ok: status < 400,
        status,
        statusText: "OK",
        json: async () => route.body,
        text: async () => (typeof route.body === "string" ? route.body : JSON.stringify(route.body)),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  const apiQuestionUrl =
    /^https:\/\/api\.stackexchange\.com\/2\.3\/questions\/231767\?site=stackoverflow&filter=withbody$/;
  const apiAnswersPage1Url =
    /^https:\/\/api\.stackexchange\.com\/2\.3\/questions\/231767\/answers\?site=stackoverflow&filter=withbody&order=desc&sort=votes&pagesize=100&page=1$/;
  const apiAnswersPage2Url =
    /^https:\/\/api\.stackexchange\.com\/2\.3\/questions\/231767\/answers\?site=stackoverflow&filter=withbody&order=desc&sort=votes&pagesize=100&page=2$/;
  const apiAnswersAnyPageUrl =
    /^https:\/\/api\.stackexchange\.com\/2\.3\/questions\/231767\/answers\?site=stackoverflow&filter=withbody&order=desc&sort=votes&pagesize=100&page=\d+$/;
  const feedUrl = /^https:\/\/stackoverflow\.com\/feeds\/question\/231767$/;

  const apiQuestion = {
    title: "What does the &quot;yield&quot; keyword do in Python?",
    body: "<p>What does the <code>yield</code> keyword do?</p>",
    score: 14000,
    answer_count: 2,
    tags: ["python", "generator"],
    owner: { display_name: "Alex" },
  };
  const apiAnswerItems = [
    {
      body: "<p><strong>Iterables</strong></p>",
      score: 18316,
      is_accepted: true,
      owner: { display_name: "Bite code" },
    },
    { body: "<p>Second answer</p>", score: 100, owner: { display_name: "Other" } },
  ];
  const feedXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://stackoverflow.com/q/231767</id>
    <title>What does the yield keyword do in Python?</title>
    <link rel="alternate" href="https://stackoverflow.com/questions/231767/" />
    <author><name>Alex</name></author>
    <summary type="html">&lt;p&gt;What does the yield keyword do?&lt;/p&gt;</summary>
  </entry>
  <entry>
    <id>https://stackoverflow.com/a/231855</id>
    <title>Answers to What does the yield keyword do in Python?</title>
    <author><name>Bite code</name></author>
    <summary type="html">&lt;p&gt;&lt;strong&gt;Iterables&lt;/strong&gt;&lt;/p&gt;</summary>
  </entry>
  <entry>
    <id>https://stackoverflow.com/a/999999</id>
    <title>Answers to What does the yield keyword do in Python?</title>
    <author><name>Other</name></author>
    <summary type="html">&lt;p&gt;Second answer&lt;/p&gt;</summary>
  </entry>
</feed>`;

  it("質問パーマリンク（slug・クエリ・www 付き）を解析する", () => {
    const parsed = parseStackOverflowQuestionUrl(stackOverflowQuestionUrl);
    assert.equal(parsed?.questionId, "231767");
    assert.equal(parsed?.permalink, "https://stackoverflow.com/questions/231767");
    assert.equal(parsed?.feedUrl, "https://stackoverflow.com/feeds/question/231767");
    assert.equal(
      parseStackOverflowQuestionUrl("https://stackoverflow.com/questions/231767")?.questionId,
      "231767",
    );
    assert.equal(
      parseStackOverflowQuestionUrl(
        "https://www.stackoverflow.com/questions/231767/yield?noredirect=1#tab-top",
      )?.questionId,
      "231767",
    );
  });

  it("質問パーマリンク以外は対象外とする", () => {
    assert.equal(parseStackOverflowQuestionUrl("https://stackoverflow.com/tags/python"), undefined);
    assert.equal(parseStackOverflowQuestionUrl("https://stackoverflow.com/users/1/"), undefined);
    assert.equal(parseStackOverflowQuestionUrl("https://ja.stackoverflow.com/questions/1/x"), undefined);
    assert.equal(parseStackOverflowQuestionUrl("https://serverfault.com/questions/1/x"), undefined);
    assert.equal(parseStackOverflowQuestionUrl("https://stackoverflow.com/questions/abc/x"), undefined);
  });

  it("SE API で質問と回答を取得して Markdown 化する", async () => {
    const requests: string[] = [];
    const fetcher = soRouteFetcher(
      [
        { match: apiQuestionUrl, body: { items: [apiQuestion] } },
        { match: apiAnswersPage1Url, body: { items: apiAnswerItems, has_more: false } },
      ],
      requests,
    );

    const markdown = await fetchStackOverflowMarkdown(stackOverflowQuestionUrl, undefined, fetcher);

    assert.match(markdown, /^# What does the "yield" keyword do in Python\?$/m);
    assert.match(markdown, /^- Author: Alex$/m);
    assert.match(markdown, /^- Score: 14000$/m);
    assert.match(markdown, /^- Answers: 2 retrieved \/ 2 total$/m);
    assert.match(markdown, /^- Tags: python, generator$/m);
    assert.match(markdown, /^## Question$/m);
    assert.match(markdown, /^What does the `yield` keyword do\?$/m);
    assert.match(markdown, /^### 1\. Bite code \(accepted, score 18316\)$/m);
    assert.match(markdown, /^\*\*Iterables\*\*$/m);
    assert.match(markdown, /^### 2\. Other \(score 100\)$/m);
    assert.equal(requests.length, 2);
  });

  it("has_more が true の間は回答ページを進める", async () => {
    const requests: string[] = [];
    const fetcher = soRouteFetcher(
      [
        { match: apiQuestionUrl, body: { items: [apiQuestion] } },
        { match: apiAnswersPage1Url, body: { items: apiAnswerItems, has_more: true } },
        {
          match: apiAnswersPage2Url,
          body: {
            items: [{ body: "<p>page2</p>", score: 1, owner: { display_name: "Third" } }],
            has_more: false,
          },
        },
      ],
      requests,
    );

    const markdown = await fetchStackOverflowMarkdown(stackOverflowQuestionUrl, undefined, fetcher);

    assert.match(markdown, /3 retrieved/);
    assert.match(markdown, /^### 3\. Third \(score 1\)$/m);
    assert.equal(requests.filter((url) => url.includes("/answers?")).length, 2);
  });

  it("backoff を返されたときはその秒数待ってから次のリクエストを送る", async () => {
    const requests: string[] = [];
    const fetcher = soRouteFetcher(
      [
        { match: apiQuestionUrl, body: { items: [apiQuestion], backoff: 1 } },
        { match: apiAnswersPage1Url, body: { items: apiAnswerItems, has_more: false } },
      ],
      requests,
    );

    const startedAt = Date.now();
    await fetchStackOverflowMarkdown(stackOverflowQuestionUrl, undefined, fetcher);
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs >= 950, `expected >= 950ms, got ${elapsedMs}ms`);
    assert.equal(requests.length, 2);
  });

  it("質問フィードの先頭 entry を質問、以降を回答として解析する", () => {
    const entries = parseStackOverflowAtom(feedXml);

    assert.equal(entries.length, 3);
    assert.equal(entries[0]?.title, "What does the yield keyword do in Python?");
    assert.equal(entries[0]?.author, "Alex");
    assert.equal(entries[0]?.link, "https://stackoverflow.com/questions/231767/");
    assert.match(entries[0]?.bodyMarkdown ?? "", /yield/);
    assert.equal(entries[1]?.author, "Bite code");
    assert.match(entries[1]?.bodyMarkdown ?? "", /\*\*Iterables\*\*/);
  });

  it("entry のないフィードは空配列を返す", () => {
    assert.deepEqual(parseStackOverflowAtom('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), []);
  });

  it("回答は投票順で最大500件まででページングを打ち切る", async () => {
    const requests: string[] = [];
    const hundredItems = Array.from({ length: 100 }, (_, index) => ({
      body: `<p>answer ${index}</p>`,
      score: index,
      owner: { display_name: `user${index}` },
    }));
    const fetcher = soRouteFetcher(
      [
        { match: apiQuestionUrl, body: { items: [apiQuestion] } },
        { match: apiAnswersAnyPageUrl, body: { items: hundredItems, has_more: true } },
      ],
      requests,
    );

    const markdown = await fetchStackOverflowMarkdown(stackOverflowQuestionUrl, undefined, fetcher);

    assert.match(markdown, /500 retrieved/);
    assert.equal(requests.filter((url) => url.includes("/answers?")).length, 5);
  });

  it("SE API が失敗したときは質問フィードへフォールバックする", async () => {
    const requests: string[] = [];
    const fetcher = soRouteFetcher(
      [
        { match: apiQuestionUrl, status: 429, body: { error_id: 502, error_name: "throttle_violation" } },
        { match: feedUrl, body: feedXml },
      ],
      requests,
    );

    const markdown = await fetchStackOverflowMarkdown(stackOverflowQuestionUrl, undefined, fetcher);

    assert.match(markdown, /^# What does the yield keyword do in Python\?$/m);
    assert.match(markdown, /^- Author: Alex$/m);
    assert.match(markdown, /^- Permalink: https:\/\/stackoverflow\.com\/questions\/231767$/m);
    assert.match(markdown, /What does the yield keyword do\?/);
    assert.doesNotMatch(markdown, /^- (Score|Answers|Tags): /m);
    assert.match(markdown, /^Note: score, accepted and vote order are unavailable/m);
    assert.match(markdown, /^### 1\. Bite code$/m);
    assert.match(markdown, /^### 2\. Other$/m);
    assert.ok(!requests.some((url) => url.includes("/answers?")));
  });

  it("SE API と質問フィードの両方が失敗したら例外を出す", async () => {
    const fetcher = soRouteFetcher([
      { match: apiQuestionUrl, status: 429, body: { error_id: 502 } },
      { match: feedUrl, status: 503, body: "unavailable" },
    ]);

    await assert.rejects(
      fetchStackOverflowMarkdown(stackOverflowQuestionUrl, undefined, fetcher),
      /Unable to fetch StackOverflow question 231767/,
    );
  });
});

describe("fetch provider（CamoufoxTrafilaturaFetchProvider）", () => {
  it("成功結果は body が { kind: 'text', content: Markdown }、statusCode 200、truncated false", async () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async () => "# Title\n\nbody",
    });

    const result = await provider.fetch({ url: "https://example.com/page" });

    assert.deepEqual(result, {
      url: "https://example.com/page",
      statusCode: 200,
      body: { kind: "text", content: "# Title\n\nbody" },
      truncated: false,
    });
  });

  it("Reddit 投稿は permalink を url として返す", async () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async () => "# Post",
    });

    const result = await provider.fetch({
      url: "https://www.reddit.com/r/programming/comments/abc123/title/",
    });

    assert.equal(result.url, "https://www.reddit.com/r/programming/comments/abc123/title/");
  });

  it("Reddit 投稿のサブドメイン・slug 付き URL は www 付き permalink に正規化する", async () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async () => "# Post",
    });

    const result = await provider.fetch({ url: "https://old.reddit.com/r/sub/comments/xyz99/slug/" });

    assert.equal(result.url, "https://www.reddit.com/r/sub/comments/xyz99/slug/");
  });

  it("StackOverflow 質問は ID 正規化 permalink を url として返す", async () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async () => "# Question",
    });

    const result = await provider.fetch({
      url: "https://stackoverflow.com/questions/231767/some-slug?noredirect=1",
    });

    assert.equal(result.url, "https://stackoverflow.com/questions/231767");
  });

  it("経路が全滅したら WEB_PROVIDER_ERROR の WebError で失敗する", async () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async (url, signal) => {
        const { markdown } = await fetchOne(url, CAMOUFOX_DEFAULT_BASE_URL, signal, [
          failBackend<string>("camoufox+trafilatura", "render: challenge detected"),
        ]);
        return markdown;
      },
    });

    await assert.rejects(provider.fetch({ url: "https://example.com/" }), (error) => {
      assert.ok(error instanceof WebError, `expected WebError, got ${error}`);
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.match(error.message, /camoufox\+trafilatura: render: challenge detected/);
      return true;
    });
  });

  it("Reddit 経路の全滅も WEB_PROVIDER_ERROR の WebError で失敗する", async () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async (url, signal) => {
        const { markdown } = await fetchOne(url, CAMOUFOX_DEFAULT_BASE_URL, signal, [
          failBackend<string>("Reddit", "feed: all sources failed"),
        ]);
        return markdown;
      },
    });

    await assert.rejects(
      provider.fetch({ url: "https://www.reddit.com/r/programming/comments/abc123/title/" }),
      (error) => {
        assert.ok(error instanceof WebError, `expected WebError, got ${error}`);
        assert.equal(error.code, "WEB_PROVIDER_ERROR");
        assert.match(error.message, /Reddit: feed: all sources failed/);
        return true;
      },
    );
  });

  it("StackOverflow 経路の全滅も WEB_PROVIDER_ERROR の WebError で失敗する", async () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async (url, signal) => {
        const { markdown } = await fetchOne(url, CAMOUFOX_DEFAULT_BASE_URL, signal, [
          failBackend<string>("StackOverflow", "api: request failed"),
        ]);
        return markdown;
      },
    });

    await assert.rejects(
      provider.fetch({ url: "https://stackoverflow.com/questions/231767/some-slug" }),
      (error) => {
        assert.ok(error instanceof WebError, `expected WebError, got ${error}`);
        assert.equal(error.code, "WEB_PROVIDER_ERROR");
        assert.match(error.message, /StackOverflow: api: request failed/);
        return true;
      },
    );
  });

  it("camoufox server の起動待ち超過も WEB_PROVIDER_ERROR の WebError で失敗する", async () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async (url, signal) => {
        const { markdown } = await fetchOne(url, CAMOUFOX_DEFAULT_BASE_URL, signal, [
          [
            "camoufox+trafilatura",
            () =>
              camoufoxFetch(url, CAMOUFOX_DEFAULT_BASE_URL, signal, {
                probeServer: async () => false,
                spawnCamoufox: () => {},
              }),
          ],
        ]);
        return markdown;
      },
    });

    await assert.rejects(
      provider.fetch({ url: "https://example.com/" }, AbortSignal.timeout(50)),
      (error) => {
        assert.ok(error instanceof WebError, `expected WebError, got ${error}`);
        assert.equal(error.code, "WEB_PROVIDER_ERROR");
        assert.match(error.message, /camoufox server not ready/);
        return true;
      },
    );
  });

  it("id は camoufox-trafilatura", () => {
    assert.equal(new CamoufoxTrafilaturaFetchProvider(endpoints).id, FETCH_PROVIDER_ID);
    assert.equal(FETCH_PROVIDER_ID, "camoufox-trafilatura");
  });

  it("available は search provider と同一条件（前提チェックに従う）", () => {
    let met = false;
    const searchProvider = new CamoufoxOpenserpSearchProvider(endpoints, {
      prerequisitesMet: () => met,
    });
    const fetchProvider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      prerequisitesMet: () => met,
    });
    assert.equal(searchProvider.available(), fetchProvider.available());
    met = true;
    assert.equal(searchProvider.available(), fetchProvider.available());
  });
});

describe("URL 正規化（normalizedFetchUrl）", () => {
  it("Reddit 投稿は permalink、StackOverflow 質問は ID permalink、その他は入力 URL", () => {
    assert.equal(
      normalizedFetchUrl("https://old.reddit.com/r/sub/comments/abc/x/"),
      "https://www.reddit.com/r/sub/comments/abc/x/",
    );
    assert.equal(
      normalizedFetchUrl("https://stackoverflow.com/questions/123/slug"),
      "https://stackoverflow.com/questions/123",
    );
    assert.equal(normalizedFetchUrl("https://example.com/x?y=1"), "https://example.com/x?y=1");
  });
});

describe("WebError 変換（toWebError）", () => {
  it("任意のエラーは WEB_PROVIDER_ERROR の WebError になり、メッセージと cause を保つ", () => {
    const original = new Error("boom");
    const webError = toWebError(original);

    assert.ok(webError instanceof WebError);
    assert.equal(webError.code, "WEB_PROVIDER_ERROR");
    assert.equal(webError.message, "boom");
    assert.equal(webError.cause, original);
  });

  it("WebError はそのまま通す", () => {
    const original = new WebError("kept", "WEB_ABORTED");
    assert.equal(toWebError(original), original);
  });
});

// --- SPEC §"常駐サーバー" ---

describe("camoufox サーバー起動コマンド（buildCamoufoxServerSpawn）", () => {
  it("bun server.mjs をパッケージルートで detached 起動する", () => {
    const { command, args, options } = buildCamoufoxServerSpawn("ws://127.0.0.1:9999/x", "/pkg");

    assert.equal(command, "bun");
    assert.deepEqual(args, ["server.mjs"]);
    assert.equal(options.cwd, "/pkg");
    assert.equal(options.detached, true);
    // "ignore" is the build-level default; spawnCamoufoxServer replaces
    // stdout/stderr with the log fd below and falls back to this on log failure.
    assert.equal(options.stdio, "ignore");
  });

  it("既定の起動ディレクトリはパッケージルート（server.mjs の実在先）", () => {
    const { options } = buildCamoufoxServerSpawn("ws://127.0.0.1:9378/camoufox");
    assert.ok(existsSync(join(options.cwd, "server.mjs")), options.cwd);
  });

  it("解決済み接続先を子プロセスの CAMOUFOX_BASE_URL へ渡す", () => {
    const { options } = buildCamoufoxServerSpawn("ws://127.0.0.1:9999/x", "/pkg");

    assert.equal(options.env.CAMOUFOX_BASE_URL, "ws://127.0.0.1:9999/x");
  });
});

describe("camoufox server 起動（spawnCamoufoxServer）", () => {
  function withXdgCacheHome<T>(value: string, run: () => T): T {
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = value;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
    }
  }

  it("サーバーログを append で開き、その fd を子プロセスの stdout/stderr へ渡す", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "camoufox-spawn-"));
    try {
      const logPath = join(cacheRoot, "pi", "web-search", "camoufox-server.log");
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, "existing line\n");
      const calls: { stdio: unknown }[] = [];

      const spawnServer = ((command: string, _args: string[], options: SpawnOptions) => {
        calls.push({ stdio: options.stdio });
        assert.ok(Array.isArray(options.stdio), `stdio should be a tuple, got ${options.stdio}`);
        const [, stdoutFd] = options.stdio;
        assert.ok(typeof stdoutFd === "number", `stdout should be an fd number, got ${stdoutFd}`);
        // fd が append で開いたログファイル本体を指すことを、書き込みで実測する
        writeSync(stdoutFd, "spawned line\n");
      }) as typeof spawnDetachedServer;

      withXdgCacheHome(cacheRoot, () => spawnCamoufoxServer("ws://127.0.0.1:9999/x", { spawnServer }));

      assert.equal(calls.length, 1, "spawn should be called exactly once");
      const stdio = calls[0].stdio as ("ignore" | number)[];
      assert.equal(stdio[0], "ignore");
      assert.equal(stdio[2], stdio[1], "stderr should share the stdout fd");
      // 既存行が残り、fd への書き込みが追記されている = append mode
      assert.equal(readFileSync(logPath, "utf8"), "existing line\nspawned line\n");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("ログを開けなければ stdio ignore のまま起動する（サーバー出力は破棄）", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "camoufox-spawn-blocked-"));
    try {
      // XDG_CACHE_HOME に通常ファイルを指すと mkdirSync が ENOTDIR で失敗する
      const blockingFile = join(cacheRoot, "not-a-directory");
      writeFileSync(blockingFile, "file");
      const calls: { stdio: unknown }[] = [];

      const spawnServer = ((_command: string, _args: string[], options: SpawnOptions) => {
        calls.push({ stdio: options.stdio });
      }) as typeof spawnDetachedServer;

      withXdgCacheHome(blockingFile, () =>
        spawnCamoufoxServer("ws://127.0.0.1:9999/x", { spawnServer }),
      );

      assert.equal(calls.length, 1, "spawn should still run exactly once");
      assert.equal(calls[0].stdio, "ignore");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe("openserp 起動コマンド（buildOpenserpServerSpawn）", () => {
  it("openserp serve を base URL の host・port で --quiet 付きバックグラウンド起動する", () => {
    const { command, args, options } = buildOpenserpServerSpawn("http://127.0.0.1:7100");

    assert.equal(command, "openserp");
    assert.deepEqual(args, ["serve", "-a", "127.0.0.1", "-p", "7100", "--quiet"]);
    assert.equal(options.detached, true);
    assert.equal(options.stdio, "ignore");
  });
});

describe("サーバーログとヘルスチェック", () => {
  it("サーバーログは <XDG_CACHE_HOME:-~/.cache>/pi/web-search/camoufox-server.log へ追記される", () => {
    assert.equal(
      camoufoxServerLogPath({ XDG_CACHE_HOME: "/cache-root" }),
      join("/cache-root", "pi", "web-search", "camoufox-server.log"),
    );
    assert.equal(
      camoufoxServerLogPath({}),
      join(homedir(), ".cache", "pi", "web-search", "camoufox-server.log"),
    );
  });

  it("websocket 接続が成功するサーバーは健全と判定する", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, serve) {
        if (serve.upgrade(request)) return;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open() {},
        message() {},
      },
    });
    try {
      const healthy = await camoufoxServerHealthy(
        `ws://127.0.0.1:${server.port}/camoufox`,
        AbortSignal.timeout(2_000),
      );
      assert.ok(healthy);
    } finally {
      server.stop(true);
    }
  });

  it("接続できないサーバーは不健全と判定する", async () => {
    const healthy = await camoufoxServerHealthy("ws://127.0.0.1:1/camoufox", AbortSignal.timeout(2_000));
    assert.ok(!healthy);
  });

  it("起動コマンドが存在しないとき spawn の error を握り、プロセスを落とさない", async () => {
    const child = spawnDetachedServer("definitely-missing-binary-xyz", ["arg"], { stdio: "ignore" });
    // Give the error event a chance to fire; the swallowed handler in
    // spawnDetachedServer keeps it from becoming an uncaughtException.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(child);
  });
});

describe("段階別タイムアウト", () => {
  it("サーバー起動待ち・パース・変換・Reddit・StackOverflow は各15秒、描画は30秒", () => {
    assert.equal(SERVER_WAIT_TIMEOUT_MS, 15_000);
    assert.equal(RENDER_TIMEOUT_MS, 30_000);
    assert.equal(PARSE_TIMEOUT_MS, 15_000);
    assert.equal(CONVERT_TIMEOUT_MS, 15_000);
    assert.equal(REDDIT_TIMEOUT_MS, 15_000);
    assert.equal(STACKOVERFLOW_TIMEOUT_MS, 15_000);
  });
});

describe("playwright-cli 起動パラメータ", () => {
  it("CLI 引数はセッションを -s= で指定する", () => {
    assert.deepEqual(buildPlaywrightCliArgs("web-search", ["open", "https://x"]), [
      "-s=web-search",
      "open",
      "https://x",
    ]);
  });

  it("PLAYWRIGHT_MCP_CONFIG に config パスを設定し、他の変数を引き継ぐ", () => {
    const env = buildPlaywrightCliEnv({ PATH: "/bin" }, "/pkg/playwright-cli.config.json");
    assert.deepEqual(env, {
      PATH: "/bin",
      PLAYWRIGHT_MCP_CONFIG: "/pkg/playwright-cli.config.json",
    });
  });

  it("config パスはパッケージルート内の playwright-cli.config.json", () => {
    assert.equal(playwrightCliConfigPath("/pkg"), "/pkg/playwright-cli.config.json");
  });
});

describe("playwright-cli config の接続先反映", () => {
  it("config JSON は接続先（camoufoxBaseUrl）を remoteEndpoint に反映する", () => {
    assert.deepEqual(JSON.parse(playwrightCliConfigJson("ws://127.0.0.1:9999/x")), {
      browser: { browserName: "firefox", remoteEndpoint: "ws://127.0.0.1:9999/x" },
    });
  });

  it("syncPlaywrightCliConfig は指定ディレクトリの config を接続先に合わせて書き込む", () => {
    const configDirectory = mkdtempSync(join(tmpdir(), "websearch-config-"));
    try {
      syncPlaywrightCliConfig(configDirectory, "ws://127.0.0.1:9999/x");
      const written = readFileSync(join(configDirectory, "playwright-cli.config.json"), "utf8");
      assert.deepEqual(JSON.parse(written), {
        browser: { browserName: "firefox", remoteEndpoint: "ws://127.0.0.1:9999/x" },
      });
    } finally {
      rmSync(configDirectory, { recursive: true, force: true });
    }
  });

  it("書き込み失敗しても例外を出さない（既存 config で続行）", () => {
    assert.doesNotThrow(() => syncPlaywrightCliConfig("/nonexistent-dir-zzz", "ws://x"));
  });
});

describe("plugin 適用時の先行起動（primeServers）", () => {
  const okResponse = (): Response => new Response(null, { status: 200 });
  const failingFetcher = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const okFetcher = (async () => okResponse()) as unknown as typeof fetch;

  it("openserp が未起動なら openserp だけを起動する", async () => {
    const spawned: string[] = [];
    await primeServers(endpoints, {
      fetcher: failingFetcher,
      spawnOpenserp: (baseUrl) => spawned.push(`openserp:${baseUrl}`),
      probeCamoufox: async () => true,
      spawnCamoufox: (baseUrl) => spawned.push(`camoufox:${baseUrl}`),
    });

    assert.deepEqual(spawned, [`openserp:${OPENSERP_DEFAULT_BASE_URL}`]);
  });

  it("camoufox が未起動なら camoufox だけを起動する", async () => {
    const spawned: string[] = [];
    await primeServers(endpoints, {
      fetcher: okFetcher,
      spawnOpenserp: (baseUrl) => spawned.push(`openserp:${baseUrl}`),
      probeCamoufox: async () => false,
      spawnCamoufox: (baseUrl) => spawned.push(`camoufox:${baseUrl}`),
    });

    assert.deepEqual(spawned, [`camoufox:${CAMOUFOX_DEFAULT_BASE_URL}`]);
  });

  it("両方未起動なら両方を起動する", async () => {
    const spawned: string[] = [];
    await primeServers(endpoints, {
      fetcher: failingFetcher,
      spawnOpenserp: (baseUrl) => spawned.push(`openserp:${baseUrl}`),
      probeCamoufox: async () => false,
      spawnCamoufox: (baseUrl) => spawned.push(`camoufox:${baseUrl}`),
    });

    assert.deepEqual(spawned, [
      `openserp:${OPENSERP_DEFAULT_BASE_URL}`,
      `camoufox:${CAMOUFOX_DEFAULT_BASE_URL}`,
    ]);
  });

  it("両方起動済みなら何も起動しない", async () => {
    const spawned: string[] = [];
    await primeServers(endpoints, {
      fetcher: okFetcher,
      spawnOpenserp: (baseUrl) => spawned.push(`openserp:${baseUrl}`),
      probeCamoufox: async () => true,
      spawnCamoufox: (baseUrl) => spawned.push(`camoufox:${baseUrl}`),
    });

    assert.deepEqual(spawned, []);
  });

  it("openserp 側の失敗は camoufox の先行起動を妨げない", async () => {
    const spawned: string[] = [];
    await primeServers(endpoints, {
      fetcher: failingFetcher,
      spawnOpenserp: () => {
        throw new Error("spawn failed");
      },
      probeCamoufox: async () => false,
      spawnCamoufox: (baseUrl) => spawned.push(`camoufox:${baseUrl}`),
    });

    assert.deepEqual(spawned, [`camoufox:${CAMOUFOX_DEFAULT_BASE_URL}`]);
  });

  it("先行起動の失敗は解決し、後続処理に影響させない", async () => {
    const boomFetcher = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await primeServers(endpoints, {
      fetcher: boomFetcher,
      spawnOpenserp: () => {
        throw new Error("boom");
      },
      probeCamoufox: async () => {
        throw new Error("boom");
      },
      spawnCamoufox: () => {
        throw new Error("boom");
      },
    });
  });

  it("解決済み接続先に対して probe・spawn する", async () => {
    const spawned: string[] = [];
    const custom = resolveEndpoints(
      { camoufoxBaseUrl: "ws://127.0.0.1:9999/x", openserpBaseUrl: "http://127.0.0.1:7100" },
      {},
    );
    await primeServers(custom, {
      fetcher: failingFetcher,
      spawnOpenserp: (baseUrl) => spawned.push(`openserp:${baseUrl}`),
      probeCamoufox: async (baseUrl) => {
        spawned.push(`probe:${baseUrl}`);
        return false;
      },
      spawnCamoufox: (baseUrl) => spawned.push(`camoufox:${baseUrl}`),
    });

    assert.deepEqual(spawned, [
      "openserp:http://127.0.0.1:7100",
      "probe:ws://127.0.0.1:9999/x",
      "camoufox:ws://127.0.0.1:9999/x",
    ]);
  });
});

// --- SPEC §"同種リクエストの直列化" ---

describe("同種リクエストの直列化（provider キュー）", () => {
  it("先行の web_search が完了するまで次の web_search を開始しない", async () => {
    const firstSearchCompletion = createDeferred<WebSearchSource[]>();
    const started: string[] = [];
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, {
      search: async (query) => {
        started.push(query);
        return query === "first" ? firstSearchCompletion.promise : [{ url: `https://${query}/` }];
      },
    });

    const firstRequest = provider.search({ query: "first" });
    const secondRequest = provider.search({ query: "second" });

    await Promise.resolve();
    assert.deepEqual(started, ["first"]);

    firstSearchCompletion.resolve([{ url: "https://first/" }]);
    await Promise.all([firstRequest, secondRequest]);

    assert.deepEqual(started, ["first", "second"]);
  });

  it("先行の web_search が失敗しても次の web_search を開始する", async () => {
    const started: string[] = [];
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, {
      search: async (query) => {
        started.push(query);
        if (query === "first") throw new Error("first search failed");
        return [{ url: `https://${query}/` }];
      },
    });

    const failedRequest = provider.search({ query: "first" });
    const secondRequest = provider.search({ query: "second" });

    await assert.rejects(failedRequest, /first search failed/);
    await secondRequest;

    assert.deepEqual(started, ["first", "second"]);
  });

  it("先行の web_fetch が完了するまで次の web_fetch を開始しない", async () => {
    const firstFetchCompletion = createDeferred<string>();
    const started: string[] = [];
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async (url) => {
        started.push(url);
        return url.endsWith("first") ? firstFetchCompletion.promise : `md:${url}`;
      },
    });

    const firstRequest = provider.fetch({ url: "https://example.com/first" });
    const secondRequest = provider.fetch({ url: "https://example.com/second" });

    await Promise.resolve();
    assert.deepEqual(started, ["https://example.com/first"]);

    firstFetchCompletion.resolve("md:first");
    await Promise.all([firstRequest, secondRequest]);

    assert.deepEqual(started, ["https://example.com/first", "https://example.com/second"]);
  });

  it("先行の web_fetch が失敗しても次の web_fetch を開始する", async () => {
    const started: string[] = [];
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async (url) => {
        started.push(url);
        if (url.endsWith("first")) throw new Error("first fetch failed");
        return `md:${url}`;
      },
    });

    const failedRequest = provider.fetch({ url: "https://example.com/first" });
    const secondRequest = provider.fetch({ url: "https://example.com/second" });

    await assert.rejects(failedRequest, /first fetch failed/);
    await secondRequest;

    assert.deepEqual(started, ["https://example.com/first", "https://example.com/second"]);
  });

  it("web_search と web_fetch は互いに並行で実行できる", async () => {
    const searchCompletion = createDeferred<WebSearchSource[]>();
    const fetchCompletion = createDeferred<string>();
    const started: string[] = [];
    const searchProvider = new CamoufoxOpenserpSearchProvider(endpoints, {
      search: async () => {
        started.push("web_search");
        return searchCompletion.promise;
      },
    });
    const fetchProvider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      fetch: async () => {
        started.push("web_fetch");
        return fetchCompletion.promise;
      },
    });

    const searchRequest = searchProvider.search({ query: "query" });
    const fetchRequest = fetchProvider.fetch({ url: "https://example.com/" });

    await Promise.resolve();
    assert.deepEqual([...started].sort(), ["web_fetch", "web_search"]);

    searchCompletion.resolve([{ url: "https://example.com/" }]);
    fetchCompletion.resolve("md");
    await Promise.all([searchRequest, fetchRequest]);
  });

  it("multi-query の web_search も provider 内部の直列化により1件ずつ実行する", async () => {
    // dsh-tool-web fans multiple queries out as parallel provider.search calls;
    // the provider serializes them (same mechanism as the two-search case).
    const started: string[] = [];
    let releaseFirst!: (sources: WebSearchSource[]) => void;
    const firstCompletion = new Promise<WebSearchSource[]>((resolve) => {
      releaseFirst = resolve;
    });
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, {
      search: async (query) => {
        started.push(query);
        return query === "q1" ? firstCompletion : [{ url: `https://${query}/` }];
      },
    });

    const running = ["q1", "q2", "q3"].map((query) => provider.search({ query }));
    await Promise.resolve();
    assert.deepEqual(started, ["q1"]);

    releaseFirst([{ url: "https://q1/" }]);
    await Promise.all(running);

    assert.deepEqual(started, ["q1", "q2", "q3"]);
  });
});

// --- SPEC §"提供する plugin" ---

describe("提供する plugin（entry exports・apply）", () => {
  function captureRegistry() {
    const searchProviders: WebSearchProvider[] = [];
    const fetchProviders: WebFetchProvider[] = [];
    return {
      searchProviders,
      fetchProviders,
      ctx: {
        web: {
          registerSearchProvider: (provider: WebSearchProvider) => searchProviders.push(provider),
          registerFetchProvider: (provider: WebFetchProvider) => fetchProviders.push(provider),
        },
      } as never,
    };
  }

  const noopPrime = () => Promise.resolve();

  it("export する name は dsh-web-search、inject は [\"web\"]", () => {
    assert.equal(name, "dsh-web-search");
    assert.deepEqual(inject, ["web"]);
  });

  it("apply は search・fetch 両 provider を ctx.web へ登録する", () => {
    const { ctx, searchProviders, fetchProviders } = captureRegistry();

    apply(ctx, {}, { prime: noopPrime });

    assert.equal(searchProviders.length, 1);
    assert.equal(searchProviders[0]?.id, SEARCH_PROVIDER_ID);
    assert.equal(fetchProviders.length, 1);
    assert.equal(fetchProviders[0]?.id, FETCH_PROVIDER_ID);
  });

  it("apply は camoufox server と openserp の先行起動を1回だけ開始する（完了を待たない）", () => {
    const { ctx } = captureRegistry();
    const primed: ServerEndpoints[] = [];

    apply(ctx, {}, { prime: (resolved) => (primed.push(resolved), Promise.resolve()) });

    assert.equal(primed.length, 1);
  });

  it("apply の先行起動は解決済み接続先（config > env > 既定）で行う", () => {
    const { ctx } = captureRegistry();
    const primed: ServerEndpoints[] = [];

    apply(
      ctx,
      { camoufoxBaseUrl: "ws://cfg:1/x" },
      {
        prime: (resolved) => {
          primed.push(resolved);
          return Promise.resolve();
        },
      },
    );

    assert.deepEqual(primed, [
      { camoufoxBaseUrl: "ws://cfg:1/x", openserpBaseUrl: OPENSERP_DEFAULT_BASE_URL },
    ]);
  });

  it("パッケージ名は dotfiles-dsh-web-search、cordis 行 id は dsh-web-search", () => {
    const packageRoot = dirname(new URL(".", import.meta.url).pathname);
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { name?: string };
    const patchYml = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");

    assert.equal(packageJson.name, "dotfiles-dsh-web-search");
    assert.match(patchYml, /^\s*- id: dsh-web-search$/m);
    assert.match(patchYml, /^\s*name: dotfiles-dsh-web-search$/m);
  });

  it("server.mjs は bundle 外にパッケージルートへ同梱する", () => {
    const packageRoot = dirname(new URL(".", import.meta.url).pathname);

    assert.ok(existsSync(join(packageRoot, "server.mjs")), "server.mjs must ship in the package root");
  });
});
