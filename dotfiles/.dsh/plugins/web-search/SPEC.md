# dotfiles-dsh-web-search Spec

## 概要

本 plugin は、dsh web profile の `web_search` / `web_fetch` ツール（`@deepseek-ai/dsh-tool-web`）に対し、camoufox + openserp による search provider と camoufox + trafilatura による fetch provider を host 側で提供する。pi extension `web-search` の移行物であり、client 側のコードは持たない。

provider の選択は dsh 本家契約（`ctx.web`、`@deepseek-ai/dsh-web`）に従う。設定未指定のとき usable な provider が 1 つだけなので、本 plugin を追加しただけで本家 tool-web の既定経路になる（`WEB_PROVIDER_AMBIGUOUS` は本 plugin 単独では起きない）。

## 設定

cordis patch 行の `config` で次の 2 項目を受け付ける。優先順位は config 値 > 環境変数 > 既定値。

| 項目 | 既定（config 未指定時） | 意味 |
|---|---|---|
| `camoufoxBaseUrl` | 環境変数 `CAMOUFOX_BASE_URL`、それも無ければ `ws://127.0.0.1:9378/camoufox` | camoufox server の待ち受け・接続先 |
| `openserpBaseUrl` | 環境変数 `OPENSERP_BASE_URL`、それも無ければ `http://127.0.0.1:7000` | openserp の待ち受け・接続先 |

## search provider（id: `camoufox-openserp`）

モデル向け `web_search`（引数は tool-web 契約の `{ queries: string[] }`）の実行時に、query ごとに次の振る舞いをする。

| 条件 | 結果 |
|---|---|
| google の描画・パースが成功し結果 1 件以上 | google の結果を返す（後続エンジンは試行しない） |
| google 失敗（描画失敗・チャレンジ検出・パース失敗・空結果のいずれか） | duckduckgo を試行。さらに失敗なら bing を試行 |
| 3 エンジンすべて失敗 | `WEB_PROVIDER_ERROR` の `WebError` で失敗し、メッセージに各エンジンの失敗行が含まれる。描画の abort を含む失敗だった場合、メッセージ末尾に hung した camoufox server の kill ヒント（`pkill -f "bun server.mjs"` 行）が付く |
| `maxResults` 指定あり | 結果の上位 `maxResults` 件に cap |
| `maxResults` 指定なし | 上位 10 件に cap |

- 言語ヒントは対応しない。dsh 契約の `WebSearchRequest` に lang フィールドが存在せず、検索は言語指定なしで行われる
- `available()` は、`bun`、`openserp`、`playwright-cli` の 3 バイナリが PATH 上で見つかること、および camoufox ブラウザ実行ファイル（環境変数 `CAMOUFOX_EXECUTABLE_PATH`、既定 `~/.cache/camoufox/camoufox-bin`）が存在することを条件とする。ネットワークアクセスは行わない

## fetch provider（id: `camoufox-trafilatura`）

モデル向け `web_fetch`（引数は tool-web 契約の `{ url: string }`）の実行時に、URL で経路を 1 つ固定する。

| URL | 経路と結果 |
|---|---|
| Reddit 投稿（`reddit.com` またはサブドメインの `/r/<subreddit>/comments/<投稿ID>/...`） | Reddit 経路。Atom フィード → embed → oEmbed の順で試行し、Markdown を返す。全試行失敗なら `WEB_PROVIDER_ERROR` で失敗する |
| StackOverflow 質問（`stackoverflow.com` の `/questions/<数字ID>/...`） | StackOverflow 経路。StackExchange API → 質問フィードの順で試行し、Markdown を返す。全試行失敗なら `WEB_PROVIDER_ERROR` で失敗する |
| 上記以外 | camoufox 描画 + `trafilatura --markdown` で本文を Markdown 化して返す。描画失敗・チャレンジ検出・変換失敗は `WEB_PROVIDER_ERROR` で失敗する |

- 成功結果は契約に従い `body: { kind: 'text', content: <Markdown> }` として返す。`statusCode` は `200`、`url` は入力 URL または経路ごとの正規化 URL（Reddit は permalink）を返す
- 描画は challenge 検出シグナル（Cloudflare 4 種、Google CAPTCHA 4 種）を用い、検出時はその backend の失敗として扱う
- `available()` は search provider と同一条件とする

## 常駐サーバー

| 時点 | 振る舞い |
|---|---|
| plugin 適用時（`apply`） | camoufox server（`bun server.mjs`）と openserp を health probe し、未起動なら detached spawn する。完了を待たない（fire-and-forget） |
| search / fetch 実行時 | サーバーが健康でなければ起動を待つ（15 秒上限、超過で `WEB_PROVIDER_ERROR`） |
| pi 等他プロセスが同一サーバーを既に起動済み | 起動済みのサーバーに接続して再利用する |

- camoufox server の標準出力・標準エラーは `<XDG_CACHE_HOME:-~/.cache>/pi/web-search/camoufox-server.log` へ追記される
- 描画のタイムアウトは 30 秒、openserp パースと trafilatura 変換は各 15 秒、Reddit・StackOverflow の各要求は 15 秒

## 同種リクエストの直列化

| リクエストの組 | 実行 |
|---|---|
| web_search 同士 | 先行の実行完了まで後続は開始しない（provider 内部で直列化） |
| web_fetch 同士 | 同上 |
| web_search と web_fetch | 互いに並行で実行できる |

multi-query の web_search（`queries` 2 件以上）も、provider 内部の直列化により 1 件ずつ順に実行する。

## 提供する plugin

| 項目 | 値 |
|---|---|
| パッケージ / cordis 行 id | `dotfiles-dsh-web-search` / `dsh-web-search` |
| `export const name` | `"dsh-web-search"` |
| `export const inject` | `["web"]` |
| 登録 | `ctx.web.registerSearchProvider`（id `camoufox-openserp`）と `ctx.web.registerFetchProvider`（id `camoufox-trafilatura`） |
| エントリポイント構成 | 単一の自己完結モジュール（`run_build.sh` の `--external '*'` が相対 import を externalize するため、src 配下の相対 import を持たない 1 ファイルにする）。camoufox server 本体（server.mjs）はパッケージ同梱の .mjs として bundle 外に置く |
