# ticket CLI spec

コマンド `ticket` の仕様。人間とコーディングエージェントが、`~/.agents/tickets/` 配下の markdown チケットを一覧・参照・状態変更するための CLI。

## ストア

- チケットストアは `~/.agents/tickets/<project>/*.md`。1 ticket = 1 markdown ファイルで、frontmatter に `status` と `depends_on`（省略可）、本文の H1 がタイトル。H1 がない ticket のタイトルは ID とする
- `status` の値は `draft` / `open` / `blocked` / `locked` / `closed` / `cancelled` の 6 種
- ticket の ID はファイル名から拡張子を除いた文字列（例: `20260917-180315_create-ticket-system-cli`）
- `depends_on` が参照する ID の解決は同一 project 内に限定する
- list 等の ticket 並び順は ID の辞書順とする（タイムスタンプ接頭辞付きの ID は起票時刻順に一致する）

## 共通の振る舞い

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `--project <name>` がある | 任意のコマンド実行 | `<name>` のディレクトリをストアとして扱う |
| `--all` がある | `list` / `check` 実行 | `~/.agents/tickets/` 配下の全 project を横断する |
| `--all` と `--project` の両方がある | `list` / `check` 実行 | `--all` を優先し、`--project` を無視する |
| どちらもない | 任意のコマンド実行 | カレントディレクトリの basename を project 名として扱う |
| 指定 project のディレクトリが存在しない | 任意のコマンド実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |
| ストアルート（`~/.agents/tickets/`）が存在しない | `--all` 付きのコマンド実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |
| `--json` がある | `list` / `show` / `check` 実行 | stdout に単一の JSON を出力する（jq でパース可能） |
| ID に完全一致する ticket がある | ID 参照コマンド実行 | その ticket を対象にする |
| ID が接頭辞で一意に特定できる | ID 参照コマンド実行 | 一致する 1 件を対象にする |
| ID が接頭辞で複数票になる | ID 参照コマンド実行 | 候補 ID 一覧を stderr へ出力し、終了コード 1 で終わる |
| ID に一致する ticket がない | ID 参照コマンド実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |
| コマンド指定がない・未知のコマンド・必須引数が不足している | 実行 | usage を stderr へ出力し、終了コード 1 で終わる |
| そのコマンドに定義のないフラグを渡した | 実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |
| 値を要求するフラグに値がない | 実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |
| `status` / `claim` / `close` の対象に frontmatter がない・閉じがない・`status` フィールドがない | 実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる（ファイルは書き換えない） |
| そのコマンドの定義を超える位置引数を渡した | 実行 | 余剰の位置引数を無視する |

`--json` のフィールド: `id`、`status`、`title`、`depends_on`（未指定なら空配列）、`project`（`--all` 時のみ）、`path`。

## `ticket list`

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 引数なし | `ticket list` | 対象ストアの全 ticket を ID の辞書順に、1 行 1 ticket で ID・status・タイトルを出力する |
| `--status <s>[,<s>...]` がある | `ticket list` | 指定 status のいずれかに一致する ticket のみを出力する |
| `--all` がある | `ticket list` | project 名順に project を並べ、各 project 内を ID の辞書順で出力し、各行の先頭に project 名を付ける |
| `--json` がある | `ticket list` | ticket 配列の JSON を出力する |
| ストアに ticket が 1 件もない | `ticket list` | 何も行を出力せず、終了コード 0 で終わる |

## `ticket show <id>`

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| ID が特定できる | `ticket show <id>` | ID・status・depends_on・タイトル・本文を順に出力する |
| `--json` がある | `ticket show <id>` | 共通フィールド + 本文（`body`）の JSON を出力する |

## `ticket status <id> <status>`

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `<status>` が 6 種のいずれか | `ticket status <id> <status>` | 対象 ticket の frontmatter `status` を書き換え、新 status を 1 行出力する |
| `<status>` が 6 種のいずれかでもない | `ticket status <id> <status>` | エラー 1 行を stderr へ出力し、終了コード 1 で終わる（ファイルは書き換えない） |

`ticket status` が検証するのは `<status>` の値のみで、遷移元→遷移先の妥当性は `ticket check` の担当である。

## `ticket claim <id>` と `ticket close <id>`

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 対象の status が `locked` 以外 | `ticket claim <id>` | `status: locked` に書き換え、`locked` を 1 行出力する |
| 対象の status が `locked` | `ticket claim <id>` | エラー 1 行を stderr へ出力し、終了コード 1 で終わる（排他の確保に失敗） |
| 任意の status | `ticket close <id>` | `status: closed` に書き換え、`closed` を 1 行出力する |

`claim` / `close` は本文を書き換えない。対処記録の追記は tickets skill の運用に従うエージェントの担当である。

## `ticket check`

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 全 ticket の整合性が取れている | `ticket check` | `ok` を出力し、終了コード 0 で終わる |
| `status` が 6 種のいずれかでもない ticket がある | `ticket check` | ストアルートからの相対パス（`<project>/<file>`）と問題種別・内容を 1 行ずつ出力し、終了コード 1 で終わる |
| `depends_on` に同一 project 内に存在しない ID がある ticket がある | `ticket check` | 同上 |
| `depends_on` に循環がある | `ticket check` | 循環 1 件につき 1 行を出力し、終了コード 1 で終わる |
| `depends_on` に `closed` 以外が含まれるのに `status: open` の ticket がある | `ticket check` | 同上（相対パスと問題種別・内容を 1 行ずつ） |
| `--json` がある | `ticket check` | 問題配列（空配列は問題なし）の JSON を出力する。要素のフィールドは `file`（`<project>/<file>`）、`kind`（`invalid-status` / `missing-dep` / `open-with-unresolved-deps` / `dep-cycle`）、`detail`（問題内容）で、終了コードは上記に準ずる |
