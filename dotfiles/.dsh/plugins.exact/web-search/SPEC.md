# dotfiles-dsh-web-search Spec

## 概要

本plugin は、dsh web profile の `web_search` / `web_fetch` ツール（`@deepseek-ai/dsh-tool-web`）に対し、search provider（id `camoufox-openserp`）と fetch provider（id `camoufox-trafilatura`）を host側で提供する。client側のコードは持たない。

各provider は共有CLIコマンド `browse`（`dotfiles/.agents/cli.exact/browse`、展開先 `~/.agents/cli/browse/`。振る舞いの正本は `dotfiles/.agents/cli.exact/browse/SPEC.md`）の薄いラッパーである: 呼び出しごとに `bun <browse プロジェクトディレクトリ> search|fetch <引数> --json` を子プロセス起動し、stdout の JSON から契約型（`WebSearchResult` / `WebFetchResult`）を組み立てる。エンジン試行順・challenge検出・Reddit / StackOverflow経路・常駐サーバーの起動・タイムアウトは CLI の受け持ちであり、本plugin は再実装しない。

provider の選択は dsh本家契約（`ctx.web`、`@deepseek-ai/dsh-web`）に従う。設定未指定のときusable な provider が 1つだけなので、本plugin を追加しただけで本家tool-web の既定経路になる（`WEB_PROVIDER_AMBIGUOUS` は本plugin単独では起きない）。

## 設定

cordis patch行の `config` で次の 2項目を受け付ける。優先順位は config値 > 環境変数 > 既定値。

| 項目 | 既定（config未指定時） | 意味 |
| --- | --- | --- |
| `camoufoxBaseUrl` | 環境変数 `CAMOUFOX_BASE_URL`、それも無ければ `ws://127.0.0.1:9378/camoufox` | camoufox server の待ち受け・接続先 |
| `openserpBaseUrl` | 環境変数 `OPENSERP_BASE_URL`、それも無ければ `http://127.0.0.1:7000` | openserp の待ち受け・接続先 |

解決済みの値は子プロセスの環境変数 `CAMOUFOX_BASE_URL` / `OPENSERP_BASE_URL` としてCLI へ渡る。CLI はこれを接続先として使うほか、自身が camoufox server を起動するときの待ち受けアドレスにも使うため、config値由来の URL でも接続先と待ち受けは一致する。

## search provider（id: `camoufox-openserp`）

モデル向け `web_search`（引数は tool-web契約の `{ queries: string[] }`）の実行時に、queryごとに `bun <browse CLI スクリプト> search "<query>" --json` を起動し、stdout の JSON を契約の `WebSearchResult` へ写像する。

| 条件 | 結果 |
| --- | --- |
| CLI が終了コード0 で JSON を返した | `sources`（下記の写像）と `truncated: false` を返す |
| CLI が終了コード1 で失敗した（全エンジン失敗等） | `WEB_PROVIDER_ERROR` の `WebError`。メッセージは CLI の stderr出力を逐語で持つ（各エンジンの失敗行と、描画abort を含む失敗時の camoufox server復旧ヒントを含む） |
| signal が abortされた | 子プロセスを殺し、`WEB_PROVIDER_ERROR` の `WebError` で失敗する |
| stdout が JSON としてパースできない | `WEB_PROVIDER_ERROR` の `WebError` で失敗する |

- CLI JSON の `results[]` は `WebSearchSource` へ射影して返す。`url` の無いエントリは捨て、`title`・`snippet` は空白時に省略する。CLI の JSON は openserp の生の href をそのまま含むため、engine origin からの相対URL（google の `/goto?url=...` など。プロトコル相対も含む）は engine origin で絶対化して返す。不正な URL（解決できないもの）のエントリは `url` 無しと同様に捨てる。CLI の `type`・`display_url`・`rank`・`tookMs` と、検索のメタデータ行は契約型に置き場がなく出力しない
- 検索結果は CLI が上位10件に限定して返す。それ以上の件数上限（`maxResults` cap）と `truncated` は dsh-web seam の受け持ちで、cap により行が減ったときは seam が `truncated: true` を設定する（本家 `dsh-web-search-deepseek` と同じ構造）
- 言語ヒントは対応しない。dsh契約の `WebSearchRequest` に langフィールドが存在せず、CLI を言語指定なしで起動する
- エンジンの試行順（google → duckduckgo → bing）、challenge / captcha検出時の同一エンジン1回再試行、空結果の失敗扱いは CLI の振る舞い（`browse/SPEC.md`）に従う

## fetch provider（id: `camoufox-trafilatura`）

モデル向け `web_fetch`（引数は tool-web契約の `{ url: string }`）の実行時に、`bun <browse CLI スクリプト> fetch <url> --json` を起動し、stdout の JSON を契約の `WebFetchResult` へ写像する。

| 項目 | 値 |
| --- | --- |
| `url` | CLI JSON の `url`（Reddit / StackOverflow は permalink へ正規化済み） |
| `statusCode` | `200` 固定（CLI はフェッチ失敗をエラーとして報告するため、非2xx を結果として表現しない） |
| `body` | `{ kind: "text", content: <CLI JSON の body（markdown）> }`。`fallbacks` がある場合は、本文の先頭に `✓ <backend> [- "<title>"] (fallback: <backend>: <error>; ...) (1.2s)` の1行を追加する |
| `truncated` | `false` |

- URL による経路の選択（Reddit投稿 → RSS / embed / oEmbed、StackOverflow質問 → StackExchange API / 質問フィード、その他 → camoufox描画 + `trafilatura --markdown`）と各経路のフォールバックは CLI の振る舞い（`browse/SPEC.md`）に従う
- 失敗時のエラー伝播は search provider と同じ（CLI stderr を逐語で持つ `WEB_PROVIDER_ERROR` の `WebError`）
- CLI が返した `fallbacks` は、標準dsh UI の成功行へ渡せないため、成功本文の先頭1行へ表示する。タイトル抽出は本家tool-web側の責務だが、fallback行のタイトルは CLI JSON の `title` を使う

## available()

`available()` は、`bun`、`openserp`、`playwright-cli` の 3バイナリが PATH上で見つかること、および camoufoxブラウザ実行ファイル（環境変数 `CAMOUFOX_EXECUTABLE_PATH`、既定 `~/.cache/camoufox/camoufox-bin`）が存在することを条件とする。ネットワークアクセスは行わない。CLI がこれら全部を駆動するため、前提チェックはラッパー化前と同じ条件を維持する。

## CLIスクリプトのパス解決

CLIスクリプトは `~/.agents/cli/browse` で解決する。本plugin の bundle は常に展開先（`~/.dsh/plugins/web-search/`）で動くため、ホームディレクトリ基準の解決を使う（pi拡張と違い、source tree からの相対位置には依存しない）。

環境変数 `BROWSE_CLI_DIR` を設定したときは、そのディレクトリを `~/.agents/cli` の代わりに使う（テスト・開発用。pi拡張のラッパーと同じ規則）。CLIプロジェクトは `bun <script>` として起動し、bun が `browse` ディレクトリの package.json `main` を解決するため、実行ビットには依存しない。

## 常駐サーバー

サーバーの起動・ヘルスチェック・待ち（15秒上限）は CLI の受け持ちである。本plugin はサーバーを起動しない。

- camoufox server本体は `browse` CLI に内蔵され、`browse server start` サブコマンドが起動する。本plugin は server を起動せず、server本体も同梱しない。pi拡張と同じ単一の server を共有する
- サーバーの先行起動（priming）は共通スクリプト `~/.agents/scripts/startup`（`dotfiles/.agents/scripts.exact/startup.spec.md`）が `bun ~/.agents/cli/browse server start` の detached spawn で行うのが受け持ちであり、本plugin も CLI も起動時にこれを行わない
- camoufox server のログは `<XDG_CACHE_HOME:-~/.cache>/pi/web-search/camoufox-server.log` へ追記される（CLI が行う）

## 同種リクエストの直列化

直列化は CLI の横断プロセスロック（`flock`）の受け持ちである。本plugin はプロセス内キューを持たない。

| リクエストの組 | 実行 |
| --- | --- |
| web_search同士 | CLI のロックにより先行の実行完了まで後続は開始しない（pi など他プロセスからの同一CLI起動とも直列化する） |
| web_fetch同士 | 同上 |
| web_search と web_fetch | 互いに並行で実行できる（ロックファイルが別） |

multi-query の web_search（`queries` 2件以上）も、各query の CLI起動が順に直列化される。

## 提供するplugin

| 項目 | 値 |
| --- | --- |
| パッケージ / cordis行id | `dotfiles-dsh-web-search` / `dsh-web-search` |
| `export const name` | `"dsh-web-search"` |
| `export const inject` | `["web"]` |
| 登録 | `ctx.web.registerSearchProvider`（id `camoufox-openserp`）と `ctx.web.registerFetchProvider`（id `camoufox-trafilatura`） |
| エントリポイント構成 | `build.apply.ts` が 1エントリとしてbundleする（相対import は inline、script に明示されたbare-specifier external のみ外部解決） |
| 依存 | 探索ロジックの依存を持たない（ロジックは browse CLI側が持つ） |
