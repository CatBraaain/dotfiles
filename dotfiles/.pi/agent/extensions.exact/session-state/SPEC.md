# session-state の所属と実行フェーズ仕様

この文書は、pi拡張 session-state の所属ストア更新と、専用tmux paneへの実行フェーズ公開を定める。読者は、この拡張と外部の読み書き手を保守する user と coding agent である。課題・目的・重要な制約の正本は [REQUIREMENTS.md](REQUIREMENTS.md) とする。

## 適用対象

現在の session directory が、そのcwdの subagent用directory と一致する子セッションでは、ストア更新・コマンド登録・pane公開を行わない。この判定は新規・resume・fork・vision委譲に共通し、agent名・役割・親ヘッダーの有無では変わらない。

| 入力・状態 | 所属ストア | pane公開 |
| --- | --- | --- |
| トップレベルの `input` | 自セッションの所属を追加する | 現在値を維持する |
| トップレベルの `session_start` | 内容と有無を維持する | 管理下を照合し、`waiting-user` を公開する |
| 実行フェーズの変化 | 内容と有無を維持する | 下記イベント表に従う |
| `session_shutdown` | 所属を保持する | 新規公開を止め、optionの除去を試みる |
| 専用tmux管理外のトップレベル | 所属更新とコマンドを提供する | 公開しない |

## 所属ストア

保存先は pi の agent directory 配下の `session-state.json` とする。所属の意味・形式・保持対象・不正なストアの条件は [メタデータストアの契約](REQUIREMENTS.md#メタデータストアの契約) に従う。

トップレベルのセッション開始時に `/archive`・`/unarchive` を登録する。`input` による自動アーカイブ解除と両コマンドの結果・lock・通知は [機能要件](REQUIREMENTS.md#機能要件) に従う。

この拡張による所属更新は、入力・コマンドの受付順に反映する。保存は同じdirectoryの一時ファイルへ書き、renameで置換する。保存失敗時は一時ファイルを清掃する。不正なストアは上書きしない。

実行フェーズのイベントではストアを読み書きしない。既存entryの `state` は所属更新時にも保持し、実行フェーズの表示入力には使わない。

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

全項目が一致したpaneだけを公開先にする。専用paneの子プロセスや偽マーカーを持つプロセスは、照合不一致により公開対象外になる。照合は `session_start` ごとに行い、その世代では捕捉済みの接続先を使う。

## pane optionの公開契約

pane-local user option `@pi_session_state` に、次のJSON文字列を1回の `set-option -p` で設定する。

```json
{ "version": 1, "sessionId": "<現在の会話ID>", "phase": "running" }
```

`phase` は `running`・`waiting-approval`・`waiting-user` のいずれかである。JSON文字列は `JSON.stringify` で組み立て、shell引数をescapeして渡す。`-F` によるtmux format展開は行わない。

同じ世代では、前回要求したphaseと同じならCLIを呼ばない。世代開始時は、同じ会話ID・phaseでも初期値を公開する。公開のためにpane optionを読み取らず、外部上書きだけでは再公開しない。

### 実行の区間とイベント

run区間は `agent_start` から `agent_settled` までとし、中断による確定停止も含む。リトライ・自動圧縮・キュー継続をまたいで維持する。`agent_end` は確定停止を表さない。

承認UI待ちは `ui_prompt_start` から `ui_prompt_end` までの外側の待ち区間とする。対象はSDKの `select`・`confirm`・`input`・`editor`・`custom` によるUI待ちである。

| イベント | 処理 |
| --- | --- |
| `session_start` | 旧世代を失効させ、run区間外・承認待ちなしで開始して `waiting-user` を公開する |
| `agent_start` | run区間に入り、承認待ちでなければ `running` を公開する |
| `ui_prompt_start` | 承認待ちに入り、`waiting-approval` を公開する |
| `ui_prompt_end` | 承認待ちを解除し、run区間内なら `running`、区間外なら `waiting-user` を公開する |
| `agent_settled` | run区間を終了し、承認待ちでなければ `waiting-user` を公開する |
| `session_shutdown` | 新規公開と未実行分を止め、開始済みCLIの通常終端を待ち、可能ならoptionを除去する |

その他の進展イベントでは公開しない。承認待ち中は、進展・繰り返しの `agent_start`・確定停止によって表示を `running` へ戻さない。UI終了後は、その時点のrun区間に対応するphaseへ戻す。

### 世代と終了

公開処理はrunの `ctx.signal` と独立する。会話ID・必要context・接続候補を受付時に捕捉する。世代失効では、未実行の旧公開・古い結果・古い操作の失敗通知を破棄する。

開始済みのtmux CLIは世代失効で強制中断せず、通常のtool結果が返るまで待つ。結果が `completed` なら、Bashエラーを含めその実行は終端したものとして、次の公開へ進む。古いsetやunsetの副作用が終わる前に、新世代の照合・公開を開始しない。CLI自身のtimeoutは約1秒、背景Bash要求の期限は約2秒とする。

背景要求が `failed`・`unavailable`・`aborted` で終わった場合、CLI実行の終端を確証できないため、そのpiプロセスからの後続CLIを停止し、短く通知する。停止は新しい会話・reload・factoryの再生成でも解除しない。停止後もinputと所属操作は継続する。

終了時は新規受付を止め、未実行分を失効させ、開始済みCLIの終端を待つ。実行終端が確定していればoptionの除去を待つ。Tools が先に停止した場合や終端が不確実な場合は、追加のcleanupを実行せず、通知とpane終了を公開終了の境界にする。paneが終了すると、pane-local optionも消滅する。

## 実行経路と失敗

CLI実行は [Toolsの背景Bash入口](../tools/SPEC.md#背景bash入口) に依頼し、[Guardrailsの認可・sandbox契約](../guardrails/SPEC.md) に従う。

| 結果 | 扱い |
| --- | --- |
| `completed`、Bash成功 | 結果を用いて照合・公開を進める |
| `completed`、`isError` または非0終了 | 操作失敗として通知する |
| `failed` | 実行終端が不確実として通知し、後続CLIを停止する |
| `unavailable` | 入口の不在・停止を通知し、後続CLIを停止する |
| `aborted` | 実行終端が不確実な中断を通知し、後続CLIを停止する |
| 出力の欠落・切り詰め・照合不一致 | 管理paneとして採用しない |

所属更新・公開の失敗はTUIの短い警告で通知し、inputとpi本体の動作を継続する。UIがない場合は標準エラーへ通知する。
