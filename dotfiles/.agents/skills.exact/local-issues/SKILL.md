---
name: local-issues
description: >-
  対処すべきこと（発見した問題・依頼外課題・予定した作業）を ~/.pi/agent/issues/ 配下の markdown ファイルで管理する。issue の起票・一覧・着手・更新・完了・取り下げをするとき、「issue にしといて」「あとで直すリストに入れて」「タスク積んどいて」「open の issue 一覧」「あの issue クローズして」等の依頼で使う。作業・レビュー・検証中に、その場で直さない問題（依頼範囲外のバグ、lint 指摘、スペック逸脱など）を見つけたときも、「issue」という語が無くても、記録として残すために使う。GitHub Issues 等の外部 issue トラッカーの操作はしない。
---

# Local Issues

ローカルのIssueを `~/.pi/agent/issues/` で管理する。

## ストア

- 1 issue = 1 markdown ファイル。`~/.pi/agent/issues/<project>/` 配下に置く。`<project>` は対象リポジトリのルートディレクトリ名。リポジトリ外の問題ならカレントディレクトリ名
- ファイル名は `<YYYYMMDD-HHMMSS>-<slug>.md`。`<slug>` は問題を表す kebab-case 英語（例: `memory-leak-in-worker`）。日時部分は起票時刻を `date +%Y%m%d-%H%M%S` で採番し（ローカル時刻）、同一秒のファイルが既にあるときは衝突しなくなるまで +1 秒ずらす
- issue の ID はファイル名から拡張子を除いたもの

## ファイル形式

各Issueは1つのMarkdownファイルとして保存する。

```md
---
status: open
---

# Issue title

Issue body
```

* `status` はfrontmatterで管理する。project はディレクトリで表現するため、frontmatter には書かない
* Issueの内容はMarkdown本文で管理する。タイトルは H1 とし、日本語で書いてよい。本文には必要な見出しだけを足す
* ファイル名やIDの規則は、既存のIssueに合わせる

## いつ使うか

大きく2つ: 対処すべきことを後回しにする瞬間の記録と、明示依頼によるストア操作。

### 発見時に記録する

作業・レビュー・検証中に問題を見つけたが、その文脈では直さない判断になったときに issue を起票する。該当するのは次のようなケース。

* 依頼範囲外の問題（依頼箇所以外のバグ、typo、リンター・フォーマッター・タイプチェック指摘など）。グローバル AGENTS.md の Out-of-Scope Issues 規約が「別課題として扱う」対象と一致する
* owner が後回しを判断した問題（「あとで直して」「今回は置いといて」）
* 現タスクの外で対処すべき懸念（spec 乖離、性能懸念、設計上の疑問）

起票しないのは、その場で直す問題、owner が対処不要と判断した問題。起票してよいか迷うときは owner に確認する。

起票前に同じ `<project>/` 配下の `open` issue を読み、重複があれば新規に起票せず既存 issue の本文に補足を追記する。

起票本文には、後で対処する人が判断できる観測事実（場所・内容・出力）を残す。起票・更新した issue ID は完了報告で列挙する。

### 明示依頼で操作する

「issue にしといて」「あとで直すリストに入れて」「タスク積んどいて」「これやりたい」「open の issue ある？」「これクローズして」「あの issue 取り下げて」等の依頼で、起票・一覧・着手・更新・完了・取り下げを行う。問題に限らず、owner が予定した作業も対処すべきこととして起票する。

## 状態

使用できるstatusは以下の4つ。

* `open`: 未着手
* `wip`: 作業中
* `closed`: 完了
* `cancelled`: 中止

遷移のタイミング:

| タイミング | status |
| --- | --- |
| 起票時 | `open` |
| issue の対処に着手したとき | `wip` |
| 対処が完了し問題が解消したとき | `closed`。commit 等の参照があれば本文に追記する |
| 対処しないことになったとき（重複、意図した挙動、owner 判断） | `cancelled`。理由を本文に追記する |

`open` から `wip` を経由せず直接 `closed` にしてよい（外部要因で解消した場合など）。status の書き換えで本文を書き換えない。

対処に着手するときは `status` を `wip` に書き換えてから着手する。コード修正を伴う対処は、グローバル AGENTS.md の worktree 規約に従い worktree と branch を作って行う。

## 編集

Issueの読み書き・編集には、利用可能なfs toolsを使用する。

本文は必要な箇所だけ編集し、可能な限り既存の内容を維持する。

frontmatterも必要に応じて編集してよい。

frontmatterの完全な保護や構造の維持は保証しない。壊れた場合は内容を確認し、修正する。

## 一覧

frontmatter の `status` から列挙する:

```bash
awk 'FNR==1{n=0} /^---$/{n++} n==1 && /^status: open$/{print FILENAME}' ~/.pi/agent/issues/<project>/*.md
```

`status` の値を変えれば `wip`・`closed` も同様に列挙できる。全 project を横断するときは glob を `~/.pi/agent/issues/*/*.md` にする。owner への一覧では issue ID とタイトル（H1）を報告する。

## 対象外

* GitHub Issues 等の外部 issue トラッカーの操作はしない
* 専用のIssue操作ツール（CLI・MCP）を前提としない
