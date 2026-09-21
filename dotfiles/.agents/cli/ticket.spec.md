# ticket CLI spec

`ticket` は `~/.agents/tickets/` の Markdown ticket を操作する CLI である。

## ストアと安全境界

- 1 ticket は `~/.agents/tickets/<project>/<YYYYMMDD-HHMMSS>.md`。ID は拡張子を除くファイル名、順序は ID の辞書順
- frontmatter は `status`（必須）、`after`（任意、単一 ID）を持つ。本文の最初の H1 を title とし、なければ ID を title とする
- `project` は `/`、`\\`、`.`、`..` を含まない単一のパス要素である。`-p/--project` と cwd から解決した project のいずれもこの制約に従い、違反時はストア外を読書きしない
- `after` は同一 project 内の ID または一意な ID 接頭辞で指定する。保存時は完全な ID に正規化する
- `status` は `draft`、`open`、`blocked`、`locked`、`closed`、`cancelled` のいずれか
- 同じ frontmatter 内の `status`、`after` の重複は破損である。読み書きコマンドは失敗し、`check` は `invalid-frontmatter` として報告する

## 共通の振る舞い

| 条件 | 結果 |
|---|---|
| `-p/--project <name>` | 指定 project を使う |
| project 未指定 | Git リポジトリ内では main worktree の basename、それ以外では cwd の basename を使う |
| `-a/--all` | `list` / `check` で全 project を横断する。`-p` は無視する |
| 不存在 project | `create` は作成し、その他は終了コード 1 |
| `--json` | 成功時 stdout は単一 JSON。失敗時 stdout は `{ "error": "..." }`、stderr は同じ 1 行、終了コードは失敗種別に従う |
| `--` | 後続を位置引数として扱う |
| I/O 例外 | stderr に 1 行を出し終了コード 1。書込みトランザクションは復元し、復元不能なら次の書込み前に journal から復元する |

終了コードは成功が 0、値・状態・環境・I/O の不備が 1、未知の flag/command、必須引数不足、JSON の型不備、許可外 key、空 `set`、空 `edit.old` が 2 である。書込みコマンドは validation failure 時に ticket を変更しない。

## 排他と原子性

- `create`、`set`、`edit` は project ごとの排他区間で、読込み、検証、書込み、依存解放を直列化する
- `create` は排他的ファイル作成で ID を確保する。同一秒の競合時は次秒以降の ID で再試行し、既存 ticket を上書きしない
- 1 コマンドの複数 ticket 更新は journal と一時ファイルを用いる。すべての次内容を準備してから rename し、失敗時は既に置換した内容を復元する
- `set` が `closed` にする場合、排他区間内で再読した `status: blocked` かつ `after` が対象 ID の ticket だけをすべて `open` にする

## セレクタ

`show`、`set`、`edit` の selector は完全 ID、一意な接頭辞、または `next`。省略時は `next`。複数候補、不存在、actionable ticket 不在は終了コード 1。actionable は `status: open` かつ `after` が未設定または参照 ticket が `closed` の ticket である。

## after と status

`after` の設定先は存在し、`closed` / `cancelled` でなく、循環を作らない ticket である。未解決の after を status 明示なしで設定すると `blocked`、`after: null` を status 明示なしで blocked ticket に設定すると `open`。status 明示時はその値を優先する。

## コマンド

### `ticket list [-s <s>[,<s>...]] [-p <project>] [-a] [--json]`

既定では open ticket を出力する。`-s` は指定 status だけを出力する。`--all` のテキスト出力は project、ID、status、title を tab 区切りにする。JSON 共通フィールドは `id`、`status`、`after`（未設定は `null`）、`title`、`path`、`--all` 時だけ `project`。

### `ticket show [<selector>] [-p <project>] [--json]`

ID、status、after、本文全体を返す。JSON は共通フィールドと末尾空白・改行を保持した `body` を返す。

### `ticket create <json> [-p <project>] [--json]

JSON は必須の `title` と任意の `status`、`after`、`body` を持つ。body は H1 の後の空行を挟んで置く。after が未解決で status 未指定なら blocked で作る。成功時は ID または JSON 共通フィールドを返す。

### `ticket set [<selector>] <json> [-p <project>] [--json]

JSON の許可 key は `status` と `after` だけであり、少なくとも一方を含む。frontmatter と status 連動を更新する。`status: closed` は上記の原子操作で依存 ticket を解放する。成功時は status または JSON 共通フィールドを返す。

### `ticket edit [<selector>] <old> <new> [-p <project>] [--json]

frontmatter を除く本文全体（H1 を含む）の literal な `<old>` を検索する。正確に 1 回なら `<new>` へ置換する。0 回または複数回なら出現数と現在本文を stderr に出し、変更しない。空の old は usage error、空の new は削除である。

### `ticket check [-p <project>] [-a] [--json]`

frontmatter、重複 field、status、missing after、after cycle を検証する。問題の JSON 要素は `file`、`kind`、`detail` を持つ。問題なしは `ok` または空配列を返す。
