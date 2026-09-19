# .dsh/test

dsh web UI の見た目を検証する fixture。dsh 本体を起動せず、commit 済みの plugin client bundle と dsh theme CSS を静的ページに render して、composer dock 周りの見た目を確認する。LLM 呼び出しは発生しない。

## 使い方

```bash
cd dotfiles/.dsh/test
bun install
bun run render.ts   # dist/fixture.html（light）と dist/fixture-dark.html を生成
bun run shot.ts     # light / dark / hover のスクショを dist/ に撮影（playwright-cli が必要）
bun serve.ts        # fixture を browser で直接見るとき。http://localhost:4173/ と /dark（Ctrl-C で停止）
```

実 dsh web の起動・表示時エラーを自動確認する（`dsh` と `playwright-cli` が必要）:

```bash
bun run test:web
```

この smoke test の判定契約は `SPEC.md` に定める。`dsh web --no-open --port 0` を起動し、token URL の readiness を待って Chromium で開く。初期表示と reload 後の browser console error、および初期表示・reload 中の uncaught page error があると終了コード 1 で失敗する。チャット入力など LLM を呼ぶ操作は行わず、browser・dsh・token を含む一時ログは終了時に削除する。

会話幅は fixture html 内の `.conv-root` に `--dsh-chat-user-width` を設定すると変えられる（既定は clamp(680px, 64%, 920px)）。

## スクショレビュー

fixture スクショの撮影物と合否判定基準は `REVIEW.md` に定める。判定は人が行う。

## 仕組み

- **theme CSS**: インストール済み `@deepseek-ai/dsh-client-ui-theme` の client bundle から inline CSS 領域を抽出（`--dsw-*` token 全量・フォント）
- **plugin component**: `../plugins/*/lib/client.js` を `window.__ModuleLoader__` shim で load し、fake slot context で `apply` を呼んで register された component を取り出し、`react-dom/server` で render。画面に出る markup は実 bundle と同一物。session-list の stylesheet は apply が付ける style 要素を capture して当てる
- **UI primitives**: shell が提供する `@deepseek-ai/dsh-client-ui-primitives` は raw npm package のままでは bun で動かないため、fixture は同一 DOM 形状の stub + 実アイコン path で置き換え、実物の `Button.module.css` / `StateDot.module.css`（devDependencies のインストール物から読む）を当てる
- **dock 親構造**: `dsh-client-ui-conversation` の composerStack / InputBar の観測値を写した CSS（幅・中央寄せ・gap・レイアウト変数は同値）

`useSyncExternalStore` は react-dom/server が `getServerSnapshot` を必須にするため、render.ts 内で getSnapshot を直接読む shim に差し替えている。

## 制限

- 静的 render のため subscription・インタラクションは動かない（snapshot の初期値のみ反映）。session-list のクリック（行 open、archive、copy）、グループ折りたたみ、Show more の展開、Add workspace flow（directory picker・作成・エラーダイアログ）、check icon への切替、rail（折りたたみ）表示、失敗経路（archive 失敗時の行残留と可視エラーなし、clipboard 書き込み失敗時に check icon へ変わらないこと）、表示中セッションの archive 時の New Session view 切替、agents のメニュー開状態（popover・選択適用・外側クリックで閉じること）は実 dsh 起動後の確認対象。agents 行ボタンの hover fill は CSS `:hover` なので fixture ページ上で `playwright-cli hover` と screenshot で確認できる
- ヘッドレス chromium は絵文字グリフを持たず、`🎯` が tofu で写る
- dsh web 全体の画面（会話履歴・hero 等）は対象外。dock 周辺のみ
