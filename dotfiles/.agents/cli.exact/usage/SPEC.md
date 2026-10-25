# usage CLI

`usage` は provider の利用制限枠の残量率を問い合わせる独立CLI。利用者と保守担当者が、コマンドの入出力・認証・失敗時の挙動を確認するための振る舞い正本である。

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

`--json` は引数の前後に置ける。照会の重複指定は1件にまとめる。結果は既定providerを先頭にし、残りは下表の順序で出す。指定順では並べ替えない。

引数なしでも、保存認証が期限切れ・不正なproviderは省略せず欠損値で報告する。認証の設定がないproviderだけを省略する。対象が0件のとき、人間可読出力は空、JSON出力は `[]` となる。

## 対応provider

providerごとに用途を保持し、異なる枠・通貨の数値を合算しない。APIが値を返さない場合は未知として扱い、0や無制限を補わない。APIが省略を0と定義するフィールドは、その定義に従う。

| ID | 表示名 |
| --- | --- |
| `openai-codex` | Codex |
| `command-code` | Command |
| `zai` | Z.AI |

Command Code・Z.AIは、必須応答を取得できても補足応答に失敗する場合がある。取得できた通常の利用制限枠から残量率を返す。

## 認証と既定provider判定

`$HOME/.pi/agent/auth.json` と `$HOME/.pi/agent/settings.json` を読み取る。HOMEがない環境ではOSのhomeを使う。ファイルの不在は空の設定として扱い、読み取り不能・不正JSON・object以外の内容はコマンドの失敗となる。

保存認証はprovider IDをキーとするobjectで、環境変数より優先する。保存認証が不正・期限切れの場合も、別の環境認証へ黙って切り替えない。

| 保存形式 | 挙動 |
| --- | --- |
| `type: "api_key"`、非空の `key` | API keyを使う |
| `type: "oauth"`、非空の `access`、文字列の `refresh`、有限数値の `expires` | 保存されたtokenを使う。`expires` はUnix epochミリ秒 |
| `expires <= 現在時刻` | 照会せず欠損値を返す |
| `!` で始まる保存API key | コマンド形式のkeyは認証不可とする。コマンドを実行しない |
| 上記以外 | 照会せず欠損値を返す |

OAuth refresh通信・認証ファイルへの書き戻し・ログイン操作は行わない。

Codexの保存OAuthには、非空かつ制御文字を含まない `accountId` を要求し、`ChatGPT-Account-Id` ヘッダに使う。

Z.AIは保存認証がない場合に `ZAI_API_KEY` を使う。Codex・Command Codeは保存認証だけを使う。

`settings.json` の `defaultProvider` に一致するproviderを既定providerとする。これは既定設定との一致であり、稼働中セッションの選択モデルを表すものではない。

### Command Codeの別名

`commandcode` は `command-code` の別名。入力・保存認証・既定provider判定で受け付け、出力IDは `command-code` に統一する。

| 条件 | 使用する保存認証 |
| --- | --- |
| 片方のIDだけを保存 | 保存された方 |
| 両方を保存、引数なし・list・canonical指定 | `command-code` |
| 両方を保存、`commandcode` だけを明示指定 | `commandcode` |
| 両方のIDを明示指定 | `command-code`。照会は1回 |

## 出力

人間可読出力は、先頭行を `short`・`long` のヘッダとし、providerごとに表示名・short残量率・long残量率を1行で並べる。表示名は対応provider表に従う。残量率は0〜100%の整数に丸めた `%` 付き数値で、タイトル・バー・時刻・プラン・認証状態・notesは付けない。

通常表示とJSON照会の対象は、正の有限数値の `windowMinutes` がある通常の利用制限枠である。Command Codeの月次credits（`monthly`）とZ.AIのMCP月次枠（`mcp-monthly`）は除く。longは期間が最長の1枠、shortはlong以外で消費率が最小（残量率が最大）の1枠とする。同順位では取得結果の先頭の枠を選ぶ。期間や残量率をリセット時刻・枠の位置から推測しない。

残量率はpercent枠では `remaining`、他の単位では正の有限数値の `limit` に対する `remaining` の割合から求める。`remaining` が有限数値でなければ、有限数値の `used` から残量を求める。残量率が不明な枠はshort候補から除く。対象枠がないセル・選択されたlongの残量率が不明なセル・失敗したproviderの両セルは `—` とする。

```text
         short   long
Codex      80%    70%
Command    90%    98%
Z.AI         —    60%
```

JSON照会結果は、各要素に次の3フィールドだけを持つ配列である。枠選択・残量計算・整数への丸めは通常表示と同じとし、`%` を付けず数値で返す。通常表示で `—` になる値は `null` とする。成功・認証不可・取得失敗のいずれも同じフィールド構成とする。

| フィールド | 内容 |
| --- | --- |
| `provider` | 既存のprovider ID（`openai-codex`・`command-code`・`zai`） |
| `short` | shortの整数残量率、または `null` |
| `long` | longの整数残量率、または `null` |

```json
[
  { "provider": "openai-codex", "short": 80, "long": 70 },
  { "provider": "command-code", "short": null, "long": null }
]
```

JSON一覧の各行は `id`・`displayName`・`semantics`・`authenticated`・`authType` を含む。`authenticated` はローカルで認証情報を解決できたことだけを表し、API受理の証明ではない。認証不可の `authType` は `null` となる。

## 通信・安全性・終了コード

provider固有の公式endpointへだけ接続し、redirectを拒否する。照会は最大2 providerを同時に進め、1 providerの失敗が他の結果を失わせない。HTTP要求には残りの制限時間を渡し、基本の制限は15秒である。usage値は実行ごとに取得し、ディスクへキャッシュしない。

成功bodyは基本64KiB、エラーbodyは4KiBまで読む。provider固有の応答サイズが必要な要求はその上限に従う。成功bodyの上限超過・不正JSON・object以外のJSONは取得失敗とする。

出力する成功値・失敗理由は、既知の認証情報を除去してから表示用の制御文字除去・短縮を行う。HTTP失敗時は生の応答本文を表示せず、providerの残量率を欠損値として返す。OSC・CSIなどの端末制御列は表示として実行しない。

| 状況 | 終了コード |
| --- | --- |
| 1件以上成功、一覧成功、対象0件 | `0` |
| 試行した照会がすべて失敗、設定ファイルの読み取り・解析失敗 | `1` |
| 引数の誤り | `2` |

コマンド全体のエラーはstderrへ `usage: <理由>` と出す。provider単位の失敗は標準出力の結果に含める。JSONは2スペースインデント、出力がある場合は末尾改行を付ける。

## 帰属

provider処理・正規化・整形は [narumiruna/pi-extensions の pi-usage](https://github.com/narumiruna/pi-extensions/tree/80566d6cf05e93b068d02ff235e3ae55d22ba01a/packages/pi-usage) v0.68.1に基づく。
