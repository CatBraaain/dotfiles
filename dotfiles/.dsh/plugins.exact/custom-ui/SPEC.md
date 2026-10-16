# custom-ui

## 目的

dsh webプロファイルの composer周りを、既定のままだと邪魔な表示を減らし、モデル選択と reasoning effort の既定を整えるdsh bundle plugin。設定ファイルは持たず、plugin を profile から外すことで全体を無効化する。対象は dsh web UI。

## 用語

- **セッション表示中**: 既存セッションが開かれ、composer が入力可能な状態。
- **ツール行**: composer の操作行全体。stock は入力欄の下に置き、本plugin適用後は入力欄の右端に置く(「composer の 1行化」)。stock の左側のボタン群(commands・add attachment等)と右側のモデル選択control の双方を含み、左側のみを指さない。
- **advertised effort**: 選択中のモデルが dshカタログで対応を広告するeffortレベル(off / minimal / low / medium / high / xhigh / max のうち)。
- **既定effort**: effort を明示選択していないときにリクエストへ設定するレベル。選択中モデルの advertised effort のうちOff を除く最も高いレベル。Off を除くadvertised effort が存在しない、またはカタログから確定できない場合は effort を設定しない。
- **chord待ち**: Ctrl+K入力後、1000ms以内(ちょうど1000ms を含む)だけ次のキーを受け付ける状態。
- **turn尾部**: 完了したturn のアクション行の前に置かれるchain slot(`conversation.chat.turnTail`)の表示領域。

## 基準

- 基準とするstock機能: dsh web の composer周りUI、`/model` popup、`agent/request` のリクエスト構成
  - `@deepseek-ai/dsh-client-ui-conversation`: `InputBar` のツール行ボタン群と `PermissionSelect`、New Session画面の hero chip行(`ConversationRoot`)と中央タイトル行(`EmptyHero`)
  - single slot `conversation.input.model` の stock seat `ModelSelect`(`@deepseek-ai/dsh-client-ui-model-selection`)、single slot `conversation.input.plan` の stock seat `PlanModeControl`(`@deepseek-ai/dsh-client-ui-plan`)
  - `@deepseek-ai/dsh-client-ui-chat`: assistantメッセージ下の turn usage・turn時間パネル(`TurnUsagePanel` / `TurnTimePanel`)、composer下の stats pills(`StatsPills`、`conversation.composer.dock`)
  - `@deepseek-ai/dsh-client-ui-message-feedback`: assistantメッセージの 👍/👎 feedbackボタン(`MessageFeedbackActions`)
  - `/model` コマンドの popup(`@deepseek-ai/dsh-client-ui-model-selection` の commandUi contribution。provider別グループのモデル・effort選択画面。addressed subagentセッションでは利用できない)
  - `agent/request` waterfall が組むリクエスト: effort を明示選択していないリクエストに effort を付けない
- 本SPEC に明記しない限り、基準stock の振る舞いは変更されない
- 無効化・置換するstock構成: なし。profile の stock plugin構成は変えず、削除は client側の隠蔽(slot の shadow登録と CSS)で行う
- 置換後も stock に合わせる点:
  - chord が開く画面は stock の `/model` popup と同一(行構成・options load失敗時の retry見た目まで)
  - 自前turn時間表示の数値規則と見た目は stock の turn時間パネル(`TurnTimePanel`)に合わせる
  - 既定effort の判定源は dshカタログ(選択中モデルの advertised effort)に合わせる

## 削除

### composer のモデル選択control

stock `ModelSelect`(single slot `conversation.input.model` の seat)。本節の非表示は、セッション表示中・新規セッション画面の双方で適用される。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄のツール行を見る | ツール行にモデル選択control(モデル名・effort の表示と選択メニュー)が存在しない |

### composer の tool rowボタン

stock `InputBar` のツール行ボタン群と `PermissionSelect`(access mode選択)。本節の非表示は、セッション表示中・新規セッション画面の双方で適用される。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄のツール行を見る | commandsボタン(プラスアイコン)が存在しない |
| セッション表示中 | 入力欄のツール行を見る | add attachmentボタン(クリップアイコン)が存在しない |
| セッション表示中 | 入力欄のツール行を見る | access mode(workspace write等)の選択control が存在しない |
| セッション表示中 | 入力欄のツール行を見る | planチップが存在しない |
| セッション表示中 | 入力欄へ `/` を入力 | コマンドメニューは従来どおり開く(本機能はボタンのみを消し、メニュー自体は変えない) |

### New Session画面の chip行

stock `ConversationRoot` の hero workspace行(agent preset・ワークスペース選択chip)。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション未選択の新規セッション画面 | 入力欄の上を見る | agent preset(標準モード)選択chip が存在しない |
| セッション未選択の新規セッション画面 | 入力欄の上を見る | ワークスペース選択chip が存在しない |

### New Session画面の中央タイトル行

stock `EmptyHero` の headline行。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション未選択の新規セッション画面 | 入力欄の上の中央を見る | 魚アイコン・タイトル・Previewバッジのタイトル行が存在しない |

### turn usage・時間パネルと自前turn時間表示

stock の turn usageパネル(DBアイコンのトークン使用量パネル)と turn時間パネル(時計アイコンの所要時間パネル)。両者は stock で同一CSS module を共有するため、CSS による非表示では区別できない。本plugin は両パネルを削除し、代わりに turn尾部(`conversation.chat.turnTail` chain)へ自前の所要時間表示を置く。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 完了したturn のメッセージ下を見る | turn usageパネルと turn時間パネルが存在しない |
| セッション表示中 | 完了したturn のメッセージ下を見る | turn尾部に時計アイコンと所要時間(例: `1m 23s`)の表示が存在する |
| セッション表示中 | 未完了の turn のメッセージ下を見る | 自前の所要時間表示は存在しない |
| 同一turn で stock の尾部表示(deliverables等)が描画対象 | メッセージ下を見る | 自前の所要時間表示の代わりに stock尾部が表示される(chain は昇順試行で本plugin は末尾) |
| セッション表示中 | 自前の所要時間表示をクリック | 何も起きない(詳細dialog は再実装しない) |

### composer下の session stats pills

stock `StatsPills`(時間統計とトークン統計の pill群)。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄の下を見る | 時間統計・トークン統計の pill群が存在しない |

### assistantメッセージの feedbackボタン

stock `MessageFeedbackActions`(assistantメッセージ下のアクション行に付く 👍/👎 のメッセージ評価ボタン)。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | assistantメッセージ下のアクション行を見る | 👍/👎 の feedbackボタンが存在しない |
| セッション表示中 | メッセージ下のアクション行の他の操作(copy・branch等)を使う | 従来どおり働く(本機能は feedbackボタンのみを消し、行自体は変えない) |

## 変更

### composer の 1行化

stock `InputBar` は入力欄の下にツール行を置く。本plugin は削除節で残ったcontext meter と送信系ボタンを入力欄と同じ行の右端へ再配置し、composer を 1行にする。再配置は CSS の上書きで行い、stock の DOM構造・slot・ボタンの有効性の規則は変えない。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄のカードを見る | ツール行(context meter と送信系ボタン)が入力欄の右端に並ぶ。ボタン列は入力欄の下に存在しない |
| 空のドラフト | 入力欄のカードを見る | ツール行は入力欄の下の独立した行として存在しない |
| 空でないドラフト | 複数行を入力する | ツール行はカード右下に留まる。テキストはツール行の左側で折り返し、ボタンの下を通らない |
| セッション実行中 | 入力欄の右端を見る | 送信ボタンは stockどおり停止ボタンに変わり、位置は右端のまま |
| セッション表示中 | context meter をクリック | 内訳panel は従来どおりmeter の上に開く |
| セッション表示中 | 添付ファイルを追加する | 添付プレビュー行は入力欄の上に従来どおり出る(1行化の対象外) |
| 新規セッション画面 | 入力欄を見る | hero composer も同じ1行レイアウト |
| 入力が無効な状態(権限・削除済み等) | 入力欄を見る | 無効化された送信系ボタンが右端に表示される(位置のみの変更で、有効性の規則は変えない) |
| continuable な subagentセッション実行中 | 入力欄の右端を見る | 停止ボタンと送信ボタンが並ぶ。ツール行の幅がテキスト列の予約幅を超えるときも、テキストがボタンの下に透けて見えることはない |

### 既定effort とフォールバック

本plugin は `dotfiles-dsh-agents` bundle より先に読み込まれることを要件とする。既定effort のフォールバックを `agent/request` waterfall で先に処理し、`next()` で class routing(`dotfiles-dsh-agents`)へ渡すためである。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| effort未選択・モデルが Max を advertised | リクエストを送信 | リクエストの effort は Max |
| effort未選択・モデルが Max を advertisedしない(Xhigh は advertised) | リクエストを送信 | リクエストの effort は Xhigh(既定effort の規則どおり) |
| effort未選択・モデルが Off のみadvertised | リクエストを送信 | リクエストに effort を付けない(provider既定のまま) |
| popup で effort を明示選択 | リクエストを送信 | 選択したeffort がそのまま使われる(既定effort の規則は適用されない) |
| provider・route を問わない | リクエストを送信 | 上記の既定effort の規則はすべての provider・モデルで働く |
| 関係なく | /model popup を開く | popup の既定effort表示は従来どおり(本機能はリクエスト側のみを変更し、表示は変えない) |

## 追加

### Ctrl+K → Ctrl+M でモデル選択

セッション表示中、chord待ちに Ctrl+M を続けると stock の `/model` popup を開く。開く画面は stock の popupそのものである。addressed subagentセッションでは `/model` コマンドが利用できないため、chord でも開かない。

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | Ctrl+K → 1秒以内に Ctrl+M | /model popup が開く(/modelコマンド実行時と同一の画面) |
| セッション表示中 | Ctrl+K → 1秒以内に他のキー | chord待ちが解除され、popup は開かない |
| セッション表示中 | Ctrl+K → 1秒以上経過後に Ctrl+M | popup は開かない(Ctrl+M は通常の文字入力として扱われる) |
| セッション表示中 | Ctrl+K のみ入力 | 何も起きない |
| セッション未選択の新規セッション画面 | Ctrl+K → 1秒以内に Ctrl+M | 何も起きない |
| composer入力欄へフォーカスがある / ない | Ctrl+K → 1秒以内に Ctrl+M | /model popup が開く(フォーカス位置に依存しない) |
| セッションの remote wiring が不全でディレクトリ解決に失敗 | Ctrl+K → 1秒以内に Ctrl+M | keydown からは決してthrowしない。popup が開きoptions load の失敗と retry が表示される(stock の options load失敗時と同一の見た目) |
