# pi-mux の仕様

`pi-mux` は、固定した会話IDの pi を専用tmux内で起動・再接続し、workspace登録と復元対象の会話集合を保存・復元するCLIである。利用者と、実装・保守・評価を行う開発者に向け、起動後に観測できる振る舞いを定める。本書を最上位の正本とする。

会話は pi の会話IDで識別する。pi実体は、動作中の piプロセスとその実行PTYを指す。空新規は、動作中で、最初の user または assistantメッセージが保存されておらず、会話ファイルの実体がない新規会話を指す。

## 保存会話の探索範囲

`open`・`restore` の保存会話解決と `history` の列挙が対象にする保存先は、次の順で最初に得られたパスとする。空文字列の環境変数は未指定として次へ進む。パスの先頭の `~` はホームディレクトリへ展開し、相対パスは呼び出し時のcwdを基準に絶対パスへ解決する。呼び出し時のcwdは、`new` では起動cwd（§new 参照）を使う。

1. 環境変数 `PI_CODING_AGENT_SESSION_DIR` の値
2. settings の `sessionDir`。呼び出し時のcwdの `.pi/settings.json` に `sessionDir` がなければ `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json` の値を使う
3. 既定の `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions`

settings の読み込みに失敗した、または `sessionDir` が文字列でない場合も、コマンドは失敗する。

pi本体は、環境変数・settings の保存先へcwdグループを作らずに会話ファイルを直接保存し、既定の保存先へのみcwdグループを作る。探索対象の `*.jsonl` は、解決元ごとに次のとおりとする。

| 解決元 | 探索対象の `*.jsonl` |
| --- | --- |
| 環境変数・settings | 保存先直下 |
| 既定 | 各cwdグループ直下（通常側）と、その `archive/` 直下（archive側） |

既定の保存先直下のcwdグループは、絶対cwdから先頭のセパレータを除き、`/`・`\`・`:` を `-` へ置き換え、前後を `--` で挟んだ名前とする。

CLIのsession-dirs記録と、稼働piの保存先を探索に使わない。

## 操作

| 入力 | 結果 |
| --- | --- |
| `pi-mux` | `pi-mux new` と同じ |
| `pi-mux -h`、`pi-mux --help` | ヘルプを表示する |
| `pi-mux new [--detached] [--client-pid <pid>] [--cwd <absolute-cwd>] [initial-request]` | 初期依頼がなければ同じ起動cwdのwarm会話を再利用し、該当がなければ新規起動する。初期依頼があれば独立会話を起動する。通常はTUIへ接続する。`--detached` では会話IDと接続コマンドを返す。`--client-pid <pid>` では会話確保後に指定クライアントの表示をその会話へ切替え、会話IDと接続コマンドを返す。`--cwd <absolute-cwd>` では指定cwdで会話を確保する |
| `pi-mux open [--temporary] <session-id>` | 完全一致する会話IDのpi実体へ接続する。稼働していなければ、保存会話を元のcwdで再開する。`--temporary` は一時再開を指定する |
| `pi-mux state <session-id> <state> --source <JSON> --title <JSON>` | 通知元を照合して実行フェーズとタイトルを公開する。`running` は一時再開を通常へ昇格させる |
| `pi-mux state <session-id> --clear --source <JSON>` | 通知元が公開した実行フェーズとタイトルを除去する |
| `pi-mux send [--wait <seconds>] <session-id> <text...>` | 稼働している対象会話へ短いメッセージを1件届ける。稼働はpi実体の生存を指し、エージェントの実行状態は送信の可否に影響しない。`--wait` は対象の受信拡張が消費するまで待つ |
| `pi-mux close <session-id>` | 完全一致する会話IDのpiを非対話で終了し、その会話を復元対象から除く。保存会話・workspace登録を保持する |
| `pi-mux close --if-temporary <session-id>` | 一時再開中のpiだけを `close` と同じ手順で終了し、復元対象から除く。通常状態のpiと稼働対象がないIDは、変更せず成功する |
| `pi-mux list` | 登録済みworkspaceを、空workspaceも含めたJSON配列で返す。専用tmuxの稼働piがあるworkspaceを自動登録する |
| `pi-mux switch <session-id> [--client-pid <pid>]` | 接続クライアントが表示するtmuxセッションを、会話IDのpi実体のtmuxセッションへ切り替える |
| `pi-mux current [--client-pid <pid>]` | 接続クライアントが表示中のpi実体のmetadataをJSONで返す |
| `pi-mux history [--cwd <absolute-cwd>]` | 登録済みworkspaceの保存会話をJSON配列で列挙する |
| `pi-mux workspace register <cwd>` | piを起動せずworkspaceを登録する |
| `pi-mux workspace unregister <cwd>` | 対象workspaceの稼働piを終了し、登録と復元対象を除く。保存会話ファイルは保持する |
| `pi-mux snapshot [server-generation]` | 稼働中の専用serverから通常の管理会話を採取して保存する。serverを起動せず、指定世代と異なるserverの記録は変更しない |
| `pi-mux restore` | 専用serverを起動し、保存された会話集合を非接続で開く |
| `pi-mux reload [<session-id>]` | 待機中になった管理対象のpiから順次piプロセスを新しいpiプロセスへ置き換え、専用serverと稼働中のpiの処理を維持する。会話IDを指定すると、その会話だけを対象にする |
| `pi-mux restart [--force]` | 通常は全piの待機を待って会話集合を保存し、専用serverと配下の全piを再起動する。`--force` では待機を省略する |

`open` は対話TUIへ接続する。新しい会話IDは `new` の起動時にCLIが採番する。

シェルの `a` は `pi-mux` を呼ぶ。`pi` コマンド自体と、ほかのaliasは維持する。

### ヘルプ

トップレベルの引数が `-h` または `--help` の1個だけの場合、利用書式と「操作」表の各操作の呼び出し書式をstdoutへ表示し、終了コード0で終了する。出力は `Usage` などのラベルとコマンド構文からなる簡潔な一覧とする。

ヘルプ表示では、設定の読み込み・検証、依存コマンドの確認、tmux操作、状態の作成・変更を行わない。

`new` の初期依頼の位置にある1個の引数が `-h` または `--help` の場合（`new --detached -h`、`new --detached --help` も同じ）、その引数を初期依頼に採用せず、トップレベルと同じヘルプを表示して終了コード0で終了する。

### new

`initial-request` は、シェルで引用した1引数として受け取る。空文字列・空白のみ・NULを拒否し、空白・引用符・改行・先頭の `-` を保持する。`-h`・`--help` は初期依頼に採用せず、ヘルプを表示する。

| 引数 | 解釈 |
| --- | --- |
| `new --detached` | 初期依頼なしで非接続起動する |
| `new --detached 'fix the build'` | 初期依頼ありで非接続起動する |
| `new 'fix the build'` | 初期依頼ありで起動し、TUIへ接続する |
| `new '--option-like request'` | 先頭の `-` を依頼の一部として渡す |
| `new -h`、`new --help` | 初期依頼に採用せずヘルプを表示する |
| `new --`、`new --detached --` | `--` 自体を初期依頼として渡す |
| `new -- request`、`new first second` | 複数の末尾引数としてエラーにする |
| `new --client-pid <pid>` | 非接続で会話を確保し、指定PIDのtmuxクライアントをその会話へ切替える |
| `new --client-pid <pid> 'fix the build'` | 初期依頼ありで非接続起動し、指定クライアントをその会話へ切替える |
| `new --cwd <absolute-cwd>` | 指定cwdで起動し、初期依頼なしで会話を確保する |
| `new --cwd <absolute-cwd> 'fix the build'` | 指定cwdで初期依頼ありの独立会話を起動する |
| `new --cwd relative/path` | 複数の末尾引数としてエラーにする |
| `new --detached --detached` | 先頭を非接続指定、末尾を初期依頼文字列 `--detached` として扱う |

`new` の直後にある先頭1個の `--detached` と、初期依頼より前の1個の `--client-pid <pid>`・`--cwd <absolute-cwd>` だけをオプションとして消費し、順序は問わない。`--client-pid` の値は `switch` と同じ正の整数、`--cwd` の値はabsoluteパスとする。指定の重複・不正値・値の欠落の位置から先は、オプションとして解釈せず初期依頼の規則に従う。区切りの `--` は使わない。その後の1引数が `-h` または `--help` のときはヘルプを表示し、それ以外は初期依頼としてそのまま渡す。`@file` を含め、pi CLIへ渡した後の処理は標準pi CLIに従う。

起動cwdは、`--cwd <absolute-cwd>` の指定cwd、未指定なら呼び出しシェルのcwdとする。起動するpi実体の選択、workspace登録、保存先解決の `.pi/settings.json` 参照は、このcwdを基準とする。指定が存在しないディレクトリ・ファイルのときは、起動せずエラーにする。

初期依頼なしの `new` で作成された空新規をwarm会話とする。起動cwdに準備済みのwarm会話があれば、同時呼び出しや `--detached`・`--client-pid` の有無によらず、同じ会話ID・pane・piプロセスを使う。未送信の入力欄も保持する。別cwdのwarm会話や、初期依頼ありで作られた空新規は再利用しない。

起動した会話のTUIへは、両オプションのどちらも指定がなければ接続し、どちらかがあれば接続せず会話IDとその会話への接続コマンドを返す。新しいsessionの最初のwindow名はCLIが `pi` とする。

`--client-pid <pid>` を指定した場合、`--detached` の有無によらず、会話の確保とworkspace登録の後に、`switch` と同じ機構（PIDとその親プロセスからのクライアント特定、セッション名の厳密一致による切替）で、指定クライアントの表示をその会話のtmuxセッションへ切り替える。呼び出し元端末へは接続しないため、`--detached` の併用は結果を変えない。会話の確保に失敗したときは指定クライアントの表示を変えない。クライアントの特定・切替に失敗したときは、確保済みの会話を停止せず維持したままエラーにする。

保存済みになった会話は、`open` で同じpi実体へ戻れる。

新しいpi は、初期依頼があれば標準mainとして起動する。初期依頼ありの起動では、会話ID・piプロセス・paneを確認した作成受付で接続または結果返却へ進み、全拡張の初期化完了や初期依頼の完了は待たない。初期依頼なしの起動では、paneに公開されたmetadataの初期化完了（`startup` が `ready`）を確認した後に接続または結果返却へ進む。

初期依頼はpi CLIへそのまま1回だけ渡す。`@file` のテキスト・画像・空ファイル・不正パスの扱い、slash command・skill入力の展開、`input.source` は標準pi CLIに従う。内部の起動通知を初期依頼・通常input・保存履歴へ混ぜない。

#### warm会話の初回入力

| 条件 | 結果 |
| --- | --- |
| 会話の文脈がまだないwarm会話で最初の対話テキストを送信 | 本文を確定保存してから、同じ会話ID・cwd・paneでpiプロセスを置き換える。新しいpiの準備完了後に自動送信を1回だけ試行する |
| 旧piの終了前に保存または置き換えの操作に失敗 | 本文を旧piの入力欄に戻す |
| 同じ会話の保存履歴に本文と完全一致するユーザー発言がある | 履歴中の順序によらず、引き継ぎ用の本文を削除する |
| 起動に失敗、または受理を確認できない | 本文を保持し、その会話IDで開き直したときに入力欄へ戻す。自動再送しない |

稼働中のpiは `pi-mux open <id>` だけでは再起動しない。未確認の下書きを入力欄に戻すには、稼働中なら `pi-mux close <id>` で終了し、`pi-mux open <id>` で開き直す。

置き換え中は旧piに通知を表示し、旧piへの追加入力を受け付けない。シェル実行結果などの会話文脈が既にあるときは、元のpiで入力を処理する。スラッシュコマンド、シェル入力、画像付き入力、2通目以降、および通常のpi起動は既存の経路で処理する。引き継ぎ用の本文は、Linuxではpi-mux専用状態領域の権限 `0600` のファイル、Windowsでは `%LOCALAPPDATA%` 配下に置く。pi-muxは本文を読まず、引数・tmux環境・診断ログに本文を渡さない。

### open

会話IDは省略しない。「保存会話の探索範囲」に従い、cwdを横断してヘッダーの会話IDの完全一致を解決する。復元時の保存会話解決も同じ検索順に従う。

| 通常側の一致件数 | 保存候補の取得先 |
| --- | --- |
| 1件以上 | 通常側の一致だけを使い、archive側を探索しない |
| 0件 | archive側を探索し、その一致を使う |

以下の保存候補数と重複判定は、この検索順で採用した側の一致だけで数える。

| 状態 | 結果 |
| --- | --- |
| 同じ会話IDのpi実体が稼働中で、保存候補が0件または1件 | 同じpiプロセス・PTYへ接続し、会話の再読み込みや初期入力の再実行をしない |
| 稼働しておらず保存会話が1件 | その保存ファイルを元のcwdで再開する。別cwdへのfork確認は行わない |
| 稼働しておらず保存会話が0件で、初回入力の下書きが残っている | 同じ会話IDと元のcwdで起動し、下書きを入力欄に戻す |
| 会話IDが存在しない、稼働状態によらず保存先が複数一致、または同じIDの稼働実体が複数 | 接続・起動せずエラー |
| 元のcwdが存在しない | 代替cwdで起動せずエラー |
| 同時に同じIDを `open` | 同じ会話のpi実体を重複起動しない |

通常は保持・復元対象とし、一時再開は閲覧中のpi実体を保持しながら復元対象から除いた状態とする。`--temporary` は `open` の直後に1回だけ指定でき、会話IDの後の指定・重複・余分な引数はエラーにする。

| 指定 | 同じIDの現在の状態 | 結果 |
| --- | --- | --- |
| 通常open | 未起動 | 通常状態で再開する |
| 通常open | 一時再開中 | 同じpiプロセス・PTYを通常状態にし、その操作で復元記録を更新する |
| 通常open | 通常状態で稼働中 | 同じpi実体と通常状態を維持する |
| `open --temporary` | 未起動 | 起動時から一時再開にし、そのIDを復元候補から除く |
| `open --temporary` | 一時再開中 | 同じpi実体と一時状態を維持する |
| `open --temporary` | 通常状態で稼働中 | 同じpi実体と通常状態を維持する |

一時再開の指定IDは、server起動に伴う復元より先に一時再開の対象として扱う。同じIDが保存済みの復元候補にあっても、先に通常状態で復元しない。他の候補の復元は維持する。引数・会話解決の失敗では、一時指定を理由に既存の候補を除去しない。

一時再開の起動と復元候補の除去、通常openによる昇格と復元記録更新は、snapshot・restore・new・open・close・state・workspace解除と排他する。復元記録の読取・検証失敗は「workspace登録」で定める保存保留に従う。それ以外の更新途中の失敗はIDと理由を報告して非0で終了し、既に起動しているpiを停止しない。再度の同じopenで記録更新を修復でき、復元保証は最後に保存完了した集合に従う。

### state

会話IDは `open` と同じ完全一致形式で指定する。`<state>` は `running`・`waiting-approval`・`waiting-user` のいずれかとする。`--source` と `--title` はそれぞれ1個のJSON引数で、順序は入れ替えられる。`--title` は文字列または `null` を受け付け、引用符・改行・tmux formatに見える文字列も文字通りの値として公開する。`--clear` にはstateとtitleを指定しない。引数の不足・過剰・重複、不正JSON、不正な型は、変更せずエラーにする。

sourceは通知元が捕捉した次の情報を持つJSON objectとする。会話IDだけから対象を選ばない。

| 項目 | 型・値 |
| --- | --- |
| `socket` | 専用socketの絶対パスの文字列 |
| `serverPid` | 専用serverのPIDを表す正の整数 |
| `pane` | 通知元のpane IDの文字列 |
| `pid` | 通知元piのPIDを表す正の整数 |
| `token` | 通知元piの起動トークンを表すUUID文字列 |

起動トークンは、CLIがpiを起動する単位で新規に発行し、`PI_TMUX_LAUNCH_TOKEN` 環境変数でpiへ渡し、paneの `@pi-mux-launch` に記録する。CLIが起動したpiでは、拡張が公開するpaneメタデータ(`@pi-tmux-session`)も同じトークンを記録する。専用tmux内でCLIによらず起動したpiは、拡張が生成したトークンをpaneメタデータへ記録して使う。トークンは起動ごとに新しく、再利用しない。

通知元の生存期間は `serverPid` と起動トークンで識別する。CLI初期化の有無によらず照合し、「snapshotと復元」のCLI発行 `server-generation` は通知元の必須条件にしない。

sourceの全項目、会話ID、現在のpaneのpi実体を、稼働中の専用serverと照合してから変更する。照合では、paneの `@pi-mux-launch` のトークン(記録がない場合はpaneメタデータのトークン)と source の `token` の一致を確認する。トークンは起動ごとに新しいため、PIDの再利用、pane IDの再利用、serverの再起動は同じ通知元と見なさない。未知・停止済み・複数実体・対応不一致の通知は、公開値・一時状態・復元記録を変更せずエラーにする。server起動・初期化・復元・pi起動・接続・workspace登録は行わない。

| 通知・状態 | 結果 |
| --- | --- |
| 一時再開中に `waiting-user`・`waiting-approval`、またはその状態のタイトル変更 | stateとtitleを公開し、一時状態を維持する |
| 一時再開中に `running` | stateとtitleを公開し、既存piを再起動せず通常状態へ昇格させ、その操作で復元記録を更新する |
| 通常状態に任意の有効なstate | stateとtitleを公開し、通常状態を維持する |
| 昇格通知を再送 | 重複起動せず、通常状態と復元記録を修復する。同値の公開済みstateだけを理由に記録更新を省略しない |
| `--clear` | 同じ通知元が公開した値だけを除去する。新しいpi実体の値を保持し、一時状態・workspace登録・復元候補を維持する |

昇格の基準は `running` 通知であり、userメッセージの保存ではない。拡張や自動処理による実行開始も同じ条件で扱う。

state の処理は、排他ロックを要しない「pane 公開」と、必要なときだけロックを取る「昇格・修復」の2段で構成し、この順で実行する。

#### pane 公開（排他の外）

全通知で、source検証と、ガード付きの pane 属性書込み（`@pi_session_state` と `@pi-mux-state-source` の公開、`@pi-mux-pending-restart-blocker` の除去）を行う。`waiting-user`・`waiting-approval`・`--clear` はここまでで完了する。

#### 昇格・修復（排他の中）

`running` で、一時再開中の昇格（`PI_TMUX_TEMPORARY` 除去）または server世代の修復（`@pi-mux-generation` 存在による snapshot repair）を要するときだけ、snapshot・restore・new・open・close・workspace解除と同じ排他の中で両方を行う。ロックの取得は待たない。これにより起動・復元が保持するロックを状態通知が待ち続けない。競合した場合は、`@pi-mux-pending-restart-blocker` と `@pi-mux-restart-veto` を書き、`@pi_session_state_pending` を公開して終了する。ロック部分が成功したときは `@pi_session_state_pending` を除去する。

| 終了条件 | 終了コード |
| --- | --- |
| pane 公開が完了し、昇格・修復が不要または完了した | 0 |
| 昇格・修復のロックが競合した（pane 公開は完了済み、昇格・修復は未完了） | 75 |
| pane 公開の失敗など、競合以外の失敗 | 1 |

成功時はstdout・stderrへ出力しない。競合以外の失敗はIDと理由をstderrへ表示する。公開・昇格・記録更新の途中失敗では一部が反映済みの場合があり、piの動作は継続する。同じ通知の再送で未完了の更新を修復できる。保存済みの復元記録が不正な場合は上書きせず、復元保証は最後に保存完了した集合までとする。

#### pane optionの公開契約

pane-local user option `@pi_session_state` に、次のJSON文字列を公開する。stateとtitleは同時に置き換え、tmux format展開は行わない。

```json
{
  "version": 1,
  "sessionId": "<会話ID>",
  "state": "running",
  "title": "Fix the build"
}
```

| 項目 | 値 |
| --- | --- |
| `version` | `1` |
| `sessionId` | 通知で指定した会話ID |
| `state` | 通知で指定した実行フェーズ |
| `title` | 通知で指定した文字列または `null` |

ロック部分の競合時は、pane-local user option `@pi_session_state_pending` に、次のJSON文字列を公開する。公開は source検証済みのpaneへガード付きで行い、tmux format展開は行わない。

```json
{
  "version": 1,
  "sessionId": "<会話ID>",
  "attemptAt": 1735689600000
}
```

| 項目 | 値 |
| --- | --- |
| `version` | `1` |
| `sessionId` | 通知で指定した会話ID |
| `attemptAt` | 競合した昇格・修復の試行時刻を表す正の整数（epoch ms） |

ロック部分が成功したときと `--clear` 成功時に、`@pi_session_state_pending` を除去する。`waiting-user`・`waiting-approval` は `@pi_session_state_pending` を変えない。通常openによる昇格やpaneの置換でも、`@pi_session_state_pending` を変えない。公開値はworkspace登録と復元候補とは別に扱う。pane終了でpane-localの値も消滅する。

### send

`send [--wait <seconds>] <session-id> <text...>` は、稼働している対象会話のpi実体へ短いメッセージを1件届ける。稼働はpi実体の生存を指し、エージェントループの実行状態は送信の可否に影響しない。実行中・アイドル・承認やユーザー回答の待機中のいずれの状態にも送信でき、届くタイミングは受信側の状態で決まる(後述の表)。稼働していない会話へは、`open` で復元してから `send` する。`open` の完了時点で実体は稼働しているため、復元直後のセッションにも届く。並行する会話間で、重複作業の発見や引き継ぎの交渉を、対象のエージェントループへ直接通知するために使う。

会話IDは `open` と同じ形式の完全一致で指定し、`switch` と同じ稼働実体の解決を使う。serverの起動・復元、piの起動・接続、workspace登録は行わない。稼働実体がないIDと同じIDの実体が複数のときは、エラーにする。

`--wait` は `send` の直後に1回だけ指定でき、正の整数の秒数を受け付ける。それ以外の位置の `--wait` はテキストの一部として扱う。`<text...>` は会話ID以降の引数を単一スペースで連結した文字列とし、空白・引用符・改行・先頭の `-` を保持する。空文字列・空白のみ・NULを含むテキスト、および2800 code pointsを超えるテキストは、エラーにする。

送信側の識別はCLIが `PI_SESSION_ID` 環境変数から埋め、未設定のときは `external` とする。呼び出し元が送信者を指定する引数は持たない。

#### メッセージoptionの契約

メッセージは pane-local user option で届ける。option名はメッセージごとに `@pi-mux-msg-<uuid>` とし、値は次のUTF-8 JSONエンベロープをbase64エンコードした文字列とする。1メッセージ1optionとし、複数送信の読み書き競合を避ける。

```json
{
  "v": 1,
  "id": "<uuid>",
  "from": "<session-id or \"external\">",
  "at": "<ISO-8601>",
  "text": "<message>"
}
```

| 項目 | 値 |
| --- | --- |
| `v` | `1` |
| `id` | メッセージのUUID。option名のUUIDと同じ値 |
| `from` | 送信したCLIプロセスの `PI_SESSION_ID`。未設定のとき `external` |
| `at` | 送信時刻のISO-8601文字列 |
| `text` | メッセージ本文。2800 code points以下 |

テキスト上限の2800 code pointsは、tmux optionの計測容量（約4KBのbase64値は格納可能、16KBは失敗）から設定した運用上限である。

optionの書き込みは、対象paneのserver PID・pane ID・pane PIDの一致を条件とした `source-file` 上の `if-shell` で行い、書き込み後にoption値の読み戻しで確認する。確認が取れないとき、および対象のpaneが書き込み時点で消滅・置換しているときは、エラーにする。

受信側(pi-mux-bridge拡張)は、専用tmux内のTUIセッションで自身のpane optionを約2秒間隔で確認し、`@pi-mux-msg-` 接頭辞のoptionを処理する。有効なエンベロープのメッセージは、送信側の識別と時刻を本文に付した attributed custom message(`customType: "agent-message"`)として `deliverAs: "steer"`・`triggerTurn: true` で会話へ注入し、注入後に同一条件の `if-shell` でoptionを除去する。不正な値のoptionは注入せず、除去して記録する。

| 受信側の状態 | 配信 |
| --- | --- |
| ストリーミング中(エージェントループ実行中) | 現在のassistantターンのtool実行後・次のLLM呼び出し前にsteerとして届く |
| アイドル | ただちにターンを開始して届く |
| 承認・ユーザー回答待ち | メッセージは次のターン境界まで待機する。保留中の承認は自身のUIで先に解決する |

消費の信号はoptionの除去とする。`--wait <seconds>` 指定時は、CLIがoptionの消失をポーリングして確認する。消失を確認したら `delivered` をstdoutへ出力して終了コード0で終了する。対象paneの消滅によりoptionが失われたときは配信失敗として扱う。`--wait` 省略時はoptionの書き込み確認後に、stdout・stderrへ出力せず終了コード0で終了する。

| 失敗 | 結果 |
| --- | --- |
| 稼働実体がない、同じIDの実体が複数 | optionを書かずエラーにする |
| 対象paneが書き込み前に消滅・置換 | optionを書かずエラーにする |
| テキストが上限を超える、空・不正 | 理由をstderrへ表示して終了コード1 |
| `--wait` 中にoptionが消費されない | option名とともにstderrへ表示して終了コード1 |
| `--wait` 中に対象paneが消滅 | 配信失敗としてoption名とともにstderrへ表示して終了コード1 |

### close

会話IDは省略せず、`open` と同じ形式の完全一致で指定する。前方一致や大文字小文字の正規化は行わない。専用tmux内の稼働piと起動途中の管理piを対象とし、会話ファイルの探索・piの起動・接続・復元・確認プロンプトを行わない。

| 状態 | 結果 |
| --- | --- |
| 同じ会話IDのpiが稼働中 | 対象piを終了し、終了を確認してから、そのIDの復元候補を除く |
| 同じ会話IDの管理piが起動途中 | 安全に特定した対象piを同じ手順で終了する |
| 対象piが停止済み、専用serverが不在、または有効な形式の未知ID | serverを起動せず、残っている同じIDの復元候補を除く。候補もなければ成功する |
| 引数が不足・過剰、または会話IDの形式が不正 | 停止や記録更新を行わずエラーにする |
| 同じIDの稼働実体・管理sessionが複数、または起動途中の対象を安全に特定できない | 停止や記録更新を行わずエラーにする |
| 復元記録が不正 | 停止や記録更新を行わずエラーにする |
| 停止・終了確認・復元候補の除去に失敗 | IDと理由を報告してエラーにする。既に終了したpiを再起動しない |
| 最後のpiを停止 | 専用serverとworkspace登録を維持する。ほかに復元対象がなければ、各登録workspaceの `sessions` は空配列になる |

`close --if-temporary <session-id>` は、`--if-temporary` を `close` の直後に1回だけ指定する。条件付き停止は `close` と同じ排他の中で対象の一時状態を判定してから扱う。起動途中の管理piは、一時再開として起動したものであれば一時状態として扱う。

| 対象の状態 | 結果 |
| --- | --- |
| 同じ会話IDのpiが一時再開中 | `close` と同じ手順で終了と復元候補の除去を行う |
| 同じ会話IDのpiが通常状態 | 停止も復元候補の除去も行わず、終了コード0で終了する |
| 有効な形式のIDで稼働対象がない | serverを起動せず、停止も記録更新も行わず、終了コード0で終了する |
| 同じIDの稼働実体・管理sessionが複数、または起動途中の対象を安全に特定できない | `close` と同じく停止や記録更新を行わずエラーにする |

成功時はstdout・stderrへ出力せず終了コード0、失敗時はstderrへ理由を表示して終了コード1で終了する。保存完了済みの会話ファイル・workspace登録・他のpiとpaneを保持する。シェル配下のpiを停止するときはシェルを保持する。対象のpiだけを占有するpaneは終了し、空になったtmux sessionは消滅する。

停止成功後のsnapshot・restoreでは、停止したIDを復元対象へ戻さない。同じIDを通常openで再び起動した場合は通常の復元対象になる。停止処理はsnapshot・restore・new・open・state・workspace解除と排他し、他会話の復元候補とserver世代の保護を維持する。

### workspace登録

フロントエンドがpiの起動前にもworkspaceの登録状態を判定し、空workspaceへ新規会話を事前ロードできるようにする。登録の正本は「snapshotと復元」で定める復元記録の `workspaces` とする。登録workspaceと復元対象の会話IDはpi-muxが更新し、稼働pi・実行フェーズ・公開タイトルは専用tmuxから取得する。登録の取得・更新は復元記録に対して行う。

`<cwd>` は呼び出し時のcwdから絶対パスへ解決する。registerは存在するディレクトリを受け付け、unregisterは消失済みのディレクトリも受け付ける。同じ絶対パスは1登録とする。

| 状態・操作 | 結果 |
| --- | --- |
| 未登録workspaceをregister | `sessions: []` のworkspaceを復元記録に追加する。piとtmux serverを起動しない |
| 登録済みworkspaceをregister | 既存の登録と復元候補を保持する |
| `new`・`open` の起動・再接続成功 | そのcwdを登録する。復元記録の読取・検証に失敗した場合は下記の保存保留に従う |
| 専用tmux内で外部から起動したpi | paneを直接占有するpiと、paneのシェル配下のpiを、拡張が公開したmetadataから `list` が検出し、そのcwdを登録する。専用tmux外のpiは取り込まない |
| workspaceをunregister | 全windowを対象に、そのcwdの稼働piと起動途中の管理piを終了する。終了を確認してからworkspace登録と同じcwdの復元候補を除く。他workspaceと保存会話ファイルを保持する |
| 未登録workspaceをunregister | 稼働pi・復元候補があれば同じ終了・除去を行い、なければ成功する |
| 起動途中の管理piのpaneを安全に特定できない | 他paneを終了せず、workspace登録と復元候補を保持して非0で終了する |
| 不正な復元記録、または終了の失敗 | 理由を報告して非0で終了し、workspace登録を保持する。既に終了したpiは再起動しない |

登録の追加・解除では、他workspaceの登録と復元候補、および保存済みのserver世代を保持する。不正な復元記録は上書きしない。通常のpi終了後もworkspace登録は保持する。解除後の新しい起動は再び登録対象になる。登録の変更はsnapshot・restore・new・open・close・stateと同じ排他で行い、同時更新による登録や復元候補の欠落を防ぐ。

`new`・`open` では、復元記録を読み取れない、または内容が不正な場合も、起動・接続可能なpiへの接続と非接続起動の結果返却を継続する。既存記録を上書きせず、登録と復元候補の保存を保留し、理由をstderrへ表示する。記録の復旧後は、稼働cwdを取得する `list`、または次の `new`・`open` で登録を保存できる。復元保証は最後に保存完了した集合に従う。記録の書込み失敗、通知元の不一致、server世代の不一致はこの保存保留に含めず、各操作のエラーとして扱う。

register・unregisterの成功時はstdout・stderrへ出力せず終了コード0、失敗時はstderrへ理由を表示して終了コード1で終了する。

### list

`list` は復元記録の登録済みcwdと専用tmuxの稼働piを統合し、stdoutへ `[{"cwd":"/path/to/workspace","sessions":[{"id":"session-id","file":"/path/to/session.jsonl","state":null,"title":null,"publishPending":null}],"empty":[{"id":"empty-session-id","file":"/path/to/session.jsonl"}]}]` 形式のJSON配列と末尾改行を返す。workspaceの `cwd` は絶対パス、`sessions` は会話ファイルが存在する稼働piだけの配列であり、該当がなければ空配列になる。復元候補を稼働piとして代用しない。PID・tmux targetは内部検証に使う。

各sessionは次の5項目を持ち、一時再開中だけ `temporary: true` を追加する。通常状態では `temporary` 属性を省略する。一時再開中も `sessions` に掲載し、`id`・`file`・`state`・`title`・`publishPending` の意味は維持する。

空新規（会話ファイルが未作成の稼働pi）は `sessions` に入れず、workspaceオブジェクトの `empty` 配列に置く。存在判定はmetadataの `file` パスに対する存在チェックによる。`empty` の各要素は `id` と `file` の2項目を持ち、`state`・`title`・`publishPending` は持たない。`temporary` の付与は `sessions` と同じで、一時再開中だけ `temporary: true` を追加する。`empty` も該当がなければ空配列になる。

| 項目 | 型 | 値 |
| --- | --- | --- |
| `id` | `string` | 会話ID |
| `file` | `string` | 会話ファイルの絶対パス。未作成の保存予定先も含む |
| `state` | `string \| null` | `running`・`waiting-approval`・`waiting-user` のいずれか。確認できない場合は `null` |
| `title` | `string \| null` | セッションのタイトル。公開値を優先し、公開値がなければ会話ファイルから解決したタイトル（保存済みセッション名、なければ最初の user メッセージ）を使う。いずれも確認できない場合は `null` |
| `publishPending` | `{"attemptAt": number} \| null` | pane に未完了の昇格・修復の試行が記録されているとき、その試行時刻を含むオブジェクト。それ以外は `null` |

stateとtitleは、同じpane option `@pi_session_state` のJSONから取得する。titleは公開値を優先し、公開値がなければ会話ファイルから解決したタイトル（保存済みセッション名、なければ後述の最初の user メッセージ）を使う。公開形式と更新契約は「state」の「pane optionの公開契約」に従う。接続・セッションのアクティブ化・保存会話の再読み込みを行わず、タイトル公開後の `list` に反映する。

| 条件 | `state` | `title` |
| --- | --- | --- |
| optionが未公開、不正JSON、`version` が1でない、または `sessionId` が一覧の会話IDと一致しない | `null` | 会話ファイルから解決したタイトル |
| `version` と `sessionId` が有効 | 上記3値のいずれかなら採用し、それ以外は `null` | 文字列ならそのまま採用し、`null`・欠落・その他の型は会話ファイルから解決したタイトル |

共通のversion・会話ID検証後はstateとtitleを独立して検証する。titleを持たない旧形式やtitleの型が不正な値でも、有効なstateは保持する。stateが不正でも有効なtitleは保持する。いずれの値が `null` でも、pi自体は一覧に残す。

`publishPending` は、pane option `@pi_session_state_pending` のJSONから取得する。optionが未公開、不正JSON、`version` が1でない、`sessionId` が一覧の会話IDと一致しない、または `attemptAt` が正の整数でない場合は `null` とし、それ以外は `{"attemptAt":<attemptAt>}` を返す。公開形式と除去の契約は「state」の「pane optionの公開契約」に従う。`publishPending` は追加フィールドであり、既存項目の型・値・検証を変えない。`@pi_session_state_pending` が未公開のpaneでは `publishPending` は `null` になり、この項目を解釈しない一覧の読み手は、既存項目だけを同じ契約で扱える。

会話ファイルから解決したタイトルは、会話ファイル内で最後の `session_info` エントリの `name` とし、セッション名が利用できない場合は最初の user メッセージとする。セッション名は、ファイル末尾から逆順に走査して最初に見つけた `session_info` エントリを使う。`name` が空白のみを含む文字列・空文字列・`undefined` のエントリはセッション名の明示的なクリアとして扱い、さらに前のエントリへは辿らない。これはpi本体がセッション名の共有値として返す規則と同じである。セッション名が利用できない場合、titleは最初の user メッセージへフォールバックする。ファイル先頭から順に走査し、`type` が `message` で `message.role` が `user`、テキスト部分が空でない最初のエントリを使う。`content` が文字列ならそのまま使い、配列なら `type` が `text` のブロックの `text` を単一のスペースで結合する。pi本体のセッション一覧が最初のメッセージとして扱う規則と同じである。フォールバックのタイトルは、改行を含む連続する空白を単一のスペースへ置き換え、前後の空白も取り除いた上で、最初の80 code pointsへ切り詰める。サロゲートペアは1 code pointとして数え、省略記号は付けない。会話ファイルが未作成・読み取れない場合や、セッション名も最初の user メッセージも解決できない場合は、titleを `null` にする。

metadataは会話ID・絶対パスのcwdとfileを検証する。paneを直接占有するpiは、公開したpi PIDとpane PIDの一致を検証する。シェル配下のpiは、公開したpane PIDの一致とpi PIDがその子孫であることを検証し、終了済みpiを一覧から除く。終了済みpaneとmetadata未公開のpaneは含めない。不正metadataはエラーとする。startupを持たないmetadataと、startupが `accepted` または `ready` のmetadataを受け付ける。一覧への掲載は復元成功を示さず、復元では `ready` を必須とする。

| 状態 | 結果 |
| --- | --- |
| 専用serverが未起動、または稼働piがない | 登録済みworkspaceを空の `sessions`・`empty` とともに返す。登録もなければ終了コード0で `[]` を返す |
| tmuxからの取得に失敗 | 理由をstderrへ表示し、非0で終了する |

`list` は未登録の稼働cwdがある場合だけworkspace登録を書き込む。workspace登録と「再取得とキャッシュ」で定めるタイトルキャッシュ以外のディレクトリ作成・JSON書込みを行わない。server起動・復元は行わない。登録の追加時は既存の復元候補とserver世代を保持する。

### switch

`switch <session-id> [--client-pid <pid>]` は、専用tmuxに接続中のクライアントが表示するtmuxセッションを、その会話IDのpi実体が属するtmuxセッションへ切り替える。会話IDは `open` と同じ形式の完全一致で指定する。serverの起動・復元、piの起動、workspace登録は行わない。

切替先は、全生存paneのmetadataから会話IDと一致するpi実体を探し、そのtmuxセッション名で解決する。同じ会話IDの実体が複数ある、または未知のIDのときは切替せずエラーにする。

クライアントの特定は次のとおり行う。

| 条件 | 結果 |
| --- | --- |
| `--client-pid <pid>` 指定時 | 接続中クライアントのうち、クライアントプロセスのPIDが `pid` と一致するか、`/proc/<クライアントPID>/status` のPPidが `pid` と一致するものを1つ使う。該当がない・複数あるときは切替せずエラーにする。Windows ではPPidとの一致を使わず、PIDの一致だけで特定する(「Windows での挙動差」参照) |
| `--client-pid` 省略時 | 接続中クライアントがちょうど1つのときそれを使う。0個または2個以上のときは切替せずエラーにする |

切替は `switch-client -c <クライアント> -t =<tmuxセッション名>` としてセッション名の厳密一致で行う。成功時は stdout・stderr へ出力しない。失敗時は理由を stderr へ表示する。

| 終了コード | 結果 |
| --- | --- |
| `0` | 切替成功 |
| `2` | 生存 pane に指定 ID の Pi が見つからない |
| `3` | 対象 Pi は見つかったが、該当する接続クライアントがない。接続を待つ場合は呼び出し側が再試行する |
| `1` | その他の失敗（該当する Pi またはクライアントが複数ある場合を含む） |

### current

`current [--client-pid <pid>]` は、クライアントが表示中のpaneのpi実体のmetadataを読み、stdoutへ `{"id":"session-id","cwd":"/path/to/workspace","file":"/path/to/session.jsonl","target":"tmux-session-name"}` 形式のJSONオブジェクト1件と末尾改行を返す。表示中のpaneは、クライアントが表示するwindowのactive paneとする。`target` は表示中のpaneが属するtmuxセッション名、`id`・`cwd`・`file` はmetadataの値とする。クライアントの特定は `switch` と同じ `--client-pid` の照合と省略時の唯一クライアント判定を使う。

| 状態 | 結果 |
| --- | --- |
| 表示中のpaneがpi実体のmetadataを持つ | metadataの `id`・`cwd`・`file` と表示中のpaneが属するtmuxセッション名をJSONで返し、終了コード0で終了する |
| 表示中のpaneがpi実体のmetadataを持たない、または表示中のpaneを特定できない | 何も出力せず理由をstderrへ表示し、非0で終了する |

同一tmuxセッション内の複数のpaneでpi実体が稼働していても、表示中のpaneのpi実体を返す。

serverの起動・復元、piの起動・接続、workspace登録は行わない。

### history

`history [--cwd <absolute-cwd>]` は、復元記録の `workspaces` に登録されたcwdごとの保存会話を列挙し、stdoutへ `[{"id":"session-id","cwd":"/path/to/workspace","file":"/path/to/session.jsonl","title":"name","btime":1735689600000,"mtime":1735693200000,"size":1024}]` 形式のJSON配列と末尾改行を返す。`--cwd` に絶対パスを指定したときはそのcwdのみを対象にし、登録されていないcwdなら `[]` を返す。

「保存会話の探索範囲」のうち、対象cwdに対応するグループの通常側とarchive側を列挙する。保存先が環境変数・settings のときは、保存先直下の `*.jsonl` のうちヘッダーのcwdが対象cwdに一致する会話を列挙する。同じ会話IDが通常側とarchive側にある場合は通常側を返し、そのIDのarchive側を結果から除く。

各要素は次の7項目を持つ。

| 項目 | 型 | 値 |
| --- | --- | --- |
| `id` | `string` | 会話ファイル先頭行（ヘッダー）の会話ID |
| `cwd` | `string` | ヘッダーのcwd。グループディレクトリ名より優先する |
| `file` | `string` | 会話ファイルの絶対パス |
| `title` | `string \| null` | `list` と同じ規約で会話ファイルから解決したタイトル（保存済みセッション名、なければ最初の user メッセージ）。いずれも解決できない場合は `null` |
| `btime` | `number \| null` | 会話ファイル内で物理的に最初に現れる、`type` が `message` で `message.role` が `user` のエントリの `timestamp` をミリ秒へ解釈した値。初回ユーザーメッセージの送信日時 |
| `mtime` | `number \| null` | 会話ファイル内で物理的に最後に現れる、`timestamp` をミリ秒へ解釈できる有効な `message` または `compaction` エントリの `timestamp`。会話の最新活動時刻。該当するエントリがなければ `null` |
| `size` | `number` | 会話ファイルのサイズ（バイト） |

`btime` の対象となる最初の user メッセージは、テキストの有無によらず選び、画像のみのメッセージも含む。時刻は `message.timestamp` ではなく、そのメッセージを保存したエントリ側の `timestamp` を使う。後続のメッセージ送信で `btime` を更新しない。

ヘッダーが読めない・不正なファイル、および `timestamp` をミリ秒へ解釈できないヘッダーのファイルは結果から除く。有効なヘッダーを持つ保存会話は、次のとおり結果に含める。

| 条件 | 結果 |
| --- | --- |
| 最初の user メッセージが未保存 | `btime: null` として結果に含める |
| 最初の user メッセージが保存済み | そのエントリの時刻を `btime` として結果に含める |

並びは `mtime` の降順とする。`mtime` が `null` の要素は有効な `mtime` を持つ要素の後方に並べ、`mtime` が等しい要素は `file` の昇順とする。archived（負論理）の判定は行わず、対象cwdの保存会話全件を返す。復元記録と会話ファイルへの書込み、serverの起動、piの起動は行わない。

#### 再取得とキャッシュ

`history` のタイトル・btime・mtime の取得と、`list` で公開titleがない場合のタイトル解決は、同じファイル単位のキャッシュを呼び出し間で共有する。どちらで取得した結果も、もう一方で再利用できる。キャッシュは最終的に解決したタイトル、すなわち保存済みセッション名または最初の user メッセージのフォールバックと、btime・mtime を保存する。後にセッション名を付けると会話ファイルの fingerprint が変わるため、再解決ではセッション名が優先される。公開titleの優先順位と「list」で定めるタイトルの解決規約は維持する。

キャッシュは会話ファイルと復元記録から独立した再生成可能なものとし、CLIが管理する。利用者による作成・更新・削除を前提にしない。キャッシュの有無によらず、一覧の各項目と並び順は原本から取得した結果と同じにする。

| 条件 | 結果 |
| --- | --- |
| 会話ファイルに変更がなく、有効なキャッシュがある | 会話ファイル本文を読み直さず、保存済みのタイトル・btime・mtime の解決結果を再利用する |
| 会話ファイルを追加・追記・上書き・切り詰めた | 次の `history` と、タイトルを解決する次の `list` に現在の内容を反映する。変更したファイルのタイトル・btime・mtime は原本から解決する |
| 会話ファイルを改名・削除した | 次の `history` に現在のファイル構成を反映する |
| キャッシュがない・破損している・未対応の形式である | 原本から結果を取得する |
| キャッシュの保存に失敗した | 原本から取得した結果を返す。キャッシュ保存の失敗だけを理由に取得を失敗させない |

`history` で保存会話129件・合計約1.43GBを対象とする性能の受入基準は、次のとおりとする。

| 条件 | 応答時間 |
| --- | --- |
| 有効なキャッシュがあり、原本に変更がない再取得 | 1秒以内に返す |

### snapshotと復元

復元記録は `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-tmux/pi-mux-restore.json` に、次のJSON形式で保存する。`workspaces` は登録済みworkspaceの全件を表し、稼働piや復元候補がないworkspaceも保持する。ワークスペースは起動cwdの絶対パスでまとめ、`sessions` は復元対象として保持する会話IDの文字列配列とする。

```json
{
  "version": 1,
  "generation": "server-generation",
  "workspaces": [
    {
      "cwd": "/path/to/workspace",
      "sessions": ["session-id", "retry-session-id"]
    },
    {
      "cwd": "/path/to/empty-workspace",
      "sessions": []
    }
  ]
}
```

| 項目 | 値 |
| --- | --- |
| `version` | `1` |
| `generation` | 保存対象のserver世代を表す文字列。記録がなく、serverを起動せず登録だけを保存する場合は空文字列。既存記録の登録変更では保存済みの値を保持する |
| `workspaces` | cwdごとの登録workspace配列。登録がない場合だけ空配列 |
| `cwd` | ワークスペースの起動cwdの絶対パス |
| `sessions` | そのcwdで通常の復元対象として保持する会話IDの配列。稼働中・復元途中・復元失敗・初期化未完了の会話を含み、起動や復元成功だけでは除外しない。復元対象がなければ空配列 |

同じcwdは1つのワークスペースにまとめる。同じ会話IDに異なるcwdが指定された記録はエラーとする。記録がなければ登録と復元候補は空として扱う。不正・未対応形式・読取り失敗は理由を報告し、既存記録を上書きしない。

snapshotと復元候補の更新は、登録workspaceを保持したまま `sessions` を更新する。新しい管理会話のcwdは登録に加える。最後の候補の除外、一時再開、復元失敗、保存会話の消失、server再起動・復元の途中でも登録を除かず、登録の除去はworkspace解除に従う。

`server-generation` は、専用serverの1回の生存期間を識別するCLI発行の内部IDである。CLIが専用serverを初期化するときに発行し、同じserverの生存中は同値、再起動後は別の値にする。sessionの作成・終了hookは発火元の世代を `snapshot` の引数へ渡す。CLIは現世代と照合し、旧世代の遅延処理による新世代の記録変更を防ぐ。通常の `snapshot` で引数を省略した場合は、現世代を対象とする。`generation` が空文字列の記録は復元候補を持たない登録用の記録とし、専用serverの初期化・復元または現世代のsnapshotで、登録を保持したまま現世代に更新する。引数で指定された旧世代のsnapshotは、この場合も記録を変更しない。

管理会話は、tmux session環境の `PI_TMUX_SESSION_ID` と、そのsessionの起動cwdで識別する。これらはpi起動前から設定する。snapshotはpaneに起動後公開されるmetadataを待たず、通常状態の管理会話を採取し、復元途中・復元失敗・初期化未完了の候補と合わせて `sessions` に保持する。一時状態はpi起動前から判別可能とし、初回と後続のsnapshotのどちらでも一時再開中のIDを除外する。過去の候補との統合でも、そのIDを復元対象へ戻さない。sessionの作成・終了hookでsnapshotを実行する。

| 状態・操作 | 結果 |
| --- | --- |
| 正常稼働中にsessionを作成・終了 | 新しい管理会話を `sessions` に加え、通常終了した会話を除く。最後の復元対象がなくなっても登録workspaceを `sessions: []` で保持する |
| serverが消失・接続拒否・shutdown中、または採取に失敗 | 保存完了済みの集合を保持し、失敗理由を報告する |
| 古いserver世代のhookが遅延実行 | 新しい世代の記録を変更しない |
| server起動または `restore` | 保存集合のうち保存会話があるものを、同じID・cwd、1会話1sessionで非接続起動する |
| 保存会話が存在しないことが確定 | その候補を記録から除外する。未保存の空新規もこの条件に従う |
| 作成受付だけ確認済みの稼働pi が復元候補に含まれる | 作成受付を復元成功と見なさず、初期化完了を確認できない候補として理由を報告し、次回の復元対象に保持する |
| 復元するpi の拡張初期化中 | 起動成功として扱わず、その候補を次回の復元対象に保持する |
| 拡張初期化を完了して入力待ちになったpi の通常終了 | その会話を復元対象から外す |
| 保存先の重複・アクセス失敗・不正データ・cwd欠落・pi起動失敗・初期化中の終了・起動タイムアウト | IDと理由を報告し、その候補を次回の復元対象に残す。他の候補と通常の `new`・`open` は継続する |
| 失敗候補が残った状態で通常snapshot | 稼働会話と失敗候補を同じ `sessions` に保持する |
| 同じIDが既に稼働中 | 同じpi実体と一時・通常の状態を維持し、重複起動しない |
| workspace登録・解除・snapshot・restore・new・open・close・stateの同時実行、または復元処理の異常終了 | 復元途中の部分集合で候補を消さず、重複起動を防ぐ。異常終了した実行者の排他は後続処理を妨げない |

復元は保存会話を開いた入力待ち状態にする。初期入力・LLM再送信・tool再実行・自動続行は行わない。window/paneの配置は復元しない。復元保証の基準は最後に保存完了した集合であり、保存完了前の書込みと未保存の会話内容は保証しない。

### reload

`reload [<session-id>]` は、専用tmux外の端末から実行し、専用serverと他のpiを停止しないまま、管理対象のpiプロセスを同じ会話ID・cwdの新しいpiプロセスへ順次置き換える。pi・拡張・pi-mux・`pi.conf` の更新を、稼働中の会話と接続クライアントを壊さずに反映するための操作である。`<session-id>` には `open` と同じ形式の完全一致の会話IDを指定でき、指定時は対象をその会話のpiに絞り、他のpiは実行フェーズによらず変更しない。専用tmux内からの実行、引数の過剰・不正な形式は、置き換えや記録更新を行わずエラーにする。

対象は、専用server配下の管理sessionのうち、session環境の会話IDとpaneのmetadataの会話IDが一致するpi(一時再開中・空新規・全windowのpiを含む)とし、会話IDを指定した場合はさらにその会話のpiだけを対象にする。sessionの管理会話でないpiと、CLIによらず専用tmux内で起動されたpiは対象外とし、変更しない。

実行開始時に、専用serverへ現在のpi-muxの設定を再適用する。「専用tmux」の専用設定を `source-file` で読み込み直し、「snapshotと復元」のhook commandを現行のpi-muxで再設定する。serverの世代・稼働中のpi・復元記録の対象は変えない。

CLIは対象の状態を繰り返し確認し、置き換えの条件を満たすpiから1会話ずつ順次置き換える。判定には「state」の公開契約と「list」の実体照合・state検証を使う。

| 対象の状態 | 挙動 |
| --- | --- |
| 実行フェーズの公開が有効な `waiting-user` で、起動受付後の初期化が完了している | 置き換えの候補にする |
| `running`・`waiting-approval`、または実行フェーズが未公開・不正 | `waiting-user` になるまで待つ |
| 稼働piの `running` 通知が排他で遅延している | 遅延した通知が処理されるまで待つ |
| 管理piが起動途中 | 初期化の完了を待つ |
| 同じ会話IDの稼働実体が複数、または同じ会話IDでcwdの矛盾がある | 置き換えず、理由を報告して対象から外す |
| 管理sessionの稼働piがなく、起動途中の管理piも確認できない | 置き換えず、理由を報告して対象から外す |

待機中はpiの処理・状態通知・他のCLI操作を継続できる。待機時間だけを理由に置き換えへ切り替えない。置き換えの直前に対象の実行フェーズを再確認し、有効な `waiting-user` を確認できない場合は待機へ戻る。この再確認に加え、`respawn-pane` の実行を、他のtmuxクライアントによるpane属性の書込みを挟まないtmuxのコマンド列の中で行い、そのコマンド列の中でも、対象の公開実行フェーズが `waiting-user` であることを公開値の形式一致で確認する。待機中に新しいpiが起動した場合は対象に加え、対象がなくなった時点で終了する。中断では、置き換え済みのpiを維持し、残りの対象は現状維持のまま終了する。それまでに出力された再読込済みの会話IDが進捗を示す。

1会話の置き換えは、既存の変更操作と同じ排他の中で次の順で行う。

1. 「snapshotと復元」に従い、現在の通常管理会話・保持中の復元候補・workspace登録を保存する。一時再開と未保存の空新規の復元範囲も同節に従う。
2. 保存完了を確認した後、対象paneのpiプロセスを同じpaneで新しいpiプロセスへ置き換える。新しいpiは、同じ会話ID・cwd・tmux session・paneで入力待ちとして起動し、初期入力・LLM再送信・tool再実行・自動続行は行わない。一時再開中のpiは一時再開のまま置き換え、sessionに接続中のtmuxクライアントは切断しない。置き換えから新しいpiのmetadata公開までは、対象paneのmetadataは未公開になり、「list」の実体一覧から一時的に除かれる。
3. 起動トークンを新しいpiの分へ発行し直し、paneの起動記録を新しいプロセスで書き直す。対象sessionの環境変数を現在の呼び出し環境で更新し、過去の呼び出しにだけ存在した環境変数を持ち越さない。新しいpiのmetadata公開を確認してから、次の対象へ進む。

置き換えでは「restart」と同じ競合防御を適用する。保存後の終了hookや遅延snapshotが保存した候補を上書きしない。置き換え・保存・待機中に専用serverの同一性が変わった場合は、別のserverを停止せずエラーにする。同時の `reload` は重ねて実行できるが、1会話の置き換えは排他の中で重ならない。`restart` と `reload` も同じ排他で直列化する。

| 状態・失敗 | 結果 |
| --- | --- |
| 専用serverが不在 | 既存の保存集合と登録を保持したまま、`restore` と同じ起動・復元を行う |
| 指定した会話IDが稼働していない、または未知のID | 置き換えや記録更新を行わずエラーにする |
| 復元記録の読取・検証・保存、または対象確認に失敗 | 置き換えずエラーにする |
| 1会話の置き換えに失敗 | その会話のIDと理由を報告し、他の会話の待機と置き換えを継続する。復元候補と登録は保持し、次の `restore` で再試行できる |
| すべての対象の置き換えが完了した | 置き換えた会話ごとに `reloaded <会話ID>` をstdoutへ1行出力し、終了コード0で終了する |
| 置き換えられなかった会話が残った | 理由をstderrへ表示して終了コード2で終了する |

置き換えた会話は復元記録の対象から外さず、保存済みの会話ファイルを維持する。待機条件を満たしたpiには実行中の処理がないため、`--force` や待機の省略は持たない。

### restart

`restart [--force]` は、専用tmux外の端末から実行し、専用serverと配下の全piを終了した後、保存会話を新しいpiプロセスで非接続復元する。専用tmux内からの実行、`--force` の重複、その他の引数は、停止や記録更新を行わずエラーにする。

通常の `restart` は、専用server配下の全piについて、現在の実行フェーズが `waiting-user` であることを確認してから停止へ進む。一時再開中・空新規・全windowのpiも待機判定に含める。判定には「state」の公開契約と「list」の実体照合・state検証を使う。

| 現在の状態 | 通常の `restart` | `restart --force` |
| --- | --- | --- |
| `waiting-user` | 停止可能として扱う | 状態を待たず停止へ進む |
| `running` または `waiting-approval` | `waiting-user` になるまで待つ | 状態を待たず停止へ進む |
| 実行フェーズが未公開・不正・不一致、または管理piが起動途中 | 停止可能と見なさず、有効な `waiting-user` を確認できるまで待つ | 状態を待たず停止へ進む |
| 配下にpiがない | 状態を待たず停止へ進む | 状態を待たず停止へ進む |

待機中はpiの処理・状態通知・他のCLI操作を継続できる。待機時間だけを理由に強制停止へ切り替えない。停止開始の直前に対象pi集合と各状態を再確認し、新しいpiや `running`・`waiting-approval` のpi、有効な `waiting-user` を確認できないpiがあれば待機へ戻る。この再確認に加え、停止の実行を、他のtmuxクライアントによるpane属性の書込みを挟まないtmuxのコマンド列の中で行い、そのコマンド列の中でも、各paneの公開実行フェーズが `waiting-user` であることを公開値の形式一致で確認する。待機中の中断ではpiを停止しない。

待機条件が成立した場合、または `--force` を指定した場合は、次の順で処理する。

1. 「snapshotと復元」に従い、現在の通常管理会話・保持中の復元候補・workspace登録を保存する。一時再開と未保存の空新規の復元範囲も同節に従う。
2. 保存完了を確認してから、その専用serverと配下の全piを終了する。接続中のtmuxクライアントは切断される。他のtmux serverと専用tmux外のpiを保持する。
3. 旧serverの終了を確認した後、新世代の専用serverを起動し、保存集合を「snapshotと復元」の条件で復元する。同じID・cwdの保存会話を入力待ちに戻し、途中のLLM・tool処理は自動再開しない。

保存から復元までは、既存の変更操作と同じ排他で扱い、同時の `restart` も重ねて実行しない。全piの待機を待つ間は、その排他を占有し続けない。保存後の終了hookや旧世代の遅延snapshotが、再起動用に保存した候補を部分集合や空集合で上書きしない。待機・保存・停止中に専用serverの同一性が変わった場合は、別のserverを停止せずエラーにする。

| 状態・失敗 | 結果 |
| --- | --- |
| 専用serverが不在 | 既存の保存集合と登録を保持したまま、`restore` と同じ起動・復元を行う |
| 復元記録の読取・検証・保存、または停止前の対象確認に失敗 | serverとpiを停止せず、既存の保存完了済み記録を保持してエラーにする |
| 旧serverの停止・終了確認に失敗 | 新serverを起動せず、保存集合を保持してエラーにする |
| 新serverの起動・復元に失敗、または停止後に処理が中断 | 保存集合と登録を保持する。復元候補の保持・除外は「snapshotと復元」に従い、次の `restore` で再試行できる |

`--force` が省略するのは実行フェーズの待機だけとし、保存・対象確認・世代保護を維持する。終了前に保存されていない会話内容と実行中の処理は失われ得る。成功時は終了コード0、停止までの失敗と新serverの起動準備の失敗は1、復元候補または記録の復元失敗は `restore` と同じ2で終了し、失敗理由をstderrへ表示する。

## 読取系コマンドの応答時間

対象は、次の呼び出しとする。

- `pi-mux -h` と `pi-mux --help`
- `history` と `history --cwd <absolute-cwd>`（登録済みcwdと未登録cwdの両方）
- `current` と `current --client-pid <pid>`
- `list`

応答時間は、コマンドの起動から結果の受信完了までの時間とする。保存会話1500件・登録workspace 3件・稼働pane 3枚の状態では、1回の呼び出しの応答時間は、次のとおりとする。

| 条件 | 応答時間 |
| --- | --- |
| キャッシュ全体の作成・再構築を伴う呼び出し | 200ms以内を求めない |
| それ以外の呼び出し（会話ファイル1件の追加・更新・削除の後を含む） | 200ms以内に返す |

通常負荷で連続20回の呼び出しがすべて200ms以内であることを合格基準とする。OSの停止や外部プロセスの無応答時の絶対時間は保証しない。

## 会話IDの固定

対話TUIでは1つのpiプロセスが1つの会話IDを保持する。`/new`・`/resume`・`/fork`・`/clone`・`/import` など、会話IDを変更する操作は切替前に拒否し、理由を表示する。ショートカットと拡張APIからの同じ操作も拒否する。

会話IDを維持する `/tree`・`/compact`・`/reload` などは利用できる。pi本体のCLIによる会話選択・forkは pi標準の動作を維持する。

## 専用tmux

対象環境は、PATH上の pi と tmux 3.8である。Windows では、PATH上の `tmux` コマンドとして psmux(tmuxコマンド互換実装)を用いる。全pi実体を起動時から専用tmux内で実行する。接続クライアントの切断や起動元端末の終了後も、同じpi実体と進行中の処理が存続する。

| 項目 | 振る舞い |
| --- | --- |
| 管理先 | POSIX では `${XDG_RUNTIME_DIR:-/run/user/<uid>}/pi-tmux/server.sock` を、Windows では `~/.local/state/pi-tmux/server.sock` を使う。管理ディレクトリは所有者専用とする。Windows では `-S` のパスをサーバー識別に使い、socketファイルは作成・検査しない |
| 起動 | `new`・`open`・`restore` は専用serverがなければ起動して復元する |
| 存続 | クライアントや会話がなくなってもサーバーを存続させる |
| 設定 | 起動操作で専用設定を適用する。通常tmuxの設定を読み込まず、他のサーバーへ作用しない |
| マウス | mouseを有効にする。rootテーブルの `C-MouseDrag1Pane` だけを解除し、Ctrl+左ドラッグによるfloating pane作成を無効にする。その他のマウス操作は維持する |
| status・prefix | `status off`・`prefix None` とし、status barを非表示、prefixキーを無効にする |
| タイトル | `set-titles on`・`set-titles-string "#{pane_title}"` とし、paneタイトルを接続先端末へ転送する |
| 修飾キー | `extended-keys on`・`extended-keys-format csi-u` とし、拡張キーの報告形式をCSI-uにする。`extended-keys-format` が未対応の場合は、その設定だけを飛ばす |
| Shift+Enter | rootテーブルの `S-Enter` を、paneへCSI-uシーケンス `ESC [ 13 ; 2 u`（hex: `1b 5b 31 33 3b 32 75`）を送るbindにする。`S-Enter` キー名または `send-keys -H` が未対応の場合は、そのbindだけを飛ばす |

上記の未対応による例外以外で設定の適用に失敗した場合は、起動準備のエラーとして扱う。

新しいpi実体は、現在の呼び出し環境とtmux・CLIが必要とする生成値で起動する。過去の呼び出しにだけ存在した環境変数を持ち越さない。同時起動でも環境を混線させず、既に稼働しているpi実体の環境は変更しない。

## Windows での挙動差

Windows では、tmuxの代わりに PATH上の `tmux` コマンドとして psmux を用いる。この節に挙げる差異を除き、本書の各操作の振る舞いはプラットフォームで共通とする。

| 項目 | 振る舞い |
| --- | --- |
| shell実行 | tmux設定のhookとpaneコマンドなど、shell として解釈するコマンド文字列は Windows PowerShell の構文で実行する。pwsh または powershell が PATH上に必要である |
| 排他 | 操作の排他に使う接続先を名前付きパイプに切り替える。排他の待機・競合時の扱いは共通とする |
| サーバーとpaneの同一性 | サーバーの識別は `#{pid}` のPIDとserver世代で、piの識別は起動トークンで行い、POSIXと同じ手順で通知元を検証する |
| 起動中piの特定 | 起動中の管理piを `/proc` の環境変数とcwdで照会しない。paneの `@pi-mux-launch` の会話ID・PID・トークンの形式の一致だけで特定する |
| クライアント特定 | `--client-pid` はクライアントプロセスのPIDとの一致だけで特定する。親プロセス(PPid)との一致は使わない |
| 実行ファイル | pi・pi-muxは各々 Windows 上で `bun build --compile` した実行ファイルを用意する。クロスコンパイルは行わない |

## エラー

引数の不足・過剰、未知の操作、依存コマンドの欠落、保存会話の解決失敗、専用先の準備・pi起動・接続の失敗では、理由をstderrへ表示して非0で終了する。成功した接続後の終了はtmux標準の動作に従う。`restore` は全候補の処理を完了すると0、候補または記録の復元に失敗すると2で終了する。起動準備自体の失敗は1で終了する。
