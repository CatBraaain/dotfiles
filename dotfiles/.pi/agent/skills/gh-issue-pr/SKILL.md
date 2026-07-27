---
name: gh-issue-pr
description: >-
  Use this skill whenever the user wants to create/edit Github Issue/PR.
---

# GitHub CLI (gh)

Issue や PR を作成する前に、必ずリモートリポジトリのドキュメントと
テンプレートを確認し、受け入れ条件を満たしているか評価する。

## なぜ事前確認が必要か

リポジトリごとにコントリビューション方針・ブランチ戦略・コミット規約・
テンプレートが異なる。方針に合わない PR/Issue は却下され、メンテナと
あなたの時間を無駄にする。事前に確認することで、受け入れられる見込みを
上げ、手戻りを減らせる。

## 1. リポジトリの特定

`:owner/:repo` が不明な場合は、カレントディレクトリの git リポジトリから取得する。

```bash
gh repo view --json nameWithOwner --jq .nameWithOwner
```

以降のコマンドは `:owner/:repo` をこの値に置き換えること。

## 2. ドキュメントの確認

README と CONTRIBUTING.md を取得し、コントリビューション方針を把握する。

```bash
# README
gh api repos/:owner/:repo/readme --jq '.content' | base64 -d

# CONTRIBUTING.md (存在しない場合は空出力になる)
gh api repos/:owner/:repo/contents/CONTRIBUTING.md --jq '.content' 2>/dev/null | base64 -d
```

確認ポイント:

- PR / Issue を受け付けているか（受け付け停止・Discussions 誘導・移行済みでないか）
- ブランチ戦略・コミットメッセージ規約・テスト要件
- 歓迎される変更の種類

## 3. テンプレートの確認

```bash
# テンプレート一覧
gh api repos/:owner/:repo/contents/.github/ISSUE_TEMPLATE 2>/dev/null
gh api repos/:owner/:repo/contents/.github/PULL_REQUEST_TEMPLATE 2>/dev/null

# テンプレート内容（ファイル名を指定）
gh api repos/:owner/:repo/contents/.github/ISSUE_TEMPLATE/bug_report.yml --jq '.content' | base64 -d
```

テンプレートがあれば内容に従う。なければ自由に書いてよい。

## 4. PR 作成

1. 手順 2〜3 を実行し、ドキュメントとテンプレートを確認する
2. 以下を評価し、ユーザーに報告する:
   - PR を受け付けているか
   - ブランチ戦略・コミットメッセージ規約・テスト要件を満たすか
   - 変更内容がコントリビューション方針に合致するか
3. 受け入れ条件を満たしているとユーザーが判断した場合のみ PR を作成する:

```bash
gh pr create --title "<title>" --body "<body>" --base <base-branch>
```

## 5. Issue 作成

1. 手順 2〜3 を実行し、ドキュメントとテンプレートを確認する
2. 以下を評価し、ユーザーに報告する:
   - Issue を受け付けているか（Discussions 誘導でないか）
   - バグ報告・機能要望など、受け付けている種類か
   - テンプレートが要求する再現手順・環境情報を過不足なく含められるか
3. 適切とユーザーが判断した場合のみ Issue を作成する:

```bash
gh issue create --title "<title>" --body "<body>"
```

## 出力方針

評価結果はユーザーに必ず伝える。作成可否と理由、内容の妥当性を報告し、
ユーザーの承認を得てからコマンドを実行する。承認なしに作成しないこと。
