# AGENTS.md

## 前提

このリポジトリは dotfiles であり、chezmoi でホームディレクトリへ展開する前提で運用する。

## ディレクトリ構成

```
~/projects/dotfiles/          （ワークスペースルート）
├── dotfiles/                 # chezmoi で ~ へ展開する dotfile 群の実体
├── dist/                     # pre-chezmoi.ts が生成（gitignore、編集不可）
├── undotfiles/               # chezmoi 管理外（Nix、VSCode 拡張、winconfig 等）
└── pre-chezmoi.ts            # dotfiles/ → dist/ へ変換コピー
```

データフロー: `dotfiles/` --(pre-chezmoi.ts)--> `dist/` --(chezmoi apply)--> `~/`

編集はこのワークスペース内のみ。`~/xxx`（ホームディレクトリ配下）を直接読み書き・変更してはいけない。

## `dotfiles/` 内の命名規則

`dotfiles/` は人間が読みやすい素の記法で書き、`pre-chezmoi.ts` が `dist/` へのコピー時に chezmoi 記法へ変換する:

| `dotfiles/` 内 | 変換後（`dist/`） | 意味 |
|---|---|---|
| `.xxx` | `dot_xxx` | ドットファイル表現 |
| `xxx.exact`（ディレクトリ） | `exact_xxx` | 完全一致ディレクトリ（`.xxx.exact` → `exact_dot_xxx`） |
| `merge_*.json` / `merge_*.yaml` | `modify_*.json` / `modify_*.yaml` | 独自: `~` の実ファイルと JSON/YAML を深くマージする modify-template |

> **注意**: 相対パス `dotfiles/.pi/agent/skills.exact` は `~/projects/dotfiles/dotfiles/.pi/agent/skills.exact` を指す。ルート直下（`~/projects/dotfiles/.pi/...`）ではない — 同名の `dotfiles/` が二重に現れる点に注意。

## 実行禁止

以下はユーザーが手動で実行するため、エージェントが勝手に実行してはいけない:

- `chezmoi apply` / `chezmoi diff` / `chezmoi managed`
- `just apply` / `just diff` / `just managed`（上記を含む）
- `just nix` / `just vscode` / `just winconfig` 等のシステム変更を伴う just タスク全般

変更はファイル編集のみで完結させ、反映はユーザーに任せること。

## 完了報告

完了報告で、ユーザーが実行する反映操作（`chezmoi apply`、`just apply` など）を案内・誘導してはならない。反映操作は周知の前提であり、完了報告には記載しないこと。

## TypeScript のテスト

TS スクリプトを追加・変更する場合は、原則として隣に `.test.ts` を置き、自動テストできるようにすること。

このリポジトリでは Bun の auto-install で依存を解決する。通常のテストランナー経由だと auto-install が動かないため、Vitest / Jest などは使えない。代わりに、テストスクリプト側で `describe` / `it` 相当の関数を内蔵する形で書くこと。
assertion は自作 helper を作らず、`node:assert/strict` を使うこと。読みやすさは説明変数やテスト名で担保し、assertion の再発明では担保しない。

## dotfiles/.pi

dotfiles/.piを編集するときは必ずdotfiles/.pi/READMEを読む
