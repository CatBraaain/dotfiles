---
name: task-queue
description: pi 用タスクキューの運用。markdown ファイルと git だけで、セッション・worktree をまたぐ作業キューを管理する。タスクを積む・拾う・一覧する・完了するとき、「タスクに積んで」「次のタスク拾って」「タスク一覧」「WIP は？」等のキュー操作の依頼で使う。
---

# Task Queue

## ストア

- タスクは `~/.pi/agent/tasks/<project>/<機能名-kebab-case>.md` の 1 ファイル 1 タスク。`<project>` はワークファイル戦略と同じく作業対象リポジトリのルートディレクトリ名（リポジトリ外の作業ならカレントディレクトリ名）。ファイル名は worktree 規約の branch 名と同じ機能名にする
- frontmatter のフィールドは `branch`（着手時に追記する branch 名）のみ。status・assignee・priority は持たない。状態は git から導出する
- 本文は `## 目的`（依頼内容の要約。対象リポジトリを含める）と `## 完了条件`（観測可能な受入条件）で構成する
- 完了したタスクは削除せず `~/.pi/agent/tasks/<project>/archive/` へ移動する。archive 配下は列挙・照会・不整合検出の対象外

スキーマ例:

```markdown
---
branch: add-export-command
---
## 目的
<リポジトリ> への <依頼内容の要約>

## 完了条件
<観測可能な条件>
```

## 積む

owner の指示、または作業分解で生じた着手待ち単位に対して:

1. `mkdir -p ~/.pi/agent/tasks/<project>` のうえ、`branch:` フィールド無しでタスクファイルを作成する
2. 複数単位は 1 単位 1 ファイルに分ける

## 拾う（着手）

1. `grep -L '^branch:' ~/.pi/agent/tasks/*/*.md` で未着手を列挙する
2. 対象を read し、既存の worktree 規約（グローバルまたはプロジェクトの AGENTS.md）に従って worktree と branch を作成する
3. タスクファイルの frontmatter に `branch: <branch名>` を追記する。これが着手サインであり、二重着手を防ぐ
4. 未着手が複数あり owner が対象を指定していないときは、列挙して選ばせる

## WIP 一覧

1. `git worktree list` で現行 worktree（= WIP）を確定する
2. 対応するタスクファイル `~/.pi/agent/tasks/<project>/<branch名>.md` を read して報告する。project は worktree list の実行元リポジトリ名。タスクディレクトリの全走査はしない

## 完了

1. worktree 規約の finish または discard が owner 承認のもと close まで完了した時点で、対応するタスクファイルを `~/.pi/agent/tasks/<project>/archive/` へ移動する。frontmatter は変更しない
2. タスク履歴は archive ファイルに残る。成果の記録自体は commit 履歴と完了報告に委ねる

## 不整合の回収

次の不整合を検出したときは、事実と対処候補を owner に報告し、承認を得てから修正する:

- `~/.pi/agent/tasks/<project>/*.md`（archive 配下を除く）で、worktree が存在しないのに `branch:` を持つタスクファイル（着手中断の残骸）
- worktree が存在するのに `~/.pi/agent/tasks/<リポジトリ名>/` 配下に対応するタスクファイルが無い

## 対象外

- 人間用のビュー（ボード・レポート）、優先度・割り当て管理、MCP や CLI の提供はしない
- `~/.pi/agent/work/{project}/` のワークファイル戦略は変更しない。ワークファイルは作業の中間成果物、タスクキューは着手待ち・承認待ちの単位を扱う
