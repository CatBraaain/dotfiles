# ticket tools spec

pi と dsh は、同じ 5 tool で `ticket` CLI をラップする。ストア形式、状態遷移、排他、エラーは [ticket.spec.md](ticket.spec.md) が正本であり、tool はストアへ直接アクセスしない。

| tool | CLI |
| --- | --- |
| `ticket_list` | `list` |
| `ticket_show` | `show` |
| `ticket_create` | `create` |
| `ticket_set` | `set` |
| `ticket_edit` | `edit` |

## 共通

- tool は CLI を `--json` なしで実行し、stdout のテキスト（ticket.spec.md のテキスト出力）を tool content にそのまま返す。session cwd を渡し、`project` があれば `--project` に渡す
- read tool の dsh agent-less call は process cwd を CLI cwd にする
- CLI の非 0 exit と実行不能は tool failure として返す。エラーテキストは CLI の stderr（空ならエラーメッセージ）
- pi は `ticket_create`、`ticket_set`、`ticket_edit` を sequential に dispatch する。dsh の default exclusive dispatch と合わせ、同じ assistant response 内の write call は model order で実行する
- pi の tool content は最大 50 KiB または 2,000 行。超過すると先頭を返し、上限・全体量・完全本文を CLI で得る旨を marker に含める。truncation 時は同じ引数に `--json` を付けて read tool だけ再実行し、`details` に CLI の完全 JSON を保持する
- 各 description は対応 CLI、引数、selector の完全 ID / 一意 prefix / `next`、省略時の `next`、project の選択と cwd 既定を説明する

## `ticket_list`

引数は任意の `status: string[]`、`project: string`、`all: boolean`。status が空配列なら未指定と同じで open ticket を返す。0 件は `no tickets` を返す。

## `ticket_show`

引数は任意の `selector: string`、`project: string`。成功時は CLI テキスト出力（`id:`、`status:`、`after:`、`title:` フィールド行、`body:` 区切り、H1 を含む本文）をそのまま返す。上限時は共通の truncation を適用する。

## `ticket_create`

引数は必須の `title: string` と任意の `body: string`、`status: string`、`after: string`、`project: string`。渡された key だけを CLI JSON に含める。成功時は created ID、status、after、path を返す。after は完全 ID または一意 prefix を受け、CLI が完全 ID に正規化する。

## `ticket_set`

引数は任意の `selector: string`、`status: string`、`after: string | null`、`project: string`。status と after がともに無いときは CLI を起動せず失敗する。after と status の連動、明示 status の優先、closed による dependent 解放、after の存在・状態・循環検証は CLI に従う。成功時は updated ID、status、after、path を返す。

## `ticket_edit`

引数は任意の `selector: string`、`project: string` と必須の `old: string`、`new: string`。old は空でない。pi は schema、dsh は local validation で、空 old を CLI 起動前に失敗させる。old と new は `--` の後に literal な位置引数として渡す。成功時は updated ID、status、after、path を返す。
