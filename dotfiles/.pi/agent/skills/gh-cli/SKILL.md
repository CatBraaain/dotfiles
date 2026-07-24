---
name: gh-cli
description: GitHub CLI (gh) workflow. Use when creating or editing issues/PRs.
---

# GitHub CLI (gh)

Issue/PR を作成する前に、必ずリモートリポジトリのテンプレートを確認すること。

```bash
# テンプレート一覧
gh api repos/:owner/:repo/contents/.github/ISSUE_TEMPLATE 2>/dev/null
gh api repos/:owner/:repo/contents/.github/PULL_REQUEST_TEMPLATE 2>/dev/null

# テンプレート内容（ファイル名を指定）
gh api repos/:owner/:repo/contents/.github/ISSUE_TEMPLATE/bug_report.yml --jq '.content' | base64 -d
```

テンプレートがあれば内容に従うこと。なければ自由に書いてよい。

`:owner/:repo` が不明な場合はユーザーに確認するか、カレントディレクトリが git リポジトリなら `gh repo view --json nameWithOwner --jq .nameWithOwner` で取得できる。

<!-- ponytail: 既存の公開 SKILL を調査して統合を検討する。sbfaulkner/pi-extensions (gh-cli, github-workflow)、sgraaf/sgrapi (github)、shalomb/agent-skills (github-cli)。あとで整理。 -->
