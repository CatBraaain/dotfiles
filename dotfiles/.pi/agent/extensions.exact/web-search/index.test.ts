import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import webSearchExtension, {
  buildCamofoxServerSpawn,
  buildOpenserpServerSpawn,
  camofoxBaseUrl,
  camofoxFetch,
  camofoxOpenserpSearch,
  camofoxRender,
  camofoxServerEnv,
  CONVERT_TIMEOUT_MS,
  defaultFetchBackends,
  fetchRedditMarkdown,
  openserpBaseUrl,
  openserpParse,
  defaultSearchBackends,
  fetchOne,
  formatBackendLine,
  formatBackendLines,
  PARSE_TIMEOUT_MS,
  parseRedditAtom,
  parseRedditEmbed,
  parseRedditOEmbed,
  parseRedditPostUrl,
  REDDIT_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  searchOne,
  SERVER_WAIT_TIMEOUT_MS,
  serpUrl,
  titleFromMarkdown,
  type Attempt,
  type BackendEntry,
  type WebToolOperations,
} from "./index";

type Tool = {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (...args: any[]) => Promise<unknown>;
  renderCall: (...args: any[]) => { render(width: number): string[] };
  renderResult: (...args: any[]) => { render(width: number): string[] };
};

function captureTools(operations?: WebToolOperations): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  webSearchExtension(
    { registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never,
    operations,
  );
  return tools;
}

type WebOperationResult = Awaited<ReturnType<typeof searchOne>>;

function createWebToolOperations(overrides: Partial<WebToolOperations>): WebToolOperations {
  return { search: searchOne, fetch: fetchOne, ...overrides };
}

function successfulOperationResult(input: string): WebOperationResult {
  return {
    text: `result for ${input}`,
    backend: "test",
    attempts: [{ backend: "test", ok: true }],
  };
}

function createDeferred<Result>() {
  let resolve!: (value: Result | PromiseLike<Result>) => void;
  const promise = new Promise<Result>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.find((item) => item.type === "text")?.text ?? "";
}

function okBackend(name: string, text = `text from ${name}`): BackendEntry {
  return [name, async () => text];
}

function failBackend(name: string, message = `${name} error`): BackendEntry {
  return [
    name,
    async () => {
      throw new Error(message);
    },
  ];
}

function renderedLines(component: { render(width: number): string[] }): string[] {
  return component.render(80).map((line) => line.trim());
}

const identityTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const tools = captureTools();
const search = tools.get("web_search")!;
const fetchTool = tools.get("web_fetch")!;

const executionContext = { hasUI: true, ui: { notify: () => {} } };

async function callSearch(
  query: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<unknown> {
  return search.execute("call", { query }, signal, undefined, executionContext);
}

async function callFetch(
  url: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<unknown> {
  return fetchTool.execute("call", { url }, signal, undefined, executionContext);
}

describe("tool request queues", () => {
  it("starts the next web_search after the preceding search completes", async () => {
    const firstSearchCompletion = createDeferred<WebOperationResult>();
    const searchStartOrder: string[] = [];
    const queuedSearch = captureTools(
      createWebToolOperations({
        search: async (query) => {
          searchStartOrder.push(query);
          return query === "first"
            ? firstSearchCompletion.promise
            : successfulOperationResult(query);
        },
      }),
    ).get("web_search")!;

    const firstRequest = queuedSearch.execute("first", { query: "first" });
    const secondRequest = queuedSearch.execute("second", { query: "second" });

    await Promise.resolve();
    assert.deepEqual(searchStartOrder, ["first"]);

    firstSearchCompletion.resolve(successfulOperationResult("first"));
    await Promise.all([firstRequest, secondRequest]);

    assert.deepEqual(searchStartOrder, ["first", "second"]);
  });

  it("starts the next web_search after the preceding search fails", async () => {
    const searchStartOrder: string[] = [];
    const queuedSearch = captureTools(
      createWebToolOperations({
        search: async (query) => {
          searchStartOrder.push(query);
          if (query === "first") throw new Error("first search failed");
          return successfulOperationResult(query);
        },
      }),
    ).get("web_search")!;

    const failedRequest = queuedSearch.execute("first", { query: "first" });
    const secondRequest = queuedSearch.execute("second", { query: "second" });

    await assert.rejects(failedRequest, /first search failed/);
    await secondRequest;

    assert.deepEqual(searchStartOrder, ["first", "second"]);
  });

  it("starts the next web_fetch after the preceding fetch completes", async () => {
    const firstFetchCompletion = createDeferred<WebOperationResult>();
    const fetchStartOrder: string[] = [];
    const queuedFetch = captureTools(
      createWebToolOperations({
        fetch: async (url) => {
          fetchStartOrder.push(url);
          return url.endsWith("first")
            ? firstFetchCompletion.promise
            : successfulOperationResult(url);
        },
      }),
    ).get("web_fetch")!;

    const firstRequest = queuedFetch.execute("first", { url: "https://example.com/first" });
    const secondRequest = queuedFetch.execute("second", { url: "https://example.com/second" });

    await Promise.resolve();
    assert.deepEqual(fetchStartOrder, ["https://example.com/first"]);

    firstFetchCompletion.resolve(successfulOperationResult("first"));
    await Promise.all([firstRequest, secondRequest]);

    assert.deepEqual(fetchStartOrder, ["https://example.com/first", "https://example.com/second"]);
  });

  it("starts the next web_fetch after the preceding fetch fails", async () => {
    const fetchStartOrder: string[] = [];
    const queuedFetch = captureTools(
      createWebToolOperations({
        fetch: async (url) => {
          fetchStartOrder.push(url);
          if (url.endsWith("first")) throw new Error("first fetch failed");
          return successfulOperationResult(url);
        },
      }),
    ).get("web_fetch")!;

    const failedRequest = queuedFetch.execute("first", { url: "https://example.com/first" });
    const secondRequest = queuedFetch.execute("second", { url: "https://example.com/second" });

    await assert.rejects(failedRequest, /first fetch failed/);
    await secondRequest;

    assert.deepEqual(fetchStartOrder, ["https://example.com/first", "https://example.com/second"]);
  });

  it("starts web_search and web_fetch independently", async () => {
    const searchCompletion = createDeferred<WebOperationResult>();
    const fetchCompletion = createDeferred<WebOperationResult>();
    const startedTools: string[] = [];
    const queuedTools = captureTools(
      createWebToolOperations({
        search: async () => {
          startedTools.push("web_search");
          return searchCompletion.promise;
        },
        fetch: async () => {
          startedTools.push("web_fetch");
          return fetchCompletion.promise;
        },
      }),
    );

    const searchRequest = queuedTools.get("web_search")!.execute("search", { query: "query" });
    const fetchRequest = queuedTools
      .get("web_fetch")!
      .execute("fetch", { url: "https://example.com/" });

    await Promise.resolve();
    assert.deepEqual(startedTools.sort(), ["web_fetch", "web_search"]);

    searchCompletion.resolve(successfulOperationResult("query"));
    fetchCompletion.resolve(successfulOperationResult("https://example.com/"));
    await Promise.all([searchRequest, fetchRequest]);
  });
});

describe("web_search 単体（searchOne・モックバックエンド）", () => {
  it("失敗バックエンドを順に飛ばし、最初の成功バックエンドで本文とその名前を返す", async () => {
    const backends = [failBackend("A"), failBackend("B"), okBackend("C"), okBackend("D")];
    const result = await searchOne("query", undefined, backends);
    assert.equal(result.backend, "C");
    assert.equal(result.text, "text from C");
  });

  it("試行ごとの成否を attempts に記録し、最後は成功バックエンドになる", async () => {
    const backends = [failBackend("A"), failBackend("B"), okBackend("C")];
    const result = await searchOne("query", undefined, backends);
    assert.deepEqual(result.attempts, [
      { backend: "A", ok: false, error: "A error" },
      { backend: "B", ok: false, error: "B error" },
      { backend: "C", ok: true },
    ]);
  });

  it("失敗バックエンドのエラー文は本文に含まず、attempts だけに含む", async () => {
    const backends = [failBackend("A", "致命的エラー文"), okBackend("B", "成功本文")];
    const result = await searchOne("query", undefined, backends);
    assert.equal(result.text, "成功本文");
    assert.ok(!result.text.includes("致命的エラー文"));
    assert.ok(
      result.attempts.some((attempt) => !attempt.ok && attempt.error.includes("致命的エラー文")),
    );
  });

  it("全バックエンドが失敗したら例外を出す", async () => {
    const backends = [failBackend("A"), failBackend("B")];
    await assert.rejects(searchOne("query", undefined, backends), /All web search backends failed/);
  });

  it("成功バックエンドの本文をそのまま返す", async () => {
    const expectedText = "そのまま渡される本文";
    const backends = [okBackend("A", expectedText)];
    const result = await searchOne("query", undefined, backends);
    assert.equal(result.text, expectedText);
  });

  it("空の本文を返すバックエンドは失敗として次へフォールバックする", async () => {
    const backends = [okBackend("A", ""), okBackend("B", "本文")];
    const result = await searchOne("query", undefined, backends);
    assert.equal(result.backend, "B");
    assert.deepEqual(result.attempts[0], { backend: "A", ok: false, error: "empty response" });
  });

  it("空白・改行のみの本文も空として失敗扱いにする", async () => {
    const backends = [okBackend("A", " \n\t "), okBackend("B", "本文")];
    const result = await searchOne("query", undefined, backends);
    assert.equal(result.backend, "B");
    assert.deepEqual(result.attempts[0], { backend: "A", ok: false, error: "empty response" });
  });

  it("デフォルトのバックエンド順序は camofox+openserp(google)→duckduckgo→bing", () => {
    const backendNames = defaultSearchBackends("query").map(([name]) => name);
    assert.deepEqual(backendNames, [
      "camofox+openserp(google)",
      "camofox+openserp(duckduckgo)",
      "camofox+openserp(bing)",
    ]);
  });
});

describe("web_search 統合（execute 経由・実バックエンド）", () => {
  it("パラメータは query と lang（任意）で、複数一括クエリはサポートしない", () => {
    const parameterKeys = Object.keys(search.parameters.properties);
    assert.deepEqual(parameterKeys, ["query", "lang"]);
  });

  it("検索結果は最大10件を出力し、件数が実バックエンドの結果数に満たないこともある", async () => {
    const resultText = textOf(await callSearch("pi coding agent", AbortSignal.timeout(120_000)));
    const headings = resultText.match(/^#{2,3} \d+\./gm) ?? [];
    assert.ok(headings.length > 0);
    assert.ok(headings.length <= 10);
  }, 150_000);

  it("失敗したバックエンドも次の検索で再試行する", async () => {
    const attemptsPerSearch: string[][] = [];
    const backends = [
      [
        "A",
        async () => {
          attemptsPerSearch.push(["A"]);
          throw new Error("A error");
        },
      ],
      [
        "B",
        async () => {
          attemptsPerSearch[attemptsPerSearch.length - 1]?.push("B");
          throw new Error("B error");
        },
      ],
    ] satisfies BackendEntry[];

    await assert.rejects(searchOne("query", undefined, backends));
    await assert.rejects(searchOne("query", undefined, backends));

    assert.deepEqual(attemptsPerSearch, [
      ["A", "B"],
      ["A", "B"],
    ]);
  });

  it("実バックエンドで検索が成功する", async () => {
    const resultText = textOf(await callSearch("hello world", AbortSignal.timeout(120_000)));
    assert.ok(resultText.length > 0);
  }, 150_000);
});

describe("web_search 表示", () => {
  it("コール行は入力を添えて 'web_search - \"<query>\"' を出す", () => {
    const lines = renderedLines(search.renderCall({ query: "pi coding agent" }, identityTheme));
    assert.equal(lines[0], 'web_search - "pi coding agent"');
  });

  it("コール行は lang 指定時に [lang=<lang>] を付ける", () => {
    const lines = renderedLines(search.renderCall({ query: "pi", lang: "JA" }, identityTheme));
    assert.equal(lines[0], 'web_search - "pi" [lang=JA]');
  });

  it("結果行は試したバックエンドごとに ✓/✗ 行を出す", () => {
    const attempts: Attempt[] = [
      { backend: "openserp(google)", ok: false, error: "captcha detected" },
      { backend: "openserp(bing)", ok: true },
    ];
    const result = {
      content: [{ type: "text", text: "結果本文" }],
      details: { backend: "openserp(bing)", attempts },
    };
    const lines = renderedLines(search.renderResult(result));
    assert.deepEqual(lines, ['✗ openserp(google) - "captcha detected"', "✓ openserp(bing)"]);
  });

  it("全バックエンド失敗時も renderResult が失敗行を表示する", () => {
    const attempts: Attempt[] = [
      { backend: "openserp(google)", ok: false, error: "captcha detected" },
      { backend: "openserp(bing)", ok: false, error: "timeout" },
    ];
    const lines = renderedLines(
      search.renderResult(
        { content: [{ type: "text", text: "All failed" }], details: undefined },
        {},
        identityTheme,
        { state: { attempts } },
      ),
    );
    assert.deepEqual(lines, [
      '✗ openserp(google) - "captcha detected"',
      '✗ openserp(bing) - "timeout"',
    ]);
  });
});

describe("web_fetch 単体（fetchOne・モックバックエンド）", () => {
  it("失敗バックエンドを順に飛ばし、最初の成功バックエンドで本文とその名前を返す", async () => {
    const backends = [failBackend("A"), failBackend("B"), okBackend("C"), okBackend("D")];
    const result = await fetchOne("https://example.com/", undefined, backends);
    assert.equal(result.backend, "C");
    assert.equal(result.text, "text from C");
  });

  it("試行ごとの成否を attempts に記録し、最後は成功バックエンドになる", async () => {
    const backends = [failBackend("A"), failBackend("B"), okBackend("C")];
    const result = await fetchOne("https://example.com/", undefined, backends);
    assert.deepEqual(result.attempts, [
      { backend: "A", ok: false, error: "A error" },
      { backend: "B", ok: false, error: "B error" },
      { backend: "C", ok: true },
    ]);
  });

  it("失敗フェッチャーのエラー文は本文に含まず、attempts だけに含む", async () => {
    const backends = [failBackend("A", "致命的エラー文"), okBackend("B", "成功本文")];
    const result = await fetchOne("https://example.com/", undefined, backends);
    assert.equal(result.text, "成功本文");
    assert.ok(!result.text.includes("致命的エラー文"));
    assert.ok(
      result.attempts.some((attempt) => !attempt.ok && attempt.error.includes("致命的エラー文")),
    );
  });

  it("全バックエンド失敗時にすべての失敗を記録して例外を出す", async () => {
    const backends = [failBackend("X"), failBackend("Y")];
    await assert.rejects(
      fetchOne("https://example.com/", undefined, backends),
      /All web fetch backends failed.*X: X error.*Y: Y error/,
    );
  });

  it("空の本文を返すバックエンドは失敗として次へフォールバックする", async () => {
    const backends = [okBackend("A", ""), okBackend("B", "本文")];
    const result = await fetchOne("https://example.com/", undefined, backends);
    assert.equal(result.backend, "B");
    assert.deepEqual(result.attempts[0], { backend: "A", ok: false, error: "empty response" });
  });

  it("空白・改行のみの本文も空として失敗扱いにする", async () => {
    const backends = [okBackend("A", " \n\t "), okBackend("B", "本文")];
    const result = await fetchOne("https://example.com/", undefined, backends);
    assert.equal(result.backend, "B");
    assert.deepEqual(result.attempts[0], { backend: "A", ok: false, error: "empty response" });
  });

  it("デフォルトのバックエンド順序は camofox+trafilatura のみ", () => {
    const backendNames = defaultFetchBackends("https://example.com/").map(([name]) => name);
    assert.deepEqual(backendNames, ["camofox+trafilatura"]);
  });
});

describe("web_fetch 統合（execute 経由・実バックエンド）", () => {
  it("パラメータは url のみで、複数一括フェッチはサポートしない", () => {
    const parameterKeys = Object.keys(fetchTool.parameters.properties);
    assert.deepEqual(parameterKeys, ["url"]);
  });

  it("実バックエンドでフェッチが成功する", async () => {
    const resultText = textOf(
      await callFetch("https://example.com/", AbortSignal.timeout(120_000)),
    );
    assert.ok(resultText.length > 0);
  }, 150_000);
});

describe("バックエンド結果行のフォーマット", () => {
  it("成功（タイトルなし）は '✓ <バックエンド>' を返す", () => {
    assert.equal(formatBackendLine({ backend: "openserp(bing)", ok: true }), "✓ openserp(bing)");
  });

  it("成功（タイトルあり）は '✓ <バックエンド> - \"<タイトル>\"' を返す", () => {
    const line = formatBackendLine({ backend: "trafilatura", ok: true }, "Example");
    assert.equal(line, '✓ trafilatura - "Example"');
  });

  it("失敗はタイトルの有無に関わらず '✗ <バックエンド> - \"<エラー>\"' を返す", () => {
    const line = formatBackendLine(
      { backend: "openserp(google)", ok: false, error: "captcha detected" },
      "Example",
    );
    assert.equal(line, '✗ openserp(google) - "captcha detected"');
  });

  it("formatBackendLines は成功にだけタイトルを付け、失敗行には付けない", () => {
    const attempts: Attempt[] = [
      { backend: "openserp(google)", ok: false, error: "captcha detected" },
      { backend: "openserp(bing)", ok: true },
    ];
    assert.deepEqual(formatBackendLines(attempts, "成功タイトル"), [
      '✗ openserp(google) - "captcha detected"',
      '✓ openserp(bing) - "成功タイトル"',
    ]);
  });
});

describe("SERP URL 構築", () => {
  it("クエリを q パラメータへ URL エンコードする", () => {
    assert.equal(serpUrl("bing", "hello world"), "https://www.bing.com/search?q=hello+world");
    assert.equal(serpUrl("google", "a&b=c"), "https://www.google.com/search?q=a%26b%3Dc");
  });

  it("lang 指定時は各エンジンの言語パラメータへ反映する（大文字でも小文字に正規化）", () => {
    assert.equal(serpUrl("bing", "query", "JA"), "https://www.bing.com/search?q=query&mkt=ja-JP");
    assert.equal(serpUrl("duckduckgo", "query", "JA"), "https://duckduckgo.com/?q=query&kl=jp-ja");
    assert.equal(
      serpUrl("google", "query", "JA"),
      "https://www.google.com/search?q=query&hl=ja&gl=jp",
    );
  });

  it("lang 未指定時は言語パラメータを付けない", () => {
    assert.equal(serpUrl("google", "query"), "https://www.google.com/search?q=query");
  });

  it("対応する値のない lang は指定なしとして扱う", () => {
    assert.equal(serpUrl("bing", "query", "xx"), "https://www.bing.com/search?q=query");
    assert.equal(serpUrl("duckduckgo", "query", "xx"), "https://duckduckgo.com/?q=query");
    // google は hl に lang を直接渡し、gl は対応国があるときだけ付く
    assert.equal(serpUrl("google", "query", "sv"), "https://www.google.com/search?q=query&hl=sv");
  });
});

describe("段階別タイムアウト", () => {
  it("サーバー起動待ち・パース・変換・Reddit は各15秒、描画は30秒", () => {
    assert.equal(SERVER_WAIT_TIMEOUT_MS, 15_000);
    assert.equal(RENDER_TIMEOUT_MS, 30_000);
    assert.equal(PARSE_TIMEOUT_MS, 15_000);
    assert.equal(CONVERT_TIMEOUT_MS, 15_000);
    assert.equal(REDDIT_TIMEOUT_MS, 15_000);
  });
});

describe("web_fetch 表示", () => {
  it("コール行は入力を添えて 'web_fetch - \"<url>\"' を出す", () => {
    const lines = renderedLines(
      fetchTool.renderCall({ url: "https://example.com/" }, identityTheme),
    );
    assert.equal(lines[0], 'web_fetch - "https://example.com/"');
  });

  it("結果行は成功バックエンドにだけタイトルを付ける", () => {
    const attempts: Attempt[] = [
      { backend: "trafilatura", ok: false, error: "timeout" },
      { backend: "camofox+trafilatura", ok: true },
    ];
    const result = {
      content: [{ type: "text", text: "本文" }],
      details: { backend: "camofox+trafilatura", attempts, title: "Example Page" },
    };
    const lines = renderedLines(fetchTool.renderResult(result));
    assert.deepEqual(lines, [
      '✗ trafilatura - "timeout"',
      '✓ camofox+trafilatura - "Example Page"',
    ]);
  });

  it("結果行はタイトルがない成功バックエンドにはタイトルを付けない", () => {
    const attempts: Attempt[] = [{ backend: "camofox+trafilatura", ok: true }];
    const result = {
      content: [{ type: "text", text: "本文" }],
      details: { backend: "camofox+trafilatura", attempts, title: null },
    };
    const lines = renderedLines(fetchTool.renderResult(result));
    assert.deepEqual(lines, ["✓ camofox+trafilatura"]);
  });

  it("全バックエンド失敗時、execute は onUpdate へ attempts を渡し結果行に失敗行を出す", async () => {
    const failedFetch = captureTools(
      createWebToolOperations({
        fetch: (url, signal) => fetchOne(url, signal, [failBackend("X", "boom")]),
      }),
    ).get("web_fetch")!;
    const updates: Array<{ details?: { attempts?: Attempt[] } }> = [];

    await assert.rejects(
      failedFetch.execute(
        "call",
        { url: "https://example.com/" },
        AbortSignal.timeout(30_000),
        (update) => updates.push(update),
        executionContext,
      ),
      /All web fetch backends failed/,
    );

    const attempts = updates[0]?.details?.attempts;
    assert.deepEqual(attempts, [{ backend: "X", ok: false, error: "boom" }]);
    const lines = renderedLines(
      failedFetch.renderResult({ content: [], details: undefined }, {}, identityTheme, {
        state: { attempts },
      }),
    );
    assert.deepEqual(lines, ['✗ X - "boom"']);
  });
});

describe("web_fetch のタイトル抽出", () => {
  it("h1 見出し（# <タイトル>）からタイトルを取り出す", () => {
    assert.equal(titleFromMarkdown("# Hello World\n\nbody text"), "Hello World");
  });

  it("`## <数字>. <タイトル>` 形式の見出しもタイトルとして取り出す", () => {
    assert.equal(titleFromMarkdown("## 1. First Result\n\nbody text"), "First Result");
  });

  it("`### <数字>. <タイトル>` 形式の見出しもタイトルとして取り出す", () => {
    assert.equal(titleFromMarkdown("### 2. Second Result\n\nbody text"), "Second Result");
  });

  it("h1 と数字見出しが両方ある本文は h1 を優先する", () => {
    assert.equal(titleFromMarkdown("# Page Title\n\n## 1. First Result"), "Page Title");
  });

  it("タイトル候補の見出しがない本文は null を返す", () => {
    assert.equal(titleFromMarkdown("plain body\n\n## no numbered heading\ntail"), null);
  });
});

const redditPostUrl = "https://www.reddit.com/r/programming/comments/abc123/test_post/";

// Reddit Atom 実形式に合わせたフィクスチャ（content は HTML エスケープ、本文は Markdown 構文込み）
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

describe("Reddit URL 判定", () => {
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

  it("reddit.com 以外のホスト（notreddit.com）は対象外", () => {
    assert.equal(
      parseRedditPostUrl("https://notreddit.com/r/programming/comments/abc123/title/"),
      undefined,
    );
  });

  it("サブレディット一覧・ユーザーページ・他サイトは対象外", () => {
    assert.equal(parseRedditPostUrl("https://www.reddit.com/r/programming/"), undefined);
    assert.equal(parseRedditPostUrl("https://www.reddit.com/user/SampleAuthor"), undefined);
    assert.equal(
      parseRedditPostUrl("https://example.com/r/programming/comments/abc123/x/"),
      undefined,
    );
  });
});

describe("Reddit Atom パース", () => {
  const parsed = parseRedditAtom(redditAtomFixture)!;

  it("投稿（t3_）のタイトル・作者・更新時刻を取り出す", () => {
    assert.equal(parsed.post.title, "Announcement: We've Updated The Rules");
    assert.equal(parsed.post.author, "u/SampleAuthor");
    assert.equal(parsed.post.updated, "2026-05-23T13:54:37+00:00");
    assert.equal(parsed.post.permalink, redditPostUrl);
  });

  it("投稿本文をリンクと引用を保った Markdown に変換する", () => {
    assert.match(parsed.post.bodyMarkdown, /Hello \[world\]\(https:\/\/example\.com\/page\/\)\./);
    assert.match(parsed.post.bodyMarkdown, /^> Quoted & cited$/m);
  });

  it("コメント（t1_）を本文ごと列挙する", () => {
    assert.equal(parsed.comments.length, 1);
    assert.equal(parsed.comments[0]?.author, "u/Commenter");
    assert.match(parsed.comments[0]?.bodyMarkdown ?? "", /A \*comment\* body\./);
  });

  it("投稿エントリがないフィードは undefined", () => {
    assert.equal(parseRedditAtom("<feed></feed>"), undefined);
  });
});

describe("Reddit フォールバックパース", () => {
  it("embed ページからタイトルと表示コメント数を取り出す", () => {
    const embedHtml = '<a id="embed-title" href="x">Sample Title</a> ... 175 comments';
    assert.deepEqual(parseRedditEmbed(embedHtml), {
      title: "Sample Title",
      displayedCommentCount: 175,
    });
  });

  it("embed ページに有効な要素がなければ undefined", () => {
    assert.equal(parseRedditEmbed("<html></html>"), undefined);
  });

  it("oEmbed JSON からタイトルを取り出す", () => {
    assert.deepEqual(parseRedditOEmbed('{"title":"OEmbed Title"}'), { title: "OEmbed Title" });
    assert.equal(parseRedditOEmbed("not json"), undefined);
  });
});

describe("fetchRedditMarkdown", () => {
  const post = parseRedditPostUrl(redditPostUrl)!;

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

describe("web_fetch バックエンド構成（Reddit 分岐）", () => {
  it("Reddit 投稿パーマリンクのときバックエンドは Reddit のみでフォールバックしない", () => {
    const backendNames = defaultFetchBackends(redditPostUrl).map(([name]) => name);
    assert.deepEqual(backendNames, ["Reddit"]);
  });

  it("その他の URL では camofox+trafilatura のみ", () => {
    const backendNames = defaultFetchBackends("https://example.com/").map(([name]) => name);
    assert.deepEqual(backendNames, ["camofox+trafilatura"]);
  });
});

// --- camofox+trafilatura バックエンド（モック） ---

// --- モックサーバーフェッチャー（camofox / openserp 共用） ---

const camofoxBase = "http://127.0.0.1:9377";
const openserpBase = "http://127.0.0.1:7000";
const networkError = Symbol("network-error");

type CamofoxCall = {
  method: string;
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

interface CamofoxRoute {
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
  return (routes: CamofoxRoute[], calls: CamofoxCall[]): typeof fetch =>
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

const mockCamofoxFetcher = createMockServerFetcher(camofoxBase);
const mockOpenserpFetcher = createMockServerFetcher(openserpBase);

function camofoxDeps(fetcher: typeof fetch, spawns: { count: number } = { count: 0 }) {
  return {
    fetcher,
    spawnCamofox: () => {
      spawns.count++;
    },
    toMarkdown: async (html: string) => `md:${html}`,
  };
}

describe("camofox+trafilatura バックエンド", () => {
  it("サーバーが既に応答するときは起動せず、タブ作成→DOM取得→タブ削除→変換の順で進む", async () => {
    const calls: CamofoxCall[] = [];
    const spawns = { count: 0 };
    const fetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        {
          method: "POST",
          pattern: /^\/tabs$/,
          body: { tabId: "TAB1", url: "https://example.com/" },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          body: { ok: true, result: "<html>body</html>" },
        },
        { method: "DELETE", pattern: /^\/tabs\/TAB1\?userId=pi$/, body: { ok: true } },
      ],
      calls,
    );

    const markdown = await camofoxFetch(
      "https://example.com/",
      undefined,
      camofoxDeps(fetcher, spawns),
    );

    assert.equal(markdown, "md:<html>body</html>");
    assert.equal(spawns.count, 0);
    assert.deepEqual(
      calls.map(({ method, path, body }) => ({ method, path, body })),
      [
        { method: "GET", path: "/health", body: undefined },
        {
          method: "POST",
          path: "/tabs",
          body: { userId: "pi", sessionKey: "web-fetch", url: "https://example.com/" },
        },
        {
          method: "POST",
          path: "/tabs/TAB1/wait",
          body: { userId: "pi", waitForNetwork: true },
        },
        {
          method: "POST",
          path: "/tabs/TAB1/evaluate",
          body: { userId: "pi", expression: "document.documentElement.outerHTML" },
        },
        { method: "DELETE", path: "/tabs/TAB1?userId=pi", body: undefined },
      ],
    );
  });

  it("ヘルスチェックが失敗する間はサーバーを1回だけ起動し、成功したら処理を再開する", async () => {
    const calls: CamofoxCall[] = [];
    const spawns = { count: 0 };
    let healthChecks = 0;
    const fetcher = mockCamofoxFetcher(
      [
        {
          method: "GET",
          pattern: /^\/health$/,
          respond: () => (++healthChecks <= 2 ? networkError : { ok: true }),
        },
        { method: "POST", pattern: /^\/tabs$/, body: { tabId: "TAB1" } },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          body: { ok: true, result: "<html>x</html>" },
        },
        { method: "DELETE", pattern: /^\/tabs\/TAB1\?userId=pi$/, body: { ok: true } },
      ],
      calls,
    );

    const markdown = await camofoxFetch(
      "https://example.com/",
      undefined,
      camofoxDeps(fetcher, spawns),
    );

    assert.equal(markdown, "md:<html>x</html>");
    assert.equal(spawns.count, 1);
    assert.equal(healthChecks, 3);
  });

  it("タイムアウト内にサーバーが準備できなければ例外を出す", async () => {
    const fetcher = mockCamofoxFetcher(
      [{ method: "GET", pattern: /^\/health$/, respond: () => networkError }],
      [],
    );

    await assert.rejects(
      camofoxFetch("https://example.com/", AbortSignal.timeout(50), camofoxDeps(fetcher)),
      /camofox server not ready/,
    );
  });

  it("DOM 取得に失敗してもタブを閉じる", async () => {
    const calls: CamofoxCall[] = [];
    const fetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        { method: "POST", pattern: /^\/tabs$/, body: { tabId: "TAB1" } },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          status: 500,
          statusText: "Internal Server Error",
          body: "evaluate failed",
        },
        { method: "DELETE", pattern: /^\/tabs\/TAB1\?userId=pi$/, body: { ok: true } },
      ],
      calls,
    );

    await assert.rejects(
      camofoxFetch("https://example.com/", undefined, camofoxDeps(fetcher)),
      /render: evaluate failed/,
    );
    assert.ok(calls.some((call) => call.method === "DELETE"));
  });

  it("DOM が文字列で返らない場合は例外を出す", async () => {
    const fetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        { method: "POST", pattern: /^\/tabs$/, body: { tabId: "TAB1" } },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          body: { ok: true, result: null },
        },
        { method: "DELETE", pattern: /^\/tabs\/TAB1\?userId=pi$/, body: { ok: true } },
      ],
      [],
    );

    await assert.rejects(
      camofoxFetch("https://example.com/", undefined, camofoxDeps(fetcher)),
      /render: evaluate returned no HTML/,
    );
  });

  it("タブ削除の失敗は変換結果に影響しない", async () => {
    const fetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        { method: "POST", pattern: /^\/tabs$/, body: { tabId: "TAB1" } },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          body: { ok: true, result: "<html>y</html>" },
        },
        {
          method: "DELETE",
          pattern: /^\/tabs\/TAB1\?userId=pi$/,
          status: 500,
          statusText: "Internal Server Error",
          body: "close failed",
        },
      ],
      [],
    );

    const markdown = await camofoxFetch("https://example.com/", undefined, camofoxDeps(fetcher));

    assert.equal(markdown, "md:<html>y</html>");
  });

  it("DOM取得後にタブを閉じてから trafilatura 変換する", async () => {
    const calls: CamofoxCall[] = [];
    const fetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        { method: "POST", pattern: /^\/tabs$/, body: { tabId: "TAB1" } },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          body: { ok: true, result: "<html>z</html>" },
        },
        { method: "DELETE", pattern: /^\/tabs\/TAB1\?userId=pi$/, body: { ok: true } },
      ],
      calls,
    );

    await camofoxFetch("https://example.com/", undefined, {
      fetcher,
      spawnCamofox: () => {},
      toMarkdown: async () => {
        calls.push({ method: "CONVERT", path: "(markdown)" });
        return "md";
      },
    });

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      [
        "GET /health",
        "POST /tabs",
        "POST /tabs/TAB1/wait",
        "POST /tabs/TAB1/evaluate",
        "DELETE /tabs/TAB1?userId=pi",
        "CONVERT (markdown)",
      ],
    );
  });

  it("HTTP 操作と trafilatura 変換は別々のシグナルを使う", async () => {
    const calls: CamofoxCall[] = [];
    const fetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        { method: "POST", pattern: /^\/tabs$/, body: { tabId: "TAB1" } },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          body: { ok: true, result: "<html>s</html>" },
        },
        { method: "DELETE", pattern: /^\/tabs\/TAB1\?userId=pi$/, body: { ok: true } },
      ],
      calls,
    );
    const callerSignal = new AbortController().signal;
    let convertSignal: AbortSignal | undefined;

    await camofoxFetch("https://example.com/", callerSignal, {
      fetcher,
      spawnCamofox: () => {},
      toMarkdown: async (_html, toMarkdownSignal) => {
        convertSignal = toMarkdownSignal;
        return "md";
      },
    });

    assert.ok(calls.every((call) => call.signal !== undefined && call.signal !== callerSignal));
    assert.equal(convertSignal, callerSignal);
  });

  it("起動待ちで失敗した次のリクエストは、応答するサーバーで再起動せず成功する", async () => {
    const spawns = { count: 0 };
    const spawnCamofox = () => {
      spawns.count++;
    };
    const coldFetcher = mockCamofoxFetcher(
      [{ method: "GET", pattern: /^\/health$/, respond: () => networkError }],
      [],
    );

    await assert.rejects(
      camofoxFetch("https://example.com/", AbortSignal.timeout(50), {
        fetcher: coldFetcher,
        spawnCamofox,
        toMarkdown: async () => "md",
      }),
      /camofox server not ready/,
    );
    assert.equal(spawns.count, 1);

    const warmFetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        { method: "POST", pattern: /^\/tabs$/, body: { tabId: "TAB1" } },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          body: { ok: true, result: "<html>w</html>" },
        },
        { method: "DELETE", pattern: /^\/tabs\/TAB1\?userId=pi$/, body: { ok: true } },
      ],
      [],
    );
    const markdown = await camofoxFetch("https://example.com/", undefined, {
      fetcher: warmFetcher,
      spawnCamofox,
      toMarkdown: async () => "md",
    });

    assert.equal(markdown, "md");
    assert.equal(spawns.count, 1);
  });
});

describe("camofox サーバー起動時の環境変数", () => {
  it("未設定の変数だけ既定値を注入する", () => {
    assert.deepEqual(camofoxServerEnv({}), {
      CAMOFOX_BIND_HOST: "127.0.0.1",
      CAMOFOX_CRASH_REPORT_ENABLED: "false",
    });
  });

  it("利用者の設定を優先し、他の変数を引き継ぐ", () => {
    assert.deepEqual(
      camofoxServerEnv({
        CAMOFOX_BIND_HOST: "0.0.0.0",
        CAMOUFOX_EXECUTABLE: "/path/to/camoufox-bin",
      }),
      {
        CAMOUFOX_EXECUTABLE: "/path/to/camoufox-bin",
        CAMOFOX_BIND_HOST: "0.0.0.0",
        CAMOFOX_CRASH_REPORT_ENABLED: "false",
      },
    );
  });
});

describe("camofox サーバー起動コマンド", () => {
  it("npx @askjo/camofox-browser@1.14.0 をバックグラウンドで起動する", () => {
    const spawnSpec = buildCamofoxServerSpawn();

    assert.equal(spawnSpec.command, "npx");
    assert.deepEqual(spawnSpec.args, ["@askjo/camofox-browser@1.14.0"]);
    assert.equal(spawnSpec.options.detached, true);
    assert.equal(spawnSpec.options.stdio, "ignore");
    assert.deepEqual(spawnSpec.options.env, camofoxServerEnv());
  });
});

describe("camofox 接続先", () => {
  it("既定は http://127.0.0.1:9377", () => {
    assert.equal(camofoxBaseUrl({}), "http://127.0.0.1:9377");
  });

  it("環境変数 CAMOFOX_BASE_URL で変更できる", () => {
    assert.equal(
      camofoxBaseUrl({ CAMOFOX_BASE_URL: "http://localhost:9999" }),
      "http://localhost:9999",
    );
  });
});

describe("camofox による描画（camofoxRender）", () => {
  it("web_search と web_fetch で sessionKey を分ける", async () => {
    const renderTabs = (sessionKeys: string[]) =>
      mockCamofoxFetcher(
        [
          { method: "GET", pattern: /^\/health$/, body: { ok: true } },
          {
            method: "POST",
            pattern: /^\/tabs$/,
            respond: () => {
              return { tabId: `TAB${sessionKeys.length}` };
            },
          },
          {
            method: "POST",
            pattern: /^\/tabs\/TAB\d+\/wait$/,
            body: { ok: true, ready: true },
          },
          {
            method: "POST",
            pattern: /^\/tabs\/TAB\d+\/evaluate$/,
            body: { ok: true, result: "<html>x</html>" },
          },
          { method: "DELETE", pattern: /^\/tabs\/TAB\d+\?userId=pi$/, body: { ok: true } },
        ],
        [],
      );

    const sessionKeys: string[] = [];
    const fetcher = (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : tryParseJson(String(init.body));
      if (
        String(input).endsWith("/tabs") &&
        body &&
        typeof body === "object" &&
        "sessionKey" in body
      ) {
        sessionKeys.push((body as { sessionKey: string }).sessionKey);
      }
      return renderTabs(sessionKeys)(input, init);
    };

    await camofoxRender("https://example.com/a", "web-search", undefined, {
      fetcher,
      spawnCamofox: () => {},
    });
    await camofoxRender("https://example.com/b", "web-fetch", undefined, {
      fetcher,
      spawnCamofox: () => {},
    });

    assert.deepEqual(sessionKeys, ["web-search", "web-fetch"]);
  });

  it("描画失敗のエラーには render: 段階ラベルを付ける", async () => {
    const fetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        { method: "POST", pattern: /^\/tabs$/, status: 500, statusText: "Server Error" },
      ],
      [],
    );

    await assert.rejects(
      camofoxRender("https://example.com/", "web-search", undefined, {
        fetcher,
        spawnCamofox: () => {},
      }),
      /render: 500 Server Error/,
    );
  });
});

describe("openserp パース（openserpParse）", () => {
  it("ready を確認してから HTML を POST /<engine>/parse?format=markdown へ送る", async () => {
    const calls: CamofoxCall[] = [];
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        {
          method: "POST",
          pattern: /^\/bing\/parse\?format=markdown$/,
          body: "### 1. Example\n\n-> https://example.com/",
        },
      ],
      calls,
    );

    const markdown = await openserpParse("bing", "<html>serp</html>", undefined, {
      fetcher,
      spawnOpenserp: () => {},
    });

    assert.equal(markdown, "### 1. Example\n\n-> https://example.com/");
    const parseCall = calls.find((call) => call.method === "POST");
    assert.equal(parseCall?.path, "/bing/parse?format=markdown");
    assert.equal(parseCall?.body, "<html>serp</html>");
    assert.equal(parseCall?.headers?.["Content-Type"], "text/html");
  });

  it("サーバーが応答しないときは起動して準備を待つ", async () => {
    const calls: CamofoxCall[] = [];
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
          pattern: /^\/duckduckgo\/parse\?format=markdown$/,
          body: "### 1. Example",
        },
      ],
      calls,
    );
    const spawns = { count: 0 };

    await openserpParse("duckduckgo", "<html>serp</html>", undefined, {
      fetcher,
      spawnOpenserp: () => {
        spawns.count++;
      },
    });

    assert.equal(spawns.count, 1);
    assert.equal(readyChecks, 2);
  });

  it("ready 応答時はサーバーを起動しない", async () => {
    const spawns = { count: 0 };
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        {
          method: "POST",
          pattern: /^\/bing\/parse\?format=markdown$/,
          body: "### 1. Example",
        },
      ],
      [],
    );

    await openserpParse("bing", "<html>serp</html>", undefined, {
      fetcher,
      spawnOpenserp: () => {
        spawns.count++;
      },
    });

    assert.equal(spawns.count, 0);
  });

  it("タイムアウト内にサーバーが準備できなければ例外を出す", async () => {
    const fetcher = mockOpenserpFetcher(
      [{ method: "GET", pattern: /^\/ready$/, respond: () => networkError }],
      [],
    );

    await assert.rejects(
      openserpParse("bing", "<html>serp</html>", AbortSignal.timeout(50), {
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
          pattern: /^\/google\/parse\?format=markdown$/,
          status: 422,
          statusText: "Unprocessable Entity",
          body: "captcha detected",
        },
      ],
      [],
    );

    await assert.rejects(
      openserpParse("google", "<html>serp</html>", undefined, {
        fetcher,
        spawnOpenserp: () => {},
      }),
      /parse: captcha detected/,
    );
  });

  it("パース結果が空なら 'parse: empty response' で失敗する", async () => {
    const fetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        { method: "POST", pattern: /^\/bing\/parse\?format=markdown$/, body: "" },
      ],
      [],
    );

    await assert.rejects(
      openserpParse("bing", "<html>serp</html>", undefined, {
        fetcher,
        spawnOpenserp: () => {},
      }),
      /parse: empty response/,
    );
  });
});

describe("camofox+openserp 検索バックエンド（camofoxOpenserpSearch）", () => {
  it("SERP URL を構築し web-search セッションで描画し、パース結果を10件に切る", async () => {
    const camofoxCalls: CamofoxCall[] = [];
    const openserpCalls: CamofoxCall[] = [];
    const camofoxFetcher = mockCamofoxFetcher(
      [
        { method: "GET", pattern: /^\/health$/, body: { ok: true } },
        {
          method: "POST",
          pattern: /^\/tabs$/,
          body: { tabId: "TAB1" },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/wait$/,
          body: { ok: true, ready: true },
        },
        {
          method: "POST",
          pattern: /^\/tabs\/TAB1\/evaluate$/,
          body: { ok: true, result: "<html>serp</html>" },
        },
        { method: "DELETE", pattern: /^\/tabs\/TAB1\?userId=pi$/, body: { ok: true } },
      ],
      camofoxCalls,
    );
    const twelveResults = Array.from(
      { length: 12 },
      (_, index) => `### ${index + 1}. Result ${index + 1}\n\n-> https://example.com/${index + 1}`,
    ).join("\n\n");
    const openserpFetcher = mockOpenserpFetcher(
      [
        { method: "GET", pattern: /^\/ready$/, body: { status: "ready" } },
        {
          method: "POST",
          pattern: /^\/bing\/parse\?format=markdown$/,
          body: twelveResults,
        },
      ],
      openserpCalls,
    );
    const deps = {
      fetcher: ((input: string | URL | Request, init?: RequestInit) =>
        String(input).startsWith(camofoxBase)
          ? camofoxFetcher(input, init)
          : openserpFetcher(input, init)) as unknown as typeof fetch,
      spawnCamofox: () => {},
      spawnOpenserp: () => {},
    };

    const markdown = await camofoxOpenserpSearch("bing", "クエリ", undefined, "JA", deps);

    const headings = markdown.match(/^### \d+\./gm) ?? [];
    assert.equal(headings.length, 10);
    const tabCall = camofoxCalls.find((call) => call.path === "/tabs");
    assert.deepEqual(tabCall?.body, {
      userId: "pi",
      sessionKey: "web-search",
      url: "https://www.bing.com/search?q=%E3%82%AF%E3%82%A8%E3%83%AA&mkt=ja-JP",
    });
    const parseCall = openserpCalls.find((call) => call.method === "POST");
    assert.equal(parseCall?.body, "<html>serp</html>");
  });
});

describe("openserp 接続先と起動コマンド", () => {
  it("既定は http://127.0.0.1:7000", () => {
    assert.equal(openserpBaseUrl({}), "http://127.0.0.1:7000");
  });

  it("環境変数 OPENSERP_BASE_URL で変更できる", () => {
    assert.equal(
      openserpBaseUrl({ OPENSERP_BASE_URL: "http://localhost:8123" }),
      "http://localhost:8123",
    );
  });

  it("openserp serve を base URL の host・port で --quiet 付きバックグラウンド起動する", () => {
    const spawnSpec = buildOpenserpServerSpawn();

    assert.equal(spawnSpec.command, "openserp");
    assert.deepEqual(spawnSpec.args, ["serve", "-a", "127.0.0.1", "-p", "7000", "--quiet"]);
    assert.equal(spawnSpec.options.detached, true);
    assert.equal(spawnSpec.options.stdio, "ignore");
  });
});
