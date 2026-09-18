# tickets 仕様

## 対象と目的

tickets は、pi の LLM に ticket CLI（`dotfiles/.agents/cli/ticket.executable` の展開先 `~/.agents/cli/ticket`）の操作手段を tool として提供する pi extension である。4 つの tool を `pi.registerTool` で登録する。

tool 群の振る舞いの正本は `dotfiles/.agents/cli/ticket-tools.spec.md`、CLI とストアの振る舞いの正本は `dotfiles/.agents/cli/ticket.spec.md` である。この仕様は本 extension の構成・登録 tool・依存のみを定め、振る舞いを再定義しない。

## 構成

```text
extensions.exact/tickets/
├── index.ts        # extension 本体
├── index.test.ts   # bun:test によるテスト
└── SPEC.md         # 本ファイル
```

- `index.ts` は、tool 登録、tool 引数から CLI 引数へのマッピング（`buildListArgs` / `buildShowArgs` / `buildCreateArgs` / `buildUpdateArgs`）、description と promptSnippet の組み立て（`ticketToolDescriptions` / `ticketToolPromptSnippets`）を export する
- `index.test.ts` は上記 export の検証に限定し、CLI の実 spawn は対象外とする
- dsh 側（`dotfiles/.dsh/plugins.exact/tickets/`）が同名・同引数・同振る舞いの tool を登録する（`ticket-tools.spec.md` の「構成」）

## 登録 tool

対応 CLI サブコマンドと引数の意味、ID が接頭辞で一意に特定できることは各 tool の description に含める。`ticket_update` の description には、排他（`locked` への重複変更）と `open` の依存解決の検証で失敗しうることを含める。

| tool | 対応 CLI サブコマンド | 引数 |
| --- | --- | --- |
| `ticket_list` | `list` | `status`（string[]、任意）/ `project`（string、任意）/ `all`（boolean、任意） |
| `ticket_show` | `show` | `id`（string、必須）/ `project`（string、任意） |
| `ticket_create` | `create` | `title`（string、必須）/ `body`（string、任意）/ `status`（string、任意）/ `depends_on`（string[]、任意）/ `project`（string、任意） |
| `ticket_update` | `update` | `id`（string、必須）/ `metadata`（object、任意。キーは `status` と `depends_on` のみ）/ `body`（string、任意）/ `project`（string、任意） |

CLI の実行は `@dotfiles/agent-lib/ticket` の `runTicketCli(args, ctx.cwd, signal)` に委ね、セッション cwd を CLI の cwd として渡す。成功時の tool 結果は `content` に `formatTicket*` のテキスト、`details` に CLI の JSON を格納する。CLI 失敗時（終了コード非ゼロ・spawn 失敗・非 JSON）は `TicketCliError.stderr` のテキストを `Error` として throw し、pi が tool 呼び出しを失敗として報告する。

## 依存

| 依存 | 用途 | 場所 |
| --- | --- | --- |
| `@dotfiles/agent-lib/ticket` | CLI 実行と結果の整形 | `agent/package.json` の dependencies（`file:../../.agents/lib`） |
| `typebox` | tool 引数の schema | pi 本体が拡張向けに提供（`web-search` と同様、`agent/package.json` 未記載） |
| `@earendil-works/pi-coding-agent` | `ExtensionAPI` 等の型 | `agent/package.json` の devDependencies |
| `bun:test` / `node:assert/strict` | テスト | `@types/bun`（devDependencies）、Bun 組み込み |
