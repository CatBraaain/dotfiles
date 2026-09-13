# dsh-skill-status

## 目的

dsh web UI の composer 上部に、現在のセッションで正常に利用完了した skill 名を常設表示する。pi extension `skill-status`（`dotfiles/.pi/agent/extensions.exact/skill-status`）と同等の機能を dsh へ移行したものである。

## 表示

composer 上の dock（slot `conversation.input.dock`、session scope）に、初回利用順で skill 名を並べた1行を表示する。文字色は gray 系（`--dsw-alias-label-tertiary`）で統一する。

| 状態 | 表示 |
| --- | --- |
| 利用完了した skill がない | 何も描画しない |
| skill の利用が成功裏に完了した | `🎯 skills: <name>, <name>` の形式で、初回利用順に追記して表示する |

- 表示行は `🎯 skills: ` + skill 名を `, ` で連結したものとする
- 同じ skill を複数回利用しても、名前は1回だけ表示する
- 幅に収まらないときは CSS（`text-overflow: ellipsis`）で行末を `...` として省略する

## 表示の更新

host 側 plugin は session projection `skillStatus`（初回利用順の名前配列）を `ctx.sessionProjections` へ登録する。projection は dsh 本体の既知 event 型 `tool/call`（`name` が `skill` の呼び出し）と `tool/result` だけから全ログを畳み込み、`skill` の呼び出しと結果を callId で対にして、成功裏に完了した初回利用の順に名前を並べる。本 plugin は自前の session event を1件も append しない。client 側 plugin は standard prop の `useProjection` 経由で当該 projection の完成値を受け取り、表示する。Conversation assembly は使わない。

| 動作 | 表示 |
| --- | --- |
| `skill` tool の呼び出しがエラーなしで完了した | 利用された skill 名を追加して表示する |
| `skill` tool の呼び出しが失敗した（tool/result が `error` を持つ、または結果 block が `isError`） | 表示を変更しない |
| 表示済み skill を再度利用した | 表示順と表示名を変更しない |

- 呼び出し引数 `arguments` の JSON から skill 名を取り出せない呼び出しは、対応する結果が来ても名前に数えない
- 失敗した結果（`error` を持つ、または結果 block が `isError`）は対の呼び出しを畳み込み状態から外すだけで、名前は追加しない。その後の同じ skill の成功した利用は初回利用として数える
- 未完了のまま残った呼び出しは host 再起動後も log 全体の再畳み込みで復元され、後から届いた結果と対になる

dsh の明示コマンド `/<name>`（pi の `/skill:<name>` とは異なる）は、skill の内容を user message に直接展開し、`skill` tool を呼ばない（dsh 0.1.5-rc 系で実測）。本 plugin は `skill` tool の呼び出しの成否だけを見るため、明示コマンド経由の利用は記録されない。

この設計により session log には dsh 本体の既知 event 型しか書かれない。かつて本 plugin は log-only event `skill-status/used` を append していたが、dsh 0.1.5-rc 系の実測では、その event を含む session log は host 再起動後の observe で `unknown to this harness and not marked ignorable` として拒否され、会話履歴が読めなくなった（dock 表示だけは projection 経由で復元する）。envelope の `ignorable` marker は `Session.append` の公開 API から指定できず、既知 event 型一覧は生成物で閉じているため、plugin 単独で marker を付けられない。`skill-status/used` を含む過去の session はこの拒否が残る既知制限であり、host 側の読み替えを待つ。

## セッション間の表示

表示は `skillStatus` projection にのみ載るため、現在のセッションに属する。

- 新しいセッションに切り替えたとき、前のセッションの skill 名を表示しない
- セッションの再開・リロード時は、`skillStatus` projection の完成値から表示を復元する。projection は host がセッション全長に渡って畳み込むため、client が読み込んだイベントウィンドウの範囲に依存しない
- client が dsh から切断している間も、host 側 plugin は projection の維持を継続する（projection は log の既知 event 型から畳み込まれる）。client が再接続したとき、projection の完成値の受信で表示を復元する
- host の再起動・plugin の再読み込みで、セッション途中の in-flight な `skill` 呼び出しまでの状態をイベントログから復元する

## 設定

ON/OFF の設定ファイルは設けない。profile から plugin を除外することで全体を無効化する。
