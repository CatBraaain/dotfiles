# tickets仕様

## 対象と目的

tickets は、pi の LLM に ticket CLI（`dotfiles/.agents/cli.exact/ticket/` の展開先は `~/.agents/cli/ticket`、Windows では `~/.agents/cli/ticket.exe`）の操作手段を tool として提供するpi extension である。5つのチケット操作ツールを `pi.registerTool` で登録する。

ストアとCLIの契約は [ticket CLI仕様](../../../../.agents/cli.exact/ticket/SPEC.md) に従う。本書は、このCLIを呼び出すpi拡張の構成、tool引数の変換、実行、結果とエラー、依存を定める。ストア操作はCLIに委ねる。

## 構成

```text
extensions.exact/tickets/
├── index.ts        # extension 本体
├── index.test.ts   # bun:test によるテスト
└── SPEC.md         # 本ファイル
```

- `index.ts` は、tool登録、tool引数から CLI引数へのマッピング（`buildListArgs` / `buildShowArgs` / `buildCreateArgs` / `buildSetArgs` / `buildEditArgs`）、CLI実行、JSON引数追加（`appendJsonFlag`）、runner型 `TicketCliRunner`、description と promptSnippet の組み立て（`ticketToolDescriptions` / `ticketToolPromptSnippets`）を exportする
- `index.test.ts` は上記export と登録tool の実行経路を検証する。CLI実行は stub CLI と登録Bashのテスト用context で検証し、実際の ticket CLI は呼ばない

## 登録tool

各toolのdescriptionは、対応CLIサブコマンド、引数、selectorの完全ID・一意prefix・`next` と省略時の既定、project選択とcwd既定を説明する。

| tool | 対応CLIサブコマンド | 引数 |
| --- | --- | --- |
| `ticket_list` | `list` | `status`（string[]、任意）/ `project`（string、任意）/ `all`（boolean、任意） |
| `ticket_show` | `show` | `selector`（string、任意。省略時は `next`）/ `project`（string、任意） |
| `ticket_create` | `create` | `title`（string、必須）/ `body`（string、任意）/ `status`（string、任意）/ `after`（string、任意）/ `project`（string、任意） |
| `ticket_set` | `set` | `selector`（string、任意。省略時は `next`）/ `status`（string、任意）/ `after`（string または null、任意）/ `project`（string、任意） |
| `ticket_edit` | `edit` | `selector`（string、任意。省略時は `next`）/ `old`（string、必須・空でない）/ `new`（string、必須）/ `project`（string、任意） |

## CLIへの引数変換

| tool・入力 | CLIへの変換・起動前の検証 |
| --- | --- |
| 共通 | セッションcwdをCLIのcwdに渡す。`project` 指定時は `--project` に渡す |
| `ticket_list` | `status` をCLIのstatus指定に、`all` を全project指定に変換する。空のstatus配列は未指定として渡す。`--json` を付ける |
| `ticket_show` | `selector` を位置引数に渡し、省略時はCLIの既定に従う |
| `ticket_create` | `title`・`body`・`status`・`after` のうち渡されたkeyだけをCLIのJSON引数に含める |
| `ticket_set` | `status`・`after` のうち渡されたkeyだけをCLIのJSON引数に含める。両方未指定ならCLIを起動せず失敗する |
| `ticket_edit` | schemaで空の `old` を起動前に拒否する。`old` と `new` は `--` の後にliteralな位置引数として渡す |

`ticket_set` と `ticket_edit` のselectorも位置引数に渡し、省略時はCLIの既定に従う。

## 実行と中断

5つのtoolのCLI実行は、実行時contextの `ctx.executeTool("bash", ...)` を使い、その時点の登録Bashによるコマンド承認とサンドボックスの対象とする。引数・cwdのliteral変換、分離出力と長文の完全回収は [Tools仕様](../tools/SPEC.md#cliの引数と結果回収) に従う。

Bashツールが未登録、実行時contextが失効、実行が拒否またはキャンセルされた場合はtool failureとして返す。登録Bashを経由しない直接起動には切り替えない。toolの中断を登録Bashへ伝え、CLI実行と出力回収を中断する。

## 結果とエラー

`ticket_list` は CLI を1回実行する。成功時は一覧のJSONから、CLIのテキスト出力と同じ順序・表記・末尾改行で `content` を作る。CLIが成功してもstdoutが有効な一覧のJSONでなければtool failureとして返す。

ほかのtoolは初回に `--json` なしで実行し、成功時はstdoutのテキストを空白・改行も含めて `content` にそのまま格納する。各コマンドのテキスト形式はCLI仕様に従う。

CLIの非0終了と実行不能はtool failureとして返す。CLIのstderrから末尾の改行を1個だけ除いたテキストを `Error` としてthrowし、piがtool呼び出しを失敗として報告する。stderrが空ならエラーメッセージを使う。

toolのcontentは最大50 KiBまたは2,000行とする。上限を超えるときは先頭を返し、上限・全体量・完全本文をCLIで得る旨をmarkerに含める。

- `ticket_list`: 切詰め時は、表示の元になった `ticket list --json` の配列全体を `details` の値にする。切詰めがなければ `details` を設定しない。
- `ticket_show`: 切詰め時は同じ引数に `--json` を付けてCLIを再実行し、`details` に完全JSONを格納する。
- 書込toolは表示の切詰めを理由に再実行しない。

## 書込順序

`ticket_create`・`ticket_set`・`ticket_edit` はsequentialにdispatchし、同じassistant response内の書込callをmodel orderで実行する。

## 依存

| 依存 | 用途 | 場所 |
| --- | --- | --- |
| `typebox` | tool引数の schema | pi本体が拡張向けに提供（`web-search` と同様、`agent/package.json` 未記載） |
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`・`truncateHead` 等の型と関数 | `agent/package.json` の devDependencies |
| `bun:test` / `node:assert/strict` | テスト | `@types/bun`（devDependencies）、Bun組み込み |
