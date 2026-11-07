# session-state の要件

この文書は、pi extension session-state の解決する課題・目的と、観測可能な振る舞いを定める。読者は、この拡張を保守・改修する user と coding agent である。

## 解決する課題と目的

VS Code 拡張 vscode-pi-sessions は、セッション一覧の整理にメタデータストア `session-state.json` を使う。ワークスペースごとの `active-sessions` が既定の一覧に載るセッションのリストであり、`locked-sessions` はアーカイブからの保護を表す。pi TUI 側で会話を再開してもこのリストは変わらない。このため、`active-sessions` から外れたセッションで作業を続けても、一覧に戻らない。

session-state は、セッションのアーカイブ状態を pi 側の操作と同期させる pi extension である。メッセージの送信を正確に観測できるのは pi 本体だけであるため、pi の extension が vscode-pi-sessions と同じメタデータストアへ自セッションの所属を書き戻す。

## 機能要件

この文書でいう自セッションは、この拡張が動作している pi の現在のセッションを指す。自ワークスペースは、自セッションの作業ディレクトリを指す。

| 操作 | トリガー | `active-sessions` の更新 | `locked-sessions` への扱い | 通知 |
| --- | --- | --- | --- | --- |
| 自動アーカイブ解除 | プロンプトの送信（`input` イベント） | 自セッションを追加する。既に載っていれば書き込まない | 参照しない・変更しない | 失敗のみ |
| `/archive` | コマンドの実行 | 自セッションを削除する。載っていなければ書き込まず成功として通知する | 自セッションが載っていれば書き込まずロック中を通知する | 成功・ロック中・失敗 |
| `/unarchive` | コマンドの実行 | 自セッションを追加する。既に載っていれば書き込まず成功として通知する | 参照しない・変更しない | 成功・失敗 |

- 自動アーカイブ解除はプロンプトの送信ごとに動く。スラッシュコマンドの実行では動かない。
- ロックはアーカイブからの保護のみに効き、アーカイブ解除を妨げない。
- 書き込みに失敗しても、メッセージの送信と pi の動作を止めない。
- 通知は TUI 上の短いメッセージで返す。

## メタデータストアの契約

ストアは、workspace ごとのセッション所属を次の構造で保持する:

```json
{
  "version": 2,
  "workspaces": {
    "<workspace path>": {
      "active": true,
      "active-sessions": ["<session id>"],
      "locked-sessions": ["<session id>"]
    }
  }
}
```

| 項目 | 契約 |
| --- | --- |
| ストアのパス | pi の agent directory（環境変数 `PI_CODING_AGENT_DIR`。未設定時は `~/.pi/agent`）配下の `session-state.json` |
| workspace のキー | 自セッションの作業ディレクトリの絶対パス |
| 更新の方式 | ファイルを読み、自 workspace エントリの `active-sessions` のみを変更して書き戻す |
| エントリの作成 | 自 workspace のエントリが無い、またはオブジェクトでないときは、`active-sessions` を持つエントリとして作成・置き換える |
| 新規作成 | ファイルが無いときは `version: 2` のストアとして自 workspace エントリを作成する |
| `version` | 常に `2` で書く |
| `active` | vscode-pi-sessions の UI が扱う workspace 全体の表示トグル。この拡張は参照も変更もしない |
| 保持 | 自 workspace エントリの `locked-sessions` と未知の属性、他の workspace エントリ、未知の root キーを保持する |
| 不正なストア | JSON として読めない、ルートまたは `workspaces` がオブジェクトでない、`version` が `2` 以外（欠落を含む）のいずれかのときは、書き換えずに失敗として扱う |
| 原子性 | 一時ファイルへ書き出してから rename で置き換える |
| 逐次実行 | 複数の更新は直列に実行する |

## 検証要件

- ストアの解釈と所属の更新は純粋関数として切り出し、unit テスト（`bun test`）で検証する。対象は、store の parse と `version: 2` の検証、`active-sessions` への追加・削除、ロック判定、workspace エントリの作成、未知フィールドの保持、追加済み・削除済みの判定、serialize とする。
- `active-sessions` から外れたセッションを再開してメッセージを送り、自セッションが `active-sessions` に戻り、vscode-pi-sessions の一覧が次の refresh で既定ビューに戻ることを確認する。
- `/archive` では自セッションが `active-sessions` から外れ、一覧から消えることを確認する。
- `/unarchive` では自セッションが `active-sessions` に戻ることを確認する。
