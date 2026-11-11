# openui-preview拡張Spec

assistant出力中の ` ```openui-lang ` コードフェンスを、確定後に既存のOpenUI React Rendererと部品でheadlessブラウザに描画し、専用の撮影処理で通常のPNGとして保存してTUI transcript内にインラインプレビュー表示する。読者は本拡張の利用者と保守担当である。

## トリガーと表示の経路

| イベント | 動作 |
| --- | --- |
| `before_agent_start` | system promptに `openui-lang` セクション（openui-langのdisplay-only作成指示）を常時注入する |
| `message_end`（assistantメッセージ確定時） | メッセージ本文から ` ```openui-lang ` フェンスを検出し、各ブロックのプレビュー生成をキューへ投入する |
| markdown描画（assistant本文） | 本文から ` ```openui-lang ` ブロックを除去して表示する（表示のみの除去。LLMコンテキストは変えない） |

`message_start`・`message_update`（ストリーミング中）は対象外。プレビューはメッセージ確定後に生成される。

## system promptへの注入

`before_agent_start` で `event.systemPromptOptions.sections["openui-lang"]` に、openui-langのdisplay-only指示を設定する。指示は `prompt.ts` が生成する:

- 入力はapplyで生成した `spec.json`（58コンポーネントのLibrarySpec）と `prompt-options.json`（examples・additionalRules）。両方とも `spec.apply.ts` が `library.data.ts` から生成する
- `library.data.ts` は正本であり、`@openuidev/react-ui` の `genui-lib` から対話コンポーネント（Button・Form等26種）を除外した `createLibrary` 結果と、`genui-lib/prompt-options` から対話系を示す語を含むexamples・rulesを除外したpromptOptionsをexportする。プロジェクト外部のリポジトリには依存しない
- `prompt.ts` は対話コンポーネント（同26種）をsignatureから `never` 化・unionから除去し（`displayOnlySignature`）、生成promptの `## Action` セクションと `ActionExpression` の説明行を除去する（`stripInteractivePromptParts`）
- preambleを差し替え、markdown応答内の `openui-lang` fenced blockへの埋め込みを指示する（lang-core既定の「応答全体がコード」前提は使わない）

## 生成物とapplyの前提

`spec.json` と `prompt-options.json` は `spec.apply.ts`（applyフック）が `library.data.ts` から生成し、ホームの拡張フォルダに配置する。生成物はgit管理せず、apply時に更新する。spec生成用の依存は後述の依存導入フックが準備する。

`library.data.ts` は `.data.` 予約名のため差分検知・適用の対象外であり、ホームには展開されない。applyフックはスナップショット実行位置（dist側の拡張フォルダ）から `library.data.ts` と `display-only.ts` を読み、ホーム側の一時ディレクトリ `.spec-gen/` にコピーしてから読み込む。これで親を遡って `~/.pi/agent/node_modules` の依存を解決できる。`.spec-gen/` は使用後に削除する。

依存は `bun_install.apply.ts` が導入した `~/.pi/agent/node_modules` を利用する。applyフックは dist相対パス順で実行され、`bun_install.apply.ts` が拡張フォルダのフックより先に走る（[依存導入仕様](../../bun_install.spec.md)）。

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| `library.data.ts`・`display-only.ts`・`bun.lock` の内容ハッシュが記録と一致し、生成物が両方存在する | applyフックを実行 | 生成を省略する |
| ハッシュが記録と異なる、または記録・生成物のどちらかが欠けている | applyフックを実行 | CLIでspecとprompt optionsを再生成し、成功後に記録（`spec-gen-stamp`）を更新する |
| CLIが見つからない・生成が失敗する | applyフックを実行 | 非0で終了し、記録は更新しない。既存の生成物はそのまま残る |

`library.data.ts`・`display-only.ts`・`bun.lock` は dist側のファイルを読む。生成物と `spec-gen-stamp` はホームの拡張フォルダ配下の管理対象外ファイルである。

## 実行条件（モード）

プレビュー生成はTUIモード（`ctx.mode` が `"tui"`）だけで行う。rpc・json・printモードでは `message_end` を無視する。カスタムエントリのレンダリングはTUIだけで行われる。system promptへの注入はモードによらず常時ON、markdown transformerもモードによらず登録する。

## フェンスの検出

検出は `fence.ts` の `extractOpenuiLangBlocks` が担う。

| 対象 | 取り扱い |
| --- | --- |
| ` ```openui-lang ` で始まり ` ``` ` で閉じるブロック | プレビュー生成対象。開始行のタグ以降にトークンがあっても無視する |
| ` ```html ` 等の他言語タグ | 対象外。テキストのまま表示される |
| ` ```openui-language ` のような、`openui-lang` から始まる別タグ | 対象外（word boundaryで除外） |
| 閉じフェンスのないブロック | 解析せず、エラーカードをtranscriptに送る |
| ネストしたフェンス | 対応しない。最初の閉じフェンスで終了する |

`stripOpenuiLangBlocks` は本文表示用にブロック（閉じ済み・ストリーミング中の未閉鎖の両方）を除去する。`registerMarkdownTransformer` から `context.messageType === "assistant"` のときだけ適用する。user・assistant-thinking本文・LLMコンテキストは変更しない。

## openui-lang → React描画

入力は `spec.json` のschemaとrootに従って解析する。描画には `@openuidev/react-lang` の `Renderer` と `@openuidev/react-ui/genui-lib` の既存部品を使い、生成用ライブラリと同じdisplay-onlyの部品構成を渡す。React Rendererは汎用のOpenUI Lang描画機能であり、本拡張の専用処理がブラウザへの配置と撮影を担う。

見た目は `@openuidev/react-ui/index.css` のlight paletteと既存部品のレイアウトに従う。ブラウザ内でReactを実行し、チャートを含む部品のDOM・SVGを描画する。

| 入力・部品 | 撮影する状態・結果 |
| --- | --- |
| display-onlyライブラリ内の表示部品 | 既存React部品で描画する。チャートも入力データを反映した状態を撮影する |
| Tabs・Accordion・Carousel・Steps・Tableなど状態を持つ表示部品 | 既存React部品の初期状態を撮影する。切替・開閉・ページ送りなどの操作は行わない |
| 対話系などライブラリにない部品、不正な構文、未完の構文、描画可能なrootがない入力 | 画像を生成せず、理由をエラーカードで表示する |
| `$variable`・`$binding`・Query()/Mutation() | データ取得・更新・動的評価を行わず、理由をエラーカードで表示する |

OpenUI Langの入力はデータとして渡し、JavaScriptやHTMLとして実行しない。実行するJavaScriptとCSSはローカルの描画用bundleに限る。ブラウザによる外部通信と、入力が指定したローカルファイルの読み取りを許可しない。外部画像など禁止された参照が必要な入力は、理由をエラーカードで表示する。

## プレビュー生成

| 項目 | 値 |
| --- | --- |
| 撮影 | Playwright Coreでheadless Chromiumを制御し、描画済みページを直接PNG化する |
| 実行入口 | 登録Bashと共用の背景Bash API（[Tools仕様](../tools/SPEC.md#背景bash入口)）から専用撮影処理を起動する |
| 描画依存 | `@openuidev/react-lang`・`@openuidev/react-ui`・`react`・`react-dom` と既存のBunによるブラウザ用bundle生成 |
| 出力先 | `~/.cache/pi/openui-preview/<id>.png`。HTMLやソースを埋め込まない通常のPNG |
| 撮影領域 | 幅960 px・高さ1280 px、device scale factor 1のviewport。領域外は切り取る |
| 撮影時点 | 初期状態で表示される内容を対象とし、React描画とフォント読み込みを待ち、入力データを反映した図形とレイアウトが安定した状態を撮影する。非表示の内容は待機対象外。固定時間の経過だけを完了条件にしない |
| 実行回数 | 1ブロックにつき1回 |
| 処理期限 | 1ブロックにつき最大15秒。bundle生成からブラウザ起動・描画・撮影終了までを対象とする |
| 一時データ | 入力・HTML・bundleなどは一時領域に置き、成功・失敗の後に削除する |
| `<id>` | `Date.now()-ブロック番号-乱数接尾辞` |

Chromiumは標準のブラウザキャッシュ（`PLAYWRIGHT_BROWSERS_PATH` の指定を含む）内の既存実行ファイルを、Playwright Coreの既定リビジョンに限定せず解決する。実行時にブラウザを自動取得せず、準備済みの実行ファイルを使う。Chromiumのsandboxを有効にして実行する。成功・失敗・中断・期限超過では、撮影処理とブラウザの終了を確認してから一時データを削除する。失敗・中断したPNGは残さない。ただし、撮影CLIが完了通知を発行できないまま強制終了された場合は、一時データの削除を保証せず、未確認のPNGを公開しない。

| 失敗条件 | 結果 |
| --- | --- |
| 背景Bash APIが不在・無効、既存の承認状態では実行不可 | 理由をエラーカードで表示する。直接プロセス起動や別のBash生成による迂回はしない |
| 描画依存・ブラウザが不足、bundle生成・起動・描画・撮影が失敗、中断、PNGが生成されない | 対象と失敗理由をエラーカードで表示する。正常な画像として通知しない |
| 処理期限を超過する | 撮影処理を中断し、対象と期限超過をエラーカードで表示する |

外部処理は登録Bashと同じGuardrailsの認可状態・sandboxに従う。撮影失敗時に権限やブラウザのsandboxを緩めて再実行しない。

## キューイング

プレビュー生成は直列キュー（`createQueue`）で1件ずつ実行する。1メッセージに複数の ` ```openui-lang ` ブロックがあっても、撮影処理の実行は同時に1件まで。前件の失敗は後続の実行を止めない。

## 表示

`pi.appendEntry` でcustomType `openui-preview` の表示専用カスタムエントリを保存し、`pi.registerEntryRenderer` で登録したレンダラが描画する。画像エントリのdataには種別とPNGパスを保持し、base64画像データはセッションに書き込まない。

| data | 表示 |
| --- | --- |
| `kind: "image"` | `pi-tui` の `Image` コンポーネントでPNGをインライン表示する。高さは最大30セル（`MAX_HEIGHT_CELLS`） |
| `kind: "error"` | エラーメッセージのカードを表示する |
| PNGファイルが読めない場合 | 「ファイルが見つからない」フォールバックカードを表示する |

`Image` はKitty graphics protocol対応端末（Kitty・Ghostty・WezTerm）とiTerm2のインライン画像で描画され、非対応端末ではテキストフォールバックになる。

## カスタムエントリとLLMコンテキスト

`openui-preview` カスタムエントリは表示専用であり、LLMのコンテキストには含まれない。markdown transformerによるブロック除去も表示専用で、assistantメッセージ本体とLLMコンテキストからブロックが消えることはない。モデルがプレビュー結果を受けて自己修正するフィードバックループは本拡張の対象外である。

## ライフサイクル

プレビュー生成はfire-and-forgetで行い、`message_end` ハンドラは撮影の完了を待たない。生成中のエラーはハンドラから漏れさせず、カスタムエントリのエラーカードとして報告する。session終了時は未開始のプレビュー生成を取り消し、実行中の撮影を中断して終了処理の完了を待つ。
