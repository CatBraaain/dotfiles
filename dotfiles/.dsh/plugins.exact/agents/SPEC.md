# dotfiles-dsh-agents Spec

## 概要

セッションは **agent** を実行する。agent は利用できるツール、依頼できる子 agent、システムプロンプトを持ち、モデル候補の順序（class）の既定値を持つ実行主体である。本 plugin は host 側と client 側（browser bundle）で構成し、host 側は agent 定義の管理と選択、class によるモデルルーティング、レート制限（429）時のフォールバック、`subagent` ツール、画像読み取りの `vision` 委譲を提供する。client 側は現在の agent と実効 class の選択ボタン表示（メニューによる切替を含む）を提供する。subagent の待機表示など残りの client UI は対象外とする（「対象外」節）。

## 設定

設定ファイル: `~/.dsh/config/agents.yaml`（リポジトリ内は `dotfiles/.dsh/config/agents.yaml`）。スキーマは次のとおり。未知のキーは無視する（既存ファイルに含まれる `tiers`・`tier`・`_systemPrompts`・`_when` も未知キーとして無視する）。

```yaml
default: main

classes:
  high:
    - provider: <route 名>
      model: <model>
      # 終了コード 0 のときだけ有効になる候補の例
      when: "<bash command>"
    - provider: <route 名>
      model: <model>
  vision:
    # 画像入力をサポートするモデルだけを置く
    - provider: <route 名>
      model: <model>

agents:
  main:
    class: high
    tools: ["*"]
    subagents: [senior, junior, vision]
    systemPrompt: ["...", "..."]
```

| 項目・操作                | 内容と振る舞い                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 設定ファイル              | plugin 起動時に読み込み、検証する。`/reload` コマンドで再読込できる（「モデルの適用タイミング」の表）                                                                                                                                                                                                                              |
| `default`                 | 新規セッションで開始する agent                                                                                                                                                                                                                                                                                                     |
| `agents.<name>`           | agent の定義                                                                                                                                                                                                                                                                                                                       |
| `classes.<name>`          | class のモデル候補の配列。配列の先頭からフォールバック順序として評価する                                                                                                                                                                                                                                                           |
| 候補の `provider`/`model` | 候補のモデル。`provider` は dsh に登録された LLM route の名前と一致しなければならない                                                                                                                                                                                                                                              |
| 候補の `when`             | bash コマンド。終了コード `0` のときだけ候補が有効になる。省略・空文字なら常に有効。5 秒でタイムアウトし、タイムアウト・失敗・shell 契約の不在は無効と扱う                                                                                                                                                                       |
| `class`                   | agent の既定 class。必須                                                                                                                                                                                                                                                                                                           |
| `tools`                   | ツールの allowlist（未列挙のツールは既定で拒否）。列挙したツールだけが実行でき、`[]` はツールなしを許可する。`"*"` はすべてのツールを許可し、`"!<tool-name>"` はそのツールを除外する（`["*", "!<tool-name>"]` は有効）。`"*"` を含まないリストでは否定は allow マスクに吸収される。グローバル tool レジストリに存在しない名前は warning 付きで除外し、allow 指定の全要素が未知だった場合はツールなしになり warning する                                                                            |
| `subagents`               | `subagent` ツールでの起動を許可する子 agent の一覧。定義済み agent のみ指定できる                                                                                                                                                                                                                                                  |
| `systemPrompt`            | 配列要素を記載順で結合して、agent 固有のシステムプロンプト（persona section）として追記する。YAML のアンカーとエイリアスで複数 agent 間で要素を共有できる                                                                                                                                                                          |
| `/agent <name> [message]` | 指定した agent を即時に有効にする。実効 class は切替先 agent の既定 class に戻り、手動モデル選択は解除され、ツール制限・persona・`subagent` ツールの可視性が付け替わる。`message` を続けた場合は切替完了後にそのテキスト（前後の空白を除く）をユーザーメッセージとして送信する。未定義の `name` はエラー応答し、何も変更しない         |
| `/class [name]`           | 実効 class を `name` に切り替え、手動モデル選択を解除する。cooldown は維持する。未定義の `name` はエラー応答し、何も変更しない。`name` を省略した場合は利用可能 class と現在値を応答する（メニューからの選択は「Agent 表示」節）                                                                                                                   |
| `--agent <name>` フラグ   | 初期 agent を指定する。未定義の値は warning で無視する（`default` になる）                                                                                                                                                                                                                                                         |
| `--class <name>` フラグ   | 初期 class を指定する。`--agent` と独立であり併用できる。未定義の値は warning で無視する                                                                                                                                                                                                                                           |

`--agent` / `--class` は dsh launcher が解釈しない引数として plugin に渡されることを前提とする。この経路が dsh 本家のパーサで拒否される場合は初期 agent・初期 class は指定できない。

本 plugin の管理下にない agent に対する `/agent`・`/class` は、その旨のエラー応答になり、何も変更しない。

## 設定の検証

plugin 起動時に設定ファイルを検証する。次のいずれかに該当する場合はエラーを host log に出力し、本 plugin のすべての機能（コマンド、`subagent` ツール、ツール制限、モデルルーティング、画像委譲）を登録しない。不正な設定を一部分だけ適用することはしない。

- 設定ファイルがない・読めない・YAML として不正
- `default`・`agents`・`classes` がない、型が違う
- `agents` の各定義がオブジェクトでない
- agent の `class` がない・文字列でない、`classes` に存在しない class を参照している
- class の値が配列でない、候補がオブジェクトでない
- 候補の `provider` か `model` がない・文字列でない、`when` が文字列でない
- `tools`・`subagents`・`systemPrompt` が配列でない、要素が文字列でない
- `tools` の否定指定が `!` だけ、または `"*"` 以外の同じツール名を許可と否定の両方で指定する
- `vision` agent がない、または `vision` agent の `class` が `vision` でない
- main または senior の `subagents` が `vision` を含まない
- junior の `subagents` が `vision` を含む
- `default` が未定義の agent を指している
- `subagents` が未定義の agent を含む

無効化後も画像の自動委譲は行われず、画像の処理は dsh 本来の挙動に委ねられる。

## class によるモデル選択

class はデフォルトフォールバックの候補順序であり、モデルの種類による制限はしない。class の候補配列を先頭から順に評価し、最初に成立した候補を選ぶ。

モデル候補の選択に使う class（実効 class）は、`/class` で切り替えた class を優先し、切り替えていないときは agent の `class` を既定値とする。実効 class は agent の選択とは独立である。

セッション開始では、`--class` フラグで有効な class が指定されていれば実効 class はその class になり、指定がなければ初期 agent の既定 class になる。これを初期 class と呼ぶ。

| 候補の状態                                         | 扱い         |
| -------------------------------------------------- | ------------ |
| `provider`・`model` が dsh の route として解決不能 | 除外して次へ |
| cooldown 待機中（後述）                            | 除外して次へ |
| `when` が終了コード `0` を返さない                 | 除外して次へ |
| 上記いずれにも該当しない                           | その候補を選ぶ |

class をまたいだ降格は行わない。

本 plugin が次候補へ降格するのは rate limit 系の失敗のみ（「レート制限（429）時のフォールバック」節）で、認証エラーなどそれ以外のリクエスト失敗は dsh 本来のエラー経路に委ねられ、次候補へ進まない。

## モデルの適用タイミング

dsh ではモデルリクエストごとに `agent/request` 経由で route が確定する。本 plugin はこのタイミングで実効 class の候補を再評価する。

| タイミング                   | 動作                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| セッション開始               | 初期 agent（`--agent` フラグで指定された定義済み agent、指定なしまたは未定義なら `default`）と初期 class を適用する。dsh で agent が作られるごとに働く |
| `/agent <name>`              | agent を切り替え、手動選択を解除し、実効 class を切替先 agent の既定 class に戻す。以後のリクエストから新しい候補評価が働く                        |
| `/class [name]`              | 実効 class を切り替え、手動選択を解除する                                                                                                         |
| `/reload`                    | 設定を読み込み直す。手動選択状態・実効 class・cooldown は維持する。読み込んだ設定に現在の agent または class が存在しない場合は、agent は初期 agent へ、class はその agent の既定 class へ戻す。読み込み・検証に失敗した場合は現在の設定を維持する                                    |
| 各モデルリクエスト時（自動） | 実効 class の候補を再評価し、解決済み route と異なる候補が成立したら切り替える                                                                    |
| 429 受信時                   | 「レート制限（429）時のフォールバック」に従う                                                                                                     |

セッションの再開では agent が作り直されるため、新しい状態で始める。手動状態と cooldown は引き継がず、実効 class は初期 class（`--class` フラグの指定、なければ初期 agent の既定 class）へ戻る。手動状態の扱いは「手動モデル選択」の節に従う。

モデルの切り替えで route が変わったときは `agent model → <provider>/<model>` を info でログする。

全候補が不成立のときは、現在の route を維持し `no available model for agent <name>: class <class-name>` を warning でログして続行する。リクエスト自体は現在の route で試行され、ターンは止まらない。

## 手動モデル選択

dsh 本家の `/model` による選択は、durable な `model/selection` session event として記録される。本 plugin はこの event を検知するとその agent を手動状態にする。本 plugin 自身はこの event を書かない。

| 状態 | 振る舞い                                                                                     |
| ---- | -------------------------------------------------------------------------------------------- |
| 自動 | 各モデルリクエストで実効 class の候補を再評価する                                            |
| 手動 | ユーザーが選んだモデルを使い続ける。ただし手動の route が cooldown 中のときは自動評価に従い、cooldown が明けた後は次のリクエストから自動で手動のモデルへ戻る |

手動状態は `/agent` による agent 切替と `/class` による class 切替で解除される。セッションの再開では手動状態を引き継がない（メモリ上の状態であり、過去の `model/selection` は再評価しない）。

## レート制限（429）時のフォールバック

次のいずれかに該当するモデルは cooldown（待機状態）に入る。

| 入力     | レート制限として扱う条件                                         | 待機期間                                        |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| LLM 失敗 | `status` が `429`、または `code` が `RATE_LIMIT` / `QUOTA` のとき | 正の値の `providerRetryAfterMs`、なければ 30 分 |

cooldown 対象の route の同定は、本 plugin が直前のリクエストで解決して記録した route を使う。

- レート制限を受けたら、失敗 route を cooldown に入れ、実効 class の次候補を事前評価する。
- 次候補があればリクエストの再試行を指示する。dsh の agent loop が再試行時に route 解決をやり直すため、次候補が自動的に適用される。追加の待機は入れず、ユーザーメッセージは追加されない。切替時は `rate limited on <provider>/<model>; switched to <provider>/<model>` を warning でログする。
- 次候補がない場合は元のエラー文言と再送案内を含めた `rate limited on <provider>/<model>; no fallback available: <元のエラー文言> (resend the message to retry)` を error でログし、再試行を指示しない。この場合の処理は dsh 本来のエラー経路（本家の retry policy を含む）に委ねられる。
- 手動状態でも同じ流れでフォールバックする。
- Z.AI の同時実行系エラー（コード `1302` / `1305`）の待機リトライは本 plugin の対象外であり、`dsh-zai-concurrency-retry` が担当する。同 plugin は `agent/request-error` waterfall の最外側で対象エラーを握って下流へ渡さないため、同 plugin が有効な profile では本節のフォールバックは発火しない。
- 本 plugin だけが有効な環境では、`1305` は provider adapter で `RATE_LIMIT` に正規化されないためフォールバックの対象にならず、`1302` は `RATE_LIMIT` に正規化されるため対象になる。モデル切替では Z.AI の同時実行制限は解決しないため、`1302` での切替は無効な fallback である。

### cooldown（待機状態）

| 状況                           | 結果                       |
| ------------------------------ | -------------------------- |
| 待機期間中のモデルが候補になる | 除外して次候補を探す       |
| 待機期間の終了                 | そのモデルを再び候補にする |

cooldown は `/agent`・`/class` でも維持する。agent の破棄とともに破棄する。子 agent の cooldown は親と独立である。

## 画像入力を使う agent

モデルの画像入力対応は、dsh のモデル情報 `inputModalities` が `image` を含むかで判定する。含まないモデル、およびモダリティ情報が取れないモデルを画像非対応とみなす。

解決済み route が画像非対応の間、当該 agent のスコープで本家の `read_image` ツールを同名の shadow ツールで置き換える。shadow は画像ファイルを読み、`vision` agent の one-shot 子へ委譲し、子の最終テキストを結果として返す。画像を OCR テキストへ変換する処理は行わない。解決済み route が画像対応に変わったら shadow を解除し、本家の `read_image` がそのまま使われる。

| 現在のモデル   | 画像を必要とする場合の振る舞い                                                                |
| -------------- | ---------------------------------------------------------------------------------------------- |
| 画像入力対応   | 本家の `read_image` で画像を読み、そのまま作業を完了する                                      |
| 画像入力非対応 | `read_image` shadow が `vision` 子 agent に画像と依頼を渡す。親には子の最終テキストだけを返す |

shadow が委譲に失敗する場合（呼び出し agent の `subagents` に `vision` がない・拡張子が png/jpg/jpeg/webp/gif 以外・fs または attachment 契約が利用不能）は、画像をモデルへ送らずエラーを返す。

チャットに貼り付けられた画像の自動委譲は行わない。画像非対応 route へのチャット添付は dsh 本家の admission が拒否する。

この機能の目的は、画像入力非対応モデルへ画像を送らないことである。ファイルシステム・ツール出力・セッション保存先を横断した画像データの機密性を保証する機能ではない。

## subagent ツール

`subagent` ツールで起動できる子 agent は、現在の agent の `subagents` で決まる。モデルは指定した子 agent の既定 class から解決され、ツール呼び出しでモデルを指定することはできない。

本家が提供する delegation 系ツール（`subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`）は管理下の全 agent から隠す。`subagents` が空でない agent にのみ、本 plugin の `subagent` ツールを見せる。`subagents` が空の agent は子を起動できない。

### subagent ツールの入力

| パラメータ | 必須     | 内容                                                                                      |
| ---------- | -------- | ------------------------------------------------------------------------------------------ |
| `task`     | 必須     | 子エージェントへ渡すタスク                                                                |
| `agent`    | 必須     | 設定に定義された子 agent 名。呼び出し agent の `subagents` に含まれない名前はエラーになる |
| `cwd`      | 任意     | 受け付けるが無視する。子は常に親と同じ cwd で動く                                         |
| `model`    | 使用不可 | モデルは指定した子 agent の既定 class から解決される                                      |

| 設定                   | 子セッションへの適用                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| モデル                 | 指定された子 agent の既定 class を起動時に解決した候補                                    |
| ツール                 | 指定された子 agent の `tools`（本家 `toolFilter` として適用）                              |
| システムプロンプト     | 指定された子 agent の `systemPrompt`（本家 `persona` として適用）                          |
| さらなる subagent 実行 | 子 agent の `subagents` が空でないときに限り可能（可視性と呼び出し時ゲートの両方で判定） |

### 子セッション

- 子は dsh の in-process one-shot subagent として起動される。プロセスの起動・停止・出力の読み取りは本家の subagent 機構が担い、本 plugin は関与しない。
- 子は独自の routing 状態（独立した cooldown と、子 agent 定義の class）を持つ。子の 429 も子の class 内でフォールバックする。
- 子の結果は最終テキストのみを親へ返す。子が正常完了以外で終了した場合と、正常完了でも最終テキストが空の場合（モデル未割当などの静かな失敗として扱う）は、その旨を含むエラー応答になる。エラーメッセージは `child <agent> <stopReason>: <diagnostic または最終テキスト>` 形式で、どちらも無いときは `(no output)` を添える。
- 子セッションの表示名（label）は次の規則で作る。task の先頭行を前後の空白を除いた上で、コードポイント単位で先頭 30 文字に切り詰め、切り詰めたときは `…` を末尾に付ける。`<agent>: <summary>` 形式で、summary が空（先頭行が空）のときは agent 名のみを使う。
- 子セッションの記録は dsh の session store に行われ、本家 UI で閲覧できる。
- 委譲の深さ制限は本家の既定に従う。leaf agent（`subagents` が空）には `subagent` ツールが見えないため、設定上の委譲グラフで実質的に制御される。

### 同時実行数の制限

親 agent ごとに、同時に実行する子は 2 つまでとする。

| 実行中の子 | 新しい subagent ツールの呼び出し                                               |
| ---------- | ------------------------------------------------------------------------------ |
| 2 つ未満   | すぐに子を起動する                                                             |
| 2 つ       | 実行中の子が終了して空きが出るまで待機し、先に待機した呼び出しから順に起動する |

待機中の呼び出しの待機表示は client 側の表現のため対象外であり、host では結果を返さない待ちとして現れる。待機中に親がキャンセルした場合、その呼び出しはエラーとして終了する。

## Agent 表示

dsh web UI の composer 直上（input dock）に、現在の agent と実効 class を常設表示する。表示は次の 2 つの独立した行ボタンで、テキスト色はグレーとする。行ボタンは縦に積む。表示領域は composer カード幅の中央バンド（本家 dock 行と同じ幅と中央寄せ）に置く。

```text
🤖 agent: <currentAgent>
💎 class: <class-name> (auto:<resolved-model>)
```

行ボタンは hover で本家ボタンと同じ interactive hover fill（`--dsw-alias-interactive-bg-hover`）を表示する。

手動状態（本家 `/model` による手動モデル選択が効いている間）のときは class 行の括弧内は `manual:<resolved-model>` になる。`<resolved-model>` は直近のモデルリクエストで解決した route の model 名で、コロン前後・class 名との区切りはスペース 1 つとする。最初の turn 前（idle session）など解決済み route が無いときはモデル名を省略し `(auto)` / `(manual)` とだけ表示する。

agent 行ボタンをクリックすると agents.yaml の agent 名一覧、class 行ボタンをクリックすると class 名一覧の選択メニュー（本家 `@deepseek-ai/dsh-client-ui-primitives` の Menu による popover）が開く。メニューは外側クリック・Escape で閉じる。メニューからの選択は `/agent <name>`・`/class <name>` と同一の適用経路を通る（agent 切替では実効 class リセット、手動選択解除、ツール・persona 付け替えを含む）。

| 項目             | 内容と振る舞い                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状態の配信       | host 側が本家 `dsh-client-connection` の `/api` channel 上に exact Fetch route `POST /api/dsh-agents/state` を登録し、`{ sessionId }` に対して `{ managed, agent, className, manual, model?, agents, classes }` を返す。`model` は解決済み route の model 名（解決前に省略）、`agents`/`classes` は agents.yaml の agent 名・class 名一覧。durable な session log には書き込まず、メモリ上の状態を応答する |
| 選択の適用       | host 側が同じ `/api` channel 上に exact Fetch route `POST /api/dsh-agents/select` を登録し、`{ sessionId, kind: "agent" \| "class", name }` に対して `{ ok, text }` を返す。適用は `/agent`・`/class` コマンドと同一の内部経路（class リセット・手動選択解除・ツール/persona 付け替え）を通る |
| 表示の更新       | client half が 2 秒間隔で状態を取得し、取得に失敗したときは直前の表示を維持する。メニューからの選択が host に受け付けられたときは即座に再取得して表示を切り替える。拒否されたときは表示を変えず、次の取得周期で host 側の状態に戻る |
| 選択できない session | idle session は live agent を持たないため選択に `ok: false` で応答する（表示はそのまま）。メニュー選択は live agent を持つ session でのみ有効 |
| 未管理 session   | 本 plugin が管理しない session（plugin 無効、`agents.yaml` 不正、子 session など）では何も表示しない                                                                      |
| 表示しない環境   | web UI 以外の profile（headless、sdk など）では client half が読み込まれないため表示は出ない。routing・フォールバックなどの host 側の動作は同じ                                    |

## 実行できない場合の報告

エージェントがタスクを遂行できない場合は、理由（権限不足、力量・情報不足など）を添えて報告する。報告先（subagent 実行中は依頼元エージェント、直接実行時はオーナー）の指定は plugin コードで強制せず、各 agent の systemPrompt の規範に委ねる。

## 対象外

- client bundle のうち subagent の待機表示・toolview、通知
- チャットに貼り付けられた画像の自動委譲
- Z.AI 同時実行系エラー（`1302` / `1305`）の待機リトライ
