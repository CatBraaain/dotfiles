# ticket tools spec

pi と dsh が LLM に公開する ticket 操作 tool 群の仕様。`ticket` CLI（`ticket.spec.md`）のラッパーであり、ストアの形式と CLI の振る舞いの正本は `ticket.spec.md` である。tool 自体はストアに直接アクセスせず、すべての読み書きを CLI 経由で行う。

## 構成

pi は `dotfiles/.pi/agent/extensions.exact/tickets/`、dsh は `dotfiles/.dsh/plugins.exact/tickets/` が、同じ名前・引数・振る舞いの 5 つの tool を登録する。system prompt への露出は 1 行の tool 要約に留める。pi では各 tool の `promptSnippet` を、dsh では各 tool の `description` が 1 行要約を兼ねる（運用ルールは tickets skill が担うため、tool 側は操作手段のみを提供する）。

| tool | 対応 CLI サブコマンド |
|---|---|
| `ticket_list` | `list` |
| `ticket_show` | `show` |
| `ticket_create` | `create` |
| `ticket_set` | `set` |
| `ticket_edit` | `edit` |

`check` サブコマンドと project 横断の運用判断は tool の対象外である。`check` が必要なときは tool を使える環境からでも `bash` で CLI を直接実行する。

## 共通の振る舞い

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 任意の tool 呼び出し | 実行 | `~/.agents/cli/ticket` を `--json` 付きで起動する。呼び出し元のセッション cwd を CLI の cwd として渡す |
| `project` 引数がある | 任意の tool 呼び出し | CLI の `--project` に渡す |
| `project` 引数がない | 任意の tool 呼び出し | `--project` を渡さず、CLI の既定解決（`ticket.spec.md` の「共通の振る舞い」）に従う |
| CLI が終了コード 1 で終わった | 任意の tool 呼び出し | stderr の内容をエラーテキストとして返す（tool 呼び出しは失敗として扱う） |
| CLI が終了コード 0 で JSON 以外を stdout に出力した | 任意の tool 呼び出し | その旨のエラーテキストを返す（tool 呼び出しは失敗として扱う） |
| CLI が存在しない・実行できない | 任意の tool 呼び出し | その旨のエラーテキストを返す（tool 呼び出しは失敗として扱う） |

tool 結果の本文は LLM が読むテキストであり、pi では `details` に、dsh では結果詳細に CLI の JSON を格納する。各 tool の description には、対応する CLI サブコマンドと引数の意味、セレクタは ID・一意な接頭辞・`next` のいずれかで、省略時は `next` になること（`ticket.spec.md` の「セレクタ」）を含める。

`ticket_set` と `ticket_edit` は、`status`・`after`・`old` に値が渡されていない等の CLI を起動しない検証で失敗したとき、tool 呼び出しの失敗としてその旨のエラーテキストを返す（CLI は起動しない）。

## `ticket_list`

引数: `status`（文字列の配列、任意）、`project`（文字列、任意）、`all`（真偽値、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 引数なし | `ticket_list` 呼び出し | 対象ストアの `open` の ticket を、1 行 1 ticket のテキスト（ID・status・タイトル）で返す |
| `status` がある | `ticket_list` 呼び出し | 指定 status のいずれかに一致する ticket のみを返す |
| `all` が true | `ticket_list` 呼び出し | 全 project を横断し、各行の先頭に project 名を付けたテキストを返す |
| 対象が 0 件 | `ticket_list` 呼び出し | 0 件である旨の 1 行を返す |

## `ticket_show`

引数: `selector`（文字列、任意。省略時は `next`）、`project`（文字列、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| セレクタが ticket を特定する | `ticket_show` 呼び出し | `id`・`status`・`after`・`title` のメタデータ、`body:` の区切り、H1 を含む本文全体をテキストで返す。本文の末尾空白・改行を保持する |
| セレクタが特定できない・曖昧 | `ticket_show` 呼び出し | CLI のエラーを返す |

## `ticket_create`

引数: `title`（文字列、必須）、`body`（文字列、任意）、`status`（文字列、任意）、`after`（文字列、任意）、`project`（文字列、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `title` がある | `ticket_create` 呼び出し | CLI の `create` に `{title, status, after, body}` のうち引数として渡されたキーのみを含む JSON を渡して実行し、作成された ticket の ID・status・after・path を返す。ID 採番・after と status の連動・検証は CLI の仕様（`ticket.spec.md` の `ticket create`）に従う |
| CLI が検証エラーで失敗した | `ticket_create` 呼び出し | CLI のエラーテキストを返す |

`after` は文字列のみを受け付ける。未解決の `after` を渡すと CLI が `status: blocked` で作成する（`status` も渡した場合はそちらが優先される）。

## `ticket_set`

引数: `selector`（文字列、任意。省略時は `next`）、`status`（文字列、任意）、`after`（文字列または `null`、任意。`null` は解除）、`project`（文字列、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `status` か `after` のいずれかがある | `ticket_set` 呼び出し | CLI の `set` を実行し、更新後の ticket の ID・status・after・path を返す。frontmatter 更新・after と status の連動・`set closed` による依存解放は CLI の仕様（`ticket.spec.md` の `ticket set`）に従う |
| `status` も `after` もない | `ticket_set` 呼び出し | 更新対象がない旨のエラーを返す（CLI を起動しない） |
| CLI が検証エラーで失敗した | `ticket_set` 呼び出し | CLI のエラーテキストを返す |

LLM が操作の結果を判断できるよう、`ticket_set` の description には after と status の連動（明示した `status` が優先されること）、`status: closed` で依存 ticket が `open` に解放されること、`after` の検証（存在しない・`closed`・`cancelled` の指定、循環で失敗する）を含める。

## `ticket_edit`

引数: `selector`（文字列、任意。省略時は `next`）、`old`（空でない文字列、必須）、`new`（文字列、必須。空文字列は該当箇所の削除）、`project`（文字列、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `old` が空でない | `ticket_edit` 呼び出し | CLI の `edit` を実行し、更新後の ticket の ID・status・after・path を返す。本文の部分置換・出現数の検証は CLI の仕様（`ticket.spec.md` の `ticket edit`）に従う。`old`・`new` が `-` で始まっていても位置引数として渡す |
| `old` が空 | `ticket_edit` 呼び出し | エラーを返す（CLI を起動しない） |
| CLI が 0 回・2 回以上マッチで失敗した | `ticket_edit` 呼び出し | 現在の本文全体を含む CLI のエラーテキストを返す |
