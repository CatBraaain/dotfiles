# pi-mux の仕様

`pi-mux` は、固定した会話IDの pi を専用tmux内で起動・再接続し、その所属集合を保存・復元するCLIである。利用者と、実装・保守・評価を行う開発者に向け、起動後に観測できる振る舞いを定める。本書を最上位の正本とする。

会話は pi の会話IDで識別する。pi実体は、動作中の piプロセスとその実行PTYを指す。空新規は、動作中で、最初の user または assistantメッセージが保存されておらず、会話ファイルの実体がない新規会話を指す。

## 保存会話の探索範囲

`open`・`restore` の保存会話解決と `history` の列挙が対象にする保存先は、次の順で最初に得られたパスとする。空文字列の環境変数は未指定として次へ進む。パスの先頭の `~` はホームディレクトリへ展開し、相対パスは呼び出し時のcwdを基準に絶対パスへ解決する。

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
| `pi-mux new [--detached] [initial-request]` | 初期依頼の有無で会話を選び、通常はTUIへ接続する。`--detached` では会話IDと接続コマンドを返す |
| `pi-mux open [--temporary] <session-id>` | 完全一致する会話IDのpi実体へ接続する。稼働していなければ、保存会話を元のcwdで再開する。`--temporary` は一時再開を指定する |
| `pi-mux state <session-id> <state> --source <JSON> --title <JSON>` | 通知元を照合して実行フェーズとタイトルを公開する。`running` は一時再開を通常へ昇格させる |
| `pi-mux state <session-id> --clear --source <JSON>` | 通知元が公開した実行フェーズとタイトルを除去する |
| `pi-mux close <session-id>` | 完全一致する会話IDのpiを非対話で終了し、その会話を復元対象から除く。保存会話・workspace登録・session所属を保持する |
| `pi-mux close --if-temporary <session-id>` | 一時再開中のpiだけを `close` と同じ手順で終了し、復元対象から除く。通常状態のpiと稼働対象がないIDは、変更せず成功する |
| `pi-mux list` | 登録済みworkspaceを、空workspaceも含めたJSON配列で返す。専用tmuxの稼働piがあるworkspaceを自動登録する |
| `pi-mux switch <session-id> [--client-pid <pid>]` | 接続クライアントが表示するtmuxセッションを、会話IDのpi実体のtmuxセッションへ切り替える |
| `pi-mux current [--client-pid <pid>]` | 接続クライアントが表示中のpi実体のmetadataをJSONで返す |
| `pi-mux history [--cwd <absolute-cwd>]` | 登録済みworkspaceの保存会話をJSON配列で列挙する |
| `pi-mux workspace register <cwd>` | piを起動せずworkspaceを登録する |
| `pi-mux workspace unregister <cwd>` | 対象workspaceの稼働piを終了し、登録と復元対象を除く。保存会話ファイルは保持する |
| `pi-mux snapshot [server-generation]` | 稼働中の専用serverから通常の管理会話を採取して保存する。serverを起動せず、指定世代と異なるserverの記録は変更しない |
| `pi-mux restore` | 専用serverを起動し、保存された会話集合を非接続で開く |

`open` は対話TUIへ接続する。新しい会話IDは `new` の起動時にCLIが採番する。

シェルの `a` は `pi-mux` を呼ぶ。`pi` コマンド自体と、ほかのaliasは維持する。

### ヘルプ

トップレベルの引数が `-h` または `--help` の1個だけの場合、利用書式と「操作」表の各操作の呼び出し書式をstdoutへ表示し、終了コード0で終了する。出力は `Usage` などのラベルとコマンド構文からなる簡潔な一覧とする。

ヘルプ表示では、設定の読み込み・検証、依存コマンドの確認、tmux操作、状態の作成・変更を行わない。

`new -h`・`new --help`・`new --detached --help` では、help引数を初期依頼として扱う。

### new

`initial-request` は、シェルで引用した1引数として受け取る。空文字列・空白のみ・NULを拒否し、空白・引用符・改行・先頭の `-` を保持する。

| 引数 | 解釈 |
| --- | --- |
| `new --detached` | 初期依頼なしで非接続起動する |
| `new --detached 'fix the build'` | 初期依頼ありで非接続起動する |
| `new 'fix the build'` | 初期依頼ありで起動し、TUIへ接続する |
| `new '--option-like request'` | 先頭の `-` を依頼の一部として渡す |
| `new --`、`new --detached --` | `--` 自体を初期依頼として渡す |
| `new -- request`、`new first second` | 複数の末尾引数としてエラーにする |
| `new --detached --detached` | 先頭を非接続指定、末尾を初期依頼文字列 `--detached` として扱う |

`new` の直後にある先頭1個の `--detached` だけを非接続指定として消費する。その後の1引数は、その内容が `--detached` でも初期依頼としてそのまま渡す。区切りの `--` は使わない。ほかの単一の先頭 `-` 引数も依頼として扱う。`@file` を含め、pi CLIへ渡した後の処理は標準pi CLIに従う。

| 初期依頼 | 状態 | 選ぶ会話 |
| --- | --- | --- |
| なし | 呼び出し時と同じcwdで、依頼なしの `new` で作った空新規が稼働中 | 元のcwd・会話ID・piプロセス・PTYを維持する |
| なし | 呼び出し時と同じcwdの空新規がない | 呼び出し時のcwdで新しい会話を起動する。別cwdの会話は維持し、入力前に会話ファイルを作らない |
| なし | 最初の user または assistantメッセージで会話ファイルが作成済み | その会話を再利用せず、呼び出し時のcwdに一致する空新規を選ぶか作成する |
| なし | 同じcwdで同時に複数の `new` | 空新規の起動を重複させず、同じ空新規を選ぶ |
| なし | 異なるcwdで同時に複数の `new` | cwdごとに別の空新規を選ぶか作成する |
| あり | 空新規の有無によらず | 呼び出し時のcwdで常に独立した会話IDとtmux sessionを作る。その会話は、保存前も空新規の再利用対象にしない |

会話の選択は `--detached` の有無によらない。指定がなければ選んだ会話のTUIへ接続し、指定があればTUIへ接続せず会話IDとその会話への接続コマンドを返す。新しいsessionの最初のwindow名はCLIが `pi` とする。

保存済みになった会話は、`open` で同じpi実体へ戻れる。起動済みの旧形式tmux session `pi-empty` も、呼び出し時と同じcwdの空新規なら再利用する。

初期依頼ありの起動では、新しいpi は標準mainとして起動する。会話ID・piプロセス・paneを確認した作成受付で接続または結果返却へ進み、全拡張の初期化完了や初期依頼の完了は待たない。

初期依頼はpi CLIへそのまま1回だけ渡す。`@file` のテキスト・画像・空ファイル・不正パスの扱い、slash command・skill入力の展開、`input.source` は標準pi CLIに従う。内部の起動通知を初期依頼・通常input・保存履歴へ混ぜない。

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

一時再開の起動と復元候補の除去、通常openによる昇格と復元記録更新は、snapshot・restore・new・open・close・state・workspace解除と排他する。更新途中の失敗はIDと理由を報告して非0で終了し、既に起動しているpiを停止しない。再度の同じopenで記録更新を修復でき、復元保証は最後に保存完了した集合に従う。

### state

会話IDは `open` と同じ完全一致形式で指定する。`<state>` は `running`・`waiting-approval`・`waiting-user` のいずれかとする。`--source` と `--title` はそれぞれ1個のJSON引数で、順序は入れ替えられる。`--title` は文字列または `null` を受け付け、引用符・改行・tmux formatに見える文字列も文字通りの値として公開する。`--clear` にはstateとtitleを指定しない。引数の不足・過剰・重複、不正JSON、不正な型は、変更せずエラーにする。

sourceは通知元が捕捉した次の情報を持つJSON objectとする。会話IDだけから対象を選ばない。

| 項目 | 型・値 |
| --- | --- |
| `socket` | 専用socketの絶対パスの文字列 |
| `serverPid` | 専用serverのPIDを表す正の整数 |
| `serverStartTime` | Linuxの専用serverプロセスの開始時刻（process start time）を表す10進文字列 |
| `pane` | 通知元のpane IDの文字列 |
| `pid` | 通知元piのPIDを表す正の整数 |
| `started` | Linuxの通知元piプロセスの開始時刻（process start time）を表す10進文字列 |

通知元serverの生存期間は `serverPid` と `serverStartTime` の組で識別する。CLI初期化の有無によらず照合し、「snapshotと復元」のCLI発行 `server-generation` は通知元の必須条件にしない。

sourceの全項目、会話ID、現在のpaneのpi実体を、稼働中の専用serverと照合してから変更する。PIDの再利用、pane IDの再利用、serverの再起動は同じ通知元と見なさない。未知・停止済み・複数実体・対応不一致の通知は、公開値・一時状態・復元記録を変更せずエラーにする。server起動・初期化・復元・pi起動・接続・workspace登録は行わず、所属JSONの有無・内容・I/Oの成否に依存しない。

| 通知・状態 | 結果 |
| --- | --- |
| 一時再開中に `waiting-user`・`waiting-approval`、またはその状態のタイトル変更 | stateとtitleを公開し、一時状態を維持する |
| 一時再開中に `running` | stateとtitleを公開し、既存piを再起動せず通常状態へ昇格させ、その操作で復元記録を更新する |
| 通常状態に任意の有効なstate | stateとtitleを公開し、通常状態を維持する |
| 昇格通知を再送 | 重複起動せず、通常状態と復元記録を修復する。同値の公開済みstateだけを理由に記録更新を省略しない |
| `--clear` | 同じ通知元が公開した値だけを除去する。新しいpi実体の値を保持し、一時状態・所属・復元候補を維持する |

昇格の基準は `running` 通知であり、userメッセージの保存ではない。拡張や自動処理による実行開始も同じ条件で扱う。

状態公開・昇格・復元記録更新は、他の変更操作と同じ排他の中で処理する。`state` はロック取得を待たず、競合時は変更せず、stderrへ理由を表示して終了コード75で終了する。これにより起動・復元が保持するロックを状態通知が待ち続けない。

成功時はstdout・stderrへ出力せず終了コード0とする。競合以外の失敗はIDと理由をstderrへ表示して終了コード1とする。公開・昇格・記録更新の途中失敗では一部が反映済みの場合があり、piの動作は継続する。同じ通知の再送で未完了の更新を修復できる。保存済みの復元記録が不正な場合は上書きせず、復元保証は最後に保存完了した集合までとする。

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

公開値は所属と復元候補とは別に扱う。pane終了でpane-localの値も消滅する。

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
| 最後のpiを停止 | 専用serverとworkspace登録を維持する。ほかに復元対象がなければ復元記録の `workspaces` は空配列になる |

`close --if-temporary <session-id>` は、`--if-temporary` を `close` の直後に1回だけ指定する。条件付き停止は `close` と同じ排他の中で対象の一時状態を判定してから扱う。起動途中の管理piは、一時再開として起動したものであれば一時状態として扱う。

| 対象の状態 | 結果 |
| --- | --- |
| 同じ会話IDのpiが一時再開中 | `close` と同じ手順で終了と復元候補の除去を行う |
| 同じ会話IDのpiが通常状態 | 停止も復元候補の除去も行わず、終了コード0で終了する |
| 有効な形式のIDで稼働対象がない | serverを起動せず、停止も記録更新も行わず、終了コード0で終了する |
| 同じIDの稼働実体・管理sessionが複数、または起動途中の対象を安全に特定できない | `close` と同じく停止や記録更新を行わずエラーにする |

成功時はstdout・stderrへ出力せず終了コード0、失敗時はstderrへ理由を表示して終了コード1で終了する。保存完了済みの会話ファイル・workspace登録・session所属・他のpiとpaneを保持する。シェル配下のpiを停止するときはシェルを保持する。対象のpiだけを占有するpaneは終了し、空になったtmux sessionは消滅する。

停止成功後のsnapshot・restoreでは、停止したIDを復元対象へ戻さない。同じIDを通常openで再び起動した場合は通常の復元対象になる。停止処理はsnapshot・restore・new・open・state・workspace解除と排他し、他会話の復元候補とserver世代の保護を維持する。

### workspace登録

フロントエンドがpiの起動前にもworkspaceの登録状態を判定し、空workspaceへ新規会話を事前ロードできるようにする。登録の正本は `${PI_CODING_AGENT_DIR:-~/.pi/agent}/session-state.json` の `active-workspaces` mapとし、共有storeの形式・所属の意味は [session-stateの要件](../../../.pi/agent/extensions.exact/session-state/REQUIREMENTS.md) に従う。復元記録には登録を複製しない。

`<cwd>` は呼び出し時のcwdから絶対パスへ解決する。registerは存在するディレクトリを受け付け、unregisterは消失済みのディレクトリも受け付ける。同じ絶対パスは1登録とする。

| 状態・操作 | 結果 |
| --- | --- |
| 未登録workspaceをregister | 空の `active-sessions` mapを持つworkspaceを追加する。piとtmux serverを起動しない |
| 登録済みworkspaceをregister | 既存の所属と属性を保持する |
| `new`・`open` の起動・再接続成功 | そのcwdを登録する |
| 専用tmux内で外部から起動したpi | paneを直接占有するpiと、paneのシェル配下のpiを、拡張が公開したmetadataから `list` が検出し、そのcwdを登録する。専用tmux外のpiは取り込まない |
| workspaceをunregister | 全windowを対象に、そのcwdの稼働piと起動途中の管理piを終了する。終了を確認してからworkspace登録と同じcwdの復元候補を除く。他workspaceと保存会話ファイルを保持する |
| 未登録workspaceをunregister | 稼働pi・復元候補があれば同じ終了・除去を行い、なければ成功する |
| 起動途中の管理piのpaneを安全に特定できない | 他paneを終了せず、workspace登録と復元候補を保持して非0で終了する |
| 不正な共有store・復元記録、または終了の失敗 | 理由を報告して非0で終了し、workspace登録を保持する。既に終了したpiは再起動しない |

共有store更新では他workspace、既存session所属、属性を保持する。不正なstoreは上書きしない。通常のpi終了後もworkspace登録は保持する。解除後の新しい起動は再び登録対象になる。

### list

`list` は共有storeの登録済みcwdと専用tmuxの稼働piを統合し、stdoutへ `[{"cwd":"/path/to/workspace","sessions":[{"id":"session-id","file":"/path/to/session.jsonl","state":null,"title":null}],"empty":[{"id":"empty-session-id","file":"/path/to/session.jsonl"}]}]` 形式のJSON配列と末尾改行を返す。workspaceの `cwd` は絶対パス、`sessions` は会話ファイルが存在する稼働piだけの配列であり、該当がなければ空配列になる。共有storeの保存所属や復元候補を稼働piとして代用しない。PID・tmux targetは内部検証に使う。

各sessionは次の4項目を持ち、一時再開中だけ `temporary: true` を追加する。通常状態では `temporary` 属性を省略する。一時再開中も `sessions` に掲載し、`id`・`file`・`state`・`title` の意味は維持する。

空新規（会話ファイルが未作成の稼働pi）は `sessions` に入れず、workspaceオブジェクトの `empty` 配列に置く。存在判定はmetadataの `file` パスに対する存在チェックによる。`empty` の各要素は `id` と `file` の2項目を持ち、`state`・`title` は持たない。`temporary` の付与は `sessions` と同じで、一時再開中だけ `temporary: true` を追加する。`empty` も該当がなければ空配列になる。

| 項目 | 型 | 値 |
| --- | --- | --- |
| `id` | `string` | 会話ID |
| `file` | `string` | 会話ファイルの絶対パス。未作成の保存予定先も含む |
| `state` | `string \| null` | `running`・`waiting-approval`・`waiting-user` のいずれか。確認できない場合は `null` |
| `title` | `string \| null` | pi が保存したセッション名の共有値。公開値がなく、保存済みセッション名も確認できない場合は `null` |

stateとtitleは、同じpane option `@pi_session_state` のJSONから取得する。titleは公開値を優先し、公開値がなければ会話ファイルから解決した保存済みセッション名を使う。公開形式と更新契約は「state」の「pane optionの公開契約」に従う。接続・セッションのアクティブ化・保存会話の再読み込みを行わず、タイトル公開後の `list` に反映する。

| 条件 | `state` | `title` |
| --- | --- | --- |
| optionが未公開、不正JSON、`version` が1でない、または `sessionId` が一覧の会話IDと一致しない | `null` | 保存済みセッション名 |
| `version` と `sessionId` が有効 | 上記3値のいずれかなら採用し、それ以外は `null` | 文字列ならそのまま採用し、`null`・欠落・その他の型は保存済みセッション名 |

共通のversion・会話ID検証後はstateとtitleを独立して検証する。titleを持たない旧形式やtitleの型が不正な値でも、有効なstateは保持する。stateが不正でも有効なtitleは保持する。いずれの値が `null` でも、pi自体は一覧に残す。

titleの保存済みセッション名は、会話ファイル内で最後の `session_info` エントリの `name` とする。エントリはファイル末尾から逆順に走査して最初に見つけたものを使い、`name` が空白のみを含む文字列・空文字列・`undefined` のエントリはセッション名の明示的なクリアとして扱い、さらに前のエントリへは辿らない。pi本体がセッション名の共有値として返す規則と同じである。会話ファイルが未作成・読み取れない場合や該当エントリがない場合は、titleを `null` にする。

metadataは会話ID・絶対パスのcwdとfileを検証する。paneを直接占有するpiは、公開したpi PIDとpane PIDの一致を検証する。シェル配下のpiは、公開したpane PIDの一致とpi PIDがその子孫であることを検証し、終了済みpiを一覧から除く。終了済みpaneとmetadata未公開のpaneは含めない。不正metadataはエラーとする。startupを持たないmetadataと、startupが `accepted` または `ready` のmetadataを受け付ける。一覧への掲載は復元成功を示さず、復元では `ready` を必須とする。

| 状態 | 結果 |
| --- | --- |
| 専用serverが未起動、または稼働piがない | 登録済みworkspaceを空の `sessions`・`empty` とともに返す。登録もなければ終了コード0で `[]` を返す |
| tmuxからの取得に失敗 | 理由をstderrへ表示し、非0で終了する |

`list` は未登録の稼働cwdがある場合だけworkspace登録を書き込む。workspace登録と「再取得とキャッシュ」で定めるタイトルキャッシュ以外のディレクトリ作成・JSON書込みを行わない。server起動・復元は行わず、復元記録は参照しない。

### switch

`switch <session-id> [--client-pid <pid>]` は、専用tmuxに接続中のクライアントが表示するtmuxセッションを、その会話IDのpi実体が属するtmuxセッションへ切り替える。会話IDは `open` と同じ形式の完全一致で指定する。serverの起動・復元、piの起動、workspace登録は行わない。

切替先は、全生存paneのmetadataから会話IDと一致するpi実体を探し、そのtmuxセッション名で解決する。同じ会話IDの実体が複数ある、または未知のIDのときは切替せずエラーにする。

クライアントの特定は次のとおり行う。

| 条件 | 結果 |
| --- | --- |
| `--client-pid <pid>` 指定時 | 接続中クライアントのうち、クライアントプロセスのPIDが `pid` と一致するか、`/proc/<クライアントPID>/status` のPPidが `pid` と一致するものを1つ使う。該当がない・複数あるときは切替せずエラーにする |
| `--client-pid` 省略時 | 接続中クライアントがちょうど1つのときそれを使う。0個または2個以上のときは切替せずエラーにする |

切替は `switch-client -c <クライアント> -t =<tmuxセッション名>` としてセッション名の厳密一致で行う。成功時はstdout・stderrへ出力せず終了コード0で終了する。失敗時は理由をstderrへ表示して非0で終了する。クライアントがattachし切っていない場合のリトライは呼び出し側の責務である。

### current

`current [--client-pid <pid>]` は、クライアントが表示中のtmuxセッションに属するpi実体のmetadataを読み、stdoutへ `{"id":"session-id","cwd":"/path/to/workspace","file":"/path/to/session.jsonl","target":"tmux-session-name"}` 形式のJSONオブジェクト1件と末尾改行を返す。`target` はtmuxセッション名、`id`・`cwd`・`file` はmetadataの値とする。クライアントの特定は `switch` と同じ `--client-pid` の照合と省略時の唯一クライアント判定を使う。

| 状態 | 結果 |
| --- | --- |
| 表示中のtmuxセッションにmetadataを持つpaneが1つある | metadataの `id`・`cwd`・`file` とセッション名をJSONで返し、終了コード0で終了する |
| クライアントがpi以外のpaneを表示している、または該当するpaneが特定できない | 何も出力せず理由をstderrへ表示し、非0で終了する |

serverの起動・復元、piの起動・接続、workspace登録は行わない。

### history

`history [--cwd <absolute-cwd>]` は、共有store `active-workspaces` に登録されたcwdごとの保存会話を列挙し、stdoutへ `[{"id":"session-id","cwd":"/path/to/workspace","file":"/path/to/session.jsonl","title":"name","btime":1735689600000,"mtime":1735693200000,"size":1024}]` 形式のJSON配列と末尾改行を返す。`--cwd` に絶対パスを指定したときはそのcwdのみを対象にし、登録されていないcwdなら `[]` を返す。

「保存会話の探索範囲」のうち、対象cwdに対応するグループの通常側とarchive側を列挙する。保存先が環境変数・settings のときは、保存先直下の `*.jsonl` のうちヘッダーのcwdが対象cwdに一致する会話を列挙する。同じ会話IDが通常側とarchive側にある場合は通常側を返し、そのIDのarchive側を結果から除く。

各要素は次の7項目を持つ。

| 項目 | 型 | 値 |
| --- | --- | --- |
| `id` | `string` | 会話ファイル先頭行（ヘッダー）の会話ID |
| `cwd` | `string` | ヘッダーのcwd。グループディレクトリ名より優先する |
| `file` | `string` | 会話ファイルの絶対パス |
| `title` | `string \| null` | `list` と同じ規約で解決した保存済みセッション名。`session_info` エントリがなければ `null` |
| `btime` | `number` | ヘッダーの `timestamp` をミリ秒へ解釈した値。セッション開始日時 |
| `mtime` | `number \| null` | 会話ファイル内で物理的に最後に現れる、`timestamp` をミリ秒へ解釈できる有効な `message` または `compaction` エントリの `timestamp`。会話の最新活動時刻。該当するエントリがなければ `null` |
| `size` | `number` | 会話ファイルのサイズ（バイト） |

並びは `mtime` の降順とする。`mtime` が `null` の要素は有効な `mtime` を持つ要素の後方に並べ、`mtime` が等しい要素は `file` の昇順とする。ヘッダーが読めない・不正なファイル、および `timestamp` をミリ秒へ解釈できないヘッダーのファイルは結果から除く。archived（負論理）の判定は行わず、対象cwdの保存会話全件を返す。共有storeと会話ファイルへの書込み、serverの起動、piの起動は行わない。

#### 再取得とキャッシュ

`history` のセッション名と最新活動時刻の取得と、`list` で公開titleがない場合の保存済みセッション名の取得は、同じファイル単位のキャッシュを呼び出し間で共有する。どちらで取得した結果も、もう一方で再利用できる。公開titleの優先順位と「list」で定める保存済みセッション名の解決規約は維持する。

キャッシュは会話ファイルと共有storeから独立した再生成可能なものとし、CLIが管理する。利用者による作成・更新・削除を前提にしない。キャッシュの有無によらず、一覧の各項目と並び順は原本から取得した結果と同じにする。

| 条件 | 結果 |
| --- | --- |
| 会話ファイルに変更がなく、有効なキャッシュがある | 会話ファイル本文を読み直さず、保存済みのセッション名・mtime（最新活動時刻）の解決結果を再利用する |
| 会話ファイルを追加・追記・上書き・切り詰めた | 次の `history` と、保存済みセッション名を取得する次の `list` に現在の内容を反映する。変更したファイルのセッション名と mtime は原本から解決する |
| 会話ファイルを改名・削除した | 次の `history` に現在のファイル構成を反映する |
| キャッシュがない・破損している・未対応の形式である | 原本から結果を取得する |
| キャッシュの保存に失敗した | 原本から取得した結果を返す。キャッシュ保存の失敗だけを理由に取得を失敗させない |

`history` で保存会話129件・合計約1.43GBを対象とする性能の受入基準は、次のとおりとする。

| 条件 | 応答時間 |
| --- | --- |
| キャッシュなしの初回取得 | 同じ環境・同じ保存会話を全文読み込みでタイトル解決する場合より短時間で返す |
| 有効なキャッシュがあり、原本に変更がない再取得 | 1秒以内に返す |

### snapshotと復元

復元記録は `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-tmux/pi-mux-restore.json` に、次のJSON形式で保存する。ワークスペースは起動cwdの絶対パスでまとめ、`sessions` は復元対象として保持する会話IDの文字列配列とする。

```json
{
  "version": 1,
  "generation": "server-generation",
  "workspaces": [
    {
      "cwd": "/path/to/workspace",
      "sessions": ["session-id", "retry-session-id"]
    }
  ]
}
```

| 項目 | 値 |
| --- | --- |
| `version` | `1` |
| `generation` | 保存対象のserver世代を表す文字列 |
| `workspaces` | cwdごとのワークスペース配列。復元対象がない場合は空配列 |
| `cwd` | ワークスペースの起動cwdの絶対パス |
| `sessions` | そのcwdで通常の復元対象として保持する会話IDの配列。稼働中・復元途中・復元失敗・初期化未完了の会話を含み、起動や復元成功だけでは除外しない |

同じcwdは1つのワークスペースにまとめる。同じ会話IDに異なるcwdが指定された記録はエラーとする。

`server-generation` は、専用serverの1回の生存期間を識別するCLI発行の内部IDである。CLIが専用serverを初期化するときに発行し、同じserverの生存中は同値、再起動後は別の値にする。sessionの作成・終了hookは発火元の世代を `snapshot` の引数へ渡す。CLIは現世代と照合し、旧世代の遅延処理による新世代の記録変更を防ぐ。通常の `snapshot` で引数を省略した場合は、現世代を対象とする。

管理会話は、tmux session環境の `PI_TMUX_SESSION_ID` と、そのsessionの起動cwdで識別する。これらはpi起動前から設定する。snapshotはpaneに起動後公開されるmetadataを待たず、通常状態の管理会話を採取し、復元途中・復元失敗・初期化未完了の候補と合わせて `sessions` に保持する。一時状態はpi起動前から判別可能とし、初回と後続のsnapshotのどちらでも一時再開中のIDを除外する。過去の候補との統合でも、そのIDを復元対象へ戻さない。sessionの作成・終了hookでsnapshotを実行する。

| 状態・操作 | 結果 |
| --- | --- |
| 正常稼働中にsessionを作成・終了 | 新しい管理会話を `sessions` に加え、通常終了した会話を除く。最後の復元対象がなくなると `workspaces` は空配列になる |
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
| snapshot・restore・new・open・close・stateの同時実行、または復元処理の異常終了 | 復元途中の部分集合で候補を消さず、重複起動を防ぐ。異常終了した実行者の排他は後続処理を妨げない |

復元は保存会話を開いた入力待ち状態にする。初期入力・LLM再送信・tool再実行・自動続行は行わない。window/paneの配置は復元しない。復元保証の基準は最後に保存完了した集合であり、保存完了前の書込みと未保存の会話内容は保証しない。

## 会話IDの固定

対話TUIでは1つのpiプロセスが1つの会話IDを保持する。`/new`・`/resume`・`/fork`・`/clone`・`/import` など、会話IDを変更する操作は切替前に拒否し、理由を表示する。ショートカットと拡張APIからの同じ操作も拒否する。

会話IDを維持する `/tree`・`/compact`・`/reload` などは利用できる。pi本体のCLIによる会話選択・forkは pi標準の動作を維持する。

## 専用tmux

対象環境は Linux、PATH上の pi と tmux 3.8である。全pi実体を起動時から専用tmux内で実行する。接続クライアントの切断や起動元端末の終了後も、同じpi実体と進行中の処理が存続する。

| 項目 | 振る舞い |
| --- | --- |
| 管理先 | `${XDG_RUNTIME_DIR:-/run/user/<uid>}/pi-tmux/server.sock` を使う。管理ディレクトリは所有者専用とする |
| 起動 | `new`・`open`・`restore` は専用serverがなければ起動して復元する |
| 存続 | クライアントや会話がなくなってもサーバーを存続させる |
| 設定 | 起動操作で専用設定を適用する。通常tmuxの設定を読み込まず、他のサーバーへ作用しない |
| マウス | mouseを有効にする。rootテーブルの `C-MouseDrag1Pane`・`C-MouseDrag1Empty` だけを解除し、Ctrl+左ドラッグによるfloating pane作成を無効にする。その他のマウス操作は維持する |
| status・prefix | `status off`・`prefix None` とし、status barを非表示、prefixキーを無効にする |
| タイトル | `set-titles on`・`set-titles-string "#{pane_title}"` とし、paneタイトルを接続先端末へ転送する |
| 修飾キー | `extended-keys on`・`extended-keys-format csi-u` とし、拡張キーの報告形式をCSI-uにする。`extended-keys-format` が未対応の場合は、その設定だけを飛ばす |
| Shift+Enter | rootテーブルの `S-Enter` を、paneへCSI-uシーケンス `ESC [ 13 ; 2 u`（hex: `1b 5b 31 33 3b 32 75`）を送るbindにする。`S-Enter` キー名または `send-keys -H` が未対応の場合は、そのbindだけを飛ばす |

上記の未対応による例外以外で設定の適用に失敗した場合は、起動準備のエラーとして扱う。

新しいpi実体は、現在の呼び出し環境とtmux・CLIが必要とする生成値で起動する。過去の呼び出しにだけ存在した環境変数を持ち越さない。同時起動でも環境を混線させず、既に稼働しているpi実体の環境は変更しない。

## 起動通知

起動通知に使うBashは、呼出元のミリ秒単位のtimeout指定を秒単位へ変換し、指定時間を維持する。呼出元がtimeoutを省略した場合は1秒を使う。背景要求全体の期限と実行境界は [Tools仕様の背景Bash入口](../../../.pi/agent/extensions.exact/tools/SPEC.md#背景bash入口) に従う。

## エラー

引数の不足・過剰、未知の操作、依存コマンドの欠落、保存会話の解決失敗、専用先の準備・pi起動・接続の失敗では、理由をstderrへ表示して非0で終了する。成功した接続後の終了はtmux標準の動作に従う。`restore` は全候補の処理を完了すると0、候補または記録の復元に失敗すると2で終了する。起動準備自体の失敗は1で終了する。
