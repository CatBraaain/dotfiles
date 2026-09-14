# session-list

## 目的

dsh web の sidebar セッションリストを自前実装に置き換え、workspace（cwd）単位のグルーピング表示、Add workspace、Show more 折り畳みと、行ごとの archive / copy session id をワンクリックで提供する。合わせて、composer 下の session id 常時表示（`dotfiles-dsh-footer`）を profile から除外する。設定ファイルは持たず、plugin を profile から外すことで全体を無効化する。対象は dsh web UI。

## 用語

- **セッションリスト**: sidebar 中央の workspace ブラウザ領域。stock のブラウザを本 plugin の描画で置き換える
- **グループ**: 登録済み workspace 1 件に対応するセクション。グループヘッダー行と、その workspace に所属するセッション行で構成される
- **Ungrouped**: どの workspace にも所属しないセッションのバケット。グループ列の末尾に出る
- **rail**: sidebar を折りたたんだときの 56px icon 列表示
- **行 actions**: 行に hover したとき行右端へ現れる archive ボタンと copy session id ボタンの 2 つ
- **status dot**: 行左端の状態表示。pending interaction（amber warning）/ running（blue activity）/ completed（green done）/ 待ちも実行も完了もしていない idle（tertiary label 色）を示す stock の `StateDot`
- **blank**: まだログを持たない New Session 用セッション
- **archived**: stock の archive 操作で退避済みのセッション
- **directory flow**: `sidebar.workspaces.directoryFlow` 子slot の occupant（dsh の directory picker）が提供するパス選択インタラクション

## sidebar のセッションリスト

### 置き換え

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| dsh web 起動中 | sidebar 中央の領域を見る | セッションリストは本 plugin の描画であり、stock の workspace ブラウザのうち検索・ドラッグ並べ替え・hover card・schedule marker・workspace rename / delete・View options は存在しない。グルーピング・Add workspace・Show more 折り畳みは本 plugin が再現する |
| 同上 | rename / fork を探す | 行 actions に rename と fork は存在しない（削除済み機能） |
| 同上 | hero 側（New Session 画面）を見る | hero 側の workspace picker は stock のままで変わらない |

### グルーピング

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| 登録済み workspace が存在する | リストを見る | workspace ごとに 1 つのグループが出る。グループの並びは host の workspace 順、所属行の並びは workspace の保持順 |
| どの workspace にも所属しないセッションが存在する | リストを見る | 末尾に Ungrouped グループが出て、そのセッションは host 一覧の順序で並ぶ |
| Ungrouped に表示するセッションが存在しない | リストを見る | Ungrouped グループは出ない |
| グループに表示できるセッションが存在しない | グループヘッダーを見る | セッション行のない空のグループヘッダーが出る |
| subagent 起点のセッションが存在する | リストを見る | subagent 起点の行は存在しない |
| archived なセッションが存在する | リストを見る | archived な行は存在しない |
| 選択中でない blank なセッションが存在する | リストを見る | その行は存在しない（表示する blank は選択中の 1 行だけ） |
| blank なセッションが選択中（New Session 画面） | リストを見る | blank 行はそのセッションの所属先グループ（未所属なら Ungrouped）の中に、相対時刻なし・行 actions なしで表示される |
| あるセッションが表示中 | リストを見る | その行がハイライトされ、その行のいるグループのフォルダーアイコンが business 色になる |
| セッションが存在しない | リストを見る | 空の領域が表示される |

### グループヘッダー

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| 展開中のグループヘッダーを見る | 視認 | 開いたフォルダーアイコンと workspace タイトルが出る。workspace の無いバケットは「Ungrouped」の辞書ラベルが出る |
| ヘッダーに hover | 見る | フォルダーアイコンが右向き矢印に変わる |
| 展開中のグループヘッダーをクリック | クリック | グループが折りたたまれ、配下のセッション行と Show more ボタンが消える（選択中セッションが折りたたまれたグループにいるときは自動で再展開される） |
| 折りたたまれたグループヘッダーを見る | 視認 | 閉じたフォルダーアイコンとタイトルが出る |
| 折りたたまれたグループヘッダーをクリック | クリック | グループが展開され、配下の行が戻る。折りたたみ状態は画面表示中のみ保持され、再起動・再読込で全グループが展開に戻る |

### Show more 折り畳み

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| 展開中グループの通常セッションが 6 以上 | グループ末尾を見る | 先頭 5 行の後に `Show {n} more sessions`（n = 隠れ行数）ボタンが出る。blank 行は 5 件の上限に数えられず常に表示される |
| Show more ボタンをクリック | クリック | 残りの全行が現れ、ボタンが `Show less` に変わる |
| Show less をクリック | クリック | 表示が先頭 5 行に戻る。展開状態は画面表示中のみ保持される |

### Add workspace

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| 展開表示のセクションヘッダーを見る | 視認 | 左に `Workspaces` ラベル、右に Add workspace ボタン（+ 付きプロジェクトアイコン）が出る |
| directory flow が使えない環境でヘッダーを見る | 視認 | Add workspace ボタンは存在しない |
| Add workspace ボタンをクリック | クリック | directory flow が開き、ホストのディレクトリ選択が始まる |
| flow でディレクトリを選ぶ | 選択 | そのパスが workspace として作成され、flow が閉じ、作成された workspace の blank New Session が開く |
| workspace 作成が失敗する | 操作の後を見る | flow が閉じ、「Couldn't open folder」のエラーダイアログに失敗メッセージが出る。Cancel で閉じるか、Choose again で flow を開き直せる |
| flow 中に directory flow の occupant が消える | 操作の後を見る | 開いていた flow は取り下げられる |
| rail（折りたたみ）表示で見る | 視認 | Add workspace ボタンは出ない |

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
| sidebar を折りたたむ | rail を見る | 各行は status dot のみの icon 列になり、グループヘッダー・セクションヘッダー・タイトル・相対時刻・行 actions は表示しない。行の並びは host 一覧の順序どおり |
| rail の行をクリック | クリック | 展開時と同じくそのセッションが開く |

## composer 下の表示（dotfiles-dsh-footer の削除）

| 条件・状態 | 操作 | 結果 |
| --- | --- | --- |
| セッション表示中 | 入力欄の下を見る | `session: <id>` の常時表示とコピーボタンが存在しない |
