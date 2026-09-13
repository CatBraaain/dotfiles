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

host 側 plugin がセッションの `skill` tool 呼び出し（`tool/call` / `tool/result` session event）を監視し、成功裏に完了したとき、そのセッションで初めての利用であれば log-only session event `skill-status/used`（payload `{ name }`）を1件 append する。host 側 plugin は、当該 event を全ログに渡って畳み込む session projection `skillStatus`（初回利用順の名前配列）を `ctx.sessionProjections` へ登録する。client 側 plugin は standard prop の `useProjection` 経由で当該 projection の完成値を受け取り、表示する。Conversation assembly は使わない。

| 動作 | 表示 |
| --- | --- |
| `skill` tool の呼び出しがエラーなしで完了した | 利用された skill 名を追加して表示する |
| `skill` tool の呼び出しが失敗した（tool/result が `error` を持つ、または結果 block が `isError`） | 表示を変更しない |
| 表示済み skill を再度利用した | 表示順と表示名を変更しない |

明示的な skill コマンド（`/skill:<name>` 等）は dsh 本体が pre-step で `skill-invocation` injection に変換し、model が `skill` tool を呼ぶ。本 plugin は tool 成否だけを見るため、コマンド経由か自動選択かを区別しない。

`skill-status/used` は dsh 本体の既知 event 型の外にある plugin 固有の log-only event であり、envelope の `ignorable` forward-compat marker を付けられない。将来この marker を厳格に施行する harness では、本 event を含む session log の resume が拒否され得る。

## セッション間の表示

表示は session event と projection にのみ載るため、現在のセッションに属する。

- 新しいセッションに切り替えたとき、前のセッションの skill 名を表示しない
- セッションの再開・リロード時は、`skillStatus` projection の完成値から表示を復元する。projection は host がセッション全長に渡って畳み込むため、client が読み込んだイベントウィンドウの範囲に依存しない
- client が dsh から切断している間も、host 側 plugin は `skill-status/used` の記録と `skillStatus` projection の維持を継続する。client が再接続したとき、projection の完成値の受信で表示を復元する
- host の再起動・plugin の再読み込みで、セッション途中の in-flight な `skill` 呼び出しまでの状態をイベントログから復元する

## 設定

ON/OFF の設定ファイルは設けない。profile から plugin を除外することで全体を無効化する。
