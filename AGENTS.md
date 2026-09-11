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
| `xxx.merge.json` / `xxx.merge.yaml` | （完成形 `xxx.json` / `xxx.yaml` を出力） | 独自: ホーム実ファイルと plain base に深くマージする共有 merge レイヤー（詳細は pre-chezmoi.spec.md §7–8） |
| `xxx.merge.local.json` / `xxx.merge.local.yaml` | （完成形 `xxx.json` / `xxx.yaml` を出力） | 独自: merge ターゲットへ最後にマージするマシン固有レイヤー（gitignore） |
| `.pre-chezmoi.ts`（ファイル） | （dist にそのまま残る。chezmoi は無視） | 独自: フォルダ単位の build 時フック。既存変換より前に実行され、フォルダ固有のファイルを生成できる（詳細は pre-chezmoi.spec.md §2） |

> **注意**: 相対パス `dotfiles/.agents/skills.exact` は `~/projects/dotfiles/dotfiles/.agents/skills.exact` を指す。ルート直下（`~/projects/dotfiles/.agents/...`）ではない — 同名の `dotfiles/` が二重に現れる点に注意。

## 実行禁止

以下はユーザーが手動で実行するため、エージェントが勝手に実行してはいけない:

- `chezmoi apply` / `chezmoi diff` / `chezmoi managed`
- `just apply` / `just diff` / `just managed`（上記を含む）
- `just nix` / `just vscode` / `just winconfig` 等のシステム変更を伴う just タスク全般

変更はファイル編集のみで完結させ、反映はユーザーに任せること。

## 完了報告

完了報告で、ユーザーが実行する反映操作（`chezmoi apply`、`just apply` など）を案内・誘導してはならない。反映操作は周知の前提であり、完了報告には記載しないこと。

## TypeScript のテスト

`dotfiles/.pi/` 配下の TS スクリプトを追加・変更する場合は、原則として隣に `.test.ts` を置き、自動テストできるようにすること。`dotfiles/.pi/` 配下以外の TS スクリプト（`pre-chezmoi.ts` 等）にはテストファイルを作成しないこと。テストを書かないこれらのスクリプトの検証は `bunx tsc --noEmit` で代用する。

テストは `bun:test` で書く: `import { describe, it } from "bun:test"`。実行は `cd dotfiles/.pi/agent && bun test`。`bun test` は Bun の auto-install 対象外のため、テストが import する依存は `dotfiles/.pi/agent/package.json` に明示し、`bun install` で解決しておくこと。
assertion は自作 helper を作らず、`node:assert/strict` を使うこと。読みやすさは説明変数やテスト名で担保し、assertion の再発明では担保しない。

## skill の置き場所

自作 skill は `dotfiles/.agents/skills.exact/` に置く。新しい skill を作るときもここに作る。展開先 `~/.agents/skills/` は Agent Skills 標準の共通位置であり、pi を含む複数の harness から読める。

- 外部リポジトリの skill の取り込みは `dotfiles/.agents/skills.exact/` 配下の `.pre-chezmoi.ts` フック + `.pre-chezmoi.skills.yaml` で行う（詳細は同フォルダの `.pre-chezmoi.spec.md`）
- `dotfiles/.pi/agent/skills.exact/` は pi 固有の skill 用の予備。通常は空に保ち、`.keep` で空ディレクトリを維持する（`exact` 属性により、展開先でも `.keep` 以外のファイルが無い状態が保たれる）

## dotfiles/.pi

dotfiles/.piを編集するときは必ずdotfiles/.pi/READMEを読む
dotfiles/.pi/agent/extensions.exact配下のfooter・widgetの文字色は指定がない限りgrayにすること
