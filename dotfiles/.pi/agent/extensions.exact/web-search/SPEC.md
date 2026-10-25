# web-search拡張機能Spec

pi に **Web検索** と **URL取得** の2つのツールを追加する。実際の検索・フェッチの振る舞いは `dotfiles/.agents/cli.exact/` の `browse` CLIコマンド（spec: `dotfiles/.agents/cli.exact/browse/SPEC.md`。以下 **CLI spec**）が持つ。この拡張は登録済みbashツール経由で CLI の search / fetchサブコマンドを起動し、tool の入出力への変換のみを行う薄いラッパーである。

## ツール一覧

| ツール | 入力 | 出力 |
| --- | --- | --- |
| web_search | 検索クエリ1つ ＋ lang（任意） | 検索結果（最大10件・Markdown） |
| web_fetch | URL1つ | ページ本文（Markdown）＋タイトル（タイトルはTUIの結果行表示のみに使い、ツール出力本文には含めない） |

## 実行

各ツールの execute は実行時contextの `ctx.executeTool("bash", ...)` で現在登録されたbashツールを呼び、コンパイル済みの `browse` 実行ファイルの完了を待つ。実行ファイルパスと全引数をshellの単一引数として安全に引用する。bashのoverride、コマンド承認、sandbox、tool hooks はnested APIに従う。bashを利用できない場合も直接起動へ切り替えない。

| ツール | CLI引数 |
| --- | --- |
| web_search | `search` `<query>`（`--lang <lang>` は lang指定時のみ）`--json` |
| web_fetch | `fetch` `<url>` `--json` |

tool呼び出しの中断（abort signal）はnested bashへ伝える。各bash呼び出しの実行時間の上限は300秒とし、プロセス停止は登録bashの契約に従う。stdoutとstderrは分離して回収し、stderrの診断が成功時のJSONに混入しないようにする。

bashの構造化出力が切り詰められた場合は、返された `full_output_path` から同じ登録bash経由で全出力を分割回収して解釈する。回収にも中断・承認・sandbox・tool hooks を適用する。最初の部分出力は回収結果に混ぜず、全体の回収と検証が完了した場合だけ本文とdetailsへ変換する。回収用の出力やBase64表現はツールの本文へ含めない。

| CLI の終了 | tool の結果 |
| --- | --- |
| 終了コード0 | stdout を JSON として解釈し、本文と details へ変換する（§出力変換） |
| 終了コード0以外 | toolエラー。stderr を1行目からそのままエラーメッセージとする |
| 終了コード0以外でstderr空 | toolエラー。`<CLI名> exited with code <code>`。シグナル終了もshellが返す終了コードで表示する |
| bash失敗・承認拒否・中断・タイムアウト | toolエラー。`<CLI名>: <原因>` |
| bashの構造化出力が欠落・不正、切り詰め時の保存先が欠落・不正、分割回収の失敗・再切り詰め・不完全な回収、回収フレームが不正 | toolエラー。部分出力を成功として扱わない |
| stdout が JSON でない | toolエラー。`<CLI名>: CLI stdout is not JSON` |

エラー時も TUI の結果行に失敗を表示するため、throw の前に `onUpdate` でエラーdetails を通知する。

## 出力変換

### web_search

stdout の JSON（CLI spec `--json` のフィールド参照）から、本文Markdown と details を作る。

本文は CLI の markdown出力（CLI spec「markdown出力の構造」）と同じ形式。1行目に `**Query:** "<クエリ>" - **Engines:** <engine> - **Took:** <秒>s` を置き、続けて結果ごとに `### <番号>. <タイトル>`、`**<表示URL>** - <type>`、スニペット、`-> <URL>` の順のブロックを置く。欠損フィールドの行は省略し、タイトル欠損は URL、それも無ければ `(no title)` とする。results は CLI が rank順・上位10件に整形済みのため、そのまま順に番号を振る。

details は `{ engine, tookMs }`。

### web_fetch

本文は stdout の JSON の `body` をそのまま使う。details は `{ backend, title, fallback, tookMs }`（`title` は JSON に無いとき省略、`fallback` は `fallbacks` があるときだけ `backend: error; ...` 形式で追加）。

## 検索・フェッチの振る舞いの委譲

backend の順序とフォールバック、challenge / captcha再試行、タイムアウト、openserp / camoufox常駐サーバーの起動待ち、同一種類コマンドの直列化（flock による再spawn を含む）、Reddit / StackOverflow の専用取得経路は、すべてCLI spec に従いCLI が行う。この拡張側では実装しない。

環境変数 `OPENSERP_BASE_URL` / `CAMOUFOX_BASE_URL` は子プロセスへ継承され、CLI側の規則（CLI spec「前提と依存」）で解釈される。

## camoufox server の配置

camoufox server は `browse` CLI（`~/.agents/cli/browse`）に内蔵され、`browse server start` サブコマンドが起動する。search / fetch の実行時に server が未接続なら CLI自身が `browse server start` をバックグラウンド起動し、共通の startup script（`~/.agents/scripts/startup`）も先行起動する。この拡張は server本体を同梱しない。

### camoufox の表示モード（Xvfb headed と x11vnc）

camoufox server の表示モード（Linux既定の Xvfb `:99` 上の headed と x11vnc による人間への画面引き取り、`CAMOUFOX_HEADLESS`）、server実行環境の上書き（`CAMOUFOX_EXECUTABLE_PATH`・`CAMOUFOX_PLAYWRIGHT_CORE`）、SIGINT / SIGTERM終了時の後始末は、CLI spec「camoufox server のモード」節の正本に従う。この拡張は表示モードに独自の振る舞いを持たず、関連する環境変数も特に設定しない。

## CLI実行ファイルのパス解決

`browse` の配置ディレクトリは、この拡張のディレクトリから4階層上の `.agents/` 配下で解決する。source tree の `dotfiles/.pi/agent/extensions.exact/web-search/` からは `dotfiles/.agents/cli.exact/`、展開後の `~/.pi/agent/extensions/web-search/` からは `~/.agents/cli/` を使う。

環境変数 `BROWSE_CLI_DIR` を設定したときは、そのディレクトリを配置ごとの既定ディレクトリの代わりに使う（テスト・開発用）。起動対象は常に `<配置ディレクトリ>/browse` の実行可能なコンパイル済みファイルとする。source tree から利用するときも、`BROWSE_CLI_DIR` でその実行ファイルの配置先を指定できる。

## 表示（TUI）

ツールの表示（コール行・結果行）は tool-renderer 拡張が単一で担う。表示仕様の正本は `../tool-renderer/SPEC.md` を参照。本拡張は `details` と本文の生成だけを行い、失敗時も `onUpdate` でエラーdetails を通知して結果行に失敗を表示できるようにする。

## 環境変数

| 変数 | 影響 |
| --- | --- |
| `BROWSE_CLI_DIR` | `browse` 実行ファイルの配置ディレクトリ（既定は source tree で `.agents/cli.exact`、展開後は `.agents/cli`） |
| `CAMOUFOX_BASE_URL` | 子プロセスへ継承し、CLI側で解釈される |
| `OPENSERP_BASE_URL` | 子プロセスへ継承し、CLI側で解釈される |
