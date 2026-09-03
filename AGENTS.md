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

編集はこのワークスペース内のみ。`~/xxx`（ホームディレクトリ配下）をユーザーの許可なく直接書き込み・変更してはいけない。

## `dotfiles/` 内の命名規則

`dotfiles/` は人間が読みやすい素の記法で書き、`pre-chezmoi.ts` が `dist/` へのコピー時に chezmoi 記法へ変換する:

| `dotfiles/` 内 | 変換後（`dist/`） | 意味 |
|---|---|---|
| `.xxx` | `dot_xxx` | ドットファイル表現 |
| `xxx.exact`（ディレクトリ） | `exact_xxx` | 完全一致ディレクトリ（`.xxx.exact` → `exact_dot_xxx`） |
| `xxx.executable`（ファイル） | `executable_xxx` | 実行可能ファイル（chezmoi はソースの実行ビットを無視するため、名前で指定する） |
| `xxx.merge.json` / `xxx.merge.yaml` | `modify_xxx.json` / `modify_xxx.yaml` | 独自: `~` の実ファイルと JSON/YAML を深くマージする modify-template |
| `xxx.overwrite.json` / `xxx.overwrite.yaml` | （ベースへ統合され消滅） | 独自: 同階層のベース `xxx.json` / `xxx.yaml` へ深くマージする。PC ごとのローカル差分用（gitignore、配列は tier キー単位で丸ごと置換） |

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

TS スクリプトを追加・変更する場合は、原則として隣に `.test.ts` を置き、自動テストできるようにすること。ただし、./pre-chezmoi.tsは除く。

テストは `bun:test` で書く: `import { describe, it } from "bun:test"`。実行は `cd dotfiles/.pi/agent && bun test`。`bun test` は Bun の auto-install 対象外のため、テストが import する依存は `dotfiles/.pi/agent/package.json` に明示し、`bun install` で解決しておくこと。
assertion は自作 helper を作らず、`node:assert/strict` を使うこと。読みやすさは説明変数やテスト名で担保し、assertion の再発明では担保しない。

## dotfiles/.pi

dotfiles/.piを編集するときは必ずdotfiles/.pi/READMEを読む
dotfiles/.pi/agent/extensions.exact配下のfooter・widgetの文字色は指定がない限りgrayにすること
