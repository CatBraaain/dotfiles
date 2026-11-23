# Agent Kit design

Agent Kit サイドバー（VS Code 標準ビュータイトルと Webview）および E2E gallery の見た目の正本。Webview の対象は行・見出し・操作の寸法と色で、操作と保存の振る舞いは [SPEC.md](SPEC.md) が定める。読者はこれらの見た目を変更する実装者。Webview の値の実装先は `src/webview/webview-styles.ts` で、stories カタログが同じスタイルを共有する。

Webview の色は VS Code のテーマ変数だけを使い、固定色の palette と追加フォントは持たない。階層と部品構成の参照元は agent-open-ui のデザイン（`~/projects/agent-open-ui/DESIGN.md`）で、この文書はそれをテーマ変数へ対応させた値を定める。

## トークン

| 用途 | 値 |
| --- | --- |
| 背景・本文 | `sideBar-background`・`foreground` |
| 補助文字（日時・行の操作・アーカイブ済みの表示名） | `descriptionForeground` |
| 状態アイコン | spinner は `testing-iconPassed`、ベル・一時停止マーク・公開遅延ドットは `editorWarning-foreground`（いずれも代替 `descriptionForeground`） |
| hover 面 | `list-hoverBackground` |
| 選択面・選択文字（表示中セッションの行） | `list-inactiveSelectionBackground` / `Foreground`（行へのキーボードフォーカス中は `list-activeSelectionBackground` / `Foreground`） |
| 境界（フォーム・フッターの区切り） | `widget-border` の 50% 混色 |
| 入力（ワークスペース フォーム） | 背景 `input-background`・文字 `input-foreground`・境界 `input-border`、placeholder は `input-placeholderForeground` |
| focus | `focusBorder` の 2px ring（offset -2px） |
| コンテキストメニュー | 背景 `menu-background`（代替 `sideBar-background`）・文字 `menu-foreground`（代替 `foreground`）・境界 `menu-border`（代替 `widget-border`） |
| メニュー項目の hover | 背景 `menu-selectionBackground`（代替 `list-hoverBackground`）・文字 `menu-selectionForeground`（代替 `foreground`） |
| 基準角丸 | 9.6px（行・操作で共用） |
| スクロールつまみ | 通常 `scrollbarSlider-background`、hover `scrollbarSlider-hoverBackground`、ドラッグ `scrollbarSlider-activeBackground`。未定義時は `descriptionForeground` |
| スクロールバーの消灯待ち | 最後のスクロールから800ms。表示状態の切替とつまみの追従は即時 |

## レイアウト

Layout: Sessions ビュータイトル — 見出しと操作を一行にまとめる → VS Code 標準ビュータイトル（[参照](https://code.visualstudio.com/api/references/contribution-points#contributes.menus)）; scroll owner: `html`（Webview document）; anti-patterns: Webview 内の重複した見出しと更新ツールバー。

Layout: 一覧の通信エラー — 通信障害を一覧より先に読み、通常時は領域を空けない → stack（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/stacking/stack.md)）; scroll owner: `html`（document）; anti-patterns: 見た目だけの並べ替え、フッターへの混在、空の表示領域。

Layout: New workspace フッター — 一覧が短いときも長いときも操作の下余白を一覧の上余白に揃える → sticky-footer の document 内下端追従版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/sticky-footer.md)）; scroll owner: `html`（document）; anti-patterns: 上下で異なる外側余白、入力への切替による高さの増減、一覧だけの別スクロール領域。

Layout: ワークスペース見出し — 左の開閉・名前・省略メニュー、右のモード切替・New session を一列に配置する → split-nav の固定操作幅版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/in-line-grouping/split-nav.md)）; scroll owner: `html`（document）; anti-patterns: 操作の折り返し、名前による操作の押し出し。名前を省略して操作幅を保つ。

Layout: セッション行の日時 — 行全体の選択領域を保ち、日時と行操作を右端へ重ねる → imposter の右寄せ・自然幅版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/overlay-exception/imposter.md)）; scroll owner: `html`（document）; anti-patterns: 文字間隔の拡大で日時が欠ける固定幅、表示名・操作との重なり。

Layout: セッション一覧 — スクロールバーを既存の余白へ重ねる → imposter の右端固定配置（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/overlay-exception/imposter.md)）; scroll owner: `html`（document）; anti-patterns: バー専用の幅予約、一覧だけの別スクロール領域、一覧・フッターのフロー変更。

Layout: ワークスペースのメニュー — 一覧を押し下げず起動位置に操作を重ねる → imposter の viewport 内固定配置版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/overlay-exception/imposter.md)）; scroll owner: `html`（document）; anti-patterns: 一覧幅・行位置の変化、viewport 外へのはみ出し、メニュー内の追加スクロール領域。

| 対象 | 値 |
| --- | --- |
| 全体の余白 | Webview viewport を基準に、アプリが上と左右12pxを一度だけ確保する。`body` の padding は0。下はフッターの12pxで確保する。グループ間は12px |
| ビュータイトル | VS Code 標準の `Sessions` タイトルと右側の操作アイコン。`Reload All Pi Sessions` のアイコン（`debug-restart`）の左に Ticket Dispatch のアイコンを1つ表示する。開始は再生（`debug-start`）、停止は一時停止（`debug-pause`）で示す。間隔・寸法・配色・hover・focus は VS Code 標準に従う |
| フッター | 一覧の下。上境界線（境界トークン）と上下・左右12pxの余白で区切る。操作の下余白は、一覧の長さとスクロール位置によらず一覧の上余白と同じ12pxとする |
| 取得状態・操作エラー表示 | 文字があるときだけフッターの操作より上に表示し、高さ16px以上、操作との間隔8pxとする。空のときは表示領域と間隔を確保せず、上境界線の下端から操作の上端まで12pxとする |
| 通信エラー表示 | 一覧より前の document フローに配置する。12px文字・`errorForeground`・高さ16px以上とし、一覧との間隔は8px。空のときは表示領域と間隔を確保しない |
| フォーム（開いたとき） | New workspace と同じ位置・幅・高さ。開閉で周囲の配置とスクロール範囲を保つ |
| グループ見出し | 高さ24px、右の補助操作との間隔4px。chevron と名前の共通領域はアプリ左端の余白から8px左へ広げ、chevron ボタンと名前の間隔は0pxとする。chevron の操作領域は24px四方を保つ。見出し名の内側余白は常時左0px・右6px。文字は14px・600・20px行で省略表示。名前の直後に省略メニューボタンの領域を確保し、残る空間で右端のモード切替・New session と分ける。長い名前は省略し、chevron・省略メニュー・右の補助操作は24px四方を保つ |
| セッション行 | 高さ32px、見出し直後の行は上余白4px。行の左端はグループ見出しの開閉領域と揃え、アプリ左端の余白から8px左へ広げる。ボタンの内側の左余白は4px、アイコン・表示名の間隔は8pxとし、表示名の文字開始位置をグループ見出し名と揃える。hover・選択の背景面とfocus ringはボタン全体に描く。既存の状態アイコンは表示名の左側に置き、ボタンの一部として操作できる。文字・状態アイコン・日時・行操作の位置と幅は各状態で維持する |
| オーバーレイスクロールバー | viewport の右端に幅12pxの透明なトラックを重ねる。つまみは幅8px・右余白2px・角丸4px。高さは表示範囲の比率に合わせ、最小24px・最大トラック高。バーの有無によらず左右12pxの全体余白と行幅を保つ |

トラックの操作幅12pxは [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) の24px条件を満たさない。

## 部品

New workspace フッターの主操作はワークスペースの登録。情報の優先順は一覧、取得状態・操作エラー、登録操作。New workspace とフルパス入力欄は同じ領域を使い、左側の folder-plus アイコン、状態・エラー表示と入力のヒントを保持する。操作とキー入力は SPEC「New Workspace アクション」に従う。

セッション一覧の主操作は会話の選択・再開。情報の優先順は表示名、実行フェーズ、更新日時。表示名・日時・フェーズのヒント・選択表示・右端の Archive / Unarchive を保持する。左端の状態アイコンは既存の線画 SVG を使い、状態との対応は SPEC「実行フェーズの表示」に従う。公開遅延ドット（SPEC「実行フェーズの表示」）のほかに、追加のバッジや説明行は設けない。

| 部品 | 定義 |
| --- | --- |
| グループ見出しの開閉領域 | chevron と名前を、基準角丸のひと続きの hover 面で囲む。どちらにホバーしても領域全体を hover 面にし、各ボタンの背景は透明に保つ。名前に隣接する省略メニューと右のモード切替・New session はこの面の外に置き、個別の hover 面を保つ。モード切替・New session の focus は focus トークンの ring。開閉ボタンそれぞれの focus は focus トークンの ring |
| chevron | 24px 四方の領域に12px の SVG、本文色。展開で下向き、折りたたみで右向きに示す。hover は開閉領域と共用する。開閉の操作と状態は SPEC「Webview の表示」に従う |
| グループ見出しの New session | chevron と同じ 24px 四方の ghost 操作、本文色。通常は12px の plus SVG、SPEC「New Session アクション」の待機表示中は同じ位置・寸法・本文色で既存の spinner SVG に置き換える。操作領域と周囲の配置は保つ。hover は hover 面。ホバーのヒントは `New session` |
| グループ見出しの省略メニューボタン | New session と同じ24px四方の ghost 操作、補助文字色、基準角丸。通常は非表示とし、ボタン自身の24px四方の領域にホバーしている間だけ表示する。非表示時も領域を保持し、周囲の位置と寸法を保つ。12px の水平三点 SVG は既存の行内操作と同じ `viewBox="0 0 24 24"`・塗りなし・`currentColor` の線幅2・丸い線端と線結合を使う。hover は本文色と hover 面。ヒントと操作は SPEC「ワークスペース登録解除」に従う |
| グループ見出しのメニュー | 省略メニューボタンとコンテキストメニューで共用する。`Unregister workspace` のテキスト項目1つを持つ。固定配置で一覧に重ね、viewport 端から4px以上内側に収める。最小幅160px・最大幅は viewport 幅から8pxを除いた幅。内側余白4px、境界1px、角丸は基準角丸。メニューの色はコンテキストメニュートークン。項目は全幅・高さ32px以上・左右余白8px・13px文字・基準角丸で、長い文字は折り返す。hover はメニュー項目トークン。表示層はスクロールバーより上に置く。操作は SPEC「ワークスペース登録解除」に従う |
| セッション行のコンテキストメニュー | グループ見出しのメニューと同じ外観・配置を使う。高さが足りないときはメニュー内を縦にスクロールして全項目へ移動できる。項目と表示条件は SPEC「セッション行のコンテキストメニュー」に従う |
| フッターの New workspace | フル幅・高さ32px・角丸9.6pxの ghost 操作。13px・500 ラベル、本文色、hover は hover 面。開くとアイコンの位置を保ったまま文字部分が入力へ切り替わる。構造の参照元は agent-open-ui の `SidebarFooter` |
| フッターの folder-plus | ボタンと入力に共通する16pxの装飾SVG、本文色。操作領域の左端から11px・上端から8pxに配置する。文字先頭は操作領域の左端から33pxで、アイコンの右端との間隔は6px。入力中は入力面の左内側に置く |
| ワークスペース フォーム | New workspace の文字部分を置き換える入力欄1つ。入力は境界を含め高さ32px・角丸9.6px・入力トークン・13px 文字、左内側余白32px・右内側余白8px、placeholder は `/absolute/path`、focus は `focusBorder` の 2px ring。構造の参照元は agent-open-ui の `SidebarWorkspaceForm` |
| グループ見出しのモード切替 | 見出し名の右、New session の左に常時表示する。New session と同じ24px 四方の ghost 操作。16px の既存の目の SVG、補助文字色、hover は本文色と hover 面。未アーカイブ表示では斜線付きの目、All 表示では目を示す。focus は focus トークンの ring。ヒントと操作は SPEC「表示モード」に従う |
| 状態アイコンのスロット | 全行で12px 四方の固定領域。アイコンを中央に置き、表示名との間隔は8px。空の場合も幅を保持する |
| 公開遅延ドット | スロットの12px 四方の内側の右下へ重ねる6px の塗り円（角丸は直径の半分）。フェーズアイコンの有無によらず同じ位置に置き、スロット・表示名の開始位置と寸法は変えない。色は状態アイコントークンの `editorWarning-foreground`。点滅などの動きは加えない。表示条件は SPEC「実行フェーズの表示」に従う |
| spinner・ベル・一時停止マーク | 既存の行内操作と同じ12px SVG、`viewBox="0 0 24 24"`、塗りなし・`currentColor` の線幅2・丸い線端と線結合。spinner は開いた円弧（`M21 12a9 9 0 1 1-6.219-8.56`）。ベルは本体（`M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9`）と下端（`M10 21a2 2 0 0 0 4 0`）の輪郭線。一時停止マークは2本の縦線（`M9 4v16`・`M15 4v16`）。色は状態アイコントークンに従う |
| 表示名 | 13px・20px 行・省略表示 |
| 日時 | 等幅（`editor-font-family` 代替 `ui-monospace`）、10px・tabular-nums、右端から36pxの位置に右寄せし、文字間隔を広げても全文を収める自然幅とする。行内では右側に `36px + 5ch + 8px` を予約する |
| 行の操作（Archive・Unarchive） | 24px 四方の ghost 操作。12px の `currentColor` SVG、補助文字色、hover は本文色と hover 面。右端から4pxの位置に重ねる。Archive と Unarchive は同じ位置を占有率で切り替え、アーカイブ済みの行では Archive の代わりに Unarchive（アーカイブから取り出す矢印付きの SVG）を出す。SPEC「アーカイブ・未アーカイブアクション」の待機表示中は同じ位置・寸法・色で既存の spinner SVG に置き換え、操作領域と周囲の配置は保つ |

セッション一覧の主操作はセッションを開くこと。情報の優先順はグループ、セッション名と状態、更新日時と行操作。標準ビュータイトルの Sessions・操作アイコンと、Webview のグループ見出し・モード切替・行操作・New workspace・フォームを保持する。スクロール位置の操作は補助操作とし、装飾や追加のツールバーは設けない。

## Motion & Interaction

アニメーション対象の反映(SPEC「一覧更新のアニメーション」)では、動いた行は実要素が前後の位置を滑らかに移動する。移動中も行の当たり位置は見た目と一致する。前回の表示に無かった行は移動せず即時に表示する。移動は700ms・`cubic-bezier(0.45, 0, 0.25, 1)` とし、行の詰まり全体を視線で追える速度にする。`prefers-reduced-motion: reduce` では即時に切り替える。

セッションを正常に開いた後の既読化では、表示中のベルを200ms・ease-outで不透明度1から0へフェードアウトして消す。変化させるのは `opacity` のみとし、行・スロット・表示名の位置と寸法を保つ。`prefers-reduced-motion: reduce` では即時に消す。

ワークスペース見出しは [beui.dev の shared-layout-bg](https://beui.dev/r/shared-layout-bg/raw) の共通背景を参照し、chevron と名前で1つの hover 面を共有する。背景の切替は即時とし、アニメーションは加えない。hover・focus で文字位置・余白・寸法を変えない。

ワークスペースのメニューは [beui.dev の context-menu](https://beui.dev/r/context-menu/raw) の起動元・viewport 内への位置調整を参照する。開閉と位置調整は即時とし、アニメーションは加えない。

spinner は中心を軸に1秒・linear・無限反復で1回転する。回転は `transform` のみで行い、行やスロットの寸法を変えない。`prefers-reduced-motion` での表示は、セッション行では SPEC「実行フェーズの表示」に従い、New session と行の操作では `reduce` のとき静止表示する。

## 状態

| 状態 | 表示 |
| --- | --- |
| 行の hover | hover 面 |
| 行の選択 | 選択面。選択中の表示名・日時は選択文字色 |
| アーカイブ済みの行 | 表示名・日時を補助文字色にする |
| 空の一覧・状態表示 | 補助文字色・12px。空の案内と取得失敗の案内は余白24px の中央寄せ |
| スクロールバーの表示 | document に縦 overflow があるとき、Webview へのホバー・スクロール中・つまみのドラッグ中・バーのキーボードフォーカス中だけ表示する。キーボードフォーカスには focus トークンの ring を出す |

## E2E gallery

`e2e-gallery.html` は、開発者がケース見出し、比較画像の順に結果を確認するビューアー。主操作は画像の原寸表示。画像・添付名・原寸リンク・ケース見出し・合否・エラー・未実行と画像なしの表示を保持する。列数の設定や新しい操作は設けず、色・文字・余白は既存 HTML の値を使う。

Layout: E2E gallery — 比較画像の縮小を抑えた折り返し → ram-grid の列数制限版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/grid-repetition/ram-grid.md)）; scroll owner: `html`; anti-patterns: 画像数だけ列を増やす配置、横スクロール、表示順の入れ替え。

| 対象 | 配置 |
| --- | --- |
| ケースの画像 | 画面幅800px超では画像数に応じて1列または2列。3枚目以降は元の順序で次行へ折り返す |
| 狭幅の画像 | 画面幅800px以下では1列 |
| 1枚だけの画像 | ケースの表示幅いっぱいに配置する |
