# Tools — 仕様書

pi の標準7ツールを登録する Tools拡張の振る舞いを定める。読者はツールの利用者と保守担当である。read のテキスト返却契約と、外部コマンド実行の境界を本書で定め、認可・画像判定・隔離実行は [Guardrails仕様](../guardrails/SPEC.md) に依存する。

## テキストread

`read` は、正規化して cwd 基準で解決した指定パスから、次のテキストファイルを全文読みの対象とする。対象ファイルへの symlink を読んだ場合も、リンク先ではなく指定パスで判定する。

- ファイル名が正確に `SKILL.md` のファイル。
- `SKILL.md` が通常ファイルとして確認できるディレクトリの直下にある `references/` 配下のファイル。サブディレクトリも含む。この `SKILL.md` が symlink の場合はリンク先で通常ファイルかを判定する。

| テキストファイル | 結果 |
| --- | --- |
| 全文読みの対象 | `offset` / `limit` と 2000行・50 KiB の打ち切りを適用せず、UTF-8 の原文を返す。空ファイル・CRLF・末尾改行の有無もそのまま返す。 |
| その他のファイル | 標準 `read` の `offset` / `limit` と打ち切りを適用する。 |

全文の成功結果はテキストブロック1件だけを持ち、その本文に通知を加えない。`structuredContent` も同じ全文の文字列とし、追加メタデータを返さない。アクセス制御・sandbox・キャンセルは通常の読取と同じである。codemode のスクリプトによる加工と最終出力の制限は codemode の動作に従う。

## 実行境界

Tools は全文読みの対象判定、UTF-8全文IO、成功結果の組立てを所有する。指定パスのファイル名が `SKILL.md` の場合、または親ディレクトリのいずれかの名前が `references` の場合は、Tools配下のworkerを指定する内部executor descriptorを Guardrails公開APIへ渡す。モデルの引数にある executor・entrypoint・モード指定は内部descriptorとして採用しない。

認可・画像優先・sandbox・キャンセルの契約は [Guardrails仕様](../guardrails/SPEC.md) に従う。画像ファイルは、指定パスが全文読みの条件に一致しても画像readを優先する。`references/` の兄弟にある `SKILL.md` の確認は認可後に sandbox 内で行う。全文読みの条件に一致しない場合は sandbox 内で標準readを実行する。workerが失敗した場合は呼び出しを失敗として返し、再試行やhost読取は行わない。

## ツール登録

Tools は pi の標準tool factory からツール定義（schema・説明文）を取り込み、既存ツールの execute を差し替える。取り込んだ説明文にはサンドボックスの挙動ガイドを追記する: `read` には画像ファイルを Vision入力として読める旨と、画像入力非対応モデルでは `vision` への委譲を促すエラーを返す旨を、`bash` には書き込み失敗（read-only file system）時、対象の最終アクションが `ask` または未設定の場合だけ `ask_permission` で許可要求できること、明示 `deny` と credentials は要求不可であること、承認により Guardrails の共通書込許可が更新され、その許可を利用するすべてのツールに適用されることを、理由必須ゲート（`ask_with_reason`）で差し戻されたときは元のコマンドと理由で `ask_permission` に要求することを追記する。`write` / `edit` には、最終アクションが `ask` または未設定のパスは許可確認の対象になり、承認により Guardrails の共通書込許可が選択したスコープに対してセッション内で有効になること、明示 `deny` と credentials は許可ダイアログを出さず拒否すること（承認スコープ内でも拒否は維持する。[Guardrails仕様](../guardrails/SPEC.md) のbind契約に従う）を追記する。

read / write / edit / grep / find / ls / bash の実行を Guardrails公開APIへ直接依頼する。通常のSDK経路の引数検証・tool hooks・実行イベント・履歴はSDKのまま維持する。Guardrails初期化が失敗した場合は原因を通知し、7ツールを同じ初期化エラーで実行不可にする。

## BashのRTK書換え

登録 `bash` は `tool_call` の後、認可・実行の前にRTKによるコマンド書換えを試みる。他の拡張の `tool_call` handler は書換え前のコマンドを見る。起動時のRTK実行・version確認・警告は行わない。

| 条件・書換え結果 | 本処理へ渡すコマンド |
| --- | --- |
| 空入力、`rtk ` 始まり、`RTK_DISABLED=1` | 元のコマンド |
| 終了コード `0` または `3`、非空の標準出力 | 標準出力の前後空白を除いたコマンド |
| 書換えの認可拒否、失敗、2秒の実行timeout、不正・打ち切り済みの結果、空出力 | 元のコマンド |

書換えCLIは、元コマンド全体を単一の引数として登録Bash経由で実行し、同じsandboxとコマンド承認を適用する。標準エラーは書換え結果に含めない。内部の `rtk ` コマンドには再度書換えを適用しない。呼び出し元の中断信号を引き継ぎ、中断済みの結果を採用しない。本処理には元または書換え後のコマンドを渡し、どちらも通常のGuardrails認可・実行を通す。

## 拡張からの外部コマンド実行

実行経路は、コマンドを選ぶ主体と入力の用途で決まる。

| 入力元・用途 | 実行経路 |
| --- | --- |
| AIが呼ぶツールの外部CLI・コマンド | 実行時contextの `ctx.executeTool("bash", params, { signal })` で、その時点の登録Bashを呼ぶ |
| 拡張が決めた固定の補助処理 | SDKの `pi.exec` など通常のプロセス起動を使う |
| ユーザーが明示的に実行した閲覧コマンドによるエディタ起動 | ユーザー設定のエディタを通常のプロセスとして起動する |

固定補助処理では、実行ファイルと操作を信頼済みコードで決める。AIや外部データ由来の値は検証した引数・payloadとして扱い、任意のコマンド本文として実行しない。backgroundで動くことや、contextに `executeTool` がないことだけでは固定補助処理に分類しない。

### 登録Bashの呼び出しと結果

通常のコマンド実行は呼び出し元から直接 `ctx.executeTool` に依頼する。引数検証・tool hooks・実行イベント・nested call記録・確認UIはSDKに従い、認可・sandboxは [Guardrails仕様](../guardrails/SPEC.md) に従う。入口不在・context失効・拒否・失敗時は呼び出しを失敗として扱い、直接processや標準Bashの再生成へ切り替えない。

SDK応答の外側 `isError` と、元の `result` にある `content`・内側 `isError`・`details`・`structuredContent` を保持する。tool failureを単なるError文字列へ落とさず、呼び出し元の失敗判定・details・診断へ元情報を渡す。SDKがthrowした例外とsignalの中断理由も保持する。

呼び出し元のsignalを登録Bashへ渡す。開始前の中断では起動せず、開始した呼び出しの終端を待つ。timeoutは秒単位で指定値を維持し、省略時は追加しない。

### CLIの引数と結果回収

CLIのliteral引数変換と結果回収に必要な内部処理は共用できる。その処理自身も同じ実行時contextの `ctx.executeTool("bash", ...)` を使う。

実行ファイル・各引数・cwdのNULは起動前に拒否する。それぞれをshell用にquoteし、cwdを指定した場合はそのディレクトリで実行する。CLIの実行は1要求につき最大1回とする。stdout・stderr・終了コードを分離し、両streamの空白・改行をそのまま回収する。末尾改行の除去・JSON解釈・表示切詰めは利用者側の契約に従う。

Bashの `structuredContent` にある `output`・`truncated`・`exit_code` を検証し、出力フレームから両streamと0〜255の整数終了コードを検証・復元する。CLIの非0終了も分離した終了コードとして返す。Bashの外側・内側 `isError`、非0のBash終了コード、フレームや符号化の不正は回収失敗とし、不完全な出力を成功として返さない。

Bashが出力を切り詰めた場合は、元の `full_output_path` から全量を回収する。回収先はNULを含まない絶対パスとして検証し、各取得結果の非切詰めとbyte数を確認する。回収にも同じcontext・signal・timeoutを使い、CLI自体を再実行しない。回収不能・不完全なら失敗とする。中断後の後続Bash呼び出しは開始しない。

CLI完了時は分離した `stdout`・`stderr`・`code` と最初のBash応答を保持する。回収失敗・中断でも、受領したBash応答と外側 `isError` を保持する。回収中の失敗では失敗した呼び出しの応答を、応答がなければ最初の応答を診断に使う。応答未受領なら元の例外・中断理由を伝える。

### 通常プロセスの終了

固定補助処理とユーザー明示操作は、登録Bashの認可状態やToolsの初期化・停止に依存せず起動する。引数の扱い、timeout・signal・終了待機・cleanupは各機能の契約に従う。起動不能、非0終了、中断、出力切詰めを成功とせず、それぞれの機能へ結果を渡す。子プロセスの終端と、ブラウザなど子孫のcleanup完了は区別する。
