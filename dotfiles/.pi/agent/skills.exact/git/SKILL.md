---
name: git
description: >-
  git の commit・branch・merge・push・PR 運用の規則。コミットを意味単位に分割する、コミットメッセージの規約と scope を定める、worktree の作成・移行・finish・discard・close、リポジトリの branch strategy・contribution ガイドに照合する、OSS への PR の受付可否と適切性を評価する。「コミットして」「コミットを分けて」「マージして」「push して」「ブランチ切って」「worktree で作業して」「finish this worktree」「discard this worktree (wt)」「close this worktree」「ワークツリーを閉じて」「PR 作って」「OSS にコントリビュートしたい」等の git 操作で使う。
---

# Git

## 適用範囲

git の commit・branch・push・PR に関する判断規則を所有する。

リポジトリ固有の規約が、常に本標準の一般規則より優先する。

- 適用する: commit の作成・分割、commit メッセージの作成、branch の作成・選択、worktree の作成とセッションの移行、worktree ブランチの統合、worktree の finish・discard・close、remote への push、PR の作成と適切性評価、外部リポジトリ（OSS 等）への contribution。
- 適用しない: コード変更そのものの品質（readable-code 等）、調査手段の選択（research-strategy）。

## Decision Ladder: リポジトリ規約の確認

git 操作の前に、このラダーで対象リポジトリの規約を特定する。

目標: branch 運用・commit 規約・PR 手順を、観測可能な根拠（ドキュメントの該当箇所・履歴）で特定する。

最初に成立する段で止まる。

1. 条件: ローカルのリポジトリに規約を述べたドキュメントがあり、branch・commit・PR の必要な規約が特定できるか？
   行動: CONTRIBUTING.md、`.github/`（CONTRIBUTING、PULL_REQUEST_TEMPLATE、ISSUE_TEMPLATE）、`docs/`、README、`.gitmessage`、AGENTS.md から branch strategy・commit 規約・PR 手順を読む。
2. 条件: ドキュメントに規約がなく、同一形式のコミット・branch 名が履歴に繰り返し現れ、慣習が一貫して観測できるか？
   行動: `git log --oneline -20`、`git branch -a`、直近の merge commit から、メッセージ形式・branch 命名・PR 運用の実績を読む。
3. 条件: 外部リポジトリへの contribution で、ローカルに案内がないか？
   行動: 公式の contribution guide・issue tracker から、PR 受付可否、issue 先行の要否、CLA/DCO 署名要件、AI 利用の可否と開示要件を確認する。手段の選択は research-strategy に従う。
4. 条件: 前段までで規約を特定できないか？
   行動: 本標準の一般規則を適用する。その後も判断が分かれる点は、質問して止まる。

検証: 特定した規約と根拠（ドキュメントの該当箇所・履歴の観測・公式情報）を確認する。

## コミットの作成と分割

### 標準手順

1. `git status` と `git diff HEAD` で、ステージ済み・未ステージ・未追跡を含む変更を確認する。
2. `git branch --show-current` で現在の branch を確認し、branch を移動しない。
3. 変更がある場合のみ、現在の `HEAD` を `backup/<現在のbranch名>-<yyyymmddhhmmss>` に保存する。`git branch <バックアップbranch名> HEAD` で作成し、バックアップのために branch を移動しない。
4. 変更を独立して review・revert できる目的または意味の単位へ分ける。`1 commit = 1 論理的変更` とし、分割すると中間の commit が成立しない密接な変更は同じ commit にまとめる。
5. 各単位の変更内容と既存の commit 履歴を確認して、リポジトリ規約に従うコミットメッセージを決める。
6. 各単位に必要なファイルだけを明示して stage し、`git diff --cached` で確認してから commit する。意味の異なる変更が混在するときは `git add -p` 等で分割する。
7. すべての commit の後に `git status` と `git log -n <作成したcommit数>` を確認する。

### 分割時のバックアップと一致確認（必須）

add/reset によって分割する場合、確認済みの分割対象を一時 commit にしてから、次の手順で内容の一致を確認する。既存 commit を分割し直す場合は、未コミット変更を一時 commit にしない。

**1. 分割前 — バックアップの作成**

```sh
git add <確認済みの分割対象>
git commit -m "WIP: backup before split"
git branch backup/split-$(date +%Y%m%d-%H%M%S)
```

分割開始状態へ戻す:

```sh
git reset --soft HEAD~1        # 未コミット変更をこれから分割して commit するとき（WIP を解いて staged へ戻す）
git reset --soft <commit>^      # 既存 commit を分割し直すとき（分割対象の最初の commit の親へ戻す。例: git reset --soft abc1234^）
```

**2. 分割後 — 一致確認**

```sh
git diff backup/split-<timestamp> HEAD   # 差分が空であること
git status                               # 分割対象の変更が残っていないこと
```

- 差分が空なら変更を失っていない。バックアップ branch を削除する:

```sh
git branch -D backup/split-<timestamp>
```

- 差分が出たらコミット漏れか誤削除である。バックアップへ戻して分割をやり直す:

```sh
git reset --hard backup/split-<timestamp>
```

### コミット作成の境界

- コミットメッセージはリポジトリの規約に従う。規約がない場合は Conventional Commits に従い、`feat`、`fix`、`refactor`、`chore`、`docs`、`style`、`test`、`build`、`ci`、`perf` などから変更の意味に合う `type` を選ぶ。言語は `git log` で確認した履歴で優勢なものを使う。
- 機密情報、生成物、意図しない変更を commit しない。owner が明示していない既存の変更を編集・削除・破棄しない。
- `git add .` と `git add -A` で無関係な変更をまとめて stage しない。既存 commit の amend、rebase、squash、またはこの節の分割手順以外の reset はしない。
- 変更がない場合は、バックアップ branch も commit も作成せず、その旨を報告する。
- 安全に判断できる場合は commit 作成前に確認を求めない。判断できない変更または危険な変更がある場合は、commit せずに停止して確認を求める。

### コミット作成の出力

作成した commit ごとに、commit hash、commit message、含めた変更の概要を報告する。未コミットの変更が残る場合は理由も報告する。

## コミットメッセージ

リポジトリに規約（Conventional Commits、`.gitmessage`、履歴の慣習）があればそれに従う。規約がないときの scope は「リポジトリのどこを変更したか」を一意に表す領域名にする:

- リポジトリのディレクトリ・モジュール構成に即した名前を使う（例: `frontend`, `backend`, `db`）
- 外部ツールや環境の設定を管理するリポジトリでは、対象システム名を scope にする（例: `ci`, `docker`）。システム配下の機能名単独は対象が一意に定まらないため使わない
- 対応する領域名がない変更は scope を省略する

## branch

branch 名・分岐元は、リポジトリの branch strategy に従う。文書化されていないときは、既存 branch の慣習に従う。

## worktree の作成と移行

編集を伴う作業を着手するときは、並行セッションと干渉しないよう worktree を作成してセッションを移す。

1. branch 名は取り組む機能を表す kebab-case 英語（例: `ext-worktree-finish`）。リポジトリ規約があれば優先する。
2. `git worktree add ~/projects/<リポジトリ名>-<branch> -b <branch>` で HEAD から worktree を作成する。
3. 未コミット変更があるときは `git stash push -u -m worktree-migration:<branch>` で退避する。
4. `cd` ツールでセッションを worktree へ移す。bash の `cd` はシェルごとに閉じるため、セッションの cwd は変わらない。
5. 退避した変更は worktree 側で `git stash pop` で受け取る。

main へ戻るときも `cd` ツールを使う。未コミット変更の持ち帰りも同じく stash 経由。worktree と branch はそのまま残る。

## worktree ブランチの統合

`git worktree` で運用するローカルの使い捨てブランチを統合先（main 等）へマージするときは、履歴を線形に保つ。

1. 統合先で `git merge --ff-only <branch>` を実行する。worktree セッションのまま `git -C <main worktree のパス> merge --ff-only <branch>` でも実行できる。
2. 統合先が diverge して失敗するときは、対象ブランチを `git rebase <統合先>` してから再度 ff-only マージする。
3. `--no-ff` による merge commit と `--squash` による squash 統合は行わない。

- 適用する: ローカルの使い捨て worktree ブランチの統合。この統合のための rebase は、「コミットの作成と分割」の rebase 禁止の対象外とする。
- 適用しない: remote へ push 済みで共有しているブランチ。トポロジーとして作業のまとまりを記録したいタスクは、worktree ではなく PR で統合する。

検証: 統合後に `git log --graph --oneline -n <統合した commit 数 + 2>` を確認し、merge commit がなく線形であること。

## worktree の finish・discard・close

ローカルの使い捨て worktree を閉じるときは、次の3語で区別する。

| 言葉 | 意味 | 手順 |
| --- | --- | --- |
| finish | 成果を統合先へ取り込んで閉じる | commit → 統合 → main へ戻る → close |
| discard | 変更と branch を捨てて閉じる | main へ戻る → close（`--force`・`-D`） |
| close | VSCode のワークスペースから外し、worktree と branch を削除する | 下記の手順 |

### finish

1. worktree 内の変更を確認し、あれば「コミットの作成と分割」に従って commit する。手順3の backup branch は、close で worktree ごと削除するため作らない。
2. 「worktree ブランチの統合」に従って統合先へマージする。worktree セッションのまま `git -C` で実行してよい。
3. `cd` ツールで main worktree へ戻る。
4. close の手順を実行する。

### discard

owner が discard を明示した指示のときだけ実行する。

1. worktree の branch 名と未コミット変更を確認し、捨てる対象を特定する。
2. `cd` ツールで main worktree へ戻る。未コミット変更・branch はその場に残る。
3. close の手順を `--force` と `-D` で実行する。

### close

main worktree 側にいる状態で実行する。自分がいる worktree は削除できないため、worktree セッションのまま実行しない。

1. `code --remove <worktree のパス>` で、最後のアクティブウィンドウのワークスペースから外す。この操作は常に最後のアクティブウィンドウに作用する。
2. `git worktree remove <worktree のパス>` で worktree を削除する。未コミット変更が残って失敗するときは、finish で commit するか、discard の `--force` を使う。
3. `git branch -d <branch>` で、worktree が checkout していた branch を削除する。未マージで失敗するときは、finish で統合するか、discard の `-D` を使う。
4. `git worktree list` に prunable な参照が残っていれば、`git worktree prune` を実行する。

検証: `git worktree list` に対象 worktree がなく、`git branch --list <branch>` が空であること。

### 閉じ忘れの点検

worktree の自動掃除は行われない。作業完了時は finish か discard まで実行する。中途終了で残った worktree は `git worktree list` で点検する。

### 指示の解釈

finish・discard を指定しない閉じる指示では、未コミット変更または未マージの branch があるとき finish か discard かを質問し、どちらもなければ close だけを実行する。

## 実行の境界

- coding agent の変更は、owner が staged/unstaged の状態で管理・レビューする。owner が明示的に staging、commit の作成・分割など staging を必要とする操作を指示した場合を除き、`git add` 等で変更を staged にしてはならない。
- remote への push と PR の作成は、明示的な指示があるときだけ行う。
- 共有 branch への force push・履歴の書き換えは、owner の承認があるまで行わない。

## PR の適切性

PR を作る前に、次を評価する。

| 観点 | 確認すること | 根拠の例 |
| --- | --- | --- |
| 受付可否 | PR・issue を受け付けているか | archive 状態、contributing guide、maintainer の発言 |
| 手順 | 要求される手順を満たすか | issue 先行、discussion、CLA/DCO 署名 |
| スコープ | 変更が1目的にまとまっているか | コミット分割と同じ論理単位で分割できるか |
| 既存案 | 同一変更の PR・issue が既にないか | issue・PR 検索 |

## 外部リポジトリへの PR での AI 利用の開示

owner が所属しないリポジトリへの PR でのみ適用する。所属リポジトリへの PR には付けない。

- PR 本文の末尾に、次の形式の trailer を付ける:

  ```
  Assisted-by: pi:glm-5.3
  ```

  モデル名は `PI_MODEL` 環境変数の値を使う。pi 以外のツールなら `<tool>:<model>` の形式で実態を書く。

## 出力

- PR の適切性評価は、観点ごとの結果と根拠（リンク・該当箇所）を表で出す。未評価の観点を残したまま「問題ない」と結論しない。
