# dsh-footer

## 目的

dsh web UI の composer 下に、現在のセッション ID を常時表示する。pi の footer extension が上段右端に表示しているセッション ID を dsh へ移行したものである。

## 表示

composer 下 dock に現在のセッション ID を表示する。文字色の指定がない限り gray 系（dim）で統一する。

| 状態 | 表示 |
| --- | --- |
| 常時 | 現在のセッションの ID を省略せず全文字表示する。セッションの切替・作成に追従する |

- 表示書式は `session: <id>`（pi footer と同じ形式）とする
- セッション ID は client slot の標準 props（`scope: 'session'` の `sessionId`）から取得し、表示のための host 側配線を持たない

## 対象外

pi footer が常時表示していたセッション累積コスト（stats 行の `$金額`）は移行対象外とする。dsh client 側に金額のデータソースが存在しないためである。`tokenUsage` projection はトークン数 4 項目のみを持ち、turn 単位・provider 単位を含む全 usage 型に cost フィールドはなく、モデル別単価表も client に存在しない。代替として stock の StatsPills がセッション累計のトークン合計と cache-hit 率を表示するが、コスト表示の代替は dsh web UI 全体に存在しない。

## 設定

表示の ON/OFF の設定ファイルは設けない。profile から plugin を除外することで全体を無効化する。
