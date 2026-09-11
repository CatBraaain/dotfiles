---
name: task-queue
description: pi 用タスクキューの運用。markdown ファイルと規約だけで、セッション・worktree をまたぐ作業キューを管理する。タスクを積む・拾う・一覧する・完了するとき、「タスクに積んで」「次のタスク拾って」「タスク一覧」「WIP は？」等のキュー操作の依頼で使う。
---

# Task Queue

## ストア

- タスクは `~/.pi/agent/tasks/<project>/<YYYYMMDD-HHMMSS>-<機能名-kebab-case>.md` の 1 ファイル 1 タスク。`<project>` はワークファイル戦略と同じく作業対象リポジトリのルートディレクトリ名（リポジトリ外の作業ならカレントディレクトリ名）。すべてのタスクは status にかかわらずこの場所にフラットに置く（サブフォルダ分けはしない）
- 日時部分は積むときに `date +%Y%m%d-%H%M%S` で採番する（ローカル時刻）。同一秒のファイルが既にあるときは +1 秒ずらす。固定幅なので辞書順 = 時系列が保たれ、参照も一意になる
- frontmatter のフィールドは `status`（必須）、`branch`（着手時に追記）、`depends`（着手を待つ先行タスクの参照。ファイル名から拡張子を除いたもの。省略可）のみ
- `status` は TODO（未着手）/ WIP（作業中）/ DONE（完了）/ CANCELLED（やらないことになった）の 4 種。状態が変わるたびに書き換える
- 本文は `## 目的`（依頼内容の要約。対象リポジトリを含める）と `## 完了条件`（観測可能な受入条件）で構成する

スキーマ例:

```markdown
---
status: WIP
branch: add-export-command
depends: 20260911-110523-add-import-base
---
## 目的
<リポジトリ> への <依頼内容の要約>

## 完了条件
<観測可能な条件>
```

## 積む

owner の指示、または作業分解で生じた着手待ち単位に対して:

1. `mkdir -p ~/.pi/agent/tasks/<project>` のうえ、`status: TODO` を書いたタスクファイルを作成する。日時部分は `date +%Y%m%d-%H%M%S` で採番し、同一秒の既存ファイルがあれば +1 秒ずらす
2. 複数単位は 1 単位 1 ファイルに分ける。依存関係があるときは先行タスクの参照（ファイル名から拡張子を除いたもの）を `depends:` に書く

## 依存関係

- `depends:` に先行タスクの参照（ファイル名から拡張子を除いたもの）を書く。複数は YAML リストで列挙する（例: `depends: [20260911-110523-add-base, 20260912-090000-fix-cache]`）。依存は同じ project のタスクを参照する
- 解決判定は依存先ファイルの `status` を read して行う:
  - `DONE` → 解決済み
  - `TODO` / `WIP` → 未解決
  - `CANCELLED` → 自動では解決しない。理由を添えて owner に判断を仰ぐ

## 拾う（着手）

1. `grep -l "status: TODO" ~/.pi/agent/tasks/*/*.md` で着手待ちを列挙する
2. `depends:` を持つものは依存関係の規則で ready / blocked を分類する
3. 着手待ちが複数あり owner が対象を指定していないときは、ready と blocked（未解決の依存つき）に分けて列挙し、選ばせる。blocked は着手しない
4. ready な対象を read し、既存の worktree 規約（グローバルまたはプロジェクトの AGENTS.md）に従って worktree と branch を作成する
5. `status` を `TODO` から `WIP` に書き換え、frontmatter に `branch: <branch名>` を追記する。これが着手サインであり、二重着手を防ぐ

## ワークファイルとの紐付け

- 着手したタスクの成果物としてワークファイル（`~/.pi/agent/work/{project}/` 配下の plan・spec・research・review・report・interview）を作るときは、frontmatter に `task: <タスク参照名>`（タスクファイル名から拡張子を除いたもの）を書く
- 紐付けは新しいワークファイルを作るときだけ行い、既存のワークファイルを遡って書き換えない

## WIP 一覧

1. `grep -l "status: WIP" ~/.pi/agent/tasks/*/*.md` で列挙し、各ファイルの `branch:` と `git worktree list` の突き合わせを報告する

## 完了

1. worktree 規約の finish が owner 承認のもと close まで完了した時点で、対応するタスクファイルの `status` を `DONE` に書き換える
2. discard が owner 承認のもと close まで完了した時点で、`status` を `CANCELLED` に書き換える
3. タスクファイルは依存参照（`depends`）と履歴の対象として削除せず残す。成果の記録自体は commit 履歴と完了報告に委ねる

## 不整合の回収

次の不整合を検出したときは、事実と対処候補を owner に報告し、承認を得てから修正する:

- `status: WIP` のタスクファイルに `branch:` が無い、または対応する worktree が存在しない（着手記録の不一致・中断の残骸）
- worktree が存在するのに、その project 配下に `status: WIP` のタスクファイルが無い
- `depends:` に対応するタスクファイル（`<参照>.md`）が同じ project 配下に存在しない（参照の誤りか先行タスクの積み忘れ）

## 対象外

- 人間用のビュー（ボード・レポート）、優先度・割り当て管理、MCP・CLI・pi 拡張ツールの提供はしない。本 SKILL.md の手順が唯一の実装であり、不便が観測されたときは shell 関数、その次に CLI の順で拡張を検討する
- `~/.pi/agent/work/{project}/` のワークファイル戦略は変更しない。ワークファイルは作業の中間成果物、タスクキューは着手待ち・承認待ちの単位を扱う。両者は frontmatter の `task:` で結ぶ
