# tool-renderer — 仕様書

pi のツール呼び出しの表示（コール行と結果行）を1つの拡張で担う。ツール拡張はロジックと `details` の生成だけを持ち、見た目はこの拡張に集約する。表示はツールの実行結果を変更せず、pi TUI の renderer だけを置き換える。

## 仕組み

- `pi.registerToolRenderer` で resolver を1本登録し、ツール名ごとの `renderCall` / `renderResult` を返す。
- 対象ツール: `bash` `read` `write` `edit` `grep` `find` `ls` `ask_permission` `codemode` `web_search` `web_fetch` `subagent` `replace_context` `session_search` `create_detached_session`。
- 登録にないツール名は `next()` に委譲する。描画は残りの resolver → 登録済みツール自身の renderer → pi既定の順で解決されるため、本拡張が未知のツールの表示を壊さない。
- 描画は結果の `details` と content から宣言的に行う。`tool_execution_*` イベントを描画のトリガーにしない。スクロールバックや HTML export の再描画でも同じ出力になる。
- 描画実装と resolver API の互換型は `index.ts` に置く。テキスト表示は共通の描画手順を使い、ツールごとの差をコール行・結果行の定義で表す。main agent と subagent の Actions は同じコール行・成功サマリーの整形処理を使う。
- pi 1.4 の resolver API を使う。開発用にピン留めした pi-coding-agent（1.0.0）に無い API型は拡張内で定義する。

## details 契約

各ツール拡張が定義して返す通常のツール結果（`content`・`details`）を pi 経由で受け取り、描画する。結果の型は生成側、描画専用の state と整形用の型は本拡張に置く。

## 共通の表示

- 実行中表示は `Running...`。
- エラー表示はエラーメッセージの先頭3行。4行目以降がある場合は、3行目の後に `…` を表示する。
- 成功時の折りたたみ表示はツールごとのサマリー（以下の各節）。展開時は結果本体を表示する。

## パス表示（コール行）

この節は、main agent と subagent のコール行に表示するパスを確認するユーザーを読者とする。対象は `read`、`write`、`edit`、`grep`、`find`、`ls` であり、作業ディレクトリはそのツールを実行するセッションの cwd である。

パスを表示するコール行では、入力パスを cwd から解決して次の形式で表示する。

| 解決先 | 表示 |
| --- | --- |
| cwd自体 | `.` |
| cwd の配下 | cwd からの相対パス（`./` から始める。例: `./childfolder`） |
| cwd の親またはそれ以外 | 絶対パス（ホーム配下は `~` から始める） |

`grep` と `find` はパターンに続けて `in <表示パス>` を表示し、path未指定時は cwd を表示する。

`read` がスキル名を表示する既存の形式では、パスを表示しない。

## bash / write / edit / read / grep / find / ls / ask_permission

| ツール | コール行 | 折りたたみ時の成功サマリー | 展開時 |
| --- | --- | --- | --- |
| `bash` | `$ <command>`（300文字で切り詰め） | 実行秒数（例: `1.2s`） | stdout/stderr |
| `write` | `write <path>` | `wrote <size>` | 書き込んだ内容 |
| `edit` | `edit <path>` | `edited N block(s)` | diff |
| `read` | `read <path>`（SKILL.md のとき `[skill] <name>`） | `N lines`。画像ファイルのときは `image input`（画像入力非対応モデルのときはエラー） | ファイル内容、画像、またはエラー |
| `grep` | `grep <pattern>` | `N matches`（context行を含まない純マッチ数） | マッチ結果（context行を含む） |
| `find` | `find <pattern>` | `N files` | パス一覧 |
| `ls` | `ls <path>`（未指定は `.`） | `N entries` | エントリ一覧 |
| `ask_permission` | `ask_permission <path>`（`command` のとき `ask_permission <command>`。いずれも80文字で切り詰め） | `granted` / `already granted`。`denied`（理由入力があれば `denied — <理由>` の形式で理由を80文字に切り詰めて併記） | 結果テキスト |

bash の追加規則:

- 実行中は、直近の stderr 行を進捗として表示する。1行も届いていないときは `Running...`。stderr の行単位の送出は guardrail 拡張が担う（guardrail SPEC §7）。
- 実行秒数は renderCall が実行開始時に記録した時刻と最終結果から求める。履歴を再表示しても同じ秒数を表示する。

## codemode

`codemode` の結果表示は本拡張で管理する。サマリーはスクリプト全体の経過時間、本文はスクリプトが出力したテキスト・画像を指す。呼び出し一覧はスクリプトから呼んだツールの状態・引数・時間・費用を示す詳細である。

標準表示とは、利用中の pi が提供する組込codemode の表示である。呼び出し一覧にはツール名・引数・状態・計測できた時間と費用が含まれ、失敗とキャンセルは状態の印で区別する。スクリプト失敗時には診断本文をエラー色で示す。本文は折りたたみ時にプレビュー、展開時に全文となり、切り詰めた出力の全文ファイルがあればその案内を含む。

| 状態 | 表示 |
| --- | --- |
| 正常終了・折りたたみ・経過時間あり | サマリーは `1.2s` のような小数1桁の秒数だけ。その下に標準の本文プレビューを表示する。呼び出し一覧と費用集計は展開時に表示する |
| 正常終了・展開 | 秒数のサマリーと、標準の呼び出し一覧・本文全文を表示する |
| スクリプト失敗 | 標準の失敗表示・呼び出し一覧・診断本文を表示する |
| 呼び出したツールに失敗またはキャンセルあり | スクリプトが例外を捕捉して正常終了しても、標準の呼び出し一覧と本文を表示し、失敗・キャンセルを判別できる |
| 実行中（部分結果・partial） | 標準の呼び出し一覧による進捗表示を維持し、本文は確定時に表示する。確定前の秒数は表示しない |
| 正常終了・経過時間を取得できない結果 | 標準の結果表示を維持する |

経過時間はスクリプト全体の計測値を使う。並列で呼んだツールの時間を合計せず、履歴を再表示しても同じ秒数を表示する。秒数の丸め精度は bash の結果サマリーとそろえる。空の本文でも、経過時間があれば秒数を表示する。

本文の色・改行・画像表示・折りたたみ時の行数制限・展開時の全文表示・全文ファイルへの案内は標準表示に従う。呼び出し欄のコード表示も標準に従う。

短縮は、登録された codemode ツールの renderer を resolver チェーン（`next()`）から受け取り、その外側に秒数サマリーを足す形で行う。codemode本体には pi標準のスクリプト実装を使い、短縮は対話画面の結果表示だけに適用する。短縮の適用は本拡張のロードだけに依存し、guardrail の有効状態に従わない。ツールを使用可能にする選択と codemode の動作設定は pi標準に従う。スクリプトの実行結果、ツールの使用条件、入れ子のツール呼び出し、権限確認、フック、store、モデル機能、セッションへの保存内容は pi標準の codemode と同じである。内部から呼ぶfs/bash は各ツールのアクセス制御と実行規則に従う。

## web_search / web_fetch

### コール行（実行開始時）

ツール名に続けて入力を記載：`web_search - "<クエリ>"`（`lang` 指定時は末尾に ` [lang=<lang>]`）/ `web_fetch - "<URL>"`。

### 結果行（実行完了時）

成功時は `✓` に続けて成功したengine または backend名を置く。web_fetch成功時はタイトルがあるとき ` - "<タイトル>"` を続ける。行末に CLI の実測所要時間を ` (1.2s)` 形式で付ける。

| 状態 | 出力 |
| --- | --- |
| 成功（web_search） | `✓ <engine> (1.2s)` |
| 成功（web_fetch、タイトルあり） | `✓ <backend> - "<タイトル>" (1.2s)` |
| 成功（web_fetch、fallbackあり） | `✓ <backend> [- "<タイトル>"] (fallback: <backend>: <error>; ...) (1.2s)` |
| 成功（web_fetch、タイトルなし） | `✓ <backend> (1.2s)` |
| 失敗 | `✗ <CLI名> - "<エラーメッセージ>"` |

失敗行のエラーメッセージは CLI の stderr（全backend失敗の理由に、再試行と camoufox server手動復旧のヒントが含まれることがある。CLI spec「共通の振る舞い」）をそのまま引用する。CLI の JSON に試行（attempts）一覧が無いため、バックエンド試行を1行ずつ列挙する表示は行わない。

最終結果の `details` が空のとき（throw 前に `onUpdate` で通知したエラーdetails を使う場面）、render state に記憶した最後の details を代わりに使う。空の details で state の内容を置き換えない。

## subagent

subagent の呼び出し時と実行結果を、次の形式で表示する。実行結果は subagentツールの結果欄に子エージェントごとの実行ブロックとして表示する。折りたたみは行わない。子からのイベント（`message_end`・ツール実行の開始・更新・終了）は毎回受領して記録する一方、表示の更新は 0.15秒に1回までに間引き、間引き中のイベントは最新の状態に併合する。子の実行確定時には必ず最新状態で更新する。

### 呼び出し時の表示

```text
subagent <child-agent>
```

resume・forkの呼び出しでは、続けて対象のセッションファイル名を表示する。

```text
subagent <child-agent> (resume <session-id-or-file-name>)
subagent <child-agent> (fork <session-id-or-file-name>)
```

### 実行結果の表示形式

```text
┌─── Task ──────
<task>
└───────────────

┌─── Actions ───
<actions>
└───────────────

┌─── Output ────
<output>
└───────────────

session: <sessionId>
```

| 項目 | 形式・条件 |
| --- | --- |
| `child-agent` | 実行した子agent名 |
| `task` | subagentツールに渡したタスク全文 |
| `<actions>` | 子エージェントがツールを利用した場合のみ、受け取った時系列順ですべて表示する |
| `<output>` | 最終アシスタントテキストが確定した場合のみMarkdown として表示する |
| `session: <sessionId>` | 子のsessionId を取得できた実行でのみ、Output ブロックの後に1行表示する。部分表示では出さない。最終報告にも同じID を返す |
| 待機行 | 子エージェントの実行が確定するまでブロックの末尾に表示する（後述） |
| 更新 | 子からのイベントは毎回受領・記録し、表示は 0.15秒に1回まで間引く。間引き中のイベントは最新の状態に併合する。子の実行確定時には必ず最新状態で更新する |

### Actions の行形式

ツール呼び出しは「コール行」と、その下の「結果行」で構成する。コール行はツールごとに整形した表示、結果行はツールの実行結果のサマリーとする。

| ツール | コール行 | 結果行（成功時） |
| --- | --- | --- |
| `bash` | `→ $ <command>`（300文字で切り詰め） | 実行秒数（例: `1.2s`）。計測できないときは `done` |
| `write` | `→ write <path>` | `wrote <size>` |
| `edit` | `→ edit <path>` | `edited N block(s)` |
| `read` | `→ read <path>`（SKILL.md のとき `[skill] <name>`） | `N lines` |
| `grep` | `→ grep <pattern>` | `N matches` |
| `find` | `→ find <pattern>` | `N files` |
| `ls` | `→ ls <path>`（未指定は `.`） | `N entries` |
| 上記以外のツール | `→ <toolName> <args-preview>`。引数は JSON の先頭100文字までを表示し、超過時は `...` を付ける。引数がない場合は `{}` と表示する | 表示しない |

結果行はコール行の下に半角スペース2文字分のインデントを付けて表示する。

| 条件 | 結果行の内容 |
| --- | --- |
| ツールがエラーを返したとき | エラーメッセージの末尾を優先して最大2000文字。超過時は末尾に `[Output truncated; showing the tail.]` を付ける |
| ツールの結果を受け取る前 | 表示しない |

### 待機スピナー

subagent の呼び出しを受け付けた直後から子エージェントの実行が確定するまで、ブロックの末尾に待機行を表示する。

```text
<frame> <child-agent>
```

| 項目 | 振る舞い |
| --- | --- |
| フレーム | titlebar と同じ `⠋` `⠙` `⠹` `⠸` `⠼` `⠴` `⠦` `⠧` `⠇` `⠏` の 10文字をこの順で循環させる |
| 切り替え | 80ミリ秒間隔でフレーム文字を切り替える。行を増やさず同じ位置で更新する。間隔は titlebar と共通の `SPINNER_INTERVAL_MS`（pi-tui の Loader と同じ80ミリ秒）を使う |
| テキスト色 | セクション区切りと同じグレー系とする |
| 消去 | 子エージェントの実行が確定した時点で待機行を消す |

## session_search / create_detached_session

| ツール | コール行 | 実行中 | 折りたたみ時の結果行 | 展開時 |
| --- | --- | --- | --- | --- |
| `session_search` | `session_search <action>` | `Running...` | `session_search: <status>`。`status` は構造化出力の `status`、判定できないとき `complete`、エラー時 `error` | 結果テキスト全体 |
| `create_detached_session` | `create_detached_session <name または initialRequest の先頭40文字>` | `Running...` | `create_detached_session: <status>`。`status` は構造化出力の `status`、判定できないとき `created`、エラー時 `error` | 結果テキスト全体 |

両ツールの結果行は、エラーのとき `error` 色、成功のとき `toolOutput` 色で表示する。

## replace_context

対話画面で `replace_context` の呼出しは、pi が圧縮時に表示するcompactionメッセージと同じ1箱の構成で表示する。上からラベル行・空行・状態行の順に並べる。箱の背景はテーマの `customMessageBg`、パディングは左右1・上下1、ラベルはテーマの `customMessageLabel` で太字の `[compaction]` とする。

| 状態 | 状態行 |
| --- | --- |
| ツール実行中 | `Requesting context replacement...` |
| 呼出し成功・折りたたみ | `Context will be replaced at end of turn (`＋展開キー＋` to expand)` |
| 呼出し成功・展開 | 折りたたみ文を見出しに、`Reason` と `Handoff` の見出し付きで `reason` と `handoff` をMarkdown表示 |
| ツールエラー | ツールが返したエラーメッセージ |

状態行の本文はテーマの `customMessageText`、展開キーはテーマの `dim` で `app.tools.expand` に割り当てられたキーを表示する。既定の展開キーは `ctrl+o` である。
