# ticket CLI spec

コマンド `ticket` の仕様。人間とコーディングエージェントが、`~/.agents/tickets/` 配下の markdown チケットを一覧・参照・作成・状態変更するための CLI。

## ストア

- チケットストアは `~/.agents/tickets/<project>/<YYYYMMDD-HHMMSS>.md`。1 ticket = 1 markdown ファイルで、frontmatter に `status`（必須）と `after`（省略可、単一の ID）、本文の H1 がタイトル。H1 がない ticket のタイトルは ID とする
- ticket の ID はファイル名から拡張子を除いた文字列（例: `20260918-125653`）
- ticket の並び順は ID の辞書順とする（timestamp のみの ID は起票時刻順に一致する）
- `after` が参照する ID の解決は同一 project 内に限定する

`status` は次の 6 種のいずれかである。

| status | 意味 |
|---|---|
| `draft` | アイデアなどを溜めている途中段階 |
| `open` | 未着手 |
| `locked` | いずれかのセッションが対処を保持している（排他） |
| `blocked` | 着手条件が未充足。外部要因の待ちと、`after` で指す依存 ticket の未解決待ちを含む |
| `closed` | 完了 |
| `cancelled` | 中止 |

## 共通の振る舞い

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `-p/--project <name>` がある | 任意のコマンド実行 | `<name>` のディレクトリをストアとして扱う |
| どちらもない | 任意のコマンド実行 | cwd が Git リポジトリ内のときは main worktree の basename を、そうでないときはカレントディレクトリの basename を project 名として扱う |
| `-a/--all` がある | `list` / `check` 実行 | `~/.agents/tickets/` 配下の全 project を横断する |
| `-a/--all` と `-p/--project` の両方がある | `list` / `check` 実行 | `--all` を優先し、`--project` を無視する |
| 指定 project のディレクトリが存在しない | `create` 実行 | project のディレクトリを作成してから起票する |
| 指定 project のディレクトリが存在しない | `list` / `show` / `set` / `edit` / `check` 実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |
| ストアルート（`~/.agents/tickets/`）が存在しない | `--all` 付きのコマンド実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |
| `--json` がある | 任意のコマンド実行 | stdout に単一の JSON を出力する（jq でパース可能） |
| `--` がある | 任意のコマンド実行 | `--` より後ろの引数を位置引数として扱う。位置引数は `-` で始まっていてもフラグとして解釈しない |
| `status` を受け取る箇所（frontmatter・`-s`・JSON）に 6 種以外の値がある | 実行 | エラー 1 行を stderr へ出力し、終了コード 1 で終わる（書き込み系はファイルを書き換えない） |

### セレクタ

`show` / `set` / `edit` の第 1 引数はセレクタである。

| セレクタ | 条件 | 結果 |
|---|---|---|
| `<id>` | ID に完全一致する ticket がある | その ticket を対象にする |
| `<id>` | ID が接頭辞で一意に特定できる | 一致する 1 件を対象にする |
| `<id>` | ID が接頭辞で複数票になる | 候補 ID 一覧を stderr へ出力し、終了コード 1 で終わる |
| `<id>` | ID に一致する ticket がない | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |
| `next` | actionable な ticket が 1 件以上ある | ID 辞書順で最も古い 1 件を対象にする |
| `next` | actionable な ticket がない | エラー 1 行を stderr へ出力し、終了コード 1 で終わる |

セレクタを省略できるコマンドでは `next` が既定値である。actionable とは `status` が `open` かつ（`after` が未設定、または `after` で指す ticket の `status` が `closed`）であることをいう。

### 終了コード

| 終了コード | 条件 |
|---|---|
| 0 | 成功 |
| 1 | 値・状態・環境の不備。status 値の 6 種外、`after` の不存在・closed/cancelled 指定・循環、セレクタの不特定、`next` の該当なし、`edit` の 0 回・2 回以上マッチ、frontmatter の破損、project ディレクトリの不存在、書き込み検証の失敗、`check` の問題検出 |
| 2 | usage ミス。未知のコマンド・フラグ、必須引数の不足、値を要求するフラグに値がない、JSON のパース失敗・オブジェクト以外・型不備・`set` の許可外キー・空オブジェクト、`create` の `title` 欠落、`edit` の空の `<old>` |

usage ミスのときは usage を stderr へ出力し、終了コード 2 で終わる。書き込み系コマンドは、エラーになったときファイルを書き換えない。

## after と status の連動

`after` の設定・解除に連動した status の自動切り替えを行う。ただし操作の JSON に `status` キーがあるときは自動切り替えを行わず、指定された status をそのまま書き込む（明示指定を優先する）。

| 操作 | JSON の `status` | 書き込み後の status |
|---|---|---|
| `after` に未解決の ID を設定 | なし | `blocked` |
| `after` に未解決の ID を設定 | あり | 指定値 |
| `after` を `null` で解除 | なし、現 status が `blocked` | `open` |
| `after` を `null` で解除 | なし、現 status が `blocked` 以外 | 現 status のまま |
| `after` を `null` で解除 | あり | 指定値 |

未解決とは、`after` で指す ticket の `status` が `closed` 以外であることをいう。

## `ticket list`

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 引数なし | `ticket list` | 対象ストアの `status: open` の ticket を ID 辞書順に、1 行 1 ticket で ID・status・タイトルを出力する |
| `-s/--status <s>[,<s>...]` がある | `ticket list` | 指定 status のいずれかに一致する ticket のみを出力する |
| `--all` がある | `ticket list` | project 名順に project を並べ、各 project 内を ID 辞書順で出力し、各行の先頭に project 名を付ける |
| `--json` がある | `ticket list` | ticket 配列の JSON を出力する |
| ストアに一致する ticket がない | `ticket list` | 何も行を出力せず、終了コード 0 で終わる |

`--json` の共通フィールドは `id`、`status`、`after`（未設定なら `null`）、`title`、`project`（`--all` 時のみ）、`path` である。

## `ticket show`

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| セレクタが ticket を特定する | `ticket show` | ID・status・after に続けて、H1 を含む本文全体を出力する |
| `--json` がある | `ticket show` | 共通フィールド + H1 を含む本文（`body`）の JSON を出力する。`body` は本文の末尾空白・改行を保持する |

## `ticket create <json>`

新しい ticket の markdown ファイルを作成する。ID は起票時刻の `YYYYMMDD-HHMMSS`（ローカル時刻）で、同一秒の既存ファイルがあれば衝突しなくなるまで +1 秒ずらす。`<json>` はオブジェクトで、`title`（文字列、必須）、`status`（文字列、省略可）、`after`（文字列または `null`、省略可）、`body`（文字列、省略可）をキーに持つ。

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `<json>` に `title` がある | `ticket create <json>` | project のディレクトリがなければ作成し、`<project>/<YYYYMMDD-HHMMSS>.md` を作成する。frontmatter は `status: open`、本文は `# <title>` で始まり、作成した ID を 1 行出力する |
| `<json>` に `status` がある | `ticket create <json>` | frontmatter の `status` をその値にする |
| `<json>` に未解決の `after` があり、`status` がない | `ticket create <json>` | `status: blocked` で作成する |
| `<json>` に未解決の `after` があり、`status` がある | `ticket create <json>` | 指定された `status` で作成する（自動切り替えをしない） |
| `<json>` の `after` に存在しない ID、`closed` の ticket、`cancelled` の ticket を指定した | `ticket create <json>` | エラー 1 行を stderr へ出力し、終了コード 1 で終わる（ファイルは作成しない） |
| `<json>` に `body` がある | `ticket create <json>` | H1 の直後に空行 1 つ挟んで `<body>` を置く |
| `--json` がある | `ticket create <json>` | 作成した ticket の JSON（共通フィールド）を出力する |

## `ticket set`

`ticket set [<selector>] <json>`。frontmatter の `status` と `after` のみを更新する。`<json>` はオブジェクトで、キーは `status` と `after` のみ。指定のないフィールドは書き換えない。

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `<json>` に `status` がある | `ticket set` | frontmatter の `status` を書き換え、新しい status を 1 行出力する |
| `<json>` に `after` のみがある | `ticket set` | after と status の連動の表に従って frontmatter を書き換える。status を書き換えたときは新しい status を 1 行出力し、書き換えないときは何も出力しない |
| `<json>` の `after` に存在しない ID、`closed` の ticket、`cancelled` の ticket を指定した | `ticket set` | エラー 1 行を stderr へ出力し、終了コード 1 で終わる（ファイルは書き換えない） |
| `<json>` の `after` の設定により循環が生じる | `ticket set` | エラー 1 行を stderr へ出力し、終了コード 1 で終わる（ファイルは書き換えない） |
| `--json` がある | `ticket set` | 更新後の ticket の JSON（共通フィールド）を出力する |
| `<json>` に `status`・`after` 以外のキーがある | `ticket set` | usage を stderr へ出力し、終了コード 2 で終わる（ファイルは書き換えない） |
| `<json>` が空オブジェクト | `ticket set` | usage を stderr へ出力し、終了コード 2 で終わる（ファイルは書き換えない） |

### `set closed` による依存の解放

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `<json>` の `status` が `closed` | `ticket set` | 対象 ticket を `closed` に書き込んだ後、その ticket を `after` に持つ同一 project 内の ticket のうち `status: blocked` のものをすべて `open` に書き換える |
| `<json>` の `status` が `closed` 以外 | `ticket set` | 依存の解放を行わない |

依存の解放で書き換えた ticket があっても、`set` 自体の出力は変わらない。

## `ticket edit`

`ticket edit [<selector>] <old> <new>`。本文の部分置換を行う。置換対象は frontmatter を除くファイル全文（H1 を含む）である。frontmatter の更新は `set` の担当である。オプションを指定する場合は `<old> <new>` より前に置き、`--` をセレクタの後ろに置くと `-` で始まる `<old>`・`<new>` を位置引数として渡せる。

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| `<old>` が置換対象に正確に 1 回出現する | `ticket edit` | 最初の出現を `<new>` で置き換えて保存する。何も出力せず、終了コード 0 で終わる |
| `<old>` が 0 回または 2 回以上出現する | `ticket edit` | 出現回数と現在の本文全体を stderr へ出力し、終了コード 1 で終わる（ファイルは書き換えない） |
| `--json` がある | `ticket edit` | 更新後の ticket の JSON（共通フィールド）を出力する |

`<old>` は空でない文字列である。`<new>` は必須の位置引数で、空文字列を指定したときは該当箇所を削除する。

## `ticket check`

| 条件・状態 | 操作 | 結果 |
|---|---|---|
| 全 ticket の整合性が取れている | `ticket check` | `ok` を出力し、終了コード 0 で終わる |
| frontmatter がない・閉じがない・`status` フィールドがない ticket がある | `ticket check` | ストアルートからの相対パス（`<project>/<file>`）と問題種別・内容を 1 行ずつ出力し、終了コード 1 で終わる |
| `status` が 6 種のいずれかでもない ticket がある | `ticket check` | 同上 |
| `after` に同一 project 内に存在しない ID がある ticket がある | `ticket check` | 同上 |
| `after` に循環がある | `ticket check` | 循環 1 件につき 1 行を出力し、終了コード 1 で終わる |
| `--json` がある | `ticket check` | 問題配列（空配列は問題なし）の JSON を出力する。要素のフィールドは `file`（`<project>/<file>`）、`kind`（`invalid-frontmatter` / `invalid-status` / `missing-after` / `after-cycle`）、`detail`（問題内容）で、終了コードは上記に準ずる |

`status: open` かつ未解決の `after` を持つ ticket は正当な状態であり、問題として検出しない（`next` の対象から除外されるのみである）。

## 制約

- `after` は単一であるため、「複数の依存 ticket がすべて解決するのを待つ」状態は表現できない
- `after` を設定した後に `after` 先が `cancelled` になった ticket は、`after` を解除するまで actionable にならず、`next` に選ばれない
