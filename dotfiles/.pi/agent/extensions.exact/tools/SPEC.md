# Tools — 仕様書

pi の標準7ツールを登録する Tools拡張の振る舞いを定める。読者はツールの利用者と保守担当である。read のテキスト返却契約を本書で定め、認可・画像判定・隔離実行は Guardrails の公開APIに依存する。

## テキストread

tools の `read` は、Guardrails公開APIのパス正規化関数による正規化と cwd基準の解決後、ファイル名が正確に `SKILL.md` であるテキストファイルを全文で返す。判定は指定パスの名前を使い、symlink の実体名には依存しない。

| テキストファイル・入力 | 結果 |
| --- | --- |
| `SKILL.md`、`offset` / `limit` の指定あり・なし | 指定を無視し、2000行・50 KiB の打ち切りを適用せず全文を返す |
| `SKILL.md`、空ファイル・CRLF・末尾改行あり・なし | UTF-8 として読み取った原文の文字列をそのまま返す |
| その他のファイル（skill内の参考文書を含む） | 標準readの `offset` / `limit` と打ち切りを適用する |

全文の成功結果はテキストブロック1件だけを持ち、その本文に通知を加えない。`structuredContent` も同じ全文の文字列とし、追加メタデータを返さない。アクセス制御・sandbox・キャンセルは通常の読取と同じである。codemode のスクリプトによる加工と最終出力の制限は codemode の動作に従う。

## 実行境界

Tools は SKILL判定、UTF-8全文IO、成功結果の組立てを所有する。対象のテキストreadは、Tools配下のworkerを指定する内部executor descriptorを Guardrails公開APIへ渡す。モデルの引数にある executor・entrypoint・モード指定は内部descriptorとして採用しない。

認可・画像優先・sandbox・キャンセルの契約は [Guardrails仕様](../guardrails/SPEC.md) に従う。画像内容を持つファイルは、名前が `SKILL.md` でも画像readを優先する。workerの失敗は呼び出しの失敗として返り、標準readやhost読取へのfallbackを行わない。

## ツール登録

Tools は pi の標準tool factory からツール定義（schema・説明文）を取り込み、既存ツールの execute を差し替える。取り込んだ説明文にはサンドボックスの挙動ガイドを追記する: `read` には画像ファイルを Vision入力として読める旨と、画像入力非対応モデルでは `vision` への委譲を促すエラーを返す旨を、`bash` には書き込み失敗（read-only file system）時、対象の最終アクションが `ask` または未設定の場合だけ `ask_permission` で許可要求できること、明示 `deny` と credentials は要求不可であること、許可結果が bash書き込み不可を示す場合は fsツールを使うことを、理由必須ゲート（`ask_with_reason`）で差し戻されたときは元のコマンドと理由で `ask_permission` に要求することを追記する。`write` / `edit` には、最終アクションが `ask` または未設定のパスは許可確認の対象になり、承認後にセッション内で書き込み可能になること、明示 `deny` と credentials は許可ダイアログを出さず拒否すること（`ask` に確定したパスは bash からは書けない。[Guardrails仕様](../guardrails/SPEC.md) のbind契約に従う）を追記する。

read / write / edit / grep / find / ls / bash の実行を Guardrails公開APIへ配線する。codemodeを登録し、結果は呼び出し元へ返す。Guardrails初期化が失敗した場合は原因を通知し、7ツールすべてを同じ理由で実行不可にする。
