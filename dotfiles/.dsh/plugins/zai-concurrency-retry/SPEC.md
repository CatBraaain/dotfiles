# dsh-zai-concurrency-retry plugin Spec

Z.AI coding plan の同時実行制限エラー（業務コード 1302 / 1305）を検知し、バックオフ待機してから同じ step を再試行し続ける host plugin。対象読者は、Z.AI ルートで並走・連続リクエストを行うオーナーと agent。

## 対象

| 条件       | 値                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| プロバイダ | `agent/request-error` payload の `provider` が `zai` または `zai-coding-cn` のとき（現行 dsh デプロイが登録するのは `zai` のみ。`zai-coding-cn` は pi 側 model-sync 由来の将来用） |
| エラー     | `failure.message` が次のいずれかに一致すること: 生 JSON ボディの `code":"1302"` / `code":"1305"`（正規表現 `code"\s*:\s*"130[25]"`）、`rate limit reached for requests`（大文字小文字無視）、`temporarily overloaded`（大文字小文字無視） |

対象外: quota 系エラー（`1113`、`1308`〜`1321`）と zai 以外のプロバイダ。これらには本 plugin は何もせず `next()` で委譲し、dsh-llm-retry の予算付きリトライと dsh-agents のモデルフォールバック（cooldown + 次候補切替）に従う。

同時実行エラーはモデルフォールバックを起こさない。Z.AI の同時実行制限はアカウント単位のため切替では解決しない。本 plugin の listener は `prepend: true` で waterfall の最外側に登録され、対象エラーを握って下流（dsh-llm-retry、dsh-agents）へ渡さない。plugin の load 順は bundle 並び順ではなく service-availability 駆動で決まるため、優先順位はこの登録方法でのみ保証する。

## 再試行

| 状態                                       | 操作                       | 結果                                                                                          |
| ------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------- |
| 対象エラーが `agent/request-error` に届く  | 待機時間だけ待つ           | `{kind: 'retry'}` を返し、同じ step のリクエストを再実行する。再試行回数に上限はない         |
| 待機中に turn の abort signal が発火する   | 待機を中断する             | `undefined` を返し、失敗は terminal のままターンを終える                                      |
| 対象外の失敗（他プロバイダ・quota 系を含む） | —                          | `next()` で委譲し、本 plugin は何もしない                                                    |

## 待機時間

連続エラー回数 `n` に対し `5s × 2^(n-1)`（上限 60s）に ±20% の対称ジッタを加えた値（ジッター後の値は上限を 20% 超え得る。pi と同一式）。連続エラー回数は agent ごとの in-memory で、同じ turn かつ同じ step の再試行ループの中で加算され、turn または step が変わると 1 に戻る（dsh の再試行は step 内でループするため、成功や新 step の開始が自然にリセットを兼ねる。llm-retry の projection と同じリセット・タイミング）。

`failure.providerRetryAfterMs` が正の有限値で届いた場合、ローカルバックオフとジッターを置き換えてその値を優先する。現行の dsh-llm-pi-ai はこの値を設定しないため、常にローカルバックオフが効く。

## 表示

待機の開始時に1行の警告ログを出す（dsh-agents のレート制限ログと同じ手段・文言構造）:

```
Z.AI concurrency limit on <provider> (attempt <n>); retrying the same step in <秒>s: <failure.message>
```

ステータス領域・通知（pi の `ctx.ui.setStatus` / `notify` 相当）は持たない。トランスクリプト上での待機表示は client bundle になるため範囲外。

## 状態のスコープ

再試行チェーンは agent ごと（`WeakMap<Agent>`）。プロセス再起動で消える（pi の module 変数と同じ非 durable）。セッションイベントは追加しない。
