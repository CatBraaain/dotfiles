---
name: dsh-plugins
description: >-
  dsh（DeepSeek Harness）の plugin / bundle を作成・修正・レビュー・調査するときに使う。
  dotfiles/.dsh/plugins.exact/ 配下の TS・SPEC.md・cordis.patch.yml・package.json.dsh を扱うとき、
  dsh の API・型・slot・service・event の仕様を調べるときにも使う。API 仕様の正本は
  ミラー実ファイルであり、このスキルは参照マップとプロジェクト契約の案内役である。
---

# dsh plugins 開発ガイド

dsh（DeepSeek Harness）の plugin 開発のための参照マップと、このリポジトリ固有の契約。
API 仕様や型の詳細はこのファイルに書かない。正本はミラーとリポジトリ内の文書であり、
正しい場所へ到達することがこのスキルの目的。dsh は活発に変化するため、要約を信用せず
参照元を読む。

## 正本

| 正本 | 場所 | 役割 |
|---|---|---|
| dsh 本体の仕様・型・実装 | `~/mirrors/github.com/deepseek-ai/deepseek-harness/` | API・docs の一次情報 |
| リポジトリ運用の契約 | `dotfiles/.dsh/README.md` | ビルド・依存解決・plugin 追加手順。着手前に必ず読む |
| 各 plugin の振る舞い | `dotfiles/.dsh/plugins.exact/*/SPEC.md` | 観測可能な振る舞いの契約。変更時は乖離照合する |

ミラーは master を追わず、**実行環境に適したリリースタグ**に固定する。master は
実行環境より先の API を含むことがある。作業のたびにタグを選んで checkout する:

```sh
dsh --version   # CLI のバージョン。例: 0.1.5-rc.1
git -C ~/mirrors/github.com/deepseek-ai/deepseek-harness ls-remote --tags origin
```

タグ一覧（フィルタせず全件）の中から、現在のバージョンに近いタグを推測して選ぶ:

- 判断材料: CLI のバージョン（`dsh --version`）と、plugin が import する bundle 実体のバージョン（`~/.dsh/profiles/web/bun.lock` の `"@deepseek-ai/dsh-*"`）。両者はずれていることがある
- 完全一致するタグがあればそれを使う。無ければ実行環境に最も近いタグを選ぶ。実行環境より大幅に先のバージョンは避ける
- 選んだタグを `git fetch --depth=1 origin tag <tag> --no-tags` して checkout する。ミラーは shallow clone のため `--depth=1` が必須
- 適切なタグを判断できないときはユーザーに確認する

## 参照マップ（ミラー）

ミラー根を `M/` と略記。パスはタグ `dsh-v0.1.5-rc.2` のコミットで実在確認済み（2026-09）。

### plugin 開発の学習路径

| 目的 | パス |
|---|---|
| 最小 plugin を作る | `M/docs/user/develop/basic/index.md` |
| cordis.yml からの設定受取 | `M/docs/user/develop/basic/config.md` |
| tool を作る（defineTool） | `M/docs/user/develop/basic/tool.md` |
| bundle へのパッケージングと profile への install | `M/docs/user/develop/basic/publish.md` |
| Cordis plugin モデル・lifecycle・inject | `M/docs/user/develop/framework/`（index / service / events） |
| 上級パターン（3 役 capability 等） | `M/docs/user/develop/practice/` |

### 調べ物の索引

| 調べたいこと | パス |
|---|---|
| `ctx` の service・event・lifecycle API | `M/docs/cordis-api/`（生成物。`context.md` が入口） |
| Cordis の概念のハンズオン | `M/docs/cordis-tutorial/`（01〜07 の runnable 例） |
| サブシステムの語彙・wiring | `M/docs/subsystems/`（50 ページ超。該当サブシステム名のファイル） |
| 拡張パターンの骨格 | `M/docs/cookbook/extension-cookbook.md` |
| tool 実装のリファレンス | `M/docs/cookbook/adding-a-tool.md` |
| harness 全体像 | `M/docs/architecture.md` |
| `package.json.dsh` の契約型 | `M/packages/util/package-manifest/src/types.ts` |

注意: `M/docs/` 直下に bundle / client / extensions / hooks / sdk ディレクトリは
存在しない。これらは `M/packages/` 配下のパッケージとして存在する。

### 主要パッケージ

| パッケージ | パス | 役割 |
|---|---|---|
| `@deepseek-ai/dsh-tools` | `M/packages/core/tools/` | tool registry・実行パイプライン。`defineTool` の提供元 |
| `@deepseek-ai/dsh-agent-loop` | `M/packages/core/agent-loop/` | agent loop plugin の本体 |
| `@deepseek-ai/dsh-client-ui-renderer` | `M/packages/client/ui-renderer/` | client plugin が inject する中心。React slot bindings |
| `@deepseek-ai/dsh-client-ui-primitives` | `M/packages/client/ui-primitives/` | React atoms（Button 等）。zero cordis |
| `@deepseek-ai/dsh-client-ui-slots` | `M/packages/client/ui-slots/` | slot registry の純粋コア |
| `@deepseek-ai/dsh-client-modules` | `M/packages/client/modules/` | client module system・`__ModuleLoader__` |
| `@deepseek-ai/dsh-base` | `M/packages/bundle/base/` | profile bundle の第一層。library として import しない |

docs は網羅的でない。正確な契約が必要なときは docs より先に実装を grep する。

## プロジェクト契約（このリポジトリ固有）

詳細の正本は `dotfiles/.dsh/README.md`。要点:

- dsh は **web プロファイルのみ**使用する。plugin の追加先も web プロファイル
- plugin ソースは `dotfiles/.dsh/plugins.exact/`。追加・更新は README の「プラグインの追加・更新」
- エントリは TS で書き `dist/index.js` に build。ビルドは `build.run.sh` が apply の全ターゲット適用後に一括実行
- client half（`src/client/`）を持つ plugin の browser bundle は `lib/client.js` をリポジトリにコミットする。`src/client/` を編集したら README 記載の `bun build` コマンドで再ビルド
- 依存解決には bun 固有の罠がある（transitive 依存の hoist 遮蔽、pnpm の `.gitignore` 除外）。依存構成を変えるときは README の該当節を読む
- テスト: `dotfiles/.dsh/plugins.exact/<plugin>/` で `bun test`。TS 変更には隣接 `.test.ts` を置く（グローバル AGENTS.md の規約）
- client UI の見た目の検証は `dotfiles/.dsh/test/` の fixture。dsh 本体を起動せず light / dark のスクショで確認する。静的 render のため subscription・インタラクションは検証対象外

### 実装サンプル

`dotfiles/.dsh/plugins.exact/` に 12 plugin がある。client half あり 7 つ、bundle のみ 5 つ。
近い機能の plugin を探し、実装と SPEC.md を参照する。

## レビュー時のテスト

plugin 変更のレビュー・検証では、まず `dotfiles/.dsh/test/` の smoke test で dsh web の起動・表示時エラーを自動確認する。判定契約は `dotfiles/.dsh/test/SPEC.md` に定める:

```sh
cd dotfiles/.dsh/test
bun run test:web
```

この smoke test は `dsh web --no-open --port 0` を `script` 経由で起動し、stdout の token 付き URL を readiness として待つ。`playwright-cli` の Chromium で開き、初期表示と reload 後の `console.error`、初期表示と reload 中の uncaught page error が 0 件であることを終了コードで検証する。チャット入力の送信・コマンド実行など **LLM を呼ぶ操作はしない**。browser・dsh web・token を含む一時 log は test 終了時に削除する。

- smoke test が失敗したときの追加調査には `playwright-cli` skill を使う。既定の `chrome` チャネルは未 install のため、`playwright-cli -s=<session> open --browser=chromium "<token URL>"` とする。最初の open で cookie が確立され、以後の操作は認証済みになる
- devtools 相当の追加確認: `console error`（console エラーのみ。`console` で全レベル）、`requests`（network。失敗は `[4xx]` / `[5xx]` ステータス付きで列挙される）
- 確認範囲は**起動と表示まで**: page の render、console error 0、該当 plugin の UI と SPEC.md の照合
- 本体起動なしの静的確認には `dotfiles/.dsh/test/` の fixture を使う
- 手動で dsh web を起動して調査するときも、token 付き URL は認証情報として扱い、検証後は browser の close、dsh web の停止、token を含む log ファイルの削除まで行う

## 作業時の判断軸

1. 新規 plugin: `dotfiles/.dsh/README.md` の手順 → `M/docs/user/develop/basic/` で骨格 → 型は `M/packages/util/package-manifest/src/types.ts`
2. 既存 plugin の変更: まず当該 `SPEC.md` を読み、変更後に乖離がないか照合する
3. 使える slot / service / event の候補が分からない: `M/docs/subsystems/` の該当ページ、ui-renderer / ui-slots の実装、既存 12 plugin の `inject` 一覧
4. 正確な契約が必要: ミラー実装を grep する（docs を信用しきらない）
5. レビュー・検証を求められたら「レビュー時のテスト」に従い dsh web の起動確認まで行う
