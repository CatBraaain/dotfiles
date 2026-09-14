# .dsh/test

dsh web UI の見た目を検証する fixture。dsh 本体を起動せず、commit 済みの plugin client bundle と dsh theme CSS を静的ページに render して、composer dock 周りの見た目を確認する。LLM 呼び出しは発生しない。

## 使い方

```bash
cd dotfiles/.dsh/test
bun install
bun run render.ts   # dist/fixture.html（light）と dist/fixture-dark.html を生成
bun serve.ts        # http://localhost:4173/ と /dark で serve（Ctrl-C で停止）
```

別ターミナルで light / dark の2枚をスクショ:

```bash
playwright-cli open --browser=chromium http://localhost:4173/
playwright-cli resize 1280 900
playwright-cli screenshot --filename=dist/fixture.png
playwright-cli goto http://localhost:4173/dark
playwright-cli screenshot --filename=dist/fixture-dark.png
playwright-cli close
```

会話幅は fixture html 内の `.conv-root` に `--dsh-chat-user-width` を設定すると変えられる（既定は clamp(680px, 64%, 920px)）。

## スクショレビューのチェックリスト

fixture は1画面に確認観点ごとのパターン（case 1〜6）を並べてある。light / dark の2枚を撮り、人または VLM（画像を渡せる agent）でレビューする。判定基準の正本は各 plugin の SPEC.md。case 4 は session-list の hover actions を確認するとき `playwright-cli hover '.session-list-row:nth-child(2)'` で hover 状態を撮る。

| パターン | 対応する SPEC の振る舞い | レビューで確認するポイント |
|---|---|---|
| 1. skill-status — populated | `🎯 skills: ` に続けて skill 名を `, ` で連結、first-use 順、文字色 gray | 書式と順序。gray で読めること。行は入力欄カードの上に出る |
| 2. skill-status — empty snapshot | スキル未使用のときは何も表示しない | カードの上に何も無い（ラベル直下が空） |
| 3. skill-status — many skills | 幅に収まらないときは `...` で行末省略 | 行末が `...` で切れ、画面外へあふれない |
| 4. session-list — sidebar rows | 各行は status dot（running=青マトリクス / pending=橙 / done=緑 / idle=gray）+ タイトル + 相対時刻。current 行はハイライト。hover で archive と copy session id の 2 ボタンが現れ、時刻は隠れる | dot の色分け、時刻の bucket（1min / 3h / 2d / 1mo）、hover actions のフラット配置。light / dark 両方で読めること |
| 5. session-list — blank current | 選択中の blank 行は相対時刻なし・actions なしで表示される | 行の高さ・位置が通常行と揃い、右端に何も出ないこと |
| 6. session-list — empty | セッションが無いときは空の領域 | リスト領域が空で、エラーや余計な表示が出ないこと |
| light / dark 両方 | gray は light / dark で別の token 値 | どちらのテーマでも読めること（黒や白に潰れない） |

VLM に依頼するときは、dist/fixture.png と dist/fixture-dark.png の2枚に、上の表と「各 case のラベル番号に沿って PASS/FAIL と根拠を返す」ことだけ伝えれば判定できる。

titlebar は React 無関係（`document.title` への書き込み）のため fixture では検証できず、実 dsh 起動後の確認対象。

## 仕組み

- **theme CSS**: インストール済み `@deepseek-ai/dsh-client-ui-theme` の client bundle から inline CSS 領域を抽出（`--dsw-*` token 全量・フォント）
- **plugin component**: `../plugins/*/lib/client.js` を `window.__ModuleLoader__` shim で load し、fake slot context で `apply` を呼んで register された component を取り出し、`react-dom/server` で render。画面に出る markup は実 bundle と同一物。session-list の stylesheet は apply が付ける style 要素を capture して当てる
- **UI primitives**: shell が提供する `@deepseek-ai/dsh-client-ui-primitives` は raw npm package のままでは bun で動かないため、fixture は同一 DOM 形状の stub + 実アイコン path で置き換え、実物の `Button.module.css` / `StateDot.module.css`（devDependencies のインストール物から読む）を当てる
- **dock 親構造**: `dsh-client-ui-conversation` の composerStack / InputBar の観測値を写した CSS（幅・中央寄せ・gap・レイアウト変数は同値）

`useSyncExternalStore` は react-dom/server が `getServerSnapshot` を必須にするため、render.ts 内で getSnapshot を直接読む shim に差し替えている。

## 制限

- 静的 render のため subscription・インタラクションは動かない（snapshot の初期値のみ反映）。session-list のクリック（行 open、archive、copy）、check icon への切替、rail（折りたたみ）表示、失敗経路（archive 失敗時の行残留と可視エラーなし、clipboard 書き込み失敗時に check icon へ変わらないこと）、表示中セッションの archive 時の New Session view 切替は実 dsh 起動後の確認対象
- ヘッドレス chromium は絵文字グリフを持たず、`🎯` が tofu で写る
- dsh web 全体の画面（会話履歴・hero 等）は対象外。dock 周辺のみ
