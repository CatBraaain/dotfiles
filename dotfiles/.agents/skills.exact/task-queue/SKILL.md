---
name: task-queue
description: pi 用タスクキューの運用。markdown ファイルと規約だけで、セッション・worktree をまたぐ作業キューを管理する。タスクを積む・拾う・一覧する・完了するとき、~/.pi/agent/tasks/ 配下のタスクファイルを読む・書き換えるとき、「タスクに積んで」「次のタスク拾って」「タスク一覧」「WIP は？」等のキュー操作の依頼で使う。
---

# Task Queue

pi 専用。グローバル AGENTS.md（`~/.pi/agent/AGENTS.md`）の worktree 規約とワークファイル戦略を前提とし、pi 以外の harness からロードされた場合は適用しない。

## ストア

- タスクは `~/.pi/agent/tasks/<project>/<YYYYMMDD-HHMMSS>-<機能名-kebab-case>.md` の 1 ファイル 1 タスク。`<project>` は main worktree（`~/projects/<リポジトリ名>`）のディレクトリ名。リポジトリ外の作業ならカレントディレクトリ名。すべてのタスクは status にかかわらずこの場所にフラットに置く（サブフォルダ分けはしない）
- 日時部分は積むときに `date +%Y%m%d-%H%M%S` で採番する（ローカル時刻）。同一秒のファイルが既にあるときは衝突しなくなるまで +1 秒ずらす。固定幅なので辞書順 = 時系列が保たれ、参照も一意になる
- frontmatter のフィールドは `status`（必須）、`worktree`（そのタスクが worktree と branch を要するか。省略可、省略時 `true`）、`branch`（着手時に追記。`worktree: false` のタスクには書かない）、`depends`（着手を待つ先行タスクの参照。省略可、書式は依存関係の節）のみ
- `status` は TODO（未着手）/ WIP（作業中）/ READY（実装・検証が完了し、worktree 規約の finish の owner 承認待ち）/ DONE（完了）/ CANCELLED（やらないことになった）の 5 種。状態が変わるたびに書き換える
- 本文は冒頭に「このタスクの操作は task-queue skill の規約に従う」の 1 行、続いて `## 目的`（依頼内容の要約。対象リポジトリを含める）と `## 完了条件`（観測可能な受入条件）で構成する

スキーマ例:

```markdown
---
status: TODO
worktree: false
---
このタスクの操作は task-queue skill の規約に従う。

## 目的
<リポジトリ> への <依頼内容の要約>

## 完了条件
<観測可能な条件>
```

## 積む

owner の指示、または作業分解で生じた着手待ち単位に対して:

1. `mkdir -p ~/.pi/agent/tasks/<project>` のうえ、`status: TODO` を書いたタスクファイルを作成する。日時部分はストアの採番規則で採番する
2. 複数単位は 1 単位 1 ファイルに分ける。依存関係があるときは依存関係の節の書式で `depends:` に書く
3. タスクが worktree と branch を要しないとき（単発の調査など）は、frontmatter に `worktree: false` を書く

## 依存関係

- `depends:` は先行タスクの参照（ファイル名から拡張子を除いたもの）を書く。単数はスカラー（例: `depends: 20260911-110523-add-base`）、複数は YAML リスト（例: `depends: [20260911-110523-add-base, 20260912-090000-fix-cache]`）。依存は同じ project のタスクを参照する
- 解決判定は依存先ファイルの `status` を read して行う:
  - `DONE` → 解決済み
  - `TODO` / `WIP` / `READY` → 未解決
  - `CANCELLED` → 自動では解決しない。理由を添えて owner に判断を仰ぐ

## 拾う（着手）

1. `awk 'FNR==1{n=0} /^---$/{n++} n==1 && /^status: TODO$/{print FILENAME}' ~/.pi/agent/tasks/*/*.md` で、frontmatter の `status` から着手待ちを列挙する
2. `depends:` を持つものは依存関係の規則で ready / blocked を分類する
3. 着手待ちが複数あり owner が対象を指定していないときは、ready と blocked（未解決の依存つき）に分けて列挙し、選ばせる。blocked は着手しない
4. 選ばれた対象を read し、`status` がまだ `TODO` であることを確認する。同一 project の拾うは同時 1 セッションを前提とし、衝突は検出しない。すでに `WIP` へ変わっていたら着手せず、手順 1 へ戻る
5. `worktree: false` 以外のタスクは、既存の worktree 規約（グローバルまたはプロジェクトの AGENTS.md）に従って worktree と branch を作成する。`worktree: false` のタスクは worktree を作らず着手する
6. `status` を `TODO` から `WIP` に書き換え、`worktree: false` 以外のタスクは frontmatter に `branch: <branch名>` を追記する。これが着手サインである

## ワークファイルとの紐付け

- 着手したタスクの成果物としてワークファイル（`~/.pi/agent/work/{project}/` 配下の plan・spec・research・review・report・interview）を作るときは、frontmatter に `task: <タスク参照名>`（タスクファイル名から拡張子を除いたもの）を書く
- 紐付けは新しいワークファイルを作るときだけ行い、既存のワークファイルを遡って書き換えない

## WIP 一覧

1. `awk 'FNR==1{n=0} /^---$/{n++} n==1 && /^status: (WIP|READY)$/{print FILENAME}' ~/.pi/agent/tasks/*/*.md` で列挙する。`READY` は承認待ちとして `WIP` と区別して報告する
2. 各ファイルの `branch:` と `git worktree list` の突き合わせに差分があるときは、不整合の回収の手順へ進む

## 完了

1. worktree 規約の finish が owner 承認のもと close まで完了した時点で、対応するタスクファイルの `status` を `DONE` に書き換える
2. discard が owner 承認のもと close まで完了した時点で、`status` を `CANCELLED` に書き換える
3. `worktree: false` のタスクは、完了条件を観測できた時点で `status` を `DONE` に書き換える
4. タスクファイルは依存参照（`depends`）と履歴の対象として削除せず残す。成果の記録自体は commit 履歴と完了報告に委ねる

## 不整合の回収

拾う・WIP 一覧・完了の実行時に、`git worktree list` との突き合わせで次の不整合を検出する。検出したら、事実と対処候補を owner に報告し、承認を得てから修正する:

- `status: WIP` または `READY` のタスクファイルに `branch:` が無い、または対応する worktree が存在しない（着手記録の不一致・中断の残骸）。`worktree: false` のタスクは `branch:` 無し・worktree 無しが正当状態であり、検出対象から除外する
- worktree が存在するのに、その project 配下に `status: WIP` または `READY` のタスクファイルが無い
- `depends:` に対応するタスクファイル（`<参照>.md`）が同じ project 配下に存在しない（参照の誤りか先行タスクの積み忘れ）

## 対象外

- 人間用のビュー（ボード・レポート）、優先度・割り当て管理、MCP・CLI・pi 拡張ツールの提供はしない。本 SKILL.md の手順が唯一の実装であり、不便が観測されたときは shell 関数、その次に CLI の順で拡張を検討する
- `~/.pi/agent/work/{project}/` のワークファイル戦略は変更しない。ワークファイルは作業の中間成果物、タスクキューは着手待ち・承認待ちの単位を扱う。両者は frontmatter の `task:` で結ぶ
