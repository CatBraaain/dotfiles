# worktree セッション移行拡張 Spec

## 対象

pi のセッションを会話・コンテキストごと git worktree へ移行し、main worktree へ戻す拡張。人間用に `/worktree` `/worktree-back` コマンド、エージェント用に `worktree` ツールを提供する。配置先は `dotfiles/.pi/agent/extensions.exact/worktree/`。

## 入口

| 入口 | 呼び手 | 役割 |
|---|---|---|
| `/worktree [branch]` | 人間 | main worktree から worktree セッションへ移行する |
| `/worktree-back` | 人間 | worktree セッションから main worktree へ戻る |
| `worktree` ツール | LLM | `/worktree <branch>` をフォローアップとして発火する |

## 移行先の特定

| 項目 | 値 |
|---|---|
| worktree パス | `~/projects/<リポジトリ名>-<branch>`（リポジトリ名はリポジトリルート（`git rev-parse --show-toplevel`）の basename） |
| branch（引数指定時） | 引数の文字列をそのまま使う |
| branch（省略時） | `wt-<yyyymmdd-hhmmss>`（実行のローカル時刻から生成） |
| 分岐元 | 現在の HEAD |

## /worktree の振る舞い

| 状態 | 操作 | 結果 |
|---|---|---|
| main worktree 内の git リポジトリ | `/worktree [branch]` | 次節「移行手順」の全ステップが成功し、worktree を cwd とするセッションへ切り替わる。移行通知に branch と worktree パスを表示する（退避した未コミット変更があった場合はその旨も表示する） |
| 既に worktree にいる | `/worktree [branch]` | エラー通知「`/worktree-back` で戻る」のみ。状態は変わらない |
| git リポジトリ内でない | `/worktree [branch]` | エラー通知のみ。状態は変わらない |
| `git worktree list` が失敗、または主ワークツリーを特定できない | `/worktree [branch]` | エラー通知のみ。状態は変わらない |
| セッションが未保存（ファイル無し） | `/worktree [branch]` | エラー通知のみ。状態は変わらない |
| 指定 branch が既に存在する等で `git worktree add` が失敗 | `/worktree [branch]` | エラー通知のみ。元セッション・元の変更は変わらない |

### 移行手順（上から順に、失敗したら以降を中止してエラー通知）

1. `git worktree add <worktreeパス> -b <branch>`（HEAD から作成）
2. 未コミット変更（`git status --porcelain` の出力で判定）があるときのみ `git stash push -u -m worktree-migration:<branch>`（tracked 変更と untracked を退避。`.gitignore` 対象は移動しない。`/worktree-back` でのラベルは `worktree-migration:back`）
3. worktree 側で `git stash pop`（手順2を実行したときのみ）
4. 現セッションを fork した新規セッションファイルを作成（会話履歴は全てコピー、header の `cwd` を worktree パスに書き換え、`parentSession` に元セッションのパスを記録）
5. `ctx.switchSession` で新セッションへ切り替え。AGENTS.md・`.pi/`・skills・extensions は worktree 側の内容で再読込される

失敗時の保全:

| 失敗箇所 | 残る状態 |
|---|---|
| 手順1の失敗 | 元のままで何も変わらない |
| 手順3の失敗 | 変更は stash に残存（通知に `git stash list` を案内）。worktree と branch は残る。セッションは元のまま |
| 手順4〜5の失敗 | worktree・branch・移行済み変更は残る。セッションは元のまま |

## /worktree-back の振る舞い

main worktree のパスは `git worktree list` の主ワークツリー（先頭エントリ）から特定する。

| 状態 | 操作 | 結果 |
|---|---|---|
| worktree 内 | `/worktree-back` | `/worktree` と同じ手順で main worktree へ切り替わる（branch は既存の main worktree チェックアウトを使い、新規作成しない）。移行通知に main パスを表示する（退避した未コミット変更があった場合はその旨も表示する） |
| main worktree 内 | `/worktree-back` | エラー通知のみ。状態は変わらない |
| git リポジトリ内でない | `/worktree-back` | エラー通知のみ。状態は変わらない |
| `git worktree list` が失敗、または主ワークツリーを特定できない | `/worktree-back` | エラー通知のみ。状態は変わらない |
| セッションが未保存（ファイル無し） | `/worktree-back` | エラー通知のみ。状態は変わらない |

復帰後、移行元の worktree と branch は残す。閉じる操作は提供しない（owner の git 運用手順に委ねる）。

## worktree ツール（エージェント用）

| 入力 | 結果 |
|---|---|
| branch（省略可） | `/worktree <branch>` をフォローアップのユーザーメッセージとして発火する。ツールの戻り値は「発火をキューした」旨のテキスト |
| 発火したコマンドの成否 | コマンド側の通知・セッション切り替えに現れる |

システムプロンプトへの露出: `promptSnippet` で1行の説明、`promptGuidelines` で「編集を伴う作業の着手前に `worktree` ツールでセッション移行を提案する」を追加する。

## 終了時の掃除（session_shutdown, reason が quit）

| 状態 | 結果 |
|---|---|
| worktree セッションで未コミット変更あり（`git status --porcelain` の出力で判定） | 自動コミット（`git add -A` 後、branch 名（`git branch --show-current`）でメッセージ `[pi] auto-commit on exit (<branch>)`。branch 不明時は `detached`）し、`git worktree remove` で worktree を削除する |
| worktree セッションで変更なし | `git worktree remove` で worktree を削除する（いずれも main worktree 側で実行する） |
| 自動コミットが失敗 | 通知して worktree を残す |
| worktree remove が失敗（削除できない変更が残る等） | 通知して worktree を残す |
| 掃除中のその他の失敗（`git status` 取得失敗を含む例外全般） | 通知せずに終了する（終了処理を妨げない） |
| main セッション | 何もしない |

branch はどの case でも削除しない。worktree の統合・破棄は owner の git 運用手順（finish・discard・close）による。reason が quit 以外（reload・new・resume・fork）では何もしない。
