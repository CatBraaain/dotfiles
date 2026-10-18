# tickets仕様

## 対象と目的

tickets は、pi の LLM に ticket CLI（`dotfiles/.agents/cli.exact/ticket/` の展開先 `~/.agents/cli/ticket`。単一実行ファイルとして直接起動する）の操作手段を tool として提供するpi extension である。5つの tool を `pi.registerTool` で登録する。

tool群と CLI・ストアの振る舞いの正本は `dotfiles/.agents/cli.exact/ticket/SPEC.md` である。この仕様は本extension の構成・登録tool・依存のみを定め、振る舞いを再定義しない。

## 構成

```text
extensions.exact/tickets/
├── index.ts        # extension 本体
├── index.test.ts   # bun:test によるテスト
└── SPEC.md         # 本ファイル
```

- `index.ts` は、tool登録、tool引数から CLI引数へのマッピング（`buildListArgs` / `buildShowArgs` / `buildCreateArgs` / `buildSetArgs` / `buildEditArgs`）、CLI spawn（`spawnTicketCli`、`appendJsonFlag`、runner型 `TicketCliRunner`）、description と promptSnippet の組み立て（`ticketToolDescriptions` / `ticketToolPromptSnippets`）を exportする
- `index.test.ts` は上記export の検証に限定する。CLI spawn は stub CLI projectディレクトリ（`deps.cliDir` 注入）でのみ検証し、実際の ticket CLI は呼ばない
- dsh側（`dotfiles/.dsh/plugins.exact/tickets/`）が同名・同引数・同振る舞いの tool を登録する（`ticket/SPEC.md` の「toolラッパー」）

## 登録tool

対応CLIサブコマンドと引数の意味、ID が接頭辞で一意に特定できることは各tool の description に含める。

| tool | 対応CLIサブコマンド | 引数 |
| --- | --- | --- |
| `ticket_list` | `list` | `status`（string[]、任意）/ `project`（string、任意）/ `all`（boolean、任意） |
| `ticket_show` | `show` | `selector`（string、任意。省略時は `next`）/ `project`（string、任意） |
| `ticket_create` | `create` | `title`（string、必須）/ `body`（string、任意）/ `status`（string、任意）/ `after`（string、任意）/ `project`（string、任意） |
| `ticket_set` | `set` | `selector`（string、任意。省略時は `next`）/ `status`（string、任意）/ `after`（string または null、任意）/ `project`（string、任意） |
| `ticket_edit` | `edit` | `selector`（string、任意。省略時は `next`）/ `old`（string、必須・空でない）/ `new`（string、必須）/ `project`（string、任意） |

CLI の実行は `spawnTicketCli(args, ctx.cwd, signal)`（extension内の runner。tests は `deps.runCli` で置換）に委ね、セッションcwd を CLI の cwd として渡す。成功時の tool結果は `content` に CLI の stdoutテキスト（`ticket/SPEC.md` の非 `--json` 出力）をそのまま格納する。`ticket_list` と `ticket_show` は pi の上限（50 KiB / 2,000行）を超えたとき先頭を返し、同じ引数に `--json` を付けてCLI を再実行し、`details` に完全JSON を格納する。CLI失敗時（終了コード非ゼロ・spawn失敗）は CLI の stderrテキストを `Error` としてthrowし、pi が tool呼び出しを失敗として報告する。

## 依存

| 依存 | 用途 | 場所 |
| --- | --- | --- |
| `typebox` | tool引数の schema | pi本体が拡張向けに提供（`web-search` と同様、`agent/package.json` 未記載） |
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`・`truncateHead` 等の型と関数 | `agent/package.json` の devDependencies |
| `bun:test` / `node:assert/strict` | テスト | `@types/bun`（devDependencies）、Bun組み込み |
