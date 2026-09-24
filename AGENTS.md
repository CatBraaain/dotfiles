# AGENTS.md

## 前提

このリポジトリは dotfiles であり、独自の build・apply エンジン（`scripts/` 配下）でホームディレクトリへ展開する前提で運用する。chezmoi は使用しない。

## ディレクトリ構成

```
~/projects/dotfiles/          （ワークスペースルート）
├── dotfiles/                 # ~ へ展開する dotfile 群の実体
├── dist/                     # scripts/build.ts が生成（gitignore、編集不可）
├── scripts/                  # build・差分検知・適用・フックのエンジン
├── undotfiles/               # 管理外（Nix、VSCode 拡張、winconfig 等）
└── justfile                  # apply / diff / managed 等のタスク
```

データフロー: `dotfiles/` --(scripts/build.ts)--> `dist/` --(scripts/apply.ts)--> `~/`

編集はこのワークスペース内のみ。`~/xxx`（ホームディレクトリ配下）をユーザーの許可なく直接書き込み・変更してはいけない。

## `dotfiles/` 内の命名規則

`dotfiles/` は人間が読みやすい素の記法で書き、`scripts/build.ts` が `dist/` を生成する。命名規則と変換仕様の正本は `~/.pi/agent/work/dotfiles/20260923-233728-dotfiles-manager.spec.md` とし、`dotfiles/` を編集するときは同仕様を参照する。

> **skills.exact の場所**: `dotfiles/.agents/skills.exact` は `~/projects/dotfiles/dotfiles/.agents/skills.exact` を指す。これは共有 skill の編集元であり、プロジェクト専用 skill の読み込み先ではない。ルート直下（`~/projects/dotfiles/.agents/...`）とは別の場所である。

## 実行禁止

以下はユーザーが手動で実行するため、エージェントが勝手に実行してはいけない:

- `just apply` / `just diff` / `just managed`
- `just nix` / `just vscode` / `just winconfig` 等のシステム変更を伴う just タスク全般

変更はファイル編集のみで完結させ、反映はユーザーに任せること。

## 完了報告

完了報告で、ユーザーが実行する反映操作（`just apply` など）を案内・誘導してはならない。反映操作は周知の前提であり、完了報告には記載しないこと。

## TypeScript のテスト

`dotfiles/.pi/` と `dotfiles/.dsh/plugins.exact/` 配下の TS スクリプトを追加・変更する場合は、原則として隣に `.test.ts` を置き、自動テストできるようにすること。この2つ以外の TS スクリプト（`scripts/build.ts` 等のエンジン本体）にはテストファイルを作成しないこと。テストを書かないこれらのスクリプトの検証は `bunx tsc --noEmit` で代用する。

テストは `bun:test` で書く: `import { describe, it } from "bun:test"`。実行は `cd dotfiles/.pi/agent && bun test`、dsh plugin は plugin ディレクトリごとに `cd dotfiles/.dsh/plugins.exact/<plugin> && bun test`。`bun test` は Bun の auto-install 対象外のため、テストが import する依存は配置先パッケージの `package.json` に明示し、インストールで解決しておくこと。
assertion は自作 helper を作らず、`node:assert/strict` を使うこと。読みやすさは説明変数やテスト名で担保し、assertion の再発明では担保しない。

## skill の置き場所

skill はスコープごとに正本を分ける。この規則は skill 本文を読む前に適用する。

- プロジェクト専用 skill は、現在の作業対象リポジトリのルート（worktree 使用時はその worktree）の `.agents/skills/` に置く。`dsh-plugins` の読み込み先は `.agents/skills/dsh-plugins/SKILL.md` に限る。`dotfiles/.agents/skills.exact/` や `~/.agents/skills/` を候補にしない。
- 共有 skill は `dotfiles/.agents/skills.exact/` に置き、build で `~/.agents/skills/` へ展開する。展開先は Agent Skills 標準の共通位置であり、pi を含む複数の harness から読める。

- 外部リポジトリの skill の取り込みは `dotfiles/.build-external.yaml` で行う（build の external fetch ステージ。詳細は正本 spec の §build: external fetch）
- `dotfiles/.pi/agent/skills.exact/` は pi 固有の skill 用の予備。通常は空に保ち、`.keep` で空ディレクトリを維持する（`exact` 属性により、展開先でも `.keep` 以外のファイルが無い状態が保たれる）

skill を読む指示は、ファイルパスではなく skill 名（例: `dsh-plugins` または `/skill:dsh-plugins`）で書く。ファイルを直接読む必要があるときは、現在のリポジトリまたは worktree のルートから `./.agents/skills/dsh-plugins/SKILL.md` を解決する。`~/.agents/skills/...` や `dotfiles/.agents/skills.exact/...` を読み込み先にしない。

## dotfiles/.pi

dotfiles/.piを編集するときは必ずdotfiles/.pi/READMEを読む
dotfiles/.pi/agent/extensions.exact配下のfooter・widgetの文字色は指定がない限りgrayにすること
