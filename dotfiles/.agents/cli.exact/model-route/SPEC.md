# model-route CLI

`model-route` は、provider の利用残量・期間・リセット時刻から、モデル候補の正規化urgencyと利用状況を返す独立CLI。pi拡張（agents拡張）が class の候補選択に使う。利用者と保守担当者が、コマンドの入出力・キャッシュ・失敗時の挙動を確認するための振る舞い正本である。

残量の照会は `usage` CLI に依存し、自身は照会結果のキャッシュとurgency計算を担う。候補のスコアリングと並べ替え、provider や model の実在確認は呼び出し元が担う。モデルへのリクエストと、レート制限・cooldown の管理は呼び出し元が担う。

## コマンド

| 入力 | 結果 |
| --- | --- |
| `model-route score [<file>]` | file（省略時は標準入力、標準入力が端末の場合は使い方を表示して終了コード `2`）の候補JSONへurgencyと利用状況を加え、入力順のJSON配列で出す |
| 不明なコマンド・不明なフラグ | stderrに `model-route:` 付きの理由と使用方法を出す。照会しない |

## 入出力

`score` の入力は、`candidates` 配列を持つobjectである。各候補の `provider` と `model` は必須の非空文字列である。余分な入力フィールドは解釈せず、出力へ伝播しない。不正な入力はstderrへ理由を出し、終了コード `2` となる。

成功出力は、各候補の `provider`・`model`・`urgency`・`usageState` だけを持つ直接JSON配列である。全候補を入力順に保持し、残量0・利用状況不明・同一provider/modelの重複も返す。候補が0件なら `[]` を返す。

`usageState` は `remaining`（0〜100の残量率）・`resetsAt`（リセット日時）・`windowMinutes`（long枠の全期間、分単位。不明なら `null`）・`source`（`cache` または `fresh`）を持つ。利用状況を取得できない候補とリセット済みの候補では `usageState` は `null` となる。

```json
[
  {
    "provider": "zai",
    "model": "glm-5.3",
    "urgency": 1.8,
    "usageState": {
      "remaining": 90,
      "resetsAt": "2026-06-21T00:00:00+00:00",
      "windowMinutes": 10080,
      "source": "cache"
    }
  }
]
```

## urgency

`urgency = (remaining / 100) × windowMinutes / max(remainingMinutes, 60)` とする。`remainingMinutes` は現在時刻からリセットまでの分数である。値が大きいほど、残量と期間に対してリセットが近く、積極的に消化すべき状態を表す。

| 利用状況 | urgency |
| --- | --- |
| 全期間の半分が残り、残量50% | `1` |
| 全期間の半分が残り、残量90% | `1.8` |
| リセットまで1時間未満 | 分母を60分として計算 |
| 有効な期間・未来のリセット時刻があり、残量0 | `0` |
| 利用状況不明、リセット済み・不正日時、期間が欠落・非正・非有限 | `null` |

期間の正本は `usage --json` の `longWindowMinutes` であり、providerやリセット時刻から推測しない。

## usage の照会とキャッシュ

照会対象のproviderは、候補の `provider` と同じIDを使う。`commandcode` は `command-code` の正規IDへ読み替える。照会は `usage --json` を実行し、long枠の残量率・リセット日時・全期間（`longWindowMinutes`）を使う。long枠が不明なproviderは候補から取得できないものとして扱う。

キャッシュは `XDG_CACHE_HOME` があれば `$XDG_CACHE_HOME/model-route/usage.json`、なければ `~/.cache/model-route/usage.json` に保存する。成功した全体照会の残量率・リセット日時・全期間と照会完了時刻を保持し、有効期間は5分固定である。空の照会結果や不明なproviderも同じスナップショットに含まれるため、5分以内は候補の追加・変更による再照会も行わない。urgencyは保存せず、呼び出し時の現在時刻で再計算する。期間が欠けた有効なスナップショットは残量率と日時を保持し、期間を `null` として扱う。キャッシュの不在・不正JSON・未対応形式は未取得として扱い、コマンドの失敗にはしない。

| 条件 | 動作 |
| --- | --- |
| 候補がない | 照会しない |
| 取得から5分以内のスナップショットがある | 保存済みの結果を使い、照会しない |
| スナップショットがない、または5分を超過した | `usage --json` を1回実行し、成功結果でスナップショット全体を置き換える |
| fresh・cacheのリセット日時が採用時点の現在時刻以前 | そのproviderのusageを不明として候補を保持する。有効期間内は再照会しない |
| スナップショットの保存が失敗した | fresh値から通常のurgency配列を返し、stderrへ `model-route:` 付きの短い警告を出す |

fresh値の採用とurgency計算には、照会完了後の現在時刻を使う。

## 通信・安全性・終了コード

照会に使うコマンド名は `usage` 固定で、PATHから解決し、タイムアウトは20秒とする。タイムアウト・非ゼロ終了・不正JSONの照会は、全体の失敗（すべての候補がurgency `null`）として扱い、キャッシュへ書かない。キャッシュの読み書きは原子に行い、ロックはしない。stdoutには成功時のJSON配列だけを出し、診断はstderrへ出す。

| 状況 | 終了コード |
| --- | --- |
| `score` の成功（照会失敗での `null` urgency、キャッシュ保存失敗を含む） | `0` |
| 引数・入力の誤り | `2` |
