# custom-ui

dsh web プロファイルの composer 周りを、既定のままだと邪魔な表示を減らし、モデル選択と reasoning effort の既定を整える dsh bundle plugin。設定ファイルは持たず、plugin を profile から外すことで全体を無効化する。対象は dsh web UI。

## 読み込み順

本 plugin は `dotfiles-dsh-agents` bundle より先に読み込まれることを要件とする。既定 effort のフォールバックを `agent/request` waterfall で先に処理し、`next()` で class routing（`dotfiles-dsh-agents`）へ渡すためである。

## 用語

- **/model popup**: `/model` コマンド実行時に開く、provider 別グループのモデル・effort 選択画面。addressed subagent セッションでは /model コマンドが利用できないため、chord でも開かない。
- **セッション表示中**: 既存セッションが開かれ、composer が入力可能な状態。
- **advertised effort**: 選択中のモデルが dsh カタログで対応を広告する effort レベル(off / minimal / low / medium / high / xhigh / max のうち)。
- **既定 effort**: effort を明示選択していないときにリクエストへ設定するレベル。選択中モデルの advertised effort のうち Off を除く最も高いレベル。Off を除く advertised effort が存在しない、またはカタログから確定できない場合は effort を設定しない。
- **chord 待ち**: Ctrl+K 入力後、1000ms 以内(ちょうど 1000ms を含む)だけ次のキーを受け付ける状態。

## composer のモデル選択 control

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄のツール行を見る | ツール行にモデル選択 control(モデル名・effort の表示と選択メニュー)が存在しない |

## New Session 画面の chip 行

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション未選択の新規セッション画面 | 入力欄の上を見る | agent preset(標準モード)選択 chip が存在しない |
| セッション未選択の新規セッション画面 | 入力欄の上を見る | ワークスペース選択 chip が存在しない |

## Ctrl+K → Ctrl+M でモデル選択

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | Ctrl+K → 1 秒以内に Ctrl+M | /model popup が開く(/model コマンド実行時と同一の画面) |
| セッション表示中 | Ctrl+K → 1 秒以内に他のキー | chord 待ちが解除され、popup は開かない |
| セッション表示中 | Ctrl+K → 1 秒以上経過後に Ctrl+M | popup は開かない(Ctrl+M は通常の文字入力として扱われる) |
| セッション表示中 | Ctrl+K のみ入力 | 何も起きない |
| セッション未選択の新規セッション画面 | Ctrl+K → 1 秒以内に Ctrl+M | 何も起きない |
| composer 入力欄へフォーカスがある / ない | Ctrl+K → 1 秒以内に Ctrl+M | /model popup が開く(フォーカス位置に依存しない) |

## 既定 effort とフォールバック

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| effort 未選択・モデルが Max を advertised | リクエストを送信 | リクエストの effort は Max |
| effort 未選択・モデルが Max を advertised しない(Xhigh は advertised) | リクエストを送信 | リクエストの effort は Xhigh(既定 effort の規則どおり) |
| effort 未選択・モデルが Off のみ advertised | リクエストを送信 | リクエストに effort を付けない(provider 既定のまま) |
| popup で effort を明示選択 | リクエストを送信 | 選択した effort がそのまま使われる(既定 effort の規則は適用されない) |
| provider・route を問わない | リクエストを送信 | 上記の既定 effort の規則はすべての provider・モデルで働く |
| 関係なく | /model popup を開く | popup の既定 effort 表示は従来どおり(本機能はリクエスト側のみを変更し、表示は変えない) |
