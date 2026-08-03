# annotation.plan.md

ソースコードに行頭コメント `AI-NOTE:` で注釈を書くと、pi への送信時に自動収集・削除してプロンプトに前置する pi extension を実装する計画。

## 目的

diff viewer や専用 GUI を導入せず、普段のコードリーディングの延長でフィードバックを書けるようにする。エディタで pi の成果物を読みながら気になった行に直接 `AI-NOTE:` を書き、pi への送信時にそれを**ファイル・行・周辺コード付きの構造化テキスト**に変換して自動で送る。

レビュー（「ここを直して」）だけでなく、ソースへの一般的な言及（「これは参照」「ここ疑問」）にも使える汎用な注釈チャネル。

## 仕様

### マーカー

- キーワード: `AI-NOTE:`（pi 固有でなく、任意の agent で再利用可能な汎用名）
- **行頭コメントのみ許可**。インライン（行末）注釈は無視
  - 行頭コメント = 行の先頭（インデント許容）が言語のコメント記号で始まり、その直後に `AI-NOTE:` が続く
  - 対象記号: `//` `#` `--` `;` `*` `/*` `<!--` 等（正規表現で判定）
  - インラインを許すと「行全体削除」で実コードまで消えるため禁止

### 起点と検出

- **コマンド不要・自動検出**。`input` イベントで毎回 `git grep` する
- 除外条件（transform せず `continue`）:
  - `event.source !== "interactive"`（RPC / extension 投入分は触らない）
  - `event.text` が `/` で始まる（拡張コマンド・スキル・テンプレートを壊さないため）
  - ヒット0件

### 検出時の確認ダイアログ

注釈を検出したら、**transform 実行前に確認ダイアログ**を出す:

- 収集した注釈のプレビュー（件数＋各 `path:line` ＋注釈本文）を表示
- 選択肢: **送信（注釈を前置して削除）** / **キャンセル（注釈も入力もそのまま）**
- キャンセル時は `continue`。注釈はファイルに残り、次回送信で再検出される

### 承認時の処理

1. マーカー行を行番号**降順**に削除（ズレ防止）。`node:fs` で書き戻し
2. `return { action: "transform", text: <注釈Markdown> + "\n\n" + event.text }`
   - 注釈をユーザー入力の**前に**前置
   - transform 後のテキストがユーザーメッセージとして pi へ。発火1回・履歴にも1メッセージとして表示

## 技術設計

| 役割 | API | 内容 |
|------|-----|------|
| 検出 | `pi.on("input")` | コマンド/スキル以外のユーザー送信時に `git grep -n "AI-NOTE:"` |
| 判定 | 正規表現 | 行頭コメントのみ抽出。インラインは除外 |
| 確認 | `ctx.ui.confirm` / `ctx.ui.select` | プレビュー付きで送信/キャンナル選択 |
| 削除 | `node:fs/promises` | マーカー行を行番号降順に削除 |
| 注入 | `input` の `transform` | 注釈 Markdown を前置して return |

### なぜ `input` の `transform` 一択か

- `pi.sendUserMessage` は **Always triggers a turn**＝即時発火。コマンド起点だと「注釈送信(1回)＋追加指示(2回)」の二回発火になる
- `pi.sendMessage({deliverAs:"nextTurn"})` は発火しないが**編集不可**（注釈をそのまま次回送信に合流させるだけ）
- `ctx.ui.pasteToEditor` は入力欄を占有し、`/annotate` コマンド実行→編集→送信の2ステップになる
- `input` の `transform` は**ユーザー送信に自動フック**・発火1回・履歴へ自然表示・コマンド不要。ユーザーは「注釈を書いて普通に話しかける」だけ。これが最小

### チェックポイント整合

git-checkpoint extension は `turn_start` で `git stash create` する。`input` → `before_agent_start` → … → `turn_start` の順なので、**注釈削除は stash 作成より前に完了**する。チェックポイントに `AI-NOTE:` 行は混入しない。

## 状態管理

- **状態を持たない**（ステートレス）。毎回 `git grep` で検出 → 確認 → 削除。セッション永続化・活性セット等は不要
- 例外: 確認ダイアログでキャンセルされた注釈はファイルに残る（=次回再検出）。これは仕様

## 決定事項

- マーカー: `AI-NOTE:`（行頭コメントのみ）
- 起点: `input` イベント・自動検出（コマンド不要）
- 除外: 非 interactive 送信・`/` 始まりの入力・ヒット0件
- 確認: transform 前にダイアログ（プレビュー付き・送信/キャンセル）
- 承認時: マーカー行削除（降順）＋ `transform`（注釈前置）
- キャンセル時: `continue`（注釈・入力ともに変更なし）
- extension 配置: `dotfiles/.pi/agent/extensions.exact/ai-annotation/`（グローバル展開・`path-rules` と同じ構成）
- 行削除: `node:fs/promises` の read/write（`withFileMutationQueue` は input イベント段階では不要＝ツール実行と並走しない）
- grep: `git grep -n`（tracked のみ・速い・`node_modules` 自動除外）

## タスク

- [ ] マーカー検出（`git grep -n "AI-NOTE:"` ＋ 行頭コメント正規表現でフィルタ）
- [ ] 行削除ロジック（ファイルごとに行番号降順で削除・書き戻し）
- [ ] 注釈の Markdown 構造化（`path:line` ＋ 周辺コード ＋ 注釈本文）
- [ ] `input` イベントハンドラ（除外判定 → 検出 → 確認ダイアログ → transform/continue）
- [ ] 確認ダイアログのプレビュー表示（件数・注釈一覧）
- [ ] エッジケース（空注釈・巨大注釈のプレビュートリム・マーカーが既存コメントと衝突）
- [ ] テスト（`.test.ts`・Bun auto-install 向けに describe/it を内蔵）

## メモ・未決定

- **確認ダイアログの形式**（実装時に決定）:
  - `ctx.ui.confirm`（Yes/No）で注釈一覧を message に詰めるか
  - `ctx.ui.select` で「送信 / 編集して送信 / キャンセル」にするか
  - 「編集して送信」を入れるなら `ctx.ui.editor` で注釈を編集できると更强力
- **プレビュー表示**（実装時に決定）: confirm の message 内 vs `ctx.ui.setWidget` で別表示 vs `ctx.ui.notify`。注釈が多いと confirm message が膨らむので件数でトリム要
- **周辺コードの幅**: 注釈行の前後何行を Markdown に含めるか（2〜3行想定・実装時調整）
- **untracked ファイル**: `git grep` は tracked のみ。新規ファイル中の `AI-NOTE:` は拾えない。必要なら `rg --no-ignore-vcs` 等に切り替え（YAGNI・初版は tracked のみ）
- **複数ファイル跨ぎ**: 1つの transform に全件まとめて前置する
- pi の input イベントは skill/template 展開の**前**に走る。`/` 始まりで弾けば安全
- 検出〜削除〜transform は input ハンドラ内で同期的に完結。ユーザー送信の流れをブロックするが、確認ダイアログで待機するので体感問題なし
