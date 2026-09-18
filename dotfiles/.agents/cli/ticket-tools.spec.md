# ticket tools spec

pi と dsh が LLM に公開する ticket 操作 tool 群の仕様。`ticket` CLI（`ticket.spec.md`）のラッパーであり、ストアの形式と CLI の振る舞いの正本は `ticket.spec.md` である。tool 自体はストアに直接アクセスせず、すべての読み書きを CLI 経由で行う。

## 構成

pi は `dotfiles/.pi/agent/extensions.exact/tickets/`、dsh は `dotfiles/.dsh/plugins.exact/tickets/` が、同じ名前・引数・振る舞いの 4 つの tool を登録する。system prompt への露出は 1 行の tool 要約に留める。pi では各 tool の `promptSnippet` を、dsh では各 tool の `description` が 1 行要約を兼ねる（運用ルールは tickets skill が担うため、tool 側は操作手段のみを提供する）。

| tool | 対応 CLI サブコマンド |
|---|---|
| `ticket_list` | `list` |
| `ticket_show` | `show` |
| `ticket_create` | `create` |
| `ticket_update` | `update` |

`check` サブコマンドと project 横断の運用判断は tool の対象外である。`check` が必要なときは tool を使える環境からでも `bash` で CLI を直接実行する。

## 共通の振る舞い

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 任意の tool 呼び出し | 実行 | `~/.agents/cli/ticket` を `--json` 付きで起動する。呼び出し元のセッション cwd を CLI の cwd として渡す |
| `project` 引数がある | 任意の tool 呼び出し | CLI の `--project` に渡す |
| `project` 引数がない | 任意の tool 呼び出し | `--project` を渡さず、CLI の既定解決（`ticket.spec.md` の「共通の振る舞い」）に従う |
| CLI が終了コード 1 で終わった | 任意の tool 呼び出し | stderr の内容をエラーテキストとして返す（tool 呼び出しは失敗として扱う） |
| CLI が存在しない・実行できない | 任意の tool 呼び出し | その旨のエラーテキストを返す（tool 呼び出しは失敗として扱う） |

tool 結果の本文は LLM が読むテキストであり、pi では `details` に、dsh では結果詳細に CLI の JSON を格納する。各 tool の description には、対応する CLI サブコマンドと引数の意味、ID は接頭辞で一意に特定できること（`ticket.spec.md` の「共通の振る舞い」）を含める。

## `ticket_list`

引数: `status`（文字列の配列、任意）、`project`（文字列、任意）、`all`（真偽値、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 引数なし | `ticket_list` 呼び出し | 対象ストアの全 ticket を、1 行 1 ticket のテキスト（ID・status・タイトル）で返す |
| `status` がある | `ticket_list` 呼び出し | 指定 status のいずれかに一致する ticket のみを返す |
| `all` が true | `ticket_list` 呼び出し | 全 project を横断し、各行の先頭に project 名を付けたテキストを返す |
| 対象が 0 件 | `ticket_list` 呼び出し | 0 件である旨の 1 行を返す |

## `ticket_show`

引数: `id`（文字列、必須）、`project`（文字列、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| ID が特定できる | `ticket_show` 呼び出し | ID・status・depends_on・タイトル・本文を含むテキストを返す |
| ID が特定できない・曖昧 | `ticket_show` 呼び出し | CLI のエラーを返す |

## `ticket_create`

引数: `title`（文字列、必須）、`body`（文字列、任意）、`status`（文字列、任意。既定は `open`）、`depends_on`（文字列の配列、任意）、`project`（文字列、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `title` がある | `ticket_create` 呼び出し | CLI の `create` を実行し、作成された ticket の ID・path・status を返す。ID 採番・slug 生成・整合性検証は CLI の仕様（`ticket.spec.md` の `ticket create`）に従う |
| CLI が検証エラーで失敗した | `ticket_create` 呼び出し | CLI のエラーテキストを返す |

## `ticket_update`

引数: `id`（文字列、必須）、`metadata`（オブジェクト、任意。キーは `status` と `depends_on` のみ）、`body`（文字列、任意）、`project`（文字列、任意）

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `metadata` か `body` のいずれかがある | `ticket_update` 呼び出し | CLI の `update` を実行し、更新後の ticket の ID・status・path を返す。frontmatter マージ・整合性検証は CLI の仕様（`ticket.spec.md` の `ticket update`）に従う |
| `metadata` も `body` もない | `ticket_update` 呼び出し | 更新対象がない旨のエラーを返す（CLI を起動しない） |
| CLI が検証エラーで失敗した | `ticket_update` 呼び出し | CLI のエラーテキストを返す |

`metadata` のオブジェクトは CLI の `--metadata` に JSON として渡す。LLM が排他（`locked` への重複着手）と `open` の依存解決を判断できるよう、`ticket_update` の description には対応する検証で失敗しうることを含める。
