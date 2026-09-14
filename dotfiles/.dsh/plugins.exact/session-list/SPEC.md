# session-list

## 目的

dsh web の sidebar セッションリストを自前実装に置き換え、workspace（cwd）単位のグルーピング表示、Add workspace、Show more 折り畳みと、行ごとの archive / copy session id をワンクリックで提供する。合わせて、composer 下の session id 常時表示（`dotfiles-dsh-footer`）を profile から除外する。設定ファイルは持たず、plugin を profile から外すことで全体を無効化する。対象は dsh web UI。

## 基準

セッションリストは stock（dsh 本体 `ui-workspace` の sidebar workspace browser）の挙動を再現する。この文書は **stock との差分だけ**を定め、ここに明記しない挙動は stock に従う。照合の基準は、実行環境の dsh バージョンに対応するタグに固定したミラー実装である。対象領域は sidebar 中央の workspace ブラウザ領域で、hero 側（New Session 画面）の workspace picker は stock のままで変わらない。

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

## 削除（stock にあり、本 plugin に存在しない）

| stock の機能 | 本 plugin での状態 |
| --- | --- |
| 検索（wide の検索入力、rail の検索ボタン、コンテンツ検索） | 存在しない |
| セッション行・ワークスペース行のドラッグ並べ替え | 存在しない |
| hover card（タイトル・時刻・status のカードと、その copy） | 存在しない |
| schedule marker（予定タスクの時計アイコン） | 存在しない |
| workspace rename / delete（グループヘッダーの ellipsis メニューと確認ダイアログ） | 存在しない |
| 行 actions の rename と fork | 存在しない（削除済み機能） |
| View options（Group by / Order by メニュー） | 存在しない。常に workspace グルーピング・host 順で固定 |
| rail の検索ボタンと Add workspace ボタン | 存在しない。rail では Add workspace の手段を提供しない |
| composer 下の session id 常時表示 | stock にも無い自作表示（`dotfiles-dsh-footer`）であり、profile から除外して表示しない |

## 変更（stock と異なる挙動）

| # | 項目 | 本 plugin の挙動 | stock の挙動 |
| --- | --- | --- | --- |
| 1 | 選択中グループの折りたたみ | 選択中セッションのいるグループも折りたためる。自動で再展開しない | 選択グループが一度も操作されていないときだけ、初回に自動展開する |
| 2 | グループ折りたたみ状態の保持 | 永続化せず、再起動・再読込で全グループが展開に戻る | persisted store に保持する |
| 3 | 行 actions の形 | hover で archive ボタンと copy session id ボタンの直接 2 ボタンが現れる。archive の結果（確認ダイアログなしで即 archive、表示中セッションなら New Session view へ切替、失敗時は行が残り console 警告のみ）は stock に従う | hover で ellipsis メニュー（Rename / Fork session / Archive session）が現れる |
| 4 | Ungrouped の行順 | host 一覧の順序どおり | updatedAt 降順を基準にした保持順 |
| 5 | status dot の idle | idle でも tertiary 色の dot を表示する | idle のとき dot を表示しない（空スロット） |
| 6 | グループ折りたたみ時の Show more 展開状態 | 保持する | リセットする |

## 追加（stock に無い機能）

| # | 機能 | 挙動 |
| --- | --- | --- |
| 1 | copy session id ボタン | 非 blank 行の行 actions にあり、クリックでそのセッション id（id 文字列のみ、prefix なし）をクリップボードへ書き込む。成功で 1 秒間 check icon に変わり、その後 copy icon へ戻る。書き込み失敗では copy icon のまま。二重クリックは 1 秒間無視する |
| 2 | rail の行一覧 | stock は rail でリスト本体を描画しないが、本 plugin は各行を status dot のみの icon 列で表示する。グループヘッダー・セクションヘッダー・タイトル・相対時刻・行 actions は出ない。行の並びは host 一覧の順序どおり。クリックで展開時と同じくそのセッションを開く |
