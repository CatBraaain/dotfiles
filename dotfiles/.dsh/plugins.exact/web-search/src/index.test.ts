// Tests for dotfiles-dsh-web-search. Describes follow the SPEC.md section
// order: 設定 -> CLI 子プロセス wiring -> search provider -> fetch provider ->
// available() -> エラー伝播 -> 提供する plugin. The CLI itself (engine chain,
// servers, Reddit / StackOverflow routes) has its own contract in
// dotfiles/.agents/cli/browse.spec.md and is not exercised here: the CLI
// spawn is mocked at the exec seam.
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebError } from "@deepseek-ai/dsh-web";
import type { WebFetchProvider, WebSearchProvider } from "@deepseek-ai/dsh-web";
import {
  apply,
  binaryOnPath,
  browseCliDir,
  browseScript,
  buildCliEnv,
  CAMOUFOX_DEFAULT_BASE_URL,
  camoufoxExecutablePath,
  CamoufoxOpenserpSearchProvider,
  CamoufoxTrafilaturaFetchProvider,
  cliErrorMessage,
  CLI_OUTPUT_MAX_BUFFER,
  Config,
  execCli,
  FETCH_PROVIDER_ID,
  formatFetchFallbackLine,
  hostPrerequisitesMet,
  inject,
  name,
  OPENSERP_DEFAULT_BASE_URL,
  resolveEndpoints,
  SEARCH_PROVIDER_ID,
  toFetchResult,
  toSearchSources,
  toWebError,
  type CliExec,
  type CliSpawnOptions,
  type ServerEndpoints,
} from "./index.ts";

const endpoints: ServerEndpoints = resolveEndpoints({});

// --- test doubles ---

interface RecordedCall {
  command: string;
  args: readonly string[];
  options: CliSpawnOptions;
}

function fakeExec(stdoutByKind: Record<string, string>): { exec: CliExec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: CliExec = (command, args, options) => {
    calls.push({ command, args, options });
    if (options.signal?.aborted) {
      // Mirror execFile: a pre-aborted signal rejects the spawn immediately.
      return Promise.reject(
        Object.assign(new Error("The operation was aborted"), { name: "AbortError", stderr: "" }),
      );
    }
    const script = args[0] ?? "";
    const stdout = stdoutByKind[script];
    if (stdout === undefined) {
      return Promise.reject(Object.assign(new Error("spawn ENOENT"), { stderr: "" }));
    }
    return Promise.resolve({ stdout, stderr: "" });
  };
  return { exec, calls };
}

function searchJson(results: unknown[], engine = "google"): string {
  return JSON.stringify({ query: "q", engine, tookMs: 1, results });
}

function fetchJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: "https://example.com/page",
    backend: "camoufox+trafilatura",
    body: "# Example\n\ntext",
    tookMs: 1,
    ...overrides,
  });
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

// --- SPEC §"CLI 子プロセス" ---

describe("CLI の起動引数と環境（browseScript・buildCliEnv・execCli 経由の wiring）", () => {
  it("browseCliDir は ~/.agents/cli が既定で、BROWSE_CLI_DIR で上書きできる", () => {
    assert.equal(browseCliDir({}), join(homedir(), ".agents", "cli"));
    assert.equal(browseCliDir({ BROWSE_CLI_DIR: "/opt/web-cli" }), "/opt/web-cli");
  });

  it("browseScript は <dir>/browse を返し、source tree の browse.executable を優先する", () => {
    const directory = mkdtempSync(join(tmpdir(), "web-search-cli-"));
    try {
      const plain = join(directory, "browse");
      writeFileSync(plain, "");
      assert.equal(browseScript({ BROWSE_CLI_DIR: directory }), plain);

      const source = join(directory, "browse.executable");
      writeFileSync(source, "");
      assert.equal(browseScript({ BROWSE_CLI_DIR: directory }), source);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("buildCliEnv は解決済みエンドポイントを子プロセス環境へ上書きする", () => {
    const env = buildCliEnv(
      { camoufoxBaseUrl: "ws://cfg:1/x", openserpBaseUrl: "http://cfg:2" },
      { CAMOUFOX_BASE_URL: "ws://env:1/x", OPENSERP_BASE_URL: "http://env:2", OTHER: "keep" },
    );
    assert.equal(env.CAMOUFOX_BASE_URL, "ws://cfg:1/x");
    assert.equal(env.OPENSERP_BASE_URL, "http://cfg:2");
    assert.equal(env.OTHER, "keep");
  });

  it("search は bun <browse> search <query> --json を spawn し、signal と env と maxBuffer を渡す", async () => {
    const controller = new AbortController();
    const { exec, calls } = fakeExec({
      [browseScript()]: searchJson([{ url: "https://a/" }]),
    });
    const provider = new CamoufoxOpenserpSearchProvider(
      { camoufoxBaseUrl: "ws://x:1/y", openserpBaseUrl: "http://z:2" },
      { exec },
    );

    await provider.search({ query: "pi coding agent" }, controller.signal);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "bun");
    assert.deepEqual(calls[0]!.args, [browseScript(), "search", "pi coding agent", "--json"]);
    assert.equal(calls[0]!.options.signal, controller.signal);
    assert.equal(calls[0]!.options.env.CAMOUFOX_BASE_URL, "ws://x:1/y");
    assert.equal(calls[0]!.options.env.OPENSERP_BASE_URL, "http://z:2");
    assert.equal(calls[0]!.options.maxBuffer, CLI_OUTPUT_MAX_BUFFER);
  });

  it("fetch は bun <browse> fetch <url> --json を spawn し、signal と env を渡す", async () => {
    const controller = new AbortController();
    const { exec, calls } = fakeExec({ [browseScript()]: fetchJson() });
    const provider = new CamoufoxTrafilaturaFetchProvider(
      { camoufoxBaseUrl: "ws://x:1/y", openserpBaseUrl: "http://z:2" },
      { exec },
    );

    await provider.fetch({ url: "https://example.com/page" }, controller.signal);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "bun");
    assert.deepEqual(calls[0]!.args, [
      browseScript(),
      "fetch",
      "https://example.com/page",
      "--json",
    ]);
    assert.equal(calls[0]!.options.signal, controller.signal);
    assert.equal(calls[0]!.options.env.CAMOUFOX_BASE_URL, "ws://x:1/y");
    assert.equal(calls[0]!.options.env.OPENSERP_BASE_URL, "http://z:2");
  });

  it("execCli のデフォルト実装は child_process.execFile に command・args・options を渡す（bun 実行で往復する）", async () => {
    // Real execFile round trip against `bun -e` (bun is a required binary):
    // argv and env survive the spawn, and stdout comes back.
    const output = await execCli(
      "bun",
      ["-e", "console.log(JSON.stringify({ok: process.env.PING ?? 'none'}))"],
      {
        env: { ...process.env, PING: "pong" },
        maxBuffer: 1024 * 1024,
      },
    );
    assert.deepEqual(JSON.parse(output.stdout), { ok: "pong" });
  });
});

// --- SPEC §"search provider" ---

describe("CLI JSON の sources 変換（toSearchSources）", () => {
  it("results をそのまま sources へ写像する（rank 昇順・上位10件への限定は CLI の受け持ち）", () => {
    const json = JSON.parse(
      searchJson([
        { rank: 1, title: " One ", url: " https://one/ ", snippet: " s1 " },
        { rank: 2, url: "https://two/" },
      ]),
    );
    assert.deepEqual(toSearchSources(json), [
      { url: "https://one/", title: "One", snippet: "s1" },
      { url: "https://two/" },
    ]);
  });

  it("url のないエントリは捨てる", () => {
    const json = JSON.parse(searchJson([{ title: "no url" }, { url: "https://a/" }]));
    assert.deepEqual(toSearchSources(json), [{ url: "https://a/" }]);
  });

  it("engine origin からの相対 URL（/goto?url=... 等）は engine origin で絶対化する", () => {
    const json = JSON.parse(
      searchJson([{ url: "/goto?url=xyz" }, { url: "https://abs/" }], "google"),
    );
    assert.deepEqual(toSearchSources(json), [
      { url: "https://www.google.com/goto?url=xyz" },
      { url: "https://abs/" },
    ]);
  });

  it("プロトコル相対 URL も engine origin で絶対化する", () => {
    const json = JSON.parse(searchJson([{ url: "//cdn.example.com/x" }], "duckduckgo"));
    assert.deepEqual(toSearchSources(json), [{ url: "https://cdn.example.com/x" }]);
  });

  it("解決不能な URL（host 不備の絶対 URL 等）のエントリは url 無しと同様に捨てる", () => {
    const json = JSON.parse(
      searchJson([{ url: "https://exa mple.com/x" }, { url: "https://ok/" }], "google"),
    );
    assert.deepEqual(toSearchSources(json), [{ url: "https://ok/" }]);
  });

  it("空白の title・snippet は省略し、捏造しない", () => {
    const json = JSON.parse(searchJson([{ url: "https://a/", title: "  ", snippet: "" }]));
    assert.deepEqual(toSearchSources(json), [{ url: "https://a/" }]);
  });

  it("results が配列でなければ unexpected output で失敗する", () => {
    assert.throws(
      () => toSearchSources({ query: "q", engine: "google", results: null }),
      /unexpected browse search CLI output/,
    );
  });
});

describe("search provider（CamoufoxOpenserpSearchProvider）", () => {
  it("CLI JSON から sources と truncated false を組み立てる（cap は seam の受け持ち）", async () => {
    const { exec } = fakeExec({
      [browseScript()]: searchJson(
        Array.from({ length: 12 }, (_, index) => ({ url: `https://example.com/${index + 1}` })),
      ),
    });
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, { exec });

    const result = await provider.search({ query: "q", maxResults: 2 });

    assert.equal(result.sources.length, 12);
    assert.equal(result.truncated, false);
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

// --- SPEC §"fetch provider" ---

describe("CLI JSON の fetch result 変換（toFetchResult）", () => {
  it("url・statusCode 200・text body・truncated false を組み立てる", () => {
    const json = JSON.parse(
      fetchJson({ url: "https://www.reddit.com/r/a/comments/id/slug/", backend: "Reddit" }),
    );
    assert.deepEqual(toFetchResult(json), {
      url: "https://www.reddit.com/r/a/comments/id/slug/",
      statusCode: 200,
      body: { kind: "text", content: "# Example\n\ntext" },
      truncated: false,
    });
  });

  it("fallback履歴を成功本文の先頭行へ表示する", () => {
    const json = JSON.parse(fetchJson({
      backend: "camoufox+trafilatura",
      title: "Example",
      tookMs: 1200,
      fallbacks: [{ backend: "camoufox+trafilatura", error: "render: challenge detected" }],
    }));
    assert.equal(
      formatFetchFallbackLine(json),
      '✓ camoufox+trafilatura - "Example" (fallback: camoufox+trafilatura: render: challenge detected) (1.2s)',
    );
    assert.equal(
      (toFetchResult(json).body as { kind: "text"; content: string }).content,
      '✓ camoufox+trafilatura - "Example" (fallback: camoufox+trafilatura: render: challenge detected) (1.2s)\n\n# Example\n\ntext',
    );
  });

  it("title・backend・tookMs は結果に使わない", () => {
    const json = JSON.parse(
      fetchJson({ title: "Page title", backend: "StackOverflow", tookMs: 99 }),
    );
    const result = toFetchResult(json) as unknown as Record<string, unknown>;
    assert.equal(result.title, undefined);
    assert.equal(result.backend, undefined);
    assert.equal(result.tookMs, undefined);
  });

  it("url か body が文字列でなければ unexpected output で失敗する", () => {
    assert.throws(
      () => toFetchResult(JSON.parse(fetchJson({ url: "" }))),
      /unexpected browse fetch CLI output/,
    );
    assert.throws(
      () => toFetchResult(JSON.parse(fetchJson({ body: 1 }))),
      /unexpected browse fetch CLI output/,
    );
    assert.throws(() => toFetchResult("not an object"), /unexpected browse fetch CLI output/);
  });
});

describe("fetch provider（CamoufoxTrafilaturaFetchProvider）", () => {
  it("CLI JSON の正規化済み url を結果の url に使う", async () => {
    const { exec } = fakeExec({
      [browseScript()]: fetchJson({
        url: "https://www.reddit.com/r/a/comments/id/slug/",
      }),
    });
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, { exec });

    const result = await provider.fetch({ url: "https://redd.it/id" });

    assert.equal(result.url, "https://www.reddit.com/r/a/comments/id/slug/");
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { kind: "text", content: "# Example\n\ntext" });
    assert.equal(result.truncated, false);
  });

  it("成功本文の fallback 行を維持する", async () => {
    const { exec } = fakeExec({
      [browseScript()]: fetchJson({
        fallbacks: [{ backend: "camoufox+trafilatura", error: "render: challenge detected" }],
      }),
    });
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, { exec });

    const result = await provider.fetch({ url: "https://example.com/page" });

    assert.equal(
      result.body.content,
      '✓ camoufox+trafilatura (fallback: camoufox+trafilatura: render: challenge detected) (0.0s)\n\n# Example\n\ntext',
    );
  });

  it("id は camoufox-trafilatura", () => {
    assert.equal(new CamoufoxTrafilaturaFetchProvider(endpoints).id, FETCH_PROVIDER_ID);
    assert.equal(FETCH_PROVIDER_ID, "camoufox-trafilatura");
  });

  it("available は search provider と同一条件", () => {
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, {
      prerequisitesMet: () => true,
    });
    assert.equal(provider.available(), true);
  });
});

// --- SPEC §"available() の前提チェック" ---

describe("available() の前提チェック（hostPrerequisitesMet・binaryOnPath）", () => {
  it("bun・openserp・playwright-cli と camoufox 実行ファイルが揃ったとき true", () => {
    assert.equal(
      hostPrerequisitesMet({}, { binaryOnPath: () => true, fileExists: () => true }),
      true,
    );
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
    assert.equal(
      hostPrerequisitesMet({}, { binaryOnPath: () => true, fileExists: () => false }),
      false,
    );
  });

  it("camoufox 実行ファイルは CAMOUFOX_EXECUTABLE_PATH、既定は ~/.cache/camoufox/camoufox-bin", () => {
    assert.equal(
      camoufoxExecutablePath({ CAMOUFOX_EXECUTABLE_PATH: "/opt/camoufox" }),
      "/opt/camoufox",
    );
    assert.equal(camoufoxExecutablePath({}), join(homedir(), ".cache", "camoufox", "camoufox-bin"));
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

// --- SPEC §"エラー伝播" ---

describe("エラー伝播（cliErrorMessage・toWebError・provider 経由）", () => {
  it("cliErrorMessage は stderr を優先し、無ければ error.message を使う", () => {
    const withStderr = Object.assign(new Error("Command failed: bun x"), {
      stderr: "All web search backends failed: boom\n",
    });
    assert.equal(cliErrorMessage(withStderr), "All web search backends failed: boom");
    assert.equal(cliErrorMessage(new Error("spawn ENOENT")), "spawn ENOENT");
    assert.equal(cliErrorMessage("plain string"), "plain string");
  });

  it("CLI が終了コード 1 で失敗した場合、stderr のメッセージを逐語で持つ WEB_PROVIDER_ERROR の WebError になる", async () => {
    const calls: RecordedCall[] = [];
    const exec: CliExec = (command, args, options) => {
      calls.push({ command, args, options });
      return Promise.reject(
        Object.assign(new Error("Command failed: bun browse search --json"), {
          stderr:
            "All web search backends failed: camoufox+openserp(google): render: aborted\nHint: renders aborted while the servers looked healthy, so the camoufox server is likely hung. Run `browse restart` to recover (it stops and respawns the server).\n",
        }),
      );
    };
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, { exec });

    await assert.rejects(provider.search({ query: "q" }), (error) => {
      assert.ok(error instanceof WebError, `expected WebError, got ${error}`);
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.equal(
        error.message,
        "All web search backends failed: camoufox+openserp(google): render: aborted\nHint: renders aborted while the servers looked healthy, so the camoufox server is likely hung. Run `browse restart` to recover (it stops and respawns the server).",
      );
      return true;
    });
  });

  it("stdout が JSON でなければ unparsable output の WebError になる", async () => {
    const { exec } = fakeExec({ [browseScript()]: "not json" });
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, { exec });

    await assert.rejects(provider.search({ query: "q" }), (error) => {
      assert.ok(error instanceof WebError);
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.match(error.message, /unparsable output/);
      return true;
    });
  });

  it("CLI の spawn に失敗した場合も WebError に変換する", async () => {
    const { exec } = fakeExec({});
    const provider = new CamoufoxTrafilaturaFetchProvider(endpoints, { exec });

    await assert.rejects(provider.fetch({ url: "https://example.com/" }), (error) => {
      assert.ok(error instanceof WebError);
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      assert.equal(error.message, "spawn ENOENT");
      return true;
    });
  });

  it("abort 済み signal で即座に失敗し、WebError に変換する", async () => {
    const { exec, calls } = fakeExec({
      [browseScript()]: searchJson([{ url: "https://a/" }]),
    });
    const provider = new CamoufoxOpenserpSearchProvider(endpoints, { exec });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(provider.search({ query: "q" }, controller.signal), (error) => {
      assert.ok(error instanceof WebError);
      assert.equal(error.code, "WEB_PROVIDER_ERROR");
      return true;
    });
    assert.equal(calls.length, 1);
  });

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

  it('export する name は dsh-web-search、inject は ["web"]', () => {
    assert.equal(name, "dsh-web-search");
    assert.deepEqual(inject, ["web"]);
  });

  it("apply は search・fetch 両 provider を ctx.web へ登録する", () => {
    const { ctx, searchProviders, fetchProviders } = captureRegistry();

    apply(ctx);

    assert.equal(searchProviders.length, 1);
    assert.equal(searchProviders[0]?.id, SEARCH_PROVIDER_ID);
    assert.equal(fetchProviders.length, 1);
    assert.equal(fetchProviders[0]?.id, FETCH_PROVIDER_ID);
  });

  it("パッケージ名は dotfiles-dsh-web-search、cordis 行 id は dsh-web-search", () => {
    const packageRoot = dirname(new URL(".", import.meta.url).pathname);
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name?: string;
    };
    const patchYml = readFileSync(join(packageRoot, "cordis.patch.yml"), "utf8");

    assert.equal(packageJson.name, "dotfiles-dsh-web-search");
    assert.match(patchYml, /^\s*- id: dsh-web-search$/m);
    assert.match(patchYml, /^\s*name: dotfiles-dsh-web-search$/m);
  });
});
