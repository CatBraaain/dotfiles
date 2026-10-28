# AGENTS.md

## 前提

このリポジトリは dotfiles であり、独自の build・applyエンジン（`dotfiles-manager/` 配下）でホームディレクトリへ展開する前提で運用する。chezmoi は使用しない。

## ディレクトリ構成

```
~/projects/dotfiles/          （ワークスペースルート）
├── dotfiles/                 # ~ へ展開する dotfile 群の実体
├── dist/                     # dotfiles-manager/src/build.ts が生成（gitignore、編集不可）
├── dotfiles-manager/         # CLI と build・差分検知・適用・フックのエンジン（実装は src/ 配下）
├── undotfiles/               # 管理外（Nix、VSCode 拡張、winconfig 等）
└── justfile                  # apply / diff / managed 等のタスク
```

データフロー: `dotfiles/` --(dotfiles-manager/src/build.ts)--> `dist/` --(dotfiles-manager/src/apply.ts)--> `~/`

編集はこのワークスペース内のみ。`~/xxx`（ホームディレクトリ配下）をユーザーの許可なく直接書き込み・変更してはいけない。この制限は書き込み・変更に適用し、ホームディレクトリ配下のファイルの読み取りは制限しない。

## 正本と展開先

`~/.agents/`・`~/.config/`・`~/.pi/` 等の home 配下のファイルを編集・作成するときは、まず `dotfiles/` 配下に対応する正本を探す。正本があれば展開先を直接変更せず、worktree 戦略に従って正本を編集する。正本が見つからないファイルは管理外として扱い、ask_permission の承認を得てから変更する。

## `dotfiles/` 内の命名規則

`dotfiles/` は人間が読みやすい素の記法で書き、`dotfiles-manager/src/build.ts` が `dist/` を生成する。命名規則と変換仕様の正本は `dotfiles-manager/SPEC.md` とし、`dotfiles/` を編集するときは同仕様を参照する。

> **skills.exact の場所**: `dotfiles/.agents/skills.exact` は `~/projects/dotfiles/dotfiles/.agents/skills.exact` を指す。これは共有skill の編集元であり、プロジェクト専用skill の読み込み先ではない。ルート直下（`~/projects/dotfiles/.agents/...`）とは別の場所である。

## 実行禁止

以下はユーザーが手動で実行するため、エージェントが勝手に実行してはいけない:

- `just apply` / `just diff` / `just managed`
- `just nix` / `just vscode` / `just winconfig` 等のシステム変更を伴うjustタスク全般

変更はファイル編集のみで完結させ、反映はユーザーに任せること。

## 完了報告

完了報告で、ユーザーが実行する反映操作（`just apply` など）を案内・誘導してはならない。反映操作は周知の前提であり、完了報告には記載しないこと。

## コメント

コメントは原則として書かない。ソースコードに限らず、YAML・JSONC・TOML などコメントを書ける設定ファイルでも同じ。

書いてよい例外は3つある。

- グルーピング（ファミリー分け）のための区切りコメント。セクション見出しや区切り線など、区切りの役割だけにする
- 設定ファイルでの、自明でない設定値（マジックナンバーなど）の説明コメント。ソースコードでは許されず、名前のある定数・変数へ置く
- 上流（ライブラリ・OS・API・言語処理系）のバグ・欠陥や制約を回避する非自明なコードへの、理由と出典（issue URL 等）付きの1行コメント。上流が修正されたら外す

## TypeScript のテスト

`dotfiles/.pi/` 配下の TSスクリプトを追加・変更する場合は、原則として隣に `.test.ts` を置き、自動テストできるようにすること。それ以外の TSスクリプト（`dotfiles-manager/src/` 配下のエンジン本体）にはテストファイルを作成しないこと。テストを書かないこれらのスクリプトの検証は `bunx tsc --noEmit` で代用する。

テストは `bun:test` で書く: `import { describe, it } from "bun:test"`。実行は `cd dotfiles/.pi/agent && bun test`。`bun test` は Bun の auto-install対象外のため、テストが importする依存は配置先パッケージの `package.json` に明示し、インストールで解決しておくこと。
assertion は自作helper を作らず、`node:assert/strict` を使うこと。読みやすさは説明変数やテスト名で担保し、assertion の再発明では担保しない。

## skill の編集先と読み込み先

skill の編集先はスコープごとに正本を分ける。

- プロジェクト専用skill は、現在の作業対象リポジトリのルート（worktree使用時はその worktree）の `.agents/skills/` に置く。`dotfiles/.agents/skills.exact/` や `~/.agents/skills/` を候補にしない。
- 共有skill は `dotfiles/.agents/skills.exact/` に置き、build で `~/.agents/skills/` へ展開する。展開先は Agent Skills標準の共通位置であり、pi を含む複数の harness から読める。

- 外部リポジトリの取り込みは external hook（`dotfiles/external.build.ts` とその隣の `external.data.yaml`）が処理する。skill の取り込みは `dotfiles/.agents/skills.exact/external.data.yaml` に定義し、配置先の `.agents` が `remap.data.md` で削除されるOS では fetch も走らない
- `dotfiles/.pi/agent/skills.exact/` は pi固有の skill用の予備。通常は空に保ち、`.keep` で空ディレクトリを維持する（`exact` 属性により、展開先でも `.keep` 以外のファイルが無い状態が保たれる）

skill を読む指示は、ファイルパスではなくskill名で書く。skill を利用するときは、利用可能なskill一覧に提示されたパスから読む。編集先の規則を読み込み先の制限として適用しない。

skillフォルダ内の specファイルは skill と同梱のスクリプトの開発・保守用であり、利用者には提示せず、利用手順から参照させない。`SKILL.md` の利用手順は、配布される文書と assets だけで完結させる。

`dotfiles/` 配下から `~/` へ展開される SKILL.md は、配布先でその skill を利用するコーディングエージェントが読む文書である。dotfiles リポジトリ側の管理事情（取り込み元・ビルド構成・正本のパスなど）は読者に関係しないため、本文に書かない。環境固有の読み替えが必要なときは、利用者が取る行動として書く。

## コーディングエージェントツールの外部CLI実行

外部CLIに依存するコーディングエージェントのツールを実装・変更するときは、呼び出し時に登録されているBashツール経由でCLIを起動し、サンドボックスとコマンド承認を適用する。pi拡張では実行時contextの `ctx.executeTool("bash", ...)` を使う。上書き前の標準Bashツールを新しく生成したり、直接プロセスを起動したりして迂回しない。

## dotfiles/.pi

dotfiles/.piを編集するときは必ずdotfiles/.pi/READMEを読む
dotfiles/.pi/agent/extensions.exact配下のfooter・widgetの文字色は指定がない限りgrayにすること
