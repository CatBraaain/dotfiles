# session-list

## 目的

dsh web の sidebar セッションリストを自前実装に置き換え、行ごとに archive と copy session id をワンクリックで実行できるようにする。合わせて、composer 下の session id 常時表示（`dotfiles-dsh-footer`）を profile から除外する。設定ファイルは持たず、plugin を profile から外すことで全体を無効化する。対象は dsh web UI。

## 用語

- **セッションリスト**: sidebar 中央のセッション行一覧。stock では workspace グルーピング付きブラウザだが、本 plugin はフラットな一覧に置き換える
- **rail**: sidebar を折りたたんだときの 56px icon 列表示
- **行 actions**: 行に hover したとき行右端へ現れる archive ボタンと copy session id ボタンの 2 つ
- **status dot**: 行左端の状態表示。pending interaction（amber warning）/ running（blue activity）/ completed（green done）/ 待ちも実行も完了もしていない idle（tertiary label 色）を示す stock の `StateDot`
- **blank**: まだログを持たない New Session 用セッション
- **archived**: stock の archive 操作で退避済みのセッション

## sidebar のセッションリスト

### 置き換え

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| dsh web 起動中 | sidebar 中央の領域を見る | セッションリストは本 plugin の描画であり、stock の workspace ブラウザ（グルーピング・検索・ドラッグ並べ替え・hover card・schedule marker・Add workspace・Show more 折り畳み）は存在しない |
| 同上 | rename / fork を探す | 行 actions に rename と fork は存在しない（削除済み機能） |
| 同上 | hero 側（New Session 画面）を見る | hero 側の workspace picker は stock のままで変わらない |

### リストの内容

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッションが存在する | リストを見る | 各行は status dot・タイトル・相対時刻で構成される。行の並びは host が返す一覧の順序どおり |
| subagent 起点のセッションが存在する | リストを見る | subagent 起点の行は存在しない |
| archived なセッションが存在する | リストを見る | archived な行は存在しない |
| 選択中でない blank なセッションが存在する | リストを見る | その行は存在しない（表示する blank は選択中の 1 行だけ） |
| blank なセッションが選択中（New Session 画面） | リストを見る | blank 行は相対時刻なしで表示され、行 actions は出ない |
| あるセッションが表示中 | リストを見る | その行がハイライトされる |
| セッションが存在しない | リストを見る | 空の領域が表示される |

### 行クリック

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| 既存セッションの行をクリック | 行をクリック | そのセッションが開き、開いていた panel があれば閉じて conversation へ戻る |
| blank 行をクリック | 行をクリック | その New Session が開く |

### 行 actions

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| 非 blank の行に hover | 行右端を見る | archive ボタンと copy session id ボタンが横並びで現れる |
| 非 blank の行に hover | 行の相対時刻を見る | 時刻は隠れ、actions と入れ替わる |
| archive ボタンをクリック | クリック | 確認ダイアログなしでそのセッションが archive され、行がリストから消える |
| archive が失敗する | 操作の後を見る | 行はリストに残り、ユーザー可視のエラーは出ない（コンソール警告のみ） |
| 表示中セッションの archive ボタンをクリック | クリック | archive され、画面は New Session view へ切り替わる |
| copy session id ボタンをクリック | クリック | その行のセッション id（id 文字列のみ、prefix なし）がクリップボードへ書き込まれる |
| copy session id ボタンのクリップボード書き込みが失敗 | ボタンを見る | check icon には変わらず、copy icon のまま |
| copy session id ボタンをクリック後 | ボタンを見る | 1 秒間 check icon に変わり、その後 copy icon へ戻る |
| blank 行に hover | 行右端を見る | 行 actions は現れない |

### rail

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| sidebar を折りたたむ | rail を見る | 各行は status dot のみの icon 列になり、タイトル・相対時刻・行 actions は表示しない |
| rail の行をクリック | クリック | 展開時と同じくそのセッションが開く |

## composer 下の表示（dotfiles-dsh-footer の削除）

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄の下を見る | `session: <id>` の常時表示とコピーボタンが存在しない |
