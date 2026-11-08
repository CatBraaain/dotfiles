# tool-renderer — 仕様書

pi TUI の全ツール呼び出しを、1ツールにつき既定1行で表示し、個別に詳細を展開する拡張の仕様である。読者は利用者と実装・テストの担当者。コール行はツール名と入力、サマリーは実行状態または結果の要約、詳細は展開時の本文を指す。

## 仕組み

- `pi.registerToolRenderer` で resolver を1本登録し、ツール名ごとの `renderCall` / `renderResult` を返す。
- ツール別の整形は `bash` `read` `write` `edit` `grep` `find` `ls` `ask_permission` `codemode` `web_search` `web_fetch` `subagent` `recontext` `session_search` `create_detached_session` に適用する。
- 登録にないツールの詳細は、残りの resolver → 登録済みツール自身の renderer → pi既定の順で解決する。未知のツールにも共通の1行表示と個別展開を適用する。
- 描画は結果の `details` と content から行う。スクロール・リサイズ・テーマ変更後も、その時点の展開状態を保って再描画する。
- 描画実装と resolver API の互換型は `index.ts` に置く。テキスト表示は共通の描画手順を使い、ツールごとの差をコール行・結果行の定義で表す。main agent と subagent の Actions は同じコール行・成功サマリーの整形処理を使う。
- 対話画面の折りたたみは拡張のロード中に適用する。履歴から復元されたツールも同じ規則に従い、reload後も重複せず適用する。拡張を外した後は pi本来の表示とマウス処理に戻る。

## details 契約

各ツール拡張が定義して返す通常のツール結果（`content`・`details`）を pi 経由で受け取り、描画する。結果の型は生成側、描画専用の state と整形用の型は本拡張に置く。

## 共通の表示

折りたたみ行はコール行とサマリーを `—` でつないだ1行である。改行を空白にし、ANSI装飾・全角文字・絵文字を考慮した表示幅で切り詰める。ツール間の空行や本文・画像は折りたたみ行に加えない。連続した複数ツールもそれぞれ別の1行である。

以下の `<...>` は実行ごとに変わる値を示す。具体例は架空の入力・結果であり、切り詰めが起きない幅を前提とする。展開時はツールごとのコール表示と詳細を表示する。実行前・実行中・部分結果・エラー・画像とクリック操作には、全ツールで次の共通規則を適用する。

サマリーの描画に失敗した場合は `<toolName> — [render error]` を幅内の1行で表示し、他の画面要素の描画を継続する。

| 状態 | 折りたたみ行のサマリー | 展開時 |
| --- | --- | --- |
| 引数受信中・実行中・部分結果 | `Running...`。bash は届いている進捗を使う | 現在のコールと取得済みの詳細 |
| 成功 | ツールごとの成功サマリー。専用サマリーのないツールは結果テキスト、空なら `done` | 結果本体 |
| エラー | エラーテキスト、空なら `Error` | エラーテキスト全体 |
| 画像を含む結果 | 通常の成功・エラーサマリー | pi の画像表示設定に従った画像と詳細 |

| 操作・条件 | 結果 |
| --- | --- |
| fullscreenで折りたたみ行を左クリック | そのツールだけを展開する。最初の結果が届く前も操作できる |
| fullscreenで展開したコールのヘッダを左クリック | そのツールだけを折りたたむ |
| 展開中に部分結果・最終結果が届く | 展開状態を保ち、詳細を更新する |
| pi標準の一括展開操作（既定 `Ctrl+O`） | pi本来の一括展開・折りたたみを維持する |
| 通常モード | 端末がマウスとスクロールバックを管理する。クリックはpiへ届かず、既存の一括展開操作で詳細を開く |
| fullscreenと通常モードの切り替え | ツールの表示状態と入力先を保つ |

承認要求・promptui・入力・focus・権限判定は pi と各拡張の通常動作を保つ。許可・拒否後の結果行は他のツールと同じ折りたたみ対象である。表示の変更は対話画面に限定し、モデルへ渡す結果・永続ログ・ツール実行・起動経路は変更しない。

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

| ツール | 既定1行（成功時） | 展開時の詳細 |
| --- | --- | --- |
| `bash` | `$ <command> — <秒数>s` | stdout/stderr。秒数サマリーは詳細に追加しない |
| `write` | `write <path> — wrote <size>` | 書き込んだ内容 |
| `edit` | `edit <path> — edited <N> block(s)` | diff。diff がない結果は結果テキスト |
| `read` | `read <path> — <N> lines`。`SKILL.md` は `[skill] <name> — <N> lines`、画像は `read <path> — image input` | ファイル内容または画像。画像入力非対応モデルではエラー |
| `grep` | `grep <pattern> in <path> — <N> matches` | context行を含むマッチ結果。`N` は context行を含まない純マッチ数 |
| `find` | `find <pattern> in <path> — <N> files` | パス一覧 |
| `ls` | `ls <path> — <N> entries`（path未指定は `.`） | エントリ一覧 |
| `ask_permission` | `ask_permission <path> — <許可結果>`。command承認は `ask_permission <command> — <許可結果>` | 許可・拒否の結果テキスト |

`ask_permission` の path・command は80文字で切り詰める。`<許可結果>` は `granted` / `already granted` / `denied`。拒否理由があるときは `denied — <理由>` とし、理由を80文字で切り詰める。

bash の追加規則:

- コール行の command は300文字で切り詰める。
- 実行中は、直近の stderr 行を進捗として表示する。1行も届いていないときは `Running...`。stderr の行単位の送出は guardrail 拡張が担う（guardrail SPEC §7）。
- 実行秒数は pi が最終結果に付けた実行時間を小数1桁で表示する。計測できないときは `done`。履歴を再表示しても同じ秒数を表示する。

### read・bash の表示例

内容が `alpha`・`beta`・`gamma` の3行である `notes.txt` を読んだ場合:

```text
read ./notes.txt — 3 lines
```

ヘッダーをクリックした後:

```text
read ./notes.txt
alpha
beta
gamma
```

`printf` が2行を出力し、実行時間が1.2秒だった場合:

```text
$ printf 'alpha\nbeta\n' — 1.2s
```

ヘッダーをクリックした後:

```text
$ printf 'alpha\nbeta\n'
alpha
beta
```

## codemode

`codemode` の結果表示は本拡張で管理する。サマリーはスクリプト全体の経過時間、本文はスクリプトが出力したテキスト・画像を指す。呼び出し一覧はスクリプトから呼んだツールの状態・引数・時間・費用を示す詳細である。

標準表示とは、利用中の pi が提供する組込codemode の表示である。展開時の呼び出し一覧にはツール名・引数・状態・計測できた時間と費用が含まれ、失敗とキャンセルは状態の印で区別する。スクリプト失敗時には診断本文をエラー色で示す。切り詰めた出力の全文ファイルがあれば、その案内を詳細に含む。内側のツール呼び出しは親codemode の詳細に含める。

コール部分の `<引数JSONプレビュー>` は「汎用ツールと未知のツール」の規則に従う。展開時のコール表示は、標準のスクリプトコード表示である。

| 状態 | 既定1行 | 展開時の詳細 |
| --- | --- | --- |
| 正常終了・経過時間あり | `codemode <引数JSONプレビュー> — <秒数>s`（例の秒数: `1.2s`） | 秒数と標準の呼び出し一覧・本文全文 |
| スクリプト失敗 | `codemode <引数JSONプレビュー> — <エラーテキスト>` | 標準の失敗表示・呼び出し一覧・診断本文 |
| 呼び出したツールに失敗またはキャンセルあり | `codemode <引数JSONプレビュー> — <秒数>s (failed calls)`。時間なしは `done (failed calls)` | スクリプトが例外を捕捉した場合も標準の呼び出し一覧・本文で失敗とキャンセルを判別できる |
| 実行中（部分結果・partial） | `codemode <引数JSONプレビュー> — Running...` | 標準の呼び出し一覧による進捗。本文は確定時に表示する |
| 正常終了・経過時間なし | `codemode <引数JSONプレビュー> — done` | 標準の結果表示 |

経過時間はスクリプト全体の計測値を使う。並列で呼んだツールの時間を合計せず、履歴を再表示しても同じ秒数を表示する。秒数の丸め精度は bash の結果サマリーとそろえる。空の本文でも、経過時間があれば秒数を表示する。

詳細の本文の色・改行・画像表示・全文表示・全文ファイルへの案内は標準表示に従う。呼び出し欄のコード表示も標準に従う。

短縮は、登録された codemode ツールの renderer を resolver チェーン（`next()`）から受け取り、その外側に秒数サマリーを足す形で行う。codemode本体には pi標準のスクリプト実装を使い、短縮は対話画面の結果表示だけに適用する。短縮の適用は本拡張のロードだけに依存し、guardrail の有効状態に従わない。ツールを使用可能にする選択と codemode の動作設定は pi標準に従う。スクリプトの実行結果、ツールの使用条件、入れ子のツール呼び出し、権限確認、フック、store、モデル機能、セッションへの保存内容は pi標準の codemode と同じである。内部から呼ぶfs/bash は各ツールのアクセス制御と実行規則に従う。

## web_search / web_fetch

### 既定1行と展開内容

| ツール | 既定1行（成功時） | 展開時の詳細 |
| --- | --- | --- |
| `web_search` | `web_search - "<クエリ>" — ✓ <engine> (<秒数>s)` | 検索結果の本文 |
| `web_fetch` | `web_fetch - "<URL>" — ✓ <backend> - "<タイトル>" (<秒数>s)` | 取得した本文 |

`web_search` の `lang` 指定時は、クエリの直後、`—` の前に ` [lang=<lang>]` を付ける。サマリーのタイトル・fallback・失敗時の形式は次の表に従う。

### サマリー（実行完了時）

成功時は `✓` に続けて成功したengine または backend名を置く。web_fetch成功時はタイトルがあるとき ` - "<タイトル>"` を続ける。行末に CLI の実測所要時間を ` (1.2s)` 形式で付ける。

| 状態 | 出力 |
| --- | --- |
| 成功（web_search） | `✓ <engine> (1.2s)` |
| 成功（web_fetch、タイトルあり） | `✓ <backend> - "<タイトル>" (1.2s)` |
| 成功（web_fetch、fallbackあり） | `✓ <backend> [- "<タイトル>"] (fallback: <backend>: <error>; ...) (1.2s)` |
| 成功（web_fetch、タイトルなし） | `✓ <backend> (1.2s)` |
| 失敗 | `✗ <CLI名> - "<エラーメッセージ>"` |

失敗行のエラーメッセージは CLI の stderr（全backend失敗の理由に、再試行と camoufox server手動復旧のヒントが含まれることがある。CLI spec「共通の振る舞い」）を引用し、共通の1行表示の規則で切り詰める。展開時には取得した結果本文またはエラー全文を表示する。CLI の JSON に試行（attempts）一覧が無いため、バックエンド試行を1行ずつ列挙する表示は行わない。

最終結果の `details` が空のとき（throw 前に `onUpdate` で通知したエラーdetails を使う場面）、render state に記憶した最後の details を代わりに使う。空の details で state の内容を置き換えない。

## subagent

subagent の完了時のサマリーは小数1桁の実行秒数、計測できないときは `done` とする。展開時はコール行に続けて、子エージェントごとの実行ブロックを表示する。実行秒数サマリーは詳細に追加しない。Actions 内の子ツールは、後述するコール行と結果サマリーの形式を使う。子からのイベント（`message_end`・ツール実行の開始・更新・終了）は毎回受領して記録する一方、表示の更新は 0.15秒に1回までに間引き、間引き中のイベントは最新の状態に併合する。子の実行確定時には必ず最新状態で更新する。

### 既定1行

正常完了時の形式は次のとおり（具体例: `subagent junior — 1.2s`）。

```text
subagent <child-agent> — <秒数>s
```

resume・forkの呼び出しでは、コール部分に対象のセッションファイル名を付ける。

```text
subagent <child-agent> (resume <session-id-or-file-name>) — <秒数>s
subagent <child-agent> (fork <session-id-or-file-name>) — <秒数>s
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

| ツール | 既定1行（成功時） | 展開時の詳細 |
| --- | --- | --- |
| `session_search` | `session_search <action> — session_search: <status>` | 検索・一覧・表示の結果テキスト全体 |
| `create_detached_session` | `create_detached_session <名前プレビュー> — create_detached_session: <status>` | 作成したセッションの結果テキスト全体 |

`<status>` は構造化出力の `status` とし、判定できないときは `session_search` が `complete`、`create_detached_session` が `created` を使う。`<名前プレビュー>` は前後空白を取り除いた `name`、名前がないときは `initialRequest` とし、40文字で切り詰める。

実行中・エラーは共通の表示規則に従う。展開した結果テキストは、エラーのとき `error` 色、成功のとき `toolOutput` 色で表示する。

## recontext

`recontext` の成功時の既定1行は `[compaction] — Context will be replaced at end of turn` とする。展開時は、pi が圧縮時に表示するcompactionメッセージと同じ1箱の構成で表示する。上からラベル行・空行・状態行の順に並べる。箱の背景はテーマの `customMessageBg`、パディングは左右1・上下1、ラベルはテーマの `customMessageLabel` で太字の `[compaction]` とする。

| 状態 | 状態行 |
| --- | --- |
| ツール実行中 | `Requesting context replacement...` |
| 呼出し成功 | `Context will be replaced at end of turn` を見出しに、`Reason` と `Handoff` の見出し付きで `reason` と `handoff` をMarkdown表示 |
| ツールエラー | ツールが返したエラーメッセージ |

状態行の本文はテーマの `customMessageText` とする。

## 汎用ツールと未知のツール

専用整形のないツールと、動的に見つかった未知のツールの既定1行は `<toolName> <引数JSONプレビュー> — <結果テキスト>` とする。引数JSONプレビューは引数の JSON を使い、100文字を超えると先頭100文字に `...` を付ける。引数がない場合は `{}` とする。結果テキストは全テキストブロックを結合して空白・改行を1つの空白に畳み、前後の空白を除いたものを使う。空なら `done` とする。最終的な幅制限と実行中・エラー・画像には共通の表示規則を適用する。

展開時は「仕組み」の解決順に従い、各ツールのコール表示と結果本文を表示する。各ツール自身の renderer がある場合はその表示を使い、ない場合は pi既定のツール名・引数JSONと結果テキストを表示する。

次の表の JSON は入力例であり、`<結果テキスト>` は上記の規則で作るサマリーを示す。

| ツール | 既定1行（成功時の入力例） | 展開時の内容 |
| --- | --- | --- |
| `powershell` | `powershell {"command":"Get-Date"} — <結果テキスト>` | PowerShellコマンドのコール表示と stdout/stderr |
| `tool_search` | `tool_search {"query":"browser"} — <結果テキスト>` | 引数を含むコール表示と、見つかったツールの結果本文 |
| `ticket_list` | `ticket_list {} — <結果テキスト>` | 引数を含むコール表示と、チケット一覧の結果テキスト |
| `ticket_show` | `ticket_show {"selector":"abc123"} — <結果テキスト>` | 引数を含むコール表示と、チケット詳細の結果テキスト |
| `ticket_create` | `ticket_create {"title":"Check output"} — <結果テキスト>` | 引数を含むコール表示と、作成結果のテキスト |
| `ticket_set` | `ticket_set {"selector":"abc123","status":"closed"} — <結果テキスト>` | 引数を含むコール表示と、状態・依存関係の更新結果テキスト |
| `ticket_edit` | `ticket_edit {"selector":"abc123","old":"alpha","new":"beta"} — <結果テキスト>` | 引数を含むコール表示と、本文の編集結果テキスト |
