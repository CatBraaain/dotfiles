---
name: git-standard
description: >-
  git の commit・branch・push・PR 運用の規則。コミットを意味単位に分割する、コミットメッセージの規約と scope を定める、リポジトリの branch strategy・contribution ガイドに照合する、OSS への PR の受付可否と適切性を評価する。「コミットして」「コミットを分けて」「push して」「ブランチ切って」「PR 作って」「OSS にコントリビュートしたい」等の git 操作で使う。
---

# Git Standard

git の commit・branch・push・PR に関する判断規則を所有する。リポジトリ固有の規約が、常に本標準の一般規則より優先する。

## 適用条件

- 適用する: commit の作成・分割、commit メッセージの作成、branch の作成・選択、remote への push、PR の作成と適切性評価、外部リポジトリ（OSS 等）への contribution。
- 適用しない: コード変更そのものの品質（readable-code-standard 等）、調査手段の選択（research-strategy）。

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

## コミットの分割

- commit 前に `git status` と `git diff` で変更を俯瞰し、論理単位ごとにまとめる。
- 1 commit = 1 論理的変更。機能追加・バグ修正・リファクタ・フォーマット・ドキュメントなど、意味の異なる変更を混ぜない。
- 意味の異なる変更が混在しているときは `git add -p` 等で分割する。
- 分割すると中間の commit がビルド・テストを通らない変更（依存するリファクタと修正など）は、1 commit にまとめてよい。

### バックアップと一致確認（必須）

分割は add/reset の繰り返しで変更を失いやすい。分割の前後で次の手順を必ず実行する。バックアップ branch 名は以下をそのまま使う。

**1. 分割前 — バックアップの作成**

未コミット変更・untracked ファイルがあるときは、まず一時コミットに固める（既存 commit の分割し直しで未コミット変更がないときは不要）:

```sh
git add -A
git commit -m "WIP: backup before split"
```

バックアップ branch を作る:

```sh
git branch backup/split-$(date +%Y%m%d-%H%M%S)
```

分割開始状態へ戻す:

```sh
git reset --soft HEAD~1        # 未コミット変更をこれから分割してコミットするとき（WIP を解いて staged へ戻す）
git reset --soft <commit>^      # 既存 commit を分割し直すとき（分割対象の最初の commit の親へ戻す。例: git reset --soft abc1234^）
```

**2. 分割後 — 一致確認**

すべてのコミットが終わったら、`git diff` が空であること（ツリー内容が同一であること）を確認する。コミット履歴・ハッシュの一致は不要:

```sh
git diff backup/split-<timestamp> HEAD   # 差分が空であること
git status                               # 分割対象の変更が残っていないこと
```

- 差分が空なら変更を失っていない。バックアップ branch を削除する:

```sh
git branch -D backup/split-<timestamp>
```

- 差分が出たらコミット漏れか誤削除。バックアップへ戻して分割をやり直す:

```sh
git reset --hard backup/split-<timestamp>
```

## コミットメッセージ

リポジトリに規約（Conventional Commits、`.gitmessage`、履歴の慣習）があればそれに従う。規約がないときの scope は「リポジトリのどこを変更したか」を一意に表す領域名にする:

- リポジトリのディレクトリ・モジュール構成に即した名前を使う（例: `frontend`, `backend`, `db`）
- 外部ツールや環境の設定を管理するリポジトリでは、対象システム名を scope にする（例: `ci`, `docker`）。システム配下の機能名単独は対象が一意に定まらないため使わない
- 対応する領域名がない変更は scope を省略する

## branch

branch 名・分岐元は、リポジトリの branch strategy に従う。文書化されていないときは、既存 branch の慣習に従う。

## 実行の境界

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

## Verify

- [ ] git 操作の前にリポジトリ規約を Decision Ladder で確認した
- [ ] commit が論理単位に分割されている
- [ ] 分割前にバックアップ branch を作成した
- [ ] 分割後に `git diff <backup> HEAD` が空であることを確認した
- [ ] commit メッセージがリポジトリ規約（なければ本標準）に従う
- [ ] owner が所属しないリポジトリへの PR の本文に、規約の開示形式（なければ AI 利用の末尾注記）を付けた
- [ ] branch・push が規約と慣習に沿っている
- [ ] force push・履歴の書き換えを行っていない、または承認済みである
- [ ] PR の前に受付可否・手順・スコープ・既存案を評価し、根拠を添えた
