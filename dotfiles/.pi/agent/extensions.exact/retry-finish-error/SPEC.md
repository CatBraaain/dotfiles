# retry-finish-error

OpenAI 互換プロバイダの中には、標準外の `finish_reason`（`error`、`timeout_reached` 等の任意文字列）を返すものがある。pi はこれを `Error: Provider finish_reason: ${reason}` として扱い、ランが失敗する。本拡張は、このエラーが発生したときリトライ設定の予算が残っていれば、同一モデルでの自動再試行が行われるようにする。

適用範囲: エラーのリトライ可否の判定のみ。再試行の回数と待ち時間は制御しない。

## 振る舞い

assistant メッセージが `stopReason: "error"` で終了したとき、`errorMessage` の内容に応じて次のように振る舞う。

| `errorMessage` の内容                                             | 本拡張の動作                                                        | その後の再試行                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `Provider finish_reason: ${reason}` で始まり、`${reason}` が `content_filter` / `network_error` 以外の文字列 | `errorMessage` を `provider returned error: ${元のerrorMessage}` に置き換える | pi 内蔵の auto-retry による同一モデルの再試行が行われる |
| `Provider finish_reason: content_filter`                           | 何もしない                                                          | 再試行されない（同じ入力では失敗が繰り返されるため） |
| `Provider finish_reason: network_error`                            | 何もしない                                                          | 本拡張なしでも内蔵 auto-retry が発火する       |
| 上記以外のエラーメッセージ（HTTP エラー文言等）                     | 何もしない                                                          | pi 本来のリトライ分類に従う                    |

role が `assistant` 以外、`stopReason` が `"error"` 以外、または `errorMessage` がないメッセージは対象外とし、何もしない。

## リトライ予算・間隔

再試行の有無・回数・待ち時間は pi の settings.retry（`enabled` / `maxRetries` / `baseDelayMs`）だけが決める。予算を使い切った場合、ランは本拡張がない場合と同じくエラーで終わる。本拡張はエラーをリトライ可能な種別に分類し直すだけで、予算や間隔を独自に制御しない。
