# dotfiles-dsh-tickets Spec

## 概要

本 plugin は、ticket CLI（`~/.agents/cli/ticket/`。`bun ~/.agents/cli/ticket` として起動し、bun が package.json の `main` を解決する）のラッパー tool 5 つを dsh に登録する、pi `tickets` extension の host 移植。tool 群の振る舞いの正本は `dotfiles/.agents/cli/ticket-tools.spec.md`（harness 中立）であり、本 SPEC.md はそれを再定義せず、dsh での実現形（構成・依存・ビルド・結果形式）だけを定める。CLI とストアの仕様は `dotfiles/.agents/cli/ticket.spec.md` が正本。

## 登録する tool

`defineTool`（`@deepseek-ai/dsh-tools`）で登録する。引数の型・意味・CLI 引数へのマッピング・結果テキストは oracle spec の各 tool 表のとおり。

| tool | CLI サブコマンド | 引数 |
| --- | --- | --- |
| `ticket_list` | `list` | `status`（string[]）・`project`・`all`（bool） |
| `ticket_show` | `show [<selector>]` | `selector`・`project` |
| `ticket_create` | `create <json>` | `title`（必須）・`body`・`status`・`after`・`project` |
| `ticket_set` | `set [<selector>] <json>` | `selector`・`status`・`after`（string または null）・`project` |
| `ticket_edit` | `edit [<selector>] <old> <new>` | `selector`・`old`（必須・空でない）・`new`（必須）・`project` |

`create`・`set` に渡す JSON は、tool 引数として与えられたキーのみを含むオブジェクトを `JSON.stringify` した文字列である。`after` の `null`（解除）は `ticket_set` のみで使う。実行は CLI の spawn に委譲し、stdout テキストをそのまま tool 結果にする（`--json` は付けない）。plugin はストアに直接アクセスしない。

## 結果形式

| 層 | 内容 |
| --- | --- |
| canonical value（`execute` の戻り値） | CLI のテキスト出力（`ticket.spec.md` の非 `--json` stdout）そのもの |
| model-facing text（`output.render`） | canonical value を 1 個の text content block として渡す |

pi extension が truncation 時に保持する `details`（完全 JSON）は dsh 側では持たない。dsh の tool result truncation は harness 側の責務である。

## セッション cwd

CLI の cwd には、呼び出し元 agent の session header の `cwd`（`exec.agent.session.header.cwd`）を使う。dsh 本体の tool（tool-bash の workdir 解決）や system prompt の `cwd` 変数と同じソース。agent がいない・header に `cwd` がない場合は `process.cwd()` を使う。

## エラー

| 条件 | 扱う箇所 | 結果 |
| --- | --- | --- |
| CLI が終了コード 1・2、spawn 失敗 | `execute` が throw する runner の Error | tool 呼び出しの失敗。エラーテキストは CLI の stderr（空ならエラーメッセージ） |
| `ticket_set` で `status` も `after` もない | `buildSetArgs` が CLI 起動前に throw | tool 呼び出しの失敗（`nothing to set: ...`） |
| `ticket_edit` で `old` が空文字列 | `buildEditArgs` が CLI 起動前に throw | tool 呼び出しの失敗（`old must be a non-empty string`） |

## 構成・依存関係

- `src/index.ts` のみ（client half なし、bundle のみ plugin）。引数マッピング（`buildListArgs` 等）・cwd 解決（`sessionCwd`）は純関数として export し、テストはこれを通して検証する。CLI spawn（`spawnTicketCli`）は runner 型 `TicketCliRunner` の既定実装で、テストは runner を注入して spawn を置き換える
- 依存関係（`dotfiles/.dsh/README.md` の規約どおり）:
  - `peerDependencies` + `devDependencies`: `@deepseek-ai/dsh-tools`（`defineTool`・registry 型。framework package）
  - `devDependencies` のみ: `@deepseek-ai/cordis`（`Context` 型のみ。type-only で bundle に残らない）、`@types/bun`
- `inject` は `tools` のみ

## ビルド

`plugins.exact/build.apply.ts` の共通コマンドで `src/index.ts` を `dist/index.js` に bundle する。`@deepseek-ai/*` は external（実行時に profile closure から解決）。本 plugin 固有の build 設定はなし。

## profile 登録

`dotfiles/.dsh/profiles/web/package.json` の `dependencies`（`file:../../plugins/tickets`）と `dsh.profile.bundles`（`dotfiles-dsh-tickets`、既存の末尾に追加）に追記する。
