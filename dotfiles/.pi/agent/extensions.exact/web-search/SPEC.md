# web-search 拡張機能 Spec

pi に **Web検索** と **URL取得** の2つのツールを追加する。実際の検索・フェッチの振る舞いは `dotfiles/.agents/cli/` の `browse` CLI コマンド（spec: `dotfiles/.agents/cli/browse.spec.md`。以下 **CLI spec**）が持つ。この拡張は CLI の search / fetch サブコマンドを子プロセスで起動し、tool の入出力への変換のみを行う薄いラッパーである。

## ツール一覧

| ツール     | 入力                          | 出力                                                                                                |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| web_search | 検索クエリ1つ ＋ lang（任意） | 検索結果（最大10件・Markdown）                                                                      |
| web_fetch  | URL1つ                        | ページ本文（Markdown）＋タイトル（タイトルはTUIの結果行表示のみに使い、ツール出力本文には含めない） |

## 実行

各ツールの execute は、対応するサブコマンドを `bun <browse スクリプト>` で子プロセス起動し、完了を待つ。

| ツール     | CLI 引数                                                |
| ---------- | ------------------------------------------------------- |
| web_search | `search` `<query>`（`--lang <lang>` は lang 指定時のみ）`--json` |
| web_fetch  | `fetch` `<url>` `--json`                                 |

tool 呼び出しの中断（abort signal）は子プロセスの kill に伝える。

| CLI の終了        | tool の結果                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| 終了コード 0      | stdout を JSON として解釈し、本文と details へ変換する（§出力変換）                |
| 終了コード 0 以外 | tool エラー。stderr を1行目からそのままエラーメッセージとする                       |
| stderr 空         | tool エラー。`<CLI名> exited with code <code>`（シグナル終了時は `terminated by signal`） |
| spawn 失敗        | tool エラー。`<CLI名>: <原因>`                                                    |
| stdout が JSON でない | tool エラー。`<CLI名>: CLI stdout is not JSON`                                 |

エラー時も TUI の結果行に失敗を表示するため、throw の前に `onUpdate` でエラー details を通知する。

## 出力変換

### web_search

stdout の JSON（CLI spec `--json` のフィールド参照）から、本文 Markdown と details を作る。

本文は CLI の markdown 出力（CLI spec「markdown 出力の構造」）と同じ形式。1 行目に `**Query:** "<クエリ>" - **Engines:** <engine> - **Took:** <秒>s` を置き、続けて結果ごとに `### <番号>. <タイトル>`、`**<表示URL>** - <type>`、スニペット、`-> <URL>` の順のブロックを置く。欠損フィールドの行は省略し、タイトル欠損は URL、それも無ければ `(no title)` とする。results は CLI が rank 順・上位10件に整形済みのため、そのまま順に番号を振る。

details は `{ engine, tookMs }`。

### web_fetch

本文は stdout の JSON の `body` をそのまま使う。details は `{ backend, title, tookMs }`（`title` は JSON に無いとき省略）。

## 検索・フェッチの振る舞いの委譲

backend の順序とフォールバック、challenge / captcha 再試行、タイムアウト、openserp / camoufox 常駐サーバーの起動待ち、同一種類コマンドの直列化（flock による再 spawn を含む）、Reddit / StackOverflow の専用取得経路は、すべて CLI spec に従い CLI が行う。この拡張側では実装しない。

環境変数 `OPENSERP_BASE_URL` / `CAMOUFOX_BASE_URL` は子プロセスへ継承され、CLI 側の規則（CLI spec「前提と依存」）で解釈される。

## camoufox server の配置

camoufox server は `browse` CLI（`~/.agents/cli/browse`）に内蔵され、`browse start` サブコマンドが起動する。search / fetch の実行時に server が未接続なら CLI 自身が `browse start` をバックグラウンド起動し、共通の startup script（`~/.agents/scripts/startup`）も先行起動する。この拡張は server 本体を同梱しない。

### camoufox の表示モード（Xvfb headed と x11vnc）

camoufox server の表示モード（Linux 既定の Xvfb `:99` 上の headed と x11vnc による人間への画面引き取り、`CAMOUFOX_HEADLESS`）、server 実行環境の上書き（`CAMOUFOX_EXECUTABLE_PATH`・`CAMOUFOX_PLAYWRIGHT_CORE`）、SIGINT / SIGTERM 終了時の後始末は、CLI spec「camoufox server のモード」節の正本に従う。この拡張は表示モードに独自の振る舞いを持たず、関連する環境変数も特に設定しない。

## CLI スクリプトのパス解決

CLI スクリプト（`browse`）は、この拡張のディレクトリから4階層上の `.agents/cli/` ディレクトリで解決する。source tree（`dotfiles/.pi/agent/extensions.exact/web-search/` → `dotfiles/.agents/cli/`）と展開後（`~/.pi/agent/extensions/web-search/` → `~/.agents/cli/`）のどちらも同じ相対位置で解決できるためである。

スクリプト名は `browse.executable`（source tree の chezmoi 記法）を優先し、無ければ `browse`（展開後の名前）を使う。`bun <script>` で起動するため実行ビットには依存しない。

環境変数 `BROWSE_CLI_DIR` を設定したときは、そのディレクトリを `.agents/cli` の代わりに使う（テスト・開発用）。

## 表示（TUI）

### コール行（実行開始時）

ツール名に続けて入力を記載：`web_search - "<クエリ>"`（`lang` 指定時は末尾に ` [lang=<lang>]`）/ `web_fetch - "<URL>"`。

### 結果行（実行完了時）

成功時は `✓` に続けて成功した engine または backend 名を置く。web_fetch 成功時はタイトルがあるとき ` - "<タイトル>"` を続ける。行末に CLI の実測所要時間を ` (1.2s)` 形式で付ける。

| 状態                            | 出力                                     |
| ------------------------------- | ---------------------------------------- |
| 成功（web_search）              | `✓ <engine> (1.2s)`                      |
| 成功（web_fetch、タイトルあり） | `✓ <backend> - "<タイトル>" (1.2s)`      |
| 成功（web_fetch、タイトルなし） | `✓ <backend> (1.2s)`                     |
| 失敗                            | `✗ <CLI名> - "<エラーメッセージ>"`       |

失敗行のエラーメッセージは CLI の stderr（全 backend 失敗の理由に camoufox server の復旧ヒント `browse restart` が含まれることがある。CLI spec「共通の振る舞い」）をそのまま引用する。CLI の JSON に試行（attempts）一覧が無いため、バックエンド試行を1行ずつ列挙する表示は行わない。

## 環境変数

| 変数                | 影響                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `BROWSE_CLI_DIR`    | CLI スクリプトのディレクトリ（既定は拡張から4階層上の `.agents/cli`）   |
| `CAMOUFOX_BASE_URL` | 子プロセスへ継承し、CLI 側で解釈される                                   |
| `OPENSERP_BASE_URL` | 子プロセスへ継承し、CLI 側で解釈される                                   |
