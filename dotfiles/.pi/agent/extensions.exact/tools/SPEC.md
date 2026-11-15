# Tools — 仕様書

pi の標準7ツールを登録する Tools拡張の振る舞いを定める。読者はツールの利用者と保守担当である。read のテキスト返却契約と実行入口を本書で定め、認可・画像判定・隔離実行は [Guardrails仕様](../guardrails/SPEC.md) に依存する。

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

Tools は pi の標準tool factory からツール定義（schema・説明文）を取り込み、既存ツールの execute を差し替える。取り込んだ説明文にはサンドボックスの挙動ガイドを追記する: `read` には画像ファイルを Vision入力として読める旨と、画像入力非対応モデルでは `vision` への委譲を促すエラーを返す旨を、`bash` には書き込み失敗（read-only file system）時、対象の最終アクションが `ask` または未設定の場合だけ `ask_permission` で許可要求できること、明示 `deny` と credentials は要求不可であること、承認により Guardrails の共通書込許可が更新され、その許可を利用するすべてのツールに適用されることを、理由必須ゲート（`ask_with_reason`）で差し戻されたときは元のコマンドと理由で `ask_permission` に要求することを追記する。`write` / `edit` には、最終アクションが `ask` または未設定のパスは許可確認の対象になり、承認により Guardrails の共通書込許可が選択したスコープに対してセッション内で有効になること、明示 `deny` と credentials は許可ダイアログを出さず拒否すること（承認スコープ内でも拒否は維持する。[Guardrails仕様](../guardrails/SPEC.md) のbind契約に従う）を追記する。

read / write / edit / grep / find / ls / bash の実行を Guardrails公開APIへ直接依頼する。通常のSDK経路の引数検証・tool hooks・実行イベント・履歴はSDKのまま維持する。codemodeを登録し、結果は呼び出し元へ返す。Guardrails初期化が失敗した場合は原因を通知し、7ツールと背景Bash入口のすべてを同じ初期化エラーで実行不可にする。

## 背景Bash入口

lifecycle/background処理は、Tools配下のBash専用helperをimportし、型付きの直接APIへ要求できる。要求は `id`、`params`、呼び出し元のruntimeを識別するcontext、モデル・thinking level・会話IDと会話ファイルの必要情報、任意の `signal` を持つ。`params` は登録Bashのschemaを再利用し、文字列の `command` と任意の数値 `timeout` だけを入口で検証する。APIは要求の終端結果をPromiseで返す。すべての結果は、登録Bash経路の実行待機を表す `executionSettled: Promise<void>` を持つ。

初回要求は、`session_start` の全handlerによる初期化が完了した後の `resources_discover` 以降に開始する。この時点で、そのruntimeの背景APIを利用できる。未登録のAPIへの要求は、初期化を待たずに直ちに `unavailable` で決着する。

同一runtime内では、登録Bashと背景APIが同じ承認状態を共有する。同じ会話ID・会話ファイルを使う場合でも、別runtimeの承認状態は共有しない。再読み込み後は新しいruntimeの背景APIを使い、旧API・失効したcontextによる新規要求は拒否する。

この入口は登録Bashと同じ実行関数・同じGuardrailsの認可状態を使う。要求から実行tool・executor・認可policyを選ばせず、GuardrailsへはBash実行と既存承認限定のpolicyを渡す。新しい認可UIが必要なら実行せず失敗する。通常の登録toolは従来どおり確認UIを使う。既存設定・承認とsandboxの適用は [Guardrails仕様](../guardrails/SPEC.md) に従う。

背景入口はSDKの通常dispatchではない。SDKのtool hooks、実行イベント、履歴は自動付与されない。

| 要求・状態 | 要求元への結果 |
| --- | --- |
| 実行完了 | `completed` と元のtool result。`isError`・details・structuredContentを保持する |
| 引数の検証失敗、実行がthrow、不正な結果、要求期限の超過 | `failed` と失敗理由 |
| 開始前・実行中のabort | `aborted` と中断理由 |
| APIが未登録・停止済み、または要求元のruntimeが失効している | 直ちに `unavailable` と不在・失効理由 |
| Guardrailsの初期化が失敗したruntimeの有効なAPIへの要求 | `failed` と通常ツールと同じ初期化エラー |
| `session_shutdown` による背景APIの停止 | 保留要求を `unavailable` と停止理由で決着する |

`params.timeout` はBash実行の期限を秒単位で指定する。要求全体の期限は、指定がある場合はその秒数に2秒を加え、指定がない場合は2秒とする。追加の2秒はsandboxの準備・プロセス起動・結果回収の余裕とし、Bash実行の指定時間は維持する。

要求結果と実行終端は独立する。`executionSettled` は、登録Bashと共有する実行関数のPromiseが正常または例外で終端した時に解決し、rejectしない。実行がthrowした場合も `failed` の返却前に解決済みとする。開始前の中断・入口不在などで実行しない場合は、解決済みPromiseを返す。要求期限の超過やAPI停止で先に結果を返した場合は、開始済み実行の終端までこのPromiseを未解決のまま保持する。API停止やruntimeの失効後も、返却済みの実行待機は有効とする。

1要求につき実行は最大1回とし、要求結果は一度だけ確定する。要求期限の超過・API停止では未開始の実行を取り消す。開始済み実行に `params.timeout` の指定がある場合は、それだけを理由に実行信号をabortせず、Bash自身のtimeoutによる終端を待つ。指定がない場合は実行信号をabortする。後着の成功・失敗で要求結果を変更せず、`executionSettled` の解決だけを通知する。

呼び出し元の明示的な `signal` 中断は、未決の要求を `aborted` で決着させ、開始済み実行の信号もabortする。開始済み要求のsignal監視と実行待機は、要求結果が先に確定した場合も実行終端まで維持する。`session_shutdown` で背景APIを停止し、そのruntimeへの新規要求を拒否する。入口の不在・無効・失敗時に別の実行経路へfallbackしない。
