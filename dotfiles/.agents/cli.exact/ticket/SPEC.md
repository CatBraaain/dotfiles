# ticket spec

`ticket` は `~/.agents/tickets/` の Markdown ticket を操作するCLIである。CLIの利用者と保守担当に向け、ストア形式、コマンドの入出力と実行結果を定める。

## ストアと安全境界

- 1 ticket は `~/.agents/tickets/<project>/<YYYYMMDD-HHMMSS>.md`。ID は拡張子を除くファイル名、順序は ID の辞書順
- frontmatter は `status`（必須）、`after`（任意、単一ID）を持つ。本文の最初の H1 を title とし、なければ ID を title とする
- `project` は空でなく、`/` と `\` を含まず、`.` と `..` ではない単一のパス要素である。`-p/--project`、cwd から解決したproject のいずれもこの制約に従い、違反時はストア外を読書きしない
- `after` は同一project内の ID または一意な ID接頭辞で指定する。保存時は完全な ID に正規化する
- `status` は `draft`、`open`、`blocked`、`locked`、`closed`、`cancelled` のいずれか
- 同じfrontmatter内の `status`、`after` の重複は破損である。読み書きコマンドは失敗し、`check` は `invalid-frontmatter` として報告する

## 共通の振る舞い

| 条件 | 結果 |
| --- | --- |
| `-p/--project <name>` | project指定に対応するコマンドで、指定project を使う |
| project未指定 | project単位の操作では、Gitリポジトリ内なら main worktree の basename、それ以外なら cwd の basename を使う |
| `-a/--all` | `list` / `check` / `dispatch` で全project を横断する。project指定は無視する |
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

位置引数を指定すると usageエラー（終了コード2）とする。

既定では open ticket を出力する。`-s` は指定status だけを出力する。テキスト出力は `[project<TAB>]ID<TAB>status<TAB>title` 形式の 1 ticket 1行で、0件のときは `no tickets` を出す。`--all` 時だけ `project` を前置する。JSON共通フィールドは `id`、`status`、`after`（未設定は `null`）、`title`、`path`、`--all` 時だけ `project`。

### `ticket stats [--json]`

全project の ticket を、project別・status別に集計する。project名の辞書順に出力し、status は `draft`、`open`、`blocked`、`locked`、`closed`、`cancelled` の順とする。ticket がないproject も各件数を0として出す。

テキスト出力は先頭行を列見出し、以降を1 project 1行とする。先頭列の見出しは `project`、件数列の見出しは各status名である。列間は半角スペース2個とし、各列を次の規則で整列する。幅は文字数ではなく端末上の表示幅で求め、日本語の全角文字は半角文字2個分として扱う。

| 列 | 幅 | 揃え |
| --- | --- | --- |
| project名 | 見出しと全project名の最大表示幅 | 見出し・名前とも左揃え |
| 各statusの件数 | 見出しと全projectの件数の十進表記の最大表示幅 | 見出し・件数とも右揃え |

JSON は `project` と各status名をkeyとする件数を持つオブジェクトの配列である。project が0件なら、テキストは `no tickets`、JSON は空配列を返す。ストアルートの不存在と不正なticket は終了コード1とし、部分的な集計結果を返さない。

位置引数と未対応のオプションは usageエラー（終了コード2）とする。

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

dispatcher は ticket store から起動可能な ticket を探してプロンプトを生成し、tmux 上に ticketごとの piセッションを起動する。ticket の status とセッションの有無を監視し、空いた稼働枠へ次の起動可能ticket を補充する。稼働枠とは、その dispatcher が監視し、今回の実行でまだ解放していない piセッションごとの枠を指す。

| コマンド | 動作 |
| --- | --- |
| `ticket dispatch start [-p <project>] [-a] [--max N] [--interval SEC] [--prefix NAME]` | dispatcher を detached tmuxセッションで起動する |
| `ticket dispatch [-p <project>] [-a] [--max N] [--interval SEC] [--prefix NAME]` | `start` と同じ動作 |
| `ticket dispatch stop [-p <project>] [-a]` | 指定した範囲の dispatcher を停止する |

`-a/--all` 指定時は全project を対象とするグローバルdispatcher、未指定時は1 project を対象とするproject単位dispatcher を操作する。操作範囲が同じなら、別のディレクトリ・worktree からも同じ dispatcher を操作する。

#### 入力と配置

start と stop は共通の `-p/--project <name>` と `-a/--all` を受け付ける。start は、さらに次の3オプションを受け付ける。

| start の入力 | ticket store のproject | dispatcher の cwd | 新規pi の cwd |
| --- | --- | --- | --- |
| `--all` 指定 | 全project。project指定は無視する | 呼出時の cwd | ticket が属するproject の `~/projects/<project>` |
| `--all` なし、`-p/--project` 指定 | 指定したproject名をそのまま使う | ホームディレクトリ配下の `projects/<project>` | dispatcher と同じ |
| `--all` なし、`-p/--project` 省略 | 共通の振る舞いに従い、呼出時の cwd から解決する | 呼出時の cwd | dispatcher と同じ |

指定したproject名は、起動先のGitリポジトリや main worktree の basename に置き換えない。project名に含まれる空白・引用符を保持する。

stop は `--all` 指定時にグローバルdispatcher、それ以外では共通の振る舞いに従って解決したproject の dispatcher を操作する。起動先ディレクトリへの移動を行わず、ticket store と起動先ディレクトリの存在や内容に依存せず操作できる。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--max N` | `5` | dispatcher全体の未解放の監視枠数（稼働数）の上限。1以上の整数。グローバルでは全project の合計に適用する |
| `--interval SEC` | `30` | tick間隔の秒数。0より大きい有限の数値、小数可 |
| `--prefix NAME` | `fix_` | piセッション名の接頭辞 |

| 入出力 | パス・規則 |
| --- | --- |
| 固定本文 | CLI同梱の `dispatch-prompt.md` の冒頭 `ticket {{ TICKET_ID }}` に ticket ID を文字どおり埋め込む |
| tmux socket | `/run/user/1000/pi-tmux/server.sock`。`TICKET_TEST_TMUX_SOCKET` 指定時はその socket を使う |

固定本文は dispatch の実行ごとに読み込む。作業ディレクトリにテンプレートを用意する必要はなく、ソースからの実行とコンパイル済みCLI のどちらでも同梱本文を使う。dispatch は ticket と作業ディレクトリの既存ファイルを変更しない。dispatch の引数、ticket読取り、ログ、終了条件は本節に従う。

#### 固定プロンプトと user への説明

生成するプロンプトは、起動したpi に `ticket {{ TICKET_ID }}` の1件対処を依頼し、作業とticket更新は skill `tickets` に従わせる。pi は user がticketを読んでいない前提で、次の説明と対応を行う。

| 場面・条件 | 説明と対応 |
| --- | --- |
| user の回答・承認を待って止まるとき、または作業完了時 | 最後のアシスタントメッセージに、対象の仕組みの役割・利用場面、本来の動作に対する支障、調査・対応結果と残る作業をまとめる。途中のメッセージを読まずに理解できる説明とし、記録上の指摘と確認済みの事実を区別する |
| 問題が再現した | 再現したこと自体の報告・確認を挟まず、適用中の承認手順に従って修正・検証を進める |
| 再現せず、取り下げを推奨する | 確認した条件・結果・取り下げを勧める理由を示し、user の承認を待つ。未再現だけを解決済みの根拠にしない |
| 重複・対応不要・見送りを推奨する、または判断材料が不足する | 根拠と推奨する扱い・確認事項を示し、修正に入らずuser の承認を待つ。承認前に取り下げや `closed`・`cancelled` への変更を行わない |
| 判断を求めるとき | 要約に続けて、現在の影響、今回の対処で変わること、決めること・選択肢・推奨理由・user がすることを説明する |
| 終了時 | 要約に続けて、何がどう改善したか、検証で分かったこと、残件、user の対応要否を説明する |

最後の説明は、ticket のタイトルや内部用語だけで済ませず、仕組みの役割と支障を先に伝え、ファイル名・内部用語・詳細な根拠はその後に添える。過去の失敗と現在の影響、原因の解消と症状への対処を区別し、背景や影響が不明な箇所を推測で補わない。

#### start と stop

同じ範囲の dispatcher は同時に1つだけ動作する。dispatcher の識別は `--prefix` に依存せず、グローバルと各project を区別する。グローバルとproject単位の dispatcher の同時稼働は、起動順にかかわらず拒否する。同時に start が呼ばれた場合も、この境界を守る。異なるproject のproject単位dispatcher は、それぞれ動作できる。

| 条件・操作 | 結果 |
| --- | --- |
| 同じ範囲の dispatcher が起動済みで start | 既存セッション名と起動済みである旨を stdout へ出して終了コード0。既存の起動条件・監視を保持する |
| グローバル起動中にproject単位を start、またはproject単位が1つでも起動中にグローバルを start | 重複する範囲の dispatcher が起動中である旨を stderr へ出して終了コード1。既存セッションを保持する |
| dispatcher が未起動で start | 固定本文・対象範囲のticket store を読み、その範囲を識別する名前の detached tmuxセッションを作る |
| dispatcher用tmuxセッションの作成成功 | セッション名を stdout へ出し、呼出元CLI は終了コード0で戻る。全ticket の完了を待たない |
| dispatcher が起動中で stop | dispatcher用セッションだけを終了し、停止した旨を stdout へ出して終了コード0。起動済みpi は作業を続ける |
| dispatcher が未起動で stop | 停止済みである旨を stdout へ出して終了コード0 |
| stop 後に start | 対象範囲の残存piセッションを起動済み・稼働中として引き継ぎ、同じticket の pi を二重起動しない |

stop は指定した範囲の dispatcher だけを対象とする。グローバルの stop でproject単位dispatcher を停止せず、project単位の stop でグローバルdispatcher を停止しない。

引継ぎ対象は ticket CLI が起動したpiセッションであり、グローバルでは全project、project単位ではそのproject に限る。以前の起動がグローバルかproject単位かにかかわらず、対象範囲の残存pi を引き継ぐ。引き継いだpi のセッション名と cwd は保持する。新しい `--prefix` で start しても残存pi を引き継ぎ、新規起動には今回の start の条件を使う。残存pi の数が今回の `--max` 以上なら、その数が上限未満になるまで新規起動を待つ。

start の成功は dispatcher用tmuxセッションの作成成功を表し、その後の監視継続や pi起動成功を保証しない。ソースからのCLI起動とコンパイル済みCLI のどちらでも同じ動作を提供する。

#### piセッションの起動

ticket はproject と ID の組で識別し、異なるproject に同じ ID があっても別ticket として起動・監視する。

project単位で起動する ID `X` のセッション名は、`--prefix` に `X` の `.` を `_` へ全置換した文字列を連結した名前である。グローバルで新規起動する場合は、`--prefix`、project名をUTF-8として小文字の16進表記にした文字列、`_`、同じ変換をした ID を連結する。

起動対象ごとに生成した prompt の内容全体を単一引数として `pi` へ直接渡す。本文の空白・引用符・末尾改行を保持する。

存在確認は `has-session -t =<セッション名>` の完全一致で行う。他project または dispatcher管理外の既存セッションと名前が衝突する場合は、そのセッションを変更せず、その ticket の起動失敗を記録する。衝突したセッションを稼働中として扱わず、今回の実行中はその ticket を再起動しない。

起動コマンドが失敗した場合は `tmux new-session failed for <セッション名>: <エラー内容>` を dispatcher の stderr と stdout へ出す。名前の衝突以外の失敗は稼働として登録し、以降の tick の解放条件で判定する。

#### tick と終了

起動時に `dispatcher start max=<max>` を記録する。最初の tick を直ちに行い、その後は `--interval` 秒ごとに次の順で繰り返す。各 tick で対象範囲の ticket store を読み直し、起動可能ticket と稼働中ticket の status を判定する。グローバルでは各 tick でproject一覧も読み直す。

| 順 | 条件 | 結果 |
| --- | --- | --- |
| 1 | 稼働中ticket の status が `closed`、`cancelled`、`blocked` のいずれか | `done <ID> status=<status>` を記録し、piセッションを保持したまま稼働枠を解放する |
| 2 | 1で解放していない稼働中セッションが tmux 上に存在しない | `incomplete <ID> status=<status\|none> session exited without close` を記録し、稼働枠を解放する。その ticket は再起動しない |
| 3 | 稼働数が `--max` 未満で、起動可能ticket がある | 起動可能ticket を ID の古い順に空き枠の数だけ選び、起動する。起動ごとに `launched <ID> as <セッション名>` を記録する |
| 4 | 稼働数が0で、起動可能ticket がない | `dispatcher finished` を記録し、dispatcher用セッションを終了する。終了後の ticket の追加・変化は、次回の start で扱う |

1の解放をすべて行ってから2へ進む。同じ tick で解放した稼働枠を3の補充に使う。

起動可能ticket は、「セレクタ」の actionable の条件を満たし、稼働中でも今回の実行で起動済みでもない ticket である。after はticket が属する同一project 内で判定する。グローバルでは全project の候補をまとめて ID の辞書順に選び、同じ ID はproject名の辞書順にする。ID の日時部分を作成日時として扱う。

引き継いだ ticket、done や incomplete で解放した ticket も今回の起動済みに含まれ、再び起動しない。実行中に store へ追加された ticket と、`after` の解消で open になった ticket は、次の tick から起動可能になる。

#### ログとエラー

ログはローカル時刻の `[YYYY-MM-DD HH:MM:SS] <メッセージ>` を1行として dispatcher の stdout へ出す。グローバルのticket別ログでは `<ID>` を `<project>/<ID>` として表示する。呼出元CLI の stdout は start・stop の操作結果を示す。

| 条件 | 結果 |
| --- | --- |
| 位置引数の指定、未知のオプション、値の不足、`--max` / `--interval` の値の不正、stop への `--max` / `--interval` / `--prefix` 指定 | usage を呼出元CLI の stderr へ出し、終了コード2 |
| project名がストアと安全境界の制約に違反 | 既存CLI と同じ validationエラーを呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動・停止しない |
| start の cwd、またはグローバルで新規起動候補となるticket の対象cwd が存在しない、ディレクトリでない、または移動できない | `I/O error: <エラー内容>` を呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動せず、pi も起動しない |
| 新規start の事前確認で ticket の値・状態・環境が不正 | 既存CLI と同じ validationエラーを呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動しない |
| 新規start の事前確認で固定本文読込みに失敗 | `I/O error: <エラー内容>` を呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動しない |
| dispatcher用tmuxセッションの作成、または稼働中dispatcher の停止に失敗 | 操作と理由を呼出元CLI の stderr へ出し、終了コード1 |
| start成功後に ticket読取り、固定本文読込み、グローバルの新規起動候補の対象cwd確認などの継続不能なエラー | エラーを dispatcher の stderr と stdout へ出し、dispatcher用セッションを終了する。起動済みpi は作業を続け、呼出元CLI の終了コードは変化しない |

グローバルの新規起動候補の対象cwd は、start の事前確認と各 tick の新規起動前にまとめて確認する。不正な対象cwd が1つでもあれば、その確認に続くpi起動を行わず、上表の失敗時の動作に従う。

#### ライフサイクル

dispatcher を終了させると監視と補充が止まる。tmux server の終了または OS再起動で dispatcher と piセッションが消え、自動では再開しない。
