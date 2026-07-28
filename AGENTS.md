# AGENTS.md

## 前提

このリポジトリは dotfiles であり、chezmoi でホームディレクトリへ展開する前提で運用する。

## 編集対象

- このワークスペース内のファイルのみ編集すること。`~/xxx`（ホームディレクトリ配下）を直接読み書き・変更してはいけない。
- chezmoi が読む sourceDir は `dist/` だが、`dist/` は `pre-chezmoi.ts` が `dotfiles/` から毎回再生成する成果物（gitignore 済み）なので編集しないこと。実体は `dotfiles/` 配下を編集する。
- chezmoi 管理外の設定は `undotfiles/` 配下。

## 実行禁止

以下はユーザーが手動で実行するため、エージェントが勝手に実行してはいけない:

- `chezmoi apply`
- `chezmoi diff`
- `chezmoi managed`
- `just apply` / `just diff` / `just managed`（上記を含むため）
- `just nix` / `just vscode` / `just winconfig` 等のシステム変更を伴う just タスク全般

変更はファイル編集のみで完結させ、反映はユーザーに任せること。

## TypeScript のテスト

TS スクリプトを追加・変更する場合は、原則として隣に `.test.ts` を置き、自動テストできるようにすること。

このリポジトリでは Bun の auto-install で依存を解決する。通常のテストランナー経由だと auto-install が動かないため、Vitest / Jest などは使えない。代わりに、テストスクリプト側で `describe` / `it` 相当の関数を内蔵する形で書くこと。
