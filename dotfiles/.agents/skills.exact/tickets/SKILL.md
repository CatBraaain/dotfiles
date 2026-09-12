---
name: tickets
description: >-
  対処すべきこと（発見した問題・依頼外課題・予定した作業）を ~/.pi/agent/tickets/ 配下の markdown ファイルで管理する。ticket の起票・一覧・着手・更新・完了・取り下げをするとき、「チケットにしといて」「ticket にしといて」「あとで直すリストに入れて」「タスク積んどいて」「open の ticket 一覧」「あの ticket クローズして」等の依頼で使う。作業・レビュー・検証中に、その場で直さない問題（依頼範囲外のバグ、lint 指摘、スペック逸脱など）を見つけたときも、「ticket」という語が無くても、記録として残すために使う。GitHub Issues 等の外部トラッカーの操作はしない。
---

# Local Tickets

ローカルのチケットを `~/.pi/agent/tickets/` で管理する。

## ストア

- 1 ticket = 1 markdown ファイル。`~/.pi/agent/tickets/<project>/` 配下に置く。`<project>` は対象リポジトリのルートディレクトリ名。リポジトリ外の問題ならカレントディレクトリ名
- ファイル名は `<YYYYMMDD-HHMMSS>-<slug>.md`。`<slug>` は問題を表す kebab-case 英語（例: `memory-leak-in-worker`）。日時部分は起票時刻を `date +%Y%m%d-%H%M%S` で採番し（ローカル時刻）、同一秒のファイルが既にあるときは衝突しなくなるまで +1 秒ずらす
- ticket の ID はファイル名から拡張子を除いたもの

## ファイル形式

各Ticketは1つのMarkdownファイルとして保存する。

```md
---
status: open
---

# Ticket title

Ticket body
```

* `status` はfrontmatterで管理する。project はディレクトリで表現するため、frontmatter には書かない
* Ticketの内容はMarkdown本文で管理する。タイトルは H1 とし、日本語で書いてよい。本文には必要な見出しだけを足す
* ファイル名やIDの規則は、既存のTicketに合わせる

## いつ使うか

大きく2つ: 対処すべきことを後回しにする瞬間の記録と、明示依頼によるストア操作。

### 発見時に記録する

作業・レビュー・検証中に問題を見つけたが、その文脈では直さない判断になったときに ticket を起票する。該当するのは次のようなケース。

* 依頼範囲外の問題（依頼箇所以外のバグ、typo、リンター・フォーマッター・タイプチェック指摘など）。グローバル AGENTS.md の Out-of-Scope Tickets 規約が「別課題として扱う」対象と一致する
* owner が後回しを判断した問題（「あとで直して」「今回は置いといて」）
* 現タスクの外で対処すべき懸念（spec 乖離、性能懸念、設計上の疑問）

起票しないのは、その場で直す問題、owner が対処不要と判断した問題。起票してよいか迷うときは owner に確認する。

起票前に同じ `<project>/` 配下の `open` ticket を読み、重複があれば新規に起票せず既存 ticket の本文に補足を追記する。

起票本文には、後で対処する人が判断できる観測事実（場所・内容・出力）を残す。起票・更新した ticket ID は完了報告で列挙する。

### 明示依頼で操作する

「ticket にしといて」「あとで直すリストに入れて」「タスク積んどいて」「これやりたい」「open の ticket ある？」「これクローズして」「あの ticket 取り下げて」等の依頼で、起票・一覧・着手・更新・完了・取り下げを行う。問題に限らず、owner が予定した作業も対処すべきこととして起票する。

## 状態

使用できるstatusは以下の4つ。

* `open`: 未着手
* `locked`: 別のセッションが対処を保持している（排他）。着手しない
* `closed`: 完了
* `cancelled`: 中止

遷移のタイミング:

| タイミング | status |
| --- | --- |
| 起票時 | `open` |
| ticket の対処に着手したとき（調査を含む） | `locked` |
| 対処が完了し問題が解消したとき | `closed`。commit 等の参照があれば本文に追記する |
| 対処しないことになったとき（重複、意図した挙動、owner 判断） | `cancelled`。理由を本文に追記する |

`open` から `locked` を経由せず直接 `closed` にしてよい（外部要因で解消した場合など）。status の書き換えで本文を書き換えない。

対処に着手するときは、まず owner の承認を得る。agent が自ら選んだ ticket では、ticket ID、タイトル、内容の要約、考えている進め方を示して承認を求める。owner が特定の ticket を明示した依頼なら、依頼自体が承認にあたる。着手してよいのは `status: open` の ticket のみで、`locked` には着手しない。承認を得たら、ファイル編集の開始を待たず、調査など対処に向けた作業を始めた時点で `status` を `locked` に書き換えて着手する。同じ ticket への重複着手（バッティング）を防ぐため。コード修正を伴う対処は、グローバル AGENTS.md の worktree 規約に従い worktree と branch を作って行う。

`locked` は着手したセッションが対処を完了（`closed`）または取り下げ（`cancelled`）した時点で外れる。異常終了などで `locked` が残ったときは、owner の指示で `open` に戻す。

## 編集

Ticketの読み書き・編集には、利用可能なfs toolsを使用する。

本文は必要な箇所だけ編集し、可能な限り既存の内容を維持する。

frontmatterも必要に応じて編集してよい。

frontmatterの完全な保護や構造の維持は保証しない。壊れた場合は内容を確認し、修正する。

## 一覧

frontmatter の `status` から列挙する:

```bash
awk 'FNR==1{n=0} /^---$/{n++} n==1 && /^status: open$/{print FILENAME}' ~/.pi/agent/tickets/<project>/*.md
```

`status` の値を変えれば `locked`・`closed` も同様に列挙できる。全 project を横断するときは glob を `~/.pi/agent/tickets/*/*.md` にする。owner への一覧では ticket ID とタイトル（H1）を報告する。

## 対象外

* GitHub Issues 等の外部トラッカーの操作はしない
* 専用のTicket操作ツール（CLI・MCP）を前提としない
