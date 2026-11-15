# session-state の実行フェーズ・タイトル仕様

この文書は、pi拡張 session-state の専用tmux paneへの実行フェーズ・タイトル公開を定める。読者は、この拡張と外部の読み書き手を保守する user と coding agent である。課題・目的・重要な制約の正本は [REQUIREMENTS.md](REQUIREMENTS.md) とする。

## 適用対象

実行フェーズの公開はトップレベルセッションに適用する。現在の session directory が、そのcwdの subagent用directory と一致する子セッションでは、pane公開を行わない。この判定は新規・resume・fork・画像入力の自動vision委譲に共通し、agent名・役割・親ヘッダーの有無では変わらない。

公開はライフサイクルイベントに従い、この拡張が提供するスラッシュコマンドはない。自セッションは、この拡張が動作しているpiの現在のセッションを指す。

| 入力・状態 | pane公開 |
| --- | --- |
| トップレベルの `input` | 現在値を維持する |
| トップレベルの `session_start` | 公開世代を開始する |
| トップレベルの `resources_discover` | 管理下を照合し、`waiting-user` を公開する |
| 実行フェーズ・保存名の変化 | 下記イベント表に従う |
| `session_shutdown` | 新規公開を止め、optionの除去を試みる |
| 専用tmux管理外のトップレベル | 公開しない |

## workspace登録・復元との境界

セッション一覧の正本は `pi-mux list` とし、復元用JSONの読込み・更新はpi-muxが担う。session-stateは、自セッションの実行フェーズと保存済みタイトルを [pi-muxのstate操作](../../../../.local/cli.exact/pi-mux/SPEC.md#state) へ通知し、pane optionに公開する。状態metadataを直接書き換えず、終了時の除去も同じ公開CLIへ依頼する。

起動・入力・実行フェーズ遷移・終了の全期間で、workspace登録と復元記録の取得・更新はpi-muxが担う。拡張自身は保存storeを直接読み書きせず、会話JSONLも変更・削除しない。`running` 通知に伴う一時再開からの昇格と復元記録更新はpi-muxが行う。

## 管理paneの初期照合

専用socketは `${XDG_RUNTIME_DIR:-/run/user/<uid>}/pi-tmux/server.sock` の絶対パスとする。全tmux操作で `-S <絶対パス>` を指定し、既存サーバーに接続する。

`TMUX` のsocketが専用pathと一致し、`TMUX_PANE` がある場合だけ候補とする。実socketをファイルシステムで確認した後、`display-message` のtab区切り応答から次の値を照合する。

| 照合値 | 一致条件 |
| --- | --- |
| socket path | 専用socketの絶対パス |
| server PID | `TMUX` にあるserver PID |
| pane ID | `TMUX_PANE` |
| pane PTY | `/proc/self/fd/0` のリンク先 |
| pane起動PID | 現在のpiの `process.pid` |

全項目が一致したpaneだけを公開先にする。専用paneの子プロセスや偽マーカーを持つプロセスは、照合不一致により公開対象外になる。照合は各世代の `resources_discover` で、全拡張の `session_start` 初期化が完了した後に行う。その世代では捕捉済みの接続先を使う。

専用serverプロセスの開始時刻とpi自身のprocess start timeも捕捉し、socket・server PID・pane ID・pi PIDとともに、state操作の `--source` の各項目へ渡す。serverの開始時刻は `serverStartTime`、piの開始時刻は `started` とする。CLI初期化の有無によらず、専用serverのPIDと開始時刻で生存期間を識別する。再送時にも捕捉済みsourceを維持し、古い通知を新server・新pane・新piへ付け替えない。pi-muxは変更の直前に通知元を再照合する。

## 状態通知の公開契約

公開先の形式は [pi-muxのpane option公開契約](../../../../.local/cli.exact/pi-mux/SPEC.md#pane-optionの公開契約) に従う。通常の通知には `state <会話ID> <state> --source <JSON> --title <JSON>`、終了時には `state <会話ID> --clear --source <JSON>` を使う。

タイトルの正本はpiの保存済みセッション名とし、名前がない場合は `null` を通知する。sourceとtitleはそれぞれJSON化し、shell引数としてescapeして渡す。

同じ世代では、直前に成功した通知とstate・titleの両方が同じで、未完了の通知がなければCLIを呼ばない。失敗した通知は成功済みと見なさず、同値の次の要求でも再送できる。titleだけが変わった場合は、現在のstateと会話IDを維持して通知する。その後のstate変更でも現在のtitleを保持する。世代開始時は、同じ会話ID・state・titleでも初期値を通知する。公開のためにpane optionを読み取らず、外部上書きだけでは再通知しない。

### 実行の区間とイベント

run区間は `agent_start` から `agent_settled` までとし、中断による確定停止も含む。リトライ・自動圧縮・キュー継続をまたいで維持する。`agent_end` は確定停止を表さない。

承認UI待ちは `ui_prompt_start` から `ui_prompt_end` までの外側の待ち区間とする。対象はSDKの `select`・`confirm`・`input`・`editor`・`custom` によるUI待ちである。

| イベント | 処理 |
| --- | --- |
| `session_start` | 起動・resume・reload時に旧世代を失効させ、run区間外・承認待ちなしで公開世代を開始する。現在の保存名を取得し、titleの初期値にする |
| `resources_discover` | 管理paneを初期照合し、`waiting-user` と現在のtitleを公開する |
| `session_info_changed` | 保存後の `event.name` を現在のtitleとし、stateと会話IDを維持して公開する。`undefined` は `null` として公開する |
| `agent_start` | run区間に入り、承認待ちでなければ `running` を公開する |
| `ui_prompt_start` | 承認待ちに入り、`waiting-approval` を公開する |
| `ui_prompt_end` | 承認待ちを解除し、run区間内なら `running`、区間外なら `waiting-user` を公開する |
| `agent_settled` | run区間を終了し、承認待ちでなければ `waiting-user` を公開する |
| `session_shutdown` | 新規公開と再送を止め、未実行分を失効させ、可能ならoptionを除去する |

保存名の変更は標準の `session_info_changed` で受け取る。初回リクエストのagentループ終了より遅れて保存された場合も、セッションのアクティブ化や次のstate変更を待たずに公開する。初期照合前の保存名変更はtitleの現在値に反映し、公開CLIは `resources_discover` 以降に実行する。

その他の進展イベントでは公開しない。承認待ち中は、進展・繰り返しの `agent_start`・確定停止によって表示を `running` へ戻さない。UI終了後は、その時点のrun区間に対応するstateへ戻す。

### 世代と終了

公開処理はrunの `ctx.signal` と独立し、背景Bash要求に呼び出し元の `signal` を渡さない。会話ID・state・title・必要context・接続候補を受付時に捕捉し、実行フェーズとタイトルの公開は同じ受付順で反映する。世代失効では、未実行の旧公開・古い結果・古い操作の失敗通知を破棄する。

開始済みのCLIは世代失効だけを理由に強制中断しない。背景Bashの要求結果と、[Toolsの実行待機契約](../tools/SPEC.md#背景bash入口) による `executionSettled` の解決を区別する。本書の実行終端は、この実行待機の解決を指す。登録Bashが1秒timeoutを例外として返した場合も実行終端済みとし、`failed` だけを理由に終端不明と扱わない。要求期限が先に到来した場合やToolsが先に停止した場合は、開始済み実行の待機を保持する。

同じpiプロセスでは、古い通知や除去の実行終端を確認してから後続CLIを開始する。この順序は、新しい会話・reload・factoryの再生成をまたいで保持する。終端後の新規要求には、その時点で有効な世代のcontextと背景Bash入口を使う。CLIのtimeoutは1秒とし、背景Bash要求全体の期限はToolsの指定秒数+2秒、すなわち3秒とする。

通常公開のstate操作が終了コード75で通常終端した場合は、有効な世代の未反映の同じ通知を受付順のまま背景で再送する。ロック競合だけを理由に `running` を後続の待機通知で置き換えない。起動・復元のロックを持つ呼出元が通知の成功を待つ循環を作らず、resources_discoverとpiの初期化・入力を継続する。世代失効とshutdownは、未実行の再送を止める。shutdownの除去が競合した場合は再送せず通知し、終了を継続する。競合以外の通常終端した失敗は通知し、後続要求を受け付ける。

### 自動復旧

初期照合または通常公開の背景要求が `failed`・`unavailable`・`aborted` で終わった場合、有効な世代は復旧待ちに入る。復旧待ちの開始を短く通知し、連続する再試行ごとには同じ警告を繰り返さない。復旧待ちの間もinputとpi本体の動作、およびstate・titleの変化の受付を継続する。

| 復旧待ちの条件 | 処理と結果 |
| --- | --- |
| 開始済み実行の終端が未確認 | その終端を追跡し、後続CLIの開始を待つ |
| 実行終端または未実行を確認済み | 確認から1秒後に、失敗した初期照合または同じ通知を背景で再送する |
| 再送も `failed`・`unavailable`・`aborted` | 同じ条件で復旧待ちを続ける |
| 初期照合の再送に成功 | その世代の公開先を確定し、保留中の通知を受付順に公開する |
| 通知の再送に成功 | その通知を成功済みとし、保留中の通知を受付順に公開する |
| 世代が失効 | その世代の再送と未実行分を破棄し、開始済み実行の終端追跡だけを保持する |
| shutdownを受信 | 再送を止め、終了処理に移る |

登録Bashの実行が終端し、背景Bash入口と専用tmuxが利用可能になれば、再送が成功するまで自動復旧を続ける。再送は、追加入力・実行フェーズ変更・会話切替・reloadを待たずに行う。失敗した通知と、その後に受け付けたstate・titleの組を保持し、復旧後は受付順に反映して最新値へ到達する。失敗した `running` を後続の待機通知で置き換えない。終端未確認の実行が後から成功しても、それを新しい世代の成功や成功済み通知として採用しない。

### 終了処理

終了時は新規受付と再送を止め、未実行分を失効させる。開始済み要求は背景Bashの要求期限内で結果を待ち、その時点で実行終端を確認でき、Toolsも有効な場合にoptionの除去を1回依頼する。Toolsが先に停止した場合や実行終端が未確認の場合は、追加のcleanupを実行せず、短く通知して終了を継続する。終了処理から戻った後も、同じpiプロセスが存続する間は開始済み実行の終端追跡を保持し、後続世代のCLIをその終端より後にする。paneが終了すると、pane-local optionも消滅する。

## 実行経路と失敗

初期照合のtmux CLIと通知のpi-mux CLIは、どちらも [Toolsの背景Bash入口](../tools/SPEC.md#背景bash入口) に依頼し、[Guardrailsの認可・sandbox契約](../guardrails/SPEC.md) に従う。受信口が不在・無効の場合も、直接のプロセス起動や別のBash生成へ切り替えない。

| 結果 | 扱い |
| --- | --- |
| `completed`、Bash成功 | 結果を用いて照合・公開を進める |
| `completed`、通常公開のstate操作が終了コード75 | 有効な世代の同じ通知を再送する |
| `completed`、shutdownの除去が終了コード75 | 競合を通知し、終了を継続する |
| `completed`、上記以外の `isError` または非0終了 | 操作失敗として通知する。同値の次の要求も受け付ける |
| `failed`・`unavailable`・`aborted`、初期照合または通常公開 | 上記の自動復旧に従う |
| `failed`・`unavailable`・`aborted`、shutdownの除去 | 失敗を通知し、再送せず終了を継続する |
| 出力の欠落・切り詰め・照合不一致 | 管理paneとして採用しない |

公開の失敗はTUIの短い警告で通知し、inputとpi本体の動作を継続する。UIがない場合は標準エラーへ通知する。
