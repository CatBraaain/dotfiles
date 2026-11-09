# Session worktreeメタデータ仕様

本書は、pi の session に関連する Git worktree を記録する `session-metadata` 拡張の入出力・状態・エラーを定める。読者は拡張の保守者と、session ファイルを読む外部ツールの開発者である。目的と重要制約は [REQUIREMENTS.md](./REQUIREMENTS.md) に従う。保存形式は pi の標準 [CustomEntry](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/session-format.md#customentry) を使う。

## 記録形式と保存

更新後の一覧を、`customType: "session-worktree-metadata"` の `data.workspaces: string[]` にsnapshotとして記録する。各要素は現存する Git worktree ルートの絶対パスであり、実体パスへ正規化する。重複は持たず、登録順を保つ。同一Bash呼び出しで複数の `add` が残った場合、新規登録分は操作後に観測した Git worktree一覧の順に追加する。関連がなければ `[]` とする。

```json
{
  "type": "custom",
  "customType": "session-worktree-metadata",
  "id": "entry-id",
  "parentId": "previous-entry-id",
  "timestamp": "2026-11-09T00:00:00.000Z",
  "data": {
    "workspaces": ["/worktrees/app/feature"]
  }
}
```

外部ツールと拡張は、session全体のエントリを追記順に読み、`type: "custom"` かつ上記customTypeである最後のエントリを現在値として採用する。末尾の行、timestamp、現在の会話分岐だけでは判定しない。該当エントリがなければ空の一覧とする。最新snapshotのデータ型が不正、パスが相対パス・空・NULを含む、または重複する場合は読み取りエラーとする。

| 条件 | 更新結果 |
| --- | --- |
| 更新後の一覧が現在値と異なる | 標準customエントリ追記APIでsnapshotを1件追記する。既存の session header と履歴本文を保持する |
| 更新後の一覧が現在値と同じ | snapshotを追記しない |
| session が初回保存前 | 標準APIが受け付けたsnapshotを、pi の通常の初回保存に含める |
| ファイル保存を使わない session | 同じ標準APIでメモリ上のsnapshotを更新する |
| 標準APIが失敗する | 更新を失敗として扱い、成功結果や成功通知を返さない |
| 非同期処理中に session が切り替わる | その処理による更新と通知を取りやめる |

更新成功は標準APIの正常受付を意味し、独自のディスク保存済み保証を加えない。一覧は session全体の関連を表し、会話内の分岐移動では変化しない。明示操作と自動更新の際に既存の登録先も確認し、現存しない worktree を一覧から取り除く。更新先は呼出sessionに限る。

## Bash操作への自動追従

登録された Bashツールの呼び出しに現れる通常の `git worktree add`・`move`・`remove` を扱う。`git -C <path>` と `cd <path> && git ...` による操作場所の指定、空白を含む引用パス、同一コマンド内の複数操作、別ツールからの nested呼び出しにも追従する。パスは Bash の通常の引数として解釈し、先頭の `@` と、引用またはエスケープされた `~/` は文字通り扱う。

| 操作前後の Git worktree一覧 | 関連データの更新 |
| --- | --- |
| `add` により新しい worktree が残った | そのパスを末尾へ登録する |
| `move` により登録済み worktree のパスが変わった | 元の位置で新しいパスへ置換する |
| `remove` により登録済み worktree がなくなった | その関連を解除する |
| 操作が失敗・未実行であり、一覧に変化がない | その操作を成功したものとして登録・置換・解除しない |
| 操作後の別コマンドが失敗したが、worktree操作の変化が残った | 残った変化を反映する |
| 作成後に同じコマンド内で削除され、最終状態に残らない | そのパスを登録しない |

追従の判断には、コマンドで指定された対象と、呼び出し中に観測した Git の実状態を使う。同時期に別の操作が作成した、指定対象でない worktree は登録しない。外部で直接実行した操作や、任意のスクリプト・動的なシェル処理による変更を補正するときは、次の明示ツールを使う。

## 明示ツール `session_worktree`

エージェントは、既存 worktree の指定や別 session からの引き継ぎに、このツールを使う。

| 入力 | 意味 |
| --- | --- |
| `action: "register"` | 指定した worktree を呼出sessionに登録する |
| `action: "unregister"` | 指定したパスの関連を呼出sessionから解除する。worktree自体は削除しない |
| `path: string` | 対象パス。絶対パス、session の cwd相対パス、`~/` 表記を受け付ける。先頭の `@` はパス参照の接頭辞として除く |

| 条件 | 結果 |
| --- | --- |
| `register` のパスが現存する Git worktree のルート | 正規化したパスを末尾へ登録する |
| 同じパスを再登録する、または未登録のパスを解除する | 重複を作らず、変更後の一覧を返す |
| `unregister` のパスが既に存在しない | そのパスの関連を解除する |
| パスが空・NULを含む、または `register` の対象が worktreeルートでない | ツールエラーを返し、関連データを変更しない |
| Git照会・snapshotの読み取り・標準APIの追記に失敗する | 対象と理由を含むツールエラーを返し、成功として返さない |

成功結果の本文と `details` は `{ changed: boolean, workspaces: string[] }` とする。`changed` は新しいsnapshotを追記したかを表す。

## 自動更新の通知

| 結果 | モデルへの通知 | TUI表示 |
| --- | --- | --- |
| 一覧が変わり、標準APIがsnapshotを受け付けた | 別の `custom_message` で更新済みの事実・追加/置換/解除内容・現在の `workspaces` を伝える | 変更件数を含む短い表示。展開すると通知本文を読める |
| 一覧が変わらない | 更新通知を出さない | 更新通知を出さない |
| Git照会・snapshotの読み取り・標準APIの追記が失敗した | 別の `custom_message` で更新失敗と理由を伝える | 短い失敗表示 |

通知のcustomTypeは `session-worktrees` とする。モデル向けの情報は `content` に含め、`details` はTUI表示用に使う。更新通知は再登録を求めず、Bash の返値・本文・エラーフラグを変更しない。`display: true`、`deliverAs: "steer"`、`triggerTurn` 省略により、実行中のモデルには次の応答までに通知を渡し、idle のsessionでは通知だけを保存してモデルの応答を開始しない。
