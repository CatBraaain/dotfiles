// 実行: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import webSearchExtension, {
  BACKEND_TIMEOUT_MS,
  defaultFetchBackends,
  fetchRedditMarkdown,
  defaultSearchBackends,
  fetchOne,
  formatBackendLine,
  formatBackendLines,
  openserpError,
  parseRedditAtom,
  parseRedditEmbed,
  parseRedditOEmbed,
  parseRedditPostUrl,
  pageTitle,
  searchOne,
  type Attempt,
  type BackendEntry,
  type WebToolOperations,
} from "./index";

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
let group = "";

function describe(name: string, fn: () => void): void {
  const previousGroup = group;
  group = name;
  fn();
  group = previousGroup;
}

function it(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

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
  return { search: searchOne, fetch: fetchOne, pageTitle, ...overrides };
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

  it("starts the next web_fetch after the preceding title lookup completes", async () => {
    const firstTitleCompletion = createDeferred<string | null>();
    const fetchStartOrder: string[] = [];
    const queuedFetch = captureTools(
      createWebToolOperations({
        fetch: async (url) => {
          fetchStartOrder.push(url);
          return successfulOperationResult(url);
        },
        pageTitle: async (url) => (url.endsWith("first") ? firstTitleCompletion.promise : null),
      }),
    ).get("web_fetch")!;

    const firstRequest = queuedFetch.execute("first", { url: "https://example.com/first" });
    const secondRequest = queuedFetch.execute("second", { url: "https://example.com/second" });

    await Promise.resolve();
    assert.deepEqual(fetchStartOrder, ["https://example.com/first"]);

    firstTitleCompletion.resolve(null);
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
        pageTitle: async () => null,
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
        pageTitle: async () => null,
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

  it("デフォルトのバックエンド順序は openserp(google)→duckduckgo→bing→markdown.new", () => {
    const backendNames = defaultSearchBackends("query").map(([name]) => name);
    assert.deepEqual(backendNames, [
      "openserp(google)",
      "openserp(duckduckgo)",
      "openserp(bing)",
      "markdown.new",
    ]);
  });
});

describe("web_search 統合（execute 経由・実バックエンド）", () => {
  it("パラメータは query と lang（任意）で、複数一括クエリはサポートしない", () => {
    const parameterKeys = Object.keys(search.parameters.properties);
    assert.deepEqual(parameterKeys, ["query", "lang"]);
  });

  it("検索結果は最大10件を出力し、件数が実バックエンドの結果数に満たないこともある", async () => {
    const resultText = textOf(await callSearch("pi coding agent"));
    const headings = resultText.match(/^#{2,3} \d+\./gm) ?? [];
    assert.ok(headings.length > 0);
    assert.ok(headings.length <= 10);
  });

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
    const resultText = textOf(await callSearch("hello world"));
    assert.ok(resultText.length > 0);
  });
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

  it("デフォルトのバックエンド順序は trafilatura→fetch+trafilatura→Jina Reader", () => {
    const backendNames = defaultFetchBackends("https://example.com/").map(([name]) => name);
    assert.deepEqual(backendNames, ["trafilatura", "fetch+trafilatura", "Jina Reader"]);
  });
});

describe("web_fetch 統合（execute 経由・実バックエンド）", () => {
  it("パラメータは url のみで、複数一括フェッチはサポートしない", () => {
    const parameterKeys = Object.keys(fetchTool.parameters.properties);
    assert.deepEqual(parameterKeys, ["url"]);
  });

  it("実バックエンドでフェッチが成功する", async () => {
    const resultText = textOf(await callFetch("https://example.com/"));
    assert.ok(resultText.length > 0);
  });

  it("HTML 以外の本文（text/plain）は変換せずそのまま返す", async () => {
    const plainTextUrl = "https://raw.githubusercontent.com/karust/openserp/main/README.md";
    const resultText = textOf(await callFetch(plainTextUrl));
    assert.match(resultText, /OpenSERP/);
  });
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

  it("pageTitle は title 要素がある HTML からタイトルを取り出す", async () => {
    const htmlWithTitle = "<html><head><title>Example</title></head><body></body></html>";
    const title = await pageTitle("https://example.com/", undefined, async () => htmlWithTitle);
    assert.equal(title, "Example");
  });

  it("pageTitle は title 要素がない HTML で null を返す", async () => {
    const htmlWithoutTitle = "<html><body>no title</body></html>";
    const title = await pageTitle("https://example.com/", undefined, async () => htmlWithoutTitle);
    assert.equal(title, null);
  });
});

describe("openserp のエラー抽出", () => {
  it("stderr から Error: 行だけを取り出しプレフィックスを外す", () => {
    const openserpStderr = [
      'time="2026-08-08T13:41:14+09:00" level=warning msg="cannot read config"',
      '[2026-08-08 13:41:15][error][engine=google][query_hash=e43c51c2b000]["Page classified as captcha detected"]',
      "Error: google search: captcha detected",
    ].join("\n");
    const execFileError = {
      message: "Command failed: openserp search google chikawa",
      stderr: openserpStderr,
    };
    assert.equal(openserpError(execFileError).message, "google search: captcha detected");
  });

  it("Error: 行が複数あれば最後を使う", () => {
    const execFileError = { stderr: "Error: first attempt failed\nError: second attempt failed" };
    assert.equal(openserpError(execFileError).message, "second attempt failed");
  });

  it("Error: 行がなければ元のエラーメッセージにフォールバックする", () => {
    const timeoutError = new Error("Command failed: openserp timed out");
    assert.equal(openserpError(timeoutError).message, "Command failed: openserp timed out");
  });
});

describe("バックエンドタイムアウト", () => {
  it("1バックエンドあたりの最大待ち時間は15秒で全バックエンド一律", () => {
    assert.equal(BACKEND_TIMEOUT_MS, 15_000);
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
      { backend: "Jina Reader", ok: true },
    ];
    const result = {
      content: [{ type: "text", text: "本文" }],
      details: { backend: "Jina Reader", attempts, title: "Example Page" },
    };
    const lines = renderedLines(fetchTool.renderResult(result));
    assert.deepEqual(lines, ['✗ trafilatura - "timeout"', '✓ Jina Reader - "Example Page"']);
  });

  it("結果行はタイトルがない成功バックエンドにはタイトルを付けない", () => {
    const attempts: Attempt[] = [{ backend: "Jina Reader", ok: true }];
    const result = {
      content: [{ type: "text", text: "本文" }],
      details: { backend: "Jina Reader", attempts, title: null },
    };
    const lines = renderedLines(fetchTool.renderResult(result));
    assert.deepEqual(lines, ["✓ Jina Reader"]);
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
    assert.equal(parsed.comments[0].author, "u/Commenter");
    assert.match(parsed.comments[0].bodyMarkdown, /A \*comment\* body\./);
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

  it("その他の URL では従来どおり trafilatura→fetch+trafilatura→Jina Reader", () => {
    const backendNames = defaultFetchBackends("https://example.com/").map(([name]) => name);
    assert.deepEqual(backendNames, ["trafilatura", "fetch+trafilatura", "Jina Reader"]);
  });
});

let passed = 0;
const failures: string[] = [];
for (const test of tests) {
  try {
    await test.fn();
    passed++;
  } catch (error) {
    failures.push(
      `  ✗ ${test.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
