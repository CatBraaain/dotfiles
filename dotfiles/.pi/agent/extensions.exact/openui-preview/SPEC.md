# openui-preview拡張Spec

assistant出力中の ` ```openui-lang ` コードフェンスを、確定後に既存のOpenUI React Rendererと部品でheadlessブラウザに描画し、専用の撮影処理で通常のPNGとして保存してTUI transcript内にインラインプレビュー表示する。読者は本拡張の利用者と保守担当である。

## トリガーと表示の経路

| イベント | 動作 |
| --- | --- |
| `resources_discover` | 拡張フォルダ内に生成した `skills/openui-preview/SKILL.md` を `skillPaths` で登録する |
| `message_end`（assistantメッセージ確定時） | メッセージ本文から ` ```openui-lang ` フェンスを検出し、各ブロックのプレビュー生成をキューへ投入する |
| markdown描画（assistant本文） | 本文から ` ```openui-lang ` ブロックを除去して表示する（表示のみの除去。LLMコンテキストは変えない） |

`message_start`・`message_update`（ストリーミング中）は対象外。プレビューはメッセージ確定後に生成される。

## openui-preview skill

`openui-preview` skillは、markdown応答内にdisplay-onlyのOpenUI Langを作成するための構文・コンポーネント説明・例・ルールを本文として提供する。モデルは生成UIが有用な応答を作るときにskillを選び、本文を読む。system promptへの常時掲載はskillの名前・description・パスだけとする。

frontmatterの `name` は `openui-preview`、`description` は「markdown応答内に表示専用のOpenUI Langを作成する。生成UIを使う応答や、openui-langコードフェンスの作成・修正時に使う。」とする。本文はapplyで生成した `spec.json`（LibrarySpec）と `prompt-options.json`（examples・additionalRules）から作成し、構文・コンポーネント説明・例・ルールが本文だけで読める形とする。両入力の安全な型・説明・例・規則の変更は本文に反映する。対応一覧やプロンプトの手書きによる二重管理は行わない。

| 本文の情報 | 掲載する用法 |
| --- | --- |
| 出力形式 | markdown応答内の、完結した `openui-lang` コードフェンス。各プログラムは `root` を定義し、参照先をすべて含む |
| 値と参照 | 文字列・数値・真偽値・null・配列・オブジェクト・表示部品の呼出しと、静的に定義した通常の名前参照 |
| signature | 対応部品の引数名・順序・表示用の型を保持する。未選択部品はunionから除き、操作やbinding用の引数位置はnullで表す。末尾の省略可能引数は省略でき、中間位置を飛ばす場合はnullを渡す |
| 説明・規則・例 | 現行の静的描画能力に合う既存素材。state・binding・Query・Mutation・Action・動的AST式を使う用法、入力フォームの作成、chunkごとの逐次表示を教える案内は含めない |
| 状態を持つ表示部品 | Tabs・Accordion・Carousel・Steps・Table等の初期状態の静止画。切替・開閉・ページ送りを前提としない |
| 画像参照 | `data:` に埋め込んだ画像。外部URLやローカルファイルの参照を案内しない |
| 撮影時点 | assistantメッセージが確定した後。表示領域は幅960 px・高さ1280 px |

上流の構文・部品説明・例を利用し、常時生成される案内も上表へ整合させる。新たな補足説明は日本語とする。SKILL本文は描画方法を案内するものであり、rendererの部品集合・入力検証・通信制限は変更しない。

## 対応部品

対応部品の集合は [対応部品設定](./supported-components.ts) に明示する。生成する部品案内・入力検証・描画で、同じ設定の部品集合を使用する。

| 条件 | 結果 |
| --- | --- |
| 設定で選択した部品 | 部品案内に掲載し、入力検証と描画で使用する |
| 設定で選択していない部品 | 部品案内に掲載せず、入力時は理由をエラーカードで表示する |
| 上流ライブラリに部品が追加され、設定は変わらない | 対応部品の集合は変わらない |
| 対応部品設定を変更して生成物を更新する | 部品案内・入力検証・描画が変更後の集合に従う |

## 生成物とapplyの前提

apply時に、対応部品設定と上流の部品定義・プロンプト素材から `spec.json`・`prompt-options.json`・frontmatter付きの `skills/openui-preview/SKILL.md` を生成し、ホームの拡張フォルダへ配置する。これら3つの生成物はgit管理せず、apply時に更新する。

生成に必要な依存は [依存導入仕様](../../bun_install.spec.md) に従って準備する。

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| 対応部品設定・生成に使う定義・プロンプト素材・依存lockfileが前回成功時から変わらず、3つの生成物がすべて存在する | applyフックを実行 | 生成を省略する |
| 生成入力が変わった、または前回成功の記録・生成物が欠けている | applyフックを実行 | 3つの生成物を再生成し、成功後に記録を更新する |
| CLIが見つからない・生成が失敗する | applyフックを実行 | 非0で終了し、記録は更新しない。既存の生成物はそのまま残る |

## 実行条件（モード）

プレビュー生成はTUIモード（`ctx.mode` が `"tui"`）だけで行う。rpc・json・printモードでは `message_end` を無視する。カスタムエントリのレンダリングはTUIだけで行われる。skillとmarkdown transformerはモードによらず登録する。

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

入力は `spec.json` のschemaとrootに従って解析する。描画には `@openuidev/react-lang` の `Renderer` と `@openuidev/react-ui/genui-lib` の既存部品を使い、「対応部品」で定めた部品構成を渡す。React Rendererは汎用のOpenUI Lang描画機能であり、本拡張の専用処理がブラウザへの配置と撮影を担う。

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
