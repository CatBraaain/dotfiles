# usage CLI

`usage` は provider の利用枠・リセット時刻・creditsを問い合わせる独立CLI。利用者と保守担当者が、コマンドの入出力・認証・失敗時の挙動を確認するための振る舞い正本である。

## コマンド

| 入力 | 結果 |
| --- | --- |
| `usage` | 設定済みの対応providerを問い合わせ、人間可読レポートを出す |
| `usage <provider> ...` | 指定した対応providerだけを問い合わせる。未設定の指定も失敗状態として報告する |
| `usage --json` | 同じ照会結果をJSON配列で出す |
| `usage <provider> ... --json` | 指定providerの照会結果をJSON配列で出す |
| `usage list` | 全対応providerのID・表示名・用途区分・認証種別をタブ区切りで出す。通信しない |
| `usage list --json` | 一覧をJSON配列で出す。通信しない |
| 不明なprovider・不明なフラグ・`list` の余分な引数 | stderrに `usage:` 付きの理由と使用方法を出す。通信しない |

`--json` は引数の前後に置ける。照会の重複指定は1件にまとめる。結果は `Current` を先頭にし、残りは下表の順序で出す。指定順では並べ替えない。

引数なしでも、保存認証が期限切れ・不正なproviderは省略せず認証不可を報告する。認証の設定がないproviderだけを省略する。対象が0件のとき、人間可読出力は空、JSON出力は `[]` となる。

## 対応provider

providerごとに用途を保持し、異なる枠・通貨の数値を合算しない。APIが値を返さない場合は未知として扱い、0や無制限を補わない。APIが省略を0と定義するフィールドは、その定義に従う。

| ID | 表示する情報 |
| --- | --- |
| `openai-codex` | subscriptionの期間別枠・残量・リセット・credits |
| `command-code` | spending cap・credits・plan・期間内のrequests/tokens |
| `zai` | Coding Plan枠・MCP枠・plan名と更新日 |

Command Code・Z.AIは、必須応答を取得できても補足応答に失敗する場合がある。Command Codeは取得済み情報と不足を示すnotesを返す。Z.AIは取得できた補足情報だけを表示する。

## 認証とCurrent判定

`$HOME/.pi/agent/auth.json` と `$HOME/.pi/agent/settings.json` を読み取る。HOMEがない環境ではOSのhomeを使う。ファイルの不在は空の設定として扱い、読み取り不能・不正JSON・object以外の内容はコマンドの失敗となる。

保存認証はprovider IDをキーとするobjectで、環境変数より優先する。保存認証が不正・期限切れの場合も、別の環境認証へ黙って切り替えない。

| 保存形式 | 挙動 |
| --- | --- |
| `type: "api_key"`、非空の `key` | API keyを使う |
| `type: "oauth"`、非空の `access`、文字列の `refresh`、有限数値の `expires` | 保存されたtokenを使う。`expires` はUnix epochミリ秒 |
| `expires <= 現在時刻` | 認証不可と期限切れ理由を返す |
| `!` で始まる保存API key | コマンド形式のkeyは認証不可とする。コマンドを実行しない |
| 上記以外 | 認証不可と理由を返す |

OAuth refresh通信・認証ファイルへの書き戻し・ログイン操作は行わない。

Codexの保存OAuthには、非空かつ制御文字を含まない `accountId` を要求し、`ChatGPT-Account-Id` ヘッダに使う。

Z.AIは保存認証がない場合に `ZAI_API_KEY` を使う。Codex・Command Codeは保存認証だけを使う。

`settings.json` の `defaultProvider` に一致するproviderを `Current`、他を `Configured` と表示する。これは既定設定との一致であり、稼働中セッションの選択モデルを表すものではない。

### Command Codeの別名

`commandcode` は `command-code` の別名。入力・保存認証・Current判定で受け付け、出力IDは `command-code` に統一する。

| 条件 | 使用する保存認証 |
| --- | --- |
| 片方のIDだけを保存 | 保存された方 |
| 両方を保存、引数なし・list・canonical指定 | `command-code` |
| 両方を保存、`commandcode` だけを明示指定 | `commandcode` |
| 両方のIDを明示指定 | `command-code`。照会は1回 |

## 出力

人間可読の成功レポートはタイトル、`Current|Configured`、存在すればAccount、Semantics、provider固有の数値・リセット、notesを出す。複数providerのレポートを空行で区切る。失敗時はprovider名と状態・理由を1行で出す。

JSON照会結果は状態objectの配列である。

| フィールド | 内容 |
| --- | --- |
| `providerId` / `providerName` | provider IDと表示名 |
| `displayState` | `current` または `configured` |
| `status` | 成功は `ready`、認証不可は `auth-unavailable`、取得失敗は `query-failed` |
| `report` | `ready` の場合のレポート |
| `message` | 失敗の場合の理由 |

reportは `providerId`、`providerName`、`capturedAt`、`source`、`semantics`、`long`、`short`、`metrics`、任意の `accountLabel` と `notes` を含む。`capturedAt` は取得時刻のUnix epochミリ秒、bucketの `resetsAt` はUnix epoch秒である。

`long` と `short` は利用枠（bucket）の配列である。Command Codeの `five-hour` とZ.AIの `mcp-monthly`（MCP枠）を除き、期間の長さが異なる上位2種類を選ぶ。同期間の全bucketを取得結果の順序で保持し、最長期間を `long`、2番目を `short` に入れる。

| 条件 | 配列の内容 |
| --- | --- |
| 期間が2種類以上 | 最長を `long`、2番目を `short` に保持する |
| 期間が1種類 | 全対象bucketを `long` に保持し、`short` は `[]` とする |
| 期間が0種類 | `long` と `short` はともに `[]` とする |

期間の比較には正の有限数値の `windowMinutes` を使う。Command Codeの `monthly` / `billing-period` 枠にその値がない場合は、週より長い月次枠として扱い、bucketに比較用の期間値を補わない。期間が不明な枠は配列に含めない。リセットまでの残り時間やprimary/secondaryの位置から期間を推測しない。metrics・notesと他のreport欄、失敗状態の各欄は取得結果を保持する。

bucketはID・label・unitに加え、APIが示すused/remaining/limit・期間・windowMinutes・reset・group/model情報を保持する。metricはID・label・valueと、該当するunit・currencyを保持する。unitは `percent`・`usd`・`currency`・`count`。通貨はmetricごとに保持する。

JSON一覧の各行は `id`・`displayName`・`semantics`・`authenticated`・`authType` を含む。`authenticated` はローカルで認証情報を解決できたことだけを表し、API受理の証明ではない。認証不可の `authType` は `null` となる。

## 通信・安全性・終了コード

provider固有の公式endpointへだけ接続し、redirectを拒否する。照会は最大2 providerを同時に進め、1 providerの失敗が他の結果を失わせない。HTTP要求には残りの制限時間を渡し、基本の制限は15秒である。usage値は実行ごとに取得し、ディスクへキャッシュしない。

成功bodyは基本64KiB、エラーbodyは4KiBまで読む。provider固有の応答サイズが必要な要求はその上限に従う。成功bodyの上限超過・不正JSON・object以外のJSONは取得失敗とする。

出力する成功値・失敗理由は、既知の認証情報を除去してから表示用の制御文字除去・短縮を行う。HTTP失敗時は生の応答本文を表示せずstatusを示す。OSC・CSIなどの端末制御列は表示として実行しない。

| 状況 | 終了コード |
| --- | --- |
| 1件以上成功、一覧成功、対象0件 | `0` |
| 試行した照会がすべて失敗、設定ファイルの読み取り・解析失敗 | `1` |
| 引数の誤り | `2` |

コマンド全体のエラーはstderrへ `usage: <理由>` と出す。provider単位の失敗は標準出力の結果に含める。JSONは2スペースインデント、出力がある場合は末尾改行を付ける。

## 帰属

provider処理・正規化・整形は [narumiruna/pi-extensions の pi-usage](https://github.com/narumiruna/pi-extensions/tree/80566d6cf05e93b068d02ff235e3ae55d22ba01a/packages/pi-usage) v0.68.1に基づく。
