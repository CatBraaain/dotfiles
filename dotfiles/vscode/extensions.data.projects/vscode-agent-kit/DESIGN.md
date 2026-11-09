# Pi Sessions design

Pi Sessions サイドバー Webview と E2E gallery の見た目の正本。Webview の対象は行・見出し・操作の寸法と色で、操作と保存の振る舞いは [SPEC.md](SPEC.md) が定める。読者はこれらの見た目を変更する実装者。Webview の値の実装先は `src/webview/webviewStyles.ts` で、stories カタログが同じスタイルを共有する。

Webview の色は VS Code のテーマ変数だけを使い、固定色の palette と追加フォントは持たない。階層と部品構成の参照元は agent-open-ui のデザイン（`~/projects/agent-open-ui/DESIGN.md`）で、この文書はそれをテーマ変数へ対応させた値を定める。

## トークン

| 用途 | 値 |
| --- | --- |
| 背景・本文 | `sideBar-background`・`foreground` |
| 補助文字（日時・行の操作・アーカイブ済みの表示名） | `descriptionForeground` |
| 状態アイコン | spinner は `testing-iconPassed`、ベル・一時停止マークは `editorWarning-foreground`（いずれも代替 `descriptionForeground`） |
| hover 面 | `list-hoverBackground` |
| 選択面・選択文字（表示中セッションの行） | `list-inactiveSelectionBackground` / `Foreground`（行へのキーボードフォーカス中は `list-activeSelectionBackground` / `Foreground`） |
| 境界（フォーム・フッターの区切り） | `widget-border` の 50% 混色 |
| 入力（ワークスペース フォーム） | 背景 `input-background`・文字 `input-foreground`・境界 `input-border`、placeholder は `input-placeholderForeground` |
| focus | `focusBorder` の 2px ring（offset -2px） |
| コンテキストメニュー | 背景 `menu-background`（代替 `sideBar-background`）・文字 `menu-foreground`（代替 `foreground`）・境界 `menu-border`（代替 `widget-border`） |
| メニュー項目の hover・focus | 背景 `menu-selectionBackground`（代替 `list-hoverBackground`）・文字 `menu-selectionForeground`（代替 `foreground`）。focus は focus トークンの ring |
| 基準角丸 | 9.6px（行・操作で共用） |
| スクロールつまみ | 通常 `scrollbarSlider-background`、hover `scrollbarSlider-hoverBackground`、ドラッグ `scrollbarSlider-activeBackground`。未定義時は `descriptionForeground` |
| スクロールバーの消灯待ち | 最後のスクロールから800ms。表示状態の切替とつまみの追従は即時 |

## レイアウト

Layout: New workspace フッター — 一覧が短いときも長いときも操作の下余白をヘッダーの上余白に揃える → sticky-footer の document 内下端追従版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/viewport-shell/sticky-footer.md)）; scroll owner: `html`（document）; anti-patterns: 上下で異なる外側余白、入力への切替による高さの増減、一覧だけの別スクロール領域。

Layout: ワークスペース見出し — 左の開閉と名前、右の補助操作を一列に配置する → split-nav の固定操作幅版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/in-line-grouping/split-nav.md)）; scroll owner: `html`（document）; anti-patterns: 操作の折り返し、名前による操作の押し出し。名前を省略して操作幅を保つ。

Layout: セッション一覧 — スクロールバーを既存の余白へ重ねる → imposter の右端固定配置（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/overlay-exception/imposter.md)）; scroll owner: `html`（document）; anti-patterns: バー専用の幅予約、一覧だけの別スクロール領域、ヘッダー・フッターのフロー変更。

Layout: ワークスペースのコンテキストメニュー — 一覧を押し下げず起動位置に操作を重ねる → imposter の viewport 内固定配置版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/overlay-exception/imposter.md)）; scroll owner: `html`（document）; anti-patterns: 一覧幅・行位置の変化、viewport 外へのはみ出し、メニュー内の追加スクロール領域。

| 対象 | 値 |
| --- | --- |
| 全体の余白 | 上と左右は12px。下はフッターの12pxで確保する。グループ間は12px |
| ヘッダー | 高さ24px、下余白12px。見出し13px・600。要素間8px |
| フッター | 一覧の下。上境界線（境界トークン）と上下・左右12pxの余白で区切る。操作の下余白は、一覧の長さとスクロール位置によらずヘッダーの上余白と同じ12pxとする |
| 状態・エラー表示 | フッターの操作より上。高さ16px以上、操作との間隔8px |
| フォーム（開いたとき） | New workspace と同じ位置・幅・高さ。開閉で周囲の配置とスクロール範囲を保つ |
| グループ見出し | 高さ24px、要素間4px。見出し名14px・600・20px行で省略表示 |
| セッション行 | 高さ32px、左インデント12px、見出し直後の行は上余白4px |
| オーバーレイスクロールバー | viewport の右端に幅12pxの透明なトラックを重ねる。つまみは幅8px・右余白2px・角丸4px。高さは表示範囲の比率に合わせ、最小24px・最大トラック高。バーの有無によらず左右12pxの全体余白と行幅を保つ |

トラックの操作幅12pxは [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) の24px条件を満たさない。

## 部品

New workspace フッターの主操作はワークスペースの登録。情報の優先順は一覧、状態・エラー、登録操作。New workspace とフルパス入力欄は同じ領域を使い、左側の folder-plus アイコン、状態・エラー表示と入力のヒントを保持する。操作とキー入力は SPEC「New Workspace アクション」に従う。

セッション一覧の主操作は会話の選択・再開。情報の優先順は表示名、実行フェーズ、更新日時。表示名・日時・フェーズのヒント・選択表示・右端の Archive / Unarchive を保持する。左端の状態アイコンは既存の線画 SVG を使い、状態との対応は SPEC「実行フェーズの表示」に従う。追加のバッジや説明行は設けない。

| 部品 | 定義 |
| --- | --- |
| chevron | 24px 四方の領域に12px の SVG、本文色。展開で下向き、折りたたみで右向きに示す。hover は hover 面。開閉の操作と状態は SPEC「Webview の表示」に従う |
| グループ見出しの New session | chevron と同じ 24px 四方の ghost 操作、本文色。12px の plus SVG、hover は hover 面。ホバーのヒントは `New session` |
| グループ見出しのコンテキストメニュー | `Unregister workspace` のテキスト項目1つを持つ。固定配置で一覧に重ね、viewport 端から4px以上内側に収める。最小幅160px・最大幅は viewport 幅から8pxを除いた幅。内側余白4px、境界1px、角丸は基準角丸。メニューの色はコンテキストメニュートークン。項目は全幅・高さ32px以上・左右余白8px・13px文字・基準角丸で、長い文字は折り返す。hover・focus はメニュー項目トークン。表示層はスクロールバーより上に置く。操作は SPEC「ワークスペース登録解除」に従う |
| フッターの New workspace | フル幅・高さ32px・角丸9.6pxの ghost 操作。13px・500 ラベル、本文色、hover は hover 面。開くとアイコンの位置を保ったまま文字部分が入力へ切り替わる。構造の参照元は agent-open-ui の `SidebarFooter` |
| フッターの folder-plus | ボタンと入力に共通する16pxの装飾SVG、本文色。操作領域の左端から11px・上端から8pxに配置する。文字先頭は操作領域の左端から33pxで、アイコンの右端との間隔は6px。入力中は入力面の左内側に置く |
| ワークスペース フォーム | New workspace の文字部分を置き換える入力欄1つ。入力は境界を含め高さ32px・角丸9.6px・入力トークン・13px 文字、左内側余白32px・右内側余白8px、placeholder は `/absolute/path`、focus は `focusBorder` の 2px ring。構造の参照元は agent-open-ui の `SidebarWorkspaceForm` |
| グループ見出しのモード切替 | 見出し名の右、New session の左に常時表示する。New session と同じ24px 四方の ghost 操作。16px の既存の目の SVG、補助文字色、hover は本文色と hover 面。未アーカイブ表示では斜線付きの目、All 表示では目を示す。focus は focus トークンの ring。ヒントと操作は SPEC「表示モード」に従う |
| 状態アイコンのスロット | 全行で12px 四方の固定領域。アイコンを中央に置き、表示名との間隔は8px。空の場合も幅を保持する |
| spinner・ベル・一時停止マーク | 既存の行内操作と同じ12px SVG、`viewBox="0 0 24 24"`、塗りなし・`currentColor` の線幅2・丸い線端と線結合。spinner は開いた円弧（`M21 12a9 9 0 1 1-6.219-8.56`）。ベルは本体（`M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9`）と下端（`M10 21a2 2 0 0 0 4 0`）の輪郭線。一時停止マークは2本の縦線（`M9 4v16`・`M15 4v16`）。色は状態アイコントークンに従う |
| 表示名 | 13px・20px 行・省略表示 |
| 日時 | 等幅（`editor-font-family` 代替 `ui-monospace`）、10px・tabular-nums、右端から36pxの位置に右寄せで5文字分。行内では右側に `36px + 5ch + 8px` を予約する |
| 行の操作（Archive・Unarchive） | 24px 四方の ghost 操作。12px の `currentColor` SVG、補助文字色、hover は本文色と hover 面。右端から4pxの位置に重ねる。Archive と Unarchive は同じ位置を占有率で切り替え、アーカイブ済みの行では Archive の代わりに Unarchive（アーカイブから取り出す矢印付きの SVG）を出す |

セッション一覧の主操作はセッションを開くこと。情報の優先順はグループ、セッション名と状態、更新日時と行操作。既存の見出し・モード切替・Refresh・行操作・New workspace・フォームを保持する。スクロール位置の操作は補助操作とし、装飾や追加のツールバーは設けない。

## Motion & Interaction

コンテキストメニューは [beui.dev の context-menu](https://beui.dev/r/context-menu/raw) の起動元・項目フォーカス・viewport 内への位置調整を参照する。開閉と位置調整は即時とし、アニメーションは加えない。

spinner は中心を軸に1秒・linear・無限反復で1回転する。回転は `transform` のみで行い、行やスロットの寸法を変えない。`prefers-reduced-motion` での表示は SPEC「実行フェーズの表示」に従う。

## 状態

| 状態 | 表示 |
| --- | --- |
| 行の hover | hover 面 |
| 行の選択 | 選択面。選択中の表示名・日時は選択文字色 |
| アーカイブ済みの行 | 表示名・日時を補助文字色にする |
| 空の一覧・状態表示 | 補助文字色・12px。空の案内は余白24px の中央寄せ |
| スクロールバーの表示 | document に縦 overflow があるとき、Webview へのホバー・スクロール中・つまみのドラッグ中・バーのキーボードフォーカス中だけ表示する。キーボードフォーカスには focus トークンの ring を出す |

## E2E gallery

`e2e-gallery.html` は、開発者がケース見出し、比較画像の順に結果を確認するビューアー。主操作は画像の原寸表示。画像・添付名・原寸リンク・ケース見出し・合否・エラー・未実行と画像なしの表示を保持する。列数の設定や新しい操作は設けず、色・文字・余白は既存 HTML の値を使う。

Layout: E2E gallery — 比較画像の縮小を抑えた折り返し → ram-grid の列数制限版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/grid-repetition/ram-grid.md)）; scroll owner: `html`; anti-patterns: 画像数だけ列を増やす配置、横スクロール、表示順の入れ替え。

| 対象 | 配置 |
| --- | --- |
| ケースの画像 | 画面幅800px超では画像数に応じて1列または2列。3枚目以降は元の順序で次行へ折り返す |
| 狭幅の画像 | 画面幅800px以下では1列 |
| 1枚だけの画像 | ケースの表示幅いっぱいに配置する |
