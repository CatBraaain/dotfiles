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

host 側 plugin がセッションの `skill` tool 呼び出し（`tool/call` / `tool/result` session event）を監視し、成功裏に完了したとき、そのセッションで初めての利用であれば log-only session event `skill-status/used`（payload `{ name }`）を1件 append する。client 側 plugin は当該 event を履歴込みで Conversation assembly（`ctx.uiConversation`）経由で受け、名前集合を first-use 順に保持・表示する。

| 動作 | 表示 |
| --- | --- |
| `skill` tool の呼び出しがエラーなしで完了した | 利用された skill 名を追加して表示する |
| `skill` tool の呼び出しが失敗した（tool/result が `error` を持つ、または結果 block が `isError`） | 表示を変更しない |
| 表示済み skill を再度利用した | 表示順と表示名を変更しない |

明示的な skill コマンド（`/skill:<name>` 等）は dsh 本体が pre-step で `skill-invocation` injection に変換し、model が `skill` tool を呼ぶ。本 plugin は tool 成否だけを見るため、コマンド経由か自動選択かを区別しない。

## セッション間の表示

表示は session event にのみ載るため、現在のセッションに属する。

- 新しいセッションに切り替えたとき、前のセッションの skill 名を表示しない
- セッションの再開・リロード時は、履歴の `skill-status/used` event から表示を復元する（イベントウィンドウの読み込み範囲に依存）
- host の再起動・plugin の再読み込みで、セッション途中の in-flight な `skill` 呼び出しまでの状態をイベントログから復元する

## 設定

ON/OFF の設定ファイルは設けない。profile から plugin を除外することで全体を無効化する。
