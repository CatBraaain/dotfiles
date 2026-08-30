# reset-hint 拡張機能 Spec

セッションの継続と新規セッションへの切替のどちらがトークン効率で有利かを、フッターの拡張ステータス行に表示して判断材料にする。対象は Pi の TUI フッター（footer が表示する拡張ステータス行）。読者は本仕様の承認者と実装者。

## 表示

拡張ステータス行に次の形式で表示する。

```text
3+ turns: reset < continue (≈30k; saves 63%)
```

| 部分 | 意味 |
| --- | --- |
| `3+ turns` | あと3往復以上続けるとき、切替の予想実効トークンコストが継続より低くなる |
| `reset < continue` | 切替の予想実効トークンコストが継続より低いこと |
| `≈30k` | 今新規セッションに切り替えて同程度の作業を1往復した場合の予想コンテキストトークン数 |
| `saves 63%` | 切替による予想コンテキスト削減率 |

## 計算

対象は、直近の compaction 以降（なければセッション開始以降）の assistant メッセージの usage。toolResult 等の入れ子 usage は数えない。assistant メッセージの完了時点のコンテキストトークン数は `input + cacheRead + cacheWrite + output` とする。

リセット後に同程度の作業を1往復した場合は、対象範囲の最初の assistant メッセージが完了した時点と同じコンテキストトークン数になると予測する。

入力値:

| 名前 | 定義 |
| --- | --- |
| `firstAssistantContextTokens` | 対象範囲の最初の assistant メッセージが完了した時点のコンテキストトークン数 |
| `currentContextTokens` | 現在のコンテキストトークン数（`getContextUsage().tokens`） |
| `latestCacheHitRate` | 直近の assistant メッセージのキャッシュヒット率。prompt トークン数のうち `cacheRead` の割合。`cacheRead` と `cacheWrite` がともに 0 なら未定義 |

導出:

```text
newSessionContextTokens =
  firstAssistantContextTokens

contextReductionRate =
  1 - newSessionContextTokens / currentContextTokens

effectiveInputCostFactor =
  (1 - latestCacheHitRate) + latestCacheHitRate × 0.1

newSessionContextRatio =
  newSessionContextTokens / currentContextTokens

breakEvenTurnCount =
  newSessionContextRatio × (1 - effectiveInputCostFactor) /
  (effectiveInputCostFactor × (1 - newSessionContextRatio))

minimumRemainingTurnsForReset =
  max(1, ceil(breakEvenTurnCount))
```

`contextReductionRate` は小数点以下を四捨五入した整数%で表示する。`latestCacheHitRate` が未定義のとき、`effectiveInputCostFactor` は 1 とする。`breakEvenTurnCount` は `newSessionContextTokens < currentContextTokens` のときのみ定義する。

キャッシュ読み取りトークンのコストは通常入力トークンの 10% として計算する。

トークン数の表示は、1000未満を整数、1000以上10000未満を小数1桁の `k`、10000以上100万未満を整数の `k`、100万以上1000万未満を小数1桁の `M`、1000万以上を整数の `M` とする。

## 表示条件

| 条件 | 拡張ステータス行 |
| --- | --- |
| `firstAssistantContextTokens` と `currentContextTokens` が定義され、`newSessionContextTokens < currentContextTokens` | `{minimumRemainingTurnsForReset}+ turns: reset < continue (≈{newSessionContextTokens}; saves {contextReductionRate}%)` を表示する |
| 上記以外 | 何も表示しない（ステータスをクリアする） |

## 更新

| 状態 | 表示される結果 |
| --- | --- |
| assistant メッセージが完了する | 再計算して表示を更新する |
| セッションの開始・再開・フォークが完了する | そのセッションの履歴から再計算する |
| compaction が完了する | ステータスをクリアする。次に assistant メッセージが完了した時点を新しい予測の基準にする |
| 表示条件を満たさなくなる | ステータスをクリアする |

## 例

`firstAssistantContextTokens = 20k`、`currentContextTokens = 80k`、`latestCacheHitRate = 90%` のとき:

```text
newSessionContextTokens = 20k
contextReductionRate = 75%
effectiveInputCostFactor = 0.19
breakEvenTurnCount = 1.42
minimumRemainingTurnsForReset = 2

2+ turns: reset < continue (≈20k; saves 75%)
```
