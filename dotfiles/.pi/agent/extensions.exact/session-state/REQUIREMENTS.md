# session-state の要件

この文書は、pi extension session-state の解決する課題・目的と、観測可能な振る舞いを定める。読者は、この拡張を保守・改修する user と coding agent である。

## 解決する課題と目的

VS Code 拡張 vscode-pi-sessions は、セッション一覧の整理にメタデータストア `session-state.json` を使う。ワークスペースごとの `active-sessions` が、既定の一覧に載るセッションの map である。`active-sessions` に載らないセッションはアーカイブ済みとして扱われ、セッション entry の `lock` はアーカイブからの保護を表す。pi TUI 側で会話を再開してもこの map は変わらない。このため、`active-sessions` から外れたセッションで作業を続けても、一覧に戻らない。

session-state は、セッションのアーカイブ状態を pi 側の操作と同期させる pi extension である。メッセージの送信を正確に観測できるのは pi 本体だけであるため、pi の extension が vscode-pi-sessions と同じメタデータストアへ自セッションの所属を書き戻す。

vscode-pi-sessions は、各セッションの実行フェーズ（agent ターン実行中・承認待ちの一次停止・user のターン待ち）を一覧に表示する。フェーズを観測できるのも pi 本体だけであるため、pi の extension が自セッションの実行フェーズを同じメタデータストアへ書き出し、読み手がウォッチして表示する。

## 機能要件

この文書でいう自セッションは、この拡張が動作している pi の現在のセッションを指す。自ワークスペースは、自セッションの作業ディレクトリを指す。

| 操作 | トリガー | `active-sessions` の更新 | `lock` への扱い | 通知 |
| --- | --- | --- | --- | --- |
| 自動アーカイブ解除 | プロンプトの送信（`input` イベント） | 自セッションの entry を作成する。既に載っていれば書き込まない | entry が無いときは `lock: false` で作成し、載っていれば参照しない・変更しない | 失敗のみ |
| `/archive` | コマンドの実行 | 自セッションの entry を削除する。載っていなければ書き込まず成功として通知する | 自セッションの entry の `lock` が `true` なら書き込まずロック中を通知する | 成功・ロック中・失敗 |
| `/unarchive` | コマンドの実行 | 自セッションの entry を作成する。既に載っていれば書き込まず成功として通知する | entry が無いときは `lock: false` で作成する | 成功・失敗 |

- 自動アーカイブ解除はプロンプトの送信ごとに動く。スラッシュコマンドの実行では動かない。
- ロックはアーカイブからの保護のみに効き、アーカイブ解除を妨げない。
- 書き込みに失敗しても、メッセージの送信と pi の動作を止めない。
- 通知は TUI 上の短いメッセージで返す。

## 実行フェーズの書き出し

session-state は、自セッションの実行フェーズを自セッションの entry の `state` として書き出す。書き手はこの拡張だけで、読み手（vscode-pi-sessions）がウォッチして表示する。更新は自セッションの entry に対する read-modify-write である。

| トリガー | `state` への反映 |
| --- | --- |
| `session_start`（起動・新規・resume・fork・reload） | 自セッションの entry に `waiting-user` を書く。既に `waiting-user` なら書き込まない |
| `agent_start`（agent run の開始） | `running` に更新する。既に `running` なら書き込まない |
| `ui_prompt_start`（拡張 UI プロンプトの表示） | `waiting-approval` に更新する |
| `ui_prompt_end`（プロンプトが閉じたとき） | agent run 継続中なら `running` に戻す。継続していなければ書き込まない |
| `agent_settled`（agent run の確定停止） | `waiting-user` に更新する。既に `waiting-user` なら書き込まない |
| `session_shutdown`（終了・セッション切替・reload） | 自セッションの entry から `state` を除去する。無ければ書き込まない |

- entry が無いときは `state` の書き込みで entry を作成する。作成・更新の際、entry の `lock` と未知の属性は保つ。
- `agent_end` はリトライやキュー継続で再発火するため、遷移のトリガーには使わない。
- 書き込みに失敗しても、pi の動作を止めない。失敗は警告で通知する。
- 異常終了で `state` が残留したときの掃除は読み手側の責務であり、この拡張は `session_shutdown` での除去だけを行う。`pid` は書かない。

## メタデータストアの契約

ストアは、workspace ごとのセッション所属と実行フェーズを次の構造で保持する:

```json
{
  "active-workspaces": {
    "<workspace path>": {
      "active-sessions": {
        "<session id>": { "lock": false, "state": "running" }
      }
    }
  }
}
```

| 項目 | 契約 |
| --- | --- |
| ストアのパス | pi の agent directory（環境変数 `PI_CODING_AGENT_DIR`。未設定時は `~/.pi/agent`）配下の `session-state.json` |
| workspace のキー | workspace の絶対パス。この拡張は自セッションの作業ディレクトリを使う |
| workspace の登録 | `session-state.json` の `active-workspaces` が登録の唯一の正本。key の存在が、vscode-pi-sessions の既定の一覧に表示する workspace の登録を表す |
| 登録の操作 | vscode-pi-sessions の `New Workspace` は workspace エントリを作成し、`Unregister` はエントリを削除する |
| 空の workspace | `active-sessions` が空でも、workspace エントリが存在すれば登録として有効 |
| `active-sessions` | workspace エントリ直下の map。key はセッション ID。載っているセッションが既定の一覧に載るセッションで、載っていないセッションはアーカイブ済み |
| entry | `lock` と `state` を持ち、未知の属性を保持する |
| `lock` | `true` のときアーカイブから保護される。省略時は `false`。この拡張は `lock` を書き換えず、`lock: true` の entry の削除を拒否する |
| `state` | `running`・`waiting-approval`・`waiting-user` の3値。省略時はフェーズ情報なし |
| 更新の方式 | ファイルを読み、自 workspace エントリの自セッション entry のみを変更して書き戻す |
| entry の作成 | この拡張は、自セッション entry の作成時に、自 workspace のエントリか `active-sessions` が無い、またはオブジェクトでないときは、作成・置き換える。pi を起動した cwd は、この作成により自動登録される |
| 登録解除後の再登録 | 稼働中のセッションがある cwd を vscode-pi-sessions で登録解除しても、次のプロンプト送信でこの拡張が workspace エントリを作成し直し、再登録する |
| 新規作成 | ファイルが無いときは空のストアとして作成する |
| 保持 | 自セッション entry の自分が更新しないフィールド、自 workspace エントリの未知の属性、他の workspace エントリ、未知の root キーを保持する |
| 不正なストア | JSON として読めない、ルートまたは `active-workspaces` がオブジェクトでない、ルートに旧 `workspaces` オブジェクトがある（`active-workspaces` と併存する場合を含む）、workspace エントリの `active-sessions` が配列（旧形式）の、いずれかのときは、書き換えずに失敗として扱う |
| 原子性 | 一時ファイルへ書き出してから rename で置き換える |
| 逐次実行 | 複数の更新は直列に実行する |

## 検証要件

- ストアの解釈と更新は純粋関数として切り出し、unit テスト（`bun test`）で検証する。対象は、store の parse（旧 `workspaces` オブジェクトと旧 `active-sessions` 配列の拒否を含む）、`active-sessions` への entry 追加・削除、ロック判定、workspace エントリと `active-sessions` の作成、未知フィールドの保持、追加済み・ロック中・削除済みの判定、`state` の読み取り・設定（同一 `state` の書き込み skip を含む）・除去、serialize とする。
- `active-sessions` から外れたセッションを再開してメッセージを送り、自セッションの entry が `active-sessions` に戻り、vscode-pi-sessions の一覧が次の refresh で既定ビューに戻ることを確認する。
- `/archive` では自セッションの entry が `active-sessions` から外れ、一覧から消えることを確認する。
- `/unarchive` では自セッションの entry が `active-sessions` に戻ることを確認する。
- pi を起動して agent を実行し、自セッションの entry の `state` が `waiting-user` で作成され、実行中は `running`、確定停止で `waiting-user` に戻り、終了で除去されることを確認する。
