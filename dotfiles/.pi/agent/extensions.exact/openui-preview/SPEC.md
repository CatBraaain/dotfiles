# openui-preview拡張Spec

assistant出力中の ` ```openui-lang ` コードフェンスを、確定後にOpenUI Langとして解析・HTML化し、htmlshotでPNG化してTUI transcript内にインラインプレビュー表示する。

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
- `library.data.ts` は正本であり、`@openuidev/react-ui` の `genui-lib` から対話コンポーネント（Button・Form等26種）を除外した `createLibrary` 結果と、`genui-lib/prompt-options` から対話系を示す語を含むexamples・rulesを除外したpromptOptionsをexportする。プロジェクト外部のリポジトリには依存しない（npmライブラリ `@openuidev/react-ui`・`react-lang`・`cli` はspec生成用のdevDependencies）
- `prompt.ts` は対話コンポーネント（同26種）をsignatureから `never` 化・unionから除去し（`displayOnlySignature`）、生成promptの `## Action` セクションと `ActionExpression` の説明行を除去する（`stripInteractivePromptParts`）
- preambleを差し替え、markdown応答内の `openui-lang` fenced blockへの埋め込みを指示する（lang-core既定の「応答全体がコード」前提は使わない）

## 生成物とapplyの前提

`spec.json` と `prompt-options.json` は `spec.apply.ts`（applyフック）が `library.data.ts` から生成し、ホームの拡張フォルダに配置する。生成物はgit管理せず、apply時に更新する。事前の手動インストールは不要である。

`library.data.ts` は `.data.` 予約名のため差分検知・適用の対象外であり、ホームには展開されない。applyフックはスナップショット実行位置（dist側の拡張フォルダ）から `library.data.ts` と `display-only.ts` を読み、ホーム側の一時ディレクトリ `.spec-gen/` にコピーしてから読み込む。これで親を遡って `~/.pi/agent/node_modules` の依存を解決できる。`.spec-gen/` は使用後に削除する。

依存は `bun_install.apply.ts` が導入した `~/.pi/agent/node_modules` を利用する。applyフックは dist相対パス順で実行され、`bun_install.apply.ts` が拡張フォルダのフックより先に走る（[依存導入仕様](../../bun_install.spec.md)）。

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| `library.data.ts`・`display-only.ts`・`bun.lock` の内容ハッシュが記録と一致し、生成物が両方存在する | applyフックを実行 | 生成を省略する |
| ハッシュが記録と異なる、または記録・生成物のどちらかが欠けている | applyフックを実行 | CLIでspecとprompt optionsを再生成し、成功後に記録（`spec-gen-stamp`）を更新する |
| CLIが見つからない・生成が失敗する | applyフックを実行 | 非0で終了し、記録は更新しない。既存の生成物はそのまま残る |

`library.data.ts`・`display-only.ts`・`bun.lock` は dist側のファイルを読む。生成物と `spec-gen-stamp` はホームの拡張フォルダ配下の管理対象外ファイルである。

## 実行条件（モード）

プレビュー生成はTUIモード（`ctx.mode` が `"tui"`）だけで行う。rpc・json・printモードでは `message_end` を無視する。カスタムメッセージのレンダリングはTUIだけで行われる。system promptへの注入はモードによらず常時ON、markdown transformerもモードによらず登録する。

## フェンスの検出

検出は `fence.ts` の `extractOpuiLangBlocks` が担う。

| 対象 | 取り扱い |
| --- | --- |
| ` ```openui-lang ` で始まり ` ``` ` で閉じるブロック | プレビュー生成対象。開始行のタグ以降にトークンがあっても無視する |
| ` ```html ` 等の他言語タグ | 対象外。テキストのまま表示される |
| ` ```openui-language ` のような、`openui-lang` から始まる別タグ | 対象外（word boundaryで除外） |
| 閉じフェンスのないブロック | 解析せず、エラーカードをtranscriptに送る |
| ネストしたフェンス | 対応しない。最初の閉じフェンスで終了する |

`stripOpuiLangBlocks` は本文表示用にブロック（閉じ済み・ストリーミング中の未閉鎖の両方）を除去する。`registerMarkdownTransformer` から `context.messageType === "assistant"` のときだけ適用する。user・assistant-thinking本文・LLMコンテキストは変更しない。

## openui-lang → HTML レンダラ

`render.ts` の `renderOpuiLang` が、`@openuidev/lang-core` のparser（`createParser` に `spec.json` のschemaとrootを渡す）でAST化し、HTML文字列を1つのHTMLドキュメントとして生成する。CSSはトークン・コンポーネント規則を `<style>` で同一ファイルに持つ（htmlshotの制約: `<script>` と外部参照は禁止）。トークンと規則はOpenUI design system（`@openuidev/react-ui` のスタイル）のlight paletteに従う。

対応コンポーネントは軽量セット18種: Stack, Card, CardHeader, Separator, InlineHeader, TextContent, Text, BoldText, CodeBlock, Callout, TextCallout, ListBlock, ListItem, EntityList, Table, Col, TagBlock, Tag。

| 保留・未対応 | 理由 |
| --- | --- |
| chart系全種（BarChart・PieChart等、Series/Slice/Point/Scatter系） | 静的HTMLでの再現コストが大きい。案内カードで案内する |
| Tabs・Accordion・Carousel・Steps | 対話（開閉・切替）を静的PNGで表現できない。案内カードで案内する |
| 対話系（Button・Form等） | display-onlyライブラリに含まれない |
| `Icon`・カードブロック（SnippetCardBlock等）・その他表示系 | 軽量セットの対象外。案内カードで案内する |
| ListBlock `variant: "image"` | 外部画像を読めない |
| `$variable`・`$binding`・Query()/Mutation() | 静的プレビューでは評価できない |
| Tableの2ページ目以降 | React実装の1ページ目（10行）のみ描画する |

未対応コンポーネントを含むプログラム・解析に失敗するプログラムはプレビューせず、既存のdetails `kind: "error"` の経路で案内カード（エラーメッセージ付き）を表示する。

## プレビュー生成

| 項目 | 値 |
| --- | --- |
| CLI | `~/.agents/cli/htmlshot`（`execFile` で起動する） |
| 出力先 | `~/.agents/work/openui-preview/<id>.html.png` |
| shot寸法 | `--width 960 --height 1280` |
| 実行回数 | 1回のみ（strict検証。`--unsafe` での再試行はしない。DSLから生成したHTMLはscript・外部参照を持たないため） |
| 一時HTML | shot成否後に削除する（正本HTMLはPNGに埋め込まれる） |
| `<id>` | `Date.now()-ブロック番号-乱数接尾辞` |

shotが失敗した場合は、stderrの最終行をエラーカードでtranscriptに送る。

## キューイング

プレビュー生成は直列キュー（`createQueue`）で1件ずつ実行する。1メッセージに複数の ` ```openui-lang ` ブロックがあっても、htmlshotの起動は同時に1プロセスまで。前件の失敗は後続の実行を止めない。

## 表示

`pi.sendMessage` でcustomType `openui-preview` のdisplay専用メッセージを送り、`pi.registerMessageRenderer` で登録したレンダラが描画する。detailsにはPNGパスのみを保持し、base64画像データはセッションに書き込まない。

| details | 表示 |
| --- | --- |
| `kind: "image"` | `pi-tui` の `Image` コンポーネントでPNGをインライン表示する。高さは最大30セル（`MAX_HEIGHT_CELLS`） |
| `kind: "error"` | エラーメッセージのカードを表示する |
| PNGファイルが読めない場合 | 「ファイルが見つからない」フォールバックカードを表示する |

`Image` はKitty graphics protocol対応端末（Kitty・Ghostty・WezTerm）とiTerm2のインライン画像で描画され、非対応端末ではテキストフォールバックになる。

## 送信メッセージとLLMコンテキスト

`openui-preview` メッセージはdisplay専用であり、LLMのコンテキストには含まれない。markdown transformerによるブロック除去も表示専用で、assistantメッセージ本体とLLMコンテキストからブロックが消えることはない。モデルがプレビュー結果を受けて自己修正するフィードバックループは本拡張の対象外である。

## ライフサイクル

プレビュー生成はfire-and-forgetで行い、`message_end` ハンドラはhtmlshotの完了を待たない。生成中のエラーはハンドラから漏れさせず、detailsのエラーカードとして報告する。
