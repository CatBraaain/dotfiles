# ticket spec

`ticket` は `~/.agents/tickets/` の Markdown ticket を操作するCLIである。CLIの利用者と保守担当に向け、ストア形式、コマンドの入出力と実行結果を定める。

## ストアと安全境界

- 1 ticket は `~/.agents/tickets/<project>/<YYYYMMDD-HHMMSS>.md`。ID は拡張子を除くファイル名、順序は ID の辞書順
- frontmatter は `status`（必須）と `after`（任意、単一ID）を持つ。本文の最初の H1 を title とし、なければ ID を title とする
- `project` は空でなく、`/` と `\` を含まず、`.` と `..` ではない単一のパス要素である。`-p/--project`、cwd から解決したproject のいずれもこの制約に従い、違反時はストア外を読書きしない
- `after` は同一project内の ID または一意な ID接頭辞で指定する。保存時は完全な ID に正規化する
- `status` は `draft`、`open`、`blocked`、`locked`、`closed`、`cancelled` のいずれか
- 同じfrontmatter内の `status` または `after` の重複は破損である。読み書きコマンドは失敗し、`check` は `invalid-frontmatter` として報告する

## 共通の振る舞い

| 条件 | 結果 |
| --- | --- |
| `-p/--project <name>` | project指定に対応するコマンドで、指定project を使う |
| project未指定 | project単位の操作では、Gitリポジトリ内なら main worktree の basename、それ以外なら cwd の basename を使う |
| `-a/--all` | `list` / `check` / `dispatch start`（短縮形を含む）/ `dispatch stop` で全project を横断する。project指定は無視する |
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

### `ticket list [-s|--status <s>[,<s>...]] [-p|--project <project>] [-a|--all] [--json]`

位置引数を指定すると usageエラー（終了コード2）とする。

既定では open ticket を出力する。`-s` は指定status だけを出力する。テキスト出力は `[project<TAB>]ID<TAB>status<TAB>title` 形式の 1 ticket 1行で、0件のときは `no tickets` を出す。`--all` 時だけ `project` を前置する。JSON共通フィールドは `id`、`status`、`after`（未設定は `null`）、`title`、`path`、`--all` 時だけ `project`。

### `ticket stats [--json]`

全project の ticket を、project別・status別に集計する。project名の辞書順に出力し、status は `draft`、`open`、`blocked`、`locked`、`closed`、`cancelled` の順とする。ticket がないproject も各件数を0として出す。

テキスト出力は先頭行を列見出し、以降を1 project 1行とし、全project行の後に区切り行、さらに total 行を続ける。total 行は先頭列に `total`、各status列に全projectのそのstatusの件数の合計を出す。区切り行は total 行の直前に出し、各列にその列の表示幅と同数の `─` を出す。先頭列の見出しは `project`、件数列の見出しは各status名である。列間は半角スペース2個とし、各列を次の規則で整列する。幅は文字数ではなく端末上の表示幅で求め、日本語の全角文字は半角文字2個分として扱う。

| 列 | 幅 | 揃え |
| --- | --- | --- |
| project名・total | 見出し、全project名、`total`の最大表示幅 | 見出し・名前とも左揃え |
| 各statusの件数 | 見出し、全projectの件数の十進表記、total行の合計の十進表記の最大表示幅 | 見出し・件数とも右揃え |

JSON は `project` と各status名をkeyとする件数を持つオブジェクトの配列である。project が0件なら、テキストは `no tickets`、JSON は空配列を返す。ストアルートの不存在と不正なticket は終了コード1とし、部分的な集計結果を返さない。

位置引数と未対応のオプションは usageエラー（終了コード2）とする。

### `ticket show [<selector>] [-p|--project <project>] [--json]`

ID、status、after、title、本文全体を返す。テキスト出力は `id:`、`status:`、`after:`、`title:` の各フィールド行、空行、`body:` 行、本文の順で、本文の末尾空白・改行を保持する。JSON は共通フィールドと末尾空白・改行を保持した `body` を返す。

### `ticket create <json> [-p|--project <project>] [--json]`

JSON は必須の `title` と任意の `status`、`after`、`body` を持つ。作成するファイルでは frontmatter終端と H1 の間に空行を1行置く。body は H1 の後の空行を挟んで置く。after が未解決で status未指定なら blocked で作る。成功時は `created <id>` に status、after、path を続けるテキスト、または JSON共通フィールドを返す。

### `ticket set [<selector>] <json> [-p|--project <project>] [--json]`

JSON の許可key は `status` と `after` だけであり、少なくとも一方を含む。frontmatter と status連動を更新する。`status: closed` は上記の原子操作で依存ticket を解放する。成功時は `updated <id>` に status、after、path を続けるテキスト、または JSON共通フィールドを返す。

### `ticket edit [<selector>] <old> <new> [-p|--project <project>] [--json]`

frontmatter を除く本文全体（H1 を含む）の literal な `<old>` を検索する。正確に 1回なら `<new>` へ置換する。0回または複数回なら出現数と現在本文を stderr に出し、変更しない。空の old は usage error、空の new は削除である。成功時は `updated <id>` に status、after、path を続けるテキスト、または JSON共通フィールドを返す。

### `ticket check [-p|--project <project>] [-a|--all] [--json]`

frontmatter、重複field、status、missing after、after cycle を検証する。問題の JSON要素は `file`、`kind`、`detail` を持つ。問題なしは `ok` または空配列を返す。

### `ticket dispatch`

dispatcher は ticket store から起動可能な ticket を探してプロンプトを生成し、tmux 上に ticketごとの piセッションを起動する。ticket の status とセッションの有無を監視し、空いた稼働枠へ次の起動可能ticket を補充する。稼働枠とは、その dispatcher が監視し、今回の実行でまだ解放していない piセッションごとの枠を指す。

| コマンド | 動作 |
| --- | --- |
| `ticket dispatch list` | 同じ tmux socket 上で動作中の dispatcher を一覧する |
| `ticket dispatch start [-p\|--project <project>] [-a\|--all] [--max N] [--status <status>]...` | dispatcher を detached tmuxセッションで起動する |
| `ticket dispatch [-p\|--project <project>] [-a\|--all] [--max N] [--status <status>]...` | `start` と同じ動作 |
| `ticket dispatch stop [-p\|--project <project>] [-a\|--all]` | 指定した範囲の dispatcher を停止する |
| `ticket dispatch one --project <project> <id>` | 指定した ticket 1件を手動で起動する |

start と stop では、`-a/--all` 指定時は全project を対象とするグローバルdispatcher、未指定時は1 project を対象とするproject単位dispatcher を操作する。操作範囲が同じなら、別のディレクトリ・worktree からも同じ dispatcher を操作する。

Windows ネイティブでは、[pi-mux の専用管理先](../../../.local/cli.exact/pi-mux/SPEC.md#管理先と起動権) を使い、`--status locked` のみを選ぶ start と、その dispatcher の list・stop に対応する。WSL を必要としない。専用管理先が初期復元済みで稼働中でなければ、start は管理先を初期化せず、理由を stderr に表示して終了コード1を返す。`open` を含む start または `one` も、既存セッションを変更せず、理由を stderr に表示して終了コード1を返す。

#### 入力と配置

start と stop は共通の `-p/--project <name>` と `-a/--all` を受け付ける。start は、さらに次のオプションを受け付ける。

| start の入力 | ticket store のproject | dispatcher の cwd | 新規pi の cwd |
| --- | --- | --- | --- |
| `--all` 指定 | 全project。project指定は無視する | 呼出時の cwd | ticket が属するproject の `~/projects/<project>` |
| `--all` なし、`-p/--project` 指定 | 指定したproject名をそのまま使う | ホームディレクトリ配下の `projects/<project>` | dispatcher と同じ |
| `--all` なし、`-p/--project` 省略 | 共通の振る舞いに従い、呼出時の cwd から解決する | 呼出時の cwd | dispatcher と同じ |

指定したproject名は、起動先のGitリポジトリや main worktree の basename に置き換えない。project名に含まれる空白・引用符を保持する。

stop は `--all` 指定時にグローバルdispatcher、それ以外では共通の振る舞いに従って解決したproject の dispatcher を操作する。起動先ディレクトリへの移動を行わず、ticket store と起動先ディレクトリの存在や内容に依存せず操作できる。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--max N` | `5` | 選択した状態で共有する、自動補充に使う稼働数の上限。1以上の整数。グローバルでは全project の合計に適用する |
| `--status <status>` | `open` | `open` または `locked`。繰り返し指定した場合は指定値の集合を対象とする |

| 入出力 | パス・規則 |
| --- | --- |
| 固定本文 | `open` は `dispatch-prompt.md` に ticket ID を埋め込む。`locked` は `dispatch-locked-prompt.md` に対象project、ticket ID、担当会話の完全な ID と履歴ファイルの絶対パスを渡す |
| tmux socket | Windows では `~/.local/state/pi-tmux/server.sock`、それ以外では `/run/user/1000/pi-tmux/server.sock`。`TICKET_TEST_TMUX_SOCKET` 指定時はその socket を使う |
| tick間隔の上書き（テスト用） | `TICKET_TEST_TICK_MS` に0より大きい数値を指定すると、その値をミリ秒としてtick間隔に使う。不正な値・0以下の場合は既定の3秒を使う |

固定本文は dispatch の実行ごとに読み込む。作業ディレクトリにテンプレートを用意する必要はなく、ソースからの実行とコンパイル済みCLI のどちらでも同梱本文を使う。dispatch は ticket と作業ディレクトリの既存ファイルを変更しない。dispatch の引数、ticket読取り、ログ、終了条件は本節に従う。

#### 固定プロンプト

生成するプロンプトの内容の正本は CLI同梱の `dispatch-prompt.md`（`open`）と `dispatch-locked-prompt.md`（`locked`）とする。どちらも通常の pi セッションとして起動し、状態によって渡す初期プロンプトを選ぶ。`locked` のプロンプトはチケットと旧会話の記録を確認し、このセッションで対処を続けるか、旧セッションの再開を提案するかの判断を求める。旧セッションを開く場合だけ、その会話IDを示して会話内で新たにユーザーの承認を得るよう求める。

#### list

`ticket dispatch list` は同じ tmux socket 上のセッションから、この CLI が起動した dispatcher をすべて一覧する。範囲の指定・フィルタは行わず、`-p/--project`、`-a/--all`、`--max`、`--status` は受け付けない。ticket store の読み取りや起動先ディレクトリの確認は行わず、tmux server 未起動や list-sessions の失敗も 0件として扱う。

1行を「project名・セッション名・起動時刻」の列とし、project単位は project名、グローバルは `(all)` を project名として表示する。並び順はグローバルを先に、project名の辞書順とする。起動時刻はローカル時刻の `YYYY-MM-DD HH:MM:SS`。dispatcher がないときは `no dispatcher running` を出す。

#### start と stop

同じ範囲の dispatcher は同時に1つだけ動作する。dispatcher の識別はpiセッション名に依存せず、グローバルと各project を区別する。グローバルとproject単位の dispatcher の同時稼働は、起動順にかかわらず拒否する。同時に start が呼ばれた場合も、この境界を守る。異なるproject のproject単位dispatcher は、それぞれ動作できる。

| 条件・操作 | 結果 |
| --- | --- |
| 同じ範囲の dispatcher が起動済みで start | 既存の dispatcher用セッションだけを終了し、今回の start のオプションで作り直す。`dispatcher restarted: <セッション名>` を stdout へ出して終了コード0。稼働済みpi は stop 後の start と同じ規則で引き継ぐ |
| グローバル起動中にproject単位を start、またはproject単位が1つでも起動中にグローバルを start | 重複する範囲の dispatcher が起動中である旨を stderr へ出して終了コード1。既存セッションを保持する |
| dispatcher が未起動で start | 固定本文・対象範囲のticket store を読み、その範囲を識別する名前の detached tmuxセッションを作る |
| dispatcher の起動確定 | セッション名を stdout へ出し、呼出元CLI は終了コード0で戻る。起動確定は Windows 以外では dispatcher用tmuxセッションの作成成功、Windows では開始した worker の照合を指す。全ticket の完了を待たない |
| dispatcher が起動中で stop | dispatcher用セッションだけを終了し、停止した旨を stdout へ出して終了コード0。起動済みpi は作業を続ける |
| dispatcher が未起動で stop | 停止済みである旨を stdout へ出して終了コード0 |
| stop 後に start | 対象範囲の残存piセッションを起動済み・稼働中として引き継ぎ、同じticket の pi を二重起動しない |

stop は指定した範囲の dispatcher だけを対象とする。グローバルの stop でproject単位dispatcher を停止せず、project単位の stop でグローバルdispatcher を停止しない。

Windows では start が同じ管理先と範囲の起動権を確保し、開始した worker を照合してから成功を返す。stop と、同じ範囲の start による置き換えでは、照合した worker への同じ接続にだけ停止を送る。切断後に名前で停止対象を引き直さない。旧 worker が未起動か終了済みと確認できた場合だけ、停止成功や置き換えに進む。照合不能や一覧の空・部分結果だけでは不在と判定しない。

引継ぎ対象は ticket CLI が起動したpiセッションであり、グローバルでは全project、project単位ではそのproject に限る。以前の起動がグローバルかproject単位かにかかわらず、対象範囲の残存pi を引き継ぐ。引き継いだpi のセッション名と cwd は保持する。残存pi の数が今回の `--max` 以上なら、その数が上限未満になるまで自動補充を待つ。

`locked` の履歴検索は、Pi の通常の保存先と、対象 cwd に適用されるカスタム保存先の通常履歴・アーカイブを対象とする。カスタム保存先と新規会話の保存先は、呼び出し元の `PI_CODING_AGENT_SESSION_DIR` が空でなければその値を優先し、未設定・空文字なら通常の保存先設定に従う。tmux server の環境にだけある値は使わない。

start の成功は、その後の監視継続や pi起動成功を保証しない。ソースからのCLI起動とコンパイル済みCLI のどちらでも同じ動作を提供する。

#### one

`one` では `--project` と完全な ticket ID を必須とする。指定project の ticket store から該当する1件を選び、`~/projects/<project>` を cwd として「固定プロンプト」と「piセッションの起動」の規則で piセッションを起動する。dispatcher の起動・停止は行わず、稼働数が `--max` 以上でも手動起動できる。

指定した ticket が存在しない、起動時点で `open` の actionable 条件を満たさない、または起動済みなら、終了コード1で拒否する。`one` で起動済みと判定するのは、同じ tmux socket に対象project と ID の組に対応する ticket CLI 所有の piセッションが現存する場合に限る。

対象cwd が存在しない、ディレクトリでない、または移動できない場合と、tmux で piセッションの作成に失敗した場合は、新規セッションを作らず終了コード1で終了する。

#### piセッションの起動

ticket はproject と ID の組で識別し、異なるproject に同じ ID があっても別ticket として起動・監視する。手動起動と自動起動が同じ ticket を同時に選んでも、piセッションの起動は1回に限る。

piセッション名の接頭辞は `handle_` で固定であり、オプションでは指定できない。project単位の自動起動で使う ID `X` のセッション名は、接頭辞に `X` の `.` を `_` へ全置換した文字列を連結した名前である。グローバルの自動起動と `one` の手動起動では、接頭辞、project名をUTF-8として小文字の16進表記にした文字列、`_`、同じ変換をした ID を連結する。

起動対象ごとに生成した prompt の内容全体を単一引数として `pi` へ直接渡す。本文の空白・引用符・末尾改行を保持する。

存在確認は `has-session -t =<セッション名>` の完全一致で行う。他project または dispatcher管理外の既存セッションと名前が衝突する場合は、そのセッションを変更せず、その ticket の起動失敗を記録する。衝突したセッションを稼働中として扱わず、今回の実行中はその ticket を再起動しない。

`open` の自動起動で tmux のセッション作成に失敗した場合、または `locked` の起動で名前が衝突した場合は、`tmux new-session failed for <セッション名>: <エラー内容>` を dispatcher の stderr と stdout へ出す。`open` で名前の衝突以外の失敗が起きた場合は稼働として登録し、以降の tick の解放条件で判定する。

#### tick と終了

起動時に `dispatcher start max=<max>` を記録する。最初の tick を直ちに行い、その後は3秒ごとに次の順で繰り返す。各 tick で対象範囲の ticket store を読み直し、起動可能ticket と稼働中ticket の status を判定する。グローバルでは各 tick でproject一覧も読み直す。

各 tick では、下表の判定前に、対象範囲の新たな手動起動を起動済み・稼働中として取り込む。project単位ではそのproject、グローバルでは全project の手動起動が対象となる。自動補充に使う稼働数には、手動・自動を問わず、枠を解放していない piセッションを数える。

| 順 | 条件 | 結果 |
| --- | --- | --- |
| 1 | 稼働中ticket の status が `closed`、`cancelled`、`blocked`、`draft` のいずれか | `done <ID> status=<status>` を記録し、piセッションを保持したまま稼働枠を解放する |
| 2 | 1で解放していない稼働中セッションが tmux 上に存在しない | `incomplete <ID> status=<status\|none> session exited without close` を記録し、稼働枠を解放する。その ticket は再起動しない |
| 3 | 稼働数が `--max` 未満で、起動可能ticket がある | 起動可能ticket を ID の古い順に空き枠の数だけ選び、起動する。起動ごとに `launched <ID> as <セッション名>` を記録する |
| 4 | 稼働数が0で、起動可能ticket がない | `dispatcher finished` を記録し、dispatcher用セッションを終了する。終了後の ticket の追加・変化は、次回の start で扱う |

1の解放をすべて行ってから2へ進む。同じ tick で解放した稼働枠を3の補充に使う。

起動可能ticket は、選択した状態の条件を満たし、稼働中でも今回の実行で起動済みでもない ticket である。

| 状態 | 起動条件 |
| --- | --- |
| `open` | 「セレクタ」の actionable の条件を満たす。after は同一project 内で判定する |
| `locked` | 履歴から担当会話を一意に特定でき、その会話が pi-mux の専用 tmux socket に存在しないと確認できる。担当不明、稼働中、起動・復元中、照会不明のときは除外して理由を記録する |

担当会話は、そのチケットに `status: locked` を明示した直接の `ticket_set` が最後に成功した会話である。呼び出しと成功結果を照合し、結果のストア内パスと完全な ID でチケットを特定する。更新前の状態は履歴から区別できないため、すでに `locked` だったチケットへの明示的な指定も含む。その後に `locked` 以外への成功結果がある、記録がない、または元の会話を一意に特定できない場合は担当不明とする。手作業や別ツールの変更はこの履歴からは特定できない。稼働の確認範囲は専用 tmux 内に限り、専用 tmux 外での稼働は判定しない。

空き枠があるとき、チケットのファイル世代を控えて候補の履歴をまとめて検索し、対象の起動先 cwd から担当会話を事前照会する。事前照会後、履歴を再検索する。担当会話か履歴パスに変化があった場合や、担当を特定できなくなった場合は、その照会結果を使わない。変化のない履歴の内容は読み直さない。読み取り中に変化した履歴ファイルは1回再読し、それでも検索を完了できなければ、担当不明とは区別して履歴照会不可を記録する。

履歴検索と事前照会の間も、同じ socket 上で別の dispatch 操作を行える。`open` も選択している場合、次の tick までに最初の履歴検索が終わらなければ、検索を続けたまま `open` の起動判定を行う。検索中または新たに見つかった `locked` 候補は、空き枠を消費せず照会結果を待つ。

再検索後は、同じ socket 上の dispatch 操作と排他して、チケットの状態と稼働セッションを読み直し、起動済みを除外して `--max` の空き枠を数え直す。最終確認を呼び出すのは、チケットが引き続き `locked` で、チケットのファイル世代が最初の検索前から変わらず、担当会話の履歴ファイルの世代も再検索時から変わっていない場合に限る。同じ内容への置換も変更とみなす。他の履歴ファイルと履歴の新規追加は再検索で確認できた範囲までを扱う。履歴やストアの書き込みとは排他しない。

担当会話の不在の最終確認と新規 pi の起動は、同じ専用 tmux socket を使い、`pi-mux` の起動・復元など、同じロックを使う操作が間に入らないように一体で行う。この処理が完了するまで、同じ socket 上で別の dispatch 操作による起動・再起動・停止の判定を並行して行わない。

事前照会で pi-mux のライフサイクルロックが競合した場合は、起動せず、後続の tick で1回再照会する。履歴照会不可、再確認での見送り、最終確認での担当会話の存在、または最終確認・起動の結果を確認できない場合は、理由を記録する。以降の tick で起動条件を満たせば1回だけ再試行する。ただし、tmux セッション名が衝突した場合は再試行しない。

`open` と `locked` の両方を指定しても、同じチケットを同時に、または同じ実行中に繰り返し起動しない。グローバルでは全project の候補をまとめて ID の辞書順に選び、同じ ID はproject名の辞書順にする。ID の日時部分を作成日時として扱う。

引き継いだ ticket、done や incomplete で解放した ticket も今回の起動済みに含まれ、再び起動しない。実行中に store へ追加された ticket と、`after` の解消で open になった ticket は、次の tick から起動可能になる。

#### ログとエラー

ログはローカル時刻の `[YYYY-MM-DD HH:MM:SS] <メッセージ>` を1行として dispatcher の stdout へ出す。グローバルのticket別ログでは `<ID>` を `<project>/<ID>` として表示する。呼出元CLI の stdout は start・stop の操作結果を示す。

| 条件 | 結果 |
| --- | --- |
| サブコマンドが受け付けない位置引数・オプションの指定、必須の引数・値の不足、`--max` または `--status` の値の不正 | usage を呼出元CLI の stderr へ出し、終了コード2 |
| project名がストアと安全境界の制約に違反 | 既存CLI と同じ validationエラーを呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動・停止しない |
| start の cwd、またはグローバルで新規起動候補となるticket の対象cwd がディレクトリでない、または移動できない | `I/O error: <エラー内容>` を呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動せず、pi も起動しない |
| グローバルで新規起動候補となるticket の対象cwd が存在しない | そのticket は新規起動せず `skipped <project>: cwd not found: <cwd>` を出し、他の候補の確認・起動を続ける。start の事前確認では dispatcher も起動する。ログは start の事前確認では呼出元CLI の stdout へ、各 tick では時刻付きで dispatcher の stdout へ出す |
| 新規start の事前確認で ticket の値・状態・環境が不正 | 既存CLI と同じ validationエラーを呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動しない |
| 新規start の事前確認で固定本文読込みに失敗 | `I/O error: <エラー内容>` を呼出元CLI の stderr へ出し、終了コード1。dispatcher は起動しない |
| dispatcher用tmuxセッションの作成、または稼働中dispatcher の停止に失敗 | 操作と理由を呼出元CLI の stderr へ出し、終了コード1 |
| start成功後に ticket読取り、固定本文読込み、グローバルの新規起動候補の対象cwd確認などの継続不能なエラー | エラーを dispatcher の stderr と stdout へ出し、dispatcher用セッションを終了する。起動済みpi は作業を続け、呼出元CLI の終了コードは変化しない |

グローバルの新規起動候補の対象cwd は、start の事前確認と各 tick の新規起動前にまとめて確認する。`locked` を選択した場合は、起動対象にできる形式の未起動 `locked` チケットも対象とする。ディレクトリでない・移動できない対象cwd が1つでもあれば、その確認に続くpi起動を行わず、上表の失敗時の動作に従う。存在しない対象cwd のproject は上表のとおりスキップし、スキップは各確認で再評価するため、後から対象cwd が作られれば次の tick の起動候補に戻る。

#### ライフサイクル

dispatcher を終了させると監視と補充が止まる。tmux server の終了または OS再起動で dispatcher と piセッションが消え、自動では再開しない。
