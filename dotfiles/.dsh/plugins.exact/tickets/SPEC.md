# dotfiles-dsh-tickets Spec

## 概要

本 plugin は、ticket CLI（`~/.agents/cli/ticket`）のラッパー tool 5 つを dsh に登録する、pi `tickets` extension の host 移植。tool 群の振る舞いの正本は `dotfiles/.agents/cli/ticket-tools.spec.md`（harness 中立）であり、本 SPEC.md はそれを再定義せず、dsh での実現形（構成・依存・ビルド・結果形式）だけを定める。CLI とストアの仕様は `dotfiles/.agents/cli/ticket.spec.md` が正本。

## 登録する tool

`defineTool`（`@deepseek-ai/dsh-tools`）で登録する。引数の型・意味・CLI 引数へのマッピング・結果テキストは oracle spec の各 tool 表のとおり。

| tool | CLI サブコマンド | 引数 |
| --- | --- | --- |
| `ticket_list` | `list` | `status`（string[]）・`project`・`all`（bool） |
| `ticket_show` | `show [<selector>]` | `selector`・`project` |
| `ticket_create` | `create <json>` | `title`（必須）・`body`・`status`・`after`・`project` |
| `ticket_set` | `set [<selector>] <json>` | `selector`・`status`・`after`（string または null）・`project` |
| `ticket_edit` | `edit [<selector>] <old> <new>` | `selector`・`old`（必須・空でない）・`new`（必須）・`project` |

`create`・`set` に渡す JSON は、tool 引数として与えられたキーのみを含むオブジェクトを `JSON.stringify` した文字列である。`after` の `null`（解除）は `ticket_set` のみで使う。実行は共通 lib（`@dotfiles/agent-lib/ticket`）の `runTicketCli` に委譲する（`--json` 付き spawn・JSON パース・`TicketCliError`）。plugin はストアに直接アクセスしない。

## 結果形式（pi `details` 相当）

| 層 | 内容 |
| --- | --- |
| canonical value（`execute` の戻り値） | CLI の `--json` 出力をパースした JSON そのもの |
| model-facing text（`output.render`） | 共通 lib の `formatTicketList` / `formatTicketShow` / `formatTicketCreated` / `formatTicketUpdated` による整形テキスト（`ticket_list` は `all` 引数を第 2 引数にも渡す。`ticket_set` と `ticket_edit` は `formatTicketUpdated` を使う） |
| 結果詳細（`output.presentationMeta`） | canonical value をそのまま返し、`tool/result` の `result.meta` として永続化する。pi extension の `details` フィールドに相当する機械可読データ |

## セッション cwd

CLI の cwd には、呼び出し元 agent の session header の `cwd`（`exec.agent.session.header.cwd`）を使う。dsh 本体の tool（tool-bash の workdir 解決）や system prompt の `cwd` 変数と同じソース。agent がいない・header に `cwd` がない場合、read tool は `process.cwd()` を使い、write tool は agent session owner を取得できず失敗する。

## エラー

| 条件 | 扱う箇所 | 結果 |
| --- | --- | --- |
| CLI が終了コード 1・spawn 失敗・非 JSON 出力（`TicketCliError`） | `execute` が catch して throw し直す | tool 呼び出しの失敗。エラーテキストは `TicketCliError.stderr`（空なら `message`） |
| `ticket_set` で `status` も `after` もない | `buildSetArgs` が CLI 起動前に throw | tool 呼び出しの失敗（`nothing to set: ...`） |
| `ticket_edit` で `old` が空文字列 | `buildEditArgs` が CLI 起動前に throw | tool 呼び出しの失敗（`old must be a non-empty string`） |

## 構成・依存関係

- `src/index.ts` のみ（client half なし、bundle のみ plugin）。引数マッピング（`buildListArgs` 等）・cwd 解決（`sessionCwd`）・エラー変換（`toToolError`）は純関数として export し、テストはこれを通して検証する
- 依存関係（`dotfiles/.dsh/README.md` の規約どおり）:
  - `dependencies`: `@dotfiles/agent-lib`（`file:../../../.agents/lib`）— 通常 library
  - `peerDependencies` + `devDependencies`: `@deepseek-ai/dsh-tools`（`defineTool`・registry 型。framework package）
  - `devDependencies` のみ: `@deepseek-ai/cordis`（`Context` 型のみ。type-only で bundle に残らない）、`@types/bun`
- `inject` は `tools` のみ

## ビルド

`plugins.exact/run_after_build.sh` の共通コマンドで `src/index.ts` を `dist/index.js` に bundle する。相対 import（`@dotfiles/agent-lib/ticket` は node_modules の symlink 経由で lib の TS ソース）は inline され、`@deepseek-ai/*` は external（実行時に profile closure から解決）。本 plugin 固有の build 設定はなし。

## profile 登録

`dotfiles/.dsh/profiles/web/package.json` の `dependencies`（`file:../../plugins/tickets`）と `dsh.profile.bundles`（`dotfiles-dsh-tickets`、既存の末尾に追加）に追記する。
