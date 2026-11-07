# Pi Sessions design

Pi Sessions サイドバー Webview と E2E gallery の見た目の正本。Webview の対象は行・見出し・操作の寸法と色で、操作と保存の振る舞いは [SPEC.md](SPEC.md) が定める。読者はこれらの見た目を変更する実装者。Webview の値の実装先は `src/webview/webviewStyles.ts` で、stories カタログが同じスタイルを共有する。

Webview の色は VS Code のテーマ変数だけを使い、固定色の palette と追加フォントは持たない。階層と部品構成の参照元は agent-open-ui のデザイン（`~/projects/agent-open-ui/DESIGN.md`）で、この文書はそれをテーマ変数へ対応させた値を定める。

## トークン

| 用途 | 値 |
| --- | --- |
| 背景・本文 | `sideBar-background`・`foreground` |
| 補助文字（日時・行の操作） | `descriptionForeground` |
| hover 面 | `list-hoverBackground` |
| 選択面・選択文字（表示中セッションの行） | `list-inactiveSelectionBackground` / `Foreground`（行へのキーボードフォーカス中は `list-activeSelectionBackground` / `Foreground`） |
| 境界（モード切替の枠・フォーム・フッターの区切り） | `widget-border` の 50% 混色 |
| 入力（ワークスペース フォーム） | 背景 `input-background`・文字 `input-foreground`・境界 `input-border`、placeholder は `input-placeholderForeground` |
| focus | `focusBorder` の 2px ring（offset -2px） |
| 基準角丸 | 9.6px（行・操作・モード切替の枠で共用） |

## レイアウト

| 対象 | 値 |
| --- | --- |
| 全体の余白 | 12px。グループ間も 12px |
| ヘッダー | 高さ24px、下余白12px。見出し13px・600。要素間8px |
| フッター | 一覧の下。上境界線（境界トークン）と 12px 余白で区切る。グループ間も 12px で区切るのと同じ寸法 |
| フォーム（開いたとき） | New workspace の下、間隔8px |
| グループ見出し | 高さ24px、要素間4px。見出し名14px・600・20px行で省略表示 |
| セッション行 | 高さ32px、左インデント12px、見出し直後の行は上余白4px |

## 部品

| 部品 | 定義 |
| --- | --- |
| chevron | 24px 四方の領域に12px の SVG、本文色。展開で下向き、折りたたみで右向きに示す。hover は hover 面。開閉の操作と状態は SPEC「Webview の表示」に従う |
| グループ見出しの New session | chevron と同じ 24px 四方の ghost 操作、本文色。12px の plus SVG、hover は hover 面。ホバーのヒントは `New session` |
| グループ見出しの Unregister | New session と同じ 24px 四方の ghost 操作。12px の minus SVG、補助文字色、hover は本文色と hover 面。見出しへのホバーとキーボードフォーカスの間だけ表示し、それ以外では隠す（タイトル幅を保つ）。登録済みワークスペースのグループだけに置く。ホバーのヒントは `Unregister workspace` |
| フッターの New workspace | フル幅・高さ32px・角丸9.6pxの ghost 操作。16px の folder-plus SVG と 13px・500 ラベル、本文色、hover は hover 面。フォームを開いている間は `aria-expanded` を示し hover 面を敷く。構造の参照元は agent-open-ui の `SidebarFooter` |
| ワークスペース フォーム | New workspace の下に開く。要素間8px。入力は高さ32px・角丸9.6px・入力トークン・13px 文字、placeholder は `/absolute/path`、focus は `focusBorder` の 2px ring。`Add` は高さ32px・境界付きの本文色操作、`Cancel` は境界なしの補助文字色で hover は本文色。構造の参照元は agent-open-ui の `SidebarWorkspaceForm` |
| モード切替（ヘッダー） | 全ワークスペース共通。枠は境界トークン・角丸9.6px・余白1px・間隔2px。ボタンは高さ20px・余白左右6px・10px 文字。押下中のボタンは選択面・選択文字 |
| 状態の印 | 直径10px の円。実行フェーズのあるセッションはフェーズの色の塗り（`running` は `testing-iconPassed`、`waiting-approval` は `editorWarning-foreground`、`waiting-user` は `charts-blue`、代替 `testing-iconQueued`）、フェーズ情報のない未アーカイブは `descriptionForeground` の塗り、ロック中は `editorWarning-foreground`、アーカイブ済みは補助文字色の枠の中抜き |
| 表示名 | 13px・20px 行・省略表示 |
| 日時 | 等幅（`editor-font-family` 代替 `ui-monospace`）、10px・tabular-nums、右端の操作の左に右寄せで5文字分 |
| 行の操作（Copy・Lock・Archive・Unarchive） | 24px 四方の ghost 操作。12px の `currentColor` SVG、補助文字色、hover は本文色と hover 面。右端から 4px 間隔で並べ、行の右端に重ねる。Archive と Unarchive は同じ位置を占有率で切り替え、アーカイブ済みの行では Archive の代わりに Unarchive（アーカイブから取り出す矢印付きの SVG）を出す。コピー済みは `testing-iconPassed`、無効な Archive は `disabledForeground` |
| 確認ダイアログ（Unregister） | Webview 内のモーダル。scrim は黒40%、面は `editorWidget-background`・境界トークン・角丸9.6px・余白12px・要素間8px。見出し13px・600、本文12px・補助文字色で cwd だけ本文色、cwd は折返し。操作は高さ26px・角丸4pxで、`Unregister` は `button-background` / `button-foreground`、`Cancel` は `button-secondary-*`。Cancel に初期フォーカスし、Escape で閉じる |

## 状態

| 状態 | 表示 |
| --- | --- |
| 行の hover | hover 面 |
| 行の選択 | 選択面。選択中の表示名・日時は選択文字色 |
| アーカイブ済みの行 | 表示名・日時を補助文字色にする |
| 空の一覧・状態表示 | 補助文字色・12px。空の案内は余白24px の中央寄せ |

## E2E gallery

`e2e-gallery.html` は、開発者が走行要約、ケース見出し、比較画像の順に結果を確認するビューアー。主操作は画像の原寸表示。画像・添付名・原寸リンク・ケース見出し・合否・日時・枚数・エラー・未実行と画像なしの表示を保持する。列数の設定や新しい操作は設けず、色・文字・余白は既存 HTML の値を使う。

Layout: E2E gallery — 比較画像の縮小を抑えた折り返し → ram-grid の列数制限版（[参照](https://github.com/changeroa/StyleGallery/blob/main/patterns/grid-repetition/ram-grid.md)）; scroll owner: `html`; anti-patterns: 画像数だけ列を増やす配置、横スクロール、表示順の入れ替え。

| 対象 | 配置 |
| --- | --- |
| ケースの画像 | 画面幅800px超では画像数に応じて1列または2列。3枚目以降は元の順序で次行へ折り返す |
| 狭幅の画像 | 画面幅800px以下では1列 |
| 1枚だけの画像 | ケースの表示幅いっぱいに配置する |
