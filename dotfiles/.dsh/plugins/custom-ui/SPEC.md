# custom-ui

dsh web プロファイルの composer 周りを、既定のままだと邪魔な表示を減らし、モデル選択と reasoning effort の既定を整える dsh bundle plugin。設定ファイルは持たず、plugin を profile から外すことで全体を無効化する。対象は dsh web UI。

## 読み込み順

本 plugin は `dotfiles-dsh-agents` bundle より先に読み込まれることを要件とする。既定 effort のフォールバックを `agent/request` waterfall で先に処理し、`next()` で class routing（`dotfiles-dsh-agents`）へ渡すためである。

## 用語

- **/model popup**: `/model` コマンド実行時に開く、provider 別グループのモデル・effort 選択画面。addressed subagent セッションでは /model コマンドが利用できないため、chord でも開かない。
- **セッション表示中**: 既存セッションが開かれ、composer が入力可能な状態。
- **ツール行**: composer の入力欄の下に並ぶ操作行全体。左側のボタン群(commands・add attachment 等)と右側のモデル選択 control の双方を含み、左側のみを指さない。
- **advertised effort**: 選択中のモデルが dsh カタログで対応を広告する effort レベル(off / minimal / low / medium / high / xhigh / max のうち)。
- **既定 effort**: effort を明示選択していないときにリクエストへ設定するレベル。選択中モデルの advertised effort のうち Off を除く最も高いレベル。Off を除く advertised effort が存在しない、またはカタログから確定できない場合は effort を設定しない。
- **chord 待ち**: Ctrl+K 入力後、1000ms 以内(ちょうど 1000ms を含む)だけ次のキーを受け付ける状態。
- **turn 尾部**: 完了した turn のアクション行の前に置かれる chain slot(`conversation.chat.turnTail`)の表示領域。
- **turn usage パネル / turn 時間パネル**: assistant メッセージ下のアクション行に付く、DB アイコンのトークン使用量パネルと時計アイコンの所要時間パネル。両者は同一 CSS module を共有するため CSS では区別できない。
- **session stats pills**: composer 下の時間統計とトークン統計の pill 群。
- **feedback ボタン**: assistant メッセージ下のアクション行に付く 👍/👎 のメッセージ評価ボタン。

## composer のモデル選択 control

本節の非表示は、セッション表示中・新規セッション画面の双方で適用される。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄のツール行を見る | ツール行にモデル選択 control(モデル名・effort の表示と選択メニュー)が存在しない |

## composer の tool row ボタン

本節の非表示は、セッション表示中・新規セッション画面の双方で適用される。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄のツール行を見る | commands ボタン(プラスアイコン)が存在しない |
| セッション表示中 | 入力欄のツール行を見る | add attachment ボタン(クリップアイコン)が存在しない |
| セッション表示中 | 入力欄のツール行を見る | access mode(workspace write 等)の選択 control が存在しない |
| セッション表示中 | 入力欄のツール行を見る | plan チップが存在しない |
| セッション表示中 | 入力欄へ `/` を入力 | コマンドメニューは従来どおり開く(本機能はボタンのみを消し、メニュー自体は変えない) |

## New Session 画面の chip 行

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション未選択の新規セッション画面 | 入力欄の上を見る | agent preset(標準モード)選択 chip が存在しない |
| セッション未選択の新規セッション画面 | 入力欄の上を見る | ワークスペース選択 chip が存在しない |

## New Session 画面の中央タイトル行

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション未選択の新規セッション画面 | 入力欄の上の中央を見る | 魚アイコン・タイトル・Preview バッジのタイトル行が存在しない |

## turn usage・時間パネルと自前 turn 時間表示

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 完了した turn のメッセージ下を見る | turn usage パネルと turn 時間パネルが存在しない |
| セッション表示中 | 完了した turn のメッセージ下を見る | turn 尾部に時計アイコンと所要時間(例: `1m 23s`)の表示が存在する |
| セッション表示中 | 未完了の turn のメッセージ下を見る | 自前の所要時間表示は存在しない |
| 同一 turn で stock の尾部表示(deliverables 等)が描画対象 | メッセージ下を見る | 自前の所要時間表示の代わりに stock 尾部が表示される(chain は昇順試行で本 plugin は末尾) |
| セッション表示中 | 自前の所要時間表示をクリック | 何も起きない(詳細 dialog は再実装しない) |

## composer 下の session stats pills

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄の下を見る | 時間統計・トークン統計の pill 群が存在しない |

## assistant メッセージの feedback ボタン

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | assistant メッセージ下のアクション行を見る | 👍/👎 の feedback ボタンが存在しない |
| セッション表示中 | メッセージ下のアクション行の他の操作(copy・branch 等)を使う | 従来どおり働く(本機能は feedback ボタンのみを消し、行自体は変えない) |

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
