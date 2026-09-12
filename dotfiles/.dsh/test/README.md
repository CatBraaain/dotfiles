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

fixture は1画面に確認観点ごとのパターン（case 1〜4）を並べてある。light / dark の2枚を撮り、人または VLM（画像を渡せる agent）でレビューする。判定基準の正本は各 plugin の SPEC.md。

| パターン | 対応する SPEC の振る舞い | レビューで確認するポイント |
|---|---|---|
| 1. skill-status — populated | `🎯 skills: ` に続けて skill 名を `, ` で連結、first-use 順、文字色 gray | 書式と順序。gray で読めること。行は入力欄カードの上に出る |
| 2. skill-status — empty snapshot | スキル未使用のときは何も表示しない | カードの上に何も無い（ラベル直下が空） |
| 3. skill-status — many skills | 幅に収まらないときは `...` で行末省略 | 行末が `...` で切れ、画面外へあふれない |
| 4. footer — composer.dock | `session: <id>` 書式、文字色 gray、composer 下 dock | 書式と色。隣の StatsPills（stock）と縦に整列し、水平中央寄せ |
| light / dark 両方 | gray は light / dark で別の token 値 | どちらのテーマでも読める gray であること（黒や白に潰れない） |

VLM に依頼するときは、dist/fixture.png と dist/fixture-dark.png の2枚に、上の表と「各 case のラベル番号に沿って PASS/FAIL と根拠を返す」ことだけ伝えれば判定できる。

titlebar は React 無関係（`document.title` への書き込み）のため fixture では検証できず、実 dsh 起動後の確認対象。

## 仕組み

- **theme CSS**: インストール済み `@deepseek-ai/dsh-client-ui-theme` の client bundle から inline CSS 領域を抽出（`--dsw-*` token 全量・フォント）
- **plugin component**: `../plugins/*/lib/client.js` を `window.__ModuleLoader__` shim で load し、fake slot context で `apply` を呼んで register された component を取り出し、`react-dom/server` で render。画面に出る markup は実 bundle と同一物
- **dock 親構造**: `dsh-client-ui-conversation` の composerStack / InputBar の観測値を写した CSS（幅・中央寄せ・gap・レイアウト変数は同値）

`useSyncExternalStore` は react-dom/server が `getServerSnapshot` を必須にするため、render.ts 内で getSnapshot を直接読む shim に差し替えている。

## 制限

- 静的 render のため subscription・インタラクションは動かない（snapshot の初期値のみ反映）
- ヘッドレス chromium は絵文字グリフを持たず、`🎯` が tofu で写る
- dsh web 全体の画面（会話履歴・hero 等）は対象外。dock 周辺のみ
