# ticket spec

`ticket` は `~/.agents/tickets/` の Markdown ticket を操作するCLIである。CLIの利用者と保守担当に向け、ストア形式、コマンドの入出力と実行結果を定める。

## ストアと安全境界

- 1 ticket は `~/.agents/tickets/<project>/<YYYYMMDD-HHMMSS>.md`。ID は拡張子を除くファイル名、順序は ID の辞書順
- frontmatter は `status`（必須）、`after`（任意、単一ID）を持つ。本文の最初の H1 を title とし、なければ ID を title とする
- `project` は `/`、`\\`、`.`、`..` を含まない単一のパス要素である。`-p/--project` と cwd から解決したproject のいずれもこの制約に従い、違反時はストア外を読書きしない
- `after` は同一project内の ID または一意な ID接頭辞で指定する。保存時は完全な ID に正規化する
- `status` は `draft`、`open`、`blocked`、`locked`、`closed`、`cancelled` のいずれか
- 同じfrontmatter内の `status`、`after` の重複は破損である。読み書きコマンドは失敗し、`check` は `invalid-frontmatter` として報告する

## 共通の振る舞い

| 条件 | 結果 |
| --- | --- |
| `-p/--project <name>` | 指定project を使う |
| project未指定 | Gitリポジトリ内では main worktree の basename、それ以外では cwd の basename を使う |
| `-a/--all` | `list` / `check` で全project を横断する。`-p` は無視する |
| 不存在project | `create` は作成し、その他は終了コード1 |
| `--json` | 成功時stdout は単一JSON。失敗時stdout は `{ "error": "..." }`、stderr は同じ1行、終了コードは失敗種別に従う。省略時はテキスト出力になり、`check` は `ok` または `file: kind: detail` 行、`list` は 1 ticket = 1行の tab区切り、`show` はフィールド行と本文、`create` / `set` / `edit` は `created` / `updated` 行に共通フィールドを続ける |
| `--` | 後続を位置引数として扱う |
| I/O例外 | stderr に 1行を出し終了コード1。書込みトランザクションは復元し、復元不能なら次の書込み前に journal から復元する |

終了コードは成功が 0、値・状態・環境・I/O の不備が 1、未知の flag/command、必須引数不足、JSON の型不備、許可外key、空 `set`、空 `edit.old` が 2 である。書込みコマンドは validation failure時に ticket を変更しない。

## 排他と原子性

- `create`、`set`、`edit` は projectごとの排他区間で、読込み、検証、書込み、依存解放を直列化する
- `create` は排他的ファイル作成で ID を確保する。同一秒の競合時は次秒以降の ID で再試行し、既存ticket を上書きしない
- 1コマンドの複数ticket更新は journal と一時ファイルを用いる。すべての次内容を準備してから renameし、失敗時は既に置換した内容を復元する
- `set` が `closed` にする場合、排他区間内で再読した `status: blocked` かつ `after` が対象ID の ticket だけをすべて `open` にする

## セレクタ

`show`、`set`、`edit` の selector は完全ID、一意な接頭辞、または `next`。省略時は `next`。複数候補、不存在、actionable ticket不在は終了コード1。actionable は `status: open` かつ `after` が未設定または参照ticket が `closed` の ticket である。

## after と status

`after` の設定先は存在し、`closed` / `cancelled` でなく、循環を作らないticket である。未解決の after を status明示なしで設定すると `blocked`、`after: null` を status明示なしで blocked ticket に設定すると `open`。status明示時はその値を優先する。

## コマンド

### `ticket list [-s <s>[,<s>...]] [-p <project>] [-a] [--json]`

既定では open ticket を出力する。`-s` は指定status だけを出力する。テキスト出力は `[project<TAB>]ID<TAB>status<TAB>title` 形式の 1 ticket 1行で、0件のときは `no tickets` を出す。`--all` 時だけ `project` を前置する。JSON共通フィールドは `id`、`status`、`after`（未設定は `null`）、`title`、`path`、`--all` 時だけ `project`。

### `ticket show [<selector>] [-p <project>] [--json]`

ID、status、after、title、本文全体を返す。テキスト出力は `id:`、`status:`、`after:`、`title:` の各フィールド行、空行、`body:` 行、本文の順で、本文の末尾空白・改行を保持する。JSON は共通フィールドと末尾空白・改行を保持した `body` を返す。

### `ticket create <json> [-p <project>] [--json]

JSON は必須の `title` と任意の `status`、`after`、`body` を持つ。作成するファイルでは frontmatter終端と H1 の間に空行を1行置く。body は H1 の後の空行を挟んで置く。after が未解決で status未指定なら blocked で作る。成功時は `created <id>` に status、after、path を続けるテキスト、または JSON共通フィールドを返す。

### `ticket set [<selector>] <json> [-p <project>] [--json]

JSON の許可key は `status` と `after` だけであり、少なくとも一方を含む。frontmatter と status連動を更新する。`status: closed` は上記の原子操作で依存ticket を解放する。成功時は `updated <id>` に status、after、path を続けるテキスト、または JSON共通フィールドを返す。

### `ticket edit [<selector>] <old> <new> [-p <project>] [--json]

frontmatter を除く本文全体（H1 を含む）の literal な `<old>` を検索する。正確に 1回なら `<new>` へ置換する。0回または複数回なら出現数と現在本文を stderr に出し、変更しない。空の old は usage error、空の new は削除である。成功時は `updated <id>` に status、after、path を続けるテキスト、または JSON共通フィールドを返す。

### `ticket check [-p <project>] [-a] [--json]`

frontmatter、重複field、status、missing after、after cycle を検証する。問題の JSON要素は `file`、`kind`、`detail` を持つ。問題なしは `ok` または空配列を返す。

### `ticket dispatch`

dispatcher は ticket store から起動可能な ticket を探してプロンプトを生成し、tmux 上に ticketごとの piセッションを起動する。ticket の status とセッションの有無を監視し、空いた稼働枠へ次の起動可能ticket を補充する。稼働枠とは、同じproject の dispatcher が監視し、今回の実行でまだ解放していない piセッションごとの枠を指す。

| コマンド | 動作 |
| --- | --- |
| `ticket dispatch start [<work-dir>] [--max N] [--interval SEC] [--prefix NAME]` | dispatcher を detached tmuxセッションで起動する |
| `ticket dispatch [<work-dir>] [--max N] [--interval SEC] [--prefix NAME]` | `start` と同じ動作 |
| `ticket dispatch stop` | 現在のproject の dispatcher を停止する |

project は「共通の振る舞い」の project未指定時と同じ cwdベースの解決で選ぶ。同じproject に解決される別の cwd・worktree からも同じ dispatcher を操作する。

#### 入力と配置

`<work-dir>` は省略できる。省略時は start を呼び出したプロセスの cwd が `WORK` になる。指定した `<work-dir>` の相対パスは同じ cwd を基準に解決する。stop は位置引数・オプションを受け付けず、ticket store の存在や内容に依存せず操作できる。start は次の3オプションを受け付ける。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--max N` | `5` | 未解放の監視枠数（稼働数）の上限。1以上の整数 |
| `--interval SEC` | `30` | tick間隔の秒数。0より大きい有限の数値、小数可 |
| `--prefix NAME` | `fix_` | piセッション名の接頭辞 |

| 入出力 | パス・規則 |
| --- | --- |
| 固定本文 | CLI同梱の `dispatch-prompt.md` の冒頭 `ticket {{ TICKET_ID }}` に ticket ID を文字どおり埋め込む |
| prompt | `WORK/fix/prompt-<ID>.txt` |
| log | `WORK/dispatch.log` へ追記する |
| dispatcher・pi の cwd | start を呼び出したプロセスの cwd |
| tmux socket | `/run/user/1000/pi-tmux/server.sock`。`TICKET_TEST_TMUX_SOCKET` 指定時はその socket を使う |

固定本文は dispatch の実行ごとに読み込む。作業ディレクトリにテンプレートを用意する必要はなく、ソースからの実行とコンパイル済みCLI のどちらでも同梱本文を使う。dispatch は ticket を変更しない。dispatch の引数、ticket読取り、ログ、終了条件は本節に従う。

#### 固定プロンプトと user への説明

生成するプロンプトは、起動したpi に `ticket {{ TICKET_ID }}` の1件対処を依頼し、作業とticket更新は skill `tickets` に従わせる。pi は user がticketを読んでいない前提で、次の説明と対応を行う。

| 場面・条件 | 説明と対応 |
| --- | --- |
| ticket本文を読み、調査を始める前 | 対象の機能・利用場面、どの操作・状況で何が起きて何に困るか、今回調べること・直すことを説明する。記録上の指摘と確認済みの事実を区別する |
| 問題が再現した | 再現したこと自体の報告・確認を挟まず、適用中の承認手順に従って修正・検証を進める |
| 再現せず、取り下げを推奨する | 確認した条件・結果・取り下げを勧める理由を示し、user の承認を待つ。未再現だけを解決済みの根拠にしない |
| 重複・対応不要・見送りを推奨する、または判断材料が不足する | 根拠と推奨する扱い・確認事項を示し、修正に入らずuser の承認を待つ。承認前に取り下げや `closed`・`cancelled` への変更を行わない |
| 判断を求めるとき | 対象の問題を短く述べ直し、今回決めること・選択肢・推奨理由・user がすることを説明する |
| 終了時 | 何がどう改善したか、検証で分かったこと、残件、user の対応要否を説明する |

各説明は、ticket のタイトルや内部用語だけで済ませず、そのメッセージだけで問題と対応が分かる形にする。

#### start と stop

同じproject の dispatcher は同時に1つだけ動作する。dispatcher の識別は `WORK`・`--prefix` に依存せず、他project の dispatcher・piセッションを停止・引継ぎの対象にしない。

| 条件・操作 | 結果 |
| --- | --- |
| dispatcher が未起動で start | 固定本文・ticket store を読み、fixディレクトリ作成と log書込みが可能なことを確認して、project を識別する名前の detached tmuxセッションを作る |
| dispatcher用tmuxセッションの作成成功 | セッション名と logパスを stdout へ出し、呼出元CLI は終了コード0で戻る。全ticket の完了を待たない |
| 同じproject の dispatcher が起動済みで start | 既存セッション名と起動済みである旨を stdout へ出して終了コード0。既存の起動条件・監視を保持する |
| dispatcher が起動中で stop | dispatcher用セッションだけを終了し、停止した旨を stdout へ出して終了コード0。起動済みpi は作業を続ける |
| dispatcher が未起動で stop | 停止済みである旨を stdout へ出して終了コード0 |
| stop 後に start | 同じproject の残存piセッションを起動済み・稼働中として引き継ぎ、同じticket の pi を二重起動しない |

引き継いだpi のセッション名と cwd は保持する。新しい `WORK`・`--prefix` で start しても残存pi を引き継ぎ、新規起動には今回の start の条件を使う。残存pi の数が今回の `--max` 以上なら、その数が上限未満になるまで新規起動を待つ。

start の成功は dispatcher用tmuxセッションの作成成功を表し、その後の監視継続や pi起動成功を保証しない。ソースからのCLI起動とコンパイル済みCLI のどちらでも同じ動作を提供する。

#### piセッションの起動

ID `X` のセッション名は、`--prefix` に `X` の `.` を `_` へ全置換した文字列を連結した名前である。起動対象ごとに prompt を書き、その内容全体を単一引数として `pi` へ渡す。promptパス内の空白・単一引用符を保持する。

存在確認は `has-session -t =<セッション名>` の完全一致で行う。他project または dispatcher管理外の既存セッションと名前が衝突する場合は、そのセッションを変更せず、その ticket の起動失敗を記録する。衝突したセッションを稼働中として扱わず、今回の実行中はその ticket を再起動しない。

起動コマンドが失敗した場合は `tmux new-session failed for <セッション名>: <エラー内容>` を dispatcher の stderr と log へ出す。名前の衝突以外の失敗は稼働として登録し、以降の tick の解放条件で判定する。

#### tick と終了

起動時に `dispatcher start max=<max>` を記録する。最初の tick を直ちに行い、その後は `--interval` 秒ごとに次の順で繰り返す。各 tick で ticket store を読み直し、起動可能ticket と稼働中ticket の status を判定する。

| 順 | 条件 | 結果 |
| --- | --- | --- |
| 1 | 稼働中ticket の status が `closed`、`cancelled`、`blocked` のいずれか | `done <ID> status=<status>` を記録し、piセッションを保持したまま稼働枠を解放する |
| 2 | 1で解放していない稼働中セッションが tmux 上に存在しない | `incomplete <ID> status=<status\|none> session exited without close` を記録し、稼働枠を解放する。その ticket は再起動しない |
| 3 | 稼働数が `--max` 未満で、起動可能ticket がある | 起動可能ticket を ID の古い順に空き枠の数だけ選び、起動する。起動ごとに `launched <ID> as <セッション名>` を記録する |
| 4 | 稼働数が0で、起動可能ticket がない | `dispatcher finished` を記録し、dispatcher用セッションを終了する。終了後の ticket の追加・変化は、次回の start で扱う |

1の解放をすべて行ってから2へ進む。同じ tick で解放した稼働枠を3の補充に使う。

起動可能ticket は、「セレクタ」の actionable の条件を満たし、稼働中でも今回の実行で起動済みでもない ticket である。引き継いだ ticket、done や incomplete で解放した ticket も今回の起動済みに含まれ、再び起動しない。実行中に store へ追加された ticket と、`after` の解消で open になった ticket は、次の tick から起動可能になる。

#### ログとエラー

ログはローカル時刻の `[YYYY-MM-DD HH:MM:SS] <メッセージ>` を1行として dispatcher の stdout へ出し、同じ行を log へ追記する。呼出元CLI の stdout は start・stop の操作結果を示す。

| 条件 | 結果 |
| --- | --- |
| start の余分な位置引数、空の `<work-dir>`、未知のオプション、値の不足、`--max` / `--interval` の値の不正、stop への引数指定 | usage を呼出元CLI の stderr へ出し、終了コード2 |
| 新規start の事前確認で ticket の値・状態・環境が不正 | 既存CLI と同じ validationエラーを呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動しない |
| 新規start の事前確認で固定本文読込み・fixディレクトリ作成・log書込みに失敗 | `I/O error: <エラー内容>` を呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動しない |
| dispatcher用tmuxセッションの作成、または稼働中dispatcher の停止に失敗 | 操作と理由を呼出元CLI の stderr へ出し、終了コード1 |
| start成功後に ticket読取り、固定本文読込み、prompt・log書込みなどの継続不能なエラー | エラーを dispatcher の stderr へ出し、log が書込み可能なら同じエラーを追記して dispatcher用セッションを終了する。起動済みpi は作業を続け、呼出元CLI の終了コードは変化しない |

#### ライフサイクル

dispatcher を終了させると監視と補充が止まる。tmux server の終了または OS再起動で dispatcher と piセッションが消え、自動では再開しない。
